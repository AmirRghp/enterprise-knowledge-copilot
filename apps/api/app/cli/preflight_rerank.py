"""Operator CLI: check that the optional rerank path actually works.

Reranking is off by default, so nothing else in the project exercises this code until
somebody turns it on. A preflight is what makes the switch safe: it confirms the key
works, the model is reachable, ``index`` maps back to the positions that were sent, and
the score comes back finite — against the real service, with the real corpus, and only
when a key is configured.

What this command deliberately does **not** do:

* print the question or any document text. The question is sent to the provider by
  necessity, but it must not come back out in a log a ticket will carry, and the
  corpus excerpts must not either.
* claim anything about ranking quality. Persian relevance is not asserted here and is
  not measurable from a single two-document sample. Part 18 measures that.
* run when reranking is disabled. This is a preflight *for* enabling it, so it runs
  regardless of the current setting and reports what it found.

Usage::

    uv run --locked python -m app.cli.preflight_rerank
"""

import argparse
import asyncio
import json
import sys
import uuid
from typing import Any, Final

import httpx

from app.provider_config.contracts import ProviderConfigurationError
from app.provider_config.runtime import configured_call, get_runtime
from app.provider_config.transport import provider_client
from app.providers.base import RerankCandidate
from app.providers.rerank import (
    RerankProviderError,
    RerankResponseError,
    build_rerank_provider,
)
from app.providers.retry import RetryPolicy
from app.providers.usage import usage_record
from app.settings import ConfigurationError, Settings, load_settings

EXIT_OK: Final = 0
EXIT_NO_KEY: Final = 3
EXIT_PROVIDER: Final = 5
EXIT_RESPONSE: Final = 6
EXIT_USAGE: Final = 2

#: Two documents that a reranker must be able to order. The contrast is what makes the
#: check meaningful: if the model returned them in input order by luck, the test would
#: prove nothing about whether the scores are usable.
_SAMPLE_DOCUMENTS: Final = (
    "درخواست بازپرداخت هزینه سفر باید ظرف پانزده روز ثبت شود.",
    "سقف پرداخت مدیران پانصد میلیون ریال است.",
)

_SAMPLE_QUESTION: Final = "مهلت ثبت درخواست بازپرداخت چند روز است؟"

#: The preflight must not spend real time; the production budget applies and a stalled
#: provider should be discovered quickly rather than after twenty seconds.
_PREFLIGHT_POLICY: Final = RetryPolicy(attempts=2, attempt_timeout_seconds=10.0)

EXIT_MESSAGES: Final = {
    EXIT_NO_KEY: "configure a provider in the manager panel",
    EXIT_PROVIDER: "the rerank provider could not answer",
    EXIT_RESPONSE: "the rerank provider answered with something unusable",
}


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.preflight_rerank",
        description="Check the optional OpenRouter rerank path. Prints no document text.",
    )
    parser.add_argument("--json", action="store_true", help="emit the result as JSON")
    return parser


class _BuiltProvider:
    """An adapter together with the client it owns.

    Returned as one object so the client cannot outlive its adapter by accident: a bare
    tuple invites taking the adapter and dropping the client, and for a one-shot command
    the sockets are then never closed at all because the process exits first.
    """

    __slots__ = ("client", "provider")

    def __init__(self, client: httpx.AsyncClient, provider: Any) -> None:
        self.client = client
        self.provider = provider

    async def aclose(self) -> None:
        await self.client.aclose()


def _build(settings: Settings) -> _BuiltProvider:
    client = provider_client(timeout=_PREFLIGHT_POLICY.attempt_timeout_seconds)
    return _BuiltProvider(
        client, build_rerank_provider(settings, client=client, policy=_PREFLIGHT_POLICY)
    )


async def run_preflight(settings: Settings) -> dict[str, Any]:
    """Send two documents and report what came back, without echoing any text."""
    if not get_runtime(settings).connections["rerank"]:
        raise ProviderConfigurationError("provider is not configured")
    built = _build(settings)
    try:
        return await _run_checks(built.provider)
    except (RerankProviderError, TimeoutError):
        for usage in getattr(built.provider, "last_usages", []):
            print("provider usage: " + json.dumps(usage_record(usage)), file=sys.stderr)
        raise
    finally:
        await built.aclose()


