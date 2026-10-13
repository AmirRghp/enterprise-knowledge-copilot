"""Add separate names while preserving accounts whose names are not yet known."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006"
down_revision: str | Sequence[str] | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    for field in ("first_name", "last_name"):
        op.add_column("users", sa.Column(field, sa.Text(), nullable=True))
        op.create_check_constraint(
            op.f(f"ck_users_{field}"),
            "users",
            f"{field} IS NULL OR char_length(btrim({field})) BETWEEN 1 AND 100",
        )


def downgrade() -> None:
    for field in ("last_name", "first_name"):
        op.drop_constraint(op.f(f"ck_users_{field}"), "users", type_="check")
        op.drop_column("users", field)
