"""Async engine and session factory for the isolated project database.

Only this module constructs engines, so the allowlist in ``app.db.url`` cannot
be bypassed by a caller that builds its own URL.
"""

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.db.url import build_database_url
from app.settings import Settings


def create_engine(settings: Settings) -> AsyncEngine:
    """Create the async engine; ``pool_pre_ping`` guards against stale connections."""
    return create_async_engine(build_database_url(settings), pool_pre_ping=True)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Create the session factory used by request and worker scopes."""
    return async_sessionmaker(engine, expire_on_commit=False)
