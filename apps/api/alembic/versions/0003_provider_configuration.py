"""Encrypted manager provider configuration; no provider is seeded."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003"
down_revision: str | Sequence[str] | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "provider_chains",
        sa.Column("purpose", sa.Text(), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("embedding_digest", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "purpose IN ('chat', 'rerank', 'embedding')", name=op.f("ck_provider_chains_purpose")
        ),
    )
    op.execute(
        "INSERT INTO provider_chains (purpose, version, enabled, embedding_digest) "
        "VALUES ('chat',0,false,''),('rerank',0,false,''),('embedding',0,false,'')"
    )
    op.create_table(
        "provider_configs",
        sa.Column("provider_id", sa.Uuid(), primary_key=True),
        sa.Column("purpose", sa.Text(), sa.ForeignKey("provider_chains.purpose"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=False),
        sa.Column("base_url", sa.Text(), nullable=False),
        sa.Column("api_key_encrypted", sa.LargeBinary(), nullable=True),
        sa.Column("expected_digest", sa.Text(), nullable=False),
        sa.Column("config_version", sa.Integer(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("test_status", sa.Text(), nullable=True),
        sa.Column("tested_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "kind IN ('ollama', 'openai', 'openai_compatible', 'openrouter')",
            name=op.f("ck_provider_configs_kind"),
        ),
        sa.CheckConstraint(
            "char_length(btrim(name)) BETWEEN 1 AND 100", name=op.f("ck_provider_configs_name")
        ),
        sa.CheckConstraint("priority >= 0", name=op.f("ck_provider_configs_priority")),
        sa.UniqueConstraint(
            "purpose",
            "priority",
            deferrable=True,
            initially="DEFERRED",
            name=op.f("uq_provider_configs_purpose_priority"),
        ),
    )


def downgrade() -> None:
    op.drop_table("provider_configs")
    op.drop_table("provider_chains")
