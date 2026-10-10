"""Public routes for the authorized document list and source sections.

Two endpoints, one concern: a caller must not be able to tell *why* something was refused.
There are three reasons a source read can refuse - the document does not exist, the actor
may not read it, or the revision asked for is no longer current - and a caller who can tell
them apart can walk the corpus one probe at a time and learn the catalogue. So the refusals
are one status and one body, and the store is built so it cannot report which case it hit.

The 404 wording is therefore load-bearing rather than incidental. It says "not found" and
nothing about access, because that is the only string true of all three cases. A body
reading "forbidden" would tell an employee that a managers' document exists, which is the
exact leak the rest of this project is arranged to prevent.

The id shapes are allowlists, measured against this deployment rather than guessed. Every
revision the corpus has ever held is a UUID, so ``revision`` carries that shape. Section ids
come in two forms - the corpus import preserves ``HR-001-S1`` while an uploaded document
gets bare ``S0``, ``S1`` - and a pattern admitting only one would break half the corpus.

**On the Origin check, which does not happen here for reads.** ``enforce_origin`` skips safe
methods, so a cross-site ``GET`` of a document or a source is served, and this module does
not pretend otherwise. That is only safe because three other things close it: the response
carries no CORS grant, so a browser will not hand the body to the requesting script; the web
proxy refuses a foreign origin before forwarding; and the session cookie is ``SameSite=Lax``,
so a cross-site request arrives without it and the route answers 401. The unsafe methods are
where this API enforces Origin itself, and ``POST /api/answers`` - whose every call costs a
third party - is checked in its own route.

If a CORS middleware is ever added, that arrangement stops holding, and the test that asserts
the absence of ``Access-Control-Allow-Origin`` is the one that should fail.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Path,
    Query,
    Request,
    Response,
    status,
)
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncEngine

from app.api.auth import get_engine, get_session_factory, get_settings
from app.auth import service as auth_service
from app.auth.origin import OriginRejectedError, enforce_origin
from app.domain.models import Actor
from app.retrieval import store as retrieval_store
from app.settings import Settings

router = APIRouter(prefix="/api", tags=["documents"])

#: One wording for every refusal. See the module docstring: a body that distinguishes
#: forbidden from absent is the leak.
NOT_FOUND = "not found"
UNAUTHENTICATED = "authentication required"
ORIGIN_REJECTED = "request origin is not allowed"

#: An authorized read must never be stored by an intermediary: the next reader would be
#: handed it, and being a different user is reason enough.
NO_STORE_HEADERS = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}

_DOCUMENT_ID = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"
_SECTION_ID = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$"
_REVISION = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


class DocumentSummaryResponse(BaseModel):
    """One authorized document, as the list serves it."""

    document_id: str
    title: str
    access_role: str
    revision: str


class DocumentListResponse(BaseModel):
    """The caller's own documents.

    No pagination: ingestion caps active documents, so this is a catalogue of a bounded
    number of rows rather than a growing feed, and a page size here would be a fiction.
    """

    documents: list[DocumentSummaryResponse]


class SourceResponse(BaseModel):
    """One section's verbatim text.

    ``text`` is the ingested string, not the normalized derivation retrieval searches with.
    A reader compares a claim's quote against this, so it has to be what the document holds.
    """

    document_id: str
    section_id: str
    revision: str
    title: str
    heading_path: list[str]
    text: str


def _reject_unknown_query_parameters(request: Request) -> None:
    """Refuse a query parameter this route does not serve.

    FastAPI ignores a parameter it does not declare, so ``?debug=1`` or ``?role=manager``
    would pass through silently. Ignoring them is not itself a hole - an unknown parameter
    grants nothing - but a parameter that looks like a filter and does nothing is worse than
    one that is refused, because a caller would reasonably believe it had an effect.
    """
    unexpected = sorted(set(request.query_params) - {"revision"})
    if unexpected:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="unsupported query parameter",
        )


async def _require_actor(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> Actor:
    """Resolve the session cookie into an actor, or refuse.

    Origin first, as on every other route that reads on a user's behalf. The role comes from
    the ``users`` row and from nowhere else, so nothing in the request can widen it - a
    question, a header or a body field has no way in.
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


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    request: Request,
    actor: Annotated[Actor, Depends(_require_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
) -> DocumentListResponse:
    """Return every document this actor may cite, and nothing else.

    Scoped by the same allowlist retrieval uses, so an inactive, unpublished or not-yet-ready
    document is simply absent. That is what keeps a just-uploaded file out of a user's list
    before its text exists to show.
    """
    response.headers.update(NO_STORE_HEADERS)
    _reject_unknown_query_parameters(request)
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        listed = await retrieval_store.list_retrievable_documents(session, actor)
    return DocumentListResponse(
        documents=[
            DocumentSummaryResponse(
                document_id=row.document_id,
                title=row.title,
                access_role=row.access_role,
                revision=row.revision,
            )
            for row in listed
        ]
    )


@router.get("/sources/{document_id}/sections/{section_id}", response_model=SourceResponse)
async def read_source_section(
    request: Request,
    document_id: Annotated[str, Path(pattern=_DOCUMENT_ID)],
    section_id: Annotated[str, Path(pattern=_SECTION_ID)],
    revision: Annotated[str, Query(pattern=_REVISION)],
    actor: Annotated[Actor, Depends(_require_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
) -> SourceResponse:
    """Return one section's text, or refuse identically for every reason.

    One statement carries the authorization and the staleness conditions together, so this
    function has no branch that could tell a forbidden document from a replaced one. The
    404 is the same body in all three cases.
    """
    response.headers.update(NO_STORE_HEADERS)
    _reject_unknown_query_parameters(request)
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        found = await retrieval_store.read_source_section(
            session,
            actor,
            document_id=document_id,
            section_id=section_id,
            revision=revision,
        )
    if found is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=NOT_FOUND)
    return SourceResponse(
        document_id=found.document_id,
        section_id=found.section_id,
        revision=found.revision,
        title=found.title,
        heading_path=list(found.heading_path),
        text=found.source_text,
    )
