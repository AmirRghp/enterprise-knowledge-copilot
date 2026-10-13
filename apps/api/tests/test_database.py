"""Targeted checks for the isolated database layer.

Unit checks always run. The integration section talks to the isolated
``enterprise_knowledge_copilot_test`` database only; TESTING.md and DATABASE.md
forbid running tests against the pre-existing database or the application
database, so every live check pins the test database explicitly.

Skip policy: only the ability to *connect* may skip a test, and the decision is
delegated to :func:`is_connection_failure`. Once the connection gate has passed,
no exception is caught, so a schema or query failure fails the test instead of
hiding behind a skip. ``test_connection_failure_classifier_*`` pins that
distinction in both directions so the policy cannot silently regress.
"""

import asyncio
from collections.abc import Coroutine
from pathlib import Path
from typing import Any, Self, get_args

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from pydantic import SecretStr
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncEngine

from app.db import engine as db_engine
from app.db import preflight as db_preflight
from app.db import url as db_url
from app.db.base import Base
from app.settings import Settings

CONNECTION_ERROR_TEXT = "connection was closed in the middle of a query"

ALEMBIC_INI = Path(__file__).resolve().parents[1] / "alembic.ini"


def _expected_head() -> str:
    """Return the head revision the repository declares.

    Read from the migration scripts rather than written out here, so a new revision
    does not turn this assertion into a stale literal that has to be edited by hand -
    the check that matters is "the test database is at head", not "head is 0002".
    """
    return ScriptDirectory.from_config(Config(str(ALEMBIC_INI))).get_current_head() or ""


TEST_DATABASE = "enterprise_knowledge_copilot_test"
PROJECT_DATABASES = {"enterprise_knowledge_copilot", "enterprise_knowledge_copilot_test"}
EXPECTED_TABLES = {
    "provider_configs",
    "provider_chains",
    "users",
    "sessions",
    "documents",
    "ingestion_jobs",
    "sections",
    "chunks",
    "request_runs",
    "embedding_reindex_jobs",
    "embedding_reindex_vectors",
}


def _settings(database: str = TEST_DATABASE) -> Settings:
    return Settings(db_name=database)


# --- unit: the allowlist is enforced before a URL is ever built ---


def test_url_targets_the_configured_project_database() -> None:
    url = db_url.build_database_url(_settings())
    assert url.drivername == "postgresql+asyncpg"
    assert url.database == TEST_DATABASE
    assert url.port == 5433


def test_url_refuses_a_database_outside_the_allowlist() -> None:
    config = Settings.model_construct(
        db_name="rag_support",
        db_host="127.0.0.1",
        db_port=5433,
        db_user="enterprise_knowledge_copilot",
        db_password=SecretStr(""),
    )
    with pytest.raises(db_url.DatabaseNotAllowedError):
        db_url.build_database_url(config)


def test_url_allowlist_matches_the_typed_setting() -> None:
    literal_values = set(get_args(Settings.model_fields["db_name"].annotation))
    assert db_url.PROJECT_DATABASES == PROJECT_DATABASES | {"enterprise-pgvector"}
    assert db_url.PROJECT_DATABASES <= literal_values


def test_missing_password_is_not_sent_as_a_literal() -> None:
    config = Settings.model_construct(
        db_name=TEST_DATABASE,
        db_host="127.0.0.1",
        db_port=5433,
        db_user="enterprise_knowledge_copilot",
        db_password=SecretStr(""),
    )
    assert db_url.build_database_url(config).password is None


def test_metadata_defines_exactly_the_documented_tables() -> None:
    assert set(Base.metadata.tables) == EXPECTED_TABLES


# --- unit: the pgvector prerequisite fails closed with an actionable message ---


class _ScalarProbe:
    """Minimal stand-in for a Connection returning a single scalar."""

    def __init__(self, installed: bool) -> None:
        self._installed = installed

    def execute(self, _statement: object) -> Self:
        return self

    def scalar(self) -> int | None:
        return 1 if self._installed else None


def test_vector_extension_guard_fails_closed_when_missing() -> None:
    with pytest.raises(RuntimeError, match="sql/provision.sql"):
        db_preflight.require_vector_extension(_ScalarProbe(installed=False))  # type: ignore[arg-type]


def test_vector_extension_guard_passes_when_present() -> None:
    db_preflight.require_vector_extension(_ScalarProbe(installed=True))  # type: ignore[arg-type]


