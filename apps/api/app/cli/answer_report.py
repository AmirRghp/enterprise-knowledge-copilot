"""Operator CLI: run the answer path end to end over real authorized documents.

``generation_report`` proved the *adapter* over this deployment's documents. This proves
the *answer*: retrieval, generation, the final authorization gate, citation validation and
composition, as one call. It is the surface Part 14 is reviewed through.

What this command deliberately does not do by default:

* **print any text.** Generation is the second stage that sends document text outside the
  process, and the composed answer is that text re-rendered. Parts 11 to 13 established
  that no report prints any of it, because report output ends up in terminals, tickets
  and bug reports. ``--show-text`` exists because ``plans.md`` asks a human to review a
  documented answer sample and an abstention sample, which cannot be judged from counts -
  but reaching for the flag has to be a deliberate act by an operator who knows this
  deployment's corpus is synthetic.
* **print the model's own prose.** ``GenerationResult.answer`` is retained so an operator
  can see what the model said; it is never the served text and never appears here.
* **print a rejected claim.** ``plans.md`` is explicit that an invalid claim must not be
  displayed. A report that printed one would set a fabrication beside real citations and
  invite an operator to compare them and believe they were reviewing an answer.
* **serve anything.** This is a report, not the answer path. Part 15's route does that.

Usage::

    uv run --locked python -m app.cli.answer_report --question "..."
    uv run --locked python -m app.cli.answer_report --login manager --show-text
    uv run --locked python -m app.cli.answer_report --question "..." --json
"""

import argparse
import asyncio
import json
import sys
from typing import Any, Final

import httpx

from app.answer.compose import compose_answer
from app.answer.schemas import AnswerConfig, AnswerResult, InvalidGeneration
from app.answer.service import answer
from app.cli.retrieval_report import EXIT_NO_ACCOUNT, EXIT_OK, EXIT_USAGE, _actor_for
from app.db.engine import create_engine, create_session_factory
from app.provider_config.runtime import configured_run, get_runtime
from app.provider_config.transport import provider_client
from app.providers.base import ProviderUsage
from app.providers.generation import (
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.providers.rerank import RerankProviderError, build_rerank_provider
from app.providers.retry import RetryableError
from app.providers.usage import usage_record
from app.retrieval.contracts import RetrievalConfig
from app.settings import Settings, load_settings
from app.system_prompts import effective_prompt

EXIT_PROVIDER: Final = 5
EXIT_NO_KEY: Final = 8
EXIT_UNUSABLE_RESPONSE: Final = 10
EXIT_INVALID: Final = 11

EXIT_MESSAGES: Final = {
    EXIT_NO_ACCOUNT: "no active account for that login",
    EXIT_PROVIDER: "the generation provider could not answer",
    EXIT_NO_KEY: "configure a provider in the manager panel, so nothing was sent",
    # True of both causes the adapter raises this for: a dropped ``response_format``, and
    # a claim that cannot be used (an invented handle, a field that is not a string).
    # Deliberately does not say which - claiming the schema was ignored when the body was
    # compliant sends an operator to a broken endpoint instead of to the model's output.
    EXIT_UNUSABLE_RESPONSE: "the provider's response could not be turned into claims",
    EXIT_INVALID: "the generated citations could not be validated against authorized text",
}

#: Ceiling on passages offered, matching ``AnswerConfig.max_sources`` and the five-citation
#: limit in ``technical-details.md`` subject 6.
_MAX_SOURCES: Final = 5

#: There is deliberately no "no hits" exit code. A refusal is one of this command's two
#: outcomes, not a failure to report one, so it exits ``0`` with ``abstained: True`` - the
#: same shape ``generation_report`` does not use, because there "found nothing" means the
#: adapter produced nothing and there is no answer path to have refused.


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="answer_report",
        description="Run the answer path for one account and report what it would serve.",
    )
    parser.add_argument("--login", default="employee", help="the active account to run as")
    parser.add_argument("--question", required=True, help="the question to answer")
    parser.add_argument(
        "--show-text",
        action="store_true",
        help=(
            "print the composed answer, its citations and the validated quotes. Off by "
            "default: the output is document text."
        ),
    )
    parser.add_argument("--json", action="store_true", help="print the report as JSON")
    return parser


