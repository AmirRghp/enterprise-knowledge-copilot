"""Tests for the manager upload routes.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database and
reuses the real login flow, so the cookie, the Origin check, and the role
resolution are exercised end to end rather than stubbed.

The point of this file is what the API refuses: an unauthenticated caller, an
employee, a cross-site Origin, an unknown access role, a disallowed extension, an
oversized body, invalid UTF-8, and a job id that does not exist. It also pins that
a successful upload returns no document text and no provider detail.
"""

import asyncio
import uuid
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.auth import get_settings
from app.api.upload_guard import upload_body_ceiling
from app.auth import service as auth_service
from app.db import models as db_models
from app.db.engine import create_engine, create_session_factory
from app.main import create_app
from app.settings import Settings
from tests.provider_fixtures import seed_panel

TEST_PASSWORDS = {
    "employee": "Ek-employee-test-password",
    "manager": "Ek-manager-test-password",
}
VALID_ORIGIN = "http://localhost:3000"
FOREIGN_ORIGIN = "http://evil.example.com"

DOCUMENT_TEXT = "# سیاست بازپرداخت\n\nهزینه سفر بازپرداخت می‌شود.\n"
DOCUMENT_NAME = "policy.md"


def _settings(**overrides: Any) -> Settings:
    return Settings(
        db_name="enterprise_knowledge_copilot_test",
        **overrides,
    )


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop; asyncpg requires it."""
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def pinned_test_database() -> None:
    """Guard against ever pointing this file at the application database."""
    assert _settings().db_name == "enterprise_knowledge_copilot_test"


def _client(engine: AsyncEngine) -> AsyncClient:
    app = create_app()
    app.state.db_engine = engine
    app.state.db_session_factory = create_session_factory(engine)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _reset(engine: AsyncEngine) -> None:
    await seed_panel(engine)
    async with engine.begin() as connection:
        await connection.execute(delete(db_models.Chunk))
        await connection.execute(delete(db_models.Section))
        await connection.execute(delete(db_models.IngestionJob))
        await connection.execute(delete(db_models.Document))
        await connection.execute(delete(db_models.Session))
        await connection.execute(delete(db_models.User))


async def _seed(factory: async_sessionmaker[AsyncSession]) -> None:
    from datetime import UTC, datetime

    now = datetime.now(UTC)
    async with factory() as session:
        for login, password, role in (
            ("employee", TEST_PASSWORDS["employee"], "employee"),
            ("manager", TEST_PASSWORDS["manager"], "manager"),
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


def _scenario[Result](
    body: Callable[
        [AsyncEngine, async_sessionmaker[AsyncSession], AsyncClient], Coroutine[Any, Any, Result]
    ],
) -> Result:
    async def main() -> Result:
        settings = _settings()
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

    return _run(main())


async def _login_as(client: AsyncClient, role: str) -> str:
    """Sign in as a seeded account and return its session token.

    The credential comes from ``TEST_PASSWORDS`` rather than being written into
    each test, so a role change cannot leave one test signing in as the wrong
    account.
    """
    return await _login(client, role, TEST_PASSWORDS[role])


async def _login(client: AsyncClient, login: str, password: str) -> str:
    response = await client.post(
        "/api/auth/login",
        json={"login": login, "password": password},
        headers={"Origin": VALID_ORIGIN},
    )
    assert response.status_code == 200, response.text
    token = response.cookies.get(auth_service.SESSION_COOKIE_NAME)
    assert token
    return token


async def _upload(
    client: AsyncClient,
    *,
    name: str = DOCUMENT_NAME,
    content: bytes | str = DOCUMENT_TEXT,
    title: str = "سیاست",
    access_role: str = "employee",
) -> Response:
    payload = content.encode("utf-8") if isinstance(content, str) else content
    return await client.post(
        "/api/manager/documents",
        data={"title": title, "access_role": access_role},
        files={"file": (name, payload, "text/markdown")},
        headers={"Origin": VALID_ORIGIN},
    )


# --------------------------------------------------------------------------
# authentication and authorization
# --------------------------------------------------------------------------


def test_an_anonymous_caller_cannot_upload() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        response = await _upload(client)
        assert response.status_code == 401
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_an_employee_cannot_upload() -> None:
    """The role comes from the users row, never from the request."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, token)
        response = await _upload(client)
        assert response.status_code == 403
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_a_cross_site_origin_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, token)
        response = await client.post(
            "/api/manager/documents",
            data={"title": "x", "access_role": "employee"},
            files={"file": (DOCUMENT_NAME, DOCUMENT_TEXT.encode(), "text/markdown")},
            headers={"Origin": FOREIGN_ORIGIN},
        )
        assert response.status_code == 403
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_the_list_and_job_routes_are_also_manager_only() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "employee"))
        assert (await client.get("/api/manager/documents")).status_code == 403
        assert (await client.get(f"/api/manager/jobs/{uuid.uuid4()}")).status_code == 403

    _scenario(body)


