"""Persistent, owner-scoped chat history and in-process answer tasks."""

from __future__ import annotations

import asyncio
import base64
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Cookie, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.auth import get_engine, get_session_factory, get_settings
from app.auth import service as auth_service
from app.auth.origin import OriginRejectedError, enforce_origin
from app.db.models import Conversation, ConversationTurnRecord
from app.domain.models import Actor
from app.providers.base import MAX_CONVERSATION_TURNS
from app.retrieval import store as retrieval_store
from app.settings import Settings

router = APIRouter(prefix="/api/conversations", tags=["conversations"])
NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
NOT_FOUND = "not found"
UNAUTHENTICATED = "authentication required"


class NewConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=2000)

    @field_validator("question")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("question must not be blank")
        return value.strip()


class RenameConversation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(min_length=1, max_length=100)

    @field_validator("title")
    @classmethod
    def non_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("title must not be blank")
        return value.strip()


class ConversationSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    conversation_id: uuid.UUID
    title: str
    updated_at: datetime


class TurnView(BaseModel):
    turn_id: uuid.UUID
    question: str
    status: str
    result: dict[str, Any] | None = None
    source_unavailable: bool = False
    created_at: datetime


async def _actor(
    request: Request,
    settings: Annotated[Settings, Depends(get_settings)],
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> Actor:
    try:
        enforce_origin(request, settings)
    except OriginRejectedError as error:
        raise HTTPException(status_code=403, detail="request origin is not allowed") from error
    factory = get_session_factory(request, get_engine(request))
    actor = await auth_service.resolve_actor(factory, ekc_session)  # type: ignore[arg-type]
    if actor is None:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED)
    return actor


def _factory(request: Request, engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return get_session_factory(request, engine)  # type: ignore[return-value]


def _cursor(value: str | None) -> tuple[datetime, uuid.UUID] | None:
    if value is None:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        stamp, identifier = base64.urlsafe_b64decode(value + padding).decode().split("|", 1)
        return datetime.fromisoformat(stamp), uuid.UUID(identifier)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=422, detail="invalid cursor") from None


def _encode_cursor(stamp: datetime, identifier: uuid.UUID) -> str:
    return (
        base64.urlsafe_b64encode(f"{stamp.isoformat()}|{identifier}".encode()).decode().rstrip("=")
    )


def _check_query(request: Request) -> None:
    if set(request.query_params) - {"cursor", "limit"}:
        raise HTTPException(status_code=422, detail="unsupported query parameter")


async def _owned(
    session: AsyncSession, actor: Actor, conversation_id: uuid.UUID
) -> Conversation | None:
    return await session.scalar(
        select(Conversation).where(
            Conversation.conversation_id == conversation_id,
            Conversation.user_id == actor.user_id,
        )
    )


async def _view_turn(session: AsyncSession, actor: Actor, turn: ConversationTurnRecord) -> TurnView:
    result = turn.result
    if turn.status != "answered" or not result:
        return TurnView(
            turn_id=turn.turn_id,
            question=turn.question,
            status=turn.status,
            created_at=turn.created_at,
        )
    refs = result.get("sources", [])
    sources: list[dict[str, str]] = []
    for ref in refs if isinstance(refs, list) else []:
        if not isinstance(ref, dict):
            continue
        row = await retrieval_store.read_source_section(
            session,
            actor,
            document_id=str(ref.get("document_id", "")),
            section_id=str(ref.get("section_id", "")),
            revision=str(ref.get("revision", "")),
        )
        if row is None:
            return TurnView(
                turn_id=turn.turn_id,
                question=turn.question,
                status="answered",
                source_unavailable=True,
                created_at=turn.created_at,
            )
        sources.append(
            {
                "document_id": row.document_id,
                "section_id": row.section_id,
                "revision": row.revision,
                "document_title": row.document_title,
                "section_title": row.title,
            }
        )
    enriched = dict(result)
    enriched["sources"] = sources
    claims = enriched.get("claims")
    if isinstance(claims, list):
        for claim in claims:
            if not isinstance(claim, dict) or not isinstance(claim.get("source"), dict):
                continue
            src = claim["source"]
            match = next(
                (
                    source
                    for source in sources
                    if all(
                        src.get(k) == source[k] for k in ("document_id", "section_id", "revision")
                    )
                ),
                None,
            )
            if match is None:
                return TurnView(
                    turn_id=turn.turn_id,
                    question=turn.question,
                    status="answered",
                    source_unavailable=True,
                    created_at=turn.created_at,
                )
            claim["source"] = match
    return TurnView(
        turn_id=turn.turn_id,
        question=turn.question,
        status=turn.status,
        result=enriched,
        created_at=turn.created_at,
    )


