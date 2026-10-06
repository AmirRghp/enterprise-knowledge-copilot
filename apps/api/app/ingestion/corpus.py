"""Operator-only import of the repository's fictional corpus; never an upload route."""

from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Document, IngestionJob, User
from app.documents.parse import DocumentParseError, parse_document
from app.domain.models import Actor, Role
from app.ingestion import store
from app.ingestion.contracts import UploadInput, UploadRejectedError
from app.ingestion.limits import decode_utf8, read_capped

CORPUS_PATH = Path(__file__).resolve().parents[4] / "corpus"
# Policy is operator-owned, independent of file front matter. Matches corpus-index.md.
CORPUS_ROLES: dict[str, Role] = {
    **{
        name: "employee"
        for name in (
            "COM-001",
            "DOC-001",
            "HR-001",
            "HR-002",
            "HR-003",
            "HR-004",
            "HR-005",
            "HR-006",
            "HR-007",
            "HR-008",
            "HR-009",
            "IT-001",
            "IT-002",
            "OPS-001",
            "OPS-002",
            "SEC-001",
        )
    },
    **{name: "manager" for name in ("MGR-001", "MGR-002", "MGR-003", "MGR-004")},
}


@dataclass(frozen=True)
class CorpusDocument:
    document_id: str
    text_body: str
    metadata: UploadInput


@dataclass(frozen=True)
class ImportResult:
    created: int
    existing: int


def load_corpus(path: Path, *, max_bytes: int) -> list[CorpusDocument]:
    """Validate all 20 files before any database write or model call."""
    if {file.name for file in path.iterdir() if file.suffix == ".md"} != {
        f"{name}.md" for name in CORPUS_ROLES
    }:
        raise UploadRejectedError("corpus must contain exactly the 20 indexed Markdown files")
    documents = []
    for document_id, role in CORPUS_ROLES.items():
        file = path / f"{document_id}.md"
        if file.is_symlink() or not file.is_file():
            raise UploadRejectedError("corpus files must be regular files")
        with file.open("rb") as handle:
            body = decode_utf8(read_capped(handle.read(max_bytes + 1), max_bytes=max_bytes))
        parsed = parse_document(body)
        if (
            parsed.seed_document_id != document_id
            or parsed.claimed_access_role != role
            or parsed.content_status != "active"
            or parsed.version != "1.0"
            or {section.section_id for section in parsed.sections}
            != {f"{document_id}-S{number}" for number in range(1, 5)}
        ):
            raise UploadRejectedError("corpus metadata or section identifiers disagree with index")
        metadata = UploadInput(title=parsed.title or "", access_role=role)
        metadata.normalized_title()
        documents.append(CorpusDocument(document_id, body, metadata))
    return documents


async def ingest_corpus(
    session: AsyncSession,
    *,
    actor: Actor,
    path: Path = CORPUS_PATH,
    max_bytes: int,
    max_active_documents: int,
) -> ImportResult:
    """Stage missing seed IDs atomically; identical re-runs leave jobs untouched.

    Existing IDs with changed source/policy are refused, never replaced. A failed
    job remains failed; import is not a retry or replacement operation (Part 10).
    """
    if actor.role != "manager":
        raise UploadRejectedError("only a manager may import corpus")
    try:
        documents = load_corpus(path, max_bytes=max_bytes)
    except DocumentParseError as error:
        raise UploadRejectedError("corpus parse failed") from error
    created = 0
    async with session.begin():
        user = await session.get(User, actor.user_id, with_for_update=True)
        if user is None or not user.is_active or user.role != "manager":
            raise UploadRejectedError("active manager account required")
        await session.execute(
            text("SELECT pg_advisory_xact_lock(:key)"), {"key": store.STAGING_LOCK_KEY}
        )
        active_count = await store.count_active_documents(session)
        for item in documents:
            existing = await session.get(Document, item.document_id)
            if existing is not None:
                job = (
                    await session.execute(
                        select(IngestionJob)
                        .where(IngestionJob.document_id == item.document_id)
                        .order_by(IngestionJob.created_at.desc(), IngestionJob.job_id.desc())
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if (
                    existing.title != item.metadata.normalized_title()
                    or existing.access_role != item.metadata.access_role
                    or existing.status != "active"
                    or job is None
                    or job.operation != "create"
                    or job.source_text != item.text_body
                ):
                    raise UploadRejectedError("existing corpus ID conflicts; no documents changed")
                continue
            if active_count + created >= max_active_documents:
                raise UploadRejectedError("active document limit reached")
            store.add_document_job(
                session,
                document_id=item.document_id,
                text_body=item.text_body,
                metadata=item.metadata,
            )
            created += 1
    return ImportResult(created, len(documents) - created)
