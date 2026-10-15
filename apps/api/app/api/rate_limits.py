"""Manager API for installation-wide answer and provider capacity settings."""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, ValidationError
from sqlalchemy import select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.auth import get_engine, get_session_factory
from app.api.manager import _require_manager
from app.db.models import RateLimitSettings
from app.domain.models import Actor

router = APIRouter(prefix="/api/manager/settings/rate-limits", tags=["manager-settings"])
Manager = Annotated[Actor, Depends(_require_manager)]
QUEUE_LIMIT = 50


class RateLimitInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requests_per_user_per_minute: StrictInt = Field(ge=1, le=1000)
    ollama_concurrency: StrictInt = Field(ge=1, le=100)
    cloud_concurrency: StrictInt = Field(ge=1, le=100)
    version: StrictInt = Field(ge=1)


def view(row: RateLimitSettings) -> dict[str, object]:
    return {
        "requests_per_user_per_minute": row.requests_per_user_per_minute,
        "concurrency": {"ollama": row.ollama_concurrency, "cloud": row.cloud_concurrency},
        "max_queued_requests_per_provider": QUEUE_LIMIT,
        "version": row.version,
    }


async def load_settings(request: Request) -> RateLimitSettings:
    factory = cast(
        async_sessionmaker[AsyncSession], get_session_factory(request, get_engine(request))
    )
    try:
        async with factory() as session:
            row = await session.get(RateLimitSettings, True)
    except SQLAlchemyError:
        raise HTTPException(503, "rate limit settings unavailable") from None
    if row is None:
        raise HTTPException(503, "rate limit settings unavailable")
    return row


@router.get("")
async def get_rate_limits(
    request: Request, actor: Manager, response: Response
) -> dict[str, object]:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return view(await load_settings(request))


@router.put("")
async def put_rate_limits(
    request: Request, actor: Manager, response: Response
) -> dict[str, object]:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "application/json required")
    try:
        payload = RateLimitInput.model_validate_json(await request.body())
    except ValidationError:
        raise HTTPException(422, "rate limit settings rejected") from None
    factory = cast(
        async_sessionmaker[AsyncSession], get_session_factory(request, get_engine(request))
    )
    try:
        async with factory() as session, session.begin():
            result = await session.execute(
                update(RateLimitSettings)
                .where(
                    RateLimitSettings.singleton.is_(True),
                    RateLimitSettings.version == payload.version,
                )
                .values(
                    requests_per_user_per_minute=payload.requests_per_user_per_minute,
                    ollama_concurrency=payload.ollama_concurrency,
                    cloud_concurrency=payload.cloud_concurrency,
                    version=RateLimitSettings.version + 1,
                )
                .returning(RateLimitSettings)
            )
            row = result.scalar_one_or_none()
            if row is None:
                exists = await session.scalar(
                    select(RateLimitSettings.singleton).where(RateLimitSettings.singleton.is_(True))
                )
                raise HTTPException(
                    409 if exists else 503,
                    "rate limit settings changed; refresh and retry"
                    if exists
                    else "rate limit settings unavailable",
                )
            result_body = view(row)
    except SQLAlchemyError:
        raise HTTPException(503, "rate limit settings unavailable") from None
    capacity = getattr(request.app.state, "provider_capacity", None)
    if capacity is not None:
        await capacity.configure(row.ollama_concurrency, row.cloud_concurrency, row.version)
    return result_body
