"""Manager APIs for the installation-wide chat prompt selection."""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.api.auth import get_engine, get_session_factory
from app.api.manager import _require_manager
from app.domain.models import Actor
from app.system_prompts import (
    PromptConflictError,
    PromptUnavailableError,
    activate,
    create,
    listing,
    update,
)

router = APIRouter(prefix="/api/manager/system-prompts", tags=["system-prompts"])
Manager = Annotated[Actor, Depends(_require_manager)]


class PromptInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    prompt_text: str = Field(min_length=1, max_length=16_000)


class PromptUpdate(PromptInput):
    version: int = Field(ge=1)
    revision: int = Field(ge=1)
    confirmed: bool = False


class PromptActivation(BaseModel):
    version: int = Field(ge=1)
    confirmed: bool = False


def factory(request: Request) -> async_sessionmaker[AsyncSession]:
    return get_session_factory(request, get_engine(request))  # type: ignore[return-value]


def headers(response: Response) -> None:
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def body(request: Request, schema: type[BaseModel]) -> BaseModel:
    if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
        raise HTTPException(415, "application/json required")
    try:
        return schema.model_validate_json(await request.body())
    except ValidationError:
        raise HTTPException(422, "system prompt rejected") from None


def handle_error(exc: Exception) -> HTTPException:
    if isinstance(exc, PromptConflictError):
        return HTTPException(409, "system prompt changed; refresh and retry")
    if isinstance(exc, PromptUnavailableError):
        return HTTPException(503, "system prompt configuration unavailable")
    if isinstance(exc, LookupError):
        return HTTPException(404, "system prompt not found")
    if isinstance(exc, PermissionError):
        return HTTPException(403, "system prompt cannot be edited")
    return HTTPException(422, "system prompt rejected")


@router.get("")
async def list_prompts(request: Request, actor: Manager, response: Response) -> dict[str, object]:
    headers(response)
    try:
        async with factory(request)() as session:
            return await listing(session, actor.user_id)
    except PromptUnavailableError as exc:
        raise handle_error(exc) from None


@router.post("", status_code=201)
async def add_prompt(request: Request, actor: Manager, response: Response) -> dict[str, object]:
    headers(response)
    payload = await body(request, PromptInput)
    assert isinstance(payload, PromptInput)
    try:
        async with factory(request)() as session, session.begin():
            row = await create(
                session,
                actor_id=actor.user_id,
                name=payload.name,
                prompt_text=payload.prompt_text,
            )
            return {"prompt_id": str(row.prompt_id), "revision": row.revision}
    except (PromptConflictError, PromptUnavailableError, ValueError) as exc:
        raise handle_error(exc) from None


@router.put("/{prompt_id}")
async def edit_prompt(
    request: Request, prompt_id: UUID, actor: Manager, response: Response
) -> Response:
    headers(response)
    payload = await body(request, PromptUpdate)
    assert isinstance(payload, PromptUpdate)
    try:
        async with factory(request)() as session, session.begin():
            await update(
                session,
                actor_id=actor.user_id,
                prompt_id=prompt_id,
                expected_version=payload.version,
                expected_revision=payload.revision,
                name=payload.name,
                prompt_text=payload.prompt_text,
                confirmed=payload.confirmed,
            )
    except (
        LookupError,
        PermissionError,
        PromptConflictError,
        PromptUnavailableError,
        ValueError,
    ) as exc:
        raise handle_error(exc) from None
    response.status_code = 204
    return response


@router.post("/{prompt_id}/activate")
async def activate_prompt(
    request: Request, prompt_id: UUID, actor: Manager, response: Response
) -> dict[str, object]:
    headers(response)
    payload = await body(request, PromptActivation)
    assert isinstance(payload, PromptActivation)
    try:
        async with factory(request)() as session, session.begin():
            await activate(
                session,
                prompt_id=prompt_id,
                expected_version=payload.version,
                confirmed=payload.confirmed,
            )
            return await listing(session, actor.user_id)
    except (LookupError, PromptConflictError, PromptUnavailableError, ValueError) as exc:
        raise handle_error(exc) from None
