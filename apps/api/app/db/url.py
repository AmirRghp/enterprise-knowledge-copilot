"""Connection URL assembly behind an explicit database allowlist.

ARCHITECTURE.md section 3 forbids ``DATABASE_URL`` as a project contract, so the
URL is always composed from the typed ``DB_*`` settings. The allowlist is
re-checked here because this is the boundary that actually opens a socket, and
DATABASE.md section 11 requires the database name be verified before any
connection or migration runs.
"""

from sqlalchemy.engine import URL

from app.settings import Settings

PROJECT_DATABASES = frozenset({"enterprise_knowledge_copilot", "enterprise_knowledge_copilot_test"})


class DatabaseNotAllowedError(RuntimeError):
    """Raised when configuration targets a database outside the project."""


def build_database_url(settings: Settings) -> URL:
    """Compose the asyncpg URL for the configured project database."""
    if settings.db_name not in PROJECT_DATABASES:
        raise DatabaseNotAllowedError("DB_NAME must target an isolated project database")
    password = settings.db_password.get_secret_value()
    return URL.create(
        drivername="postgresql+asyncpg",
        username=settings.db_user,
        password=password or None,
        host=settings.db_host,
        port=settings.db_port,
        database=settings.db_name,
    )
