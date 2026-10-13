"""Operator CLI: run the generation adapter over authorized retrieval results.

``preflight_generation`` proves the *endpoint* honours the JSON schema, using two
synthetic passages. This command proves the same adapter behaves on this deployment's
real authorized documents, retrieved through the same allowlist a request would use.

What this command deliberately does **not** do:

* print the question, the chunk text, or the model's prose. Generation is the second
  stage that sends document text outside the process, and the model's prose is a
  rendering of that text; none of it belongs in a log a ticket will carry.
* print a claim's text or its quote. Both are the model's rendering of a document, and
  a claim's ``text`` is exactly the sentence that would later need Part 14 to prove it
  against the source. Printing it here would present unvalidated model output as an
  answer. Only counts, handles and flags are printed.
* present anything as true. Nothing here checks a claim against its evidence - that is
  Part 14 - so a claim in this report is the model's assertion and nothing more.
* serve anything. This is a report, not the answer path.

Usage::

    uv run --locked python -m app.cli.generation_report --question "..."
    uv run --locked python -m app.cli.generation_report --login manager --json
"""

import argparse
import asyncio
import json
import sys
import uuid
from typing import Any, Final

import httpx

from app.cli.retrieval_report import EXIT_NO_ACCOUNT, EXIT_OK, EXIT_USAGE, _actor_for
from app.db.engine import create_engine, create_session_factory
from app.provider_config.runtime import configured_run, get_runtime
from app.provider_config.transport import provider_client
from app.providers.base import EmbeddingProviderError, EvidenceItem, ProviderUsage
from app.providers.generation import (
    GenerationEvidenceError,
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.providers.rerank import RerankProviderError, build_rerank_provider
from app.providers.retry import RetryableError
from app.providers.usage import usage_record
from app.retrieval import store as retrieval_store
from app.retrieval.contracts import IndexProvenance, RetrievalConfig
from app.retrieval.service import retrieve
from app.retrieval.store import (
    IndexProvenanceMismatchError,
    RetrievalDomainTooLargeError,
)
from app.settings import Settings, load_settings

EXIT_PROVIDER: Final = 5
EXIT_INDEX: Final = 6
EXIT_CAPACITY: Final = 7
EXIT_NO_KEY: Final = 8
EXIT_NO_HITS: Final = 9
#: A distinct code from ``EXIT_PROVIDER`` because the two mean different things to an
#: operator: a schema failure is this deployment's configuration or endpoint being wrong,
#: which no retry fixes, while a provider failure may be transient. The preflight reports
#: the same two conditions under the same codes, because both are operator tools for one
#: endpoint and a disagreement between them would send somebody to the wrong log.
EXIT_SCHEMA: Final = 10

EXIT_MESSAGES: Final = {
    EXIT_USAGE: "usage: --question must not be empty",
    EXIT_NO_ACCOUNT: "no active account for that login",
    # One message for both ways of arriving here, and true for each: retrieval
    # returning nothing, and every candidate losing its authorization between that
    # and the send. Neither is a provider problem, so neither names one.
    EXIT_NO_HITS: "there was no authorized evidence to generate from",
    EXIT_NO_KEY: "configure a chat provider in the manager panel",
    EXIT_PROVIDER: "a provider could not answer; see the worker log for detail",
    EXIT_SCHEMA: "the generation provider did not honour the JSON schema",
    EXIT_INDEX: "the retrievable index is inconsistent with the active provider",
    EXIT_CAPACITY: "the retrievable domain is larger than the in-memory lexical path allows",
}

#: How many retrieved chunks become evidence. Bounded because every one of them is
#: document text sent to a third party, and the question is the only reason to send any.
_MAX_EVIDENCE: Final = 5


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.generation_report",
        description=(
            "Generate claims from authorized retrieval results. Prints no question, no "
            "chunk text and no model prose."
        ),
    )
    parser.add_argument("--login", required=True, help="the account whose role is applied")
    parser.add_argument("--question", required=True, help="the question to ask")
    parser.add_argument("--json", action="store_true", help="emit the result as JSON")
    return parser


def _usage_report(usage: ProviderUsage | None) -> dict[str, Any]:
    if usage is None:
        return {"reported": False}
    billed = usage.billed_units or {}
    return {
        "reported": True,
        # Inside the usage block rather than beside it, because the failure path prints
        # the same summary and two copies of one number drift.
        "attempts": usage.attempts,
        "prompt_tokens": str(billed["prompt_tokens"]) if "prompt_tokens" in billed else None,
        "completion_tokens": (
            str(billed["completion_tokens"]) if "completion_tokens" in billed else None
        ),
        "total_tokens": str(billed["total_tokens"]) if "total_tokens" in billed else None,
        "cost": str(usage.cost) if usage.cost is not None else None,
        "currency": usage.currency,
    }


