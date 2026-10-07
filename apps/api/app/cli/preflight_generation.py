"""Operator CLI: check that structured generation actually works on this endpoint.

Generation is the second stage that would send document text outside the process, and
the first one whose *shape* the project depends on: every claim, every abstention flag
and the refusal text downstream are read out of a JSON Schema the provider was asked to
enforce. A model that quietly ignores ``response_format`` returns fluent prose, and the
failure looks like a schema violation rather than a silent downgrade to free text — which
is exactly the kind of failure that would otherwise be discovered by reading a user's
answer.

So this command's one real job is to prove the schema is honoured, against the real
service, with the real model, and to stop with a clear failure if it is not.

What this command deliberately does **not** do:

* print the question, the evidence text, or the model's prose. The question and the
  passages are sent to the provider by necessity, and the model's prose is a rendering
  of them; none of it belongs in a log a ticket will carry.
* use the real corpus. The samples below are synthetic and about a policy nobody has,
  because the endpoint is a free one and the project's corpus must stay fictitious.
* claim anything about answer quality, Persian fluency, or citation correctness. Whether
  a claim is *true* is Part 14's validation and Part 18's measurement, and neither is
  provable from two synthetic passages.
* serve anything. This is a preflight, not the answer path.

Usage::

    uv run --locked python -m app.cli.preflight_generation
"""

import argparse
import asyncio
import json
import sys
from typing import Any, Final

import httpx

