"""Durable, confirmed embedding switch with an atomic publisher cutover."""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import Select, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import (
    Chunk,
    Document,
    EmbeddingReindex,
    EmbeddingReindexVector,
    IngestionJob,
    ProviderChain,
    ProviderConfig,
)
from app.ingestion.store import STAGING_LOCK_KEY
from app.provider_config.contracts import ProviderConflictError
from app.provider_config.runtime import EmbeddingChain, bind_runtime, get_runtime
from app.provider_config.transport import provider_client
from app.settings import Settings


def current_chunks() -> Select[Chunk]:
    return (
        select(Chunk)
        .join(Document, Document.document_id == Chunk.document_id)
        .where(
            Document.status == "active",
            Document.current_revision == Chunk.revision,
            Chunk.embedding.is_not(None),
        )
    )


def view(job: EmbeddingReindex) -> dict[str, object]:
    return {
        "job_id": str(job.job_id),
        "target_provider_id": str(job.target_provider_id),
        "status": job.status,
        "total": job.total,
        "completed": job.completed,
        "percent": 100
        if job.status == "completed"
        else (job.completed * 100 // job.total if job.total else 0),
        "safe_error": job.safe_error,
    }


async def latest(session: AsyncSession) -> EmbeddingReindex | None:
    return await session.scalar(
        select(EmbeddingReindex).order_by(EmbeddingReindex.created_at.desc()).limit(1)
    )


async def request_switch(
    session: AsyncSession, provider_id: uuid.UUID, version: int, *, confirmed: bool
) -> dict[str, object]:
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": STAGING_LOCK_KEY})
    chain = (
        await session.scalars(
            select(ProviderChain).where(ProviderChain.purpose == "embedding").with_for_update()
        )
    ).one()
    if chain.version != version:
        raise ProviderConflictError("provider configuration changed")
    target = await session.get(ProviderConfig, provider_id)
    if target is None or target.purpose != "embedding":
        raise LookupError
    if target.test_status != "passed" or not target.embedding_dimension:
        raise ProviderConflictError("test the embedding connection before selecting it")
    if chain.active_provider_id == provider_id:
        return {"requires_confirmation": False, "total": 0, "active": True}
    existing = await session.scalar(
        select(EmbeddingReindex).where(EmbeddingReindex.status.in_(("pending", "running"))).limit(1)
    )
    if existing is not None:
        raise ProviderConflictError("an embedding rebuild is already running")
    pending = await session.scalar(
        select(func.count())
        .select_from(IngestionJob)
        .where(IngestionJob.status.in_(("pending", "indexing")))
    )
    if pending:
        raise ProviderConflictError("wait for document processing to finish")
    eligible = current_chunks().subquery()
    total = await session.scalar(select(func.count()).select_from(eligible)) or 0
    documents = await session.scalar(select(func.count(func.distinct(eligible.c.document_id)))) or 0
    if total and not confirmed:
        return {
            "requires_confirmation": True,
            "total": total,
            "documents": documents,
            "active": False,
        }
    if not total:
        chain.active_provider_id = provider_id
        chain.embedding_digest = target.expected_digest
        chain.version += 1
        return {"requires_confirmation": False, "total": 0, "active": True}
    job = EmbeddingReindex(
        target_provider_id=provider_id,
        target_version=target.config_version,
        status="pending",
        total=total,
        completed=0,
    )
    session.add(job)
    await session.flush()
    return {"requires_confirmation": False, "total": total, "active": False, "job": view(job)}


async def _clock(session: AsyncSession) -> datetime:
    value = await session.scalar(text("SELECT clock_timestamp()"))
    assert isinstance(value, datetime)
    return value


async def _owned(session: AsyncSession, job_id: uuid.UUID, token: uuid.UUID) -> EmbeddingReindex:
    job = (
        await session.scalars(
            select(EmbeddingReindex).where(EmbeddingReindex.job_id == job_id).with_for_update()
        )
    ).one()
    if (
        job.status != "running"
        or job.lease_token != token
        or job.lease_expires_at is None
        or job.lease_expires_at <= await _clock(session)
    ):
        raise ProviderConflictError("embedding rebuild lease was lost")
    return job


async def run_pending(
    factory: async_sessionmaker[AsyncSession], settings: Settings
) -> uuid.UUID | None:
    async with factory() as session, session.begin():
        job = await session.scalar(
            select(EmbeddingReindex)
            .where(EmbeddingReindex.status.in_(("pending", "running")))
            .order_by(EmbeddingReindex.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if job is None:
            return None
        now = await _clock(session)
        if job.status == "running" and job.lease_expires_at and job.lease_expires_at > now:
            return None
        token = uuid.uuid4()
        job.status = "running"
        job.lease_token = token
        job.lease_expires_at = now + timedelta(seconds=120)
        job_id, target_id, target_version = job.job_id, job.target_provider_id, job.target_version

    try:
        configured = await bind_runtime(settings, factory)
        runtime = get_runtime(configured)
        runtime.active_embedding_id = target_id
        selected = next((c for c in runtime.connections["embedding"] if c.id == target_id), None)
        if selected is None or selected.version != target_version or not selected.dimension:
            raise ProviderConflictError("embedding connection changed")
        async with provider_client(60) as client:
            provider = EmbeddingChain(configured, client=client, attempt_timeout=45)
            while True:
                async with factory() as session:
                    candidates = (
                        await session.scalars(
                            current_chunks()
                            .where(
                                ~select(EmbeddingReindexVector.chunk_id)
                                .where(
                                    EmbeddingReindexVector.job_id == job_id,
                                    EmbeddingReindexVector.chunk_id == Chunk.chunk_id,
                                )
                                .exists()
                            )
                            .order_by(Chunk.chunk_id)
                            .limit(10)
                        )
                    ).all()
                if not candidates:
                    break
                vectors = await provider.embed_documents(
                    [candidate.chunk_text for candidate in candidates]
                )
                if len(vectors) != len(candidates) or any(
                    len(vector) != selected.dimension for vector in vectors
                ):
                    raise ProviderConflictError("embedding vector dimension changed")
                async with factory() as session, session.begin():
                    job = await _owned(session, job_id, token)
                    for candidate, vector in zip(candidates, vectors, strict=True):
                        still_current = await session.scalar(
                            current_chunks().where(Chunk.chunk_id == candidate.chunk_id)
                        )
                        if still_current is not None:
                            session.add(
                                EmbeddingReindexVector(
                                    job_id=job_id, chunk_id=candidate.chunk_id, embedding=vector
                                )
                            )
                            job.completed += 1
                    job.lease_expires_at = await _clock(session) + timedelta(seconds=120)

        async with factory() as session, session.begin():
            await session.execute(
                text("SELECT pg_advisory_xact_lock(:key)"), {"key": STAGING_LOCK_KEY}
            )
            job = await _owned(session, job_id, token)
            chain = (
                await session.scalars(
                    select(ProviderChain)
                    .where(ProviderChain.purpose == "embedding")
                    .with_for_update()
                )
            ).one()
            target = await session.get(ProviderConfig, target_id)
            if target is None or target.config_version != target_version:
                raise ProviderConflictError("embedding connection changed")
            staged = {
                row.chunk_id: row.embedding
                for row in (
                    await session.scalars(
                        select(EmbeddingReindexVector).where(
                            EmbeddingReindexVector.job_id == job_id
                        )
                    )
                ).all()
            }
            chunks = (await session.scalars(current_chunks())).all()
            if any(chunk.chunk_id not in staged for chunk in chunks):
                raise ProviderConflictError("embedding rebuild is incomplete")
            for chunk in chunks:
                chunk.embedding = staged[chunk.chunk_id]
                chunk.embedding_provider = target.kind
                chunk.embedding_model = target.model
                chunk.embedding_digest = target.expected_digest
                chunk.embedding_dimension = target.embedding_dimension or 0
            chain.active_provider_id = target_id
            chain.embedding_digest = target.expected_digest
            chain.version += 1
            job.status = "completed"
            job.total = len(chunks)
            job.completed = len(chunks)
            job.lease_token = None
            job.lease_expires_at = None
            job.finished_at = await _clock(session)
        return job_id
    except Exception:
        async with factory() as session, session.begin():
            try:
                job = await _owned(session, job_id, token)
            except ProviderConflictError:
                return job_id
            job.status = "failed"
            job.safe_error = "embedding rebuild failed"
            job.lease_token = None
            job.lease_expires_at = None
            job.finished_at = await _clock(session)
        return job_id
