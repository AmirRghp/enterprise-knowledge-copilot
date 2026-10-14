"""Text extraction for the manager's supported document upload formats."""

from io import BytesIO
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

import pytest
from pypdf import PdfWriter

from app.documents.extract import extract_document
from app.ingestion.contracts import UploadRejectedError

FIXTURES = Path(__file__).parent / "fixtures" / "documents"


def _fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def test_pdf_text_is_labeled_by_page_in_source_order() -> None:
    text = extract_document("policy.pdf", _fixture("policy.pdf"), max_bytes=1024 * 1024)

    assert "صفحهٔ 1" in text
    assert "محتوای" in text
    assert "اول" in text
    assert "صفحهٔ 2" in text
    assert text.index("صفحهٔ 1") < text.index("صفحهٔ 2")


def test_docx_keeps_paragraphs_and_tables_in_document_order() -> None:
    text = extract_document("policy.docx", _fixture("policy.docx"), max_bytes=1024 * 1024)

    assert text.index("پیش از جدول") < text.index("مقدار داخل جدول") < text.index("پس از جدول")


def test_xlsx_extracts_hidden_sheets_and_cached_values_not_formulae() -> None:
    text = extract_document("policy.xlsx", _fixture("policy.xlsx"), max_bytes=1024 * 1024)

    assert "نام شیت آشکار" in text
    assert "مقدار شیت پنهان" in text
    assert "12" in text
    assert "=SUM" not in text


def test_legacy_xls_is_readable() -> None:
    text = extract_document("policy.xls", _fixture("policy.xls"), max_bytes=1024 * 1024)

    assert "نام شیت آشکار" in text


def test_pdf_without_extractable_text_is_rejected() -> None:
    with pytest.raises(UploadRejectedError, match="no text content"):
        extract_document("scan.pdf", _fixture("blank.pdf"), max_bytes=1024 * 1024)


def test_encrypted_pdf_is_rejected() -> None:
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.encrypt("secret")
    encrypted = BytesIO()
    writer.write(encrypted)

    with pytest.raises(UploadRejectedError, match="encrypted"):
        extract_document("locked.pdf", encrypted.getvalue(), max_bytes=1024 * 1024)


@pytest.mark.parametrize(
    ("filename", "raw"),
    [("bad.pdf", b"not a PDF"), ("bad.docx", b"not a zip"), ("bad.xls", b"not an XLS")],
)
def test_corrupt_office_files_are_rejected(filename: str, raw: bytes) -> None:
    with pytest.raises(UploadRejectedError):
        extract_document(filename, raw, max_bytes=1024 * 1024)


def test_office_archive_expansion_is_bounded() -> None:
    archive = BytesIO()
    with ZipFile(archive, "w", ZIP_DEFLATED) as package:
        package.writestr("word/document.xml", b"x" * (16 * 1024 * 1024))

    with pytest.raises(UploadRejectedError):
        extract_document("bomb.docx", archive.getvalue(), max_bytes=1024 * 1024)


def test_extracted_text_cannot_exceed_the_upload_budget() -> None:
    with pytest.raises(UploadRejectedError):
        extract_document("policy.txt", b"\xd9\x85" * 20, max_bytes=10)
