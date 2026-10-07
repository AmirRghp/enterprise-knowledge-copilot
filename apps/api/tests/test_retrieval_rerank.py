"""Tests for reranking inside retrieval, and for the disabled path.

Two properties are worth more than the rest, so they come first:

* **disabled means zero calls.** ``RERANK_ENABLED=false`` is the shipped default, and
  the promise is not "returns the same answer" but "never touches a reranker". A fake
  that raises on any use is the only way to state that, because an assertion on the
  returned order would pass just as well if the call were made and ignored.
* **authorized before egress.** Reranking is the first step that sends document text
  outside the process, so the candidate list is re-checked against the allowlist
  immediately before it goes out. A capture of what the provider was handed is the
  direct evidence, and it is what ``technical-details.md``'s own criterion checks.

The rest cover the ordering contract: rerank sees the fused list up to
``rerank_top_k``, the final cut happens after it, the fused score survives alongside
the rerank score, and a provider failure is visible rather than silently degraded.

Every database interaction goes through :func:`_retrieve` or :func:`_publish_near_identical`,
each of which owns its event loop and closes what it opened. Handing a bare session to
``retrieve`` left connections checked out whenever an assertion failed, and the garbage
collector warning that followed named a pool that does not exist, which would have made
a real leak invisible.

The fake reranker is deliberately *not* correlated with relevance, so a test cannot pass
by the provider happening to agree with the fusion.
"""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from typing import Any
from unittest import mock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import models as db_models
from app.documents.chunking import ChunkRecord
from app.documents.normalize import normalize_for_search
from app.domain.models import Role
from app.providers.base import (
    ProviderUsage,
    RerankCandidate,
    RerankProvider,
    ScoredCandidate,
)
from app.retrieval.contracts import IndexProvenance, RetrievalConfig, RetrievalHit, SourceRef
from app.retrieval.rerank import RerankUnavailableError
from app.retrieval.service import retrieve
from tests.test_retrieval import (
    DIMENSION,
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    TEST_DIGEST,
    TEST_MODEL,
    TEST_PROVIDER,
    FakeProvider,
    _actor,
    _publish,
    _scenario,
    _search,
)

QUESTION = "درخواست بازپرداخت سفر"


def _hit(
    *,
    chunk_id: uuid.UUID | None = None,
    document_id: str = EMPLOYEE_DOCUMENT,
    access_role: Role = "employee",
    lexical_rank: int | None = 1,
    vector_rank: int | None = 2,
    fused_score: float = 0.03,
) -> RetrievalHit:
    return RetrievalHit(
        chunk=ChunkRecord(
            chunk_id=chunk_id or uuid.uuid4(),
            document_id=document_id,
            revision="11111111-1111-1111-1111-111111111111",
            section_id=f"{document_id}-S1",
            ordinal=0,
            text="متن آزمایشی",
            access_role=access_role,
        ),
        lexical_rank=lexical_rank,
        vector_rank=vector_rank,
        fused_score=fused_score,
    )


class RecordingReranker:
    """A reranker that records exactly what it was handed, on every attempt.

    ``scores`` maps a chunk id to the score it should return. Whatever is missing gets
    the default, which is how the "provider returned fewer results" case is reached
    without a second fake.

    ``refresh`` is honoured the way a real adapter must honour it: re-read per attempt.
    A fake that ignored it would make the per-attempt re-check untestable, because the
    bug being guarded is precisely a fake-faithful-to-the-bug implementation.
    """

    def __init__(self, scores: dict[uuid.UUID, float] | None = None, *, order: bool = True) -> None:
        self.scores = scores or {}
        self.order = order
        self.calls: list[tuple[str, list[uuid.UUID], int]] = []
        #: Every candidate list the provider was handed, one entry per attempt.
        self.handed: list[list[RerankCandidate]] = []
        #: Failures to raise, consumed one per attempt, for retry tests.
        self.failures: list[BaseException | None] = []

    @property
    def provider_name(self) -> str:
        return "recording"

    @property
    def model(self) -> str:
        return "recording-v1"

    @property
    def last_usage(self) -> ProviderUsage | None:
        return ProviderUsage(provider="recording", model="recording-v1")

    async def rerank(
        self,
        query: str,
        candidates: list[RerankCandidate],
        *,
        top_n: int,
        refresh: Any = None,
    ) -> list[ScoredCandidate]:
        for attempt in range(len(self.failures) or 1):
            current = await refresh() if refresh is not None else candidates
            self.handed.append(current)
            self.calls.append((query, [c.chunk_id for c in current], top_n))
            failure = self.failures[attempt] if attempt < len(self.failures) else None
            if failure is not None:
                raise failure
            scored = [
                ScoredCandidate(chunk_id=c.chunk_id, score=self.scores.get(c.chunk_id, 0.5))
                for c in current
            ]
            if self.order:
                scored.sort(key=lambda item: -item.score)
            return scored[:top_n]
        return []


