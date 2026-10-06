"""Value objects and the failure taxonomy for document ingestion.

These types carry no framework types, so the worker, the manager routes, and the
CLI all describe a job the same way. ``technical-details.md`` topic 3 fixes the
shape of ``UploadInput``, ``IngestionJob``, and ``DocumentSummary``.

The error taxonomy is the important part here. ARCHITECTURE.md section 6 allows
retry only for a network failure or 429/502/503/504; a deterministic parse,
chunking, or validation failure must fail on the first attempt instead of
burning the three-attempt budget. Each error therefore carries a short stable
``safe_code`` that is written to ``ingestion_jobs.safe_error`` and returned to the
manager, instead of an exception message that could contain document text.
"""

from dataclasses import dataclass
from datetime import datetime
from typing import Final
from uuid import UUID

from app.domain.models import Role

# DATABASE.md section 4 fixes the job status domain; the CHECK constraint on the
# column is the authority, and these names mirror it exactly.
JOB_STATUS_PENDING: Final = "pending"
JOB_STATUS_INDEXING: Final = "indexing"
JOB_STATUS_READY: Final = "ready"
JOB_STATUS_FAILED: Final = "failed"

JOB_STATUSES: Final = (
    JOB_STATUS_PENDING,
    JOB_STATUS_INDEXING,
    JOB_STATUS_READY,
    JOB_STATUS_FAILED,
)

OPERATION_CREATE: Final = "create"
OPERATION_REPLACE: Final = "replace"

# How restrictive each role is: "employee" lets every authenticated user in,
# "manager" only managers. A move up this order narrows access.
ROLE_RESTRICTION: Final[dict[str, int]] = {"employee": 0, "manager": 1}


def narrows_access(current: str, incoming: str) -> bool:
    """Return whether ``incoming`` lets fewer people in than ``current``."""
    return ROLE_RESTRICTION[incoming] > ROLE_RESTRICTION[current]


# SECURITY.md section 8: the staging text lives in the database so a job can be
# resumed or retried, and the raw file is never kept alongside it.
UNPUBLISHED_VERSION: Final = "unpublished"


class IngestionError(Exception):
    """Base class for failures that are safe to report to a manager."""

    def __init__(self, safe_code: str) -> None:
        super().__init__(safe_code)
        self.safe_code = safe_code


class PermanentIngestionError(IngestionError):
    """A deterministic failure. Retrying the same job cannot change the outcome.

    Covers a parse or chunking error, an untrustworthy vector, a model digest
    mismatch, and a quota overflow. The job goes straight to ``failed`` and the
    attempt budget is not consumed by pointless retries.
    """


class TransientIngestionError(IngestionError):
    """A failure that may clear on its own, so the job returns to the queue.

    Covers a network failure, 429/502/503/504, and an unreachable tokenizer
    download. The job keeps its attempt count and is retried until
    ``ingestion_max_attempts`` is reached.
    """


class UploadRejectedError(IngestionError):
    """Rejected before anything was written.

    Raised for an unsupported suffix, an oversized or non-UTF-8 file, and a
    quota that is already full. Because nothing was staged, there is no job to
    report and the code is returned to the caller directly.
    """


@dataclass(frozen=True)
class UploadInput:
    """Manager-reviewed metadata for one upload.

    ``access_role`` is the only source of a document's access policy.
    ``parse_document`` reports the file's own ``access_role`` front-matter claim
    separately and it is never consulted here, because SECURITY.md section 2
    forbids a file from granting itself access.
    """

    title: str
    access_role: Role

    def normalized_title(self, *, max_length: int = 300) -> str:
        """Return the title with surrounding whitespace removed.

        Raises :class:`UploadRejectedError` for a blank or over-long title,
        because ``documents.title`` is NOT NULL and must be non-blank after trim.
        """
        cleaned = " ".join(self.title.split())
        if not cleaned:
            raise UploadRejectedError("title is blank")
        if len(cleaned) > max_length:
            raise UploadRejectedError("title is too long")
        return cleaned


@dataclass(frozen=True)
class IngestionJob:
    """The non-sensitive processing state of one upload.

    ``safe_error`` is a stable code, never document text, a provider response
    body, or a credential. A manager learns *that* processing failed and *what
    class* of failure it was, and nothing about the content.
    """

    job_id: UUID
    document_id: str
    revision: str
    status: str
    attempt: int
    safe_error: str | None
    created_at: datetime
    finished_at: datetime | None

    @property
    def is_terminal(self) -> bool:
        """Whether no further attempt will be made for this job."""
        return self.status in (JOB_STATUS_READY, JOB_STATUS_FAILED)


@dataclass(frozen=True)
class DocumentSummary:
    """One row of the manager document list.

    ``content_status`` and ``processing_status`` are reported separately so a
    document that exists but is not yet searchable is never presented as
    available content.

    ``has_published_revision`` answers "is there an indexed revision right now?"
    straight from ``current_revision``. The processing status cannot answer it: a
    replacement that is pending or has failed says nothing about whether the
    revision that is already published is still there (Part 10 review).
    """

    document_id: str
    title: str
    access_role: str
    version: str
    content_status: str
    processing_status: str
    has_published_revision: bool
    updated_at: datetime
    job_id: UUID | None = None
    safe_error: str | None = None