# --------------------------------------------------------------------------
# the accepted upload
# --------------------------------------------------------------------------


def test_a_manager_upload_returns_a_pending_job_and_leaks_no_content() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, token)
        response = await _upload(client)

        assert response.status_code == 202, response.text
        payload = response.json()
        assert payload["status"] == "pending"
        assert payload["attempt"] == 0
        assert payload["safe_error"] is None
        assert payload["revision"] != payload["document_id"]
        # Neither the document text nor any internal column is echoed back.
        assert "بازپرداخت" not in response.text
        assert "source_text" not in payload
        assert "lease_token" not in payload

        async with factory() as session:
            document = await session.get(db_models.Document, payload["document_id"])
            assert document is not None
            assert document.current_revision is None
            assert document.access_role == "employee"

    _scenario(body)


def test_the_manager_list_reports_processing_state() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        await _upload(client)

        response = await client.get("/api/manager/documents")
        assert response.status_code == 200
        documents = response.json()["documents"]
        assert len(documents) == 1
        assert documents[0]["processing_status"] == "pending"
        assert documents[0]["content_status"] == "active"
        assert documents[0]["version"] == "unpublished"

    _scenario(body)


def test_job_status_is_readable_and_an_unknown_id_is_404() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        created = (await _upload(client)).json()

        response = await client.get(f"/api/manager/jobs/{created['job_id']}")
        assert response.status_code == 200
        assert response.json()["document_id"] == created["document_id"]

        missing = await client.get(f"/api/manager/jobs/{uuid.uuid4()}")
        assert missing.status_code == 404
        assert missing.json()["detail"] == "job not found"

    _scenario(body)


# --------------------------------------------------------------------------
# what the upload route refuses
# --------------------------------------------------------------------------


def test_an_unknown_access_role_is_refused_rather_than_defaulted() -> None:
    """A document with an unknown policy must never be assumed public."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        # Every unusable value is refused with 400 and a message naming the field.
        # An empty value is a missing field rather than an unknown role, and must
        # still refuse instead of falling back to a public policy.
        for role in ("admin", "EMPLOYEE", "root", ""):
            response = await _upload(client, access_role=role)
            assert response.status_code == 400, (role, response.status_code)
            detail = response.json()["detail"]
            assert "access_role" in detail, (role, detail)
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


@pytest.mark.parametrize("name", ["report.pdf", "notes", "payload.exe", "x.php"])
def test_only_markdown_and_plain_text_upload(name: str) -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        response = await _upload(client, name=name)
        assert response.status_code == 400
        assert "only .md and .txt" in response.json()["detail"]
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_invalid_utf8_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        response = await _upload(client, content=b"\xff\xfe not utf8")
        assert response.status_code == 400
        assert "UTF-8" in response.json()["detail"]

    _scenario(body)


def test_the_configured_size_ceiling_is_enforced() -> None:
    """A lowered ceiling must reject before staging, not after."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        app = client._transport.app  # type: ignore[attr-defined]
        app.dependency_overrides[get_settings] = lambda: _settings(upload_max_bytes=64)
        try:
            response = await _upload(client, content=b"a" * 500)
        finally:
            app.dependency_overrides.clear()
        assert response.status_code == 400
        assert "larger than the allowed size" in response.json()["detail"]
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_a_blank_title_is_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        response = await _upload(client, title="   ")
        assert response.status_code == 400
        assert "title" in response.json()["detail"]

    _scenario(body)