async def _history(
    session: AsyncSession, actor: Actor, conversation_id: uuid.UUID
) -> list[dict[str, Any]]:
    turns = list(
        await session.scalars(
            select(ConversationTurnRecord)
            .where(
                ConversationTurnRecord.conversation_id == conversation_id,
                ConversationTurnRecord.status == "answered",
            )
            .order_by(
                ConversationTurnRecord.created_at.desc(), ConversationTurnRecord.turn_id.desc()
            )
            .limit(MAX_CONVERSATION_TURNS)
        )
    )
    accepted: list[dict[str, Any]] = []
    for turn in reversed(turns):
        view = await _view_turn(session, actor, turn)
        if view.result is None or view.source_unavailable:
            continue
        accepted.append(
            {
                "question": turn.question,
                "answer": view.result.get("answer", ""),
                "sources": [
                    {k: source[k] for k in ("document_id", "section_id", "revision")}
                    for source in view.result.get("sources", [])
                ],
            }
        )
    return accepted


def _tasks(request: Request) -> dict[uuid.UUID, asyncio.Task[None]]:
    tasks = getattr(request.app.state, "conversation_tasks", None)
    if tasks is None:
        tasks = {}
        request.app.state.conversation_tasks = tasks
    return tasks


async def _run_turn(
    request: Request, turn_id: uuid.UUID, token: str, origin: str, actor: Actor
) -> None:
    engine = get_engine(request)
    factory = _factory(request, engine)
    try:
        async with factory() as session:
            turn = await session.get(ConversationTurnRecord, turn_id)
            if turn is None or turn.status != "pending":
                return
            parent = await session.get(Conversation, turn.conversation_id)
            if parent is None:
                return
            history = await _history(session, actor, parent.conversation_id)
            question = turn.question
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=request.app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/answers",
                json={"question": question, "history": history},
                headers={"Origin": origin, "Cookie": f"ekc_session={token}"},
            )
        async with factory() as session:
            if response.status_code != 200:
                await session.execute(
                    update(ConversationTurnRecord)
                    .where(
                        ConversationTurnRecord.turn_id == turn_id,
                        ConversationTurnRecord.status == "pending",
                    )
                    .values(
                        status="failed",
                        safe_error="answer unavailable",
                        updated_at=datetime.now(UTC),
                    )
                )
                await session.commit()
                return
            data = response.json()
            committed = await session.execute(
                update(ConversationTurnRecord)
                .where(
                    ConversationTurnRecord.turn_id == turn_id,
                    ConversationTurnRecord.status == "pending",
                )
                .returning(ConversationTurnRecord.conversation_id)
                .values(
                    status="answered", result=data, safe_error=None, updated_at=datetime.now(UTC)
                )
            )
            parent_id = committed.scalar_one_or_none()
            if parent_id is not None:
                await session.execute(
                    update(Conversation)
                    .where(Conversation.conversation_id == parent_id)
                    .values(updated_at=datetime.now(UTC))
                )
            await session.commit()
    except asyncio.CancelledError:
        raise
    except Exception:
        async with factory() as session:
            await session.execute(
                update(ConversationTurnRecord)
                .where(
                    ConversationTurnRecord.turn_id == turn_id,
                    ConversationTurnRecord.status == "pending",
                )
                .values(
                    status="failed", safe_error="answer unavailable", updated_at=datetime.now(UTC)
                )
            )
            await session.commit()


def _start(
    request: Request, turn_id: uuid.UUID, token: str | None, origin: str | None, actor: Actor
) -> None:
    if not token:
        raise HTTPException(status_code=401, detail=UNAUTHENTICATED)
    task = asyncio.create_task(_run_turn(request, turn_id, token, origin or "", actor))
    tasks = _tasks(request)
    tasks[turn_id] = task
    task.add_done_callback(
        lambda done: tasks.pop(turn_id, None) if tasks.get(turn_id) is done else None
    )


