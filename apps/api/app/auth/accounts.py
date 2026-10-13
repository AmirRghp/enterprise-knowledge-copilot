"""Account writes serialized with setup and the last-manager check."""

import re
from datetime import UTC, datetime
from uuid import UUID

from anyio import CapacityLimiter, to_thread
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.service import hash_password
from app.db.models import Session, User
from app.domain.models import Actor, Role

ACCOUNT_LOCK = 220022


def normalized_login(login: str) -> str:
    return login.strip().lower() if "@" in login else login


class PasswordInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    password: str = Field(min_length=12, max_length=512, repr=False)


class SetupInput(PasswordInput):
    email: str = Field(max_length=200)
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)

    @field_validator("first_name", "last_name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name is required")
        return value

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str) -> str:
        value = value.strip().lower()
        local, separator, domain = value.partition("@")
        labels = domain.split(".")
        if (
            not separator
            or not re.fullmatch(r"[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}", local)
            or local.startswith(".")
            or local.endswith(".")
            or ".." in local
            or len(labels) < 2
            or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", x) for x in labels)
        ):
            raise ValueError("invalid email")
        return value


class CreateUserInput(SetupInput):
    role: Role


class UpdateUserInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    role: Role | None = None
    is_active: StrictBool | None = None
    email: str | None = Field(default=None, max_length=200)
    first_name: str | None = Field(default=None, min_length=1, max_length=100)
    last_name: str | None = Field(default=None, min_length=1, max_length=100)
    password: str | None = Field(default=None, min_length=12, max_length=512, repr=False)

    @field_validator("email")
    @classmethod
    def valid_email(cls, value: str | None) -> str | None:
        return SetupInput.valid_email(value) if value is not None else None

    @field_validator("first_name", "last_name")
    @classmethod
    def valid_name(cls, value: str | None) -> str | None:
        return SetupInput.valid_name(value) if value is not None else None

    @model_validator(mode="after")
    def supplied_changes(self) -> "UpdateUserInput":
        if not self.model_fields_set or any(
            getattr(self, field) is None for field in self.model_fields_set
        ):
            raise ValueError("at least one non-null change is required")
        return self


class AccountError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        self.status = status
        self.detail = detail
        super().__init__(detail)


async def hash_new_password(password: str, limiter: CapacityLimiter) -> str:
    return await to_thread.run_sync(hash_password, password, limiter=limiter)


async def lock_accounts(session: AsyncSession) -> None:
    await session.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": ACCOUNT_LOCK})


async def require_live_manager(session: AsyncSession, actor: Actor) -> None:
    allowed = await session.scalar(
        select(User.user_id)
        .join(Session, Session.user_id == User.user_id)
        .where(
            User.user_id == actor.user_id,
            User.is_active.is_(True),
            User.role == "manager",
            Session.session_id == actor.session_id,
            Session.revoked_at.is_(None),
            Session.expires_at > func.clock_timestamp(),
        )
    )
    if allowed is None:
        raise AccountError(403, "manager role required")


async def create_user(
    session: AsyncSession,
    email: str,
    password_hash: str,
    role: Role,
    actor: Actor | None,
    *,
    first_name: str,
    last_name: str,
) -> User:
    await lock_accounts(session)
    if actor is None:
        if await session.scalar(select(User.user_id).limit(1)) is not None:
            raise AccountError(409, "setup is already complete")
    else:
        await require_live_manager(session, actor)
    user = User(
        login=email,
        password_hash=password_hash,
        role=role,
        is_active=True,
        first_name=first_name,
        last_name=last_name,
    )
    session.add(user)
    await session.flush()
    return user


async def change_user(
    session: AsyncSession,
    actor: Actor,
    user_id: UUID,
    *,
    changes: UpdateUserInput | None = None,
    password_hash: str | None = None,
) -> User:
    await lock_accounts(session)
    await require_live_manager(session, actor)
    user = await session.scalar(select(User).where(User.user_id == user_id).with_for_update())
    if user is None:
        raise AccountError(404, "account not found")
    role = changes.role if changes and changes.role is not None else user.role
    active = changes.is_active if changes and changes.is_active is not None else user.is_active
    if user.role == "manager" and user.is_active and (role != "manager" or not active):
        managers = await session.scalar(
            select(func.count())
            .select_from(User)
            .where(User.role == "manager", User.is_active.is_(True))
        )
        if managers == 1:
            raise AccountError(409, "last active manager cannot be removed")
    login = changes.email if changes and changes.email is not None else user.login
    revoke = (
        role != user.role
        or active != user.is_active
        or login != user.login
        or password_hash is not None
    )
    changed = revoke
    user.role = role
    user.is_active = active
    user.login = login
    if changes:
        for field in ("first_name", "last_name"):
            value = getattr(changes, field)
            if value is not None and value != getattr(user, field):
                setattr(user, field, value)
                changed = True
    if password_hash is not None:
        user.password_hash = password_hash
    if changed:
        user.updated_at = datetime.now(UTC)
    # The unique email must succeed before session revocation; failures roll everything back.
    await session.flush()
    if revoke:
        await session.execute(
            update(Session)
            .where(Session.user_id == user_id, Session.revoked_at.is_(None))
            .values(revoked_at=func.clock_timestamp())
        )
    await session.commit()
    return user
