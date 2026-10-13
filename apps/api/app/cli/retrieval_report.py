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
from dataclasses import replace
from typing import Any, Final

import httpx
from sqlalchemy import select

from app.cli.run_worker import build_provider
from app.db.engine import create_engine, create_session_factory
from app.db.models import User
from app.domain.models import VISIBLE_ROLES, Actor, Role
from app.provider_config.contracts import ProviderConfigurationError
from app.provider_config.runtime import bind_runtime, get_runtime
from app.provider_config.transport import provider_client
from app.providers.base import EmbeddingProviderError
from app.providers.rerank import (
    DEFAULT_RERANK_POLICY,
    RerankProviderError,
    build_rerank_provider,
)
from app.providers.retry import RetryableError
from app.providers.usage import usage_record
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
EXIT_NO_KEY: Final = 8

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
    EXIT_NO_KEY: "reranking was requested but configure a provider in the manager panel",
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
    parser.add_argument(
        "--rerank",
        action="store_true",
        help=(
            "enable the optional reranker for this report; sends the question and the "
            "candidate texts to OpenRouter, so it is off unless asked for"
        ),
    )
    parser.add_argument(
        "--rerank-top-k",
        type=int,
        default=RetrievalConfig.rerank_top_k,
        help="how many fused candidates the reranker may see; bounds what leaves the process",
    )
    parser.add_argument("--json", action="store_true", help="emit the report as JSON")
    return parser


async def _actor_for(factory: Any, login: str) -> Actor | None:
    """Resolve the real active account; operator commands do not create browser sessions."""
    from sqlalchemy import func  # noqa: PLC0415

    from app.auth.accounts import normalized_login  # noqa: PLC0415
    from app.domain.models import is_valid_role  # noqa: PLC0415

    login = normalized_login(login)
    predicate = func.lower(func.trim(User.login)) == login if "@" in login else User.login == login
    async with factory() as session:
        row = (
            await session.execute(
                select(User.user_id, User.role).where(predicate, User.is_active.is_(True))
            )
        ).one_or_none()
    if row is None or not is_valid_role(row.role):
        return None
    return Actor(user_id=row.user_id, role=row.role, session_id=uuid.uuid4())


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
            "rerank_enabled": config.rerank_enabled,
            "rerank_top_k": config.rerank_top_k,
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
                "rerank_score": hit.rerank_score,
                "citation": hit.source.citation,
            }
            for index, hit in enumerate(hits, start=1)
        ],
    }


