"""Extract bounded, citable UTF-8 text from supported manager uploads."""

from __future__ import annotations

from datetime import date, datetime, time
from io import BytesIO
from zipfile import BadZipFile, ZipFile

from docx import Document as OpenDocument
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader
from python_calamine import CalamineWorkbook, SheetTypeEnum

from app.ingestion.contracts import UploadRejectedError
from app.ingestion.limits import validate_suffix

MAX_ARCHIVE_UNCOMPRESSED_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 4096
MAX_PDF_PAGES = 250
MAX_SPREADSHEET_CELLS = 100_000

_INVALID_DOCUMENT = "document format is invalid"
_NO_TEXT = "file has no text content"
_OUTPUT_TOO_LARGE = "extracted text is larger than the allowed size"
_ARCHIVE_TOO_LARGE = "document package is too large to process"
_ENCRYPTED = "encrypted documents are not accepted"


class _TextBuilder:
    def __init__(self, max_bytes: int) -> None:
        if max_bytes <= 0:
            raise ValueError("max_bytes must be positive")
        self._max_bytes = max_bytes
        self._size = 0
        self._parts: list[str] = []

    def add(self, value: str) -> None:
        if not value.strip():
            return
        addition = value if not self._parts else f"\n\n{value}"
        self._size += len(addition.encode("utf-8"))
        if self._size > self._max_bytes:
            raise UploadRejectedError(_OUTPUT_TOO_LARGE)
        self._parts.append(value)

    def finish(self) -> str:
        if not self._parts:
            raise UploadRejectedError(_NO_TEXT)
        return "\n\n".join(self._parts)


def _suffix(filename: str | None) -> str:
    validate_suffix(filename)
    assert filename is not None
    _, dot, suffix = filename.rpartition(".")
    return f".{suffix.lower()}" if dot else ""


def _check_archive(raw: bytes, required: set[str]) -> None:
    try:
        with ZipFile(BytesIO(raw)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_ENTRIES:
                raise UploadRejectedError(_ARCHIVE_TOO_LARGE)
            if any(entry.flag_bits & 1 for entry in entries):
                raise UploadRejectedError(_ENCRYPTED)
            if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_UNCOMPRESSED_BYTES:
                raise UploadRejectedError(_ARCHIVE_TOO_LARGE)
            if not required.issubset(archive.namelist()):
                raise UploadRejectedError(_INVALID_DOCUMENT)
    except BadZipFile as error:
        raise UploadRejectedError(_INVALID_DOCUMENT) from error


def _format_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    return str(value).replace("\r", " ").replace("\n", " / ").strip()


def _extract_pdf(raw: bytes, max_bytes: int) -> str:
    if not raw.startswith(b"%PDF-"):
        raise UploadRejectedError(_INVALID_DOCUMENT)
    reader = PdfReader(BytesIO(raw), strict=True)
    if reader.is_encrypted:
        raise UploadRejectedError(_ENCRYPTED)
    if len(reader.pages) > MAX_PDF_PAGES:
        raise UploadRejectedError(_ARCHIVE_TOO_LARGE)
    text = _TextBuilder(max_bytes)
    for index, page in enumerate(reader.pages, start=1):
        content = "".join(
            char if ord(char) >= 32 or char in "\n\t" else " "
            for char in (page.extract_text() or "")
        )
        if content.strip():
            text.add(f"## صفحهٔ {index}")
            text.add(content)
    return text.finish()


def _extract_docx(raw: bytes, max_bytes: int) -> str:
    _check_archive(raw, {"[Content_Types].xml", "word/document.xml"})
    document = OpenDocument(BytesIO(raw))
    text = _TextBuilder(max_bytes)
    for block in document.iter_inner_content():
        if isinstance(block, Paragraph):
            value = block.text.strip()
            if not value:
                continue
            style_name = block.style.name if block.style else ""
            if style_name.startswith("Heading "):
                try:
                    level = min(max(int(style_name.removeprefix("Heading ")), 2), 6)
                except ValueError:
                    level = 2
                value = f"{'#' * level} {value}"
            text.add(value)
        elif isinstance(block, Table):
            for row in block.rows:
                cells = [cell.text.strip().replace("\n", " / ") for cell in row.cells]
                text.add(" | ".join(cells))
    return text.finish()


def _extract_excel(raw: bytes, max_bytes: int, *, legacy: bool) -> str:
    if legacy:
        if not raw.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
            raise UploadRejectedError(_INVALID_DOCUMENT)
    else:
        _check_archive(raw, {"[Content_Types].xml", "xl/workbook.xml"})

    workbook = CalamineWorkbook.from_filelike(BytesIO(raw))
    try:
        text = _TextBuilder(max_bytes)
        for metadata in workbook.sheets_metadata:
            if metadata.typ != SheetTypeEnum.WorkSheet:
                continue
            sheet = workbook.get_sheet_by_name(metadata.name)
            if sheet.height * sheet.width > MAX_SPREADSHEET_CELLS:
                raise UploadRejectedError(_ARCHIVE_TOO_LARGE)
            text.add(f"## {metadata.name}")
            for row_number, row in enumerate(sheet.to_python(skip_empty_area=False), start=1):
                values = [_format_cell(value) for value in row]
                if any(values):
                    text.add(f"ردیف {row_number}: " + " | ".join(values))
        return text.finish()
    finally:
        workbook.close()


def extract_document(filename: str | None, raw: bytes, *, max_bytes: int) -> str:
    """Return extracted source text, rejecting malformed or over-budget uploads."""
    extension = _suffix(filename)
    if len(raw) > max_bytes:
        raise UploadRejectedError("file is larger than the allowed size")
    if extension in {".md", ".txt"}:
        try:
            content = raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise UploadRejectedError("file is not valid UTF-8") from error
        if not content.strip():
            raise UploadRejectedError(_NO_TEXT)
        return content

    try:
        if extension == ".pdf":
            return _extract_pdf(raw, max_bytes)
        if extension == ".docx":
            return _extract_docx(raw, max_bytes)
        if extension == ".xlsx":
            return _extract_excel(raw, max_bytes, legacy=False)
        return _extract_excel(raw, max_bytes, legacy=True)
    except UploadRejectedError:
        raise
    except Exception as error:
        # Parser exceptions may contain filenames, XML fragments, or document data.
        raise UploadRejectedError(_INVALID_DOCUMENT) from error
