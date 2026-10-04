"""Operator-only seeding of the two sample accounts.

Accounts exist only because DATABASE.md section 12 requires two seeded roles for
local demonstration. There is no public registration and no role promotion
through the API. Passwords come from ``SEED_EMPLOYEE_PASSWORD`` and
``SEED_MANAGER_PASSWORD`` and are never written to a file, a log, or the database
in the clear.
"""

import asyncio
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.auth.service import hash_password
from app.db.models import User
from app.domain.models import Role
from app.settings import Settings, load_settings

SEED_ACCOUNTS: tuple[tuple[str, str, Role], ...] = (
    ("employee", "seed_employee_password", "employee"),
    ("manager", "seed_manager_password", "manager"),
)


class SeedConfigurationError(Exception):
    """Raised when a seed password is missing or too weak to accept."""


# 12 is the common minimum for a demonstrable local account; short values are
# rejected outright rather than silently accepted.
MIN_PASSWORD_LENGTH = 12


def _engine(settings: Settings) -> AsyncEngine:
    from app.db.engine import create_engine  # noqa: PLC0415

    return create_engine(settings)


async def seed_accounts(settings: Settings) -> list[str]:
    """Create or refresh the two sample accounts and return their logins.

    Passwords are always re-hashed so a rotated environment value takes effect.
    The existing ``user_id`` is preserved so sessions and future ownership
    references stay valid.
    """
    for _, secret_name, _ in SEED_ACCOUNTS:
        if len(getattr(settings, secret_name).get_secret_value()) < MIN_PASSWORD_LENGTH:
            raise SeedConfigurationError(
                f"{secret_name} must be at least {MIN_PASSWORD_LENGTH} characters"
            )
    engine = _engine(settings)
    created: list[str] = []
    try:
        # The session owns its transaction here. Wrapping an AsyncSession over an
        # engine.begin() connection and never committing would let the block exit
        # without flushing pending rows, so the session commits explicitly.
        async with AsyncSession(engine, expire_on_commit=False) as session:
            now = datetime.now(UTC)
            for login, secret_name, role in SEED_ACCOUNTS:
                password = getattr(settings, secret_name).get_secret_value()
                result = await session.execute(select(User).where(User.login == login))
                user = result.scalar_one_or_none()
                password_hash = hash_password(password)

                if user is None:
                    session.add(
                        User(
                            login=login,
                            password_hash=password_hash,
                            role=role,
                            is_active=True,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                else:
                    user.password_hash = password_hash
                    user.role = role
                    user.is_active = True
                    user.updated_at = now

                created.append(login)

            await session.commit()
    finally:
        await engine.dispose()
    return created


def main() -> None:
    """Entry point for ``python -m app.cli.seed_accounts``."""
    settings = load_settings()
    logins = asyncio.run(seed_accounts(settings))
    print(f"seeded {len(logins)} accounts: {', '.join(logins)}")


if __name__ == "__main__":
    main()
