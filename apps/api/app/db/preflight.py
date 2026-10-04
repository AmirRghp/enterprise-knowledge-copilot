"""Prerequisite checks the migration environment depends on.

These live outside ``alembic/env.py`` so they stay importable and unit-testable;
loading the Alembic environment module directly would execute its migration
entry point and require an established Alembic application context.
"""

from sqlalchemy import Connection, text

PROVISIONING_HINT = (
    "pgvector extension 'vector' is missing in the target database. "
    "Run apps/api/sql/provision.sql as the existing server superuser first; "
    "see DATABASE.md section 1."
)


def require_vector_extension(connection: Connection) -> None:
    """Fail with an actionable message when pgvector is not installed.

    The extension is a cluster prerequisite provisioned once by the operator, so
    this fails closed instead of silently creating it under the least-privilege
    application role.
    """
    installed = connection.execute(
        text("SELECT 1 FROM pg_extension WHERE extname = 'vector'")
    ).scalar()
    if installed is None:
        raise RuntimeError(PROVISIONING_HINT)
