"""Manager system-prompt configuration and generation composition."""

import asyncio
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import delete, select, update

from app.auth.service import hash_password
from app.db.models import SystemPrompt, SystemPromptSettings, User
from app.providers.base import EvidenceItem
from app.providers.generation import OpenRouterGenerationProvider
from app.system_prompts import (
    DEFAULT_SYSTEM_PROMPT,
    PromptUnavailableError,
    effective_prompt,
)
from tests.test_manager_api import (
    FOREIGN_ORIGIN,
    VALID_ORIGIN,
    _client,
    _login,
    _login_as,
    _scenario,
)

HEADERS = {"Origin": VALID_ORIGIN}
PROMPT_TEXT = "پاسخ را با لحن کوتاه ارائه کن."


def test_migration_downgrade_refuses_to_delete_custom_prompts():
    path = Path(__file__).parents[1] / "alembic" / "versions" / "0009_system_prompts.py"
    spec = importlib.util.spec_from_file_location("system_prompt_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    assert migration.DEFAULT_PROMPT == DEFAULT_SYSTEM_PROMPT
    drops = []
    migration.op = SimpleNamespace(
        get_bind=lambda: SimpleNamespace(scalar=lambda _query: True),
        drop_table=drops.append,
    )
    with pytest.raises(RuntimeError, match="custom system prompts exist"):
        migration.downgrade()
    assert drops == []


def test_manager_prompt_lifecycle_is_shared_and_protected():
    async def body(engine, factory, client):
        try:
            assert (await client.get("/api/manager/system-prompts")).status_code == 401
            await _login_as(client, "manager")
            listed = await client.get("/api/manager/system-prompts")
            assert listed.status_code == 200
            assert listed.headers["cache-control"] == "no-store"
            initial = listed.json()
            default = initial["prompts"][0]
            assert default["is_default"] and default["is_active"] and not default["can_edit"]
            assert default["prompt_text"] == DEFAULT_SYSTEM_PROMPT

            forbidden_origin = await client.post(
                "/api/manager/system-prompts",
                json={"name": "x", "prompt_text": PROMPT_TEXT},
                headers={"Origin": FOREIGN_ORIGIN},
            )
            assert forbidden_origin.status_code == 403
            assert (
                await client.put(
                    f"/api/manager/system-prompts/{default['prompt_id']}",
                    json={
                        "name": "x",
                        "prompt_text": PROMPT_TEXT,
                        "version": initial["version"],
                        "revision": default["revision"],
                    },
                    headers=HEADERS,
                )
            ).status_code == 403

            assert (
                await client.post(
                    "/api/manager/system-prompts",
                    json={"name": "   ", "prompt_text": PROMPT_TEXT},
                    headers=HEADERS,
                )
            ).status_code == 422
            assert (
                await client.post(
                    "/api/manager/system-prompts",
                    json={"name": "Too long", "prompt_text": "x" * 16_001},
                    headers=HEADERS,
                )
            ).status_code == 422

            created = await client.post(
                "/api/manager/system-prompts",
                json={"name": "لحن کوتاه", "prompt_text": PROMPT_TEXT},
                headers=HEADERS,
            )
            assert created.status_code == 201
            prompt_id = created.json()["prompt_id"]
            listed = (await client.get("/api/manager/system-prompts")).json()
            custom = next(row for row in listed["prompts"] if row["prompt_id"] == prompt_id)
            assert custom["can_edit"] and not custom["is_active"]

            async with factory() as session, session.begin():
                now = datetime.now(UTC)
                session.add(
                    User(
                        login="second-manager@example.test",
                        password_hash=hash_password("synthetic-test-password"),
                        role="manager",
                        is_active=True,
                        created_at=now,
                        updated_at=now,
                    )
                )
            async with _client(engine) as second_manager:
                await _login(
                    second_manager,
                    "second-manager@example.test",
                    "synthetic-test-password",
                )
                shared = (await second_manager.get("/api/manager/system-prompts")).json()
                other_view = next(row for row in shared["prompts"] if row["prompt_id"] == prompt_id)
                assert not other_view["can_edit"]
                assert (
                    await second_manager.put(
                        f"/api/manager/system-prompts/{prompt_id}",
                        json={
                            "name": "تغییر غیرمجاز",
                            "prompt_text": PROMPT_TEXT,
                            "version": shared["version"],
                            "revision": other_view["revision"],
                        },
                        headers=HEADERS,
                    )
                ).status_code == 404

            missing_confirmation = await client.post(
                f"/api/manager/system-prompts/{prompt_id}/activate",
                json={"version": listed["version"]},
                headers=HEADERS,
            )
            assert missing_confirmation.status_code == 422
            activated = await client.post(
                f"/api/manager/system-prompts/{prompt_id}/activate",
                json={"version": listed["version"], "confirmed": True},
                headers=HEADERS,
            )
            assert activated.status_code == 200
            assert [row["is_active"] for row in activated.json()["prompts"]].count(True) == 1
            assert next(
                row for row in activated.json()["prompts"] if row["prompt_id"] == prompt_id
            )["is_active"]
            async with factory() as session:
                assert await effective_prompt(session) == (
                    DEFAULT_SYSTEM_PROMPT
                    + "\n\nدستورهای تکمیلی مدیر؛ فقط تا جایی اجرا کن که با قواعد بالا سازگارند:\n"
                    + PROMPT_TEXT
                )

            stale = await client.post(
                f"/api/manager/system-prompts/{default['prompt_id']}/activate",
                json={"version": listed["version"], "confirmed": True},
                headers=HEADERS,
            )
            assert stale.status_code == 409

            current = activated.json()
            active = next(row for row in current["prompts"] if row["prompt_id"] == prompt_id)
            edit = {
                "name": "لحن رسمی",
                "prompt_text": "با لحن رسمی و کوتاه پاسخ بده.",
                "version": current["version"],
                "revision": active["revision"],
            }
            assert (
                await client.put(
                    f"/api/manager/system-prompts/{prompt_id}", json=edit, headers=HEADERS
                )
            ).status_code == 422
            edit["confirmed"] = True
            assert (
                await client.put(
                    f"/api/manager/system-prompts/{prompt_id}", json=edit, headers=HEADERS
                )
            ).status_code == 204
            latest = (await client.get("/api/manager/system-prompts")).json()
            assert latest["version"] == current["version"] + 1
            assert (
                next(row for row in latest["prompts"] if row["prompt_id"] == prompt_id)["name"]
                == "لحن رسمی"
            )
            assert (await client.get("/api/manager/system-prompts")).headers[
                "cache-control"
            ] == "no-store"

            async with _client(engine) as employee:
                await _login_as(employee, "employee")
                assert (await employee.get("/api/manager/system-prompts")).status_code == 403
        finally:
            async with factory() as session, session.begin():
                default_row = await session.scalar(
                    select(SystemPrompt).where(SystemPrompt.is_default.is_(True))
                )
                assert default_row is not None
                await session.execute(
                    update(SystemPromptSettings).values(
                        active_prompt_id=default_row.prompt_id,
                        version=SystemPromptSettings.version + 1,
                    )
                )
                await session.execute(
                    delete(SystemPrompt).where(SystemPrompt.is_default.is_(False))
                )

    _scenario(body)


def test_generation_sends_the_selected_effective_prompt():
    async def scenario():
        sent = []
        payload = {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "claims": [],
                                "abstained": True,
                                "missing_parts": ["insufficient_evidence"],
                                "answer": "",
                            }
                        )
                    },
                    "finish_reason": "stop",
                }
            ]
        }

        def respond(request: httpx.Request) -> httpx.Response:
            sent.append(json.loads(request.content))
            return httpx.Response(200, json=payload)

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            provider = OpenRouterGenerationProvider(
                client,
                base_url="https://models.example/v1",
                model="test-model",
                api_key="synthetic",
                system_prompt=DEFAULT_SYSTEM_PROMPT + "\n\nmanager-added",
            )
            await provider.generate(
                question="پرسش",
                evidence=[EvidenceItem("E1", "شاهد")],
            )
        return sent

    sent = asyncio.run(scenario())
    assert sent[0]["messages"][0] == {
        "role": "system",
        "content": DEFAULT_SYSTEM_PROMPT + "\n\nmanager-added",
    }


def test_missing_prompt_configuration_fails_closed():
    class MissingSettings:
        async def get(self, *_args):
            return None

    with pytest.raises(PromptUnavailableError):
        asyncio.run(effective_prompt(MissingSettings()))  # type: ignore[arg-type]
