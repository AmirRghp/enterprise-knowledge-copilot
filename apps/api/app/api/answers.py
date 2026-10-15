"""``POST /api/answers``: the answer path, served.

This is the first endpoint whose response body contains document text. Parts 11 to 14
deliberately printed none - a report's output ends up in terminals, tickets and bug
reports, and a claim's quote is the document rendered by a model. Here the text is the
product, so the boundary moves rather than disappearing: the text crosses in the **response
** and never in a log, a metric label or an error message (``CODE_STYLE.md`` section 9).

What the response carries is exactly the five keys ``technical-details.md`` fixes, no more.
Adding a field here is a contract change the moment a client exists, so the shape is
pinned by a test rather than left to drift:

* ``claims[].quote`` is the span Part 14 took **from the passage**, not the string the model
  sent. When the two differed the served citation is the document's own text, so a reader
  opening the source finds the quote there.
* ``claims[].source`` is a ``document_id``/``section_id``/``revision`` triple - the stable
  citation handle. The model's internal handle never leaves the service: it exists precisely
  so the model could not name a document.
* ``sources`` carries the same triples without a title. The UI already loads
  ``/api/documents`` for titles, and duplicating them here would be a second copy to keep in
  step.

Failures are visible and never guessed. A provider that refuses, a generation whose
citations cannot be validated, and a request that runs out of its budget all answer with a
fixed 502/504 and no detail - a user is not told which, because the difference between "the
model lied" and "the endpoint is down" is an operator's question and disclosing it to a
caller tells them about this deployment's reliability. The reason goes to the log with the
request id, never into the response body.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Annotated, Any, Final

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.answer.schemas import AnswerConfig, AnswerResult, InvalidGeneration
from app.answer.service import answer
from app.api.answer_rate_limit import AnswerRateLimiter
from app.api.auth import get_engine, get_session_factory, get_settings
from app.auth import service as auth_service
from app.auth.origin import OriginRejectedError, enforce_origin
from app.db.models import RateLimitSettings
from app.domain.models import Actor
from app.provider_config.contracts import ProviderConfigurationError
from app.providers.base import (
    MAX_CONVERSATION_TURNS,
    ConversationSource,
    ConversationTurn,
    EmbeddingProviderError,
    RerankProvider,
)
from app.providers.capacity import ProviderQueueFull, ProviderQueueTimeout
from app.providers.generation import (
    GenerationEvidenceError,
    GenerationProviderError,
    GenerationResponseError,
    build_generation_provider,
)
from app.providers.rerank import RerankProviderError, build_rerank_provider
from app.providers.retry import RetryableError
from app.retrieval.contracts import RetrievalConfig
from app.retrieval.store import (
    IndexProvenanceMismatchError,
    RetrievalDomainTooLargeError,
)
from app.settings import Settings
from app.system_prompts import PromptUnavailableError, effective_prompt

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["answers"])

#: Exported so ``main.py`` can register this path's body ceiling in the ASGI layer. FastAPI
#: parses the JSON body before any dependency runs, so a ceiling enforced on the request
#: model is enforced after the body has already been read in full.
ANSWERS_PATH = "/api/answers"

#: Fixed messages. Each is true of every failure it covers, because the one thing a caller
#: must not learn from an error is which part of the system is unhealthy.
UPSTREAM_UNAVAILABLE = "the answer could not be produced"
DEADLINE_EXCEEDED = "the answer took too long to produce"
RATE_LIMITED = "too many questions asked; try again shortly"
UNAUTHENTICATED = "authentication required"
ORIGIN_REJECTED = "request origin is not allowed"

#: The whole-request budget from the global constraints. Every layer underneath has its own
#: deadline - embedding and rerank ten seconds an attempt, generation thirty - and this is
#: the outer bound that says the request as a whole is over.
REQUEST_BUDGET_SECONDS: Final = 60.0

#: The question ceiling, from ``technical-details.md`` subject 6. Enforced by the request
#: model so an oversized question is refused before it reaches retrieval, let alone a
#: provider.
MAX_QUESTION_CHARS: Final = 2000


class HistorySource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str = Field(min_length=1, max_length=64)
    section_id: str = Field(min_length=1, max_length=128)
    revision: str = Field(min_length=1, max_length=64)


class HistoryTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    answer: str = Field(min_length=1)
    sources: list[HistorySource] = Field(default_factory=list, max_length=5)


class AnswerRequest(BaseModel):
    """Current question and its browser-session context.

    History is only context. Its cited sources are reauthorized in the service before each
    provider attempt; a body cannot supply a role, access filter or document evidence.
    """

    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    history: list[HistoryTurn] = Field(default_factory=list, max_length=MAX_CONVERSATION_TURNS)


class CitationResponse(BaseModel):
    """The stable citation handle: document, section, revision."""

    document_id: str
    section_id: str
    revision: str


class ClaimResponse(BaseModel):
    """One validated assertion and the passage span it rests on."""

    text: str
    quote: str
    source: CitationResponse


class AnswerResponse(BaseModel):
    """The served answer. Exactly these five keys - see the module docstring."""

    answer: str
    claims: list[ClaimResponse]
    sources: list[CitationResponse]
    abstained: bool
    request_id: str


def _citation(source: Any) -> CitationResponse:
    return CitationResponse(
        document_id=source.document_id, section_id=source.section_id, revision=source.revision
    )


def _response(result: AnswerResult, request_id: str) -> AnswerResponse:
    return AnswerResponse(
        answer=result.answer,
        claims=[
            ClaimResponse(text=claim.text, quote=claim.quote, source=_citation(claim.source))
            for claim in result.claims
        ],
        sources=[_citation(source) for source in result.sources],
        abstained=result.abstained,
        request_id=request_id,
    )


async def _require_actor(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> Actor:
    """Resolve the session cookie, or refuse before any provider is built.

    Origin first: this is the one endpoint whose cost falls on a third party, so a page on
    another site must not be able to make a user's browser drive it.
    """
    try:
        enforce_origin(request, settings)
    except OriginRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=ORIGIN_REJECTED
        ) from error

    factory = get_session_factory(request, get_engine(request))
    actor: Actor | None = await auth_service.resolve_actor(factory, ekc_session)  # type: ignore[arg-type]
    if actor is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=UNAUTHENTICATED)
    return actor


def _rerank_builder(settings: Settings, client: httpx.AsyncClient) -> Any:
    """Build the rerank adapter.

    A named seam rather than a direct call, so a test can swap the builder without
    replacing ``build_rerank_provider`` itself. The reason is asymmetric coverage: the error
    paths that matter here - a non-retryable upstream body, a missing API key - are properties
    of the *real* adapter's message building, so a test that stubs the factory proves nothing
    about them. A test that needs a counting stub overrides this one instead.
    """
    return build_rerank_provider(settings, client=client)


def _limit(request: Request) -> AnswerRateLimiter:
    """The process-wide limiter, built on first use.

    Process-local and therefore per instance, the same limitation ``LoginRateLimiter``
    carries and the same reason it is acceptable here: one API process serves this
    deployment. Two instances would make the budget ``limit x instances``, which weakens the
    guard rather than removing it, and the daily provider cap remains the real ceiling.
    """
    existing: AnswerRateLimiter | None = getattr(request.app.state, "answer_rate_limiter", None)
    if existing is not None:
        return existing
    limiter = AnswerRateLimiter(
        user_limit=6,
        window_seconds=60,
        max_keys=10_000,
    )
    request.app.state.answer_rate_limiter = limiter
    return limiter


@router.post("/answers", response_model=AnswerResponse)
async def post_answer(
    request: Request,
    payload: AnswerRequest,
    actor: Annotated[Actor, Depends(_require_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
) -> AnswerResponse:
    """Answer one question from the documents ``actor`` may read.

    The whole call runs under :data:`REQUEST_BUDGET_SECONDS`. Exceeding it is a failure with
    a fixed message, never a partially composed answer - a deadline that produced prose would
    be a guess, and this system does not guess.
    """
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    started = time.monotonic()
    request_id = str(uuid.uuid4())
    factory: async_sessionmaker[AsyncSession] = get_session_factory(request, engine)  # type: ignore[assignment]
    try:
        async with factory() as session:
            limits = await session.get(RateLimitSettings, True)
    except SQLAlchemyError:
        raise HTTPException(status_code=503, detail="rate limit settings unavailable") from None
    if limits is None:
        raise HTTPException(status_code=503, detail="rate limit settings unavailable")
    limiter = _limit(request)
    retry_after = limiter.retry_after(str(actor.user_id), limits.requests_per_user_per_minute)
    if retry_after is not None:
        # The seconds go in a header rather than the body: a client that reads them can pace
        # itself, and a client that ignores them learns nothing about other roles.
        request.state.retry_after = retry_after
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=RATE_LIMITED,
            headers={"Retry-After": str(retry_after)},
        )
    client: httpx.AsyncClient | None = None
    rerank_client: httpx.AsyncClient | None = None
    generator: Any = None
    rerank_provider: RerankProvider | None = None
    try:
        from app.cli.run_worker import attempt_timeout_seconds, build_provider
        from app.provider_config.runtime import bind_runtime, get_runtime
        from app.provider_config.transport import provider_client

        settings = await asyncio.wait_for(
            bind_runtime(settings, factory), timeout=REQUEST_BUDGET_SECONDS
        )
        runtime = get_runtime(settings)
        runtime.deadline = started + REQUEST_BUDGET_SECONDS
        runtime.capacity = request.app.state.provider_capacity
        await runtime.capacity.configure(
            limits.ollama_concurrency, limits.cloud_concurrency, limits.version
        )
        async with factory() as session:
            system_prompt = await asyncio.wait_for(
                effective_prompt(session),
                timeout=max(0.1, REQUEST_BUDGET_SECONDS - (time.monotonic() - started)),
            )
        client = provider_client(timeout=settings.generation_request_timeout)
        # The embedding provider borrows this same client, so one pool serves both calls
        # and one ``aclose`` below closes both. Built on its own it would open a pool the
        # route has no reference to and never closes (review P2).
        vector_provider = build_provider(
            settings,
            attempt_timeout=attempt_timeout_seconds(settings.ingestion_lease_seconds),
            client=client,
        )
        generator = build_generation_provider(settings, client=client, system_prompt=system_prompt)

        # Review P2: the route passed a bare ``RetrievalConfig()``, whose default leaves
        # reranking off, so ``RERANK_ENABLED`` had no effect on the only path a user takes.
        # Both branches are built from the setting, and only the enabled one constructs a
        # provider - a disabled rerank performs *zero* provider work, no client and no
        # request, which is the rule Part 12 settled.
        retrieval_config = RetrievalConfig(rerank_enabled=settings.rerank_enabled)
        if settings.rerank_enabled:
            rerank_client = provider_client(timeout=settings.generation_request_timeout)
            rerank_provider = _rerank_builder(settings, rerank_client)

        result = await asyncio.wait_for(
            answer(
                factory,
                actor=actor,
                question=payload.question,
                history=[
                    ConversationTurn(
                        question=turn.question,
                        answer=turn.answer,
                        sources=tuple(
                            ConversationSource(
                                document_id=source.document_id,
                                section_id=source.section_id,
                                revision=source.revision,
                            )
                            for source in turn.sources
                        ),
                    )
                    for turn in payload.history
                ],
                config=AnswerConfig(retrieval=retrieval_config),
                rerank_provider=rerank_provider,
                vector_provider=vector_provider,
                generator=generator,
            ),
            timeout=max(0, REQUEST_BUDGET_SECONDS - (time.monotonic() - started)),
        )
    except (ProviderConfigurationError, PromptUnavailableError):
        raise HTTPException(status_code=503, detail="provider configuration unavailable") from None
    except ProviderQueueFull:
        raise HTTPException(
            status_code=503, detail="سرویس مشغول است؛ کمی بعد دوباره تلاش کنید"
        ) from None
    except ProviderQueueTimeout:
        _log_failure(request_id, "provider_queue_timeout", actor, started, generator)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=DEADLINE_EXCEEDED
        ) from None
    except TimeoutError:
        # Provider work may already have been billed; the usage is still read below, and a
        # deadline that hid it would be the same silent loss Part 13's review found.
        _log_failure(request_id, "deadline_exceeded", actor, started, generator)
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT, detail=DEADLINE_EXCEEDED
        ) from None
    except (GenerationEvidenceError, GenerationResponseError, GenerationProviderError) as error:
        _log_failure(request_id, type(error).__name__, actor, started, generator)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=UPSTREAM_UNAVAILABLE
        ) from None
    except (
        EmbeddingProviderError,
        RetryableError,
        IndexProvenanceMismatchError,
        RetrievalDomainTooLargeError,
    ) as error:
        # Review P1. Retrieval embeds the question through the local provider, and that
        # adapter keeps up to 200 characters of the provider's message - because Ollama's
        # explains the failure, and because that service may echo the input back. Uncaught,
        # the user's question reached a traceback and a log, which ``CODE_STYLE.md`` section 9
        # forbids outright and which the question-logging rule in ``SECURITY.md`` exists to
        # prevent.
        #
        # Narrow on purpose: the provider's own error types, not ``Exception``. A blanket
        # catch would swallow a genuine bug into a generic 502 as well, and a handler that
        # hides everything is how a real defect survives a release. Only the type name is
        # recorded.
        _log_failure(request_id, f"retrieval:{type(error).__name__}", actor, started, generator)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=UPSTREAM_UNAVAILABLE
        ) from None
    except RerankProviderError as error:
        # Review P1. Two distinct leaks arrive here, and only the first was obvious.
        #
        # The obvious one: a non-retryable upstream status puts up to 200 characters of the
        # provider's own body in the message, because that text explains the failure. A
        # gateway that echoes the request - which this one can, since the request carries
        # authorized document text - would put a document passage into a traceback and a log.
        #
        # The less obvious one: ``build_rerank_provider`` raises this at construction for a
        # missing API key, inside the ``try`` but before any question is read. That is a
        # wiring error and a 502 is still the right answer to it, but it is raised *per
        # request* rather than at startup, so without this handler a deployment with
        # reranking enabled and no key produced a 500 traceback on the user's question.
        #
        # The transient path is already safe and stays that way: ``arun_with_retry`` re-raises
        # its own fixed message, and the adapter converts that into a message naming only the
        # attempt count. Neither carries provider text.
        #
        # Only the type name is recorded, for the same reason as the retrieval catch below.
        _log_failure(request_id, f"rerank:{type(error).__name__}", actor, started, generator)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=UPSTREAM_UNAVAILABLE
        ) from None
    except InvalidGeneration as error:
        # The model cited something it was never given, or quoted something the authorized
        # passage does not contain. Visible in the log, indistinguishable to the caller from
        # an outage - and deliberately so, because telling a user "your citation failed"
        # invites a retry that would produce another one.
        _log_failure(
            request_id, f"invalid_generation:{error.reason.value}", actor, started, generator
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=UPSTREAM_UNAVAILABLE
        ) from None
    finally:
        from app.providers.usage import usage_record

        for provider in (rerank_provider, generator):
            for usage in getattr(provider, "last_usages", []):
                logger.info(
                    "provider usage", extra={"request_id": request_id, **usage_record(usage)}
                )
        if client is not None:
            await client.aclose()
        if rerank_client is not None:
            await rerank_client.aclose()

    _log_success(request_id, actor, started, result)
    return _response(result, request_id)


def _log_success(request_id: str, actor: Actor, started: float, result: AnswerResult) -> None:
    """Record the shape of the run without a word of its content.

    Counts, flags, the role and the request id. Not the question, not the answer, not a
    quote, not the usage's provider-side detail - ``CODE_STYLE.md`` section 9, and the reason
    this endpoint's logs are as carefully bounded as its response body is not.
    """
    usage = result.usage
    logger.info(
        "answer served",
        extra={
            "request_id": request_id,
            "role": actor.role,
            "claims": len(result.claims),
            "sources": len(result.sources),
            "abstained": result.abstained,
            "missing_parts": list(result.missing_parts),
            "attempts": usage.attempts if usage is not None else None,
            "duration_ms": int((time.monotonic() - started) * 1000),
        },
    )


def _log_failure(
    request_id: str, reason: str, actor: Actor, started: float, generator: Any
) -> None:
    """Same shape as :func:`_log_success`, plus the reason and any billed usage."""
    usage = generator.last_usage if generator is not None else None
    logger.warning(
        "answer refused",
        extra={
            "request_id": request_id,
            "role": actor.role,
            "reason": reason,
            "attempts": usage.attempts if usage is not None else None,
            "duration_ms": int((time.monotonic() - started) * 1000),
        },
    )
