"""Process-local active and queued provider calls for the single API instance."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable


class ProviderQueueFull(Exception):
    pass


class ProviderQueueTimeout(Exception):
    pass


class ProviderCapacity:
    def __init__(self, queue_limit: int = 50, clock: Callable[[], float] = time.monotonic):
        self.queue_limit = queue_limit
        self.clock = clock
        self._lock = asyncio.Lock()
        self._active = {"ollama": 0, "cloud": 0}
        self._limits = {"ollama": 1, "cloud": 6}
        self._version = 1
        self._queues: dict[str, deque[asyncio.Future[None]]] = {
            "ollama": deque(),
            "cloud": deque(),
        }

    async def configure(self, ollama: int, cloud: int, version: int | None = None) -> None:
        async with self._lock:
            if version is not None and version < self._version:
                return
            self._limits.update(ollama=ollama, cloud=cloud)
            if version is not None:
                self._version = version
            self._drain("ollama")
            self._drain("cloud")

    def _drain(self, group: str) -> None:
        queue = self._queues[group]
        while queue and self._active[group] < self._limits[group]:
            waiter = queue.popleft()
            if waiter.cancelled():
                continue
            self._active[group] += 1
            waiter.set_result(None)

    async def acquire(self, group: str, limit: int | None, deadline: float) -> bool:
        async with self._lock:
            limit = self._limits[group] if limit is None else limit
            self._limits[group] = limit
            self._drain(group)
            if self._active[group] < limit and not self._queues[group]:
                self._active[group] += 1
                return False
            if len(self._queues[group]) >= self.queue_limit:
                raise ProviderQueueFull
            waiter = asyncio.get_running_loop().create_future()
            self._queues[group].append(waiter)
            self._drain(group)
        try:
            await asyncio.wait_for(asyncio.shield(waiter), max(0, deadline - self.clock()))
            return True
        except TimeoutError:
            if waiter.done() and not waiter.cancelled():
                return True
            raise ProviderQueueTimeout from None
        finally:
            if not waiter.done() or waiter.cancelled():
                async with self._lock:
                    try:
                        self._queues[group].remove(waiter)
                    except ValueError:
                        pass
                    if waiter.done() and not waiter.cancelled():
                        self._active[group] -= 1
                    self._drain(group)

    async def release(self, group: str) -> None:
        async with self._lock:
            self._active[group] -= 1
            self._drain(group)

    async def snapshot(self, group: str) -> tuple[int, int]:
        async with self._lock:
            return self._active[group], len(self._queues[group])
