"""Run the ingestion worker against the durable queue.

Run from ``apps/api``:

    # one job if one is queued, then exit
    uv run --locked python -m app.cli.run_worker --once

    # up to ten queued jobs, then exit when the queue is empty
    uv run --locked python -m app.cli.run_worker --max-jobs 10

    # stay resident and keep polling (the default); an empty queue only pauses it
    uv run --locked python -m app.cli.run_worker --poll-seconds 5

With no flags the worker stays resident until interrupted, because the queue is
filled asynchronously by the manager upload route and a worker that exited on the
first empty poll would never see the next upload. Passing ``--once`` or
``--max-jobs N`` bounds the run instead, and then an empty queue ends it - otherwise
``--max-jobs 10`` would hang on an idle queue.

The output is deliberately short and non-sensitive: job id, status, attempt, and
the stable safe code on failure. No document text, no vector, and no provider
response body is printed.

Several workers may run at the same time; the lease and its fencing token decide
which one owns each job, so a second worker is not an error and simply finds the
queue claimed.
"""

import argparse
import asyncio
import os
import socket
import sys
from collections.abc import Awaitable, Callable
from typing import Protocol

import httpx

from app.db.engine import create_engine, create_session_factory
from app.ingestion.worker import IngestionWorker, JobOutcome
from app.providers.embedding import OllamaEmbeddingProvider
from app.providers.retry import RetryPolicy
from app.settings import Settings, load_settings


class Claimable(Protocol):
    """The one thing the scheduling helpers need from a worker.

    Narrower than :class:`~app.ingestion.worker.IngestionWorker` so the schedule can
    be tested against a stub, with no database and no provider.
    """

    async def process_next_job(self) -> JobOutcome | None:
        """Claim and process one job, or return ``None`` when the queue is empty."""
        ...


def default_worker_id() -> str:
    """Return an identifier that is unique per process and readable in a log."""
    return f"{socket.gethostname()}:{os.getpid()}"


def build_provider(
    settings: Settings,
    *,
    attempt_timeout: float,
    client: httpx.AsyncClient | None = None,
) -> OllamaEmbeddingProvider:
    """Assemble the embedding adapter with one deadline applied to both layers.

    ``attempt_timeout`` must be the figure :func:`attempt_timeout_seconds` returns.
    It goes to the HTTP client *and* to the retry policy, because the client timeout
    only covers the socket phases; a handler that stalls between them is bounded
    solely by the policy. Passing the policy's default instead would leave the two
    deadlines disagreeing (Part 8 review, P2).

    Taking the figure as an argument rather than recomputing it keeps this
    constructible for a lease too short to be configured, which is what makes the
    wiring testable at all: for every configurable lease the derived figure happens
    to equal the default, so a test that only used the configured settings could not
    tell a wired policy from a defaulted one.

    ``client`` is the caller's to own or not. Left out, one is opened here - fine for the
    worker, which is a process that exits - but the API route passes one it closes in its
    ``finally``, because a provider built per request around an internally created client is
    a connection pool leaked per request (Part 15 review, P2). The borrowed client's timeout
    is left exactly as the caller set it: the route's client already carries the deadline.
    """
    owned = httpx.AsyncClient(timeout=attempt_timeout) if client is None else client
    return OllamaEmbeddingProvider(
        owned,
        base_url=str(settings.ollama_base_url),
        model=settings.ollama_embed_model,
        dimension=settings.embedding_dimension,
        expected_digest=settings.ollama_embed_digest,
        policy=RetryPolicy(attempt_timeout_seconds=attempt_timeout),
    )


def build_worker(settings: Settings, *, worker_id: str) -> IngestionWorker:
    """Assemble the worker with the configured provider and budgets."""
    engine = create_engine(settings)
    provider = build_provider(
        settings, attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds)
    )
    return IngestionWorker(
        session_factory=create_session_factory(engine),
        provider=provider,
        worker_id=worker_id,
        lease_seconds=settings.ingestion_lease_seconds,
        renew_seconds=settings.ingestion_lease_renew_seconds,
        max_attempts=settings.ingestion_max_attempts,
        max_current_chunks=settings.upload_max_current_chunks,
        max_tokens=settings.embedding_max_tokens,
    )


