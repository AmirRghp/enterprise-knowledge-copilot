"""Serialize panel mutations; never expose encrypted keys in public records."""

from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import EmbeddingReindex, ProviderChain, ProviderConfig
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
        "temperature": row.temperature,
        "priority": row.priority,
        "has_api_key": row.api_key_encrypted is not None,
        "test_status": row.test_status,
        "tested_at": row.tested_at.isoformat() if row.tested_at else None,
        "embedding_dimension": row.embedding_dimension,
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
            "active_provider_id": str(chain.active_provider_id)
            if chain.active_provider_id
            else None,
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
    temperature = payload.temperature if purpose == "chat" else None
    if current is not None and purpose == "chat" and "temperature" not in payload.model_fields_set:
        temperature = current.temperature
    if (
        purpose == "embedding"
        and current is not None
        and current.provider_id == chain.active_provider_id
    ):
        raise ProviderConflictError("select another embedding model before editing the active one")
    if purpose == "embedding" and current is not None:
        running = await session.scalar(
            select(func.count())
            .select_from(EmbeddingReindex)
            .where(
                EmbeddingReindex.target_provider_id == current.provider_id,
                EmbeddingReindex.status.in_(("pending", "running")),
            )
        )
        if running:
            raise ProviderConflictError("embedding model is being indexed")
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
    if purpose == "embedding":
        current.embedding_dimension = None
    current.api_key_encrypted = encrypted
    current.temperature = temperature
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
    if purpose == "embedding":
        if chain.active_provider_id == provider_id:
            raise ProviderConflictError("active embedding model cannot be removed")
        running = await session.scalar(
            select(func.count())
            .select_from(EmbeddingReindex)
            .where(
                EmbeddingReindex.target_provider_id == provider_id,
                EmbeddingReindex.status.in_(("pending", "running")),
            )
        )
        if running:
            raise ProviderConflictError("embedding model is being indexed")
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
