"""Ensure vector contents match the recorded embedding dimension."""

from collections.abc import Sequence

from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_check_constraint(
        op.f("ck_chunks_embedding_vector_dimension"),
        "chunks",
        "embedding IS NULL OR vector_dims(embedding) = embedding_dimension",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_chunks_embedding_vector_dimension"), "chunks", type_="check")