def attempt_timeout_seconds(lease_seconds: int) -> float:
    """Return the per-attempt provider deadline for a lease of that length.

    A third of the lease, so one embed attempt can never consume a whole lease and
    expire the worker's own claim, capped at ten seconds to match the retry budget
    ARCHITECTURE.md section 6 sets for embedding.

    Takes a plain integer rather than ``Settings`` so the relationship can be
    checked directly, including for a lease too short to be configured (a
    six-second lease yields two seconds).

    The caller must pass the result to *both* the HTTP client and the provider's
    retry policy. The client timeout alone only covers the socket phases, so a
    handler that stalls between them would otherwise be bounded only by the
    policy's default, and the two deadlines would disagree (Part 8 review, P2).
    """
    if lease_seconds <= 0:
        raise ValueError("lease_seconds must be positive")
    return float(min(10, max(1, lease_seconds // 3)))


def _report(outcome: JobOutcome) -> None:
    """Print one job's disposition.

    Only identifiers, the attempt count, and the stable safe code; no document
    text, no vector, and no provider response body.
    """
    print(  # noqa: T201 - a CLI prints to stdout
        f"job={outcome.job_id} document={outcome.document_id} "
        f"attempt={outcome.attempt} outcome={outcome.outcome} "
        f"status={outcome.status} safe_error={outcome.safe_error or '-'}"
    )


async def _run_schedule(
    worker: Claimable,
    *,
    poll_seconds: float,
    max_jobs: int,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> int:
    """Claim and process jobs until a stopping condition, and report the count.

    The contract is one sentence: **a bounded run drains the queue, an unbounded run
    stays resident.** ``max_jobs > 0`` means bounded, so it returns as soon as the
    queue is empty or that many jobs are done - which is what ``--once`` (one job) and
    ``--max-jobs N`` both mean. ``max_jobs == 0`` means resident, so an empty queue
    only pauses it.

    That distinction is the fix for Part 8 review P2. The queue is filled
    asynchronously by the manager upload route, so a resident worker that exited on
    the first empty poll would never see the next upload. Exiting on an empty queue
    is still what an explicitly bounded run should do, or ``--max-jobs 10`` would
    hang forever on an idle queue.

    ``sleep`` is injected so a test can drive the schedule without real time.
    """
    pause = sleep if sleep is not None else asyncio.sleep
    resident = max_jobs <= 0
    processed = 0
    while resident or processed < max_jobs:
        outcome = await worker.process_next_job()
        if outcome is None:
            if resident:
                await pause(poll_seconds)
                continue
            print("queue empty; stopping")  # noqa: T201
            break
        _report(outcome)
        processed += 1
    return processed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--once",
        action="store_true",
        help="process at most one queued job, then exit",
    )
    parser.add_argument(
        "--max-jobs",
        type=int,
        default=0,
        help="bounded run: exit after this many jobs or when the queue empties "
        "(0, the default, means stay resident)",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=2.0,
        help="pause after each job when staying resident (default: 2)",
    )
    parser.add_argument(
        "--worker-id",
        default=None,
        help="lease owner recorded on claimed jobs (default: host and pid)",
    )
    arguments = parser.parse_args(argv)

    if arguments.poll_seconds < 0:
        print("error: --poll-seconds must not be negative", file=sys.stderr)
        return 2
    if arguments.max_jobs < 0:
        print("error: --max-jobs must not be negative", file=sys.stderr)
        return 2

    settings = load_settings()
    worker = build_worker(settings, worker_id=arguments.worker_id or default_worker_id())

    claimed = 0
    try:
        claimed = asyncio.run(
            _run_schedule(
                worker,
                poll_seconds=arguments.poll_seconds,
                max_jobs=1 if arguments.once else arguments.max_jobs,
            )
        )
    except KeyboardInterrupt:
        # An unfinished job keeps its lease until it expires, at which point
        # another worker may reclaim it. Nothing is lost and nothing is
        # half-published, because activation is the only step that changes what
        # users can see.
        print("interrupted; an unfinished job keeps its lease until it expires")  # noqa: T201
        return 130

    if claimed == 0:
        print("no job was claimable")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
