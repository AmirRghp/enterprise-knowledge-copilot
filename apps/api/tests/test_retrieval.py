"""Tests for authorized hybrid retrieval.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database with a
deterministic fake embedding provider, so no test reaches Ollama and no vector
depends on a live model.

The negative cases are the point of this file: an employee must not receive a
manager-only document by either retrieval path or through the fusion; a deleted
document, a superseded revision, an unactivated revision, a revision whose job is
no longer ready and a chunk with no vector must never surface; the same chunk must
not appear twice; and the source text a hit carries must be byte-identical to what
was ingested, because a citation quote is matched against it later.

The fake provider's vectors are salted differently for documents and queries, so
its vector ranking is deterministic but arbitrary. A test that only ever saw the
lexical path would therefore pass by luck, which is why several of these force one
path to be empty and assert the other's contribution separately.
"""

import asyncio
import hashlib
import math
import uuid
from collections.abc import Callable, Coroutine, Sequence
from datetime import UTC, datetime
from typing import Any
from unittest import mock

import pytest
from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db import models as db_models
from app.db import url as db_url
from app.db.engine import create_engine, create_session_factory
from app.documents.chunking import chunk_sections
from app.documents.normalize import normalize_for_search
from app.documents.parse import parse_document
from app.domain.models import VISIBLE_ROLES, Actor, Role
from app.ingestion import store as ingestion_store
from app.ingestion.contracts import (
    JOB_STATUS_FAILED,
    OPERATION_CREATE,
    UploadInput,
)
from app.ingestion.worker import IngestionWorker
from app.providers.base import EmbeddingProvider, VectorProvider
from app.retrieval import store as retrieval_store
from app.retrieval.contracts import IndexProvenance, RetrievalConfig, RetrievalHit
from app.retrieval.lexical import lexical_ranking, tokenize
from app.retrieval.service import retrieve
from app.retrieval.store import IndexProvenanceMismatchError
from app.settings import Settings

DIMENSION = 768
TEST_DIGEST = "3b1f9c7d5e2a4b6c8d0e1f3a5b7c9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9a1b3c"
TEST_MODEL = "fake-embed-v1"
TEST_PROVIDER = "fake"

#: The question, deliberately spelled with Arabic yeh/kaf and Persian digits so
#: normalization is exercised on the way in rather than assumed.
QUESTION = "چه كسي مي تواند درخواست بازپرداخت ١٥ روزه ثبت كند"

#: Corpus ids, chosen so a leak is unambiguous: MGR-001 is manager-only and exists
#: in this file only so that it can fail to appear.
MANAGER_DOCUMENT = "MGR-001"
EMPLOYEE_DOCUMENT = "DOC-001"

EMPLOYEE_TEXT = """# بازپرداخت هزینه سفر

هزینه سفر تا سقف روزانه بازپرداخت می‌شود.

## شرایط

درخواست باید ظرف ۱۵ روز ثبت شود.

## استثنا

در صورت بیماری مهلت یک ماه است.
"""

MANAGER_TEXT = """# سقف پرداخت مدیران

این سند فقط برای مدیران است.

## سقف

سقف پرداخت ۵۰۰ میلیون ریال است.
"""

#: A document that shares no term with the question, so only the vector path can find it.
#: ranking cannot be mistaken for relevance.
UNRELATED_TEXT = """# موضوع نامرتبط

## الف

متنی کاملاً بی‌ربط به پرسش.
"""

#: A body the parser cannot turn into a citable document.
UNPARSEABLE = "---\ntitle: x\nkey: y\n\nمتن بدنه\n"


def _settings() -> Settings:
    """Load the real environment but pin the database to the isolated one."""
    return Settings(db_name="enterprise_knowledge_copilot_test")


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop; asyncpg binds a connection to it."""
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def isolated_database() -> None:
    """Guard against ever pointing a test at the application database."""
    settings = _settings()
    assert settings.db_name == "enterprise_knowledge_copilot_test"
    assert db_url.PROJECT_DATABASES == {
        "enterprise_knowledge_copilot",
        "enterprise_knowledge_copilot_test",
    }


def _vector(text: str) -> list[float]:
    """A deterministic, finite, correctly sized vector derived from ``text``."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [digest[index % len(digest)] / 255.0 for index in range(DIMENSION)]


def _unit_vector(text: str) -> list[float]:
    """A unit-length vector whose direction is derived from ``text``."""
    values = _vector(text)
    norm = math.sqrt(sum(value * value for value in values))
    return [value / norm for value in values]


def _tilted_vector(first: float, second: float) -> list[float]:
    """A unit vector whose only non-zero components are the first two.

    Cosine distance from ``(1, 0)`` is ``1 - first``, so a test can place a chunk at
    an exact distance instead of hoping two hash-derived vectors happen to be
    strictly ordered - which they generally are not, because 768 random components
    are all mutually near-orthogonal and every distance lands close to 1.
    """
    values = [0.0] * DIMENSION
    values[0] = first
    values[1] = second
    norm = math.sqrt(first * first + second * second)
    values[0], values[1] = first / norm, second / norm
    return values


#: Cosine distance from ``NEAR_VECTOR`` is 0, 0.5, 0.75 and 1 respectively.
NEAR_VECTOR = _tilted_vector(1.0, 0.0)
MIDDLE_VECTOR = _tilted_vector(0.5, 0.5)
FILLER_VECTOR = _tilted_vector(0.25, 0.75)
FAR_VECTOR = _tilted_vector(0.0, 1.0)


class FakeProvider:
    """A deterministic stand-in for the Ollama adapter.

    Document and query vectors are salted differently, so the vector ranking is
    deterministic but arbitrary rather than meaningfully relevant.
    """

    def __init__(self) -> None:
        self.query_calls: list[str] = []
        self._digest: str | None = None

    @property
    def provider_name(self) -> str:
        return TEST_PROVIDER

    @property
    def model(self) -> str:
        return TEST_MODEL

    @property
    def dimension(self) -> int:
        return DIMENSION

    @property
    def last_digest(self) -> str | None:
        return self._digest

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        self._digest = TEST_DIGEST
        return [_vector(f"document:{text}") for text in texts]

    async def embed_query(self, text: str) -> list[float]:
        self.query_calls.append(text)
        self._digest = TEST_DIGEST
        return _vector(f"query:{text}")


class WordCounter:
    """A stand-in token counter, so no test downloads the real tokenizer."""

    def count(self, text: str) -> int:
        return len(text.split())


def _actor(role: Role) -> Actor:
    return Actor(user_id=uuid.uuid4(), role=role, session_id=uuid.uuid4())


