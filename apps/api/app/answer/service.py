"""The answer path: retrieval, generation, and the checks that make claims serveable.

``answer`` is the service Part 15's route will call, and it is where Part 13's generation
adapter becomes something a user can be shown. Five checks stand between a model and a
served answer, and each exists because a plausible-looking wrong outcome is available
without it.

1. **Evidence comes from the allowlist, never from a caller-supplied list.** The service
   calls ``retrieve`` itself. A seam that let a caller hand over passages would make
   every check below decorative.
2. **Handles are assigned once, from the retrieval order.** ``E1``, ``E2``, ... A handle
   that shifted position after an access change would quietly come to mean a different
   passage, and a claim citing it would resolve to the wrong document. So the numbering
   is fixed before the first send and never recomputed.
3. **Every attempt re-runs the gate.** The generation adapter calls ``refresh`` before
   each attempt, and the function passed here is the same one the final gate uses. A
   retry after a backoff is a later moment than the last check, so a narrowing that
   landed during the wait must stop the second attempt, not just the first.
4. **The final gate runs after generation, before anything is served.** This is the check
   Part 14 adds. ``technical-details.md``'s review focus asks for it by name: a role
   narrowing, a deletion or a revision replacement landing *concurrently with generation*
   must not deliver the old answer. The window is real and unavoidable - the provider call
   takes seconds - so the answer is refused when a cited passage is no longer authorized
   at delivery time.
5. **The quote is matched against the text the final gate read.** The ordering is load
   bearing. Gating first and validating second proves the citation against text that was
   authorized at the last possible moment, with no separate identity check needed. The
   other order would have to assert the re-read text was unchanged, which is a claim
   about a table rather than a guarantee about a string.

The re-read also settles what happens when a passage changes: ``read_ranked_chunks``
requires ``revision = current_revision``, so a replacement makes the old rows simply
absent rather than returning new text under old ranking. That is why there is no "compare
the text and hope" branch here - a replacement cannot produce a silent mismatch, only an
absence.

The served prose is the model's synthesis. Claims and citations still pass the grounding
checks below, but those checks do not prove that every sentence in the synthesis follows
from its citations; ``evaluation-guide.md`` scores that by human review.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.answer.compose import compose_answer
from app.answer.schemas import (
    AnswerConfig,
    AnswerResult,
    AuthorizedEvidence,
    InvalidGeneration,
    InvalidReason,
    ValidatedClaims,
)
from app.answer.validate import validate_generation
from app.domain.models import Actor
from app.providers.base import (
    MAX_CONVERSATION_TURNS,
    ConversationTurn,
    EvidenceItem,
    GenerationProvider,
    MissingPart,
    ProviderUsage,
    RerankProvider,
    VectorProvider,
)
from app.providers.generation import GenerationEvidenceError
from app.retrieval import store as retrieval_store
from app.retrieval.contracts import IndexProvenance, SourceRef
from app.retrieval.service import retrieve

#: The reason used whenever the service refuses on its own, without a generation to
#: validate: nothing was authorized to answer from.
_NO_EVIDENCE: tuple[MissingPart, ...] = ("insufficient_evidence",)


async def answer(
    factory: async_sessionmaker[AsyncSession],
    *,
    actor: Actor,
    question: str,
    config: AnswerConfig,
    vector_provider: VectorProvider,
    generator: GenerationProvider,
    rerank_provider: RerankProvider | None = None,
    history: Sequence[ConversationTurn] = (),
) -> AnswerResult:
    """Answer ``question`` for ``actor`` from documents that actor may read.

    Takes a session *factory* rather than a session because the authorization gate runs
    more than once, and each of those reads has to be its own transaction. A session held
    open across a multi-second provider call would pin a snapshot the gate is supposed to
    move past, which would turn a revocation into a stale answer.

    The provider and generator are passed in rather than constructed here, matching how
    reranking is passed into ``retrieve``: a caller with no generator never builds one,
    and a test can drive the whole path without a network.

    Raises :class:`~app.answer.schemas.InvalidGeneration` when a generation cannot be
    believed or a cited passage was revoked in the delivery window. A *refusal* - no hits,
    or nothing left to send - is returned, not raised: those are answers the product owes
    the reader, and the generation provider's own failures propagate, because a guessed
    answer is never the fallback.
    """
    async with factory() as session:
        hits = await retrieve(
            session,
            actor=actor,
            question=question,
            config=config.retrieval,
            provider=vector_provider,
            rerank_provider=rerank_provider,
        )

    rerank_usages = _provider_usages(rerank_provider)
    if not hits:
        # No provider work at all. Nothing was retrieved, so there is nothing to ask
        # about, and spending an attempt would buy a refusal already known.
        return _abstained(usages=rerank_usages)

    # Numbered once, from the retrieval order, and never recomputed. See the module
    # docstring: a handle that shifts would come to mean a different passage.
    offered = list(enumerate(hits[: config.max_sources], start=1))
    expected = IndexProvenance(
        provider=vector_provider.provider_name,
        model=vector_provider.model,
        digest=vector_provider.last_digest,
        dimension=vector_provider.dimension,
    )

    async def authorized() -> dict[str, AuthorizedEvidence]:
        """Read every offered passage under the allowlist, right now.

        One function serves both the per-attempt gate and the final gate, so the two
        cannot drift apart. A second copy of this check is a second thing to forget to
        update, and the copy nobody updates is the one that leaks.

        A fresh session per read, deliberately. Holding one across the provider call would
        serve a snapshot, which is the opposite of what a final check is for.
        """
        async with factory() as gate:
            rows = await retrieval_store.read_ranked_chunks(
                gate, actor, chunk_ids=[hit.chunk.chunk_id for _, hit in offered]
            )
        retrieval_store.assert_chunks_consistent(rows.values(), expected=expected)

        found: dict[str, AuthorizedEvidence] = {}
        for position, hit in offered:
            row = rows.get(hit.chunk.chunk_id)
            if row is not None:
                found[f"E{position}"] = _evidence(f"E{position}", row.to_record())
        return found

    evidence = await authorized()
    if not evidence:
        # Every passage was revoked between the ranking and the send. An honest refusal
        # that costs nothing, which is why the generation adapter is never reached.
        return _abstained(usages=rerank_usages)

    sent_history: list[ConversationTurn] = []
    try:
        result = await generator.generate(
            question=question,
            evidence=[_item(item) for item in evidence.values()],
            refresh=_as_refresh(authorized),
            history=list(history[-MAX_CONVERSATION_TURNS:]),
            refresh_history=(
                _as_history_refresh(
                    factory,
                    actor,
                    history[-MAX_CONVERSATION_TURNS:],
                    observed=sent_history,
                )
                if history
                else None
            ),
        )
    except GenerationEvidenceError:
        # The adapter's own "nothing authorized is left to send", raised from inside its
        # attempt loop when a later refresh came back empty. A refusal, and it may still
        # have cost an earlier attempt, so the usage is carried out rather than dropped.
        return _abstained(generator.last_usage, rerank_usages + _provider_usages(generator))

    if sent_history and await _authorized_history(factory, actor, sent_history) != sent_history:
        # A previous answer may have been revoked while the provider was generating.
        # Do not deliver a new answer that could have relied on that withdrawn context.
        raise InvalidGeneration(InvalidReason.EVIDENCE_REVOKED)

    # The final gate. Everything above authorized the *evidence*; this authorizes the
    # *delivery*, which is a later moment and the only one the reader cares about.
    delivered = await authorized()

    # Only handles that were *offered* can be revoked. One the model invented is also
    # absent from ``delivered``, but calling that a revocation would tell an operator a
    # real document had closed when the truth was that the model fabricated a handle -
    # sending them to the access log instead of to the prompt. Invented handles fall
    # through to ``validate_generation``, which names them for what they are.
    cited = {claim.evidence_id for claim in result.claims}
    offered_handles = {f"E{position}" for position, _ in offered}
    revoked = sorted(
        handle for handle in cited if handle in offered_handles and handle not in delivered
    )
    if revoked:
        raise InvalidGeneration(InvalidReason.EVIDENCE_REVOKED, handle=revoked[0])

    # Filtered rather than indexed: an invented handle must be *missing* from this
    # mapping, because that absence is what ``validate_generation`` reports as a handle
    # that was never offered. Indexing it would raise ``KeyError`` out of the service
    # instead, naming nothing.
    validated = validate_generation(
        result, {handle: delivered[handle] for handle in cited if handle in delivered}
    )
    return AnswerResult(
        answer=compose_answer(
            validated.claims,
            validated.missing_parts,
            validated.abstained,
            result.answer,
        ),
        claims=validated.claims,
        sources=validated.sources,
        abstained=validated.abstained,
        missing_parts=validated.missing_parts,
        usage=generator.last_usage,
        usages=rerank_usages + _provider_usages(generator),
    )


def _evidence(handle: str, record: object) -> AuthorizedEvidence:
    """Pair a passage with the citation it resolves to.

    The ``SourceRef`` is built from the row that was *just* authorized, not from the
    ranking hit. Those can differ - a hit carries the text as ranked, this carries the
    text as permitted now - and the citation has to name the second one.
    """
    return AuthorizedEvidence(
        handle=handle,
        text=record.text,  # type: ignore[attr-defined]
        source=SourceRef(
            document_id=record.document_id,  # type: ignore[attr-defined]
            section_id=record.section_id,  # type: ignore[attr-defined]
            revision=record.revision,  # type: ignore[attr-defined]
        ),
    )


def _item(item: AuthorizedEvidence) -> EvidenceItem:
    return EvidenceItem(evidence_id=item.handle, text=item.text)


def _as_history_refresh(
    factory: async_sessionmaker[AsyncSession],
    actor: Actor,
    history: Sequence[ConversationTurn],
    *,
    observed: list[ConversationTurn] | None = None,
) -> Callable[[], Awaitable[list[ConversationTurn]]]:
    """Recheck every cited source immediately before each provider attempt.

    A prior response can be context only while every source it cites is still readable
    at the same revision. Refusals have no source text and remain safe context.
    """

    async def refresh() -> list[ConversationTurn]:
        current = await _authorized_history(factory, actor, history)
        if observed is not None:
            observed[:] = current
        return current

    return refresh


async def _authorized_history(
    factory: async_sessionmaker[AsyncSession],
    actor: Actor,
    history: Sequence[ConversationTurn],
) -> list[ConversationTurn]:
    current: list[ConversationTurn] = []
    async with factory() as session:
        for turn in history:
            valid = True
            for source in turn.sources:
                found = await retrieval_store.read_source_section(
                    session,
                    actor,
                    document_id=source.document_id,
                    section_id=source.section_id,
                    revision=source.revision,
                )
                if found is None:
                    valid = False
                    break
            if valid:
                current.append(turn)
    return current


def _as_refresh(
    authorized: Callable[[], Awaitable[dict[str, AuthorizedEvidence]]],
) -> Callable[[], Awaitable[list[EvidenceItem]]]:
    """Adapt the gate to the adapter's refresh hook.

    The empty case raises rather than returning ``[]``: an empty list would tell the
    adapter to build a request from nothing, and ``GenerationEvidenceError`` is the signal
    Part 13 established for "there is nothing authorized left to send". The adapter
    treats it as non-retryable, which is right - a repair would ask the model again with
    evidence the caller may no longer send.
    """

    async def refresh() -> list[EvidenceItem]:
        current = await authorized()
        if not current:
            raise GenerationEvidenceError("no authorized evidence remains")
        return [_item(item) for item in current.values()]

    return refresh


def _provider_usages(provider: GenerationProvider | RerankProvider | None) -> list[ProviderUsage]:
    if provider is None:
        return []
    return list(
        getattr(provider, "last_usages", None)
        or ([provider.last_usage] if provider.last_usage else [])
    )


def _abstained(
    usage: ProviderUsage | None = None, usages: list[ProviderUsage] | None = None
) -> AnswerResult:
    """The safe refusal, carrying whatever the attempt cost.

    The text comes from the same ``compose_answer`` an answer would use, so the refusal a
    reader sees is not a special case with its own wording.
    """
    empty = ValidatedClaims(claims=[], abstained=True, missing_parts=list(_NO_EVIDENCE))
    return AnswerResult(
        answer=compose_answer(empty.claims, empty.missing_parts, empty.abstained),
        claims=[],
        sources=[],
        abstained=True,
        missing_parts=empty.missing_parts,
        usage=usage,
        usages=usages or [],
    )