class ExplodingReranker:
    """Fails on any use, so a disabled rerank's zero calls are provable."""

    def __init__(self) -> None:
        self.calls = 0

    @property
    def provider_name(self) -> str:
        return "exploding"

    @property
    def model(self) -> str:
        return "exploding-v1"

    @property
    def last_usage(self) -> ProviderUsage | None:
        return None

    async def rerank(
        self,
        query: str,
        candidates: list[RerankCandidate],
        *,
        top_n: int,
        refresh: Any = None,
    ) -> list[ScoredCandidate]:
        self.calls += 1
        raise AssertionError("a disabled rerank must not be called")


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


@asynccontextmanager
async def _session(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """Open a session for one call and close it, including when the call raises."""
    async with factory() as session:
        yield session


async def _publish_near_identical(factory: Any, count: int) -> None:
    """Publish ``count`` near-identical employee documents, exceeding the caps."""
    for index in range(count):
        await _publish(
            factory,
            document_id=f"DOC-{index:03d}",
            text=f"# سند {index}\n\n## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n",
            access_role="employee",
        )


async def _publish_documents(factory: Any, *documents: tuple[str, str, Role]) -> None:
    """Publish the given ``(document_id, text, access_role)`` triples."""
    for document_id, text, role in documents:
        await _publish(factory, document_id=document_id, text=text, access_role=role)


async def _retrieve(factory: Any, **overrides: Any) -> list[RetrievalHit]:
    """Call ``retrieve`` on a session that is closed when the call returns."""
    async with _session(factory) as session:
        return await retrieve(
            session,
            actor=_actor(overrides.pop("role", "employee")),
            question=overrides.pop("question", QUESTION),
            config=overrides.pop("config", RetrievalConfig()),
            provider=overrides.pop("provider", FakeProvider()),
            rerank_provider=overrides.pop("rerank_provider", None),
        )


async def _documents_of_chunks(factory: Any, chunk_ids: list[uuid.UUID]) -> list[str]:
    """Map chunk ids to their document ids, with the join stated explicitly.

    Without the join this is a cartesian product and reports documents that supplied
    none of these chunks, which is exactly the shape of a leak report that is not a
    leak.
    """
    async with _session(factory) as session:
        rows = (
            await session.execute(
                select(db_models.Chunk.chunk_id, db_models.Document.document_id)
                .join(
                    db_models.Document,
                    db_models.Document.document_id == db_models.Chunk.document_id,
                )
                .where(db_models.Chunk.chunk_id.in_(chunk_ids))
            )
        ).all()
    return [document for _, document in rows]


# --------------------------------------------------------------------------
# disabled: zero provider work
# --------------------------------------------------------------------------


def test_a_disabled_rerank_makes_no_call_at_all() -> None:
    """``RERANK_ENABLED=false`` is the shipped default, and it must cost nothing."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))
        reranker = ExplodingReranker()

        hits = await _retrieve(factory, rerank_provider=reranker)

        assert hits, hits
        assert reranker.calls == 0, "the reranker was called while disabled"

    _scenario(body)


def test_a_disabled_rerank_never_produces_a_rerank_score() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        hits = await _retrieve(factory, rerank_provider=RecordingReranker())

        assert hits
        assert all(hit.rerank_score is None for hit in hits), hits

    _scenario(body)


def test_disabled_retrieval_is_identical_to_never_having_a_reranker() -> None:
    """A reranker in hand must not perturb the disabled path at all."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        without = await _retrieve(factory)
        in_hand = await _retrieve(factory, rerank_provider=RecordingReranker())

        assert [hit.chunk.chunk_id for hit in without] == [hit.chunk.chunk_id for hit in in_hand]
        assert [hit.fused_score for hit in without] == [hit.fused_score for hit in in_hand]

    _scenario(body)


# --------------------------------------------------------------------------
# enabled: the egress gate
# --------------------------------------------------------------------------


def test_only_authorized_chunks_are_handed_to_the_provider() -> None:
    """``technical-details.md``'s own criterion, checked against a capture.

    An employee must not reach a manager-only document even for the moment it takes to
    hand a list to an external service.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(
            factory,
            (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"),
            (MANAGER_DOCUMENT, MANAGER_TEXT, "manager"),
        )
        reranker = RecordingReranker()

        await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=reranker,
        )

        assert reranker.calls, "the reranker was never called"
        _, ids, _ = reranker.calls[0]
        assert ids, ids

        documents = await _documents_of_chunks(factory, ids)
        assert len(documents) == len(ids), (len(documents), len(ids))
        assert set(documents) == {EMPLOYEE_DOCUMENT}, documents
        assert MANAGER_DOCUMENT not in documents

    _scenario(body)


def test_a_manager_may_rerank_manager_only_documents() -> None:
    """The gate is a widening for managers, not a separate rule."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (MANAGER_DOCUMENT, MANAGER_TEXT, "manager"))
        reranker = RecordingReranker()

        hits = await _retrieve(
            factory,
            role="manager",
            question="سقف پرداخت مدیران",
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=reranker,
        )

        assert hits, hits
        assert {hit.chunk.document_id for hit in hits} == {MANAGER_DOCUMENT}
        assert reranker.calls

    _scenario(body)


def test_nothing_is_sent_when_the_domain_is_empty() -> None:
    async def body(engine: Any, factory: Any) -> None:
        reranker = RecordingReranker()

        hits = await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=reranker,
        )

        assert hits == []
        assert reranker.calls == [], "an empty domain must send nothing"

    _scenario(body)


