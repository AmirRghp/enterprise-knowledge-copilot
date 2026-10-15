"""Persist manager-controlled request and provider capacity limits."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "rate_limit_settings",
        sa.Column("singleton", sa.Boolean(), nullable=False),
        sa.Column("requests_per_user_per_minute", sa.Integer(), nullable=False),
        sa.Column("ollama_concurrency", sa.Integer(), nullable=False),
        sa.Column("cloud_concurrency", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("singleton", name=op.f("ck_rate_limit_settings_singleton")),
        sa.CheckConstraint(
            "requests_per_user_per_minute BETWEEN 1 AND 1000",
            name=op.f("ck_rate_limit_settings_requests_range"),
        ),
        sa.CheckConstraint(
            "ollama_concurrency BETWEEN 1 AND 100",
            name=op.f("ck_rate_limit_settings_ollama_concurrency_range"),
        ),
        sa.CheckConstraint(
            "cloud_concurrency BETWEEN 1 AND 100",
            name=op.f("ck_rate_limit_settings_cloud_concurrency_range"),
        ),
        sa.CheckConstraint("version >= 1", name=op.f("ck_rate_limit_settings_version_positive")),
        sa.PrimaryKeyConstraint("singleton"),
    )
    op.execute(
        sa.text(
            "INSERT INTO rate_limit_settings "
            "(singleton, requests_per_user_per_minute, ollama_concurrency, "
            "cloud_concurrency, version) "
            "VALUES (true, 6, 1, 6, 1)"
        )
    )


def downgrade() -> None:
    connection = op.get_bind()
    has_custom_settings = connection.scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM rate_limit_settings "
            "WHERE requests_per_user_per_minute <> 6 OR ollama_concurrency <> 1 "
            "OR cloud_concurrency <> 6 OR version <> 1)"
        )
    )
    if has_custom_settings:
        raise RuntimeError("cannot downgrade while manager-edited rate limits exist")
    op.drop_table("rate_limit_settings")
