"""``retrieve``: one authorized question in, ranked authorized chunks out.

The order of operations is fixed by ARCHITECTURE.md section 6 and DATABASE.md
section 5, and each step exists for a reason that is not obvious from its name:

1. the question is normalized **once**, and that one string goes to both the
   provider and BM25, so the two paths cannot be searching for different things;
2. an empty question short-circuits, so no pointless provider call is made;
3. the eligible domain is read and the question embedded **concurrently** - the two
   are independent, and both are the expensive part of a request;
4. the index is checked against the provider that just answered, so a stale or
   mixed index fails closed *before* anything is ranked;
5. BM25 and an exact pgvector scan rank the same eligible chunks, each capped at
   its own ``top_k``, and the two rank lists are fused with RRF;
6. the fused candidates are **re-read under the allowlist** and only those that are
   still eligible and match the query provider are returned.

Step 6 is not redundancy. Ranking happens over a snapshot read earlier in the
request, and access can be narrowed, a document deleted, or a revision replaced
between that read and the response. Ranking does not unrank anything, so the last
read is where authorization is decided; without it a revoked document would still be
served from memory.

Both paths read the same allowlist, so neither can return a document the other
would refuse. There is no fallback path and no "if the vector search fails, use
lexical" branch: a failure here is a failure, because silently degrading would
change what a caller sees without telling it (ARCHITECTURE.md section 6).
"""

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from app.documents.normalize import normalize_for_search
from app.domain.models import Actor
from app.providers.base import RerankProvider, VectorProvider
from app.retrieval import store
from app.retrieval.contracts import IndexProvenance, RetrievalConfig, RetrievalHit
from app.retrieval.fusion import as_rank_maps, fuse, order_by_score
from app.retrieval.lexical import lexical_ranking
from app.retrieval.rerank import RerankUnavailableError, rerank_hits


async def retrieve(
    session: AsyncSession,
    *,
    actor: Actor,
    question: str,
    config: RetrievalConfig,
    provider: VectorProvider,
    rerank_provider: RerankProvider | None = None,
) -> list[RetrievalHit]:
    """Return the best authorized chunks for ``question``, best first.

    ``actor.role`` is the only thing that decides membership, and it comes from the
    server-side session row. Nothing in the question, the configuration or the
    provider can widen it.

    ``question`` is the caller's text as typed; it is normalized here and the raw
    form is not used for ranking. Callers keep their own copy for display or for
    quoting back to the user.

    ``rerank_provider`` is consulted only when ``config.rerank_enabled`` is true, and
    it is passed in rather than constructed here so a disabled rerank performs **zero**
    provider work: no client, no adapter, no request. When enabled it runs after fusion
    and before the final cut, so the reranker sees the fused ranking rather than a
    pre-truncated one.
    """
    search_text = normalize_for_search(question)
    if not search_text:
        return []

    # A TaskGroup rather than ``asyncio.gather``: gather returns the first exception
    # and leaves the sibling running, so a provider failure would orphan a database
    # read that is still in flight when the caller tears the session down. The
    # failure the operator sees would then be a connection error instead of the
    # provider error, which is both a worse message and a misleading one. The
    # TaskGroup cancels the sibling and waits for it to finish unwinding, so one
    # session is never in use after ``retrieve`` has raised.
    chunks, embedding = await _read_domain_and_embed(session, actor, provider, search_text)
    if not chunks:
        return []

    # The provider has now verified its live digest, which is what the index is
    # compared against. Checking here rather than before the embed is what makes the
    # comparison possible at all; checking before either path ranks is what makes it
    # mean anything.
    expected = IndexProvenance(
        provider=provider.provider_name,
        model=provider.model,
        digest=provider.last_digest,
        dimension=provider.dimension,
    )
    await store.assert_index_consistent(session, actor, expected=expected)
    store.assert_chunks_consistent(chunks, expected=expected)

    lexical = lexical_ranking(chunks, search_text, top_k=config.lexical_top_k)
    vector_rows = await store.vector_candidates(
        session, actor, embedding=embedding, top_k=config.vector_top_k
    )

    # Each read has its own snapshot; validate the rows actually ranked.
    store.assert_chunks_consistent(vector_rows, expected=expected)

    fused = fuse(
        as_rank_maps(lexical),
        {row.chunk_id: rank for rank, row in enumerate(vector_rows, start=1)},
        rrf_k=config.rrf_k,
    )

    # How many survive fusion is decided here, before the final cut, because that is
    # the number the reranker may see. Disabled, it is the final size and the rerank
    # branch below is never reached; enabled, it is the reranker's cap and the final
    # cut happens again after it. Reading it as one variable keeps the two branches
    # from drifting apart.
    candidate_limit = config.rerank_top_k if config.rerank_enabled else config.final_top_k
    ordered = order_by_score(fused, limit=candidate_limit)

    # The authorization gate. Anything that no longer qualifies is dropped here and is
    # never returned, rather than being returned from the earlier snapshot.
    fresh = await store.read_ranked_chunks(
        session, actor, chunk_ids=[chunk_id for chunk_id, _ in ordered]
    )

    store.assert_chunks_consistent(fresh.values(), expected=expected)

    candidates: list[RetrievalHit] = []
    for chunk_id, (lexical_rank, vector_rank, score) in ordered:
        chunk = fresh.get(chunk_id)
        if chunk is None:
            continue
        candidates.append(
            RetrievalHit(
                chunk=chunk.to_record(),
                lexical_rank=lexical_rank,
                vector_rank=vector_rank,
                fused_score=score,
            )
        )

    if config.rerank_enabled:
        if rerank_provider is None:
            # An enabled rerank with no provider is a wiring mistake, not a degraded
            # mode. Falling back to the fused order would silently serve a ranking that
            # was never reranked, while every downstream report claimed reranking.
            raise RerankUnavailableError("reranking is enabled but no rerank provider was given")
        candidates = await rerank_hits(
            session,
            actor=actor,
            question=search_text,
            hits=candidates,
            provider=rerank_provider,
            top_n=config.rerank_top_k,
            expected=expected,
        )

    # The final cut, applied after reranking so the reranker chooses which five survive.
    hits = candidates[: config.final_top_k]

    # The delivery gate, and the only one that runs after reranking. ``rerank_hits``
    # already re-checked on its way back, but this runs on the rows that will actually
    # be returned, so the guarantee does not depend on which branch produced them.
    delivered = await store.read_ranked_chunks(
        session, actor, chunk_ids=[hit.chunk.chunk_id for hit in hits]
    )
    store.assert_chunks_consistent(delivered.values(), expected=expected)
    # A hit that no longer passes the allowlist is dropped rather than returned. The
    # list comprehension keeps the reranked order, because ``delivered`` is a mapping.
    return [hit for hit in hits if hit.chunk.chunk_id in delivered]


