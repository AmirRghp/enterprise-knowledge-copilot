"""A bounded sliding window over answer requests, per role.

Same shape and same reasoning as ``app.auth.rate_limit.LoginRateLimiter``: one process, one
lock, a window swept on each call, and a cap on the number of keys. Reusing that pattern
rather than writing a second one means there is a single limiter to reason about in this
codebase, and the properties that matter - refused requests still count, capacity refuses
instead of evicting - are already established there.

**What this cannot do.** The free endpoint allows fifty requests a day for the entire
account, measured in Part 13 from the ``X-RateLimit-Limit`` header, so no per-role window
stops that budget being spent - a patient caller asking twice an hour exhausts it. What
this prevents is the other failure: a retry loop, a double-submitting client, or one actor
monopolising an endpoint whose every call reaches a third party. Protecting the daily
budget needs a per-day allowance, which is a product decision about how many questions a
user may ask in a day. No such number is invented here.

Keyed by role, so one busy role cannot lock the other out. The role comes from the session
row on every request and is never taken from the body, so a caller cannot pick which
budget it spends.
"""

from __future__ import annotations

import math
import time
from collections import deque
from collections.abc import Callable
from threading import Lock


class AnswerRateLimiter:
    """Count one answer request per role; return seconds to wait when the window is full.

    ``clock`` is injectable so the window can be tested by advancing time rather than by
    sleeping, the same seam ``LoginRateLimiter`` offers.
    """

    def __init__(
        self,
        role_limit: int,
        window_seconds: int,
        max_keys: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if role_limit <= 0 or window_seconds <= 0 or max_keys <= 0:
            raise ValueError("the limit, window and key cap must all be positive")
        self.role_limit = role_limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self.clock = clock
        self._buckets: dict[str, deque[float]] = {}
        self._lock = Lock()
        # Observability for tests and for an operator reading the endpoint's behaviour. Not
        # exposed on the response: it is a count of requests, and a caller learns nothing
        # useful about another role from a number like this.
        self.recorded = 0

    @property
    def bucket_count(self) -> int:
        with self._lock:
            return len(self._buckets)

    def bucket_roles(self) -> list[str]:
        with self._lock:
            return sorted(self._buckets)

    def retry_after(self, role: str) -> int | None:
        """Count a request; return seconds to retry when this role's window is full.

        A refused request still counts. A budget a caller can exceed for free by hammering
        it is not a budget, and a retry storm is exactly when the limit should hold hardest.

        At the key cap the call is refused rather than served by evicting an active bucket.
        Eviction would let a caller drop someone else's limit by adding keys of its own,
        which is a bypass with more steps.
        """
        with self._lock:
            now = self.clock()
            cutoff = now - self.window_seconds
            for role_key, events in list(self._buckets.items()):
                while events and events[0] <= cutoff:
                    events.popleft()
                if not events:
                    del self._buckets[role_key]

            existing = self._buckets.get(role)
            if existing is None:
                if len(self._buckets) >= self.max_keys:
                    # Refuse without recording: the window this would fall into is
                    # unknowable, and inventing a number would be a false promise.
                    return self._earliest_wait(now)
                fresh: deque[float] = deque()
                self._buckets[role] = fresh
                events = fresh
            else:
                events = existing

            if len(events) >= self.role_limit:
                return max(1, math.ceil(events[0] + self.window_seconds - now))

            events.append(now)
            self.recorded += 1
            return None

    def _earliest_wait(self, now: float) -> int:
        """Seconds until the oldest active window frees a key."""
        if not self._buckets:
            return self.window_seconds
        earliest = min(events[0] for events in self._buckets.values())
        return max(1, math.ceil(earliest + self.window_seconds - now))