async def _run_checks(provider: Any) -> dict[str, Any]:
    """Exercise the adapter and describe the answer, without echoing any text."""
    # Distinct ids so nothing about the corpus leaks through an identifier either.
    candidates = [RerankCandidate(chunk_id=uuid.uuid4(), text=text) for text in _SAMPLE_DOCUMENTS]

    scored = await provider.rerank(_SAMPLE_QUESTION, candidates, top_n=len(candidates))
    usage = provider.last_usage

    # Every returned chunk id must be one of the two that were sent. A provider that
    # invented an identifier, or echoed one twice, would be caught here rather than in
    # a ranking three stages downstream.
    sent = {candidate.chunk_id for candidate in candidates}
    returned = [item.chunk_id for item in scored]
    unknown = [str(item) for item in returned if item not in sent]
    duplicates = len(returned) != len(set(returned))
    ordered = [item.score for item in scored]

    checks = {
        "index_mapping_ok": not unknown and not duplicates,
        "unknown_identifiers": len(unknown),
        "duplicate_identifiers": duplicates,
        "scores_finite": all(score == score and abs(score) != float("inf") for score in ordered),
        "scores_descending": all(
            earlier >= later for earlier, later in zip(ordered, ordered[1:], strict=False)
        ),
        "scores_distinct": len(set(ordered)) == len(ordered),
    }
    return {
        "provider": provider.provider_name,
        "model": provider.model,
        "documents_sent": len(candidates),
        "results_returned": len(scored),
        **checks,
        # The verdict travels inside the report so that the JSON output says whether
        # the checks passed, not only the individual fields. A reader of the JSON who
        # had to recompute the verdict would have to re-implement this function to
        # know whether the preflight passed.
        "verdict": _verdict(checks),
        "usage": _usage_report(usage),
        "provider_usages": [usage_record(u) for u in getattr(provider, "last_usages", [])],
    }


def _usage_report(usage: Any) -> dict[str, Any]:
    """Report consumption, naming an absent figure as unknown rather than zero."""
    if usage is None:
        return {"reported": False}
    billed = usage.billed_units or {}
    return {
        "reported": True,
        # Every unit is a string or null, never an invented zero.
        "search_units": str(billed["search_units"]) if "search_units" in billed else None,
        "total_tokens": str(billed["total_tokens"]) if "total_tokens" in billed else None,
        "cost": str(usage.cost) if usage.cost is not None else None,
        "currency": usage.currency,
    }


def _verdict(checks: dict[str, Any]) -> int:
    """The exit code the checks imply.

    ``index_mapping_ok`` and ``scores_finite`` are the two that make the answer
    unusable: an index that does not point at what was sent cannot be mapped to a chunk,
    and a score that cannot be ordered cannot produce a ranking. The other checks are
    reported for a human to weigh and do not by themselves make the path unusable - a
    provider that returns equal scores has answered, just unhelpfully.
    """
    if not checks["index_mapping_ok"] or not checks["scores_finite"]:
        return EXIT_RESPONSE
    return EXIT_OK


def _print_text(report: dict[str, Any]) -> None:
    print(f"provider: {report['provider']}")
    print(f"model: {report['model']}")
    print(f"documents sent: {report['documents_sent']}")
    print(f"results returned: {report['results_returned']}")
    print(f"index mapping valid: {report['index_mapping_ok']}")
    print(f"scores finite: {report['scores_finite']}")
    print(f"scores descending: {report['scores_descending']}")
    print(f"scores distinct: {report['scores_distinct']}")
    usage = report["usage"]
    if not usage["reported"]:
        print("usage: not reported by the provider")
    else:
        units = usage["search_units"] or "unknown"
        tokens = usage["total_tokens"] or "unknown"
        cost = usage["cost"] or "unknown"
        print(f"usage: search_units={units} total_tokens={tokens} cost={cost}")
    if report["scores_distinct"]:
        print("note: the two sample documents scored differently, so the ranking is usable")


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        settings = load_settings()
    except ProviderConfigurationError:
        print("configure providers in the manager panel", file=sys.stderr)
        return 2
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return EXIT_USAGE

    try:
        report = asyncio.run(configured_call(settings, run_preflight))
    except ProviderConfigurationError:
        print(EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
        return EXIT_NO_KEY
    except RerankResponseError:
        print(EXIT_MESSAGES[EXIT_RESPONSE], file=sys.stderr)
        return EXIT_RESPONSE
    except RerankProviderError as error:
        # Only the class name: a gateway error may quote the request, and the request
        # is the question and the document texts.
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]} ({type(error).__name__})", file=sys.stderr)
        return EXIT_PROVIDER
    except OSError as error:
        print(f"preflight failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER

    if arguments.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_text(report)
    verdict: int = report["verdict"]
    if verdict != EXIT_OK:
        print(EXIT_MESSAGES[verdict], file=sys.stderr)
    return verdict


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
