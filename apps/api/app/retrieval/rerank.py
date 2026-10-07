"""``rerank_hits``: reorder authorized candidates, once, before the final cut.

This module sits between rank fusion and the final ``final_top_k`` truncation, and it
has exactly one job: put the best candidates first. Two properties are not negotiable.

**Authorization is re-checked before anything is sent.** Reranking is the first step in
this project that sends document text outside the process, so the gate that Part 11
placed at the end of retrieval is now a gate on *egress* as well as on delivery. The
same ``read_ranked_chunks`` call is reused rather than a second predicate written, which
is what keeps the two from ever disagreeing about who may read what. It runs once per
attempt path rather than once per attempt, because the decision must hold for the whole
call including its retries: a candidate that was allowed when checked and revoked
before the retry went out would otherwise leave the process mid-flight.

**There is no fallback.** If reranking is enabled and fails, the request fails. Silently
returning the pre-rerank order would change what the caller serves without saying so,
and the caller would report a ranking it never obtained.

The provider never returns text, only scores and the chunk ids it was given, so a
provider that reformats a document cannot move a score onto different text.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.models import Actor
from app.providers.base import RerankCandidate, RerankProvider
from app.retrieval import store
from app.retrieval.contracts import IndexProvenance, RetrievalHit


class RerankUnavailableError(RuntimeError):
    """Reranking is enabled but cannot run.

    A wiring failure, not a degraded mode. ``technical-details.md`` subject 5 forbids a
    silent fallback: serving the pre-rerank order while every downstream report claims
    reranking happened is worse than failing, because nothing would reveal the
    difference to a reader.
    """


async def rerank_hits(
    session: AsyncSession,
    *,
    actor: Actor,
    question: str,
    hits: list[RetrievalHit],
    provider: RerankProvider,
    top_n: int,
    expected: IndexProvenance,
) -> list[RetrievalHit]:
    """Return ``hits`` reordered by the reranker, best first.

    At most ``top_n`` chunks are offered to the provider, which is the caller's
    ``rerank_top_k`` and therefore the number that bounds egress. The list is **not**
    truncated to the final result size here: the reranker's whole value is choosing
    among candidates, and cutting the field down first would leave it nothing to
    choose between. The final cut belongs to the caller, which knows both sizes.
    """
    offered = hits[:top_n]
    if not offered:
        return []

    # The egress gate. Everything below this line may already have left the process.
    #
    # The payload is built from the rows this read returns, not from the ``hits`` the
    # caller handed in. Those hits were read earlier in the request, so if the row
    # changed since - a revision replaced, a chunk rewritten - the text they carry is
    # stale, and sending it would transmit content the current index does not hold.
    # Reading the text here also means the authorization decision and the bytes that
    # leave are derived from the same statement, which is the only way they cannot
    # disagree.
    async def refresh() -> list[RetrievalHit]:
        rows = await store.read_ranked_chunks(
            session, actor, chunk_ids=[hit.chunk.chunk_id for hit in offered]
        )
        # The rows must also still carry the identity the caller's ranking was built
        # from. A row whose provenance changed between the fusion read and here is not
        # the row that earned its place, so it is refused rather than sent.
        store.assert_chunks_consistent(rows.values(), expected=expected)

        live: list[RetrievalHit] = []
        for hit in offered:
            row = rows.get(hit.chunk.chunk_id)
            if row is None:
                continue
            live.append(hit.with_chunk(row.to_record()))
        return live

    # A candidate that lost its authorization between the ranking read and now is
    # dropped, not sent. If that leaves nothing, there is nothing to rerank and the
    # caller's answer is an empty list rather than a failure: nothing was eligible to
    # be scored, which is a different fact from "the provider was asked and failed".
    #
    # ``refresh`` is handed to the adapter rather than called once here, because the
    # adapter is what retries: calling it only once would leave the second attempt
    # holding the first attempt's text. The adapter rebuilds the request from whatever
    # this returns, once per attempt, so a document revoked during a backoff is never
    # re-sent.
    async def refreshed_candidates() -> list[RerankCandidate]:
        return [
            RerankCandidate(chunk_id=hit.chunk.chunk_id, text=hit.chunk.text)
            for hit in await refresh()
        ]

    if not await refresh():
        return []

    scored = await provider.rerank(
        question,
        await refreshed_candidates(),
        top_n=top_n,
        refresh=refreshed_candidates,
    )
    # The mapping is rebuilt from the same gate rather than captured before the call,
    # because the adapter may have re-read the rows during a retry. Reading it separately
    # would be a third read that could disagree with the ones the provider saw.
    by_id = {hit.chunk.chunk_id: hit for hit in await refresh()}

    # The egress gate runs again on the way back. A candidate that was allowed when it
    # was sent and revoked while the provider was thinking has been transmitted already,
    # so this cannot undo the egress; what it does guarantee is that the ranking the
    # caller receives never names a chunk it may no longer read. Part 11's final gate
    # in ``retrieve`` is what closes the delivery side.
    after = await store.read_ranked_chunks(
        session, actor, chunk_ids=[scored.chunk_id for scored in scored]
    )

    reordered: list[RetrievalHit] = []
    for candidate in scored:
        hit = by_id.get(candidate.chunk_id)
        if hit is None or candidate.chunk_id not in after:
            continue
        reordered.append(hit.with_rerank_score(candidate.score))
    return reordered