from app.providers.base import EvidenceItem, ProviderUsage
from app.providers.generation import (
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.providers.retry import RetryPolicy
from app.settings import ConfigurationError, Settings, load_settings

EXIT_OK: Final = 0
EXIT_NO_KEY: Final = 3
EXIT_PROVIDER: Final = 5
EXIT_RESPONSE: Final = 6
EXIT_USAGE: Final = 2

#: Two passages about a policy that exists in neither the corpus nor any real
#: organization, with a question whose answer is in only one of them. The contrast is
#: what makes the check mean something: a single passage would pass just as well whether
#: the model reads it or ignores it.
_SAMPLE_EVIDENCE: Final = (
    (
        "E1",
        "در سیاست نمونهٔ نگهبانی، مهلت ثبت درخواست بازپرداخت پانزده روز است.",
    ),
    ("E2", "در سیاست نمونهٔ نگهبانی، سقف پرداخت مدیران پانصد میلیون ریال است."),
)

_SAMPLE_QUESTION: Final = "در سیاست نمونهٔ نگهبانی، مهلت ثبت درخواست چند روز است؟"

#: The **production** budget, deliberately not a tighter one. The rerank preflight can
#: afford ten seconds because a reranker answers in about a second; this model measures
#: six to nine against the free endpoint, which sits exactly on a ten-second deadline. A
#: preflight tighter than production reports failures the deployed path would not have,
#: and the first version of this command did exactly that: three consecutive runs failed
#: on latency while the adapter itself succeeded under the real budget. A preflight's job
#: is to predict production behaviour, so it has to run on production's terms.
_PREFLIGHT_POLICY: Final = RetryPolicy(attempts=2, attempt_timeout_seconds=30.0)

EXIT_MESSAGES: Final = {
    EXIT_NO_KEY: "no OpenRouter API key is configured",
    EXIT_PROVIDER: "the generation provider could not answer",
    EXIT_RESPONSE: "the generation provider did not honour the JSON schema",
}

#: Appended to the provider message when the adapter named the refusal, so an operator
#: is told whether to wait or to go looking for an outage.
EXIT_DETAIL: Final = " ({refusal})"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli.preflight_generation",
        description=(
            "Check the structured generation path. Prints no question, no evidence text "
            "and no model prose."
        ),
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
    client = httpx.AsyncClient(timeout=_PREFLIGHT_POLICY.attempt_timeout_seconds)
    return _BuiltProvider(
        client, build_generation_provider(settings, client=client, policy=_PREFLIGHT_POLICY)
    )


async def run_preflight(settings: Settings) -> dict[str, Any]:
    """Send two synthetic passages and report what came back, without echoing any text."""
    built = _build(settings)
    try:
        return await _run_checks(built.provider)
    finally:
        # Stashed for the error paths below, which cannot read the provider: it is closed
        # here before an exception would reach ``main``. The provider object itself, not
        # one value copied out of it, so the refusal and the usage cannot disagree.
        _LAST_PROVIDER["value"] = built.provider
        await built.aclose()


async def _run_checks(provider: Any) -> dict[str, Any]:
    """Exercise the adapter and describe the answer, without echoing any text."""
    evidence = [
        EvidenceItem(evidence_id=identifier, text=text) for identifier, text in _SAMPLE_EVIDENCE
    ]

    result = await provider.generate(question=_SAMPLE_QUESTION, evidence=evidence)
    usage = provider.last_usage

    # A claim that cites a handle this command never sent is already refused by the
    # adapter, so it cannot be counted here: a check that can never fire would be a
    # claim of coverage without any. What the adapter deliberately leaves alone is
    # whether the quote appears in the passage it cites, and that is reported as an
    # observation - Part 14 is where a paraphrase is refused.
    texts = {item.evidence_id: item.text for item in evidence}
    quoted_elsewhere = sorted(
        claim.evidence_id
        for claim in result.claims
        if claim.quote.strip() and claim.quote.strip() not in texts.get(claim.evidence_id, "")
    )

    checks = {
        # Abstaining and answering at the same time is a contradiction a caller cannot
        # resolve: serving the claims would ignore the abstention, and honouring the
        # abstention would throw away the claims. Part 14 has to pick one, so a model
        # that returns both has not followed the contract.
        "contradictory": result.abstained and bool(result.claims),
        "quotes_not_verbatim": quoted_elsewhere,
        "abstained": result.abstained,
        "missing_parts": list(result.missing_parts),
        # Whether the model wrote prose at all, never the prose itself.
        "answer_present": result.answer is not None,
    }
    return {
        "provider": provider.provider_name,
        "model": provider.model,
        "evidence_sent": len(evidence),
        "claims_returned": len(result.claims),
        "cited_evidence_ids": [claim.evidence_id for claim in result.claims],
        **checks,
        "verdict": _verdict(checks),
        "usage": _usage_report(usage),
    }


def _usage_report(usage: ProviderUsage | None) -> dict[str, Any]:
    """Report consumption, naming an absent figure as unknown rather than zero."""
    if usage is None:
        return {"reported": False}
    billed = usage.billed_units or {}
    return {
        "reported": True,
        "attempts": usage.attempts,
        # Every unit is a string or null, never an invented zero.
        "prompt_tokens": str(billed["prompt_tokens"]) if "prompt_tokens" in billed else None,
        "completion_tokens": (
            str(billed["completion_tokens"]) if "completion_tokens" in billed else None
        ),
        "total_tokens": str(billed["total_tokens"]) if "total_tokens" in billed else None,
        "cost": str(usage.cost) if usage.cost is not None else None,
        # The published ChatUsage carries no currency field, so the unit stays unknown
        # rather than being guessed from OpenRouter's pricing pages.
        "currency": usage.currency,
    }


def _refusal_of_run() -> str | None:
    """The refusal recorded by the provider the last run built, if any."""
    provider = _LAST_PROVIDER.get("value")
    return provider.last_refusal if provider is not None else None


def _usage_of_run() -> Any:
    """The usage recorded by the provider the last run built, if any."""
    provider = _LAST_PROVIDER.get("value")
    return provider.last_usage if provider is not None else None


def _print_usage_on_failure() -> None:
    """Print what a failed preflight cost, on stderr.

    Same reason as the report's, and sharper here: the free endpoint allows fifty requests
    a day, so a preflight that fails is exactly the run whose cost an operator needs to
    see. Figures only - the usage block holds numbers and names, never text.
    """
    summary = _usage_report(_usage_of_run())
    if not summary["reported"]:
        return
    print(
        "usage: "
        f"attempts={summary['attempts']} "
        f"prompt={summary['prompt_tokens']} "
        f"completion={summary['completion_tokens']} "
        f"total={summary['total_tokens']} "
        f"cost={summary['cost']} "
        f"currency={summary['currency']}",
        file=sys.stderr,
    )


#: Stashed between ``run_preflight`` and ``main``. A one-shot command has nowhere else to
#: put it: the provider is closed before the exception reaches ``main``, and rebuilding
#: one to ask would cost the very quota whose exhaustion is being reported.
_LAST_PROVIDER: dict[str, Any] = {"value": None}


def _verdict(checks: dict[str, Any]) -> int:
    """The exit code the checks imply.

    Only a contradiction fails the run. An abstention is a *correct* answer when the
    evidence does not support one, and prose being absent is not a defect either - so a
    preflight that failed on those would be testing the model's judgement rather than the
    endpoint's support for ``response_format``. A schema the endpoint dropped raises
    ``GenerationResponseError`` before this function is ever reached, which is the other
    way this command can fail.
    """
    if checks["contradictory"]:
        return EXIT_RESPONSE
    return EXIT_OK


def _print_text(report: dict[str, Any]) -> None:
    print(f"provider: {report['provider']}")
    print(f"model: {report['model']}")
    print(f"evidence sent: {report['evidence_sent']}")
    print(f"claims returned: {report['claims_returned']}")
    print(f"cited evidence ids: {', '.join(report['cited_evidence_ids']) or 'none'}")
    print(f"abstained and answered at once: {report['contradictory']}")
    if report["quotes_not_verbatim"]:
        print(f"quotes not verbatim: {', '.join(report['quotes_not_verbatim'])}")
    print(f"abstained: {report['abstained']}")
    print(f"missing parts: {', '.join(report['missing_parts']) or 'none'}")
    print(f"answer present: {report['answer_present']}")
    usage = report["usage"]
    if usage["reported"]:
        print(
            "usage: "
            f"attempts={usage['attempts']} prompt={usage['prompt_tokens']} "
            f"completion={usage['completion_tokens']} "
            f"total={usage['total_tokens']} cost={usage['cost']} currency={usage['currency']}"
        )
    else:
        print("usage: not reported")
    if report["verdict"] == EXIT_OK:
        print("note: the endpoint answered with the requested JSON schema")
    else:
        print("note: the endpoint did not answer with the requested JSON schema")


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        settings = load_settings()
    except ConfigurationError as error:
        print(str(error), file=sys.stderr)
        return EXIT_USAGE

    if not settings.openrouter_api_key.get_secret_value():
        print(EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
        return EXIT_NO_KEY

    try:
        report = asyncio.run(run_preflight(settings))
    except GenerationResponseError:
        print(EXIT_MESSAGES[EXIT_RESPONSE], file=sys.stderr)
        _print_usage_on_failure()
        return EXIT_RESPONSE
    except GenerationProviderError as error:
        # The class name, and the refusal this adapter recognises - never the provider's
        # wording, because a gateway body can quote the request, and the request is the
        # question and the evidence texts.
        refusal = _refusal_of_run()
        detail = f" - {refusal}" if refusal else f" ({type(error).__name__})"
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]}{detail}", file=sys.stderr)
        _print_usage_on_failure()
        return EXIT_PROVIDER
    except OSError as error:
        print(f"preflight failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER

    if arguments.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_text(report)
    verdict: int = report["verdict"]
    return verdict


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
