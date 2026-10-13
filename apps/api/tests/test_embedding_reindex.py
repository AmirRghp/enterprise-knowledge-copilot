"""The publisher keeps access revocations while changing embedding spaces."""

from uuid import uuid4

from sqlalchemy import select

from app.db.models import Chunk, Document, EmbeddingReindex, ProviderChain, ProviderConfig
from app.provider_config import reindex
from app.settings import Settings
from tests.provider_fixtures import TEST_ENCRYPTION_KEY
from tests.test_ingestion import FakeProvider, _upload, _worker
from tests.test_manager_api import _login_as, _scenario

ORIGIN = {"Origin": "http://localhost:3000"}


def test_delete_and_access_narrowing_during_reindex_keep_only_current_chunks(monkeypatch) -> None:
    async def scenario(engine, factory, client):
        await _login_as(client, "manager")
        restricted = await _upload(factory, title="Restricted after start")
        deleted = await _upload(factory, title="Deleted after start")
        worker = _worker(factory, FakeProvider())
        assert (await worker.process_next_job()).status == "ready"
        assert (await worker.process_next_job()).status == "ready"

        target_id = uuid4()
        async with factory() as session, session.begin():
            chain = await session.get(ProviderChain, "embedding")
            assert chain is not None and chain.active_provider_id != target_id
            session.add(
                ProviderConfig(
                    provider_id=target_id,
                    purpose="embedding",
                    name="New embedding",
                    kind="ollama",
                    model="qwen3-embedding:0.6b",
                    base_url="http://localhost:11434",
                    expected_digest="b" * 64,
                    priority=1,
                    embedding_dimension=1024,
                    test_status="passed",
                    config_version=1,
                )
            )
            version = chain.version

        async with factory() as session, session.begin():
            preview = await reindex.request_switch(session, target_id, version, confirmed=False)
        assert preview["requires_confirmation"] and preview["documents"] == 2
        async with factory() as session, session.begin():
            started = await reindex.request_switch(session, target_id, version, confirmed=True)
        assert started["job"]["status"] == "pending"
        status = await client.get("/api/manager/providers/embedding/reindex")
        assert status.json()["job"]["percent"] == 0

        class Provider:
            changed = False

            def __init__(self, *args, **kwargs):
                pass

            async def embed_documents(self, texts):
                if not self.changed:
                    self.changed = True
                    response = await client.patch(
                        f"/api/manager/documents/{restricted.document_id}",
                        json={"access_role": "manager"},
                        headers=ORIGIN,
                    )
                    assert response.status_code == 204
                    response = await client.delete(
                        f"/api/manager/documents/{deleted.document_id}", headers=ORIGIN
                    )
                    assert response.status_code == 204
                return [[0.1] * 1024 for _ in texts]

        monkeypatch.setattr(reindex, "EmbeddingChain", Provider)
        settings = Settings(
            db_name="enterprise_knowledge_copilot_test",
            app_encryption_key=TEST_ENCRYPTION_KEY,
        )
        assert await reindex.run_pending(factory, settings) is not None
        status = await client.get("/api/manager/providers/embedding/reindex")
        assert status.json()["job"]["status"] == "completed"
        assert status.json()["job"]["percent"] == 100
        async with factory() as session:
            job = await session.scalar(
                select(EmbeddingReindex).order_by(EmbeddingReindex.created_at.desc()).limit(1)
            )
            chain = await session.get(ProviderChain, "embedding")
            kept = await session.get(Document, restricted.document_id)
            removed = await session.get(Document, deleted.document_id)
            kept_vectors = (
                await session.scalars(
                    select(Chunk).where(Chunk.document_id == restricted.document_id)
                )
            ).all()
            removed_vectors = (
                await session.scalars(select(Chunk).where(Chunk.document_id == deleted.document_id))
            ).all()
            assert job is not None and job.status == "completed" and job.completed == job.total
            assert chain is not None and chain.active_provider_id == target_id
            assert kept is not None and kept.access_role == "manager"
            assert removed is not None and removed.status == "inactive"
            assert kept_vectors and all(chunk.embedding_dimension == 1024 for chunk in kept_vectors)
            assert removed_vectors and all(
                chunk.embedding_dimension == 768 for chunk in removed_vectors
            )

    _scenario(scenario)


def test_access_restriction_requires_manager_origin_and_exact_policy() -> None:
    async def scenario(engine, factory, client):
        path = "/api/manager/documents/DOC-001"
        assert (
            await client.patch(path, json={"access_role": "manager"}, headers=ORIGIN)
        ).status_code == 401
        await _login_as(client, "employee")
        assert (
            await client.patch(path, json={"access_role": "manager"}, headers=ORIGIN)
        ).status_code == 403
        await _login_as(client, "manager")
        assert (
            await client.patch(
                path, json={"access_role": "manager"}, headers={"Origin": "http://evil.example"}
            )
        ).status_code == 403
        assert (
            await client.patch(path, json={"access_role": "employee"}, headers=ORIGIN)
        ).status_code == 422
        assert (
            await client.patch(path, json={"access_role": "manager"}, headers=ORIGIN)
        ).status_code == 404

    _scenario(scenario)
