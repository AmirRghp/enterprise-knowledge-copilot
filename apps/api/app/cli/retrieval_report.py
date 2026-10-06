"""Operator CLI: report what retrieval returns for a question, without the text.

This is the Part 11 review surface. It answers "which documents would this question
reach, and how did each one rank" - and deliberately **not** "what do those
documents say":

* no chunk text, no section source and no document title is printed, because a
  retrieval report is the first thing that would end up pasted into a ticket or a
  chat, and an employee's report must not carry text from a manager-only document;
* only identifiers, ranks, the fused score and the role that was actually applied
  are printed, which is everything needed to confirm an authorization or an ordering
  bug and nothing needed to quote a document;
* the role comes from a real ``users`` row read server-side, so the CLI has no way
  to assert a role it does not hold.

Usage::

    uv run --locked python -m app.cli.retrieval_report --question "..."
    uv run --locked python -m app.cli.retrieval_report --login manager --json
"""

import argparse
import asyncio
import json
import sys
import uuid
from typing import Any, Final

from sqlalchemy import select

from app.cli.run_worker import build_provider
from app.db.engine import create_engine, create_session_factory
from app.db.models import User
from app.domain.models import VISIBLE_ROLES, Actor, Role
from app.providers.base import EmbeddingProviderError
from app.retrieval import store as retrieval_store
from app.retrieval.contracts import RetrievalConfig
from app.retrieval.service import retrieve
from app.retrieval.store import (
    IndexProvenanceMismatchError,
    RetrievalDomainTooLargeError,
)
from app.settings import ConfigurationError, load_settings

EXIT_OK: Final = 0
EXIT_USAGE: Final = 2
EXIT_NO_ACCOUNT: Final = 4
EXIT_PROVIDER: Final = 5
EXIT_INDEX: Final = 6
EXIT_CAPACITY: Final = 7

#: Every message here is written here, never taken from an exception. An adapter's
#: message may quote up to 200 characters of the provider's own response, and Ollama
#: echoes the input back when it rejects it - which for this CLI is the question. A
#: report that promises to print no prose must not print the question in its error
#: path either.
EXIT_MESSAGES: Final = {
    EXIT_USAGE: "usage: --question must not be empty",
    EXIT_NO_ACCOUNT: "no active account for that login",
    EXIT_PROVIDER: "the embedding provider could not answer; see the worker log for detail",
    EXIT_INDEX: "the retrievable index is inconsistent with the active provider",
    EXIT_CAPACITY: "the retrievable domain is larger than the in-memory lexical path allows",
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.retrieval_report",
        description="Report authorized retrieval ranks for one question. Prints no document text.",
    )
    parser.add_argument("--question", required=True, help="the question to retrieve for")
    parser.add_argument(
        "--login",
        default="employee",
        help="which account's role to report for; the role is read from the database",
    )
    parser.add_argument("--final-top-k", type=int, default=RetrievalConfig.final_top_k)
    parser.add_argument("--lexical-top-k", type=int, default=RetrievalConfig.lexical_top_k)
    parser.add_argument("--vector-top-k", type=int, default=RetrievalConfig.vector_top_k)
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    return parser


async def _actor_for(factory: Any, login: str) -> Role | None:
    """Return the stored role of ``login``, or ``None`` when there is no such account.

    The role comes from the ``users`` row, never from an argument. A session id is
    not needed: retrieval is not a request-scoped operation and nothing here reads or
    writes a session, so minting a throwaway id cannot widen anything.
    """
    async with factory() as session:
        role = (
            await session.execute(
                select(User.role).where(User.login == login, User.is_active.is_(True))
            )
        ).scalar_one_or_none()
    if role is None:
        return None
    return role  # type: ignore[no-any-return]


