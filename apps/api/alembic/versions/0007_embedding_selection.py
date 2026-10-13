"""Keep one active embedding space and stage confirmed rebuilds."""

from collections.abc import Sequence

import pgvector.sqlalchemy
import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint(op.f("ck_chunks_embedding_dimension_768"), "chunks", type_="check")
    op.alter_column("chunks", "embedding", type_=pgvector.sqlalchemy.Vector(), existing_nullable=True)
    op.create_check_constraint(
        op.f("ck_chunks_embedding_dimension_range"),
        "chunks",
        "embedding_dimension BETWEEN 1 AND 16000",
    )
    op.add_column("provider_chains", sa.Column("active_provider_id", sa.Uuid(), nullable=True))
    op.add_column("provider_configs", sa.Column("embedding_dimension", sa.SmallInteger(), nullable=True))
    op.execute(
        "UPDATE provider_configs SET embedding_dimension = 768 "
        "WHERE purpose = 'embedding' AND kind = 'ollama' "
        "AND model = 'nomic-embed-text-v2-moe:latest'"
    )
    op.execute(
        "UPDATE provider_chains SET active_provider_id = ("
        "SELECT provider_id FROM provider_configs WHERE purpose = 'embedding' "
        "ORDER BY priority LIMIT 1) WHERE purpose = 'embedding'"
    )
    op.create_table(
        "embedding_reindex_jobs",
        sa.Column("job_id", sa.Uuid(), primary_key=True),
        sa.Column("target_provider_id", sa.Uuid(), sa.ForeignKey("provider_configs.provider_id"), nullable=False),
        sa.Column("target_version", sa.Integer(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("total", sa.Integer(), nullable=False),
        sa.Column("completed", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("safe_error", sa.Text(), nullable=True),
        sa.Column("lease_token", sa.Uuid(), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("status IN ('pending', 'running', 'completed', 'failed')", name=op.f("ck_embedding_reindex_jobs_status")),
        sa.CheckConstraint("total >= 0 AND completed >= 0 AND completed <= total", name=op.f("ck_embedding_reindex_jobs_progress")),
    )
    op.create_table(
        "embedding_reindex_vectors",
        sa.Column("job_id", sa.Uuid(), sa.ForeignKey("embedding_reindex_jobs.job_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("chunk_id", sa.Uuid(), sa.ForeignKey("chunks.chunk_id", ondelete="CASCADE"), primary_key=True),
        sa.Column("embedding", pgvector.sqlalchemy.Vector(), nullable=False),
    )


def downgrade() -> None:
    connection = op.get_bind()
    incompatible = connection.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM chunks WHERE embedding_dimension <> 768)"))
    if incompatible:
        raise RuntimeError("cannot downgrade while non-768 embeddings exist")
    op.drop_table("embedding_reindex_vectors")
    op.drop_table("embedding_reindex_jobs")
    op.drop_column("provider_configs", "embedding_dimension")
    op.drop_column("provider_chains", "active_provider_id")
    op.drop_constraint(op.f("ck_chunks_embedding_dimension_range"), "chunks", type_="check")
    op.alter_column("chunks", "embedding", type_=pgvector.sqlalchemy.Vector(768), existing_nullable=True)
    op.create_check_constraint(op.f("ck_chunks_embedding_dimension_768"), "chunks", "embedding_dimension = 768")
