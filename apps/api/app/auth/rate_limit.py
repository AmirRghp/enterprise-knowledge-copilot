"""Bounded, process-local sliding windows for login attempts."""

import hashlib
import math
import time
from collections import deque
from collections.abc import Callable
from threading import Lock


class LoginRateLimiter:
    def __init__(
        self,
        pair_limit: int,
        ip_limit: int,
        window_seconds: int,
        max_keys: int,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.pair_limit = pair_limit
        self.ip_limit = ip_limit
        self.window_seconds = window_seconds
        self.max_keys = max_keys
        self.clock = clock
        self._buckets: dict[tuple[str, str], deque[float]] = {}
        self._lock = Lock()

    def retry_after(self, ip: str, login: str) -> int | None:
        """Count an attempt; return seconds to retry when either window is full.

        Denied pair attempts still count against the IP budget. At capacity we
        reject new keys instead of evicting an active limit and enabling bypass.
        """
        with self._lock:
            now = self.clock()
            cutoff = now - self.window_seconds
            for key, events in list(self._buckets.items()):
                while events and events[0] <= cutoff:
                    events.popleft()
                if not events:
                    del self._buckets[key]

            ip_key = (ip, "")
            pair_key = (ip, hashlib.sha256(login.encode()).hexdigest())
            ip_events = self._buckets.get(ip_key)
            if ip_events is not None and len(ip_events) >= self.ip_limit:
                return max(1, math.ceil(ip_events[0] + self.window_seconds - now))

            missing = sum(key not in self._buckets for key in (ip_key, pair_key))
            if len(self._buckets) + missing > self.max_keys:
                earliest = min(events[0] for events in self._buckets.values())
                return max(1, math.ceil(earliest + self.window_seconds - now))

            ip_events = self._buckets.setdefault(ip_key, deque())
            pair_events = self._buckets.setdefault(pair_key, deque())
            ip_events.append(now)
            if len(pair_events) >= self.pair_limit:
                return max(1, math.ceil(pair_events[0] + self.window_seconds - now))
            pair_events.append(now)
            return None
