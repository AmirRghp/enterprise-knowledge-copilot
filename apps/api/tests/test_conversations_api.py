"""Conversation ownership, persistence, and retry contract on the dedicated test DB."""

import asyncio
import importlib.util
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.api import conversations as conversations_api
from app.db import models as db_models
from app.db.engine import create_engine, create_session_factory
from app.domain.models import Actor
from app.retrieval import store as retrieval_store
from app.settings import Settings
from tests.provider_fixtures import seed_panel
from tests.test_manager_api import (
    VALID_ORIGIN,
    _client,
    _login_as,
    _reset,
    _run,
    _seed,
)
from tests.test_retrieval import EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT, _publish


def _scenario(body):
    async def run():
        settings = Settings(db_name="enterprise_knowledge_copilot_test")
        assert settings.db_name == "enterprise_knowledge_copilot_test"
        engine = create_engine(settings)
        try:
            await _reset(engine)
            await seed_panel(engine, settings)
            factory = create_session_factory(engine)
            await _seed(factory)
            async with _client(engine) as client:
                return await body(engine, factory, client)
        finally:
            await engine.dispose()

    return _run(run())


async def _eventually_failed(client: AsyncClient, path: str, token: str) -> dict:
    for _ in range(50):
        result = await client.get(path, cookies={"ekc_session": token})
        assert result.status_code == 200
        turn = result.json()["turns"][-1]
        if turn["status"] == "failed":
            return turn
        await asyncio.sleep(0.02)
    pytest.fail("fake-disabled provider request did not reach a retryable failure")


def test_persistence_owner_isolation_and_retry_same_turn(monkeypatch) -> None:
    real_httpx = conversations_api.httpx

    class FailedAnswerClient:
        def __init__(self, *, base_url, transport):
            self.answer_url = real_httpx.URL(base_url).join("/api/answers")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path, *, json, headers):
            assert self.answer_url == "http://test/api/answers"
            return real_httpx.Response(503)

    monkeypatch.setattr(
        conversations_api,
        "httpx",
        SimpleNamespace(
            ASGITransport=lambda **kwargs: object(),
            AsyncClient=lambda **kwargs: FailedAnswerClient(**kwargs),
        ),
    )

    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del factory
        employee = await _login_as(client, "employee")
        other_client = _client(engine)
        manager = await _login_as(other_client, "manager")
        created = await client.post(
            "/api/conversations",
            json={"question": "مدیرها چطور دسترسی دارند؟"},
            cookies={"ekc_session": employee},
            headers={"Origin": VALID_ORIGIN},
        )
        assert created.status_code == 200
        conversation_id = created.json()["conversation"]["conversation_id"]
        turn_id = created.json()["turn"]["turn_id"]
        path = f"/api/conversations/{conversation_id}"
        failed = await _eventually_failed(client, path, employee)
        assert failed["turn_id"] == turn_id
        assert failed["question"] == "مدیرها چطور دسترسی دارند؟"

        own = await client.get(path, cookies={"ekc_session": employee})
        assert own.status_code == 200
        foreign = await other_client.get(path, cookies={"ekc_session": manager})
        missing = await client.get(
            "/api/conversations/00000000-0000-4000-8000-000000000001",
            cookies={"ekc_session": employee},
        )
        assert foreign.status_code == missing.status_code == 404
        assert foreign.json() == missing.json()

        renamed = await client.patch(
            path,
            json={"title": "فرایند مدیرها"},
            cookies={"ekc_session": employee},
            headers={"Origin": VALID_ORIGIN},
        )
        assert renamed.status_code == 200
        assert renamed.json()["conversation"]["title"] == "فرایند مدیرها"
        denied_rename = await other_client.patch(
            path,
            json={"title": "نباید دیده شود"},
            cookies={"ekc_session": manager},
            headers={"Origin": VALID_ORIGIN},
        )
        assert denied_rename.status_code == 404

        retried = await client.post(
            f"{path}/turns/{turn_id}/retry",
            cookies={"ekc_session": employee},
            headers={"Origin": VALID_ORIGIN},
        )
        assert retried.status_code == 200
        assert retried.json()["turn"]["turn_id"] == turn_id
        assert (await _eventually_failed(client, path, employee))["turn_id"] == turn_id

        listed = await client.get("/api/conversations?limit=1", cookies={"ekc_session": employee})
        assert [item["conversation_id"] for item in listed.json()["conversations"]] == [
            conversation_id
        ]
        assert not (
            await other_client.get("/api/conversations", cookies={"ekc_session": manager})
        ).json()["conversations"]
        removed = await client.delete(
            path, cookies={"ekc_session": employee}, headers={"Origin": VALID_ORIGIN}
        )
        assert removed.status_code == 204
        assert (await client.get(path, cookies={"ekc_session": employee})).status_code == 404
        await other_client.aclose()

    _scenario(body)