# --------------------------------------------------------------------------
# enabled: the ordering contract
# --------------------------------------------------------------------------


def test_the_rerank_score_is_recorded_alongside_the_fused_score() -> None:
    """Both survive, so a report can show what the reranker actually changed."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))
        captured: dict[uuid.UUID, float] = {}

        class Capturing(RecordingReranker):
            async def rerank(
                self,
                query: str,
                candidates: list[RerankCandidate],
                *,
                top_n: int,
                refresh: Any = None,
            ) -> list[ScoredCandidate]:
                scored = await super().rerank(query, candidates, top_n=top_n)
                captured.update({item.chunk_id: item.score for item in scored})
                return scored

        hits = await _retrieve(
            factory, config=RetrievalConfig(rerank_enabled=True), rerank_provider=Capturing()
        )

        assert hits, hits
        assert all(hit.rerank_score == 0.5 for hit in hits), hits
        # The fused score is still there and is not the rerank score.
        assert all(hit.fused_score != 0.5 for hit in hits), hits
        for hit in hits:
            assert hit.rerank_score == captured[hit.chunk.chunk_id]

    _scenario(body)


def test_the_reranker_orders_the_hits_and_the_final_cut_follows_it() -> None:
    """The reranker chooses which five survive, not the fusion.

    Six candidates are offered and five survive, which is the shape the contract
    describes. The reranker reverses whatever it is handed, so the fused order it
    received becomes visible in the result: if the final cut were taken before
    reranking, the reversal could not appear at all.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _publish_near_identical(factory, 6)

        class Reversing(RecordingReranker):
            async def rerank(
                self,
                query: str,
                candidates: list[RerankCandidate],
                *,
                top_n: int,
                refresh: Any = None,
            ) -> list[ScoredCandidate]:
                scored = await super().rerank(query, candidates, top_n=len(candidates))
                return list(reversed(scored))[:top_n]

        reranker = Reversing()
        reranked = await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True, rerank_top_k=6, final_top_k=5),
            rerank_provider=reranker,
        )
        _, offered_ids, top_n = reranker.calls[0]

        assert len(offered_ids) == 6, offered_ids
        assert top_n == 6, top_n
        assert len(reranked) == 5, reranked

        # The same fused order the reranker was given, with reranking disabled.
        fused = await _retrieve(factory, config=RetrievalConfig(rerank_top_k=6, final_top_k=6))
        expected = [hit.chunk.chunk_id for hit in fused][::-1][:5]
        assert [hit.chunk.chunk_id for hit in reranked] == expected

    _scenario(body)


