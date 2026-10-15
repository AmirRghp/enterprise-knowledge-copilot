"""A request/job snapshot, with live per-send checks and ordered bounded fallback."""

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from typing import Any, cast
from uuid import UUID

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.engine import create_engine, create_session_factory
from app.db.models import ProviderConfig
from app.provider_config import store
from app.provider_config.contracts import ProviderConfigurationError, Purpose, decrypt
from app.provider_config.transport import provider_client
from app.providers.base import (
    ConversationTurn,
    EmbeddingModelChangedError,
    EmbeddingProviderError,
    EmbeddingValidationError,
    EvidenceItem,
    GenerationResult,
    ProviderUsage,
    RerankCandidate,
    ScoredCandidate,
)
from app.providers.capacity import ProviderCapacity, ProviderQueueTimeout
from app.providers.embedding import CloudEmbeddingProvider, OllamaEmbeddingProvider
from app.providers.generation import (
    GenerationEvidenceError,
    GenerationProviderError,
    GenerationReferenceError,
    GenerationRefusalError,
    OpenRouterGenerationProvider,
)
from app.providers.rerank import OpenRouterRerankProvider, RerankEvidenceError, RerankProviderError
from app.providers.retry import RetryableError, RetryPolicy
from app.providers.usage import summarize_usage
from app.settings import Settings
from app.system_prompts import DEFAULT_SYSTEM_PROMPT


@dataclass(frozen=True)
class Connection:
    id: UUID
    version: int
    kind: str
    model: str
    base_url: str
    digest: str
    key: str = field(repr=False)
    temperature: float | None = 0.7
    dimension: int = 768


@dataclass
class Runtime:
    factory: async_sessionmaker[AsyncSession]
    connections: dict[str, list[Connection]]
    enabled: bool
    active_embedding_id: UUID | None = None
    owned_clients: list[httpx.AsyncClient] = field(default_factory=list)
    deadline: float | None = None
    capacity: ProviderCapacity | None = None

    async def check(self, connection: Connection) -> None:
        async with self.factory() as session:
            row = await session.get(ProviderConfig, connection.id)
            if row is None or row.config_version != connection.version:
                raise httpx.ConnectError("provider configuration changed")


def get_runtime(settings: Settings) -> Runtime:
    runtime = getattr(settings, "_provider_runtime", None)
    if not isinstance(runtime, Runtime):
        raise ProviderConfigurationError("configure providers in the manager panel")
    return runtime


async def bind_runtime(settings: Settings, factory: async_sessionmaker[AsyncSession]) -> Settings:
    async with factory() as session:
        snapshot = await store.snapshot(session)
        connections: dict[str, list[Connection]] = {}
        for purpose in ("chat", "rerank", "embedding"):
            connections[purpose] = [
                Connection(
                    row.provider_id,
                    row.config_version,
                    row.kind,
                    row.model,
                    row.base_url,
                    row.expected_digest,
                    decrypt(row.api_key_encrypted, settings.app_encryption_key),
                    row.temperature,
                    row.embedding_dimension or 0,
                )
                for row in snapshot[purpose][1]
            ]
    runtime = Runtime(
        factory,
        connections,
        snapshot["rerank"][0].enabled,
        snapshot["embedding"][0].active_provider_id,
    )
    # The existing reports consume these typed model labels, never environment credentials.
    update: dict[str, Any] = {"rerank_enabled": runtime.enabled}
    for purpose, model_field in (
        ("chat", "openrouter_model"),
        ("rerank", "openrouter_rerank_model"),
        ("embedding", "ollama_embed_model"),
    ):
        selected = connections[purpose]
        if purpose == "embedding":
            selected = [c for c in selected if c.id == runtime.active_embedding_id]
        if selected:
            update[model_field] = selected[0].model
    active_embedding = [c for c in connections["embedding"] if c.id == runtime.active_embedding_id]
    if active_embedding:
        update["embedding_provider"] = active_embedding[0].kind
        update["embedding_dimension"] = active_embedding[0].dimension
        update["ollama_base_url"] = active_embedding[0].base_url
        update["ollama_embed_digest"] = active_embedding[0].digest or settings.ollama_embed_digest
    configured = settings.model_copy(update=update)
    object.__setattr__(configured, "_provider_runtime", runtime)
    return configured


