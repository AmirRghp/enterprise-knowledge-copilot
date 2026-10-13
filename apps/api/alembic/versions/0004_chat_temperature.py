"""Persist per-chat sampling temperature, preserving existing connections."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004"
down_revision: str | Sequence[str] | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("provider_configs", sa.Column("temperature", sa.Float(), nullable=True))
    # Previous probes and in-flight snapshots did not include this sampling parameter.
    op.execute(
        "UPDATE provider_configs SET temperature=0.7, test_status=NULL, tested_at=NULL, "
        "config_version=config_version+1 WHERE purpose='chat'"
    )
    op.execute(
        "UPDATE provider_chains SET version=version+1 WHERE purpose='chat' "
        "AND EXISTS (SELECT 1 FROM provider_configs WHERE purpose='chat')"
    )
    op.create_check_constraint(
        op.f("ck_provider_configs_temperature"),
        "provider_configs",
        "(purpose = 'chat' AND temperature IS NOT NULL AND temperature BETWEEN 0 AND 2) "
        "OR (purpose <> 'chat' AND temperature IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_provider_configs_temperature"), "provider_configs", type_="check")
    op.drop_column("provider_configs", "temperature")
