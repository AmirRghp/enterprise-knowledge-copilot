"""Part 9 imports use only the isolated project test database and fake embeddings."""

import asyncio
import shutil
import uuid
from pathlib import Path

import pytest
from sqlalchemy import delete, func, select

from app.db.engine import create_engine, create_session_factory
from app.db.models import Chunk, Document, IngestionJob, Section, User
from app.domain.models import Actor
from app.ingestion import store
from app.ingestion.contracts import UploadRejectedError
from app.ingestion.corpus import CORPUS_PATH, CORPUS_ROLES, ingest_corpus, load_corpus
from app.ingestion.worker import IngestionWorker
from app.settings import Settings
from tests.test_ingestion import FakeProvider, WordCounter


def test_indexed_corpus() -> None:
    records = load_corpus(CORPUS_PATH, max_bytes=1024 * 1024)
    assert len(records) == 20
    assert sum(record.metadata.access_role == "manager" for record in records) == 4
    index = (CORPUS_PATH.parent / "docs/corpus-index.md").read_text()
    for record in records:
        assert f"| `{record.document_id}` |" in index
        assert record.metadata.title in index


@pytest.mark.parametrize("mutation", ["role", "id", "section", "missing", "extra", "symlink"])
def test_invalid_corpus_refused(tmp_path: Path, mutation: str) -> None:
    folder = tmp_path / "corpus"
    shutil.copytree(CORPUS_PATH, folder)
    file = folder / "MGR-001.md"
    body = file.read_text()
    if mutation == "missing":
        file.unlink()
    elif mutation == "extra":
        (folder / "extra.md").write_text(body)
    elif mutation == "symlink":
        file.unlink()
        file.symlink_to(CORPUS_PATH / "MGR-001.md")
    else:
        old, new = {
            "role": ("access_role: manager", "access_role: employee"),
            "id": ("document_id: MGR-001", "document_id: OTHER"),
            "section": ("MGR-001-S1", "OTHER-S1"),
        }[mutation]
        file.write_text(body.replace(old, new))
    with pytest.raises(UploadRejectedError):
        load_corpus(folder, max_bytes=1024 * 1024)


def test_atomic_import_idempotency_policy_and_worker() -> None:
    async def scenario() -> None:
        settings = Settings(db_name="enterprise_knowledge_copilot_test")
        assert settings.db_name.endswith("_test")
        engine = create_engine(settings)
        factory = create_session_factory(engine)
        user_id = uuid.uuid4()
        actor = Actor(user_id, "manager", uuid.uuid4())
        try:
            async with engine.begin() as conn:
                for model in (Chunk, Section, IngestionJob, Document):
                    await conn.execute(delete(model))
                await conn.execute(
                    User.__table__.insert().values(
                        user_id=user_id,
                        login=f"corpus-test-{user_id}",
                        password_hash="not-a-login-password",
                        role="manager",
                        is_active=True,
                    )
                )
            async with factory() as session:
                with pytest.raises(UploadRejectedError, match="limit"):
                    await ingest_corpus(
                        session, actor=actor, max_bytes=1024 * 1024, max_active_documents=19
                    )
                assert await session.scalar(select(func.count()).select_from(Document)) == 0
                await session.rollback()
                with pytest.raises(UploadRejectedError, match="manager"):
                    await ingest_corpus(
                        session,
                        actor=Actor(user_id, "employee", uuid.uuid4()),
                        max_bytes=1024 * 1024,
                        max_active_documents=100,
                    )
                result = await ingest_corpus(
                    session, actor=actor, max_bytes=1024 * 1024, max_active_documents=100
                )
                assert (result.created, result.existing) == (20, 0)
                repeated = await ingest_corpus(
                    session, actor=actor, max_bytes=1024 * 1024, max_active_documents=20
                )
                assert (repeated.created, repeated.existing) == (0, 20)
                jobs = (await session.scalars(select(IngestionJob))).all()
                ids_before = {job.job_id for job in jobs}
                assert len(ids_before) == 20
                assert all(job.status == "pending" for job in jobs)
                document = await session.get(Document, "MGR-004")
                assert document is not None
                document.access_role = "employee"
                await session.commit()
                with pytest.raises(UploadRejectedError, match="conflicts"):
                    await ingest_corpus(
                        session, actor=actor, max_bytes=1024 * 1024, max_active_documents=100
                    )
                document = await session.get(Document, "MGR-004")
                assert document is not None
                document.access_role = "manager"
                await session.commit()
            worker = IngestionWorker(
                session_factory=factory,
                provider=FakeProvider(),
                worker_id="corpus-test",
                counter=WordCounter(),
            )
            for _ in range(20):
                outcome = await worker.process_next_job()
                assert outcome is not None and outcome.status == "ready"
            async with factory() as session:
                result = await ingest_corpus(
                    session, actor=actor, max_bytes=1024 * 1024, max_active_documents=100
                )
                assert result.created == 0
                assert set(await session.scalars(select(IngestionJob.job_id))) == ids_before
                docs = (await session.scalars(select(Document))).all()
                assert {doc.document_id: doc.access_role for doc in docs} == CORPUS_ROLES
                assert all(doc.current_revision and doc.content_version == "1.0" for doc in docs)
                sections = (await session.scalars(select(Section.section_id))).all()
                assert len(sections) == 80
                assert set(sections) == {
                    f"{name}-S{i}" for name in CORPUS_ROLES for i in range(1, 5)
                }
                summaries = await store.list_documents(session, actor=actor)
                assert all(row.job_id and row.safe_error is None for row in summaries)
        finally:
            async with engine.begin() as conn:
                for model in (Chunk, Section, IngestionJob, Document):
                    await conn.execute(delete(model))
                await conn.execute(delete(User).where(User.user_id == user_id))
            await engine.dispose()

    asyncio.run(scenario())