def test_the_reranker_sees_the_fused_list_not_a_truncated_one() -> None:
    """``rerank_top_k`` bounds what leaves the process; ``final_top_k`` does not."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_near_identical(factory, 8)
        reranker = RecordingReranker()

        hits = await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True, rerank_top_k=6, final_top_k=3),
            rerank_provider=reranker,
        )

        _, ids, _ = reranker.calls[0]
        assert len(ids) == 6, ids
        assert len(hits) == 3, hits

    _scenario(body)


def test_a_reranker_that_returns_nothing_yields_no_hits_rather_than_everything() -> None:
    """A provider that scores nothing must not be read as "everything is relevant"."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        class Silent(RecordingReranker):
            async def rerank(
                self,
                query: str,
                candidates: list[RerankCandidate],
                *,
                top_n: int,
                refresh: Any = None,
            ) -> list[ScoredCandidate]:
                await super().rerank(query, candidates, top_n=top_n)
                return []

        hits = await _retrieve(
            factory, config=RetrievalConfig(rerank_enabled=True), rerank_provider=Silent()
        )

        assert hits == []

    _scenario(body)


def test_no_candidate_appears_twice_after_reranking() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _publish_near_identical(factory, 5)

        hits = await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=RecordingReranker(),
        )

        ids = [hit.chunk.chunk_id for hit in hits]
        assert len(ids) == len(set(ids))

    _scenario(body)


def test_a_reranked_hit_keeps_a_usable_citation() -> None:
    """The citation handle must survive reranking, or Part 13 cannot cite it."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        hits = await _retrieve(
            factory,
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=RecordingReranker(),
        )

        assert hits
        for hit in hits:
            source = hit.source
            assert isinstance(source, SourceRef)
            assert source.document_id == EMPLOYEE_DOCUMENT
            assert source.section_id and source.revision

    _scenario(body)


# --------------------------------------------------------------------------
# enabled and failing: visible, with no fallback
# --------------------------------------------------------------------------


def test_a_reranker_failure_fails_the_request_instead_of_degrading() -> None:
    """``technical-details.md`` subject 5: no hidden fallback, ever."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        class Failing(RecordingReranker):
            async def rerank(
                self,
                query: str,
                candidates: list[RerankCandidate],
                *,
                top_n: int,
                refresh: Any = None,
            ) -> list[ScoredCandidate]:
                raise RuntimeError("rerank provider unavailable")

        with pytest.raises(RuntimeError, match="unavailable"):
            await _retrieve(
                factory,
                config=RetrievalConfig(rerank_enabled=True),
                rerank_provider=Failing(),
            )

        # And the fused ranking was available, so this really was a refusal to degrade.
        recovered = await _search(factory, question=QUESTION)
        assert recovered, "the same question works with reranking disabled"

    _scenario(body)


def test_enabled_without_a_provider_is_a_wiring_error_not_a_degraded_ranking() -> None:
    """Silently serving the fused order would claim a reranking that never happened."""

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))

        with pytest.raises(RerankUnavailableError, match="no rerank provider"):
            await _retrieve(factory, config=RetrievalConfig(rerank_enabled=True))

    _scenario(body)


def test_the_reranker_is_not_consulted_for_an_empty_question() -> None:
    """An empty question short-circuits before anything is built, so nothing is sent."""

    async def body(engine: Any, factory: Any) -> None:
        reranker = ExplodingReranker()

        hits = await _retrieve(
            factory,
            question="   ",
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=reranker,
        )

        assert hits == []
        assert reranker.calls == 0

    _scenario(body)


# --------------------------------------------------------------------------
# the contract objects
# --------------------------------------------------------------------------


def test_the_recording_fake_satisfies_the_protocol() -> None:
    """The dependency is the protocol, so a caller never imports the adapter."""
    assert isinstance(RecordingReranker(), RerankProvider)


def test_with_rerank_score_keeps_the_fused_score_and_the_ranks() -> None:
    hit = _hit(lexical_rank=3, vector_rank=7, fused_score=0.031)

    rescored = hit.with_rerank_score(0.9)

    assert rescored.rerank_score == 0.9
    assert rescored.fused_score == 0.031
    assert rescored.lexical_rank == 3
    assert rescored.vector_rank == 7
    assert rescored.chunk is hit.chunk
    # The original is untouched: it is the record of how the candidate was chosen.
    assert hit.rerank_score is None


def test_rerank_candidate_equality_compares_the_text_too() -> None:
    """Two candidates for one chunk with different text are different candidates."""
    chunk_id = uuid.uuid4()
    assert RerankCandidate(chunk_id, "یک") == RerankCandidate(chunk_id, "یک")
    assert RerankCandidate(chunk_id, "یک") != RerankCandidate(chunk_id, "دو")


