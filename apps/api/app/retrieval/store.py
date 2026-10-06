"""Database reads for retrieval, all of them inside the authorization allowlist.

The allowlist is a **SQL predicate**, not a Python filter over retrieved rows, and
that is the single most important property of this module. Filtering after the
fact would rank forbidden rows first and drop them afterwards, which leaks through
the result count and depends on nobody forgetting the filter. Every statement here
therefore carries :func:`retrievable_documents`.

The predicate encodes every condition ARCHITECTURE.md section 6 and DATABASE.md
section 5 require: ``status = 'active'``, ``current_revision IS NOT NULL``, a
``ready`` job exists for that revision, a non-null embedding, and an ``access_role``
the actor may read. Both the lexical and the vector path read it, so they cannot
disagree about membership.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import Row
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.sql.elements import ColumnElement

from app.db.models import Chunk, Document, IngestionJob
from app.documents.chunking import ChunkRecord
from app.domain.models import ROLES, VISIBLE_ROLES, Actor, Role
from app.ingestion.contracts import JOB_STATUS_READY
from app.retrieval.contracts import IndexProvenance

#: How many eligible chunks the lexical path may read into memory. The corpus is
#: small and DATABASE.md section 6 keeps exact vector scans until it is not, so an
#: in-memory BM25 over the whole eligible domain is the documented design rather
#: than an approximation of it. The bound exists so a corpus that outgrows this
#: assumption fails loudly instead of exhausting the process.
MAX_LEXICAL_CHUNKS = 50_000


class RetrievalDomainTooLargeError(RuntimeError):
    """The eligible domain exceeds what the in-memory lexical path will read.

    Raised rather than silently truncating: a truncated BM25 corpus would return
    results that look complete but are not, which is the kind of quiet wrongness
    this project refuses.
    """


class IndexProvenanceMismatchError(RuntimeError):
    """The index about to be ranked was not built by the active provider.

    DATABASE.md section 5's index consistency invariant: a mixed or stale digest, or
    a dimension other than the provider's, fails closed instead of being ranked.
    Comparing vectors across two models produces numbers, not meaning, and returning
    them as confident hits is the worst possible outcome.

    The message names the **expected** identity - which the operator already
    configured, so it discloses nothing - and a count of how many distinct
    provenances were found. It never names an *observed* digest and never names a
    document. A row the actor may not read must not become observable through the
    shape of an error, and an observed digest could be correlated with a document's
    revision if an attacker can already see one digest.
    """


def role_restriction_cast(value: str) -> Role:
    """Narrow a stored role string to the domain type, refusing an unknown value.

    ``documents.access_role`` is typed ``str`` because it comes from a text column.
    Narrowing it once, here, keeps ``type: ignore`` out of the record constructor and
    means an unexpected value fails here rather than travelling further.
    """
    if value not in ROLES:
        raise ValueError(f"stored access_role is not a known role: {value!r}")
    return value


def retrievable_documents(actor: Actor) -> ColumnElement[bool]:
    """Return the predicate a chunk must satisfy to be visible to ``actor``.

    Applied to the joined statement rather than evaluated in Python, so the
    database never ranks a row the actor may not read.
    """
    ready_job = (
        select(IngestionJob.job_id)
        .where(
            IngestionJob.document_id == Document.document_id,
            IngestionJob.target_revision == Document.current_revision,
            IngestionJob.status == JOB_STATUS_READY,
        )
        .exists()
    )
    # Every operand is parenthesised. ``&`` binds tighter than ``==`` in Python, so
    # an unparenthesised chain groups as ``... & Chunk.revision == (...)`` and hands
    # PostgreSQL a text operand to AND.
    #
    # The embedding test belongs *here* and not in the vector path alone: DATABASE.md
    # section 5 keeps data without an embedding out of retrieval entirely, so BM25
    # must not be a way around it. A chunk that exists but was never embedded is
    # incomplete, and an incomplete row must not be citable.
    return (
        (Document.status == "active")
        & (Document.current_revision.is_not(None))
        & (Document.access_role.in_(VISIBLE_ROLES[actor.role]))
        & (Chunk.revision == Document.current_revision)
        & (Chunk.embedding.is_not(None))
        & ready_job
    )


@dataclass(frozen=True)
class EligibleChunk:
    """One row of the eligible domain, in both the raw and derived forms.

    ``chunk_text`` is kept verbatim and ``search_text`` is read from its own
    column. Both are already stored, so retrieval normalizes the question only and
    never rewrites either.
    """

    chunk_id: UUID
    document_id: str
    revision: str
    section_id: str
    ordinal: int
    chunk_text: str
    access_role: str
    provenance: IndexProvenance

    def to_record(self) -> ChunkRecord:
        return ChunkRecord(
            chunk_id=self.chunk_id,
            document_id=self.document_id,
            revision=self.revision,
            section_id=self.section_id,
            ordinal=self.ordinal,
            text=self.chunk_text,
            # The database CHECK and :func:`retrievable_documents` both restrict
            # this to the two known roles, so the cast is narrowing, not guessing.
            access_role=role_restriction_cast(self.access_role),
        )


_CHUNK_COLUMNS = (
    Chunk.chunk_id,
    Chunk.document_id,
    Chunk.revision,
    Chunk.section_id,
    Chunk.ordinal,
    Chunk.chunk_text,
    Document.access_role,
    Chunk.embedding_provider,
    Chunk.embedding_model,
    Chunk.embedding_digest,
    Chunk.embedding_dimension,
)


def _eligible_query(actor: Actor) -> Any:
    """The one query both paths build on: eligible chunks, and nothing else.

    Deliberately carries **no** ``ORDER BY``. Each path adds its own, because
    SQLAlchemy appends ``order_by`` rather than replacing what is already there: a
    shared ``ORDER BY chunk_id`` would silently become the primary sort key of the
    vector query and rank by UUID instead of by distance.

    The ``Any`` is deliberate. SQLAlchemy types a multi-column select as
    ``Select[c1, c2, ...]`` while ``execute`` yields a tuple row, and no precise
    spelling satisfies both. The column order is pinned once, in :func:`_to_chunk`,
    which is the only place it matters.
    """
    return (
        select(*_CHUNK_COLUMNS)
        .join(Document, Document.document_id == Chunk.document_id)
        .where(retrievable_documents(actor))
    )


def _to_chunk(row: Row[Any]) -> EligibleChunk:
    """Map one selected row onto the retrieval record.

    Unpacking keeps the column order in one place, and the trailing column the
    vector path adds is ignored rather than silently shifting the fields.
    """
    fields = tuple(row)
    if len(fields) < 11:  # pragma: no cover - the select is built right above
        raise RuntimeError("retrieval row is missing columns")
    chunk_id, document_id, revision, section_id, ordinal, chunk_text, access_role = fields[:7]
    return EligibleChunk(
        chunk_id=chunk_id,
        document_id=document_id,
        revision=revision,
        section_id=section_id,
        ordinal=ordinal,
        chunk_text=chunk_text,
        access_role=access_role,
        provenance=IndexProvenance(*fields[7:11]),
    )


async def read_eligible_chunks(
    session: AsyncSession, actor: Actor, *, limit: int = MAX_LEXICAL_CHUNKS
) -> list[EligibleChunk]:
    """Return every chunk the actor may search over, in a stable order.

    The stable order is what makes two identical requests rank identically: BM25 is
    order-insensitive in its scores, but the tie-breaks that follow it are not.
    """
    statement = _eligible_query(actor).order_by(Chunk.chunk_id).limit(limit + 1)
    rows = (await session.execute(statement)).all()
    if len(rows) > limit:
        raise RetrievalDomainTooLargeError(
            f"more than {limit} chunks are retrievable for this role; "
            "the in-memory BM25 design no longer holds"
        )
    return [_to_chunk(row) for row in rows]


async def vector_candidates(
    session: AsyncSession,
    actor: Actor,
    *,
    embedding: Sequence[float],
    top_k: int,
) -> list[EligibleChunk]:
    """Return the nearest eligible chunks by cosine distance.

    An exact scan, matching DATABASE.md section 6's decision to add ANN only after
    measurement. Distance is the **primary** sort key; ``chunk_id`` appears only
    after it, so equal distances have a defined order without UUID overriding the
    ranking. The embedding test is no longer repeated here: it is part of
    :func:`retrievable_documents`, which is what keeps the two paths in step.
    """
    distance = Chunk.embedding.cosine_distance(list(embedding))
    statement = (
        _eligible_query(actor).add_columns(distance).order_by(distance, Chunk.chunk_id).limit(top_k)
    )
    return [_to_chunk(row) for row in (await session.execute(statement)).all()]


async def read_ranked_chunks(
    session: AsyncSession,
    actor: Actor,
    *,
    chunk_ids: Sequence[UUID],
) -> dict[UUID, EligibleChunk]:
    """Re-read the fused candidates under the allowlist, in one fresh statement.

    This is the authorization decision point. Ranking happens over a snapshot read
    earlier in the request, and between that read and this one the document may have
    been deleted, replaced, or have had its access narrowed. Ranking does not unrank
    anything, so a candidate that is no longer eligible is **dropped**, and the rows
    that do come back are re-read, which means the text a hit carries is the text
    that is authorized *now* rather than the text that was authorized then.

    A candidate is never replaced by a different chunk. If a replacement landed in
    between, the old rows no longer satisfy ``revision = current_revision``, so they
    are simply absent from the result and the request returns fewer hits. Returning
    nothing is the honest outcome; returning the new revision's text under the old
    ranks would be a quote that matches no ranking that produced it.
    """
    if not chunk_ids:
        return {}
    statement = _eligible_query(actor).where(Chunk.chunk_id.in_(list(chunk_ids)))
    return {
        chunk.chunk_id: chunk
        for chunk in (_to_chunk(row) for row in (await session.execute(statement)).all())
    }


async def assert_index_consistent(
    session: AsyncSession, actor: Actor, *, expected: IndexProvenance
) -> None:
    """Fail closed unless the domain about to be ranked was built by ``expected``.

    The check is scoped to the **eligible domain**, not to the whole ``chunks``
    table, and that scoping is deliberate. A global verdict would make one actor's
    availability depend on rows that actor cannot read, which is both a false
    failure and a role-dependent signal about data they are not entitled to know
    exists. Scoping it to the domain also keeps the statement inside the allowlist,
    so the check cannot be turned into an oracle.

    An empty domain is consistent: there is nothing to rank, and refusing an empty
    corpus would make "no documents yet" indistinguishable from a broken index.
    """
    statement = (
        select(
            Chunk.embedding_provider,
            Chunk.embedding_model,
            Chunk.embedding_digest,
            Chunk.embedding_dimension,
        )
        .select_from(Chunk)
        .join(Document, Document.document_id == Chunk.document_id)
        .where(retrievable_documents(actor))
        .distinct()
    )
    observed = {
        IndexProvenance(
            provider=provider,
            model=model,
            digest=digest,
            dimension=dimension,
        )
        for provider, model, digest, dimension in (await session.execute(statement)).all()
    }
    _assert_provenances(observed, expected=expected)


def assert_chunks_consistent(chunks: Iterable[EligibleChunk], *, expected: IndexProvenance) -> None:
    """Validate identity from the same rows used for ranking or delivery."""
    _assert_provenances({chunk.provenance for chunk in chunks}, expected=expected)


def _assert_provenances(observed: set[IndexProvenance], *, expected: IndexProvenance) -> None:
    if not observed or observed == {expected}:
        return
    raise IndexProvenanceMismatchError(
        "the retrievable index was not built by the active embedding provider "
        f"(expected provider={expected.provider!r} model={expected.model!r} "
        f"digest={expected.digest!r} dimension={expected.dimension}; found "
        f"{len(observed)} distinct provenance entries); rebuild the index before querying"
    )


async def count_retrievable_documents(session: AsyncSession, actor: Actor) -> int:
    """Count the documents in the allowlist, for a report's summary line."""
    statement = select(Document.document_id).where(retrievable_documents(actor)).distinct()
    return len((await session.execute(statement)).all())


def visible_roles(actor: Actor) -> tuple[Role, ...]:
    """Expose the allowlist's role set so a report can state what it searched."""
    return VISIBLE_ROLES[actor.role]