async def _wipe(engine: AsyncEngine) -> None:
    async with engine.begin() as connection:
        await connection.execute(delete(db_models.Chunk))
        await connection.execute(delete(db_models.Section))
        await connection.execute(delete(db_models.IngestionJob))
        await connection.execute(delete(db_models.Document))


def _scenario[Result](
    body: Callable[[AsyncEngine, async_sessionmaker[AsyncSession]], Coroutine[Any, Any, Result]],
) -> Result:
    async def main() -> Result:
        engine = create_engine(_settings())
        try:
            await _wipe(engine)
            return await body(engine, create_session_factory(engine))
        finally:
            await engine.dispose()

    return _run(main())


class _AtBarrier:
    """Lets a test pause ``retrieve`` between two of its own database reads.

    Review finding 1 is a race, so reproducing it needs a real interleaving rather
    than a call to the store functions in an order that happens to look similar.
    Patching :func:`~app.retrieval.store.vector_candidates` to block puts the
    document change genuinely between the first read the service already did and the
    next thing it does - and the read after that is the authorization gate, so this is
    exactly the window the review describes.

    ``empty_vector`` makes the vector path contribute nothing, which is how a test
    isolates the case the review names: a candidate that only the **lexical** path,
    reading the earlier snapshot, ever held.
    """

    def __init__(self, *, empty_vector: bool = False) -> None:
        self.empty_vector = empty_vector
        self.reached = asyncio.Event()
        self.resume = asyncio.Event()

    async def __call__(self, *args: Any, **kwargs: Any) -> Any:
        self.reached.set()
        await self.resume.wait()
        if self.empty_vector:
            return []
        return await _real_vector_candidates(*args, **kwargs)


_real_vector_candidates = retrieval_store.vector_candidates


async def _search_while_blocked(
    factory: async_sessionmaker[AsyncSession], barrier: _AtBarrier
) -> list[RetrievalHit]:
    """Run a retrieval whose vector read blocks, so a test can act in between."""

    async with factory() as session:
        with mock.patch.object(retrieval_store, "vector_candidates", barrier):
            return await retrieve(
                session,
                actor=_actor("employee"),
                question=QUESTION,
                config=RetrievalConfig(),
                provider=FakeProvider(),
            )


def _worker(
    factory: async_sessionmaker[AsyncSession], provider: EmbeddingProvider, **overrides: Any
) -> IngestionWorker:
    defaults: dict[str, Any] = {
        "worker_id": "worker-retrieval",
        "lease_seconds": 120,
        "renew_seconds": 0.01,
        "max_attempts": 3,
        "max_current_chunks": 2000,
        "counter": WordCounter(),
    }
    return IngestionWorker(session_factory=factory, provider=provider, **{**defaults, **overrides})


