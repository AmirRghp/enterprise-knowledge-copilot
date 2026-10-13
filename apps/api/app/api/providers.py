"""Manager JSON routes. Authentication runs before request body parsing."""

import asyncio
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.auth import get_engine, get_session_factory, get_settings
from app.api.manager import _require_manager
from app.db.models import ProviderConfig
from app.domain.models import Actor
from app.provider_config import reindex, store
from app.provider_config.contracts import (
    ChainInput,
    OrderInput,
    ProviderConfigurationError,
    ProviderConflictError,
    ProviderInput,
    Purpose,
    SwitchInput,
    VersionInput,
)
from app.provider_config.runtime import (
    EmbeddingChain,
    GenerationChain,
    RerankChain,
    bind_runtime,
    get_runtime,
)
from app.provider_config.transport import addresses, provider_client
from app.providers.base import (
    EmbeddingProviderError,
    EmbeddingValidationError,
    EvidenceItem,
    RerankCandidate,
)
from app.providers.generation import GenerationProviderError
from app.providers.rerank import RerankProviderError
from app.providers.retry import RetryableError
from app.settings import Settings

router = APIRouter(prefix="/api/manager/providers", tags=["providers"])
Manager = Annotated[Actor, Depends(_require_manager)]
Config = Annotated[Settings, Depends(get_settings)]


def factory(request: Request) -> async_sessionmaker[AsyncSession]:
    return get_session_factory(request, get_engine(request))  # type: ignore[return-value]


def error(exc: Exception) -> HTTPException:
    if isinstance(exc, ProviderConflictError):
        return HTTPException(409, "provider configuration conflict")
    if isinstance(exc, ProviderConfigurationError):
        return HTTPException(503, "provider configuration unavailable")
    if isinstance(exc, LookupError):
        return HTTPException(404, "provider not found")
    return HTTPException(422, "provider configuration rejected")


async def body(request: Request, schema: Any) -> Any:
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "JSON required")
    try:
        return schema.model_validate(await request.json())
    except (ValidationError, ValueError):
        raise HTTPException(422, "provider configuration rejected") from None


def headers(response: Response) -> None:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/embedding/reindex")
async def reindex_status(request: Request, actor: Manager, response: Response) -> dict[str, object]:
    headers(response)
    async with factory(request)() as session:
        job = await reindex.latest(session)
        return {"job": reindex.view(job) if job else None}


@router.post("/embedding/{provider_id}/activate")
async def activate_embedding(
    request: Request, provider_id: UUID, actor: Manager, response: Response
) -> dict[str, object]:
    headers(response)
    payload = await body(request, SwitchInput)
    try:
        async with factory(request)() as session, session.begin():
            return await reindex.request_switch(
                session, provider_id, payload.version, confirmed=payload.confirmed
            )
    except (ProviderConflictError, LookupError) as exc:
        raise error(exc) from None


@router.get("")
async def list_providers(request: Request, actor: Manager, response: Response) -> dict[str, Any]:
    headers(response)
    try:
        async with factory(request)() as session:
            return await store.listing(session)
    except ProviderConfigurationError as exc:
        raise error(exc) from None


@router.put("/{purpose}/order")
async def order_providers(
    request: Request, purpose: Purpose, actor: Manager, response: Response
) -> dict[str, Any]:
    headers(response)
    payload = await body(request, OrderInput)
    try:
        async with factory(request)() as session, session.begin():
            await store.reorder(session, purpose, payload.ids, payload.version)
            await session.flush()
            return await store.listing(session)
    except ValueError as exc:
        raise error(exc) from None


@router.post("/{purpose}", status_code=201)
async def add_provider(
    request: Request, purpose: Purpose, actor: Manager, settings: Config, response: Response
) -> dict[str, Any]:
    return await save_provider(request, purpose, actor, settings, response)


@router.put("/{purpose}/{provider_id}")
async def save_provider(
    request: Request,
    purpose: Purpose,
    actor: Manager,
    settings: Config,
    response: Response,
    provider_id: UUID | None = None,
) -> dict[str, Any]:
    headers(response)
    payload = await body(request, ProviderInput)
    try:
        url = httpx.URL(payload.base_url)
        async with asyncio.timeout(3):
            await addresses(url.host, url.port or (443 if url.scheme == "https" else 80))
    except (httpx.ConnectError, TimeoutError, ProviderConfigurationError):
        raise HTTPException(422, "provider destination is not allowed or unavailable") from None
    try:
        async with factory(request)() as session, session.begin():
            await store.save(session, purpose, payload, settings, provider_id)
            return await store.listing(session)
    except (ValueError, LookupError, ProviderConfigurationError) as exc:
        raise error(exc) from None


