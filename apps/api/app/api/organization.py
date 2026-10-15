"""Public organization branding and manager-controlled organization settings."""

from typing import Annotated, cast

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import func, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.auth import get_engine, get_session_factory
from app.api.manager import _require_manager
from app.db.models import OrganizationSettings
from app.domain.models import Actor

router = APIRouter(tags=["organization"])
Manager = Annotated[Actor, Depends(_require_manager)]


class OrganizationNameInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=100)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("organization name is required")
        return value


def public(row: OrganizationSettings) -> dict[str, str]:
    return {"name": row.name}


async def load(request: Request) -> OrganizationSettings:
    factory = cast(
        async_sessionmaker[AsyncSession], get_session_factory(request, get_engine(request))
    )
    try:
        async with factory() as session:
            row = await session.get(OrganizationSettings, True)
    except SQLAlchemyError:
        raise HTTPException(503, "organization settings unavailable") from None
    if row is None:
        raise HTTPException(503, "organization settings unavailable")
    return row


@router.get("/api/organization")
async def get_organization(request: Request, response: Response) -> dict[str, str]:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return public(await load(request))


@router.get("/api/manager/settings/organization")
async def get_organization_settings(
    request: Request, actor: Manager, response: Response
) -> dict[str, str]:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return public(await load(request))


@router.put("/api/manager/settings/organization")
async def put_organization_settings(
    request: Request, actor: Manager, response: Response
) -> dict[str, str]:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "application/json required")
    try:
        payload = OrganizationNameInput.model_validate_json(await request.body())
    except ValidationError:
        raise HTTPException(422, "organization name rejected") from None
    factory = cast(
        async_sessionmaker[AsyncSession], get_session_factory(request, get_engine(request))
    )
    try:
        async with factory() as session, session.begin():
            result = await session.execute(
                update(OrganizationSettings)
                .where(OrganizationSettings.singleton.is_(True))
                .values(name=payload.name, updated_at=func.clock_timestamp())
                .returning(OrganizationSettings)
            )
            row = result.scalar_one_or_none()
            if row is None:
                raise HTTPException(503, "organization settings unavailable")
            result_body = public(row)
    except SQLAlchemyError:
        raise HTTPException(503, "organization settings unavailable") from None
    return result_body
