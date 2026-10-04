"""Targeted checks for server-side authentication.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database only.
TESTING.md and DATABASE.md forbid running tests against the pre-existing
database or the application database, so every live check pins the test database
and the suite truncates only the auth tables it owns.

The negative scenarios are the point of this file: an invalid session, a revoked
session, an expired session, a deactivated account, a changed role, a forged
role claim, a missing Origin, and a mismatched Origin must all be refused, and
the role must come from the ``users`` row rather than anything the client sends.
"""

import asyncio
from collections.abc import Awaitable, Callable, Coroutine, Iterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import delete, insert, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.auth import service as auth_service
from app.auth.origin import is_allowed_origin
from app.cli import seed_accounts as seed_module
from app.db import models as db_models
from app.db import url as db_url
from app.db.engine import create_engine, create_session_factory
from app.main import create_app
from app.settings import Settings

EMPLOYEE_PASSWORD = "Ek-employee-test-password"
MANAGER_PASSWORD = "Ek-manager-test-password"
VALID_ORIGIN = "http://localhost:3000"
FOREIGN_ORIGIN = "http://evil.example.com"


def _settings(database: str = "enterprise_knowledge_copilot_test") -> Settings:
    return Settings(
        db_name=database,
        seed_employee_password=SecretStr(EMPLOYEE_PASSWORD),
        seed_manager_password=SecretStr(MANAGER_PASSWORD),
    )


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine to completion on a single, dedicated event loop.

    Every async step for a test must live in one coroutine: an asyncpg connection
    is bound to the loop that created it, so an engine shared across separate
    ``asyncio.run`` calls would fail with "attached to a different loop". This is
    also why the engine is created inside each scenario rather than in a
    module-scoped fixture.
    """
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def isolated_database() -> Iterator[None]:
    """Guarantee each test starts and ends with only the test database.

    Guard rail against ever touching the application database or the
    pre-existing ``rag_support``, per TESTING.md.
    """
    settings = _settings()
    assert settings.db_name == "enterprise_knowledge_copilot_test"
    assert db_url.PROJECT_DATABASES == {
        "enterprise_knowledge_copilot",
        "enterprise_knowledge_copilot_test",
    }
    yield


async def _with_engine[Result](body: Callable[[AsyncEngine], Awaitable[Result]]) -> Result:
    """Open an engine on the isolated test database, run ``body``, then clean up.

    The engine, its pool, and the auth-table reset all happen inside a single
    event loop, which is what asyncpg requires.
    """
    engine = create_engine(_settings())
    try:
        async with engine.begin() as connection:
            await connection.execute(delete(db_models.Session))
            await connection.execute(delete(db_models.User))
        return await body(engine)
    finally:
        await engine.dispose()


async def _seed(factory: async_sessionmaker[AsyncSession]) -> None:
    """Insert both accounts directly, bypassing the CLI password policy."""
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    async with factory() as session:
        for login, password, role in (
            ("employee", EMPLOYEE_PASSWORD, "employee"),
            ("manager", MANAGER_PASSWORD, "manager"),
        ):
            session.add(
                db_models.User(
                    login=login,
                    password_hash=auth_service.hash_password(password),
                    role=role,
                    is_active=True,
                    created_at=now,
                    updated_at=now,
                )
            )
        await session.commit()


def _client(engine: AsyncEngine) -> AsyncClient:
    """Build an ASGI client whose app shares the test engine."""
    app = create_app()
    app.state.db_engine = engine
    app.state.db_session_factory = create_session_factory(engine)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- password and token primitives ---


def test_password_hash_is_argon2id_and_never_plaintext() -> None:
    hashed = auth_service.hash_password("correct horse battery staple")
    assert hashed.startswith("$argon2id$")
    assert "correct horse battery staple" not in hashed


def test_password_verification_rejects_wrong_password() -> None:
    hashed = auth_service.hash_password("correct horse battery staple")
    assert auth_service.verify_password("correct horse battery staple", hashed) is True
    assert auth_service.verify_password("wrong password", hashed) is False


def test_verify_password_survives_a_corrupt_hash() -> None:
    assert auth_service.verify_password("anything", "not-a-real-hash") is False


def test_session_token_is_unique_and_unguessable() -> None:
    tokens = {auth_service.generate_session_token() for _ in range(200)}
    assert len(tokens) == 200
    assert all(len(token) >= 40 for token in tokens)


def test_session_token_hash_is_stable_and_not_reversible() -> None:
    token = auth_service.generate_session_token()
    assert auth_service.hash_session_token(token) == auth_service.hash_session_token(token)
    assert token.encode() not in auth_service.hash_session_token(token)


# --- authenticate against the real database ---


def test_authenticate_accepts_correct_credentials() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, _ = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            assert user.login == "employee"
            assert user.role == "employee"

    _run(_with_engine(scenario))


@pytest.mark.parametrize("password", ["wrong-password", "", "EMPLOYEE_PASSWORD"])
def test_authenticate_rejects_a_wrong_password(password: str) -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            with pytest.raises(auth_service.InvalidCredentialsError):
                await auth_service.authenticate(session, "employee", password)

    _run(_with_engine(scenario))


def test_authenticate_rejects_an_unknown_login() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            with pytest.raises(auth_service.InvalidCredentialsError):
                await auth_service.authenticate(session, "ghost", EMPLOYEE_PASSWORD)

    _run(_with_engine(scenario))


def test_authenticate_rejects_a_deactivated_account() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            await session.execute(
                update(db_models.User)
                .where(db_models.User.login == "employee")
                .values(is_active=False)
            )
            await session.commit()
            with pytest.raises(auth_service.InvalidCredentialsError):
                await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)

    _run(_with_engine(scenario))


def test_disabled_account_uses_the_same_generic_error() -> None:
    """A disabled account must be indistinguishable from a wrong password."""

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            await session.execute(
                update(db_models.User)
                .where(db_models.User.login == "employee")
                .values(is_active=False)
            )
            await session.commit()

        async def message_for(login: str, password: str) -> str:
            async with factory() as session:
                try:
                    await auth_service.authenticate(session, login, password)
                except auth_service.InvalidCredentialsError as error:
                    return str(error)
            raise AssertionError("expected rejection")

        unknown = await message_for("ghost", EMPLOYEE_PASSWORD)
        wrong = await message_for("employee", "wrong")
        disabled = await message_for("employee", EMPLOYEE_PASSWORD)
        assert unknown == wrong == disabled

    _run(_with_engine(scenario))


# --- session issuing and resolution ---


def test_issue_then_resolve_returns_the_server_role() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "manager", MANAGER_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        actor = await auth_service.resolve_actor(factory, token)
        assert actor is not None
        assert actor.role == "manager"

    _run(_with_engine(scenario))


def test_only_the_token_hash_is_persisted() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        async with factory() as session:
            rows = (await session.execute(select(db_models.Session))).scalars().all()
            assert len(rows) == 1
            stored = bytes(rows[0].token_hash)
            assert stored == auth_service.hash_session_token(token)
            assert token.encode("utf-8") not in stored

    _run(_with_engine(scenario))


def test_resolve_rejects_a_missing_cookie() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        assert await auth_service.resolve_actor(factory, None) is None
        assert await auth_service.resolve_actor(factory, "") is None

    _run(_with_engine(scenario))


def test_resolve_rejects_an_unknown_token() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        actor = await auth_service.resolve_actor(factory, "never-issued-token")
        assert actor is None

    _run(_with_engine(scenario))


def test_resolve_rejects_a_revoked_session() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        assert await auth_service.resolve_actor(factory, token) is not None

        async with factory() as session:
            assert await auth_service.revoke_session(session, token) is True

        assert await auth_service.resolve_actor(factory, token) is None

    _run(_with_engine(scenario))


def test_revoke_is_idempotent_and_reports_whether_it_revoked() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        async with factory() as session:
            assert await auth_service.revoke_session(session, token) is True
            assert await auth_service.revoke_session(session, token) is False
            assert await auth_service.revoke_session(session, "unknown") is False

    _run(_with_engine(scenario))


def test_resolve_rejects_an_expired_session() -> None:
    from datetime import UTC, datetime, timedelta

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        long_past = datetime.now(UTC) - timedelta(hours=2)
        async with factory() as session:
            user = (
                await session.execute(
                    select(db_models.User).where(db_models.User.login == "employee")
                )
            ).scalar_one()
            # Created in the past with a TTL that has already elapsed.
            await auth_service.issue_session(session, user, 60, long_past)
            row = (await session.execute(select(db_models.Session))).scalars().one()
            token = auth_service.generate_session_token()
            await session.execute(
                update(db_models.Session)
                .where(db_models.Session.session_id == row.session_id)
                .values(token_hash=auth_service.hash_session_token(token))
            )
            await session.commit()

        assert await auth_service.resolve_actor(factory, token) is None

    _run(_with_engine(scenario))


def test_resolve_reflects_a_role_change_on_the_next_request() -> None:
    """The role is read live, so promoting an account takes effect immediately."""

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        actor = await auth_service.resolve_actor(factory, token)
        assert actor is not None and actor.role == "employee"

        async with factory() as session:
            await session.execute(
                update(db_models.User)
                .where(db_models.User.login == "employee")
                .values(role="manager")
            )
            await session.commit()

        promoted = await auth_service.resolve_actor(factory, token)
        assert promoted is not None and promoted.role == "manager"

    _run(_with_engine(scenario))


def test_resolve_rejects_a_deactivated_account_with_a_live_session() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = await auth_service.issue_session(session, user, 3600, now)

        assert await auth_service.resolve_actor(factory, token) is not None

        async with factory() as session:
            await session.execute(
                update(db_models.User)
                .where(db_models.User.login == "employee")
                .values(is_active=False)
            )
            await session.commit()

        assert await auth_service.resolve_actor(factory, token) is None

    _run(_with_engine(scenario))


# --- Origin enforcement ---


def test_origin_allows_only_the_configured_web_origin() -> None:
    settings = _settings()
    assert is_allowed_origin(settings, VALID_ORIGIN) is True
    assert is_allowed_origin(settings, "null") is False
    assert is_allowed_origin(settings, None) is False
    assert is_allowed_origin(settings, "") is False
    assert is_allowed_origin(settings, FOREIGN_ORIGIN) is False
    assert is_allowed_origin(settings, "http://localhost:3001") is False


# --- HTTP surface ---


def test_login_sets_an_http_only_lax_cookie() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))

        async def run() -> Any:
            async with _client(engine) as client:
                return await client.post(
                    "/api/auth/login",
                    json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                    headers={"origin": VALID_ORIGIN},
                )

        response = await run()
        assert response.status_code == 200, response.text
        assert response.json()["role"] == "employee"

        cookie_header = response.headers.get("set-cookie", "")
        assert "HttpOnly" in cookie_header
        assert "SameSite=lax" in cookie_header.replace("samesite", "SameSite")
        assert "Path=/" in cookie_header

    _run(_with_engine(scenario))


def test_login_cookie_value_is_not_the_stored_hash() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)

        async def run() -> str:
            async with _client(engine) as client:
                response = await client.post(
                    "/api/auth/login",
                    json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                    headers={"origin": VALID_ORIGIN},
                )
                return response.cookies[auth_service.SESSION_COOKIE_NAME]

        token = await run()
        async with factory() as session:
            rows = (await session.execute(select(db_models.Session))).scalars().all()
            assert bytes(rows[0].token_hash) == auth_service.hash_session_token(token)

    _run(_with_engine(scenario))


def test_login_rotates_the_session_token() -> None:
    """A second sign-in must not reuse the first token."""

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)

        async def login_twice() -> tuple[str, str]:
            async with _client(engine) as client:
                first = await client.post(
                    "/api/auth/login",
                    json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                    headers={"origin": VALID_ORIGIN},
                )
                second = await client.post(
                    "/api/auth/login",
                    json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                    headers={"origin": VALID_ORIGIN},
                )
                return (
                    first.cookies[auth_service.SESSION_COOKIE_NAME],
                    second.cookies[auth_service.SESSION_COOKIE_NAME],
                )

        first, second = await login_twice()
        assert first != second
        assert await auth_service.resolve_actor(factory, first) is None
        assert await auth_service.resolve_actor(factory, second) is not None

    _run(_with_engine(scenario))


def test_login_is_refused_without_an_origin() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))
        async with _client(engine) as client:
            response = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
            )
        assert response.status_code == 403
        assert response.json()["detail"] == "request origin is not allowed"

    _run(_with_engine(scenario))


def test_login_is_refused_for_a_foreign_origin() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))
        async with _client(engine) as client:
            response = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": FOREIGN_ORIGIN},
            )
        assert response.status_code == 403

    _run(_with_engine(scenario))


def test_login_does_not_leak_whether_an_account_exists() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))
        async with _client(engine) as client:
            unknown = await client.post(
                "/api/auth/login",
                json={"login": "ghost", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            wrong = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": "wrong"},
                headers={"origin": VALID_ORIGIN},
            )
        assert unknown.status_code == wrong.status_code == 401
        assert unknown.json() == wrong.json() == {"detail": "invalid credentials"}

    _run(_with_engine(scenario))


def test_login_response_never_contains_a_hash_or_token() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))
        async with _client(engine) as client:
            response = await client.post(
                "/api/auth/login",
                json={"login": "manager", "password": MANAGER_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
        body = response.text
        assert "argon2" not in body
        assert "password" not in body.lower()
        assert auth_service.SESSION_COOKIE_NAME not in body

    _run(_with_engine(scenario))


def test_me_returns_the_server_role() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "manager", "password": MANAGER_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            response = await client.get("/api/auth/me")
        assert response.status_code == 200
        body = response.json()
        assert body["role"] == "manager"
        assert body["login"] == "manager"
        assert "password" not in response.text.lower()

    _run(_with_engine(scenario))


def test_me_requires_a_session() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        async with _client(engine) as client:
            response = await client.get("/api/auth/me")
        assert response.status_code == 401

    _run(_with_engine(scenario))


def test_me_rejects_a_forged_cookie() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            client.cookies.set(auth_service.SESSION_COOKIE_NAME, "forged-token-value")
            response = await client.get("/api/auth/me")
        assert response.status_code == 401

    _run(_with_engine(scenario))


def test_me_ignores_a_client_supplied_role() -> None:
    """A role in the query string, header, or body must never influence /me."""

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            response = await client.get(
                "/api/auth/me",
                params={"role": "manager"},
                headers={"x-role": "manager", "x-user-role": "manager"},
            )
        assert response.status_code == 200
        assert response.json()["role"] == "employee"

    _run(_with_engine(scenario))


def test_logout_revokes_immediately() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            assert (await client.get("/api/auth/me")).status_code == 200

            logout = await client.post("/api/auth/logout", headers={"origin": VALID_ORIGIN})
            assert logout.status_code == 204
            assert "Max-Age=0" in logout.headers["set-cookie"]
            assert auth_service.SESSION_COOKIE_NAME not in client.cookies

            after = await client.get("/api/auth/me")
        assert after.status_code == 401

    _run(_with_engine(scenario))


def test_logout_requires_a_valid_origin() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            response = await client.post("/api/auth/logout")
            assert response.status_code == 403

            # A rejected logout must not have revoked the live session.
            assert (await client.get("/api/auth/me")).status_code == 200

    _run(_with_engine(scenario))


def test_logout_is_accepted_without_a_session() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        async with _client(engine) as client:
            response = await client.post("/api/auth/logout", headers={"origin": VALID_ORIGIN})
        assert response.status_code == 204

    _run(_with_engine(scenario))


def test_health_is_still_public_and_unaffected() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        async with _client(engine) as client:
            response = await client.get("/api/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    _run(_with_engine(scenario))


def test_role_changes_take_effect_on_the_next_request() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            assert (await client.get("/api/auth/me")).json()["role"] == "employee"

            async with factory() as session:
                await session.execute(
                    update(db_models.User)
                    .where(db_models.User.login == "employee")
                    .values(role="manager")
                )
                await session.commit()

            assert (await client.get("/api/auth/me")).json()["role"] == "manager"

    _run(_with_engine(scenario))


def test_deactivating_an_account_invalidates_its_live_session() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with _client(engine) as client:
            await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            assert (await client.get("/api/auth/me")).status_code == 200

            async with factory() as session:
                await session.execute(
                    update(db_models.User)
                    .where(db_models.User.login == "employee")
                    .values(is_active=False)
                )
                await session.commit()

            assert (await client.get("/api/auth/me")).status_code == 401

    _run(_with_engine(scenario))


# --- seed CLI contract ---


def test_seed_refuses_a_short_password() -> None:
    settings = _settings().model_copy(update={"seed_employee_password": SecretStr("short")})
    with pytest.raises(seed_module.SeedConfigurationError):
        _run(seed_module.seed_accounts(settings))


def test_seed_uses_argon2id_for_both_accounts() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        original = seed_module._engine
        seed_module._engine = lambda settings: engine
        try:
            logins = await seed_module.seed_accounts(_settings())
        finally:
            seed_module._engine = original

        assert logins == ["employee", "manager"]
        factory = create_session_factory(engine)
        async with factory() as session:
            rows = (await session.execute(select(db_models.User))).scalars().all()
            assert len(rows) == 2
            for row in rows:
                assert row.password_hash.startswith("$argon2id$")

    _run(_with_engine(scenario))


def test_seed_persists_both_accounts() -> None:
    """Regression: the seed must actually commit both rows."""

    async def scenario(engine: AsyncEngine) -> None:
        original = seed_module._engine
        seed_module._engine = lambda settings: engine
        try:
            await seed_module.seed_accounts(_settings())
        finally:
            seed_module._engine = original

        factory = create_session_factory(engine)
        async with factory() as session:
            rows = (
                (await session.execute(select(db_models.User).order_by(db_models.User.login)))
                .scalars()
                .all()
            )
        assert [row.login for row in rows] == ["employee", "manager"]

    _run(_with_engine(scenario))


def test_seed_rerun_preserves_user_id() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        original = seed_module._engine
        seed_module._engine = lambda settings: engine
        try:
            await seed_module.seed_accounts(_settings())
            factory = create_session_factory(engine)
            async with factory() as session:
                first = (
                    (
                        await session.execute(
                            select(db_models.User).where(db_models.User.login == "employee")
                        )
                    )
                    .scalar_one()
                    .user_id
                )
            await seed_module.seed_accounts(_settings())
            async with factory() as session:
                second = (
                    (
                        await session.execute(
                            select(db_models.User).where(db_models.User.login == "employee")
                        )
                    )
                    .scalar_one()
                    .user_id
                )
                total = (await session.execute(select(db_models.User))).scalars().all()
        finally:
            seed_module._engine = original
        assert first == second
        assert len(total) == 2

    _run(_with_engine(scenario))


def test_sessions_table_rejects_a_duplicate_token_hash() -> None:
    """The UNIQUE constraint on token_hash is part of the schema contract."""

    async def scenario(engine: AsyncEngine) -> None:
        await _seed(create_session_factory(engine))
        factory = create_session_factory(engine)
        async with factory() as session:
            user, now = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            token = auth_service.generate_session_token()
            digest = auth_service.hash_session_token(token)
            await session.execute(
                insert(db_models.Session).values(
                    user_id=user.user_id,
                    token_hash=digest,
                    created_at=now,
                    expires_at=auth_service.expires_at_from(now, 3600),
                )
            )
            await session.commit()
            with pytest.raises(IntegrityError):
                await session.execute(
                    insert(db_models.Session).values(
                        user_id=user.user_id,
                        token_hash=digest,
                        created_at=now,
                        expires_at=auth_service.expires_at_from(now, 3600),
                    )
                )
                await session.commit()
            await session.rollback()

    _run(_with_engine(scenario))


def test_failed_rotation_rolls_back_old_session_revocation() -> None:
    from unittest.mock import patch

    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, _ = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            old = await auth_service.issue_session(session, user, 3600)
            unrelated = await auth_service.issue_session(session, user, 3600)
            # Force the new insert to fail its uniqueness constraint after UPDATE.
            with patch.object(auth_service, "generate_session_token", return_value=old):
                with pytest.raises(IntegrityError):
                    await auth_service.issue_session(session, user, 3600, previous_token=old)
            await session.rollback()
        assert await auth_service.resolve_actor(factory, old) is not None
        assert await auth_service.resolve_actor(factory, unrelated) is not None

    _run(_with_engine(scenario))


def test_failed_login_preserves_old_session_and_success_preserves_other_devices() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        factory = create_session_factory(engine)
        await _seed(factory)
        async with factory() as session:
            user, _ = await auth_service.authenticate(session, "employee", EMPLOYEE_PASSWORD)
            unrelated = await auth_service.issue_session(session, user, 3600)
        async with _client(engine) as client:
            first = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": EMPLOYEE_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            old = first.cookies[auth_service.SESSION_COOKIE_NAME]
            failed = await client.post(
                "/api/auth/login",
                json={"login": "employee", "password": "wrong"},
                headers={"origin": VALID_ORIGIN},
            )
            assert failed.status_code == 401
            assert await auth_service.resolve_actor(factory, old) is not None
            switched = await client.post(
                "/api/auth/login",
                json={"login": "manager", "password": MANAGER_PASSWORD},
                headers={"origin": VALID_ORIGIN},
            )
            assert switched.status_code == 200
            actor = await auth_service.resolve_actor(
                factory, switched.cookies[auth_service.SESSION_COOKIE_NAME]
            )
            assert actor is not None and actor.role == "manager"
        assert await auth_service.resolve_actor(factory, old) is None
        assert await auth_service.resolve_actor(factory, unrelated) is not None

    _run(_with_engine(scenario))


def test_seed_uses_real_factory_with_explicit_test_database() -> None:
    async def scenario(engine: AsyncEngine) -> None:
        # No monkeypatch: the supplied Settings must select the isolated database.
        assert await seed_module.seed_accounts(_settings()) == ["employee", "manager"]
        async with AsyncSession(engine) as session:
            logins = (await session.execute(select(db_models.User.login))).scalars().all()
        assert set(logins) == {"employee", "manager"}

    _run(_with_engine(scenario))