def test_the_query_the_provider_receives_is_the_normalized_one() -> None:
    """Reranking searches for the same string the two retrieval paths used.

    Part 11 normalized the question once for BM25 and the embedding provider. The
    reranker must get that same string, or the last ranking stage would be searching for
    something the first two did not.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))
        reranker = RecordingReranker()

        await _retrieve(
            factory,
            question="درخواست بازپرداخت ي با رقم ١٥",
            config=RetrievalConfig(rerank_enabled=True),
            rerank_provider=reranker,
        )

        query, _, _ = reranker.calls[0]
        assert query == normalize_for_search("درخواست بازپرداخت ي با رقم ١٥")
        assert query != "درخواست بازپرداخت ي با رقم ١٥"

    _scenario(body)


# --------------------------------------------------------------------------
# the review findings: a retry must not re-send revoked text
# --------------------------------------------------------------------------


def test_a_retry_after_a_revocation_sends_nothing() -> None:
    """Review P1 at the service layer, with a real database.

    The first attempt fails transiently. During the backoff the document's access is
    narrowed. The second attempt must re-run the egress gate and send nothing, rather
    than replaying the first attempt's text - which would transmit a document the caller
    may no longer read.

    The backoff is the seam: it is the window in which a concurrent revocation would
    land, and the only place a retry can be caught between one attempt and the next.
    """
    import httpx
    from sqlalchemy import update

    from app.db import models as db_models
    from app.providers import retry as retry_module
    from app.providers.rerank import OpenRouterRerankProvider, RerankResponseError
    from app.providers.retry import RetryPolicy

    sent: list[list[str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        import json

        sent.append(json.loads(request.content)["documents"])
        return httpx.Response(503, json={"error": {"message": "unavailable"}})

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenRouterRerankProvider(
            client,
            base_url="https://openrouter.test/api/v1",
            model="test-reranker",
            api_key="k" * 32,
            policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0),
        )

        revoked = False

        async def narrow_during_backoff(seconds: float) -> None:
            nonlocal revoked
            if not revoked:
                revoked = True
                async with _session(factory) as session:
                    await session.execute(
                        update(db_models.Document)
                        .where(db_models.Document.document_id == EMPLOYEE_DOCUMENT)
                        .values(access_role="manager")
                    )
                    await session.commit()

        try:
            # The retry helper's own sleeper, not ``asyncio.sleep``: patching the module
            # attribute would change it for the whole process, including this test.
            with mock.patch.object(retry_module, "_default_sleep", narrow_during_backoff):
                # Every candidate is gone by the second attempt, so the request is
                # refused rather than sent with an empty document list.
                with pytest.raises(RerankResponseError, match="no candidate remained"):
                    await _retrieve(
                        factory,
                        config=RetrievalConfig(rerank_enabled=True),
                        rerank_provider=provider,
                    )
        finally:
            await client.aclose()

        # Exactly one transmission: the retry sent nothing.
        assert len(sent) == 1, sent
        # And the narrowing really happened, so the gate had something to catch.
        assert revoked, "the revocation never happened"
        async with _session(factory) as session:
            document = await session.get(db_models.Document, EMPLOYEE_DOCUMENT)
            assert document is not None and document.access_role == "manager"

    _scenario(body)


def test_the_egress_gate_refuses_a_row_whose_provenance_changed() -> None:
    """Review P2: the gate must check provenance, not only membership.

    If the stored identity no longer matches the active provider, the text is not the
    text the ranking was built on, so it must not be sent at all - not sent and then
    rejected on the way back, which is what the previous version did.
    """
    from sqlalchemy import update

    from app.db import models as db_models
    from app.retrieval.rerank import rerank_hits
    from app.retrieval.store import IndexProvenanceMismatchError

    def expected() -> IndexProvenance:
        return IndexProvenance(
            provider=TEST_PROVIDER,
            model=TEST_MODEL,
            digest=TEST_DIGEST,
            dimension=DIMENSION,
        )

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(factory, (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"))
        reranker = RecordingReranker()

        # Hits shaped exactly like the ones ``retrieve`` builds, so the gate is
        # exercised with the real record type rather than a stand-in.
        hits = await _retrieve(factory, config=RetrievalConfig(rerank_top_k=5))
        assert hits, "the scenario needs real candidates"

        # Corrupt the identity *after* the ranking read: that is the window the finding
        # describes, and the gate must catch it before any request goes out.
        async with _session(factory) as session:
            await session.execute(
                update(db_models.Chunk)
                .where(db_models.Chunk.document_id == EMPLOYEE_DOCUMENT)
                .values(embedding_digest="a" * 64)
            )
            await session.commit()

        async with _session(factory) as session:
            with pytest.raises(IndexProvenanceMismatchError):
                await rerank_hits(
                    session,
                    actor=_actor("employee"),
                    question=QUESTION,
                    hits=hits,
                    provider=reranker,
                    top_n=5,
                    expected=expected(),
                )

        assert reranker.calls == [], "a request was sent despite the mismatch"
        assert reranker.handed == []

        # The control: a matching identity is accepted and does reach the provider. The
        # digest is restored in place rather than the document re-published, because
        # publishing a document that already exists is a constraint violation rather
        # than a way to reset it.
        async with _session(factory) as session:
            await session.execute(
                update(db_models.Chunk)
                .where(db_models.Chunk.document_id == EMPLOYEE_DOCUMENT)
                .values(embedding_digest=TEST_DIGEST)
            )
            await session.commit()
        matching = await _retrieve(factory, config=RetrievalConfig(rerank_top_k=5))
        assert matching, "the restored scenario needs real candidates"
        async with _session(factory) as session:
            result = await rerank_hits(
                session,
                actor=_actor("employee"),
                question=QUESTION,
                hits=matching,
                provider=reranker,
                top_n=5,
                expected=expected(),
            )
        assert result, result
        assert reranker.calls, "a consistent index must be allowed through"

    _scenario(body)


def test_a_partial_revocation_mid_retry_scores_the_documents_that_were_sent() -> None:
    """The service-level consequence of mapping and counting against the sent list.

    Four candidates are offered across two employee documents. The first attempt fails;
    during the backoff one document is narrowed away, so the retry sends three documents
    and asks for three results. A provider that answers exactly what it was asked must
    be accepted, and the ranking must name only the document still readable.

    Measured against the original four-candidate request the same answer was rejected as
    "3 results for 4 requested" - a false failure on a provider that had answered
    correctly. And resolving each ``index`` against the original list would have attached
    scores to the wrong chunks, one of them the revoked document, which the egress gate
    would then have dropped: the ranking would silently lose a result instead of failing.
    """
    import httpx
    from sqlalchemy import update

    from app.db import models as db_models
    from app.providers import retry as retry_module
    from app.providers.rerank import OpenRouterRerankProvider
    from app.providers.retry import RetryPolicy

    second_document = "DOC-EMP-SECOND"
    attempts = 0
    sent: list[tuple[int, int]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        body = json.loads(request.content)
        sent.append((len(body["documents"]), body["top_n"]))
        if attempts == 1:
            return httpx.Response(503, json={"error": {"message": "unavailable"}})
        # Exactly as many results as this attempt asked for, which is the only correct
        # answer to this request.
        return httpx.Response(
            200,
            json={
                "results": [
                    {"index": index, "relevance_score": 0.9 - index / 10}
                    for index in range(body["top_n"])
                ]
            },
        )

    async def body(engine: Any, factory: Any) -> None:
        await _publish_documents(
            factory,
            (EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, "employee"),
            (second_document, "## بخش\n\nدرخواست بازپرداخت سفر و ثبت آن.\n", "employee"),
        )
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        provider = OpenRouterRerankProvider(
            client,
            base_url="https://openrouter.test/api/v1",
            model="test-reranker",
            api_key="k" * 32,
            policy=RetryPolicy(attempts=2, attempt_timeout_seconds=5.0),
        )

        revoked = False

        async def narrow_during_backoff(seconds: float) -> None:
            nonlocal revoked
            if not revoked:
                revoked = True
                async with _session(factory) as session:
                    await session.execute(
                        update(db_models.Document)
                        .where(db_models.Document.document_id == second_document)
                        .values(access_role="manager")
                    )
                    await session.commit()

        try:
            with mock.patch.object(retry_module, "_default_sleep", narrow_during_backoff):
                hits = await _retrieve(
                    factory,
                    config=RetrievalConfig(rerank_enabled=True),
                    rerank_provider=provider,
                )
        finally:
            await client.aclose()

        # The retry sent three documents and asked for three results.
        assert sent == [(4, 4), (3, 3)], sent
        assert revoked, "the revocation never happened"
        # Every surviving chunk kept its own score, so none was lost to a wrong index.
        assert len(hits) == 3, hits
        assert all(hit.rerank_score is not None for hit in hits), hits
        documents = await _documents_of_chunks(factory, [hit.chunk.chunk_id for hit in hits])
        assert set(documents) == {EMPLOYEE_DOCUMENT}, documents

    _scenario(body)
