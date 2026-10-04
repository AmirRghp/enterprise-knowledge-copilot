"""Alembic environment for the isolated project database.

The URL comes from the typed ``DB_*`` settings and is allowlist-checked by
``app.db.url`` before the engine is created, so a migration can never run
against another project's database. Migrations are async because the
application engine is async; Alembic drives it through ``run_sync``.

The ``vector`` extension is a cluster prerequisite created once by the operator
provisioning step, not by this environment. ``app.db.preflight`` verifies it and
fails with an actionable message when it is missing.
"""

import asyncio
from logging.config import fileConfig

from sqlalchemy import Connection
from sqlalchemy.ext.asyncio import create_async_engine

from alembic import context
from app.db import models  # noqa: F401  imported so autogenerate sees every table
from app.db.base import Base
from app.db.preflight import require_vector_extension
from app.db.url import build_database_url
from app.settings import load_settings

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def do_run_migrations(connection: Connection) -> None:
    require_vector_extension(connection)
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_offline() -> None:
    context.configure(
        url=build_database_url(load_settings()),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    engine = create_async_engine(build_database_url(load_settings()), pool_pre_ping=True)
    try:
        # engine.begin() commits on success and rolls back on failure. A plain
        # engine.connect() would leave the DDL in an uncommitted transaction that
        # SQLAlchemy discards when the block exits.
        async with engine.begin() as connection:
            await connection.run_sync(do_run_migrations)
    finally:
        await engine.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
