"""Session issuing and actor resolution.

Security rules enforced here (SECURITY.md sections 1 and 2):

- Passwords are hashed with Argon2id and never stored or logged in the clear.
- The session cookie holds a random opaque token; only its hash is persisted, so
  a database leak does not yield usable cookies.
- Role and account activity are read from ``users`` on every request. Neither is
  cached in the session row nor accepted from the client.
- Logout revokes immediately, and login rotates the token so a pre-login cookie
  cannot survive a new sign-in.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from uuid import UUID

from anyio import CapacityLimiter, to_thread
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db.models import Session as SessionRow
from app.db.models import User
from app.domain.models import Actor, Role

SESSION_COOKIE_NAME = "ekc_session"
# 256 bits of entropy; the value is a base64url string safe in a cookie.
TOKEN_BYTES = 32


class InvalidCredentialsError(Exception):
    """Raised for any failed sign-in.

    The message is deliberately identical for an unknown login, a wrong password,
    and a disabled account so the endpoint cannot be used to enumerate accounts.
    """


class OriginNotAllowedError(Exception):
    """Raised when a state-changing request lacks a matching browser Origin."""


def hash_password(password: str) -> str:
    """Hash a password with Argon2id."""
    from pwdlib import PasswordHash  # noqa: PLC0415  keeps import cost off the health path

    return PasswordHash.recommended().hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against an Argon2id hash, never raising on bad input.

    A stored hash can be missing, truncated, or produced by another algorithm.
    Any of those must read as "does not match" so a damaged row cannot turn into
    a 500 on the login endpoint; it fails closed instead.
    """
    from pwdlib import PasswordHash  # noqa: PLC0415
    from pwdlib.exceptions import UnknownHashError  # noqa: PLC0415

    try:
        return PasswordHash.recommended().verify(password, password_hash)
    except (UnknownHashError, ValueError, TypeError):
        return False


def generate_session_token() -> str:
    """Return a fresh opaque session token."""
    return secrets.token_urlsafe(TOKEN_BYTES)


def hash_session_token(token: str) -> bytes:
    """Hash a session token for storage and lookup.

    SHA-256 is appropriate here because the token is high-entropy random, not a
    low-entropy password; a slow KDF would only add latency to every request.
    """
    return hashlib.sha256(token.encode("utf-8")).digest()


def expires_at_from(now: datetime, ttl_seconds: int) -> datetime:
    """Return the expiry for a session created at ``now``."""
    return now + timedelta(seconds=ttl_seconds)


async def authenticate(
    session: AsyncSession,
    login: str,
    password: str,
    *,
    password_limiter: CapacityLimiter | None = None,
) -> tuple[User, datetime]:
    """Return the user and creation time when credentials are valid.

    The password is always verified against a real hash, even for an unknown
    login, so response timing does not reveal whether the account exists.
    """
    from app.auth.accounts import normalized_login  # noqa: PLC0415

    login = normalized_login(login)
    predicate = func.lower(func.trim(User.login)) == login if "@" in login else User.login == login
    result = await session.execute(select(User).where(predicate))
    user = result.scalar_one_or_none()

    if user is None:
        # Verify against a dummy hash to keep the timing profile comparable.
        await to_thread.run_sync(verify_password, password, DUMMY_HASH, limiter=password_limiter)
        raise InvalidCredentialsError("invalid credentials")

    if not await to_thread.run_sync(
        verify_password, password, user.password_hash, limiter=password_limiter
    ):
        raise InvalidCredentialsError("invalid credentials")

    verified_hash = user.password_hash
    # A reset/deactivation racing the expensive password check must not issue a session.
    user = (
        await session.execute(
            select(User)
            .where(User.user_id == user.user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()
    if user is None or not user.is_active or user.password_hash != verified_hash:
        raise InvalidCredentialsError("invalid credentials")

    return user, datetime.now(UTC)


async def issue_session(
    session: AsyncSession,
    user: User,
    ttl_seconds: int,
    now: datetime | None = None,
    *,
    previous_token: str | None = None,
) -> str:
    """Create a session row and return the raw token to place in the cookie.

    The raw token is returned once and never stored; the row keeps only its hash.
    """
    moment = now or datetime.now(UTC)
    token = generate_session_token()
    if previous_token:
        # Revocation and insertion share the same transaction and commit.
        await session.execute(
            update(SessionRow)
            .where(
                SessionRow.token_hash == hash_session_token(previous_token),
                SessionRow.revoked_at.is_(None),
            )
            .values(revoked_at=moment)
        )
    row = SessionRow(
        user_id=user.user_id,
        token_hash=hash_session_token(token),
        created_at=moment,
        expires_at=expires_at_from(moment, ttl_seconds),
    )
    session.add(row)
    await session.commit()
    return token


async def revoke_session(session: AsyncSession, token: str, now: datetime | None = None) -> bool:
    """Revoke a session immediately. Returns whether a live session was revoked."""
    moment = now or datetime.now(UTC)
    result = await session.execute(
        update(SessionRow)
        .where(
            SessionRow.token_hash == hash_session_token(token),
            SessionRow.revoked_at.is_(None),
        )
        .values(revoked_at=moment)
        .returning(SessionRow.session_id)
    )
    revoked = result.first() is not None
    await session.commit()
    return revoked


async def resolve_actor(
    session_factory: async_sessionmaker[AsyncSession], token: str | None
) -> Actor | None:
    """Resolve a session cookie into an :class:`Actor`.

    Returns ``None`` for a missing, unknown, revoked, or expired cookie, and also
    when the owning account has since been deactivated. The role always comes from
    the ``users`` row, so a role change takes effect on the next request.
    """
    if not token:
        return None

    async with session_factory() as session:
        result = await session.execute(
            select(SessionRow, User)
            .join(User, User.user_id == SessionRow.user_id)
            .where(
                SessionRow.token_hash == hash_session_token(token),
                SessionRow.revoked_at.is_(None),
                SessionRow.expires_at > datetime.now(UTC),
                User.is_active.is_(True),
            )
        )
        row = result.one_or_none()

    if row is None:
        return None

    session_row, user = row
    return Actor(user_id=user.user_id, role=_role_of(user.role), session_id=session_row.session_id)


def _role_of(value: str) -> Role:
    """Narrow the stored role, failing closed on unexpected data."""
    from app.domain.models import is_valid_role  # noqa: PLC0415

    if not is_valid_role(value):
        raise ValueError("stored role is outside the permitted set")
    return value  # type: ignore[return-value]


def user_id_of(actor: Actor) -> UUID:
    """Return the authenticated user id; kept as an explicit accessor for clarity."""
    return actor.user_id


# A real Argon2id hash of a value nobody can log in with. Comparing against it
# keeps the unknown-login path's cost similar to the wrong-password path.
DUMMY_HASH = hash_password("ekc-invalid-credentials-sentinel")