async def configured_run(
    function: Callable[..., Awaitable[int]], arguments: Any, settings: Settings
) -> int:
    if isinstance(getattr(settings, "_provider_runtime", None), Runtime):
        return await function(arguments, settings)
    engine = create_engine(settings)
    configured: Settings | None = None
    try:
        configured = await bind_runtime(settings, create_session_factory(engine))
        return await function(arguments, configured)
    except ProviderConfigurationError:
        import sys

        print("provider configuration unavailable; use the manager panel", file=sys.stderr)
        return 2
    finally:
        if configured is not None:
            for client in get_runtime(configured).owned_clients:
                await client.aclose()
        await engine.dispose()


class LiveClient(httpx.AsyncClient):
    """Borrow the caller's transport, but fence every actual send against deletion/edit."""

    def __init__(self, client: httpx.AsyncClient, runtime: Runtime, connection: Connection):
        super().__init__()
        self.client, self.runtime, self.connection = client, runtime, connection
        self.sent = 0
        self.responses = 0
        self.queue_pending = False

    async def request(self, method: str, url: httpx.URL | str, **kwargs: Any) -> httpx.Response:
        capacity = self.runtime.capacity
        group = "ollama" if self.connection.kind == "ollama" else "cloud"
        acquired = False
        if capacity is not None:
            self.queue_pending = True
            await capacity.acquire(
                group,
                None,
                self.runtime.deadline or time.monotonic() + 60,
            )
            acquired = True
            self.queue_pending = False
        try:
            await self.runtime.check(self.connection)
            self.sent += 1
            response = await self.client.request(method, url, **kwargs)
            self.responses += 1
            return response
        finally:
            if acquired:
                await capacity.release(group)  # type: ignore[union-attr]


class Chain:
    def __init__(
        self,
        settings: Settings,
        purpose: Purpose,
        client: httpx.AsyncClient | None,
        timeout: float = 30,
    ):
        self.runtime = get_runtime(settings)
        self.items = self.runtime.connections[purpose]
        if purpose == "embedding":
            self.items = [c for c in self.items if c.id == self.runtime.active_embedding_id]
        if not self.items:
            raise ProviderConfigurationError(f"{purpose} provider is not configured")
        self.client = client or provider_client(timeout=timeout)
        self.owns_client = client is None
        if self.owns_client:
            self.runtime.owned_clients.append(self.client)
        self.timeout = timeout
        self.last_usages: list[ProviderUsage] = []
        self.selected = self.items[0]
        self.last_refusal: str | None = None
        self.last_digest: str | None = None

    @property
    def provider_name(self) -> str:
        return self.selected.kind

    @property
    def model(self) -> str:
        return self.selected.model

    @property
    def dimension(self) -> int:
        return self.selected.dimension

    @property
    def last_usage(self) -> ProviderUsage | None:
        # Keep the old summary surface; detailed figures retain each vendor/model.
        return summarize_usage(self.last_usages)

    async def aclose(self) -> None:
        if self.owns_client:
            await self.client.aclose()

    async def run[Adapter, Result](
        self,
        build: Callable[[Connection, httpx.AsyncClient], Adapter],
        call: Callable[[Adapter], Awaitable[Result]],
    ) -> Result:
        self.last_usages = []
        deadline = time.monotonic() + self.timeout
        if self.runtime.deadline is not None:
            deadline = min(deadline, self.runtime.deadline)
        for index, connection in enumerate(self.items):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            share = remaining / (len(self.items) - index)
            live = LiveClient(self.client, self.runtime, connection)
            adapter = build(connection, live)
            try:
                async with asyncio.timeout(share):
                    result = await call(adapter)
                self.selected = connection
                digest = getattr(adapter, "last_digest", None)
                if self.last_digest and digest and self.last_digest != digest:
                    raise EmbeddingModelChangedError("embedding space changed during the operation")
                self.last_digest = digest
                return result
            except (
                GenerationEvidenceError,
                GenerationReferenceError,
                GenerationRefusalError,
                EmbeddingModelChangedError,
                RerankEvidenceError,
            ):
                raise
            except ProviderQueueTimeout:
                raise
            except (
                GenerationProviderError,
                RerankProviderError,
                EmbeddingProviderError,
                EmbeddingValidationError,
                RetryableError,
                httpx.TransportError,
                TimeoutError,
            ):
                if live.queue_pending:
                    raise ProviderQueueTimeout from None
                if index == len(self.items) - 1:
                    raise
            finally:
                await live.aclose()
                self.last_refusal = getattr(adapter, "last_refusal", None)
                usage = getattr(adapter, "last_usage", None)
                if live.sent:
                    if usage is None or (usage.attempts or live.responses) < live.sent:
                        usage = ProviderUsage(
                            provider=connection.kind, model=connection.model, attempts=live.sent
                        )
                    else:
                        usage = replace(usage, attempts=live.sent)
                    self.last_usages.append(usage)

        raise ProviderConfigurationError("provider chain is empty")


