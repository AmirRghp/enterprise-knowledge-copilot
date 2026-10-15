"""Store the installation's organization name."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_ORGANIZATION_NAME = "فضای دانش سازمانی"


def upgrade() -> None:
    op.create_table(
        "organization_settings",
        sa.Column("singleton", sa.Boolean(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.CheckConstraint("singleton", name=op.f("ck_organization_settings_singleton")),
        sa.CheckConstraint(
            "char_length(btrim(name)) BETWEEN 1 AND 100", name=op.f("ck_organization_settings_name")
        ),
        sa.PrimaryKeyConstraint("singleton"),
    )
    op.execute(
        sa.text(
            "INSERT INTO organization_settings (singleton, name) VALUES (true, :name)"
        ).bindparams(name=DEFAULT_ORGANIZATION_NAME)
    )


def downgrade() -> None:
    connection = op.get_bind()
    customized = connection.scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM organization_settings WHERE name <> :name)"
        ).bindparams(name=DEFAULT_ORGANIZATION_NAME)
    )
    if customized:
        raise RuntimeError("cannot downgrade while the organization name is customized")
    op.drop_table("organization_settings")
