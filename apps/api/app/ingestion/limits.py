"""File-level limits applied before anything is written or requested.

SECURITY.md section 8 fixes the first-version policy: Markdown/text, PDF, DOCX,
XLSX and legacy XLS, at most 1 MiB per file, at most 100 active documents and
2000 current chunks. Every check here is deterministic, so a rejection is
permanent and never consumes a retry attempt.
"""

from typing import Final

from app.ingestion.contracts import UploadRejectedError

ALLOWED_SUFFIXES: Final = frozenset({".md", ".txt", ".pdf", ".docx", ".xlsx", ".xls"})
DEFAULT_MAX_BYTES: Final = 1024 * 1024
DEFAULT_MAX_ACTIVE_DOCUMENTS: Final = 100
DEFAULT_MAX_CURRENT_CHUNKS: Final = 2000


def _suffix_of(filename: str) -> str:
    """Return the lowercase extension, or an empty string when there is none."""
    _, dot, suffix = filename.rpartition(".")
    if not dot:
        return ""
    return f".{suffix.lower()}"


def validate_suffix(filename: str | None) -> None:
    """Reject a filename outside the supported text and office formats.

    A missing filename is rejected rather than defaulted: guessing an extension
    would let any binary payload through under a plausible name.
    """
    if not filename:
        raise UploadRejectedError("a filename is required")
    suffix = _suffix_of(filename)
    if suffix not in ALLOWED_SUFFIXES:
        # The rejected name is not echoed back; it is client-supplied.
        raise UploadRejectedError("supported formats are .md, .txt, .pdf, .docx, .xlsx and .xls")


def read_capped(raw: bytes, *, max_bytes: int) -> bytes:
    """Return ``raw`` when it fits the ceiling, otherwise reject it.

    The caller must already have stopped reading at ``max_bytes + 1`` bytes so a
    hostile upload cannot be buffered whole just to be rejected.
    """
    if max_bytes <= 0:
        raise ValueError("max_bytes must be positive")
    if len(raw) > max_bytes:
        raise UploadRejectedError("file is larger than the allowed size")
    return raw


def decode_utf8(raw: bytes) -> str:
    """Decode strictly as UTF-8, rejecting anything that is not valid.

    ``errors="strict"`` is the point: a lenient decode would silently corrupt the
    stored staging text and produce chunks that no longer match the source.
    """
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise UploadRejectedError("file is not valid UTF-8") from error
    if not text.strip():
        raise UploadRejectedError("file has no text content")
    return text


def read_upload_bytes(raw: bytes, *, filename: str | None, max_bytes: int) -> bytes:
    """Apply the extension and size policy to an already-read upload."""
    validate_suffix(filename)
    return read_capped(raw, max_bytes=max_bytes)


def validate_upload_text(text: str) -> str:
    """Return ``text`` unchanged once it is known to be non-blank.

    ``decode_utf8`` already rejects blank content; this exists so callers that
    build text from another source still get the same guarantee.
    """
    if not text.strip():
        raise UploadRejectedError("file has no text content")
    return text
