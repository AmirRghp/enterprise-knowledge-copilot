"""Prevent duplicate normalized account logins without changing existing users."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005"
down_revision: str | Sequence[str] | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Hold the table against writes between the collision check and index creation.
    op.execute("LOCK TABLE users IN SHARE MODE")
    collision = op.get_bind().scalar(
        sa.text(
            "SELECT EXISTS (SELECT 1 FROM users GROUP BY lower(trim(login)) HAVING count(*) > 1)"
        )
    )
    if collision:
        raise RuntimeError("normalized account logins conflict; resolve before upgrading")
    op.create_index(
        "ix_users_normalized_login", "users", [sa.text("lower(TRIM(BOTH FROM login))")], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_users_normalized_login", table_name="users")