def _usage_report(usage: ProviderUsage | None) -> dict[str, Any]:
    """Consumption figures, every unit a string or ``None``.

    ``None`` means unreported, and prints as ``None`` rather than as a zero: a zero cost
    is a claim that the provider charged nothing, which nobody established.
    """
    if usage is None:
        return {"reported": False}
    billed = usage.billed_units or {}
    return {
        "reported": True,
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
    """One sanitized line of figures. Numbers and counts only - never text."""
    return (
        f"attempts={summary['attempts']} "
        f"prompt={summary['prompt_tokens']} "
        f"completion={summary['completion_tokens']} "
        f"total={summary['total_tokens']} "
        f"cost={summary['cost']} "
        f"currency={summary['currency']}"
    )


def _print_usage_on_failure(usage: ProviderUsage | None) -> None:
    """Report what a failed call cost, on stderr.

    The accounting is only worth keeping if somebody can see it, and this deployment's
    free endpoint allows fifty requests a day - so a failed run is exactly the run whose
    cost matters most. Part 13's review found the adapter keeping the figure while the
    commands dropped it, which is the same as discarding it.
    """
    summary = _usage_report(usage)
    if not summary["reported"]:
        return
    print(f"usage: {_usage_line(summary)}", file=sys.stderr)


def _print_all_usage_on_failure(generator: Any) -> None:
    usages = getattr(generator, "last_usages", None) if generator is not None else None
    if usages:
        for usage in usages:
            _print_usage_on_failure(usage)
    else:
        _print_usage_on_failure(generator.last_usage if generator is not None else None)


async def _report(arguments: argparse.Namespace, settings: Settings) -> int:
    if not get_runtime(settings).connections["chat"]:
        print(EXIT_MESSAGES[EXIT_NO_KEY], file=sys.stderr)
        return EXIT_NO_KEY
    from app.cli.run_worker import attempt_timeout_seconds, build_provider

    # Closed in the ``finally`` below: a one-shot command exits first, so a client that is
    # never closed is never closed at all.
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

        # The same figure the worker derives, so this report's embedding deadline is the
        # worker's rather than the lease itself.
        vector_provider = build_provider(
            settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
        )
        async with factory() as session:
            system_prompt = await effective_prompt(session)
        generation_client = provider_client(timeout=30.0)
        generator = build_generation_provider(
            settings, client=generation_client, system_prompt=system_prompt
        )
        reranker = (
            build_rerank_provider(settings, client=generation_client)
            if settings.rerank_enabled
            else None
        )

        result = await answer(
            factory,
            actor=actor,
            question=arguments.question,
            config=AnswerConfig(
                retrieval=RetrievalConfig(rerank_enabled=settings.rerank_enabled),
                max_sources=_MAX_SOURCES,
            ),
            vector_provider=vector_provider,
            generator=generator,
            rerank_provider=reranker,
        )
        return _print_report(arguments, result, generator)
    except InvalidGeneration as error:
        # Fixed reason words and the handle, never the claim's text or quote: those are
        # the document rendered by a model, and CODE_STYLE.md section 9 keeps document
        # text out of logs. The operator learns which citation failed without the failure
        # re-introducing what the check exists to protect.
        print(f"{EXIT_MESSAGES[EXIT_INVALID]} - {error.reason.value}", file=sys.stderr)
        if error.handle is not None:
            print(f"handle: {error.handle}", file=sys.stderr)
        _print_all_usage_on_failure(generator)
        return EXIT_INVALID
    except GenerationResponseError:
        print(EXIT_MESSAGES[EXIT_UNUSABLE_RESPONSE], file=sys.stderr)
        _print_all_usage_on_failure(generator)
        return EXIT_UNUSABLE_RESPONSE
    except (GenerationProviderError, TimeoutError) as error:
        # Read here rather than in ``main``: the generator is closed in the ``finally``
        # below before an exception would reach ``main``, and rebuilding one to ask would
        # spend the very quota whose exhaustion may be the reason. The refusal is this
        # adapter's own wording - the provider's can quote the request.
        refusal = generator.last_refusal if generator is not None else None
        detail = f" - {refusal}" if refusal else f" ({type(error).__name__})"
        print(f"{EXIT_MESSAGES[EXIT_PROVIDER]}{detail}", file=sys.stderr)
        _print_all_usage_on_failure(generator)
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


def _print_report(arguments: argparse.Namespace, result: AnswerResult, generator: Any) -> int:
    """Print the report and return the exit code.

    Two modes, and the difference is deliberate rather than a convenience. Without
    ``--show-text`` the report carries identifiers, counts and flags - the shape Parts 11
    to 13 established. With it, the composed answer and the validated quotes appear, which
    is the sample a human has to read to judge whether the citation supports the claim.
    """
    usage = _usage_report(result.usage)
    report: dict[str, Any] = {
        "login": arguments.login,
        "provider": generator.provider_name,
        "model": generator.model,
        "abstained": result.abstained,
        "missing_parts": list(result.missing_parts),
        "claims_validated": len(result.claims),
        # Identifiers only. The citation handle is already the user-facing reference, so it
        # is the one piece of a source that is safe to print without the flag.
        "sources": [source.citation for source in result.sources],
        "usage": usage,
        "provider_usages": [usage_record(u) for u in result.usages],
    }
    if arguments.show_text:
        report["answer"] = compose_answer(result.claims, result.missing_parts, result.abstained)
        report["claims"] = [
            {
                "evidence_id": claim.handle,
                "source": claim.source.citation,
                "text": claim.text,
                "quote": claim.quote,
            }
            for claim in result.claims
        ]
    else:
        report["claims"] = [{"evidence_id": claim.handle} for claim in result.claims]

    if arguments.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"login: {report['login']}  provider: {report['provider']}")
        print(f"model: {report['model']}")
        print(f"claims validated: {report['claims_validated']}")
        print(f"sources: {len(report['sources'])}")
        for citation in report["sources"]:
            print(f"  {citation}")
        print(f"abstained: {report['abstained']}")
        print(f"missing parts: {', '.join(report['missing_parts']) or 'none'}")
        if arguments.show_text:
            print("answer:")
            print(report["answer"])
            for claim in result.claims:
                print(f"  {claim.source.citation}")
                print(f"    quote: {claim.quote}")
        print(f"usage: {_usage_line(usage) if usage['reported'] else 'not reported'}")
    return EXIT_OK


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = _parser().parse_args(argv)
    except SystemExit as exit_code:  # argparse already printed the reason
        return int(exit_code.code or EXIT_USAGE)
    try:
        return asyncio.run(configured_run(_report, arguments, load_settings()))
    except KeyboardInterrupt:
        return EXIT_PROVIDER
    except RetryableError as error:
        print(f"answer report failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER
    except OSError as error:
        print(f"answer report failed: {type(error).__name__}", file=sys.stderr)
        return EXIT_PROVIDER


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