def _usage_report(usage: Any) -> dict[str, Any]:
    """Report consumption, naming an absent figure as unknown rather than zero.

    A fabricated ``0`` would read as "this was free", which is a claim about money the
    provider never made. ``technical-details.md`` subject 1 requires an unreported
    figure to be recorded as such.
    """
    if usage is None:
        return {"reported": False, "search_units": None, "total_tokens": None, "cost": None}
    billed = usage.billed_units or {}
    return {
        "reported": True,
        "search_units": billed.get("search_units"),
        "total_tokens": billed.get("total_tokens"),
        "cost": str(usage.cost) if usage.cost is not None else None,
        "currency": usage.currency,
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
    if config["rerank_enabled"]:
        print(
            f"rerank: enabled (openrouter {report['rerank']['model']},"
            f" rerank_top_k={config['rerank_top_k']})"
        )
        usage: dict[str, Any] = report["rerank_usage"]
        if usage["reported"]:
            print(
                "rerank usage: "
                f"search_units={usage['search_units'] or 'unknown'} "
                f"total_tokens={usage['total_tokens'] or 'unknown'} "
                f"cost={usage['cost'] or 'unknown'}"
            )
        else:
            print("rerank usage: not reported")
    else:
        print("rerank: disabled (no provider call was made)")
    print(f"hits: {report['returned']}")
    rows: list[dict[str, Any]] = report["hits"]
    for row in rows:
        print(
            f"  {row['rank']}. {row['document_id']}#{row['section_id']}@{row['revision']}"
            f" chunk#{row['chunk_ordinal']} role={row['access_role']}"
            f" lexical={row['lexical_rank']} vector={row['vector_rank']}"
            f" fused={row['fused_score']} rerank={row['rerank_score']}"
        )


async def _report(arguments: argparse.Namespace) -> int:
    settings = load_settings()
    config = RetrievalConfig(
        lexical_top_k=arguments.lexical_top_k,
        vector_top_k=arguments.vector_top_k,
        rerank_enabled=arguments.rerank,
        rerank_top_k=arguments.rerank_top_k,
        final_top_k=arguments.final_top_k,
    )
    # Declared before the ``try`` so the ``finally`` can reach it on every path,
    # including the early returns for a missing account or a missing key.
    rerank_client: httpx.AsyncClient | None = None
    rerank_provider = None
    engine = create_engine(settings)
    try:
        factory = create_session_factory(engine)
        settings = await bind_runtime(settings, factory)
        if arguments.rerank and not settings.rerank_enabled:
            raise ProviderConfigurationError("enable rerank in the manager panel")
        config = replace(config, rerank_enabled=settings.rerank_enabled)
        actor = await _actor_for(factory, arguments.login)
        if actor is None:
            print(EXIT_MESSAGES[EXIT_NO_ACCOUNT], file=sys.stderr)
            return EXIT_NO_ACCOUNT

        # One deadline per embedding attempt, the same figure the worker derives.
        from app.cli.run_worker import attempt_timeout_seconds

        provider = build_provider(
            settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
        )

        # The reranker is constructed only when reranking was asked for. Building it
        # unconditionally would require an API key for a report that never reranks, and
        # a report that fails for a missing key it did not need is a worse default.
        rerank_usage: Any = None
        if settings.rerank_enabled:
            if not get_runtime(settings).connections["rerank"]:
                print(EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
                return EXIT_NO_KEY
            # Closed in the ``finally`` below. An adapter outliving its client leaves
            # sockets for the garbage collector, and a one-shot command exits first, so
            # they would never be closed at all.
            rerank_client = provider_client(timeout=DEFAULT_RERANK_POLICY.attempt_timeout_seconds)
            rerank_provider = build_rerank_provider(settings, client=rerank_client)

        async with factory() as session:
            searchable = await retrieval_store.count_retrievable_documents(session, actor)
            hits = await retrieve(
                session,
                actor=actor,
                question=arguments.question,
                config=config,
                provider=provider,
                rerank_provider=rerank_provider,
            )
            if rerank_provider is not None:
                rerank_usage = rerank_provider.last_usage

        report = _build_report(login=arguments.login, role=actor.role, config=config, hits=hits)
        report["searchable_documents"] = searchable
        report["rerank_usage"] = _usage_report(rerank_usage)
        report["provider_usages"] = [
            usage_record(usage) for usage in getattr(rerank_provider, "last_usages", [])
        ]
        report["rerank"] = (
            {
                "enabled": True,
                "provider": rerank_provider.provider_name,
                "model": rerank_provider.model,
            }
            if rerank_provider is not None
            else {"enabled": False, "provider": None, "model": None}
        )
        if arguments.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(f"searchable documents in the allowlist: {searchable}")
            _print_text(report)
        return EXIT_OK
    except (RerankProviderError, TimeoutError):
        for usage in getattr(rerank_provider, "last_usages", []):
            print("provider usage: " + json.dumps(usage_record(usage)), file=sys.stderr)
        raise
    finally:
        if rerank_client is not None:
            await rerank_client.aclose()
        runtime = getattr(settings, "_provider_runtime", None)
        if runtime is not None:
            for client in runtime.owned_clients:
                await client.aclose()
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if not arguments.question.strip():
        print(EXIT_MESSAGES[EXIT_USAGE], file=sys.stderr)
        return EXIT_USAGE
    try:
        return asyncio.run(_report(arguments))
    except ProviderConfigurationError:
        print("configure providers in the manager panel", file=sys.stderr)
        return 2
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return EXIT_USAGE
    except OSError as error:
        print(f"retrieval report failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_USAGE
    except (EmbeddingProviderError, RetryableError) as error:
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
    except RerankProviderError as error:
        # Class name only: a gateway may echo the request, and the request is the
        # question and the candidate texts.
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