def _usage_line(summary: dict[str, Any]) -> str:
    """One sanitized line of consumption figures.

    Figures and counts only. Nothing here can carry document text or the question: every
    value is either a number the provider reported or ``None``, and ``None`` prints as
    ``None`` rather than as a zero, because an unreported cost is not a free one.
    """
    return (
        f"attempts={summary['attempts']} "
        f"prompt={summary['prompt_tokens']} "
        f"completion={summary['completion_tokens']} "
        f"total={summary['total_tokens']} "
        f"cost={summary['cost']} "
        f"currency={summary['currency']}"
    )


def _report_failed_usage(generator: Any) -> None:
    """Print what a failed call cost, on stderr.

    The accounting is only worth keeping if someone can see it. A command that exits
    non-zero with only a reason leaves the operator no way to tell whether the attempt was
    free, cheap or expensive, and the figure disappears when the process does - which is
    what an earlier version did: the adapter kept the usage and the CLI dropped it.

    Read here rather than in ``main`` because ``main`` has no provider: it is closed in
    the ``finally`` below before an exception would reach it.
    """
    usage = generator.last_usage if generator is not None else None
    if usage is None:
        return
    summary = _usage_report(usage)
    if not summary["reported"]:
        return
    print(f"usage: {_usage_line(summary)}", file=sys.stderr)
    usages = getattr(generator, "last_usages", [])
    if len(usages) > 1:
        for item in usages:
            print("provider usage: " + json.dumps(usage_record(item)), file=sys.stderr)


