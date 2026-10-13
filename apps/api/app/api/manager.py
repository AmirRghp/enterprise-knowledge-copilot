"""Manager routes for the document lifecycle: create, replace, delete, and status.

Five routes, matching what ``plans.md`` assigns to Parts 8 and 10: create a
document, replace one, delete one, list processing state, and read one job's
state.

Authorization is resolved server-side from the session cookie. There is no
parameter anywhere in this module that could carry a role, and the store refuses a
non-manager actor as well, so hiding a control in the UI is never the only
protection.

Both write routes parse the multipart body by hand, after the Origin and manager
checks, and both go through the same field validation and the same size ceilings.
A replacement is a create with an existing document behind it, and it must not be
the laxer of the two.
"""

import uuid
from typing import Annotated, Any

from fastapi import (
    APIRouter,
    Cookie,
    Depends,
    HTTPException,
    Path,
    Request,
    Response,
    status,
)
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
# The same reasoning applies to a document: one message, whatever the reason.
DOCUMENT_NOT_FOUND = "document not found"
# Any job for this document that is still pending or running, not only a
# replacement: a create job blocks a replacement too, because a document that has
# published nothing has no revision to replace.
REPLACEMENT_CONFLICT = "a job for this document is already in flight"

# A document id is either a corpus id such as ``DOC-001`` or a server-generated
# UUID. This accepts both and nothing else, so an id can never carry a separator,
# a query string, or a percent-escape that a downstream query would misread.
DOCUMENT_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$"

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
    has_published_revision: bool
    updated_at: str
    job_id: str | None
    safe_error: str | None


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


async def _read_document_part(form: FormData, settings: Settings) -> tuple[str, UploadInput]:
    """Validate the declared fields and read the one file, or refuse.

    Shared by create and replace. A replacement must not accept a laxer document
    than a create, and both bodies arrive through the same parser under the same
    ceilings.
    """
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
    return text, UploadInput(title=title, access_role=access_role)


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
                has_published_revision=summary.has_published_revision,
                updated_at=summary.updated_at.isoformat(),
                job_id=None if summary.job_id is None else str(summary.job_id),
                safe_error=summary.safe_error,
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
    from app.provider_config.contracts import ProviderConfigurationError
    from app.provider_config.runtime import bind_runtime, get_runtime

    try:
        configured = await bind_runtime(settings, get_session_factory(request, engine))  # type: ignore[arg-type]
        runtime = get_runtime(configured)
        if not any(c.id == runtime.active_embedding_id for c in runtime.connections["embedding"]):
            raise ProviderConfigurationError
    except ProviderConfigurationError:
        raise HTTPException(503, "embedding provider is not configured") from None
    try:
        form = await request.form()
    except UploadRejectedError as error:
        raise _reject(error) from error

    try:
        text, metadata = await _read_document_part(form, settings)
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


@router.put(
    "/documents/{document_id}",
    response_model=JobResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def replace_document(
    request: Request,
    document_id: Annotated[str, Path(pattern=DOCUMENT_ID_PATTERN)],
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> JobResponse:
    """Stage a replacement for an existing document and return its job.

    Returns 202 for the same reason a create does: the text is stored, but nothing
    about it is retrievable until a worker activates the new revision. The
    currently published revision keeps serving readers the whole time.

    The body is parsed by hand after ``_require_manager``, for the reason given on
    :func:`upload_document`. ``UploadGuard`` caps this request the same way it caps
    a create, so an oversized replacement is refused before it is buffered.

    The access policy is not fully deferred, and the difference is deliberate. A
    narrower policy takes effect immediately, because withdrawing access must not
    wait on an ingestion run; a wider one takes effect only at activation, because
    a newly permitted reader must not reach the old revision before the new one is
    ready (SECURITY.md section 2, ARCHITECTURE.md section 6).
    """
    from app.provider_config.contracts import ProviderConfigurationError
    from app.provider_config.runtime import bind_runtime, get_runtime

    try:
        configured = await bind_runtime(settings, get_session_factory(request, engine))  # type: ignore[arg-type]
        runtime = get_runtime(configured)
        if not any(c.id == runtime.active_embedding_id for c in runtime.connections["embedding"]):
            raise ProviderConfigurationError
    except ProviderConfigurationError:
        raise HTTPException(503, "embedding provider is not configured") from None
    try:
        form = await request.form()
    except UploadRejectedError as error:
        raise _reject(error) from error

    try:
        text, metadata = await _read_document_part(form, settings)
    except UploadRejectedError as error:
        raise _reject(error) from error
    finally:
        await _close_form(form)

    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            job = await store.stage_replace(
                session,
                actor=actor,
                document_id=document_id,
                text_body=text,
                metadata=metadata,
            )
        except UploadRejectedError as error:
            raise _reject(error) from error
        except store.DocumentNotFoundError as error:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=DOCUMENT_NOT_FOUND
            ) from error
        except store.ReplacementConflictError as error:
            # Deleted, or a replacement is already running. Both are states of this
            # document that a retry cannot clear, and both are reported as one
            # message so the endpoint does not become a state oracle.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail=REPLACEMENT_CONFLICT
            ) from error
    return _job_response(job)


@router.patch(
    "/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def restrict_document(
    request: Request,
    document_id: Annotated[str, Path(pattern=DOCUMENT_ID_PATTERN)],
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> Response:
    """Apply the only policy change allowed during an embedding rebuild."""
    if request.headers.get("content-type", "").split(";")[0] != "application/json":
        raise HTTPException(415, "JSON required")
    try:
        payload = await request.json()
    except ValueError:
        raise HTTPException(422, "invalid access restriction") from None
    if payload != {"access_role": "manager"}:
        raise HTTPException(422, "invalid access restriction")
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            await store.restrict_document_access(session, actor=actor, document_id=document_id)
        except store.DocumentNotFoundError:
            raise HTTPException(404, DOCUMENT_NOT_FOUND) from None
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/documents/{document_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_document(
    request: Request,
    document_id: Annotated[str, Path(pattern=DOCUMENT_ID_PATTERN)],
    actor: Annotated[Actor, Depends(_require_manager)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> Response:
    """Retire a document and return 204.

    Deletion is logical and idempotent: 204 is returned for an unknown id, an
    already-deleted document, and a real deletion alike. There is nothing to
    report, and a repeated or retried delete must not turn into an error the caller
    has to distinguish from a real failure.

    No body is read, so there is nothing to parse and nothing to cap. The Origin
    and manager checks in ``_require_manager`` still run first, which is what stops
    a caller's cookie from being driven by another site.
    """
    factory = get_session_factory(request, engine)
    async with factory() as session:  # type: ignore[operator]
        try:
            await store.soft_delete_document(session, actor=actor, document_id=document_id)
        except UploadRejectedError as error:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=FORBIDDEN) from error
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