@router.get("")
async def list_conversations(
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 50,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    _check_query(request)
    await _recover(request, engine)
    factory = _factory(request, engine)
    before = _cursor(cursor)
    async with factory() as session:
        query = select(Conversation).where(Conversation.user_id == actor.user_id)
        if before:
            query = query.where(
                (Conversation.updated_at < before[0])
                | (
                    (Conversation.updated_at == before[0])
                    & (Conversation.conversation_id < before[1])
                )
            )
        rows = list(
            await session.scalars(
                query.order_by(
                    Conversation.updated_at.desc(), Conversation.conversation_id.desc()
                ).limit(limit + 1)
            )
        )
    more = len(rows) > limit
    rows = rows[:limit]
    return {
        "conversations": [
            ConversationSummary.model_validate(row).model_dump(mode="json") for row in rows
        ],
        "next_cursor": _encode_cursor(rows[-1].updated_at, rows[-1].conversation_id)
        if more
        else None,
    }


async def _recover(request: Request, engine: AsyncEngine) -> None:
    if getattr(request.app.state, "conversation_recovered", False):
        return
    async with _factory(request, engine)() as session:
        await session.execute(
            update(ConversationTurnRecord)
            .where(ConversationTurnRecord.status == "pending")
            .values(
                status="failed",
                safe_error="answer interrupted by restart",
                updated_at=datetime.now(UTC),
            )
        )
        await session.commit()
    request.app.state.conversation_recovered = True


@router.post("")
async def create_conversation(
    payload: NewConversation,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    await _recover(request, engine)
    factory = _factory(request, engine)
    question = payload.question.strip()
    conversation = Conversation(
        conversation_id=uuid.uuid4(),
        user_id=actor.user_id,
        title=question[:100],
        title_edited=False,
    )
    turn = ConversationTurnRecord(
        turn_id=uuid.uuid4(), conversation_id=conversation.conversation_id, question=question
    )
    async with factory() as session:
        session.add_all([conversation, turn])
        await session.commit()
        await session.refresh(conversation)
        await session.refresh(turn)
    _start(request, turn.turn_id, ekc_session, request.headers.get("origin"), actor)
    return {
        "conversation": ConversationSummary.model_validate(conversation).model_dump(mode="json"),
        "turn": _pending_turn(turn),
    }


def _pending_turn(turn: ConversationTurnRecord) -> dict[str, Any]:
    return {
        "turn_id": turn.turn_id,
        "question": turn.question,
        "status": turn.status,
        "result": None,
        "source_unavailable": False,
        "created_at": turn.created_at,
    }


@router.get("/{conversation_id}")
async def read_conversation(
    conversation_id: uuid.UUID,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
    cursor: str | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 50,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    _check_query(request)
    await _recover(request, engine)
    factory = _factory(request, engine)
    async with factory() as session:
        conversation = await _owned(session, actor, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        before = _cursor(cursor)
        query = select(ConversationTurnRecord).where(
            ConversationTurnRecord.conversation_id == conversation_id
        )
        if before:
            query = query.where(
                (ConversationTurnRecord.created_at < before[0])
                | (
                    (ConversationTurnRecord.created_at == before[0])
                    & (ConversationTurnRecord.turn_id < before[1])
                )
            )
        turns = list(
            await session.scalars(
                query.order_by(
                    ConversationTurnRecord.created_at.desc(), ConversationTurnRecord.turn_id.desc()
                ).limit(limit + 1)
            )
        )
        summary = ConversationSummary.model_validate(conversation).model_dump(mode="json")
        more = len(turns) > limit
        turns = turns[:limit]
        views = [await _view_turn(session, actor, turn) for turn in reversed(turns)]
        next_cursor = (
            _encode_cursor(turns[-1].created_at, turns[-1].turn_id) if more and turns else None
        )
    return {
        "conversation": summary,
        "turns": [item.model_dump(mode="json") for item in views],
        "next_cursor": next_cursor,
    }


@router.patch("/{conversation_id}")
async def rename_conversation(
    conversation_id: uuid.UUID,
    payload: RenameConversation,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    factory = _factory(request, engine)
    async with factory() as session:
        conversation = await _owned(session, actor, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        conversation.title = payload.title.strip()
        conversation.title_edited = True
        conversation.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(conversation)
        return {
            "conversation": ConversationSummary.model_validate(conversation).model_dump(mode="json")
        }


@router.delete("/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: uuid.UUID,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
) -> Response:
    factory = _factory(request, engine)
    async with factory() as session:
        conversation = await _owned(session, actor, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        turn_ids = list(
            await session.scalars(
                select(ConversationTurnRecord.turn_id).where(
                    ConversationTurnRecord.conversation_id == conversation_id
                )
            )
        )
        await session.delete(conversation)
        await session.commit()
    for turn_id in turn_ids:
        task = _tasks(request).pop(turn_id, None)
        if task:
            task.cancel()
    return Response(status_code=204, headers=NO_STORE)


@router.post("/{conversation_id}/turns")
async def add_turn(
    conversation_id: uuid.UUID,
    payload: NewConversation,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    await _recover(request, engine)
    factory = _factory(request, engine)
    async with factory() as session:
        conversation = await _owned(session, actor, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        question = payload.question.strip()
        turn = ConversationTurnRecord(conversation_id=conversation_id, question=question)
        session.add(turn)
        if not conversation.title_edited and not await session.scalar(
            select(ConversationTurnRecord.turn_id).where(
                ConversationTurnRecord.conversation_id == conversation_id
            )
        ):
            conversation.title = question[:100]
        conversation.updated_at = datetime.now(UTC)
        await session.commit()
        await session.refresh(turn)
    _start(request, turn.turn_id, ekc_session, request.headers.get("origin"), actor)
    return {"turn": _pending_turn(turn)}


@router.post("/{conversation_id}/turns/{turn_id}/retry")
async def retry_turn(
    conversation_id: uuid.UUID,
    turn_id: uuid.UUID,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
    ekc_session: Annotated[str | None, Cookie(alias=auth_service.SESSION_COOKIE_NAME)] = None,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    await _recover(request, engine)
    factory = _factory(request, engine)
    async with factory() as session:
        if await _owned(session, actor, conversation_id) is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        turn = await session.scalar(
            select(ConversationTurnRecord).where(
                ConversationTurnRecord.turn_id == turn_id,
                ConversationTurnRecord.conversation_id == conversation_id,
            )
        )
        if turn is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        should_start = turn.status in {"failed", "cancelled"}
        if should_start:
            result = await session.execute(
                update(ConversationTurnRecord)
                .where(
                    ConversationTurnRecord.turn_id == turn_id,
                    ConversationTurnRecord.conversation_id == conversation_id,
                    ConversationTurnRecord.status.in_(("failed", "cancelled")),
                )
                .returning(ConversationTurnRecord.turn_id)
                .values(
                    status="pending", safe_error=None, result=None, updated_at=datetime.now(UTC)
                )
            )
            await session.commit()
            await session.refresh(turn)
            if result.scalar_one_or_none() is not None:
                _start(request, turn_id, ekc_session, request.headers.get("origin"), actor)
        view = await _view_turn(session, actor, turn)
    return {"turn": view.model_dump(mode="json")}


@router.post("/{conversation_id}/turns/{turn_id}/cancel")
async def cancel_turn(
    conversation_id: uuid.UUID,
    turn_id: uuid.UUID,
    request: Request,
    actor: Annotated[Actor, Depends(_actor)],
    engine: Annotated[AsyncEngine, Depends(get_engine)],
    response: Response,
) -> dict[str, Any]:
    response.headers.update(NO_STORE)
    factory = _factory(request, engine)
    async with factory() as session:
        if await _owned(session, actor, conversation_id) is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        turn = await session.scalar(
            select(ConversationTurnRecord).where(
                ConversationTurnRecord.turn_id == turn_id,
                ConversationTurnRecord.conversation_id == conversation_id,
            )
        )
        if turn is None:
            raise HTTPException(status_code=404, detail=NOT_FOUND)
        await session.execute(
            update(ConversationTurnRecord)
            .where(
                ConversationTurnRecord.turn_id == turn_id,
                ConversationTurnRecord.status == "pending",
            )
            .values(status="cancelled", safe_error=None, updated_at=datetime.now(UTC))
        )
        await session.commit()
        await session.refresh(turn)
        view = await _view_turn(session, actor, turn)
    task = _tasks(request).pop(turn_id, None)
    if task:
        task.cancel()
    return {"turn": view.model_dump(mode="json")}
