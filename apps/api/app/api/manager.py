"""Manager routes for document upload and processing state.

Three routes only, matching what ``plans.md`` assigns to Part 8: create a
document, list processing state, and read one job's state. Replacement and
deletion belong to Part 10 and are deliberately absent, so a caller cannot reach
a code path that does not exist yet.

Authorization is resolved server-side from the session cookie. There is no
parameter anywhere in this module that could carry a role, and the store refuses a
non-manager actor as well, so hiding a control in the UI is never the only
protection.
"""

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncEngine
from starlette.datastructures import FormData
from starlette.datastructures import UploadFile as StarletteUploadFile

from app.api.auth import get_engine, get_session_factory, get_settings
from app.api.upload_guard import MAX_FILENAME_CHARS
from app.auth import service as auth_service
from app.auth.origin import OriginRejectedError, enforce_origin
from app.domain.models import ROLES, Actor
from app.ingestion import store
from app.ingestion.contracts import UploadInput, UploadRejectedError
from app.ingestion.limits import decode_utf8, read_capped, validate_suffix
from app.settings import Settings

router = APIRouter(prefix="/api/manager", tags=["manager"])

# The one path guarded by UploadGuard; kept here so main.py and the router
# cannot drift apart.
UPLOAD_PATH = "/api/manager/documents"

ORIGIN_REJECTED = "request origin is not allowed"
UPLOAD_REJECTED = "upload rejected"
FORBIDDEN = "manager role required"
# One public message for both an unknown job and one the caller may not see, so
# the endpoint cannot be used to probe which job ids exist.
JOB_NOT_FOUND = "job not found"

# Read at most this much from the request body plus one byte, so an oversized
# upload is refused without buffering the whole thing.
_READ_SLACK = 1

# Matches the ceiling ``UploadInput.normalized_title`` enforces.
MAX_TITLE_CHARS = 300


class JobResponse(BaseModel):
    """Non-sensitive processing state of one upload."""

    job_id: str
    document_id: str
    revision: str
    status: str
    attempt: int
    safe_error: str | None
    created_at: str
    finished_at: str | None


class DocumentSummaryResponse(BaseModel):
    """One row of the manager document list."""

    document_id: str
    title: str
    access_role: str
    version: str
    content_status: str
    processing_status: str
    updated_at: str


class DocumentListResponse(BaseModel):
    """The manager's view of every document and its processing state."""

    documents: list[DocumentSummaryResponse]


def _job_response(view: Any) -> JobResponse:
    return JobResponse(
        job_id=str(view.job_id),
        document_id=view.document_id,
        revision=view.revision,
        status=view.status,
        attempt=view.attempt,
        safe_error=view.safe_error,
        created_at=view.created_at.isoformat(),
        finished_at=None if view.finished_at is None else view.finished_at.isoformat(),
    )


