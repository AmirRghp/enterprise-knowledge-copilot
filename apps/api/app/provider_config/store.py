"""Serialize panel mutations; never expose encrypted keys in public records."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Chunk, IngestionJob, ProviderChain, ProviderConfig
from app.ingestion.store import STAGING_LOCK_KEY
from app.provider_config.contracts import (
    PURPOSES,
    ProviderConfigurationError,
    ProviderConflictError,
    ProviderInput,
    Purpose,
    encrypt,
)
from app.settings import Settings


def public(row: ProviderConfig) -> dict[str, Any]:
    return {
        "id": str(row.provider_id),
        "name": row.name,
        "kind": row.kind,
        "model": row.model,
        "base_url": row.base_url,
        "expected_digest": row.expected_digest,
        "priority": row.priority,
        "has_api_key": row.api_key_encrypted is not None,
        "test_status": row.test_status,
        "tested_at": row.tested_at.isoformat() if row.tested_at else None,
    }


async def rows(session: AsyncSession, purpose: Purpose) -> list[ProviderConfig]:
    return list(
        (
            await session.scalars(
                select(ProviderConfig)
                .where(ProviderConfig.purpose == purpose)
                .order_by(ProviderConfig.priority)
            )
        ).all()
    )


async def snapshot(session: AsyncSession) -> dict[str, tuple[ProviderChain, list[ProviderConfig]]]:
    result: dict[str, tuple[ProviderChain, list[ProviderConfig]]] = {}
    statement = (
        select(ProviderChain, ProviderConfig)
        .outerjoin(ProviderConfig, ProviderConfig.purpose == ProviderChain.purpose)
        .order_by(ProviderChain.purpose, ProviderConfig.priority)
    )
    for chain, provider in (await session.execute(statement)).all():
        result.setdefault(chain.purpose, (chain, []))
        if provider is not None:
            result[chain.purpose][1].append(provider)
    if set(result) != set(PURPOSES):
        raise ProviderConfigurationError("provider migration is required")
    return result


async def listing(session: AsyncSession) -> dict[str, Any]:
    return {
        purpose: {
            "version": chain.version,
            "enabled": chain.enabled,
            "providers": [public(row) for row in providers],
        }
        for purpose, (chain, providers) in (await snapshot(session)).items()
    }


async def lock(session: AsyncSession, purpose: Purpose, version: int) -> ProviderChain:
    if purpose == "embedding":
        await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": STAGING_LOCK_KEY})
    chain = (
        await session.scalars(
            select(ProviderChain).where(ProviderChain.purpose == purpose).with_for_update()
        )
    ).one()
    if chain.version != version:
        raise ProviderConflictError("provider configuration changed; reload")
    return chain


async def embedding_guard(
    session: AsyncSession, digest: str, previous: str = "", exclude: UUID | None = None
) -> None:
    observed = (
        await session.execute(
            select(
                Chunk.embedding_model,
                Chunk.embedding_digest,
                Chunk.embedding_dimension,
                Chunk.embedding_provider,
            ).distinct()
        )
    ).all()
    for model, stored_digest, dimension, provider in observed:
        if (
            model != "nomic-embed-text-v2-moe:latest"
            or dimension != 768
            or provider != "ollama"
            or not stored_digest.startswith(digest)
        ):
            raise ProviderConflictError("embedding is incompatible with the existing index")
    others = await rows(session, "embedding")
    if any(
        not (row.expected_digest.startswith(digest) or digest.startswith(row.expected_digest))
        for row in others
        if row.provider_id != exclude
    ):
        raise ProviderConflictError("embedding fallback must use the same model digest")
    pending = await session.scalar(
        select(func.count())
        .select_from(IngestionJob)
        .where(IngestionJob.status.in_(("pending", "indexing")))
    )
    if pending and (
        not previous or not (previous.startswith(digest) or digest.startswith(previous))
    ):
        # A job without published chunks still owns an embedding space.
        if not others or any(
            not (r.expected_digest.startswith(digest) or digest.startswith(r.expected_digest))
            for r in others
        ):
            raise ProviderConflictError("embedding cannot change during ingestion")


async def save(
    session: AsyncSession,
    purpose: Purpose,
    payload: ProviderInput,
    settings: Settings,
    provider_id: UUID | None = None,
) -> None:
    payload.for_purpose(purpose)
    chain = await lock(session, purpose, payload.version)
    current = await session.get(ProviderConfig, provider_id) if provider_id else None
    if provider_id and (current is None or current.purpose != purpose):
        raise LookupError
    if purpose == "embedding":
        await embedding_guard(
            session,
            payload.expected_digest,
            current.expected_digest if current else chain.embedding_digest,
            current.provider_id if current else None,
        )
        # Keep the space pinned while queued jobs outlive deletion of the last connection.
        chain.embedding_digest = payload.expected_digest
    key = payload.api_key.get_secret_value()
    same_kind = current is not None and current.kind == payload.kind
    encrypted = (
        encrypt(key, settings.app_encryption_key)
        if key
        else (current.api_key_encrypted if same_kind and current else None)
    )
    if payload.kind in ("openai", "openrouter") and not encrypted:
        raise ValueError("api key is required")
    if payload.kind == "ollama":
        encrypted = None
    if current is None:
        count = (
            await session.scalar(
                select(func.count())
                .select_from(ProviderConfig)
                .where(ProviderConfig.purpose == purpose)
            )
            or 0
        )
        if count >= 100:
            raise ValueError("provider limit reached")
        current = ProviderConfig(purpose=purpose, priority=count)
        session.add(current)
    else:
        current.config_version += 1
    current.name, current.kind, current.model = payload.name, payload.kind, payload.model
    current.base_url, current.expected_digest = payload.base_url, payload.expected_digest
    current.api_key_encrypted = encrypted
    current.test_status = None
    current.tested_at = None
    current.updated_at = datetime.now(UTC)
    chain.version += 1
    await session.flush()


async def remove(session: AsyncSession, purpose: Purpose, provider_id: UUID, version: int) -> None:
    chain = await lock(session, purpose, version)
    items = await rows(session, purpose)
    current = next((row for row in items if row.provider_id == provider_id), None)
    if current is None:
        raise LookupError
    await session.delete(current)
    for priority, row in enumerate(row for row in items if row is not current):
        row.priority = priority
    chain.version += 1


async def reorder(session: AsyncSession, purpose: Purpose, ids: list[str], version: int) -> None:
    chain = await lock(session, purpose, version)
    items = {str(row.provider_id): row for row in await rows(session, purpose)}
    if len(ids) != len(set(ids)) or set(ids) != set(items):
        raise ValueError("order must contain every provider exactly once")
    for priority, provider_id in enumerate(ids):
        items[provider_id].priority = priority
    chain.version += 1