def _build_report(
    *, login: str, role: Role, config: RetrievalConfig, hits: list[Any]
) -> dict[str, Any]:
    """Assemble the report from identifiers, ranks and the role applied.

    ``question`` is deliberately not a parameter. A caller that has it to hand is
    one line away from printing it, and the whole contract of this report is that no
    prose leaves it - the question included.
    """
    return {
        "login": login,
        "role": role,
        "permitted_roles": list(VISIBLE_ROLES[role]),
        "config": {
            "lexical_top_k": config.lexical_top_k,
            "vector_top_k": config.vector_top_k,
            "rrf_k": config.rrf_k,
            "final_top_k": config.final_top_k,
        },
        "returned": len(hits),
        "hits": [
            {
                "rank": index,
                "document_id": hit.chunk.document_id,
                "section_id": hit.chunk.section_id,
                "revision": hit.chunk.revision,
                "chunk_ordinal": hit.chunk.ordinal,
                "access_role": hit.chunk.access_role,
                "lexical_rank": hit.lexical_rank,
                "vector_rank": hit.vector_rank,
                "fused_score": round(hit.fused_score, 6),
                "citation": hit.source.citation,
            }
            for index, hit in enumerate(hits, start=1)
        ],
    }


def _print_text(report: dict[str, Any]) -> None:
    print(f"login: {report['login']}  role: {report['role']}")
    permitted: list[str] = report["permitted_roles"]
    print(f"permitted document roles: {', '.join(permitted)}")
    config: dict[str, int] = report["config"]
    print(
        "config: "
        f"lexical_top_k={config['lexical_top_k']} vector_top_k={config['vector_top_k']}"
        f" rrf_k={config['rrf_k']} final_top_k={config['final_top_k']}"
    )
    print(f"hits: {report['returned']}")
    rows: list[dict[str, Any]] = report["hits"]
    for row in rows:
        print(
            f"  {row['rank']}. {row['document_id']}#{row['section_id']}@{row['revision']}"
            f" chunk#{row['chunk_ordinal']} role={row['access_role']}"
            f" lexical={row['lexical_rank']} vector={row['vector_rank']}"
            f" fused={row['fused_score']}"
        )


async def _report(arguments: argparse.Namespace) -> int:
    settings = load_settings()
    config = RetrievalConfig(
        lexical_top_k=arguments.lexical_top_k,
        vector_top_k=arguments.vector_top_k,
        final_top_k=arguments.final_top_k,
    )
    engine = create_engine(settings)
    try:
        factory = create_session_factory(engine)
        role = await _actor_for(factory, arguments.login)
        if role is None:
            print(EXIT_MESSAGES[EXIT_NO_ACCOUNT], file=sys.stderr)
            return EXIT_NO_ACCOUNT

        # One deadline per embedding attempt, the same figure the worker derives.
        from app.cli.run_worker import attempt_timeout_seconds

        provider = build_provider(
            settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
        )
        actor = Actor(user_id=uuid.uuid4(), role=role, session_id=uuid.uuid4())
        async with factory() as session:
            searchable = await retrieval_store.count_retrievable_documents(session, actor)
            hits = await retrieve(
                session,
                actor=actor,
                question=arguments.question,
                config=config,
                provider=provider,
            )
        report = _build_report(login=arguments.login, role=role, config=config, hits=hits)
        report["searchable_documents"] = searchable
        if arguments.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(f"searchable documents in the allowlist: {searchable}")
            _print_text(report)
        return EXIT_OK
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if not arguments.question.strip():
        print(EXIT_MESSAGES[EXIT_USAGE], file=sys.stderr)
        return EXIT_USAGE
    try:
        return asyncio.run(_report(arguments))
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return EXIT_USAGE
    except OSError as error:
        print(f"retrieval report failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_USAGE
    except EmbeddingProviderError as error:
        # Deliberately not ``str(error)``: the adapter's message may quote the
        # provider's response body, and Ollama echoes the input back when it rejects
        # it - which here is the question. The fixed message plus the exception class
        # is enough to diagnose from a log and cannot leak even if the adapter's
        # wording changes.
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER
    except IndexProvenanceMismatchError:
        print(EXIT_MESSAGES[EXIT_INDEX], file=sys.stderr)
        return EXIT_INDEX
    except RetrievalDomainTooLargeError:
        print(EXIT_MESSAGES[EXIT_CAPACITY], file=sys.stderr)
        return EXIT_CAPACITY


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
