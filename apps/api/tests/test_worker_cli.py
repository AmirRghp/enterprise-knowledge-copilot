"""Tests for the ingestion worker CLI's scheduling and timeout wiring.

Part 8 review, P2: the polling loop exited on the first empty queue, so a resident
worker never saw the next upload, and the effective provider timeout reached the
HTTP client but not the retry policy.

No database and no provider are involved here: the worker is driven through a stub,
so these tests only pin the CLI's own decisions.
"""

import asyncio
import time
from typing import Any

import pytest

from app.cli.run_worker import (
    _run_schedule,
    attempt_timeout_seconds,
    build_provider,
)
from app.providers.base import EmbeddingProviderError
from app.providers.embedding import OllamaEmbeddingProvider
from app.providers.retry import RetryableError, RetryPolicy
from app.settings import Settings
from tests.provider_fixtures import panel_settings


class BudgetExhausted(Exception):
    """Raised by the stub to break out of an otherwise unbounded loop."""


class StubWorker:
    """Returns a scripted sequence of outcomes, recording how often it was asked."""

    def __init__(self, script: list[Any], *, max_polls: int | None = None) -> None:
        self._script = list(script)
        self._max_polls = max_polls
        self.polls = 0
        #: Poll numbers on which work was actually claimed, 1-based.
        self.claimed_on: list[int] = []

    async def process_next_job(self) -> Any:
        self.polls += 1
        if self._max_polls is not None and self.polls > self._max_polls:
            raise BudgetExhausted
        if not self._script:
            return None
        outcome = self._script.pop(0)
        if outcome is not None:
            self.claimed_on.append(self.polls)
        return outcome


def _outcome(name: str) -> Any:
    return type(
        "Outcome",
        (),
        {
            "job_id": "j",
            "document_id": "d",
            "attempt": 1,
            "outcome": name,
            "status": name,
            "safe_error": None,
            "revision": "r",
        },
    )()


# --- P2: an empty queue pauses the loop instead of ending it ----------------


def test_a_resident_run_survives_an_empty_queue_and_processes_a_later_job() -> None:
    """The first two polls find nothing; the job that arrives next must be seen.

    ``max_jobs=0`` is the resident mode, which is the default with no flags - and the
    mode that was broken: it used to exit on the first empty poll, so a resident
    worker never saw the next upload.
    """

    async def scenario() -> tuple[StubWorker, list[float]]:
        worker = StubWorker([None, None, _outcome("ready")], max_polls=4)
        slept: list[float] = []

        async def sleep(seconds: float) -> None:
            slept.append(seconds)

        with pytest.raises(BudgetExhausted):
            await _run_schedule(worker, poll_seconds=2.0, max_jobs=0, sleep=sleep)
        return worker, slept

    worker, slept = asyncio.run(scenario())
    assert worker.claimed_on == [3], "the job that arrived after two empty polls was claimed"
    assert slept[:2] == [2.0, 2.0], "it paused on each empty poll instead of exiting"


def test_polling_keeps_asking_after_the_queue_empties() -> None:
    async def scenario() -> int:
        worker = StubWorker([None, _outcome("ready")], max_polls=5)

        async def sleep(seconds: float) -> None:
            return None

        with pytest.raises(BudgetExhausted):
            await _run_schedule(worker, poll_seconds=0.0, max_jobs=0, sleep=sleep)
        return worker.polls

    assert asyncio.run(scenario()) == 6, "it kept polling rather than stopping"


def test_polling_runs_without_a_job_limit_until_interrupted() -> None:
    """``max_jobs = 0`` means resident: it keeps processing as jobs appear."""

    async def scenario() -> int:
        worker = StubWorker([None, _outcome("ready"), None, _outcome("ready")], max_polls=4)

        async def sleep(seconds: float) -> None:
            return None

        with pytest.raises(BudgetExhausted):
            await _run_schedule(worker, poll_seconds=0.0, max_jobs=0, sleep=sleep)
        return 2

    assert asyncio.run(scenario()) == 2


async def _noop(seconds: float) -> None:
    """A sleep that returns immediately, so the schedule runs without real time."""
    return None


def test_max_jobs_still_bounds_a_bounded_run() -> None:
    async def scenario() -> int:
        # A poll budget as well as the job limit, so a schedule that ignores
        # max_jobs fails the test instead of hanging it.
        worker = StubWorker([_outcome("ready")] * 5, max_polls=10)
        return await _run_schedule(worker, poll_seconds=0.0, max_jobs=3, sleep=_noop)

    assert asyncio.run(scenario()) == 3


def test_a_bounded_run_that_finds_nothing_returns_immediately() -> None:
    async def scenario() -> int:
        # A poll budget as well, so a schedule that fails to exit on an empty queue
        # fails the test instead of hanging it.
        worker = StubWorker([None, _outcome("ready")], max_polls=10)
        return await _run_schedule(worker, poll_seconds=0.0, max_jobs=5, sleep=_noop)

    assert asyncio.run(scenario()) == 0


def test_a_bounded_run_exits_on_the_first_empty_poll() -> None:
    """``--once`` and ``--max-jobs N`` are bounded: they drain, then leave.

    Exiting here is what keeps ``--max-jobs 10`` from hanging on an idle queue.
    """

    async def scenario() -> int:
        worker = StubWorker([_outcome("ready"), None, _outcome("ready")], max_polls=10)
        return await _run_schedule(worker, poll_seconds=0.0, max_jobs=10, sleep=_noop)

    assert asyncio.run(scenario()) == 1