async def _read_domain_and_embed(
    session: AsyncSession, actor: Actor, provider: VectorProvider, search_text: str
) -> tuple[list[store.EligibleChunk], list[float]]:
    """Read the eligible domain and embed the question at the same time.

    A ``TaskGroup`` rather than ``asyncio.gather``, and that choice is the point of
    this function. ``gather`` returns the first exception and leaves its sibling
    running, so a provider failure would orphan a database read that is still in
    flight when the caller tears the session down. The failure the operator would
    then see is a connection error rather than the provider error, which is a worse
    message and a misleading one. The ``TaskGroup`` cancels the sibling and waits
    for it to unwind, so the session is never in use after this has raised.
    """
    domain: list[store.EligibleChunk] = []
    embedded: list[list[float]] = []

    async def read_domain() -> None:
        domain.extend(await store.read_eligible_chunks(session, actor))

    async def embed_query() -> None:
        embedded.append(await provider.embed_query(search_text))

    try:
        async with asyncio.TaskGroup() as group:
            group.create_task(read_domain())
            group.create_task(embed_query())
    except BaseExceptionGroup as group_error:
        # A TaskGroup raises the *group*, not the failure. Left wrapped, a caller
        # could not tell a provider refusal from a database fault by type, so every
        # handler that classifies failures - the worker's, the CLI's - would silently
        # stop matching. Unwrapping restores the original exception type.
        raise _first_failure(group_error) from None

    # Both tasks appended exactly once, or the group raised, so indexing is safe.
    return domain, embedded[0]


def _first_failure(group_error: BaseExceptionGroup[BaseException]) -> BaseException:
    """Return the failure worth raising from a task group.

    Cancellation is not a failure to report: it is how the group stops the sibling
    after the first real error, and it is what the raising task was cancelled with.
    """
    failures = [
        error for error in _flatten(group_error) if not isinstance(error, asyncio.CancelledError)
    ]
    if not failures:
        return group_error
    return failures[0]


def _flatten(error: BaseExceptionGroup[BaseException]) -> list[BaseException]:
    """Every leaf exception in a group, including those in nested groups."""
    leaves: list[BaseException] = []
    for nested in error.exceptions:
        if isinstance(nested, BaseExceptionGroup):
            leaves.extend(_flatten(nested))
        else:
            leaves.append(nested)
    return leaves
