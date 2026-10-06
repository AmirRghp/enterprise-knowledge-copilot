"""add staged replacement policy to documents

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-06

Adds the two columns Part 10 needs, and only those.

Notes for reviewers:

- ``documents.access_role`` is the *effective* policy of the current revision, and
  ``documents.title`` is its title. On a replacement neither may hold a value that
  belongs to a revision that has not been activated yet.
- ``staged_access_role`` holds the pending policy. Narrowing access is applied to
  ``access_role`` immediately (SECURITY.md section 2), so it cannot double as the
  staging slot; widening is applied only at activation, so a newly permitted user
  cannot see the previous revision before the new one is ready (ARCHITECTURE.md
  section 6).
- ``staged_title`` holds the pending title for the same reason: applying it early
  would leave a document labelled with the new name while still serving the old
  text if the replacement failed.
- Both columns are nullable and additive, so existing rows and existing consumers
  stay valid. NULL simply means "no replacement is in flight". The effective values
  are cleared only at activation or when a replacement fails.
- Constraint names are wrapped in ``op.f`` so the ``ck_`` convention in
  ``app.db.base`` is applied exactly once, in both directions.
- DATABASE.md section 5 counts the CHECK constraints in the schema; this revision
  adds two, taking that count from 20 to 22.
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_STAGED_ROLE_CONSTRAINT = "ck_documents_staged_access_role"
_STAGED_TITLE_CONSTRAINT = "ck_documents_staged_title_not_blank"


def upgrade() -> None:
    op.add_column("documents", sa.Column("staged_access_role", sa.Text(), nullable=True))
    op.add_column("documents", sa.Column("staged_title", sa.Text(), nullable=True))
    op.create_check_constraint(
        op.f(_STAGED_ROLE_CONSTRAINT),
        "documents",
        "staged_access_role IS NULL OR staged_access_role IN ('employee', 'manager')",
    )
    op.create_check_constraint(
        op.f(_STAGED_TITLE_CONSTRAINT),
        "documents",
        "staged_title IS NULL OR btrim(staged_title) <> ''",
    )


def downgrade() -> None:
    op.drop_constraint(op.f(_STAGED_TITLE_CONSTRAINT), "documents", type_="check")
    op.drop_constraint(op.f(_STAGED_ROLE_CONSTRAINT), "documents", type_="check")
    op.drop_column("documents", "staged_title")
    op.drop_column("documents", "staged_access_role")
