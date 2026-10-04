"""ORM mappings for the seven v1 domain tables.

Column contracts follow DATABASE.md section 3 exactly: identifiers, FK targets,
uniqueness, and domain CHECK values are fixed there. Section 11 keeps the
physical schema in the versioned migration, so this module stays the single
declarative source that Alembic autogenerates against.

Two choices are locked in here because DATABASE.md leaves them to the migration:
``request_runs.status`` uses the fixed set below, and ``ingestion_jobs`` lease
columns must be NULL whenever the job is not ``indexing``.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    SmallInteger,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

# Fixed at migration time per DATABASE.md section 3 (request_runs.status):
# answered = validated claims delivered, abstained = insufficient/ambiguous/conflict,
# rejected = invalid generation payload, error = operational failure or deadline.
REQUEST_RUN_STATUSES = ("answered", "abstained", "rejected", "error")

_JSON_EMPTY_LIST = text("'[]'::jsonb")


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("role IN ('employee', 'manager')", name="role"),)

    user_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    login: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[str] = mapped_column(Text, nullable=False)
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class Session(Base):
    __tablename__ = "sessions"
    __table_args__ = (Index("ix_sessions_user_id_expires_at", "user_id", "expires_at"),)

    session_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.user_id", ondelete="CASCADE"), nullable=False
    )
    # Only the hash of the opaque cookie value is stored (DATABASE.md section 10).
    token_hash: Mapped[bytes] = mapped_column(LargeBinary, nullable=False, unique=True)
    created_at: Mapped[datetime] = _now()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint("access_role IN ('employee', 'manager')", name="access_role"),
        CheckConstraint("status IN ('active', 'inactive')", name="status"),
        CheckConstraint("btrim(title) <> ''", name="title_not_blank"),
        CheckConstraint("btrim(content_version) <> ''", name="content_version_not_blank"),
        CheckConstraint(
            "current_revision IS NULL OR btrim(current_revision) <> ''",
            name="current_revision_not_blank",
        ),
        Index(
            "ix_documents_status_access_role_current_revision",
            "status",
            "access_role",
            "current_revision",
        ),
    )

    # Seed identifiers such as HR-001 are preserved; new uploads get a server UUID text.
    document_id: Mapped[str] = mapped_column(Text, primary_key=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    content_version: Mapped[str] = mapped_column(Text, nullable=False)
    access_role: Mapped[str] = mapped_column(Text, nullable=False)
    current_revision: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = _now()


class IngestionJob(Base):
    __tablename__ = "ingestion_jobs"
    __table_args__ = (
        CheckConstraint("operation IN ('create', 'replace')", name="operation"),
        CheckConstraint("status IN ('pending', 'indexing', 'ready', 'failed')", name="status"),
        CheckConstraint("attempt_count BETWEEN 0 AND 3", name="attempt_count_range"),
        CheckConstraint("btrim(target_revision) <> ''", name="target_revision_not_blank"),
        # A lease is valid only while the job is being indexed, so a finished or
        # failed job cannot leave stale fencing state behind.
        CheckConstraint(
            "status <> 'indexing' OR "
            "(lease_owner IS NOT NULL AND lease_token IS NOT NULL "
            "AND lease_expires_at IS NOT NULL)",
            name="lease_required_while_indexing",
        ),
        CheckConstraint(
            "status = 'indexing' OR "
            "(lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)",
            name="lease_cleared_when_not_indexing",
        ),
        UniqueConstraint("document_id", "target_revision"),
        Index(
            "ix_ingestion_jobs_status_lease_expires_at_created_at",
            "status",
            "lease_expires_at",
            "created_at",
        ),
    )

    job_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[str] = mapped_column(
        Text, ForeignKey("documents.document_id"), nullable=False
    )
    target_revision: Mapped[str] = mapped_column(Text, nullable=False)
    operation: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False)
    attempt_count: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default=text("0")
    )
    # Staging text for resume/retry; the raw uploaded file is not kept on disk.
    source_text: Mapped[str] = mapped_column(Text, nullable=False)
    expected_current_revision: Mapped[str | None] = mapped_column(Text)
    lease_owner: Mapped[str | None] = mapped_column(Text)
    lease_token: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    safe_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Section(Base):
    __tablename__ = "sections"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_non_negative"),
        CheckConstraint("btrim(revision) <> ''", name="revision_not_blank"),
        UniqueConstraint("document_id", "revision", "ordinal"),
    )

    document_id: Mapped[str] = mapped_column(
        Text, ForeignKey("documents.document_id"), primary_key=True
    )
    revision: Mapped[str] = mapped_column(Text, primary_key=True)
    section_id: Mapped[str] = mapped_column(Text, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    heading_path: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    # source_text stays verbatim for quoting; search_text is derived and normalized.
    source_text: Mapped[str] = mapped_column(Text, nullable=False)
    search_text: Mapped[str] = mapped_column(Text, nullable=False)


class Chunk(Base):
    __tablename__ = "chunks"
    __table_args__ = (
        CheckConstraint("ordinal >= 0", name="ordinal_non_negative"),
        CheckConstraint("embedding_dimension = 768", name="embedding_dimension_768"),
        CheckConstraint("char_length(chunk_text) <= 1200", name="chunk_text_char_limit"),
        ForeignKeyConstraint(
            ["document_id", "revision", "section_id"],
            ["sections.document_id", "sections.revision", "sections.section_id"],
            name="chunk_section_fkey",
            ondelete="CASCADE",
        ),
        UniqueConstraint("document_id", "revision", "section_id", "ordinal"),
    )

    chunk_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    document_id: Mapped[str] = mapped_column(Text, nullable=False)
    revision: Mapped[str] = mapped_column(Text, nullable=False)
    section_id: Mapped[str] = mapped_column(Text, nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_text: Mapped[str] = mapped_column(Text, nullable=False)
    search_text: Mapped[str] = mapped_column(Text, nullable=False)
    # Nullable only while staging; DATABASE.md section 5 fails closed on any
    # mixed or stale digest before a chunk may be searched.
    embedding: Mapped[list[float] | None] = mapped_column(Vector(768))
    embedding_provider: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_model: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_digest: Mapped[str] = mapped_column(Text, nullable=False)
    embedding_dimension: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    created_at: Mapped[datetime] = _now()


class RequestRun(Base):
    __tablename__ = "request_runs"
    __table_args__ = (
        CheckConstraint("status IN ('answered', 'abstained', 'rejected', 'error')", name="status"),
        CheckConstraint("duration_ms IS NULL OR duration_ms >= 0", name="duration_ms_non_negative"),
        CheckConstraint("retry_count >= 0", name="retry_count_non_negative"),
    )

    request_id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, ForeignKey("users.user_id"))
    status: Mapped[str] = mapped_column(Text, nullable=False)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # Content-free telemetry: no question, answer, prompt, document text, or secret.
    config: Mapped[dict[str, object]] = mapped_column(JSONB, nullable=False)
    candidate_refs: Mapped[list[object]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=_JSON_EMPTY_LIST
    )
    retry_count: Mapped[int] = mapped_column(
        SmallInteger, nullable=False, default=0, server_default=text("0")
    )
    error_code: Mapped[str | None] = mapped_column(Text)
    # NULL means usage was not reported, never zero (DATABASE.md section 9).
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cost: Mapped[Decimal | None] = mapped_column(Numeric)
    provider_usage: Mapped[list[object]] = mapped_column(
        JSONB, nullable=False, default=list, server_default=_JSON_EMPTY_LIST
    )