class GenerationChain(Chain):
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.AsyncClient,
        policy: RetryPolicy | None = None,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    ):
        super().__init__(settings, "chat", client, settings.generation_request_timeout)
        self.policy = policy
        self.max_tokens = settings.generation_max_tokens
        self.system_prompt = system_prompt

    async def generate(
        self,
        *,
        question: str,
        evidence: Sequence[EvidenceItem],
        refresh: Callable[[], Awaitable[list[EvidenceItem]]] | None = None,
        history: Sequence[ConversationTurn] = (),
        refresh_history: Callable[[], Awaitable[list[ConversationTurn]]] | None = None,
    ) -> GenerationResult:
        def build(c: Connection, client: httpx.AsyncClient) -> OpenRouterGenerationProvider:
            return OpenRouterGenerationProvider(
                client,
                base_url=c.base_url + ("/v1" if c.kind == "ollama" else ""),
                model=c.model,
                api_key=c.key,
                max_tokens=self.max_tokens,
                provider_name=c.kind,
                temperature=c.temperature,
                policy=self.policy,
                system_prompt=self.system_prompt,
            )

        return await self.run(
            build,
            lambda adapter: adapter.generate(
                question=question,
                evidence=evidence,
                refresh=refresh,
                history=history,
                refresh_history=refresh_history,
            ),
        )


class RerankChain(Chain):
    def __init__(
        self, settings: Settings, *, client: httpx.AsyncClient, policy: RetryPolicy | None = None
    ):
        super().__init__(settings, "rerank", client, 15)
        self.policy = policy

    async def rerank(
        self,
        query: str,
        candidates: list[RerankCandidate],
        *,
        top_n: int,
        refresh: Callable[[], Awaitable[list[RerankCandidate]]] | None = None,
    ) -> list[ScoredCandidate]:
        def build(c: Connection, client: httpx.AsyncClient) -> OpenRouterRerankProvider:
            return OpenRouterRerankProvider(
                client,
                base_url=c.base_url,
                model=c.model,
                api_key=c.key,
                provider_name=c.kind,
                policy=self.policy,
            )

        return await self.run(
            build, lambda adapter: adapter.rerank(query, candidates, top_n=top_n, refresh=refresh)
        )


class EmbeddingChain(Chain):
    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.AsyncClient | None = None,
        attempt_timeout: float = 10,
    ):
        super().__init__(settings, "embedding", client, min(90, attempt_timeout * 2))
        self.attempt_timeout = attempt_timeout
        self.observed_dimension = 0
        if client is None:
            self.client.timeout = httpx.Timeout(attempt_timeout)

    def build(
        self, c: Connection, client: httpx.AsyncClient
    ) -> OllamaEmbeddingProvider | CloudEmbeddingProvider:
        policy = RetryPolicy(attempt_timeout_seconds=self.attempt_timeout)
        dimension = self.observed_dimension or c.dimension
        if c.kind == "ollama":
            return OllamaEmbeddingProvider(
                client,
                base_url=c.base_url,
                model=c.model,
                dimension=dimension,
                policy=policy,
                expected_digest=self.last_digest or c.digest,
            )
        return CloudEmbeddingProvider(
            client,
            base_url=c.base_url,
            model=c.model,
            dimension=dimension,
            policy=policy,
            api_key=c.key,
            provider_name=c.kind,
        )

    async def model_digest(self) -> str:
        return await self.run(self.build, lambda adapter: adapter.model_digest())

    async def embed_query(self, text: str) -> list[float]:
        vector = cast(
            list[float], await self.run(self.build, lambda adapter: adapter.embed_query(text))
        )
        self.observed_dimension = len(vector)
        return vector

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        vectors = cast(
            list[list[float]],
            await self.run(self.build, lambda adapter: adapter.embed_documents(texts)),
        )
        if vectors:
            self.observed_dimension = len(vectors[0])
        return vectors

    @property
    def dimension(self) -> int:
        return self.observed_dimension or self.selected.dimension


async def configured_call[Result](
    settings: Settings, call: Callable[[Settings], Awaitable[Result]]
) -> Result:
    if isinstance(getattr(settings, "_provider_runtime", None), Runtime):
        return await call(settings)
    engine = create_engine(settings)
    configured: Settings | None = None
    try:
        configured = await bind_runtime(settings, create_session_factory(engine))
        return await call(configured)
    finally:
        if configured is not None:
            for client in get_runtime(configured).owned_clients:
                await client.aclose()
        await engine.dispose()