def test_the_active_document_quota_is_enforced_by_the_api() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        client.cookies.set(auth_service.SESSION_COOKIE_NAME, await _login_as(client, "manager"))
        assert (await _upload(client)).status_code == 202

        app = client._transport.app  # type: ignore[attr-defined]
        app.dependency_overrides[get_settings] = lambda: _settings(upload_max_active_documents=1)
        try:
            second = await _upload(client, title="دوم")
        finally:
            app.dependency_overrides.clear()
        assert second.status_code == 400
        assert "limit" in second.json()["detail"]

    _scenario(body)


# --------------------------------------------------------------------------
# regressions from the Part 8 review
# --------------------------------------------------------------------------

BOUNDARY = "----opencodeboundarytest"


def _multipart(*, size: int, files: int = 1) -> bytes:
    """Build a real multipart body, so the guard is exercised as in production."""

    def field(name: str, value: str) -> bytes:
        return (
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        ).encode()

    def part(index: int) -> bytes:
        return (
            (
                f"--{BOUNDARY}\r\n"
                f'Content-Disposition: form-data; name="file{index}"; filename="f{index}.md"\r\n'
                f"Content-Type: text/markdown\r\n\r\n"
            ).encode()
            + b"x" * size
            + b"\r\n"
        )

    body = field("title", "بزرگ") + field("access_role", "employee")
    body += b"".join(part(index) for index in range(files))
    return body + f"--{BOUNDARY}--\r\n".encode()


async def _raw_post(
    client: AsyncClient, payload: bytes, *, token: str, declared_length: int | None
) -> tuple[int, int]:
    """POST the body directly at the ASGI app and count the bytes it pulled.

    ``declared_length`` of ``None`` omits ``Content-Length``, which is how a
    chunked request arrives; the ceiling must not depend on it.
    """
    app = client._transport.app  # type: ignore[attr-defined]
    headers = [
        (b"host", b"test"),
        (b"content-type", f"multipart/form-data; boundary={BOUNDARY}".encode()),
        (b"origin", VALID_ORIGIN.encode()),
        (b"cookie", f"{auth_service.SESSION_COOKIE_NAME}={token}".encode()),
    ]
    if declared_length is not None:
        headers.append((b"content-length", str(declared_length).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/manager/documents",
        "raw_path": b"/api/manager/documents",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": headers,
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }
    remaining = payload
    consumed = 0

    async def receive() -> dict[str, object]:
        nonlocal remaining, consumed
        if remaining:
            chunk, remaining = remaining[:65536], remaining[65536:]
            consumed += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": True}
        return {"type": "http.request", "body": b"", "more_body": False}

    status: dict[str, int] = {}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = int(message["status"])  # type: ignore[arg-type]

    await app(scope, receive, send)
    return status.get("code", 0), consumed


def test_an_authorised_oversized_body_is_refused_and_nothing_is_staged() -> None:
    """Part 8 review P1: the ceiling applies to the whole body, not just the file."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        payload = _multipart(size=3 * 1024 * 1024)

        status, _ = await _raw_post(client, payload, token=token, declared_length=len(payload))
        assert status == 413
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_a_chunked_oversized_body_is_refused_too() -> None:
    """The absence of Content-Length must not remove the limit."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        payload = _multipart(size=3 * 1024 * 1024)

        status, consumed = await _raw_post(client, payload, token=token, declared_length=None)
        assert status == 413
        # The application is what buffers, so what it was handed is what matters.
        assert consumed <= upload_body_ceiling(_settings()) + 65536, consumed
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_several_file_parts_are_refused() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        payload = _multipart(size=2048, files=3)

        status, _ = await _raw_post(client, payload, token=token, declared_length=len(payload))
        assert status == 400
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)


def test_a_missing_form_field_is_refused() -> None:
    """A hand-parsed form must not turn an absent field into an empty string."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")
        payload = (
            (
                f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="file"; '
                f'filename="a.md"\r\nContent-Type: text/markdown\r\n\r\n'
            ).encode()
            + b"# t\n\nm\n"
            + f"\r\n--{BOUNDARY}--\r\n".encode()
        )

        status, _ = await _raw_post(client, payload, token=token, declared_length=len(payload))
        assert status == 400
        async with factory() as session:
            assert (
                await session.execute(select(func.count()).select_from(db_models.Document))
            ).scalar_one() == 0

    _scenario(body)