async def _publish(
    factory: async_sessionmaker[AsyncSession],
    *,
    publish: bool = True,
    embedding: bool = True,
    **kwargs: Any,
) -> str | None:
    """Stage a document, optionally run it to ``ready``, and return its revision.

    ``publish=False`` leaves ``current_revision`` NULL, which is exactly what an
    upload that has never been activated looks like. ``embedding=False`` nulls the
    vectors afterwards, which is how a row that exists but was never embedded is
    reproduced.
    """
    document_id = kwargs["document_id"]
    async with factory() as session:
        now = datetime.now(UTC)
        ingestion_store._add_job(
            session,
            document_id=document_id,
            text_body=kwargs["text"],
            operation=OPERATION_CREATE,
            expected_current_revision=None,
        )
        session.add(
            db_models.Document(
                document_id=document_id,
                title=kwargs.get("title", "سند آزمون"),
                content_version=ingestion_store.UNPUBLISHED_VERSION,
                access_role=kwargs["access_role"],
                current_revision=None,
                status="active",
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()
    if not publish:
        return None
    for _ in range(8):
        outcome = await _worker(factory, FakeProvider()).process_next_job()
        if outcome is None:
            break
    if not embedding:
        async with factory() as session:
            await session.execute(
                update(db_models.Chunk)
                .where(db_models.Chunk.document_id == document_id)
                .values(embedding=None)
            )
            await session.commit()
    return await _revision_of(factory, document_id)


async def _revision_of(factory: async_sessionmaker[AsyncSession], document_id: str) -> str | None:
    async with factory() as session:
        document = await session.get(db_models.Document, document_id)
        assert document is not None
        return document.current_revision


async def _search(
    factory: async_sessionmaker[AsyncSession],
    *,
    question: str = QUESTION,
    role: Role = "employee",
    provider: EmbeddingProvider | None = None,
    config: RetrievalConfig | None = None,
) -> list[RetrievalHit]:
    async with factory() as session:
        return await retrieve(
            session,
            actor=_actor(role),
            question=question,
            config=config or RetrievalConfig(),
            provider=provider or FakeProvider(),
        )


def _document_ids(hits: Sequence[RetrievalHit]) -> set[str]:
    return {hit.chunk.document_id for hit in hits}


def test_the_allowlist_is_a_sql_predicate_and_not_a_python_filter() -> None:
    """The structural half of the authorization property.

    Filtering after ranking would leave the database ranking rows the actor may not
    read: the hit count would then depend on forbidden documents, and the safety
    would rest entirely on nobody forgetting the filter. Asserting the compiled
    statement keeps the property honest however any single question happens to rank.
    """
    # Only the dialect is needed to compile, so nothing connects here.
    dialect = postgresql.dialect()
    for role, expected in (("employee", "'employee'"), ("manager", "'employee', 'manager'")):
        compiled = str(
            retrieval_store.retrievable_documents(_actor(role)).compile(
                dialect=dialect, compile_kwargs={"literal_binds": True}
            )
        )
        assert f"documents.access_role IN ({expected})" in compiled, (role, compiled)
        assert "documents.status = 'active'" in compiled, (role, compiled)
        assert "documents.current_revision IS NOT NULL" in compiled, (role, compiled)
        assert "chunks.revision = documents.current_revision" in compiled, (role, compiled)
        assert "chunks.embedding IS NOT NULL" in compiled, (role, compiled)
        assert "ingestion_jobs.status = 'ready'" in compiled, (role, compiled)


def test_both_paths_are_built_from_the_same_allowlist() -> None:
    """If the two statements drifted, the paths could disagree about membership."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        for role in ("employee", "manager"):
            actor = _actor(role)
            shared = retrieval_store._eligible_query(actor)
            # Each path adds only its own ordering on top of the identical predicate.
            lexical = shared.order_by(db_models.Chunk.chunk_id)
            assert str(lexical.whereclause) == str(shared.whereclause)
            # And the vector path adds its distance column and limit, nothing else.
            vector = retrieval_store._eligible_query(actor).add_columns(
                db_models.Chunk.embedding.cosine_distance([0.0] * DIMENSION)
            )
            assert str(vector.whereclause) == str(shared.whereclause)

    _scenario(body)


def test_the_vector_query_sorts_by_distance_and_not_by_chunk_id() -> None:
    """Review finding: ``order_by`` appends, so a shared UUID order would win.

    SQLAlchemy does not replace an existing ``ORDER BY``; it appends to it. If the
    shared query carried ``ORDER BY chunk_id``, the vector query would compile to
    ``ORDER BY chunks.chunk_id, chunks.embedding <=> $1`` and rank by UUID. That is
    stable, so a test that only checks the query *runs* would never notice, which is
    why the ordering is asserted on the compiled statement as well as on real rows.
    """
    actor = _actor("employee")
    shared = retrieval_store._eligible_query(actor)
    # The shared query must not pin an order of its own.
    assert str(shared).upper().count("ORDER BY") == 0

    distance = db_models.Chunk.embedding.cosine_distance([0.0] * DIMENSION)
    query = shared.add_columns(distance).order_by(distance, db_models.Chunk.chunk_id).limit(5)
    order = [str(clause) for clause in query._order_by_clauses]
    assert order == [str(distance), "chunks.chunk_id"], order


def test_the_nearest_vector_ranks_first_even_when_its_chunk_id_is_largest() -> None:
    """The reproduction from the review, on real rows: UUID order would invert it."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text="# الف\n\n## یک\n\nمتن اول.\n\n## دو\n\nمتن دوم.\n\n## سه\n\nمتن سوم.\n",
            access_role="employee",
        )
        async with factory() as session:
            ids = sorted(
                (
                    await session.execute(
                        select(db_models.Chunk.chunk_id).order_by(db_models.Chunk.chunk_id)
                    )
                )
                .scalars()
                .all()
            )
        assert len(ids) >= 3, ids
        # Every chunk is assigned a known distance, so no leftover vector from the
        # fake provider can take part in the ordering.
        far, middle, near = ids[0], ids[-2], ids[-1]
        assignments = {chunk_id: FILLER_VECTOR for chunk_id in ids}
        assignments[far], assignments[middle], assignments[near] = (
            FAR_VECTOR,
            MIDDLE_VECTOR,
            NEAR_VECTOR,
        )

        # Distance 0 for the largest id and 1 for the smallest, so a UUID ordering
        # would return exactly the reverse of what a vector search must.
        async with factory() as session:
            for chunk_id, vector in assignments.items():
                await session.execute(
                    update(db_models.Chunk)
                    .where(db_models.Chunk.chunk_id == chunk_id)
                    .values(embedding=vector)
                )
            await session.commit()

        async with factory() as session:
            rows = await retrieval_store.vector_candidates(
                session, _actor("employee"), embedding=NEAR_VECTOR, top_k=len(ids)
            )

        ranked = [row.chunk_id for row in rows]
        assert ranked[0] == near, ranked
        assert ranked[1] == middle, ranked
        assert ranked[-1] == far, ranked

    _scenario(body)


def test_equal_vectors_are_ordered_by_chunk_id_so_a_tie_is_reproducible() -> None:
    """UUID decides the order only when the distances are equal."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text="# الف\n\n## یک\n\nمتن اول.\n\n## دو\n\nمتن دوم.\n\n## سه\n\nمتن سوم.\n",
            access_role="employee",
        )
        async with factory() as session:
            ids = sorted(
                (
                    await session.execute(
                        select(db_models.Chunk.chunk_id).order_by(db_models.Chunk.chunk_id)
                    )
                )
                .scalars()
                .all()
            )
        assert len(ids) >= 3, ids
        vector = _unit_vector("same")
        async with factory() as session:
            await session.execute(update(db_models.Chunk).values(embedding=vector))
            await session.commit()

        async with factory() as session:
            rows = await retrieval_store.vector_candidates(
                session, _actor("employee"), embedding=vector, top_k=5
            )

        assert [row.chunk_id for row in rows] == ids

    _scenario(body)


# --------------------------------------------------------------------------
# index provenance: the vectors must be the ones this provider produced
# --------------------------------------------------------------------------

#: A different, equally well-formed digest. A stale index and a mixed index differ
#: only in whether the rows agree with each other, so the tests cover both.
OTHER_DIGEST = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"
THIRD_DIGEST = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809"


async def _corrupt_provenance(
    factory: async_sessionmaker[AsyncSession],
    document_id: str | None,
    **values: Any,
) -> int:
    """Rewrite the stored provenance of some chunks; return how many rows changed."""
    statement = update(db_models.Chunk).values(**values)
    if document_id is not None:
        statement = statement.where(db_models.Chunk.document_id == document_id)
    async with factory() as session:
        result = await session.execute(statement)
        await session.commit()
    return int(result.rowcount)


async def _digests_of(factory: async_sessionmaker[AsyncSession], document_id: str) -> set[str]:
    """The distinct stored digests of one document, for asserting a mixed index."""
    async with factory() as session:
        return set(
            (
                await session.execute(
                    select(db_models.Chunk.embedding_digest).where(
                        db_models.Chunk.document_id == document_id
                    )
                )
            )
            .scalars()
            .all()
        )


def test_an_index_built_by_a_different_digest_fails_closed() -> None:
    """Review finding: a stale digest produced three confident hits before this."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        await _corrupt_provenance(factory, MANAGER_DOCUMENT, embedding_digest=OTHER_DIGEST)

        with pytest.raises(IndexProvenanceMismatchError) as raised:
            await _search(factory, role="manager", question="سقف پرداخت")

        assert "MGR-001" not in str(raised.value)
        assert "سقف" not in str(raised.value)

    _scenario(body)


def test_a_mixed_index_fails_closed() -> None:
    """Two digests in one index is the case DATABASE.md section 5 names explicitly."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        async with factory() as session:
            target = (await session.execute(select(db_models.Chunk.chunk_id))).scalars().first()
        await _corrupt_provenance(factory, None, embedding_digest=OTHER_DIGEST)
        async with factory() as session:
            await session.execute(
                update(db_models.Chunk)
                .where(db_models.Chunk.chunk_id == target)
                .values(embedding_digest=TEST_DIGEST)
            )
            await session.commit()
        assert len(await _digests_of(factory, MANAGER_DOCUMENT)) == 2

        with pytest.raises(IndexProvenanceMismatchError):
            await _search(factory, role="manager", question="سقف پرداخت")

    _scenario(body)


def test_an_index_from_another_model_fails_closed() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        await _corrupt_provenance(factory, MANAGER_DOCUMENT, embedding_model="other-model")

        with pytest.raises(IndexProvenanceMismatchError):
            await _search(factory, role="manager", question="سقف پرداخت")

    _scenario(body)


def test_an_index_from_another_provider_fails_closed() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        await _corrupt_provenance(factory, MANAGER_DOCUMENT, embedding_provider="someone-else")

        with pytest.raises(IndexProvenanceMismatchError):
            await _search(factory, role="manager", question="سقف پرداخت")

    _scenario(body)


def test_an_index_of_another_dimension_fails_closed() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        class OtherDimension(FakeProvider):
            @property
            def dimension(self) -> int:
                return 1024

        # The stored column still says 768, so only the provider disagrees.
        assert await _dimensions_of(factory, MANAGER_DOCUMENT) == {DIMENSION}
        with pytest.raises(IndexProvenanceMismatchError):
            await _search(factory, role="manager", question="سقف پرداخت", provider=OtherDimension())

    _scenario(body)


async def _dimensions_of(factory: async_sessionmaker[AsyncSession], document_id: str) -> set[int]:
    """The distinct stored dimensions of one document."""
    async with factory() as session:
        return set(
            (
                await session.execute(
                    select(db_models.Chunk.embedding_dimension).where(
                        db_models.Chunk.document_id == document_id
                    )
                )
            )
            .scalars()
            .all()
        )


def test_a_consistent_index_is_accepted() -> None:
    """The check must not be a blanket refusal; a matching index has to work."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        hits = await _search(factory, role="manager", question="سقف پرداخت")

        assert hits, hits

    _scenario(body)


def test_an_empty_domain_is_not_an_inconsistent_index() -> None:
    """Refusing an empty corpus would make "no documents yet" look broken."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        assert await _search(factory, role="manager") == []

    _scenario(body)


def test_a_forbidden_document_cannot_fail_an_employees_index_check() -> None:
    """The check is scoped to the allowlist, so it is not an existence oracle.

    The only mismatched row belongs to a manager-only document. If the check looked
    at the whole ``chunks`` table the employee would be refused because of a row
    they are not allowed to know exists - and a refusal is a signal.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        await _corrupt_provenance(factory, MANAGER_DOCUMENT, embedding_digest=OTHER_DIGEST)

        # The employee's own rows are consistent, so the employee's query works.
        employee_hits = await _search(factory, role="employee")
        assert _document_ids(employee_hits) == {EMPLOYEE_DOCUMENT}

        # The manager's domain is not, so the manager is the one who is told.
        with pytest.raises(IndexProvenanceMismatchError) as raised:
            await _search(factory, role="manager")
        message = str(raised.value)
        assert "MGR-001" not in message
        assert "DOC-001" not in message
        assert OTHER_DIGEST not in message

    _scenario(body)


def test_the_mismatch_message_names_neither_a_document_nor_an_observed_digest() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        await _corrupt_provenance(factory, MANAGER_DOCUMENT, embedding_digest=OTHER_DIGEST)

        with pytest.raises(IndexProvenanceMismatchError) as raised:
            await _search(factory, role="manager")

        message = str(raised.value)
        assert OTHER_DIGEST not in message
        assert "MGR-001" not in message
        assert TEST_DIGEST in message, "the operator still learns what was expected"

    _scenario(body)


def test_provenance_needs_a_verified_digest() -> None:
    """A provider that has not embedded yet cannot be compared to anything."""

    with pytest.raises(ValueError, match="verified digest"):
        IndexProvenance(provider=TEST_PROVIDER, model=TEST_MODEL, digest=None, dimension=DIMENSION)


def test_the_fake_provider_reports_the_identity_retrieval_compares_against() -> None:
    """A fake with a digest of its own is enough to exercise the check."""

    provider = FakeProvider()
    assert provider.provider_name == TEST_PROVIDER
    assert provider.model == TEST_MODEL
    assert provider.dimension == DIMENSION
    assert provider.last_digest is None, "no embed yet"
    assert isinstance(provider, VectorProvider)


def test_the_number_of_searchable_documents_differs_by_role() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        async with factory() as session:
            assert (
                await retrieval_store.count_retrievable_documents(session, _actor("employee")) == 1
            )
            assert (
                await retrieval_store.count_retrievable_documents(session, _actor("manager")) == 2
            )

    _scenario(body)


def test_an_employee_never_receives_a_manager_only_document() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        hits = await _search(factory, role="employee")

        assert _document_ids(hits) == {EMPLOYEE_DOCUMENT}
        assert all(hit.chunk.access_role == "employee" for hit in hits)

    _scenario(body)


def test_a_manager_receives_both_roles() -> None:
    """The allowlist is a widening for managers, not a second unrelated rule."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        hits = await _search(factory, role="manager")

        assert _document_ids(hits) == {EMPLOYEE_DOCUMENT, MANAGER_DOCUMENT}
        assert all(hit.chunk.access_role in VISIBLE_ROLES["manager"] for hit in hits)

    _scenario(body)


# --------------------------------------------------------------------------
# only the published revision of an active document is searchable
# --------------------------------------------------------------------------


def test_a_deleted_document_is_not_retrievable() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        async with factory() as session:
            await ingestion_store.soft_delete_document(
                session, actor=_actor("manager"), document_id=MANAGER_DOCUMENT
            )

        assert await _search(factory, role="manager") == []

    _scenario(body)


def test_an_unpublished_document_is_not_retrievable() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=MANAGER_DOCUMENT,
            text=MANAGER_TEXT,
            access_role="manager",
            publish=False,
        )

        # Nothing was ever activated, so no chunk was ever written.
        assert await _revision_of(factory, MANAGER_DOCUMENT) is None
        assert await _search(factory, role="manager") == []

    _scenario(body)


def test_a_superseded_revision_is_not_retrievable() -> None:
    """A replaced revision's rows stay in the tables and must stay out of results."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        superseded = await _revision_of(factory, MANAGER_DOCUMENT)
        assert superseded is not None

        async with factory() as session:
            await ingestion_store.stage_replace(
                session,
                actor=_actor("manager"),
                document_id=MANAGER_DOCUMENT,
                text_body="# جایگزین\n\n## تازه\n\nمتن کاملاً تازه و متفاوت.\n",
                metadata=UploadInput(title="جایگزین", access_role="manager"),  # type: ignore[arg-type]
            )
        outcome = await _worker(factory, FakeProvider()).process_next_job()
        assert outcome is not None and outcome.outcome == "ready", outcome.safe_error
        current = await _revision_of(factory, MANAGER_DOCUMENT)
        assert current is not None and current != superseded

        hits = await _search(factory, question="متن کاملاً تازه و متفاوت", role="manager")

        assert hits
        assert {hit.chunk.revision for hit in hits} == {current}
        # The superseded rows are still there; they are simply not reachable.
        async with factory() as session:
            revisions = set(
                (
                    await session.execute(
                        select(db_models.Chunk.revision).where(
                            db_models.Chunk.document_id == MANAGER_DOCUMENT
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert revisions == {superseded, current}, revisions

    _scenario(body)


def test_a_failed_replacement_does_not_hide_the_published_revision() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        async with factory() as session:
            await ingestion_store.stage_replace(
                session,
                actor=_actor("manager"),
                document_id=MANAGER_DOCUMENT,
                text_body=UNPARSEABLE,
                metadata=UploadInput(title="ناموفق", access_role="manager"),  # type: ignore[arg-type]
            )
        outcome = await _worker(factory, FakeProvider()).process_next_job()
        assert outcome is not None and outcome.outcome == "failed"

        hits = await _search(factory, question="سقف پرداخت ۵۰۰ میلیون ریال", role="manager")

        assert _document_ids(hits) == {MANAGER_DOCUMENT}

    _scenario(body)


def test_a_current_revision_whose_job_is_no_longer_ready_is_not_retrievable() -> None:
    """The ready-job half of the allowlist, and the test that keeps it honest."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        async with factory() as session:
            await session.execute(
                update(db_models.IngestionJob)
                .where(db_models.IngestionJob.document_id == MANAGER_DOCUMENT)
                .values(status=JOB_STATUS_FAILED)
            )
            await session.commit()

        assert await _search(factory, role="manager") == []

    _scenario(body)


def test_a_chunk_without_a_vector_is_not_retrievable_by_either_path() -> None:
    """DATABASE.md section 5: data without an embedding stays out of retrieval.

    BM25 does not need a vector, so without the embedding test in the *shared*
    predicate the lexical path becomes a way around a rule that is about the data,
    not about the algorithm: a chunk that exists but was never embedded is
    incomplete, and an incomplete row must not be citable.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=MANAGER_DOCUMENT,
            text=MANAGER_TEXT,
            access_role="manager",
            embedding=False,
        )

        # The rows are still there; only their vectors were removed.
        async with factory() as session:
            stored = (
                (
                    await session.execute(
                        select(db_models.Chunk.chunk_id).where(
                            db_models.Chunk.document_id == MANAGER_DOCUMENT
                        )
                    )
                )
                .scalars()
                .all()
            )
        assert stored, "the chunks exist; only their vectors were removed"

        # Neither path can reach them.
        async with factory() as session:
            assert await retrieval_store.read_eligible_chunks(session, _actor("manager")) == []
            assert (
                await retrieval_store.vector_candidates(
                    session, _actor("manager"), embedding=_unit_vector("q"), top_k=10
                )
                == []
            )
            assert (
                await retrieval_store.count_retrievable_documents(session, _actor("manager")) == 0
            )

        # And the fused result is empty, for a question they match exactly.
        assert await _search(factory, role="manager", question="سقف پرداخت") == []

    _scenario(body)


def test_one_vectorless_chunk_does_not_hide_the_chunks_that_have_one() -> None:
    """The policy is per chunk, so a single gap must not empty a whole document."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=MANAGER_DOCUMENT,
            text=MANAGER_TEXT,
            access_role="manager",
        )
        async with factory() as session:
            removed = (
                (
                    await session.execute(
                        select(db_models.Chunk.chunk_id)
                        .where(db_models.Chunk.document_id == MANAGER_DOCUMENT)
                        .order_by(db_models.Chunk.chunk_id)
                    )
                )
                .scalars()
                .first()
            )
        async with factory() as session:
            await session.execute(
                update(db_models.Chunk)
                .where(db_models.Chunk.chunk_id == removed)
                .values(embedding=None)
            )
            await session.commit()

        async with factory() as session:
            eligible = await retrieval_store.read_eligible_chunks(session, _actor("manager"))
        assert eligible, "the remaining chunks are still searchable"
        assert removed not in {chunk.chunk_id for chunk in eligible}

    _scenario(body)


# --------------------------------------------------------------------------
# the last authorization gate: a revocation between the ranking read and the
# response must not be served from the earlier snapshot
# --------------------------------------------------------------------------


def test_a_document_narrowed_to_manager_mid_request_is_not_returned() -> None:
    """Review finding 1, the narrowing case: the lexical path held it in memory.

    ``read_eligible_chunks`` sees the document as employee-readable, ranks it, and
    only then is access narrowed. Ranking cannot unrank anything, so without a final
    check the hit is served from memory with whatever role it had when it was read.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        # The vector path contributes nothing, so the only candidate is one the
        # lexical path read before the narrowing - the exact case the review names.
        barrier = _AtBarrier(empty_vector=True)

        async def narrow() -> None:
            async with factory() as session:
                await session.execute(
                    update(db_models.Document)
                    .where(db_models.Document.document_id == EMPLOYEE_DOCUMENT)
                    .values(access_role="manager")
                )
                await session.commit()

        results: list[list[RetrievalHit]] = []
        task = asyncio.ensure_future(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()
        # The narrowing lands strictly between the two reads.
        await narrow()
        barrier.resume.set()
        results.append(await task)

        hits = results[0]
        assert _document_ids(hits) == set(), hits

        # And the document really is manager-only now, so a later request agrees.
        async with factory() as session:
            assert (
                await retrieval_store.count_retrievable_documents(session, _actor("employee")) == 0
            )

    _scenario(body)


def test_a_document_deleted_mid_request_is_not_returned() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        barrier = _AtBarrier()

        async def delete() -> None:
            async with factory() as session:
                await ingestion_store.soft_delete_document(
                    session, actor=_actor("manager"), document_id=EMPLOYEE_DOCUMENT
                )

        task = asyncio.ensure_future(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()
        await delete()
        barrier.resume.set()
        hits = await task

        assert hits == []

    _scenario(body)


def test_a_document_replaced_mid_request_is_not_returned() -> None:
    """A replacement advances ``current_revision``, so the old rows stop matching.

    The review also noted that the fresh revision's vector chunk ids could reach the
    stale ``by_id`` map and raise. With the final read there is no such map: a
    candidate that no longer qualifies is dropped, never substituted and never an
    error.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        barrier = _AtBarrier()

        async def replace() -> None:
            async with factory() as session:
                await ingestion_store.stage_replace(
                    session,
                    actor=_actor("manager"),
                    document_id=EMPLOYEE_DOCUMENT,
                    text_body="# تازه\n\n## الف\n\nمتن کاملاً تازه.\n",
                    metadata=UploadInput(title="تازه", access_role="employee"),
                )
            outcome = await _worker(factory, FakeProvider()).process_next_job()
            assert outcome is not None and outcome.outcome == "ready", outcome.safe_error

        task = asyncio.ensure_future(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()
        superseded = await _revision_of(factory, EMPLOYEE_DOCUMENT)
        await replace()
        barrier.resume.set()
        hits = await task
        current = await _revision_of(factory, EMPLOYEE_DOCUMENT)

        assert current is not None and current != superseded
        # The vector path ran against the new snapshot, so it contributed the *new*
        # revision's chunks. Those are legitimately searchable, and the final read
        # confirms it. What must never appear is the revision that was replaced.
        assert superseded not in {hit.chunk.revision for hit in hits}, hits
        assert current in {hit.chunk.revision for hit in hits}, hits

    _scenario(body)


def test_a_replacement_mid_request_never_substitutes_the_fresh_revision() -> None:
    """The review's second half: a stale candidate is dropped, never swapped.

    With the vector path contributing nothing, the only candidate is a chunk of the
    revision that has just been replaced. Returning the *new* revision's chunk in its
    place would be worse than returning nothing: it would carry a rank that was
    computed for different text, which is exactly the kind of citation that silently
    stops matching its quote.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        barrier = _AtBarrier(empty_vector=True)

        async def replace() -> None:
            async with factory() as session:
                await ingestion_store.stage_replace(
                    session,
                    actor=_actor("manager"),
                    document_id=EMPLOYEE_DOCUMENT,
                    text_body="# تازه\n\n## الف\n\nمتن کاملاً تازه.\n",
                    metadata=UploadInput(title="تازه", access_role="employee"),
                )
            outcome = await _worker(factory, FakeProvider()).process_next_job()
            assert outcome is not None and outcome.outcome == "ready", outcome.safe_error

        task = asyncio.ensure_future(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()
        await replace()
        barrier.resume.set()
        hits = await task

        assert hits == [], hits

        # And the replacement is searchable normally on the next request.
        assert _document_ids(await _search(factory)) == {EMPLOYEE_DOCUMENT}

    _scenario(body)


def test_a_document_untouched_mid_request_is_still_returned() -> None:
    """The control case: the final read must not be so eager that it drops live hits."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        barrier = _AtBarrier()
        task = asyncio.ensure_future(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()
        barrier.resume.set()

        hits = await task

        assert _document_ids(hits) == {EMPLOYEE_DOCUMENT}, hits

    _scenario(body)


def test_a_hit_carries_the_text_of_the_revision_that_is_authorized_now() -> None:
    """The final read supplies the text, so a hit never quotes a superseded chunk."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        revision = await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
        )
        assert revision is not None
        async with factory() as session:
            stored = set(
                (await session.execute(select(db_models.Chunk.chunk_text))).scalars().all()
            )

        for hit in await _search(factory):
            assert hit.chunk.revision == revision
            assert hit.chunk.text in stored

    _scenario(body)


def test_a_chunk_appears_at_most_once_even_when_both_paths_rank_it() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        hits = await _search(factory)

        chunk_ids = [hit.chunk.chunk_id for hit in hits]
        assert chunk_ids
        assert len(chunk_ids) == len(set(chunk_ids))
        assert any(hit.lexical_rank is not None and hit.vector_rank is not None for hit in hits), (
            "the fusion test needs a chunk both paths ranked"
        )

    _scenario(body)


def test_ranks_are_one_based_and_fused_score_is_the_reciprocal_rank_sum() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        for index in range(4):
            await _publish(
                factory,
                document_id=f"DOC-{index:03d}",
                text=f"# سند {index}\n\n## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n",
                access_role="employee",
            )
        config = RetrievalConfig()

        hits = await _search(factory, config=config)

        assert hits
        for path in ("lexical_rank", "vector_rank"):
            ranks = [getattr(hit, path) for hit in hits if getattr(hit, path) is not None]
            assert ranks == list(range(1, len(ranks) + 1)), (path, ranks)
        for hit in hits:
            expected = 0.0
            if hit.lexical_rank is not None:
                expected += 1.0 / (config.rrf_k + hit.lexical_rank)
            if hit.vector_rank is not None:
                expected += 1.0 / (config.rrf_k + hit.vector_rank)
            assert hit.fused_score == pytest.approx(expected)

    _scenario(body)


def test_the_result_is_capped_at_final_top_k_and_sorted_by_score() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        for index in range(6):
            await _publish(
                factory,
                document_id=f"DOC-{index:03d}",
                text=f"# سند {index}\n\n## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n",
                access_role="employee",
            )

        hits = await _search(factory, config=RetrievalConfig(final_top_k=3))

        assert len(hits) == 3
        assert [hit.fused_score for hit in hits] == sorted(
            (hit.fused_score for hit in hits), reverse=True
        )

    _scenario(body)


def test_each_path_contributes_at_most_its_own_top_k() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        for index in range(8):
            await _publish(
                factory,
                document_id=f"DOC-{index:03d}",
                text=f"# سند {index}\n\n## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n",
                access_role="employee",
            )

        hits = await _search(
            factory, config=RetrievalConfig(lexical_top_k=2, vector_top_k=3, final_top_k=10)
        )

        assert max((hit.lexical_rank or 0) for hit in hits) <= 2, hits
        assert max((hit.vector_rank or 0) for hit in hits) <= 3, hits

    _scenario(body)


def test_the_allowlist_is_not_reachable_by_inflating_the_configuration() -> None:
    """A huge top-k widens how much is ranked, never who may be ranked."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )

        hits = await _search(
            factory,
            role="employee",
            config=RetrievalConfig(lexical_top_k=1000, vector_top_k=1000, final_top_k=1000),
        )

        assert MANAGER_DOCUMENT not in _document_ids(hits)

    _scenario(body)


def test_an_empty_domain_returns_no_hits_rather_than_raising() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        assert await _search(factory) == []

    _scenario(body)


def test_the_lexical_path_matches_on_overlap_even_when_scores_are_negative() -> None:
    """``rank_bm25`` returns negative scores on a small corpus; overlap is the test.

    ``BM25Okapi`` floors a negative IDF at a fraction of the corpus's *average* IDF.
    Where a term appears in every chunk, that average is negative too, so a chunk
    that matches perfectly scores below zero. The lexical path must therefore decide
    "matched" by token overlap and use the score only to order - and the corpus here
    is built so every chunk contains the searched term, which is the case that
    actually produces the negative score.
    """
    # Confirmed against the library, so the test states a fact rather than a hope.
    from rank_bm25 import BM25Okapi

    corpus = [tokenize(text) for text in ("سقف پرداخت مدیران", "سقف پرداخت")]
    scores = BM25Okapi(corpus).get_scores(["سقف"])
    assert max(scores) < 0, scores

    async def body(engine: AsyncEngine, factory: Any) -> None:
        # Two chunks, and the searched term is in both, which is what makes the
        # average IDF - and therefore the score - negative.
        await _publish(
            factory,
            document_id=MANAGER_DOCUMENT,
            text="# الف\n\n## یک\n\nسقف پرداخت مدیران.\n\n## دو\n\nسقف پرداخت.\n",
            access_role="manager",
        )

        async with factory() as session:
            eligible = await retrieval_store.read_eligible_chunks(session, _actor("manager"))
        assert len(eligible) == 2, eligible
        ranked = lexical_ranking(eligible, "سقف", top_k=10)
        assert len(ranked) == 2, "overlap must match despite the negative score"

        hits = await _search(factory, role="manager", question="سقف")
        assert len(hits) == 2, hits
        assert all(hit.lexical_rank is not None for hit in hits), hits

    _scenario(body)


def test_a_question_that_matches_nothing_still_returns_vector_hits() -> None:
    """Documented behaviour, not a bug: the vector path always has a nearest neighbour.

    Deciding that nothing is relevant enough is a later part's job; retrieval
    reports what it ranked and says which path each rank came from.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        # Latin nonsense, so no token can coincide with a Persian corpus term.
        hits = await _search(factory, question="zzzqqqxyz wvvbnm")

        assert hits
        assert all(hit.lexical_rank is None for hit in hits), hits
        assert all(hit.vector_rank is not None for hit in hits), hits

    _scenario(body)


def test_an_empty_question_returns_no_hits_without_calling_the_provider() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        provider = FakeProvider()

        hits = await _search(factory, question="   \n  ", provider=provider)

        assert hits == []
        assert provider.query_calls == []

    _scenario(body)


def test_the_query_reaches_the_provider_exactly_once() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        provider = FakeProvider()

        await _search(factory, provider=provider)

        assert len(provider.query_calls) == 1, provider.query_calls

    _scenario(body)


# --------------------------------------------------------------------------
# both paths are handed the same normalized question
# --------------------------------------------------------------------------


def test_the_provider_is_given_the_normalized_question_not_the_raw_one() -> None:
    """Review finding: the raw text produced two different questions.

    ``technical-details.md`` fixes the query prefix and nothing else; the normalizer
    is this project's job. Sending the raw text would let two spellings of the same
    Persian question embed differently, and the lexical and vector paths would then
    be searching for different things.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        provider = FakeProvider()

        await _search(factory, provider=provider)

        assert provider.query_calls == [normalize_for_search(QUESTION)]
        # It really is a rewrite, so the test cannot pass by coincidence.
        assert provider.query_calls[0] != QUESTION

    _scenario(body)


def test_both_paths_receive_the_same_normalized_string() -> None:
    """BM25 and the provider must be looking for exactly the same thing."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        provider = FakeProvider()

        await _search(factory, provider=provider)

        given = provider.query_calls[0]
        # The lexical path tokenizes what it is given, so the terms it searched are
        # derivable from the provider's input and nothing else.
        assert tokenize(given) == tokenize(QUESTION)
        assert tokenize(given) == normalize_for_search(given).split()

    _scenario(body)


def test_two_spellings_of_one_question_send_one_string_to_the_provider() -> None:
    """The review's criterion, stated directly: same text both times."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        arabic = FakeProvider()
        persian = FakeProvider()

        await _search(factory, question="درخواست بازپرداخت ي با رقم ١٥", provider=arabic)
        await _search(factory, question="درخواست بازپرداخت ی با رقم ۱۵", provider=persian)

        assert arabic.query_calls == persian.query_calls
        assert arabic.query_calls[0] == "درخواست بازپرداخت ی با رقم 15"

    _scenario(body)


def test_normalization_reaches_the_ranking_and_not_only_the_provider() -> None:
    """The bug the finding describes is visible in the ranks, not in a mock."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        arabic = await _search(factory, question="شرط بازپرداخت ي با رقم ١٥")
        persian = await _search(factory, question="شرط بازپرداخت ی با رقم ۱۵")

        assert arabic and persian
        assert [hit.lexical_rank for hit in arabic] == [hit.lexical_rank for hit in persian]
        assert [hit.fused_score for hit in arabic] == [hit.fused_score for hit in persian]

    _scenario(body)


def test_a_question_that_is_only_different_before_normalization_still_matches() -> None:
    """The stored text keeps Persian digits; the question arrives with Arabic ones."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        hits = await _search(factory, question="درخواست بازپرداخت با رقم ١٥")

        assert hits, hits
        assert any(hit.lexical_rank is not None for hit in hits), hits

    _scenario(body)


def test_a_question_that_normalizes_to_nothing_reaches_no_path() -> None:
    """The emptiness test runs on the normalized form, not on the raw one.

    A question made only of characters the normalizer discards must not reach the
    provider: embedding the empty string would cost a round trip and could return a
    nearest neighbour, which would look like a real answer to an empty question.
    """

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        provider = FakeProvider()
        # ZWNJ, RLM and whitespace only; all three normalize away.
        assert normalize_for_search("‌‏  ") == ""

        hits = await _search(factory, question="‌‏  ", provider=provider)

        assert hits == []
        assert provider.query_calls == []

    _scenario(body)


# --------------------------------------------------------------------------
# the source text a hit carries is the ingested text, byte for byte
# --------------------------------------------------------------------------


def test_a_hit_carries_the_ingested_chunk_text_unchanged() -> None:
    """A quote is matched against this string later, so it must not be normalized."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        async with factory() as session:
            stored = set(
                (await session.execute(select(db_models.Chunk.chunk_text))).scalars().all()
            )
        hits = await _search(factory)

        assert hits
        for hit in hits:
            assert hit.chunk.text in stored
            assert hit.chunk.search_text == normalize_for_search(hit.chunk.text)
        # At least one hit really does contain something normalization would rewrite,
        # so the assertion above is not vacuously true.
        assert any(normalize_for_search(hit.chunk.text) != hit.chunk.text for hit in hits), hits
        assert any("۱۵" in hit.chunk.text for hit in hits), "expected the Persian-digit section"

    _scenario(body)


def test_chunk_text_is_a_verbatim_slice_of_the_section_source() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        async with factory() as session:
            sources = set(
                (await session.execute(select(db_models.Section.source_text))).scalars().all()
            )

        for hit in await _search(factory):
            assert any(hit.chunk.text in source for source in sources), hit.chunk.text[:60]

    _scenario(body)


def test_persian_normalization_makes_the_spellings_match() -> None:
    """The contract's own assertion: two spellings must normalize to one string."""

    assert normalize_for_search("ي ك ۱۵ نیم‌فاصله") == normalize_for_search("ی ک 15 نیم فاصله")


def test_an_arabic_spelling_of_the_question_ranks_identically() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        arabic = await _search(factory, question="شرط بازپرداخت ي با رقم ١٥")
        persian = await _search(factory, question="شرط بازپرداخت ی با رقم ۱۵")

        assert arabic and persian
        assert [hit.chunk.chunk_id for hit in arabic] == [hit.chunk.chunk_id for hit in persian]
        assert [hit.fused_score for hit in arabic] == [hit.fused_score for hit in persian]

    _scenario(body)


def test_a_hit_is_scoped_to_one_section_and_the_current_revision() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        revision = await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        assert revision is not None
        records = chunk_sections(
            parse_document(EMPLOYEE_TEXT),
            document_id=EMPLOYEE_DOCUMENT,
            revision=revision,
            access_role="employee",
            counter=WordCounter(),
        )

        hits = await _search(factory)

        assert hits
        for hit in hits:
            assert hit.chunk.revision == revision
            assert any(record.section_id == hit.chunk.section_id for record in records)
            assert hit.chunk.ordinal >= 0

    _scenario(body)


# --------------------------------------------------------------------------
# the provider is reached through its protocol, not a vendor SDK
# --------------------------------------------------------------------------


def test_retrieval_depends_on_the_vector_provider_protocol() -> None:
    """The dependency is the protocol, so a fake with no vendor SDK is enough.

    The protocol carries the identity as well as the two embedding calls, because
    retrieval now refuses to rank an index that the provider did not build. That is
    four extra members on a fake and it is the whole of the safety property: a
    retrieval service that trusted an index of unknown provenance would be comparing
    vectors from two different models and calling the result a ranking.
    """

    class Minimal:
        provider_name = TEST_PROVIDER
        model = TEST_MODEL
        dimension = DIMENSION
        last_digest = TEST_DIGEST

        async def embed_documents(self, texts: list[str]) -> list[list[float]]:
            return [_vector(text) for text in texts]

        async def embed_query(self, text: str) -> list[float]:
            return _vector(text)

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )

        hits = await _search(factory, provider=Minimal())

        assert _document_ids(hits) == {EMPLOYEE_DOCUMENT}
        assert isinstance(Minimal(), EmbeddingProvider)
        assert isinstance(Minimal(), VectorProvider)

    _scenario(body)


def test_two_retrievals_over_the_same_data_rank_identically() -> None:
    """No hidden ordering: a tie must not be broken by iteration order."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        for index in range(5):
            await _publish(
                factory,
                document_id=f"DOC-{index:03d}",
                text=f"# سند {index}\n\n## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n",
                access_role="employee",
            )

        first = await _search(factory)
        second = await _search(factory)

        assert [hit.chunk.chunk_id for hit in first] == [hit.chunk.chunk_id for hit in second]
        assert [hit.fused_score for hit in first] == [hit.fused_score for hit in second]

    _scenario(body)


def test_the_allowlist_ignores_documents_the_actor_cannot_see_even_when_they_match_exactly() -> (
    None
):
    """An exact-match leak is the failure that matters, not an average-case one."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        # Both documents contain the identical sentence, so ranking cannot be blamed.
        shared = "# یکسان\n\n## مشترک\n\nدرخواست بازپرداخت سفر و ثبت آن.\n"
        await _publish(factory, document_id=EMPLOYEE_DOCUMENT, text=shared, access_role="employee")
        await _publish(factory, document_id=MANAGER_DOCUMENT, text=shared, access_role="manager")

        employee_hits = await _search(factory, question="درخواست بازپرداخت سفر", role="employee")
        manager_hits = await _search(factory, question="درخواست بازپرداخت سفر", role="manager")

        assert _document_ids(employee_hits) == {EMPLOYEE_DOCUMENT}
        assert _document_ids(manager_hits) == {EMPLOYEE_DOCUMENT, MANAGER_DOCUMENT}

    _scenario(body)


def test_the_chunk_count_returned_never_exceeds_the_published_chunk_count() -> None:
    """A duplicate or phantom row would show up here before it reached a reader."""

    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        async with factory() as session:
            published = int(
                (
                    await session.execute(
                        select(func.count())
                        .select_from(db_models.Chunk)
                        .where(db_models.Chunk.document_id == EMPLOYEE_DOCUMENT)
                    )
                ).scalar_one()
            )

        hits = await _search(factory, config=RetrievalConfig(final_top_k=100))

        assert len(hits) <= published, (len(hits), published)

    _scenario(body)


@pytest.mark.parametrize("changed_digest", [True, False])
def test_replacement_after_preflight_validates_the_vectors_actually_ranked(
    changed_digest: bool,
) -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        barrier = _AtBarrier()
        task = asyncio.create_task(_search_while_blocked(factory, barrier))
        await barrier.reached.wait()

        class ReplacementProvider(FakeProvider):
            @property
            def last_digest(self) -> str:
                return "a" * 64 if changed_digest else TEST_DIGEST

        try:
            async with factory() as session:
                await ingestion_store.stage_replace(
                    session,
                    actor=_actor("manager"),
                    document_id=EMPLOYEE_DOCUMENT,
                    text_body="# تازه\n\n## شرایط\n\nبازپرداخت هزینه سفر.\n",
                    metadata=UploadInput(title="تازه", access_role="employee"),
                )
            outcome = await _worker(factory, ReplacementProvider()).process_next_job()
            assert outcome is not None and outcome.outcome == "ready"
        finally:
            barrier.resume.set()
        if changed_digest:
            with pytest.raises(IndexProvenanceMismatchError):
                await task
        else:
            hits = await task
            assert hits and {hit.chunk.revision for hit in hits} == {
                await _revision_of(factory, EMPLOYEE_DOCUMENT)
            }

    _scenario(body)


def test_provenance_changed_before_final_read_is_not_delivered() -> None:
    async def body(engine: AsyncEngine, factory: Any) -> None:
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        original = retrieval_store.read_ranked_chunks

        async def change_before_read(*args: Any, **kwargs: Any) -> Any:
            async with factory() as changer:
                await changer.execute(
                    update(db_models.Chunk)
                    .where(db_models.Chunk.document_id == EMPLOYEE_DOCUMENT)
                    .values(embedding_digest="a" * 64)
                )
                await changer.commit()
            return await original(*args, **kwargs)

        with mock.patch.object(retrieval_store, "read_ranked_chunks", change_before_read):
            with pytest.raises(IndexProvenanceMismatchError):
                await _search(factory)

    _scenario(body)
