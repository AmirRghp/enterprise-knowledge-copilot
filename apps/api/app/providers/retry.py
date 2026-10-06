"""Bounded retry with an explicit, injectable clock.

ARCHITECTURE.md section 6 fixes the budget: embedding gets at most two attempts of
at most ten seconds each, and only a network failure or 429/502/503/504 is
retried, with exponential backoff and jitter. Anything else - a parse error, a
wrong dimension, a 404 for an unknown model - is deterministic and must fail on
the first attempt instead of burning the budget.

The sleep function is injected so tests exercise the schedule deterministically
rather than waiting on real time.
"""

import asyncio
import random
from collections.abc import Awaitable, Callable

# ARCHITECTURE.md section 6: only these statuses are transient.
RETRYABLE_STATUS = frozenset({429, 502, 503, 504})

DEFAULT_ATTEMPTS = 2
DEFAULT_ATTEMPT_TIMEOUT_SECONDS = 10.0
# A base backoff short enough to stay inside the two-attempt budget.
DEFAULT_BASE_BACKOFF_SECONDS = 0.2
DEFAULT_MAX_BACKOFF_SECONDS = 1.0


class RetryableError(Exception):
    """Marks a failure as transient so the caller should try again."""


class RetryPolicy:
    """The retry budget for one provider call."""

    __slots__ = (
        "attempt_timeout_seconds",
        "attempts",
        "base_backoff_seconds",
        "max_backoff_seconds",
    )

    def __init__(
        self,
        attempts: int = DEFAULT_ATTEMPTS,
        attempt_timeout_seconds: float = DEFAULT_ATTEMPT_TIMEOUT_SECONDS,
        base_backoff_seconds: float = DEFAULT_BASE_BACKOFF_SECONDS,
        max_backoff_seconds: float = DEFAULT_MAX_BACKOFF_SECONDS,
    ) -> None:
        if attempts < 1:
            raise ValueError("attempts must be at least 1")
        if attempt_timeout_seconds <= 0:
            raise ValueError("attempt timeout must be positive")
        if base_backoff_seconds < 0 or max_backoff_seconds < 0:
            raise ValueError("backoff must not be negative")
        self.attempts = attempts
        self.attempt_timeout_seconds = attempt_timeout_seconds
        self.base_backoff_seconds = base_backoff_seconds
        self.max_backoff_seconds = max_backoff_seconds

    def backoff_for(self, attempt: int, jitter: float) -> float:
        """Return the wait before ``attempt`` (1-based), capped and jittered.

        ``jitter`` is expected in ``[0, 1)`` and scales the delay so concurrent
        callers do not retry in lockstep.
        """
        exponential = self.base_backoff_seconds * (2 ** (attempt - 1))
        capped = min(float(exponential), self.max_backoff_seconds)
        scale = 1.0 - max(0.0, min(float(jitter), 1.0)) * 0.5
        return float(capped * scale)


async def arun_with_retry[Result](
    operation: Callable[[], Awaitable[Result]],
    *,
    policy: RetryPolicy | None = None,
    jitter: Callable[[], float] | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
) -> Result:
    """Await ``operation`` under ``policy``, retrying only transient failures.

    Each attempt runs inside a real wall-clock deadline. The HTTP client's own
    timeout only covers connect/read/write/pool phases and does not bound a
    handler that stalls between them, so the deadline is enforced here with
    ``asyncio.timeout``. A call that overruns is turned into a
    :class:`RetryableError` and therefore still consumes the bounded budget.

    The last transient error is re-raised once the budget is spent, so a caller
    never sees a silent partial result.
    """
    active = policy or RetryPolicy()
    jitter_source = jitter or random.random
    sleeper = sleep if sleep is not None else _default_sleep

    last_error: BaseException | None = None
    for attempt in range(1, active.attempts + 1):
        try:
            async with asyncio.timeout(active.attempt_timeout_seconds):
                return await operation()
        except TimeoutError as error:
            # The attempt overran its deadline; report it as transient.
            last_error = RetryableError("attempt exceeded its wall-clock deadline")
            del error
        except RetryableError as error:
            last_error = error

        if attempt >= active.attempts:
            break
        delay = active.backoff_for(attempt, jitter_source())
        if delay > 0:
            await sleeper(delay)

    if last_error is None:  # pragma: no cover - unreachable without a failure
        raise RuntimeError("retry loop finished without a result or an error")
    raise last_error


async def _default_sleep(seconds: float) -> None:
    import asyncio  # noqa: PLC0415

    await asyncio.sleep(seconds)


def is_retryable_status(status: int) -> bool:
    """Return whether an HTTP status is worth retrying."""
    return status in RETRYABLE_STATUS