# --- skip policy: only connection loss may skip, never a query or schema fault ---


def is_connection_failure(error: BaseException) -> bool:
    """Report whether ``error`` means the server could not be reached.

    Deliberately narrow. SQLAlchemy wraps connection loss in
    ``OperationalError`` but also routes genuine SQL faults such as a missing
    relation through ``DBAPIError``, so the classification keys on the driver
    cause being an OS-level connection error or on the connection being marked
    invalidated. A ``ProgrammingError`` (undefined table/column) is a schema
    fault and must never be treated as a skip.
    """
    if isinstance(error, (ConnectionError, TimeoutError, OSError)):
        return True
    if isinstance(error, ProgrammingError):
        return False
    if isinstance(error, DBAPIError):
        if error.connection_invalidated:
            return True
        return isinstance(error.orig, (ConnectionError, TimeoutError, OSError))
    return False


def _skip_unreachable(error: BaseException) -> None:
    """Skip only when the isolated database cannot be reached at all."""
    pytest.skip(f"isolated test database unavailable: {type(error).__name__}")


def test_connection_failure_classifier_treats_connection_loss_as_skip() -> None:
    lost = OperationalError("SELECT 1", {}, Exception(CONNECTION_ERROR_TEXT))
    lost.connection_invalidated = True
    assert is_connection_failure(lost) is True
    assert is_connection_failure(ConnectionRefusedError(111, "refused")) is True


def test_connection_failure_classifier_treats_query_fault_as_failure() -> None:
    undefined_table = ProgrammingError(
        "SELECT 1", {}, Exception('relation "ekc_absent_table" does not exist')
    )
    assert is_connection_failure(undefined_table) is False
    assert is_connection_failure(ValueError("not a database error")) is False


# --- integration: real connection and schema against the isolated test database ---


def _live_engine() -> AsyncEngine:
    config = _settings()
    # Guard rail: a test run must never reach the application database.
    assert config.db_name == TEST_DATABASE
    return db_engine.create_engine(config)


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop, then close it cleanly.

    Every async step for a test lives in one coroutine because an asyncpg
    connection is bound to the loop that created it; reusing an engine across two
    ``asyncio.run`` calls detaches the connection from its loop.
    """
    return asyncio.run(coroutine)


async def _connected_engine() -> AsyncEngine:
    """Return an engine to the isolated test database, skipping if unreachable."""
    config = _settings()
    # Guard rail: a test run must never reach the application database.
    assert config.db_name == TEST_DATABASE
    probe = db_engine.create_engine(config)
    try:
        async with probe.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as error:  # noqa: BLE001  narrowed to connection loss below
        await probe.dispose()
        if is_connection_failure(error):
            _skip_unreachable(error)
        raise
    return probe


def test_test_database_is_reachable_and_migrated() -> None:
    async def scenario() -> tuple[set[str], str, str]:
        probe = await _connected_engine()
        try:
            async with probe.connect() as connection:
                tables = await connection.execute(
                    text(
                        "SELECT tablename FROM pg_tables "
                        "WHERE schemaname = 'public' AND tablename <> 'alembic_version'"
                    )
                )
                version = await connection.execute(text("SELECT version_num FROM alembic_version"))
                embedding = await connection.execute(
                    text(
                        "SELECT format_type(a.atttypid, a.atttypmod) "
                        "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid "
                        "WHERE c.relname = 'chunks' AND a.attname = 'embedding'"
                    )
                )
                return (
                    set(tables.scalars().all()),
                    str(version.scalar_one()),
                    str(embedding.scalar_one()),
                )
        finally:
            await probe.dispose()

    # No try/except around the assertions on purpose: a schema or query fault
    # must fail this test rather than be reported as a skip.
    tables, revision, embedding_type = _run(scenario())

    assert revision == _expected_head()
    assert tables == EXPECTED_TABLES
    assert embedding_type == "vector"


def test_query_fault_fails_instead_of_skipping() -> None:
    """A query against a missing relation must surface as a failure, not a skip."""

    async def scenario() -> None:
        probe = await _connected_engine()
        try:
            async with probe.connect() as connection:
                await connection.execute(text("SELECT * FROM ekc_absent_relation"))
        finally:
            await probe.dispose()

    with pytest.raises(ProgrammingError):
        _run(scenario())
