"""Security regressions that never connect to a database."""

import asyncio
import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from anyio import CapacityLimiter
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr

from app.api import auth
from app.auth.rate_limit import LoginRateLimiter
from app.auth.service import authenticate
from app.cli import seed_accounts as seed
from app.main import create_app
from app.settings import Settings


@pytest.mark.parametrize(
    "password", ["sensitive-marker" * 60, {"secret": "sensitive-marker"}], ids=["long", "object"]
)
def test_invalid_login_never_echoes_password(
    password: object, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with AsyncClient(
            transport=ASGITransport(app=create_app()), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": password},
                headers={"origin": "http://localhost:3000"},
            )
        assert response.status_code == 422
        assert "sensitive-marker" not in response.text
        assert all("input" not in item and "ctx" not in item for item in response.json()["detail"])

    asyncio.run(scenario())
    assert "sensitive-marker" not in caplog.text


def test_logout_without_session_sends_cookie_deletion() -> None:
    async def scenario() -> None:
        async with AsyncClient(
            transport=ASGITransport(app=create_app()), base_url="http://test"
        ) as client:
            response = await client.post(
                "/api/auth/logout", headers={"origin": "http://localhost:3000"}
            )
        assert response.status_code == 204
        assert not response.content
        cookie = response.headers["set-cookie"]
        assert "ekc_session=" in cookie and "Max-Age=0" in cookie
        assert "HttpOnly" in cookie and "SameSite=lax" in cookie and "Path=/" in cookie

    asyncio.run(scenario())


def test_seed_validates_both_passwords_before_engine_creation() -> None:
    settings = Settings(
        db_name="enterprise_knowledge_copilot_test",
        seed_employee_password=SecretStr("valid-seed-password"),
        seed_manager_password=SecretStr("short"),
    )
    with patch.object(seed, "_engine") as make_engine:
        with pytest.raises(seed.SeedConfigurationError):
            asyncio.run(seed.seed_accounts(settings))
        make_engine.assert_not_called()


def test_seed_engine_uses_supplied_test_database() -> None:
    async def scenario() -> None:
        engine = seed._engine(Settings(db_name="enterprise_knowledge_copilot_test"))
        try:
            assert engine.url.database == "enterprise_knowledge_copilot_test"
        finally:
            await engine.dispose()

    asyncio.run(scenario())


def test_rate_limit_runs_before_database_and_ignores_forwarded_headers() -> None:
    async def scenario() -> None:
        app = create_app()
        limiter = LoginRateLimiter(1, 30, 60, 100, lambda: 0)
        # ASGITransport's actual socket peer is 127.0.0.1.
        assert limiter.retry_after("127.0.0.1", "employee") is None
        app.state.login_rate_limiter = limiter
        with patch.object(auth, "get_engine") as make_engine:
            async with AsyncClient(
                transport=ASGITransport(app=app), base_url="http://test"
            ) as client:
                response = await client.post(
                    "/api/auth/login",
                    json={"login": "employee", "password": "test-placeholder"},
                    headers={
                        "origin": "http://localhost:3000",
                        "x-forwarded-for": "203.0.113.1",
                        "x-real-ip": "203.0.113.2",
                        "forwarded": "for=203.0.113.3",
                    },
                )
            make_engine.assert_not_called()
        assert response.status_code == 429
        assert response.headers["retry-after"] == "60"

    asyncio.run(scenario())


@pytest.mark.parametrize("token", [None, "unknown-token"])
def test_logout_clears_client_cookie_even_when_token_is_unknown(token: str | None) -> None:
    async def scenario() -> None:
        async with AsyncClient(
            transport=ASGITransport(app=create_app()), base_url="http://test"
        ) as client:
            if token:
                client.cookies.set("ekc_session", token, domain="test.local", path="/")
            session = AsyncMock()
            with (
                patch.object(auth, "get_engine"),
                patch.object(auth, "get_session_factory", return_value=lambda: session),
                patch.object(
                    auth.auth_service, "revoke_session", new=AsyncMock(return_value=False)
                ),
            ):
                response = await client.post(
                    "/api/auth/logout", headers={"origin": "http://localhost:3000"}
                )
            assert response.status_code == 204
            assert "ekc_session" not in client.cookies

    asyncio.run(scenario())


def test_password_checks_run_in_bounded_workers() -> None:
    active = 0
    peak = 0
    threads: set[int] = set()
    lock = threading.Lock()

    def verify(password: str, password_hash: str) -> bool:
        nonlocal active, peak
        with lock:
            threads.add(threading.get_ident())
            active += 1
            peak = max(peak, active)
        time.sleep(0.03)
        with lock:
            active -= 1
        return True

    async def scenario() -> None:
        user = SimpleNamespace(password_hash="fake", is_active=True)
        session = AsyncMock()
        session.execute.return_value = SimpleNamespace(scalar_one_or_none=lambda: user)
        limiter = CapacityLimiter(4)
        with patch.object(auth.auth_service, "verify_password", side_effect=verify):
            await asyncio.gather(
                *(
                    authenticate(session, "employee", "fake", password_limiter=limiter)
                    for _ in range(8)
                )
            )
        assert threading.get_ident() not in threads
        assert 1 < peak <= 4

    asyncio.run(scenario())
