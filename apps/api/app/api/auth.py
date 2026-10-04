"""Authentication routes: login, logout, and current identity.

Public response bodies are limited to what the UI needs. No password material,
token, hash, or internal identifier is ever returned or logged.
"""

from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncEngine

from app.auth import service as auth_service
from app.auth.origin import OriginRejectedError, enforce_origin, is_allowed_origin
from app.auth.rate_limit import LoginRateLimiter
from app.db.engine import create_engine, create_session_factory
from app.domain.models import Actor
from app.settings import Settings, load_settings

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Generic messages: a caller must not learn whether a login exists.
INVALID_CREDENTIALS = "invalid credentials"
ORIGIN_REJECTED = "request origin is not allowed"


class LoginRequest(BaseModel):
    """Sign-in payload."""

    login: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=512)


class IdentityResponse(BaseModel):
    """Server-resolved identity; the role always originates from the users row."""

    user_id: str
    login: str
    role: str
    session_expires_at: str


class LoginResponse(BaseModel):
    """Sign-in result."""

    role: str
    login: str


def get_settings() -> Settings:
    return load_settings()


def get_engine(request: Request) -> AsyncEngine:
    """Return the process-wide engine, created once on first use."""
    engine = getattr(request.app.state, "db_engine", None)
    if engine is None:
        engine = create_engine(get_settings())
        request.app.state.db_engine = engine
    return engine


def get_session_factory(
    request: Request,
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> object:
    """Return the session factory bound to the request engine."""
    factory = getattr(request.app.state, "db_session_factory", None)
    if factory is None:
        factory = create_session_factory(engine)
        request.app.state.db_session_factory = factory
    return factory


def _cookie_secure(settings: Settings) -> bool:
    """Secure flag is set only for an https web origin (SECURITY.md section 1)."""
    return str(settings.web_origin).startswith("https://")


def _cookie_path() -> str:
    return "/"


def _require_origin(request: Request, settings: Settings) -> None:
    try:
        enforce_origin(request, settings)
    except OriginRejectedError as error:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail=ORIGIN_REJECTED
        ) from error


@router.post("/login", response_model=LoginResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> LoginResponse:
    """Create a session for valid credentials.

    Requires a matching browser Origin. A failed attempt returns one generic 401
    for an unknown login, a wrong password, and a disabled account alike.
    """
    _require_origin(request, settings)

    limiter: LoginRateLimiter = request.app.state.login_rate_limiter
    retry_after = limiter.retry_after(
        request.client.host if request.client else "unknown", payload.login
    )
    if retry_after is not None:
        raise HTTPException(
            status_code=429,
            detail="too many login attempts",
            headers={"Retry-After": str(retry_after)},
        )

    factory = get_session_factory(request, get_engine(request))
    async with factory() as session:  # type: ignore[operator]
        try:
            user, now = await auth_service.authenticate(
                session,
                payload.login,
                payload.password,
                password_limiter=request.app.state.password_limiter,
            )
        except auth_service.InvalidCredentialsError as error:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_CREDENTIALS
            ) from error

        # A new sign-in always rotates the token, so any pre-existing cookie is
        # superseded rather than reused.
        token = await auth_service.issue_session(
            session, user, settings.session_ttl_seconds, now, previous_token=ekc_session
        )

    response.set_cookie(
        auth_service.SESSION_COOKIE_NAME,
        token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        samesite="lax",
        secure=_cookie_secure(settings),
        path=_cookie_path(),
    )
    return LoginResponse(role=user.role, login=user.login)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> Response:
    """Revoke the current session immediately.

    Returns 204 whether or not a live session existed, so the endpoint cannot be
    used to probe cookie validity.
    """
    _require_origin(request, settings)

    if ekc_session:
        factory = get_session_factory(request, get_engine(request))
        async with factory() as session:  # type: ignore[operator]
            await auth_service.revoke_session(session, ekc_session)

    response.delete_cookie(
        auth_service.SESSION_COOKIE_NAME,
        path=_cookie_path(),
        secure=_cookie_secure(settings),
        httponly=True,
        samesite="lax",
    )
    response.status_code = status.HTTP_204_NO_CONTENT
    return response


@router.get("/me", response_model=IdentityResponse)
async def me(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> IdentityResponse:
    """Return the server-resolved identity for a valid session.

    Returns 401 for a missing, unknown, revoked, expired, or deactivated session.
    Any role sent by the client is ignored; there is no parameter to accept one.
    """
    factory = get_session_factory(request, get_engine(request))
    actor: Actor | None = await auth_service.resolve_actor(factory, ekc_session)  # type: ignore[arg-type]

    if actor is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required"
        )

    from sqlalchemy import select  # noqa: PLC0415

    from app.db.models import User  # noqa: PLC0415  avoids a module-level ORM import cycle

    async with factory() as session:  # type: ignore[operator]
        result = await session.execute(
            select(User.login, User.role).where(User.user_id == actor.user_id)
        )
        row = result.one_or_none()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="authentication required"
        )
    login_name, role = row

    from sqlalchemy import select as _select  # noqa: PLC0415

    from app.db.models import Session as SessionRow  # noqa: PLC0415

    async with factory() as session:  # type: ignore[operator]
        expiry = await session.execute(
            _select(SessionRow.expires_at).where(SessionRow.session_id == actor.session_id)
        )
        expires_at = expiry.scalar_one()

    return IdentityResponse(
        user_id=str(actor.user_id),
        login=login_name,
        role=role,
        session_expires_at=expires_at.isoformat(),
    )


__all__ = ["router", "is_allowed_origin"]