async def _require_manager(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> Actor:
    """Resolve the session cookie into a manager actor, or refuse the request.

    The Origin check runs first: a browser attaches Origin to a cross-site
    request, so refusing it stops a malicious page from driving this endpoint with
    the manager's cookie.
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
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required"
        )
    if actor.role != "manager":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN)
    return actor


def _required_field(form: FormData, name: str) -> str:
    """Return a required text field, or refuse.

    A missing field must not silently become an empty string: an empty
    ``access_role`` would have to be treated as a missing policy, and an empty
    ``title`` would have to be treated as a blank one.
    """
    value = form.get(name)
    if not isinstance(value, str) or not value.strip():
        raise UploadRejectedError(f"{name} is required")
    return value


def _single_upload(form: FormData) -> StarletteUploadFile:
    """Return the one uploaded file, refusing a missing or multiple file parts.

    Exactly one file is accepted so the body ceiling stays meaningful: several
    parts could otherwise sit under the cap while still multiplying the work.
    """
    uploads = [value for value in form.values() if isinstance(value, StarletteUploadFile)]
    if not uploads:
        raise UploadRejectedError("a file part is required")
    if len(uploads) > 1:
        raise UploadRejectedError("exactly one file may be uploaded")
    upload = uploads[0]
    if upload.filename is not None and len(upload.filename) > MAX_FILENAME_CHARS:
        raise UploadRejectedError("filename is too long")
    return upload


async def _close_form(form: FormData) -> None:
    """Close every file part so a temporary spooled file is released."""
    for value in form.values():
        if isinstance(value, StarletteUploadFile):
            await value.close()


def _reject(error: UploadRejectedError) -> HTTPException:
    """Turn a rejection into a 400 carrying only the stable safe code."""
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"{UPLOAD_REJECTED}: {error.safe_code}",
    )


@router.get("/documents", response_model=DocumentListResponse)
async def list_documents(
    request: Request,
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> DocumentListResponse:
    """Return every document with its processing state.

    ``content_status`` and ``processing_status`` are reported separately so a
    document that has been staged but not yet activated is never presented as
    available content.
    """
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            summaries = await store.list_documents(session, actor=actor)
        except UploadRejectedError as error:
            raise _reject(error) from error
    return DocumentListResponse(
        documents=[
            DocumentSummaryResponse(
                document_id=summary.document_id,
                title=summary.title,
                access_role=summary.access_role,
                version=summary.version,
                content_status=summary.content_status,
                processing_status=summary.processing_status,
                updated_at=summary.updated_at.isoformat(),
            )
            for summary in summaries
        ]
    )


@router.post(
    "/documents",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def upload_document(
    request: Request,
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> JobResponse:
    """Stage one document and return its job.

    Returns 202: the document exists and its text is stored, but nothing about it
    is retrievable until a worker activates a revision. The response deliberately
    omits the document text, the job's staging text, and any provider detail.

    The multipart body is parsed here, by hand, rather than through declared
    ``Form``/``File`` parameters. FastAPI parses the whole body *before* it runs any
    dependency, so a declared file parameter means a 2 MiB body is buffered before
    the Origin and manager checks above have run. Parsing after ``_require_manager``
    has already refused a bad Origin or a non-manager means the expensive parse
    never happens for a request that was going to be rejected anyway
    (Part 8 review, P1).
    """
    try:
        form = await request.form()
    except UploadRejectedError as error:
        raise _reject(error) from error

    try:
        title = _required_field(form, "title")
        access_role = _required_field(form, "access_role")
        upload = _single_upload(form)

        if len(title) > MAX_TITLE_CHARS:
            raise UploadRejectedError("title is too long")
        # The role is narrowed against the server-side allowlist before anything is
        # written; an unknown value is refused rather than defaulted to public.
        if access_role not in ROLES:
            raise UploadRejectedError("access_role must be employee or manager")

        raw = await upload.read(settings.upload_max_bytes + _READ_SLACK)
        read_capped(raw, max_bytes=settings.upload_max_bytes)
        validate_suffix(upload.filename)
        text = decode_utf8(raw)
        # ROLES was checked above, so this is a genuine Role, not a guess.
        metadata = UploadInput(title=title, access_role=access_role)
    except UploadRejectedError as error:
        raise _reject(error) from error
    finally:
        await _close_form(form)

    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            job = await store.stage_upload(
                session,
                actor=actor,
                text_body=text,
                metadata=metadata,
                max_active_documents=settings.upload_max_active_documents,
            )
        except UploadRejectedError as error:
            raise _reject(error) from error
    return _job_response(job)


@router.get("/jobs/{job_id}", response_model=JobResponse)
async def read_job(
    request: Request,
    job_id: uuid.UUID,
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> JobResponse:
    """Return one job's processing state.

    An unknown job and a job the caller may not see both return 404 with the same
    message, so the endpoint cannot enumerate job ids.
    """
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            view = await store.read_job(session, actor=actor, job_id=job_id)
        except UploadRejectedError as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN) from error
    if view is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=JOB_NOT_FOUND)
    return _job_response(view)


__all__ = ["router"]