async def _report(arguments: argparse.Namespace, settings: Settings) -> int:
    if not get_runtime(settings).connections["chat"]:
        print(EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
        return EXIT_NO_KEY
    from app.cli.run_worker import attempt_timeout_seconds, build_provider

    # Closed in the ``finally`` below, for the same reason the rerank report closes its
    # own: a one-shot command exits first, so a client that is never closed is never
    # closed at all.
    generation_client: httpx.AsyncClient | None = None
    generator: Any = None
    reranker: Any = None
    engine = create_engine(settings)
    try:
        factory = create_session_factory(engine)
        actor = await _actor_for(factory, arguments.login)
        if actor is None:
            print(EXIT_MESSAGES[EXIT_NO_ACCOUNT], file=sys.stderr)
            return EXIT_NO_ACCOUNT

        # One deadline for both embedding layers, the figure the worker derives. Passing
        # the policy's default instead would leave the client's timeout and the retry
        # deadline disagreeing.
        provider = build_provider(
            settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
        )
        generation_client = provider_client(timeout=30.0)
        generator = build_generation_provider(settings, client=generation_client)
        reranker = (
            build_rerank_provider(settings, client=generation_client)
            if settings.rerank_enabled
            else None
        )

        config = RetrievalConfig(rerank_enabled=settings.rerank_enabled)
        async with factory() as session:
            hits = await retrieve(
                session,
                actor=actor,
                question=arguments.question,
                config=config,
                provider=provider,
                rerank_provider=reranker,
            )

        if not hits:
            print(EXIT_MESSAGES[EXIT_NO_HITS], file=sys.stderr)
            return EXIT_NO_HITS

        # A handle is assigned once, from the retrieval order, and never reassigned. A
        # handle that shifted position after a revocation would quietly come to mean a
        # different passage, and a claim citing it would resolve to the wrong document.
        offered: list[tuple[str, uuid.UUID]] = [
            (f"E{position}", hit.chunk.chunk_id)
            for position, hit in enumerate(hits[:_MAX_EVIDENCE], start=1)
        ]
        expected = IndexProvenance(
            provider=provider.provider_name,
            model=provider.model,
            digest=provider.last_digest,
            dimension=provider.dimension,
        )

        async def fresh_evidence() -> list[EvidenceItem]:
            """Re-read the evidence under the allowlist, immediately before every send.

            ``retrieve`` authorized these chunks, but its last check was *before* this
            call: a narrowing, a deletion or a replacement that lands in between would
            otherwise put text on the wire that the caller may no longer read. The gate
            runs again here and on every attempt after a retry or a repair, because each
            of those is a later moment than the last check.

            A fresh session per read, rather than holding one open across a multi-second
            provider call: a long-held transaction serves no purpose here and would pin a
            snapshot the gate is supposed to move past.
            """
            async with factory() as gate:
                rows = await retrieval_store.read_ranked_chunks(
                    gate, actor, chunk_ids=[chunk_id for _, chunk_id in offered]
                )
                retrieval_store.assert_chunks_consistent(rows.values(), expected=expected)
                return [
                    EvidenceItem(evidence_id=handle, text=row.to_record().text)
                    for handle, chunk_id in offered
                    if (row := rows.get(chunk_id)) is not None
                ]

        evidence = await fresh_evidence()
        if not evidence:
            # Every chunk was revoked in the window between retrieval and the send.
            print(EXIT_MESSAGES[EXIT_NO_HITS], file=sys.stderr)
            return EXIT_NO_HITS

        result = await generator.generate(
            question=arguments.question, evidence=evidence, refresh=fresh_evidence
        )
        usage = generator.last_usage

        report = {
            "login": arguments.login,
            "role": actor.role,
            "provider": generator.provider_name,
            "model": generator.model,
            "retrieved_hits": len(hits),
            "evidence_sent": len(evidence),
            "claims_returned": len(result.claims),
            "abstained": result.abstained,
            "missing_parts": list(result.missing_parts),
            # Whether prose came back, never the prose.
            "answer_present": result.answer is not None,
            # Which handles were cited, so a missing one is visible without any text.
            "cited_evidence_ids": [claim.evidence_id for claim in result.claims],
            # Above one attempt means a retry or a repair happened, and their cost is
            # inside these totals.
            "usage": _usage_report(usage),
            "provider_usages": [
                usage_record(u)
                for adapter in (reranker, generator)
                for u in getattr(adapter, "last_usages", [])
            ],
        }

        if arguments.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print(f"login: {report['login']}  role: {report['role']}")
            print(f"provider: {report['provider']}  model: {report['model']}")
            print(f"retrieved hits: {report['retrieved_hits']}")
            print(f"evidence sent: {report['evidence_sent']}")
            print(f"claims returned: {report['claims_returned']}")
            print(f"cited evidence ids: {', '.join(report['cited_evidence_ids']) or 'none'}")
            print(f"abstained: {report['abstained']}")
            print(f"missing parts: {', '.join(report['missing_parts']) or 'none'}")
            print(f"answer present: {report['answer_present']}")
            usage_report = report["usage"]
            if usage_report["reported"]:
                print(f"usage: {_usage_line(usage_report)}")
            else:
                print("usage: not reported")
            print("note: claims are unvalidated model assertions, not answers")
        return EXIT_OK
    except GenerationEvidenceError:
        # Before ``GenerationResponseError``, which it would otherwise be caught by: this
        # is not a bad answer, it is no answer and no request. Reporting it as a schema
        # failure would blame the provider for an endpoint nobody called.
        print(EXIT_MESSAGES[EXIT_NO_HITS], file=sys.stderr)
        _report_failed_usage(generator)
        return EXIT_NO_HITS
    except GenerationResponseError:
        # A fixed message with no traceback: the provider's own wording can quote the
        # request, which is the question and the evidence texts.
        print(EXIT_MESSAGES[EXIT_SCHEMA], file=sys.stderr)
        _report_failed_usage(generator)
        return EXIT_SCHEMA
    except (GenerationProviderError, TimeoutError) as error:
        # Caught here rather than in ``main`` so the refusal is still readable: the
        # provider is closed in the ``finally`` below before an exception would reach
        # ``main``, and rebuilding one to ask would spend the very quota whose exhaustion
        # may be the reason. Never the provider's wording, only this adapter's own words.
        refusal = generator.last_refusal if generator is not None else None
        detail = f" - {refusal}" if refusal else f" ({type(error).__name__})"
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]}{detail}", file=sys.stderr)
        _report_failed_usage(generator)
        return EXIT_PROVIDER
    except RerankProviderError as error:
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER
    finally:
        for usage in getattr(reranker, "last_usages", []):
            print("provider usage: " + json.dumps(usage_record(usage)), file=sys.stderr)
        if generation_client is not None:
            await generation_client.aclose()
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if not arguments.question.strip():
        print(EXIT_MESSAGES[EXIT_USAGE], file=sys.stderr)
        return EXIT_USAGE

    settings = load_settings()
    try:
        return asyncio.run(configured_run(_report, arguments, settings))
    except (EmbeddingProviderError, RetryableError) as error:
        # Only the class name: the adapter's message can quote the request, and the
        # request is the question.
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER
    except IndexProvenanceMismatchError:
        print(EXIT_MESSAGES[EXIT_INDEX], file=sys.stderr)
        return EXIT_INDEX
    except RetrievalDomainTooLargeError:
        print(EXIT_MESSAGES[EXIT_CAPACITY], file=sys.stderr)
        return EXIT_CAPACITY
    except GenerationProviderError as error:
        # The class name, plus the refusal this adapter recognises when there was one -
        # never the provider's wording, which can quote the request.
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER
    except OSError as error:
        print(f"generation report failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
