import asyncio
import uuid
from types import SimpleNamespace

import httpx
import pytest

from app.provider_config.runtime import Chain, Connection, LiveClient, Runtime
from app.providers.capacity import ProviderCapacity, ProviderQueueFull, ProviderQueueTimeout
from app.settings import Settings


def test_active_limit_queue_bound_and_release_after_completion() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity(queue_limit=50)
        await capacity.configure(ollama=1, cloud=6)
        deadline = asyncio.get_running_loop().time() + 2
        await capacity.acquire("ollama", 1, deadline)

        async def queued_call() -> None:
            await capacity.acquire("ollama", 1, deadline)
            await capacity.release("ollama")

        waiting = [asyncio.create_task(queued_call()) for _ in range(50)]
        await asyncio.sleep(0)
        assert await capacity.snapshot("ollama") == (1, 50)
        with pytest.raises(ProviderQueueFull):
            await capacity.acquire("ollama", 1, deadline)
        await capacity.release("ollama")
        await asyncio.gather(*waiting)
        assert await capacity.snapshot("ollama") == (0, 0)

    asyncio.run(scenario())


def test_cloud_and_ollama_have_independent_active_capacity() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity()
        deadline = asyncio.get_running_loop().time() + 1
        await capacity.acquire("ollama", 1, deadline)
        for _ in range(6):
            await capacity.acquire("cloud", 6, deadline)
        assert await capacity.snapshot("ollama") == (1, 0)
        assert await capacity.snapshot("cloud") == (6, 0)

        async def queued_cloud() -> None:
            await capacity.acquire("cloud", 6, deadline)
            await capacity.release("cloud")

        queued = asyncio.create_task(queued_cloud())
        await asyncio.sleep(0)
        assert await capacity.snapshot("cloud") == (6, 1)
        for _ in range(6):
            await capacity.release("cloud")
        await queued
        assert await capacity.snapshot("cloud") == (0, 0)
        await capacity.release("ollama")

    asyncio.run(scenario())


def test_queue_timeout_and_cancellation_do_not_leak_slots_or_waiters() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity(queue_limit=1)
        await capacity.acquire("ollama", 1, asyncio.get_running_loop().time() + 1)
        with pytest.raises(ProviderQueueTimeout):
            await capacity.acquire("ollama", 1, asyncio.get_running_loop().time() - 1)
        queued = asyncio.create_task(
            capacity.acquire("ollama", 1, asyncio.get_running_loop().time() + 1)
        )
        await asyncio.sleep(0)
        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        assert await capacity.snapshot("ollama") == (1, 0)
        await capacity.release("ollama")
        assert await capacity.snapshot("ollama") == (0, 0)

    asyncio.run(scenario())


def test_cancel_after_queue_grant_releases_the_slot() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity()
        deadline = asyncio.get_running_loop().time() + 1
        await capacity.acquire("ollama", 1, deadline)
        queued = asyncio.create_task(capacity.acquire("ollama", 1, deadline))
        await asyncio.sleep(0)
        assert await capacity.snapshot("ollama") == (1, 1)
        await capacity.release("ollama")
        queued.cancel()
        with pytest.raises(asyncio.CancelledError):
            await queued
        assert await capacity.snapshot("ollama") == (0, 0)

    asyncio.run(scenario())


def test_full_local_queue_does_not_fall_back_to_cloud() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity(queue_limit=50)
        deadline = asyncio.get_running_loop().time() + 10
        await capacity.acquire("ollama", 1, deadline)

        async def queued_call() -> None:
            await capacity.acquire("ollama", 1, deadline)
            await capacity.release("ollama")

        waiting = [asyncio.create_task(queued_call()) for _ in range(50)]
        for _ in range(5):
            await asyncio.sleep(0)
        assert await capacity.snapshot("ollama") == (1, 50)
        connections = [
            Connection(uuid.uuid4(), 1, kind, "model", "http://provider.test", "", "key")
            for kind in ("ollama", "openai")
        ]
        runtime = Runtime(object(), {"chat": connections, "embedding": [], "rerank": []}, False)
        runtime.capacity = capacity
        runtime.deadline = deadline
        settings = Settings()
        object.__setattr__(settings, "_provider_runtime", runtime)
        transport = httpx.MockTransport(lambda request: httpx.Response(200))
        client = httpx.AsyncClient(transport=transport)
        chain = Chain(settings, "chat", client, timeout=2)
        called = []

        async def call(adapter):
            called.append(adapter.connection.kind)
            return await adapter.client.get("http://provider.test")

        with pytest.raises(ProviderQueueFull):
            await chain.run(
                lambda connection, live: SimpleNamespace(client=live, connection=connection), call
            )
        assert called == ["ollama"]
        await capacity.release("ollama")
        await asyncio.gather(*waiting)
        await client.aclose()

    asyncio.run(scenario())


def test_provider_failure_releases_the_active_slot() -> None:
    async def scenario() -> None:
        capacity = ProviderCapacity()
        connection = Connection(
            uuid.uuid4(), 1, "ollama", "model", "http://provider.test", "", "key"
        )
        runtime = Runtime(object(), {"chat": [connection]}, False, capacity=capacity)

        async def check(_connection):
            return None

        runtime.check = check
        transport = httpx.MockTransport(lambda request: httpx.Response(502))
        client = httpx.AsyncClient(transport=transport)
        live = LiveClient(client, runtime, connection)
        with pytest.raises(httpx.HTTPStatusError):
            response = await live.get("http://provider.test")
            response.raise_for_status()
        assert await capacity.snapshot("ollama") == (0, 0)
        await live.aclose()
        await client.aclose()

    asyncio.run(scenario())
