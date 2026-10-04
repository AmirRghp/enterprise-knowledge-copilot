"""create v1 domain schema

Revision ID: 0001
Revises:
Create Date: 2026-10-04

Creates the seven tables defined in DATABASE.md section 3 with their keys,
uniqueness, domain CHECK constraints, and indexes from sections 5 and 6.

Notes for reviewers:

- ``pgvector`` is a cluster prerequisite created once by ``sql/provision.sql`` as
  the existing server superuser. ``alembic/env.py`` verifies it before running,
  so this revision only owns the project schema and stays runnable under the
  least-privilege application role.
- ``ingestion_jobs`` encodes the rule from DATABASE.md section 3 that a lease is
  valid only while the job is ``indexing``; a worker must clear the lease
  columns when it commits ``ready`` or ``failed``.
- ``request_runs.status`` values are fixed here, which is the point DATABASE.md
  section 3 defers to migration time.
"""

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_JSON_EMPTY_LIST = sa.text("'[]'::jsonb")


def upgrade() -> None:
    """Create the v1 domain schema."""
    op.create_table(
        "documents",
        sa.Column("document_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("content_version", sa.Text(), nullable=False),
        sa.Column("access_role", sa.Text(), nullable=False),
        sa.Column("current_revision", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "access_role IN ('employee', 'manager')", name=op.f("ck_documents_access_role")
        ),
        sa.CheckConstraint("btrim(title) <> ''", name=op.f("ck_documents_title_not_blank")),
        sa.CheckConstraint(
            "btrim(content_version) <> ''", name=op.f("ck_documents_content_version_not_blank")
        ),
        sa.CheckConstraint(
            "current_revision IS NULL OR btrim(current_revision) <> ''",
            name=op.f("ck_documents_current_revision_not_blank"),
        ),
        sa.CheckConstraint("status IN ('active', 'inactive')", name=op.f("ck_documents_status")),
        sa.PrimaryKeyConstraint("document_id", name=op.f("pk_documents")),
    )
    op.create_index(
        "ix_documents_status_access_role_current_revision",
        "documents",
        ["status", "access_role", "current_revision"],
        unique=False,
    )

    op.create_table(
        "users",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("login", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("role", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("role IN ('employee', 'manager')", name=op.f("ck_users_role")),
        sa.PrimaryKeyConstraint("user_id", name=op.f("pk_users")),
        sa.UniqueConstraint("login", name=op.f("uq_users_login")),
    )

    op.create_table(
        "ingestion_jobs",
        sa.Column("job_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Text(), nullable=False),
        sa.Column("target_revision", sa.Text(), nullable=False),
        sa.Column("operation", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("attempt_count", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=False),
        sa.Column("expected_current_revision", sa.Text(), nullable=True),
        sa.Column("lease_owner", sa.Text(), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("safe_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "operation IN ('create', 'replace')", name=op.f("ck_ingestion_jobs_operation")
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'indexing', 'ready', 'failed')",
            name=op.f("ck_ingestion_jobs_status"),
        ),
        sa.CheckConstraint(
            "attempt_count BETWEEN 0 AND 3", name=op.f("ck_ingestion_jobs_attempt_count_range")
        ),
        sa.CheckConstraint(
            "btrim(target_revision) <> ''",
            name=op.f("ck_ingestion_jobs_target_revision_not_blank"),
        ),
        sa.CheckConstraint(
            "status <> 'indexing' OR "
            "(lease_owner IS NOT NULL AND lease_token IS NOT NULL "
            "AND lease_expires_at IS NOT NULL)",
            name=op.f("ck_ingestion_jobs_lease_required_while_indexing"),
        ),
        sa.CheckConstraint(
            "status = 'indexing' OR "
            "(lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)",
            name=op.f("ck_ingestion_jobs_lease_cleared_when_not_indexing"),
        ),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.document_id"],
            name=op.f("fk_ingestion_jobs_document_id_documents"),
        ),
        sa.PrimaryKeyConstraint("job_id", name=op.f("pk_ingestion_jobs")),
        sa.UniqueConstraint(
            "document_id",
            "target_revision",
            name=op.f("uq_ingestion_jobs_document_id_target_revision"),
        ),
    )
    op.create_index(
        "ix_ingestion_jobs_status_lease_expires_at_created_at",
        "ingestion_jobs",
        ["status", "lease_expires_at", "created_at"],
        unique=False,
    )

    op.create_table(
        "request_runs",
        sa.Column("request_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("duration_ms", sa.Integer(), nullable=True),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "candidate_refs",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=_JSON_EMPTY_LIST,
            nullable=False,
        ),
        sa.Column("retry_count", sa.SmallInteger(), server_default=sa.text("0"), nullable=False),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("cost", sa.Numeric(), nullable=True),
        sa.Column(
            "provider_usage",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=_JSON_EMPTY_LIST,
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('answered', 'abstained', 'rejected', 'error')",
            name=op.f("ck_request_runs_status"),
        ),
        sa.CheckConstraint(
            "duration_ms IS NULL OR duration_ms >= 0",
            name=op.f("ck_request_runs_duration_ms_non_negative"),
        ),
        sa.CheckConstraint(
            "retry_count >= 0", name=op.f("ck_request_runs_retry_count_non_negative")
        ),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.user_id"], name=op.f("fk_request_runs_user_id_users")
        ),
        sa.PrimaryKeyConstraint("request_id", name=op.f("pk_request_runs")),
    )

    op.create_table(
        "sections",
        sa.Column("document_id", sa.Text(), nullable=False),
        sa.Column("revision", sa.Text(), nullable=False),
        sa.Column("section_id", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("heading_path", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("source_text", sa.Text(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.CheckConstraint("ordinal >= 0", name=op.f("ck_sections_ordinal_non_negative")),
        sa.CheckConstraint("btrim(revision) <> ''", name=op.f("ck_sections_revision_not_blank")),
        sa.ForeignKeyConstraint(
            ["document_id"],
            ["documents.document_id"],
            name=op.f("fk_sections_document_id_documents"),
        ),
        sa.PrimaryKeyConstraint("document_id", "revision", "section_id", name=op.f("pk_sections")),
        sa.UniqueConstraint(
            "document_id",
            "revision",
            "ordinal",
            name=op.f("uq_sections_document_id_revision_ordinal"),
        ),
    )

    op.create_table(
        "sessions",
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.LargeBinary(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.user_id"],
            name=op.f("fk_sessions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("session_id", name=op.f("pk_sessions")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_sessions_token_hash")),
    )
    op.create_index(
        "ix_sessions_user_id_expires_at", "sessions", ["user_id", "expires_at"], unique=False
    )

    op.create_table(
        "chunks",
        sa.Column("chunk_id", sa.Uuid(), nullable=False),
        sa.Column("document_id", sa.Text(), nullable=False),
        sa.Column("revision", sa.Text(), nullable=False),
        sa.Column("section_id", sa.Text(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("chunk_text", sa.Text(), nullable=False),
        sa.Column("search_text", sa.Text(), nullable=False),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(768), nullable=True),
        sa.Column("embedding_provider", sa.Text(), nullable=False),
        sa.Column("embedding_model", sa.Text(), nullable=False),
        sa.Column("embedding_digest", sa.Text(), nullable=False),
        sa.Column("embedding_dimension", sa.SmallInteger(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("ordinal >= 0", name=op.f("ck_chunks_ordinal_non_negative")),
        sa.CheckConstraint(
            "embedding_dimension = 768", name=op.f("ck_chunks_embedding_dimension_768")
        ),
        # DATABASE.md section 3 caps a chunk at 1200 characters; encoding it here
        # keeps an oversized chunk from ever becoming searchable.
        sa.CheckConstraint(
            "char_length(chunk_text) <= 1200", name=op.f("ck_chunks_chunk_text_char_limit")
        ),
        sa.ForeignKeyConstraint(
            ["document_id", "revision", "section_id"],
            ["sections.document_id", "sections.revision", "sections.section_id"],
            name="chunk_section_fkey",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("chunk_id", name=op.f("pk_chunks")),
        sa.UniqueConstraint(
            "document_id",
            "revision",
            "section_id",
            "ordinal",
            name=op.f("uq_chunks_document_id_revision_section_id_ordinal"),
        ),
    )


def downgrade() -> None:
    """Drop the v1 domain schema."""
    op.drop_table("chunks")
    op.drop_index("ix_sessions_user_id_expires_at", table_name="sessions")
    op.drop_table("sessions")
    op.drop_table("sections")
    op.drop_table("request_runs")
    op.drop_index(
        "ix_ingestion_jobs_status_lease_expires_at_created_at", table_name="ingestion_jobs"
    )
    op.drop_table("ingestion_jobs")
    op.drop_table("users")
    op.drop_index("ix_documents_status_access_role_current_revision", table_name="documents")
    op.drop_table("documents")
