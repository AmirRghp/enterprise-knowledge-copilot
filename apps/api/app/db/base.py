"""Declarative base with deterministic constraint names.

Explicit naming keeps Alembic autogenerate output stable and lets integrity
checks reference constraints by name. DATABASE.md section 5 requires named
CHECK constraints, so the ``ck`` convention depends on ``constraint_name``.
"""

from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    """Base for every project table; ``app.db.models`` owns the definitions."""

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
