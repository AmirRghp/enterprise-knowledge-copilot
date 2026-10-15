"""One-time installation and manager-owned accounts."""

from typing import Annotated, Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.api.auth import (
    _cookie_secure,
    _require_origin,
    get_engine,
    get_session_factory,
    get_settings,
)
from app.auth import accounts, service
from app.db.models import OrganizationSettings, User
from app.domain.models import Actor

router = APIRouter(prefix="/api", tags=["accounts"])


class UserResponse(BaseModel):
    user_id: str
    login: str
    role: str
    is_active: bool
    created_at: str
    first_name: str | None
    last_name: str | None


class UserListResponse(BaseModel):
    users: list[UserResponse]
    total: int
    page: int


class SetupResponse(BaseModel):
    setup_required: bool


def public(user: User) -> UserResponse:
    return UserResponse(
        user_id=str(user.user_id),
        login=user.login,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at.isoformat(),
        first_name=user.first_name,
        last_name=user.last_name,
    )


def factory(request: Request) -> Any:
    return get_session_factory(request, get_engine(request))


async def manager(request: Request) -> Actor:
    actor = await service.resolve_actor(
        factory(request), request.cookies.get(service.SESSION_COOKIE_NAME)
    )
    if actor is None:
        raise HTTPException(401, "authentication required")
    if actor.role != "manager":
        raise HTTPException(403, "manager role required")
    return actor


def error(exc: accounts.AccountError) -> HTTPException:
    return HTTPException(exc.status, exc.detail)


@router.get("/auth/setup", response_model=SetupResponse)
async def setup_status(request: Request, response: Response) -> SetupResponse:
    response.headers["Cache-Control"] = "no-store"
    async with factory(request)() as session:
        exists = await session.scalar(select(User.user_id).limit(1))
    return SetupResponse(setup_required=exists is None)


@router.post("/auth/setup", status_code=201)
async def setup(request: Request, response: Response) -> dict[str, str]:
    settings = get_settings()
    _require_origin(request, settings)
    # Count before parsing or hashing; forwarding headers do not supply a trusted IP.
    retry = request.app.state.login_rate_limiter.retry_after(
        request.client.host if request.client else "unknown", "setup"
    )
    if retry is not None:
        raise HTTPException(429, "too many setup attempts", headers={"Retry-After": str(retry)})
    payload = await body(request, accounts.SetupInput)
    hashed = await accounts.hash_new_password(payload.password, request.app.state.password_limiter)
    async with factory(request)() as session:
        try:
            user = await accounts.create_user(
                session,
                payload.email,
                hashed,
                "manager",
                None,
                first_name=payload.first_name,
                last_name=payload.last_name,
            )
            updated = await session.execute(
                update(OrganizationSettings)
                .where(OrganizationSettings.singleton.is_(True))
                .values(name=payload.organization_name, updated_at=func.clock_timestamp())
            )
            if updated.rowcount != 1:
                raise HTTPException(503, "organization settings unavailable")
            token = await service.issue_session(
                session,
                user,
                settings.session_ttl_seconds,
                previous_token=request.cookies.get(service.SESSION_COOKIE_NAME),
            )
        except accounts.AccountError as exc:
            raise error(exc) from exc
        except IntegrityError as exc:
            raise HTTPException(409, "account already exists") from exc
    response.set_cookie(
        service.SESSION_COOKIE_NAME,
        token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(settings),
        path="/",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"login": user.login, "role": user.role}


async def body[Input: BaseModel](request: Request, model: type[Input]) -> Input:
    from pydantic import ValidationError  # noqa: PLC0415

    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "application/json required")
    try:
        return model.model_validate_json(await request.body())
    except ValidationError as exc:
        # Validation messages and inputs can contain the password or email.
        raise HTTPException(422, "invalid account input") from exc


@router.get("/manager/users", response_model=UserListResponse)
async def list_users(
    request: Request, response: Response, page: Annotated[int, Query(ge=1, le=1_000_000)] = 1
) -> UserListResponse:
    actor = await manager(request)
    async with factory(request)() as session:
        try:
            await accounts.lock_accounts(session)
            await accounts.require_live_manager(session, actor)
        except accounts.AccountError as exc:
            raise error(exc) from exc
        total = await session.scalar(select(func.count()).select_from(User))
        users = (
            await session.scalars(
                select(User)
                .order_by(User.created_at, User.user_id)
                .offset((page - 1) * 50)
                .limit(50)
            )
        ).all()
    response.headers["Cache-Control"] = "no-store"
    return UserListResponse(users=[public(user) for user in users], total=total or 0, page=page)


@router.post("/manager/users", response_model=UserResponse, status_code=201)
async def create_user(request: Request) -> UserResponse:
    _require_origin(request, get_settings())
    actor = await manager(request)
    payload = await body(request, accounts.CreateUserInput)
    hashed = await accounts.hash_new_password(payload.password, request.app.state.password_limiter)
    async with factory(request)() as session:
        try:
            user = await accounts.create_user(
                session,
                payload.email,
                hashed,
                payload.role,
                actor,
                first_name=payload.first_name,
                last_name=payload.last_name,
            )
            await session.commit()
        except accounts.AccountError as exc:
            raise error(exc) from exc
        except IntegrityError as exc:
            raise HTTPException(409, "account already exists") from exc
    return public(user)


@router.patch("/manager/users/{user_id}", response_model=UserResponse)
async def update_user(request: Request, user_id: UUID) -> UserResponse:
    _require_origin(request, get_settings())
    actor = await manager(request)
    payload = await body(request, accounts.UpdateUserInput)
    hashed = (
        await accounts.hash_new_password(payload.password, request.app.state.password_limiter)
        if payload.password is not None
        else None
    )
    async with factory(request)() as session:
        try:
            user = await accounts.change_user(
                session, actor, user_id, changes=payload, password_hash=hashed
            )
        except accounts.AccountError as exc:
            raise error(exc) from exc
        except IntegrityError as exc:
            raise HTTPException(409, "account already exists") from exc
    return public(user)


@router.put("/manager/users/{user_id}/password", status_code=204)
async def password(request: Request, user_id: UUID) -> Response:
    _require_origin(request, get_settings())
    actor = await manager(request)
    payload = await body(request, accounts.PasswordInput)
    hashed = await accounts.hash_new_password(payload.password, request.app.state.password_limiter)
    async with factory(request)() as session:
        try:
            await accounts.change_user(session, actor, user_id, password_hash=hashed)
        except accounts.AccountError as exc:
            raise error(exc) from exc
    return Response(status_code=204)
