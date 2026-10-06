"""Reciprocal rank fusion of the two retrieval paths.

ARCHITECTURE.md section 6 fixes ``k = 60``. The score of a chunk is the sum of
``1 / (k + rank)`` over the paths that returned it, using one-based ranks. Scores
are only comparable within one request, which is fine because the only consumer is
a ranking inside a single query.

Nothing here sees a document's text or role. Fusion runs on identifiers that both
paths already produced inside the allowlist, so it cannot widen membership: the
union of two allowlisted lists is still allowlisted.
"""

from collections.abc import Mapping, Sequence
from uuid import UUID


def fuse(
    lexical: Mapping[UUID, int],
    vector: Mapping[UUID, int],
    *,
    rrf_k: int,
) -> dict[UUID, tuple[int | None, int | None, float]]:
    """Return ``chunk_id -> (lexical_rank, vector_rank, fused_score)``.

    A chunk ranked by both paths scores higher than one ranked by either alone,
    which is the property that makes fusion worth the extra pass. Ties are left for
    the caller to break, because only the caller knows the deterministic order it
    wants; this function reports the scores and nothing else.
    """
    fused: dict[UUID, float] = {}
    for ranks in (lexical, vector):
        for chunk_id, rank in ranks.items():
            fused[chunk_id] = fused.get(chunk_id, 0.0) + 1.0 / (rrf_k + rank)

    return {
        chunk_id: (lexical.get(chunk_id), vector.get(chunk_id), score)
        for chunk_id, score in fused.items()
    }


def order_by_score(
    fused: Mapping[UUID, tuple[int | None, int | None, float]],
    *,
    limit: int,
) -> list[tuple[UUID, tuple[int | None, int | None, float]]]:
    """Return the best ``limit`` entries, highest score first.

    Ties break on the ascending ranks and finally on the identifier, so two runs
    over unchanged data produce byte-identical output. A database row order is not
    a contract, and an unstable tie would make a retrieval report impossible to
    compare between runs.
    """
    return sorted(
        fused.items(),
        key=lambda item: (-item[1][2], item[1][0] or 1 << 30, item[1][1] or 1 << 30, item[0]),
    )[:limit]


def as_rank_maps(
    ranked: Sequence[tuple[str, int]],
) -> dict[UUID, int]:
    """Turn the lexical path's ``(chunk_id, rank)`` pairs into a rank map."""
    return {UUID(chunk_id): rank for chunk_id, rank in ranked}
