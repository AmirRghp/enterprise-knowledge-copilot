"""Persist user-owned conversations and turns."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "conversations",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("title_edited", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "char_length(btrim(title)) BETWEEN 1 AND 100", name=op.f("ck_conversations_title")
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.user_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("conversation_id"),
    )
    op.create_index(
        "ix_conversations_user_updated_at",
        "conversations",
        ["user_id", "updated_at", "conversation_id"],
    )
    op.create_table(
        "conversation_turns",
        sa.Column("turn_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("result", JSONB(), nullable=True),
        sa.Column("safe_error", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'answered', 'failed', 'cancelled')",
            name=op.f("ck_conversation_turns_status"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(question)) BETWEEN 1 AND 2000",
            name=op.f("ck_conversation_turns_question"),
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["conversations.conversation_id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("turn_id"),
    )
    op.create_index(
        "ix_conversation_turns_conversation_created",
        "conversation_turns",
        ["conversation_id", "created_at"],
    )


def downgrade() -> None:
    connection = op.get_bind()
    has_history = connection.scalar(sa.text("SELECT EXISTS (SELECT 1 FROM conversations)"))
    if has_history:
        raise RuntimeError("cannot downgrade while conversation history exists")
    op.drop_index("ix_conversation_turns_conversation_created", table_name="conversation_turns")
    op.drop_table("conversation_turns")
    op.drop_index("ix_conversations_user_updated_at", table_name="conversations")
    op.drop_table("conversations")
