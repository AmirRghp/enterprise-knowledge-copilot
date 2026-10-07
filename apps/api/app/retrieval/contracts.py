"""The retrieval contract, framework-free.

CODE_STYLE.md section 4 keeps this module free of FastAPI, SQLAlchemy and provider
types so both the service and a future evaluation CLI can depend on it.

``RetrievalHit`` carries a :class:`~app.documents.chunking.ChunkRecord`, whose
``text`` is the verbatim ingested chunk. That string is what a citation quote is
matched against later, so nothing in retrieval may rewrite it; the normalized form
is a derived property of the same record.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.documents.chunking import ChunkRecord


@dataclass(frozen=True)
class SourceRef:
    """The stable citation handle: ``document_id`` + ``section_id`` + ``revision``.

    ``chunk_id`` is deliberately absent. It is an internal retrieval detail, and
    exposing it would invite it to become a user-facing reference key.
    """

    document_id: str
    section_id: str
    revision: str

    def __post_init__(self) -> None:
        for name, value in (
            ("document_id", self.document_id),
            ("section_id", self.section_id),
            ("revision", self.revision),
        ):
            if not value.strip():
                raise ValueError(f"{name} must not be blank")

    @property
    def citation(self) -> str:
        """The human-facing citation string for this reference."""
        return f"{self.document_id}#{self.section_id}@{self.revision}"


@dataclass(frozen=True)
class RetrievalHit:
    """One ranked chunk, with the ranks that produced it.

    ``lexical_rank`` and ``vector_rank`` are one-based and ``None`` when that path
    did not return the chunk. A chunk both paths ranked therefore carries two
    ranks and a fused score larger than either alone, which is the whole point of
    reciprocal rank fusion.
    """

    chunk: ChunkRecord
    lexical_rank: int | None
    vector_rank: int | None
    fused_score: float
    rerank_score: float | None = None

    @property
    def source(self) -> SourceRef:
        return SourceRef(
            document_id=self.chunk.document_id,
            section_id=self.chunk.section_id,
            revision=self.chunk.revision,
        )

    def with_rerank_score(self, score: float) -> RetrievalHit:
        """Return a copy carrying the reranker's score for this chunk.

        A new object rather than a mutation because the original is part of the
        pre-rerank ranking: the fused score is how this chunk earned its place in the
        candidate list, and overwriting it in place would erase the only record of how
        the candidate was chosen. Keeping both is what lets a report show what the
        reranker actually changed.
        """
        return RetrievalHit(
            chunk=self.chunk,
            lexical_rank=self.lexical_rank,
            vector_rank=self.vector_rank,
            fused_score=self.fused_score,
            rerank_score=score,
        )

    def with_chunk(self, chunk: ChunkRecord) -> RetrievalHit:
        """Return a copy carrying a freshly read version of this chunk.

        The ranks and scores stay, because they describe how this candidate was chosen
        and do not change. Only the chunk's content is replaced, so a caller that
        re-reads a row before sending it can send the current text while still reporting
        the ranking that selected the row.
        """
        return RetrievalHit(
            chunk=chunk,
            lexical_rank=self.lexical_rank,
            vector_rank=self.vector_rank,
            fused_score=self.fused_score,
            rerank_score=self.rerank_score,
        )


@dataclass(frozen=True)
class IndexProvenance:
    """The identity of the model that built a set of vectors.

    Every ``chunks`` row stores these four values, so retrieval can tell whether the
    index it is about to rank came from the same model that just produced the query
    vector. Comparing 768 numbers across two different models yields numbers, not
    meaning, so a mismatch fails closed instead of being ranked (DATABASE.md
    section 5).

    ``digest`` is ``str | None`` because a provider reports ``None`` until its first
    embed has verified one. A query is therefore always embedded *before* this is
    compared, which is why :func:`~app.retrieval.service.retrieve` embeds first.
    """

    provider: str
    model: str
    digest: str | None
    dimension: int

    def __post_init__(self) -> None:
        if self.digest is None:
            raise ValueError(
                "index provenance needs a verified digest; a provider that has not "
                "embedded yet cannot be compared against the index"
            )
        if self.dimension < 1:
            raise ValueError(f"dimension must be positive, got {self.dimension}")


@dataclass(frozen=True)
class RetrievalConfig:
    """The fixed retrieval shape from ARCHITECTURE.md section 6.

    ``rerank_enabled`` and ``rerank_top_k`` are part of the contract but belong to
    the optional rerank part; this part consumes only the three retrieval fields and
    never calls a reranker. They are kept here so the one configuration object
    carries the whole documented shape rather than growing a second type later.
    """

    lexical_top_k: int = 20
    vector_top_k: int = 20
    rrf_k: int = 60
    rerank_enabled: bool = False
    rerank_top_k: int = 20
    final_top_k: int = 5

    def __post_init__(self) -> None:
        for name, value in (
            ("lexical_top_k", self.lexical_top_k),
            ("vector_top_k", self.vector_top_k),
            ("rrf_k", self.rrf_k),
            ("rerank_top_k", self.rerank_top_k),
            ("final_top_k", self.final_top_k),
        ):
            if value < 1:
                raise ValueError(f"{name} must be at least 1, got {value}")