# --- P2: the effective timeout must reach the retry policy ------------------


@pytest.mark.parametrize(
    ("lease_seconds", "expected"),
    [(6, 2.0), (9, 3.0), (30, 10.0), (120, 10.0), (600, 10.0)],
)
def test_the_attempt_timeout_is_a_third_of_the_lease_capped_at_ten(
    lease_seconds: int, expected: float
) -> None:
    assert attempt_timeout_seconds(lease_seconds) == expected


def test_a_non_positive_lease_is_rejected() -> None:
    with pytest.raises(ValueError, match="positive"):
        attempt_timeout_seconds(0)


def test_the_configured_timeout_reaches_both_the_client_and_the_policy() -> None:
    """Part 8 review P2: the two deadlines must not disagree."""
    settings = panel_settings(Settings(_env_file=None))
    provider = build_provider(
        settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
    )
    expected = attempt_timeout_seconds(settings.ingestion_lease_seconds)

    assert isinstance(provider.build(provider.items[0], provider.client), OllamaEmbeddingProvider)
    assert (
        provider.build(provider.items[0], provider.client)._policy.attempt_timeout_seconds
        == expected
    )
    assert provider.client.timeout.read == expected


def test_the_policy_takes_the_supplied_deadline_rather_than_its_default() -> None:
    """The regression guard that the previous test cannot provide.

    For every configurable lease the derived figure is exactly ten seconds, which is
    also ``RetryPolicy``'s default, so asserting equality against the configured
    settings cannot tell a wired policy from a defaulted one. A lease short enough to
    diverge is not configurable, so the deadline is passed in directly - and a build
    that ignored it would hand back the default and fail here.
    """
    settings = panel_settings(Settings(_env_file=None))
    default_policy_timeout = RetryPolicy().attempt_timeout_seconds
    assert default_policy_timeout != 2.0, "the default changed; update this test"

    provider = build_provider(settings, attempt_timeout=2.0)
    assert isinstance(provider.build(provider.items[0], provider.client), OllamaEmbeddingProvider)
    assert provider.build(provider.items[0], provider.client)._policy.attempt_timeout_seconds == 2.0
    assert provider.client.timeout.read == 2.0


def test_a_borrowed_client_is_used_verbatim() -> None:
    """A caller-supplied client must be the one the adapter ends up holding.

    Without this, ``build_provider`` opening its own client is invisible from outside: the
    adapter is constructed successfully either way, and the caller closes the client it
    brought - which is not the one holding the open sockets. That was the Part 15 review's
    P2, a connection pool leaked per question, and it hid behind a passing build.

    Asserted by identity on the private field, because there is no public accessor and adding
    one to make a test comfortable would be a worse change than reading the field that the
    neighbouring policy test above already reads.
    """
    import httpx

    settings = panel_settings(Settings(_env_file=None))
    borrowed = httpx.AsyncClient(timeout=11.0)

    provider = build_provider(settings, attempt_timeout=2.0, client=borrowed)

    assert provider.client is borrowed
    # The caller's timeout is theirs to set; this build must not overwrite it.
    assert provider.client.timeout.read == 11.0
    # The retry policy still takes the supplied deadline, which is a separate concern from
    # whose socket timeout it is.
    assert provider.build(provider.items[0], provider.client)._policy.attempt_timeout_seconds == 2.0


def test_an_owned_client_is_opened_when_none_is_supplied() -> None:
    """The worker's own path is unchanged: no client in, one opened out.

    Pinned because the borrowing branch above would let a regression that always borrowed
    pass, leaving the worker with an unclosed client it never closes.
    """

    settings = panel_settings(Settings(_env_file=None))

    provider = build_provider(settings, attempt_timeout=2.0)

    assert provider.client is not None
    assert provider.client.timeout.read == 2.0


def test_a_six_second_lease_bounds_an_outbound_attempt_at_two_seconds() -> None:
    """The review's own case: lease 6s means a ~2s wall-clock deadline."""
    timeout = attempt_timeout_seconds(6)
    assert timeout == 2.0

    import httpx

    class Stalling(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            await asyncio.sleep(30)
            raise AssertionError("unreachable")

    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=Stalling(), timeout=timeout),
        base_url="http://ollama.test:11434",
        model="m:latest",
        dimension=768,
        expected_digest="a" * 64,
        policy=RetryPolicy(attempts=1, attempt_timeout_seconds=timeout, base_backoff_seconds=0),
    )

    async def scenario() -> float:
        started = time.perf_counter()
        with pytest.raises(RetryableError):
            await provider.embed_query("متن")
        return time.perf_counter() - started

    assert asyncio.run(scenario()) < 6.0


def test_a_provider_refusal_is_not_retried_forever() -> None:
    """Sanity: the policy bound and the exception split still hold together."""
    import httpx

    class Refusing(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(
                    200, json={"models": [{"name": "m:latest", "digest": "a" * 64}]}
                )
            return httpx.Response(404, json={"error": "no"})

    provider = OllamaEmbeddingProvider(
        httpx.AsyncClient(transport=Refusing()),
        base_url="http://ollama.test:11434",
        model="m:latest",
        dimension=768,
        expected_digest="a" * 64,
        policy=RetryPolicy(attempts=2, attempt_timeout_seconds=2, base_backoff_seconds=0),
    )

    async def scenario() -> None:
        with pytest.raises(EmbeddingProviderError):
            await provider.embed_query("متن")

    asyncio.run(scenario())