@router.delete("/{purpose}/{provider_id}", status_code=204)
async def delete_provider(
    request: Request, purpose: Purpose, provider_id: UUID, actor: Manager, response: Response
) -> None:
    headers(response)
    payload = await body(request, VersionInput)
    try:
        async with factory(request)() as session, session.begin():
            await store.remove(session, purpose, provider_id, payload.version)
    except (ValueError, LookupError) as exc:
        raise error(exc) from None


@router.patch("/rerank")
async def toggle_rerank(request: Request, actor: Manager, response: Response) -> dict[str, Any]:
    headers(response)
    payload = await body(request, ChainInput)
    try:
        async with factory(request)() as session, session.begin():
            chain = await store.lock(session, "rerank", payload.version)
            if payload.enabled and not await store.rows(session, "rerank"):
                raise ValueError("rerank provider is required")
            chain.enabled = payload.enabled
            chain.version += 1
            await session.flush()
            return await store.listing(session)
    except ValueError as exc:
        raise error(exc) from None


@router.post("/{purpose}/{provider_id}/test")
async def test_provider(
    request: Request,
    purpose: Purpose,
    provider_id: UUID,
    actor: Manager,
    settings: Config,
    response: Response,
) -> dict[str, Any]:
    headers(response)
    payload = await body(request, VersionInput)
    db = factory(request)
    try:
        async with db() as session, session.begin():
            await store.lock(session, purpose, payload.version)
            row = await session.get(ProviderConfig, provider_id)
            if row is None or row.purpose != purpose:
                raise LookupError
            config_version = row.config_version
        configured = await bind_runtime(settings, db)
        runtime = get_runtime(configured)
        runtime.connections[purpose] = [
            c for c in runtime.connections[purpose] if c.id == provider_id
        ]
        if purpose == "embedding":
            runtime.active_embedding_id = provider_id
        if (
            not runtime.connections[purpose]
            or runtime.connections[purpose][0].version != config_version
        ):
            raise ProviderConflictError
        result = "failed"
        observed_dimension: int | None = None
        observed_digest = ""
        async with provider_client(15) as client:
            try:
                async with asyncio.timeout(75):
                    if purpose == "embedding":
                        adapter = EmbeddingChain(configured, client=client)
                        query_vector = await adapter.embed_query("آزمون اتصال")
                        document_vectors = await adapter.embed_documents(["متن ساختگی آزمون اتصال"])
                        if len(document_vectors) != 1 or len(query_vector) != len(
                            document_vectors[0]
                        ):
                            raise EmbeddingValidationError("embedding dimension mismatch")
                        observed_dimension = len(query_vector)
                        observed_digest = adapter.last_digest or ""
                        if adapter.provider_name == "ollama" and len(observed_digest) < 12:
                            raise EmbeddingValidationError("embedding model digest missing")
                    elif purpose == "chat":
                        generator = GenerationChain(configured, client=client)
                        await generator.generate(
                            question="نام شرکت چیست؟",
                            evidence=[EvidenceItem("E1", "نام شرکت نمونه سپهر داده است.")],
                        )
                    else:
                        from uuid import uuid4

                        reranker = RerankChain(configured, client=client)
                        await reranker.rerank(
                            "نام شرکت",
                            [RerankCandidate(uuid4(), "نام شرکت نمونه سپهر داده است.")],
                            top_n=1,
                        )
                result = "passed"
            except (
                GenerationProviderError,
                RerankProviderError,
                EmbeddingProviderError,
                EmbeddingValidationError,
                RetryableError,
                TimeoutError,
            ):
                pass
        async with db() as session, session.begin():
            row = (
                await session.scalars(
                    select(ProviderConfig)
                    .where(ProviderConfig.provider_id == provider_id)
                    .with_for_update()
                )
            ).one_or_none()
            if row is None or row.config_version != config_version:
                raise ProviderConflictError
            row.test_status = result
            row.tested_at = datetime.now(UTC)
            if purpose == "embedding" and result == "passed":
                row.embedding_dimension = observed_dimension
                row.expected_digest = observed_digest
        return {"status": result}
    except (ValueError, LookupError, ProviderConfigurationError) as exc:
        raise error(exc) from None
