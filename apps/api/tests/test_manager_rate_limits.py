import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from app.db.models import RateLimitSettings
from tests.test_manager_api import VALID_ORIGIN, _login_as, _scenario


def test_migration_downgrade_preserves_manager_settings() -> None:
    path = Path(__file__).parents[1] / "alembic" / "versions" / "0010_rate_limit_settings.py"
    spec = importlib.util.spec_from_file_location("rate_limit_migration", path)
    assert spec and spec.loader
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    drops = []
    migration.op = SimpleNamespace(
        get_bind=lambda: SimpleNamespace(scalar=lambda _query: True), drop_table=drops.append
    )
    with pytest.raises(RuntimeError, match="manager-edited rate limits"):
        migration.downgrade()
    assert drops == []


def test_manager_rate_limits_auth_validation_cas_and_persistence() -> None:
    async def body(engine, factory, client) -> None:
        headers = {"Origin": VALID_ORIGIN}
        async with factory() as session, session.begin():
            row = await session.get(RateLimitSettings, True)
            assert row is not None
            row.requests_per_user_per_minute = 6
            row.ollama_concurrency = 1
            row.cloud_concurrency = 6
            row.version = 1
        with pytest.raises(IntegrityError):
            async with factory() as session, session.begin():
                await session.execute(
                    update(RateLimitSettings)
                    .where(RateLimitSettings.singleton.is_(True))
                    .values(ollama_concurrency=0)
                )
        assert (await client.get("/api/manager/settings/rate-limits")).status_code == 401
        employee = await _login_as(client, "employee")
        client.cookies.clear()
        client.cookies.set("ekc_session", employee)
        employee_response = await client.get("/api/manager/settings/rate-limits", headers=headers)
        assert employee_response.status_code == 403, employee_response.text
        manager = await _login_as(client, "manager")
        client.cookies.clear()
        client.cookies.set("ekc_session", manager)
        listed = await client.get("/api/manager/settings/rate-limits", headers=headers)
        assert listed.status_code == 200
        assert listed.json() == {
            "requests_per_user_per_minute": 6,
            "concurrency": {"ollama": 1, "cloud": 6},
            "max_queued_requests_per_provider": 50,
            "version": 1,
        }
        invalid = await client.put(
            "/api/manager/settings/rate-limits",
            json={
                "requests_per_user_per_minute": 0,
                "ollama_concurrency": 1,
                "cloud_concurrency": 6,
                "version": 1,
            },
            headers=headers,
        )
        assert invalid.status_code == 422
        invalid_max = await client.put(
            "/api/manager/settings/rate-limits",
            json={
                "requests_per_user_per_minute": 1001,
                "ollama_concurrency": 1,
                "cloud_concurrency": 6,
                "version": 1,
            },
            headers=headers,
        )
        assert invalid_max.status_code == 422
        minimum = await client.put(
            "/api/manager/settings/rate-limits",
            json={
                "requests_per_user_per_minute": 1,
                "ollama_concurrency": 1,
                "cloud_concurrency": 1,
                "version": 1,
            },
            headers=headers,
        )
        assert minimum.status_code == 200
        assert minimum.json()["version"] == 2
        saved = await client.put(
            "/api/manager/settings/rate-limits",
            json={
                "requests_per_user_per_minute": 1000,
                "ollama_concurrency": 100,
                "cloud_concurrency": 1,
                "version": 2,
            },
            headers=headers,
        )
        assert saved.status_code == 200
        assert saved.json()["version"] == 3
        stale = await client.put(
            "/api/manager/settings/rate-limits",
            json={
                "requests_per_user_per_minute": 9,
                "ollama_concurrency": 2,
                "cloud_concurrency": 2,
                "version": 1,
            },
            headers=headers,
        )
        assert stale.status_code == 409
        client.cookies.clear()
        fresh = await _login_as(client, "manager")
        client.cookies.clear()
        client.cookies.set("ekc_session", fresh)
        current = await client.get("/api/manager/settings/rate-limits", headers=headers)
        assert current.json()["requests_per_user_per_minute"] == 1000
        assert current.json()["concurrency"] == {"ollama": 100, "cloud": 1}
        async with factory() as session:
            row = await session.get(RateLimitSettings, True)
            assert row is not None and row.version == 3
        async with factory() as session, session.begin():
            row = await session.get(RateLimitSettings, True)
            assert row is not None
            row.requests_per_user_per_minute = 6
            row.ollama_concurrency = 1
            row.cloud_concurrency = 6
            row.version = 1

    _scenario(body)