def test_cancel_retry_and_restart_recovery_preserve_turn(monkeypatch) -> None:
    calls = 0

    async def hang(request, turn_id, token, origin, actor):
        nonlocal calls
        calls += 1
        await asyncio.Event().wait()

    monkeypatch.setattr(conversations_api, "_run_turn", hang)

    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")
        created = await client.post(
            "/api/conversations",
            json={"question": "پرسش پایدار"},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        conversation_id = created.json()["conversation"]["conversation_id"]
        turn_id = created.json()["turn"]["turn_id"]
        path = f"/api/conversations/{conversation_id}"
        for _ in range(50):
            if calls:
                break
            await asyncio.sleep(0.01)
        assert calls == 1

        cancelled = await client.post(
            f"{path}/turns/{turn_id}/cancel",
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert cancelled.json()["turn"]["status"] == "cancelled"
        retried = await client.post(
            f"{path}/turns/{turn_id}/retry",
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert retried.json()["turn"]["turn_id"] == turn_id
        assert retried.json()["turn"]["status"] == "pending"
        assert calls == 2
        duplicate_retry = await client.post(
            f"{path}/turns/{turn_id}/retry",
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert duplicate_retry.json()["turn"]["status"] == "pending"
        assert calls == 2

        async with _client(engine) as restarted:
            recovered = await restarted.get(path, cookies={"ekc_session": token})
        turn = recovered.json()["turns"][-1]
        assert turn["turn_id"] == turn_id
        assert turn["status"] == "failed"
        assert turn["question"] == "پرسش پایدار"
        assert calls == 2

        # The original process task is still intentionally blocked. Cancel it through
        # its own API app so the test leaves no task running after the engine closes.
        stopped = await client.post(
            f"{path}/turns/{turn_id}/cancel",
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert stopped.status_code == 200

    _scenario(body)


def test_retry_recovers_pending_before_restarting_turn(monkeypatch) -> None:
    calls = 0
    completed = 0
    release = asyncio.Event()
    all_done = asyncio.Event()

    async def hang(request, turn_id, token, origin, actor):
        nonlocal calls, completed
        calls += 1
        try:
            await release.wait()
        finally:
            completed += 1
            if completed == 2:
                all_done.set()

    monkeypatch.setattr(conversations_api, "_run_turn", hang)

    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del factory
        token = await _login_as(client, "employee")
        created = await client.post(
            "/api/conversations",
            json={"question": "بازیابی پیش از تلاش دوباره"},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        conversation_id = created.json()["conversation"]["conversation_id"]
        turn_id = created.json()["turn"]["turn_id"]
        path = f"/api/conversations/{conversation_id}"
        for _ in range(50):
            if calls == 1:
                break
            await asyncio.sleep(0.01)
        assert calls == 1

        async with _client(engine) as restarted:
            retry = await restarted.post(
                f"{path}/turns/{turn_id}/retry",
                cookies={"ekc_session": token},
                headers={"Origin": VALID_ORIGIN},
            )
            assert retry.status_code == 200
            assert retry.json()["turn"]["status"] == "pending"
            for _ in range(50):
                if calls == 2:
                    break
                await asyncio.sleep(0.01)
            assert calls == 2

            read = await restarted.get(path, cookies={"ekc_session": token})
            assert read.json()["turns"][-1]["status"] == "pending"
            duplicate = await restarted.post(
                f"{path}/turns/{turn_id}/retry",
                cookies={"ekc_session": token},
                headers={"Origin": VALID_ORIGIN},
            )
            assert duplicate.json()["turn"]["status"] == "pending"
            assert calls == 2
            cancelled = await restarted.post(
                f"{path}/turns/{turn_id}/cancel",
                cookies={"ekc_session": token},
                headers={"Origin": VALID_ORIGIN},
            )
            assert cancelled.json()["turn"]["status"] == "cancelled"

        release.set()
        await asyncio.wait_for(all_done.wait(), timeout=1)

    _scenario(body)


def test_late_answer_after_cancel_is_never_committed(monkeypatch) -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    real_httpx = conversations_api.httpx

    class SlowAnswerClient:
        def __init__(self, *, base_url, transport):
            self.answer_url = real_httpx.URL(base_url).join("/api/answers")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path, *, json, headers):
            assert self.answer_url == "http://test/api/answers"
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                # Model an upstream that finishes despite the best-effort cancellation.
                await release.wait()
            return real_httpx.Response(
                200,
                json={
                    "answer": "late answer",
                    "claims": [],
                    "sources": [],
                    "abstained": False,
                    "request_id": "late",
                },
            )

    monkeypatch.setattr(
        conversations_api,
        "httpx",
        SimpleNamespace(
            ASGITransport=lambda **kwargs: object(),
            AsyncClient=lambda **kwargs: SlowAnswerClient(**kwargs),
        ),
    )

    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del engine, factory
        token = await _login_as(client, "employee")
        created = await client.post(
            "/api/conversations",
            json={"question": "لغو در زمان پاسخ"},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        conversation_id = created.json()["conversation"]["conversation_id"]
        turn_id = created.json()["turn"]["turn_id"]
        await asyncio.wait_for(started.wait(), timeout=1)
        cancelled = await client.post(
            f"/api/conversations/{conversation_id}/turns/{turn_id}/cancel",
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert cancelled.json()["turn"]["status"] == "cancelled"
        release.set()
        await asyncio.sleep(0.05)
        read = await client.get(
            f"/api/conversations/{conversation_id}", cookies={"ekc_session": token}
        )
        turn = read.json()["turns"][-1]
        assert turn["status"] == "cancelled"
        assert turn["result"] is None

    _scenario(body)


def test_model_context_uses_only_latest_five_successful_turns() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del client
        async with factory() as session:
            user = await session.scalar(
                select(db_models.User).where(db_models.User.login == "employee")
            )
            assert user is not None
            conversation = db_models.Conversation(
                conversation_id=uuid.uuid4(),
                user_id=user.user_id,
                title="پرسش‌های متوالی",
            )
            session.add(conversation)
            await session.flush()
            start = datetime.now(UTC)
            for index in range(7):
                session.add(
                    db_models.ConversationTurnRecord(
                        turn_id=uuid.uuid4(),
                        conversation_id=conversation.conversation_id,
                        question=f"پرسش {index}",
                        status="answered",
                        result={"answer": f"پاسخ {index}", "sources": [], "claims": []},
                        created_at=start + timedelta(seconds=index),
                    )
                )
            await session.commit()
            actor = Actor(user.user_id, "employee", uuid.uuid4())
            history = await conversations_api._history(session, actor, conversation.conversation_id)
        assert [turn["question"] for turn in history] == [f"پرسش {i}" for i in range(2, 7)]
        assert [turn["answer"] for turn in history] == [f"پاسخ {i}" for i in range(2, 7)]

    _scenario(body)


def test_historical_answer_is_hidden_when_any_source_is_no_longer_authorized(monkeypatch) -> None:
    async def unavailable(*args, **kwargs):
        return None

    monkeypatch.setattr(retrieval_store, "read_source_section", unavailable)
    turn = db_models.ConversationTurnRecord(
        turn_id=uuid.uuid4(),
        conversation_id=uuid.uuid4(),
        question="پرسش محفوظ بماند",
        status="answered",
        result={
            "answer": "پاسخ محرمانه باید پنهان شود",
            "sources": [{"document_id": "MGR-001", "section_id": "S1", "revision": "old"}],
            "claims": [],
            "abstained": False,
            "request_id": "test",
        },
        created_at=datetime.now(UTC),
    )
    view = asyncio.run(
        conversations_api._view_turn(None, Actor(uuid.uuid4(), "employee", uuid.uuid4()), turn)
    )
    assert view.question == "پرسش محفوظ بماند"
    assert view.source_unavailable
    assert view.result is None


def test_conversation_cursor_pages_are_bounded_and_non_overlapping() -> None:
    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del engine
        token = await _login_as(client, "employee")
        async with factory() as session:
            user = await session.scalar(
                select(db_models.User).where(db_models.User.login == "employee")
            )
            assert user is not None
            start = datetime.now(UTC)
            session.add_all(
                [
                    db_models.Conversation(
                        conversation_id=uuid.uuid4(),
                        user_id=user.user_id,
                        title=f"گفت‌وگو {index}",
                        updated_at=start + timedelta(seconds=index),
                    )
                    for index in range(5)
                ]
            )
            await session.commit()
        first = await client.get("/api/conversations?limit=2", cookies={"ekc_session": token})
        page_one = first.json()
        assert len(page_one["conversations"]) == 2
        assert page_one["next_cursor"]
        second = await client.get(
            f"/api/conversations?limit=2&cursor={page_one['next_cursor']}",
            cookies={"ekc_session": token},
        )
        page_two = second.json()
        assert len(page_two["conversations"]) == 2
        assert set(item["conversation_id"] for item in page_one["conversations"]).isdisjoint(
            item["conversation_id"] for item in page_two["conversations"]
        )
        assert (
            await client.get("/api/conversations?limit=51", cookies={"ekc_session": token})
        ).status_code == 422

    _scenario(body)


def test_answered_turn_persists_and_returns_authorized_readable_sources(monkeypatch) -> None:
    captured_histories: list[list[dict]] = []

    class FakeAnswerClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, path, *, json, headers):
            assert path == "/api/answers"
            assert headers["Origin"] == VALID_ORIGIN
            captured_histories.append(json["history"])
            answer = {
                "answer": "بازپرداخت طبق رویه انجام می‌شود.",
                "claims": [
                    {
                        "text": "بازپرداخت طبق رویه انجام می‌شود.",
                        "quote": "مدارک باید ثبت شوند.",
                        "source": source,
                    }
                ],
                "sources": [source],
                "abstained": False,
                "request_id": "fake-request",
            }
            return real_httpx.Response(200, json=answer)

    source: dict[str, str] = {}
    real_httpx = conversations_api.httpx
    monkeypatch.setattr(
        conversations_api,
        "httpx",
        SimpleNamespace(
            ASGITransport=lambda **kwargs: object(),
            AsyncClient=lambda **kwargs: FakeAnswerClient(),
        ),
    )

    async def body(engine: AsyncEngine, factory: async_sessionmaker, client: AsyncClient) -> None:
        del engine
        token = await _login_as(client, "employee")
        revision = await _publish(
            factory,
            document_id=EMPLOYEE_DOCUMENT,
            text=EMPLOYEE_TEXT,
            access_role="employee",
            title="سیاست هزینهٔ سفر",
        )
        assert revision is not None
        async with factory() as session:
            section = await session.scalar(
                select(db_models.Section).where(
                    db_models.Section.document_id == EMPLOYEE_DOCUMENT,
                    db_models.Section.revision == revision,
                )
            )
            assert section is not None
        source.update(
            document_id=EMPLOYEE_DOCUMENT,
            section_id=section.section_id,
            revision=revision,
        )
        created = await client.post(
            "/api/conversations",
            json={"question": "چه مدارکی لازم است؟"},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        chat_id = created.json()["conversation"]["conversation_id"]
        for _ in range(50):
            history = await client.get(
                f"/api/conversations/{chat_id}", cookies={"ekc_session": token}
            )
            if history.json()["turns"][-1]["status"] == "answered":
                break
            await asyncio.sleep(0.01)
        turn = history.json()["turns"][-1]
        assert turn["result"]["answer"] == "بازپرداخت طبق رویه انجام می‌شود."
        assert turn["result"]["sources"][0]["document_title"] == "سیاست هزینهٔ سفر"
        assert turn["result"]["sources"][0]["section_title"] == section.title
        assert turn["result"]["claims"][0]["source"]["document_title"] == "سیاست هزینهٔ سفر"

        followup = await client.post(
            f"/api/conversations/{chat_id}/turns",
            json={"question": "برای مدیرها چطور؟"},
            cookies={"ekc_session": token},
            headers={"Origin": VALID_ORIGIN},
        )
        assert followup.status_code == 200
        for _ in range(50):
            page = await client.get(f"/api/conversations/{chat_id}", cookies={"ekc_session": token})
            if page.json()["turns"][-1]["status"] == "answered":
                break
            await asyncio.sleep(0.01)
        assert captured_histories[-1] == [
            {
                "question": "چه مدارکی لازم است؟",
                "answer": "بازپرداخت طبق رویه انجام می‌شود.",
                "sources": [source],
            }
        ]
        assert conversations_api.httpx is not real_httpx

    _scenario(body)


def test_migration_downgrade_refuses_existing_conversation_data(monkeypatch) -> None:
    path = Path(__file__).parents[1] / "alembic" / "versions" / "0012_conversation_history.py"
    spec = importlib.util.spec_from_file_location("conversation_history_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    class Connection:
        @staticmethod
        def scalar(statement):
            assert "conversations" in str(statement)
            return True

    monkeypatch.setattr(migration.op, "get_bind", lambda: Connection())
    with pytest.raises(RuntimeError, match="conversation history exists"):
        migration.downgrade()
