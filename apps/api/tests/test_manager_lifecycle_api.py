"""Tests for the manager replacement and deletion routes.

Runs against the isolated ``enterprise_knowledge_copilot_test`` database and
reuses the real login flow, so the cookie, the Origin check, and the role
resolution are exercised end to end rather than stubbed.

The point of this file is what the routes refuse. An unauthenticated caller, an
employee, a cross-site Origin, an unknown document, a second replacement while one
is already running, a replacement of a deleted document, a malformed document id, a
disallowed extension, invalid UTF-8, an unknown access role, and an oversized body
must all be refused. It also pins that a delete is idempotent and that neither route
echoes document text back.
"""

import asyncio
import re
from collections.abc import Callable, Coroutine
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.manager import DOCUMENT_ID_PATTERN
from app.api.upload_guard import upload_body_ceiling
from app.auth import service as auth_service
from app.db import models as db_models
from app.db.engine import create_engine, create_session_factory
from app.main import create_app
from app.settings import Settings

TEST_PASSWORDS = {
    "employee": "Ek-employee-test-password",
    "manager": "Ek-manager-test-password",
}
VALID_ORIGIN = "http://localhost:3000"
FOREIGN_ORIGIN = "http://evil.example.com"

DOCUMENT_TEXT = "# سیاست بازپرداخت\n\nهزینه سفر بازپرداخت می‌شود.\n"
REPLACEMENT_TEXT = "# سیاست بازپرداخت\n\nهزینه سفر تا سقف روزانه بازپرداخت می‌شود.\n"
DOCUMENT_NAME = "policy.md"
BOUNDARY = "----opencodeboundarytest"
UPLOAD_PATH = "/api/manager/documents"


def _settings(**overrides: Any) -> Settings:
    return Settings(
        db_name="enterprise_knowledge_copilot_test",
        seed_employee_password=TEST_PASSWORDS["employee"],
        seed_manager_password=TEST_PASSWORDS["manager"],
        **overrides,
    )


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """Run one coroutine on a single event loop; asyncpg binds a connection to it."""
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
            factory = create_session_factory(engine)
            await _seed(factory)
            async with _client(engine) as client:
                return await body(engine, factory, client)
        finally:
            await engine.dispose()

    return _run(main())


async def _login(client: AsyncClient, role: str) -> str:
    """Sign in and return the session token.

    The jar is cleared first: the login response already set a cookie on the
    client, and setting it again would leave two entries under one name, which
    ``httpx`` refuses to resolve rather than guess between.
    """
    response = await client.post(
        "/api/auth/login",
        json={"login": role, "password": TEST_PASSWORDS[role]},
        headers={"Origin": VALID_ORIGIN},
    )
    assert response.status_code == 200, response.text
    token = response.cookies.get(auth_service.SESSION_COOKIE_NAME)
    assert token
    client.cookies.clear()
    client.cookies.set(auth_service.SESSION_COOKIE_NAME, token)
    return token


async def _create(
    client: AsyncClient,
    *,
    title: str = "سیاست",
    access_role: str = "employee",
    content: bytes | str = DOCUMENT_TEXT,
    name: str = DOCUMENT_NAME,
) -> str:
    """Create one document and return its id."""
    payload = content.encode("utf-8") if isinstance(content, str) else content
    response = await client.post(
        UPLOAD_PATH,
        data={"title": title, "access_role": access_role},
        files={"file": (name, payload, "text/markdown")},
        headers={"Origin": VALID_ORIGIN},
    )
    assert response.status_code == 202, response.text
    return str(response.json()["document_id"])


async def _settle(factory: Any, document_id: str) -> None:
    """Make every job for this document terminal, as a worker would.

    A replacement is refused while any job for the document is still in flight, so
    a test that wants to exercise a replacement has to let the create finish first.
    """
    async with factory() as session:
        await session.execute(
            db_models.IngestionJob.__table__.update()
            .where(db_models.IngestionJob.document_id == document_id)
            .values(
                status="failed",
                safe_error="settled by the test",
                lease_owner=None,
                lease_token=None,
                lease_expires_at=None,
            )
        )
        await session.commit()


async def _replace(
    client: AsyncClient,
    document_id: str,
    *,
    title: str = "سیاست (ویرایش)",
    access_role: str = "employee",
    content: bytes | str = REPLACEMENT_TEXT,
    name: str = DOCUMENT_NAME,
    origin: str = VALID_ORIGIN,
) -> Response:
    payload = content.encode("utf-8") if isinstance(content, str) else content
    return await client.put(
        f"{UPLOAD_PATH}/{document_id}",
        data={"title": title, "access_role": access_role},
        files={"file": (name, payload, "text/markdown")},
        headers={"Origin": origin},
    )


async def _delete(client: AsyncClient, document_id: str, *, origin: str = VALID_ORIGIN) -> Response:
    return await client.delete(f"{UPLOAD_PATH}/{document_id}", headers={"Origin": origin})


def _only_id(listing: Response, title: str) -> str:
    """Return the one document with this title, failing loudly if it is not unique."""
    matches = [row for row in listing.json()["documents"] if row["title"] == title]
    assert len(matches) == 1, [row["title"] for row in listing.json()["documents"]]
    return str(matches[0]["document_id"])


def _row(listing: Response, document_id: str) -> dict[str, Any]:
    """Return one document's row from a list response."""
    matches = [row for row in listing.json()["documents"] if row["document_id"] == document_id]
    assert len(matches) == 1, [row["document_id"] for row in listing.json()["documents"]]
    return matches[0]


async def _document_row(factory: Any, document_id: str) -> Any:
    async with factory() as session:
        return await session.get(db_models.Document, document_id)


async def _job_count(factory: Any) -> int:
    async with factory() as session:
        return int(
            (
                await session.execute(select(func.count()).select_from(db_models.IngestionJob))
            ).scalar_one()
        )


# --------------------------------------------------------------------------
# authorization
# --------------------------------------------------------------------------


def test_an_anonymous_caller_cannot_replace_or_delete() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        # Stage one document as a manager, drop the cookie, then try both writes.
        await _login(client, "manager")
        document_id = await _create(client)
        client.cookies.clear()

        assert (await _replace(client, document_id)).status_code == 401
        assert (await _delete(client, document_id)).status_code == 401
        document = await _document_row(factory, document_id)
        assert document is not None and document.status == "active"
        assert await _job_count(factory) == 1

    _scenario(body)


def test_an_employee_cannot_replace_or_delete() -> None:
    """The role comes from the users row, never from the request."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        client.cookies.clear()
        await _login(client, "employee")

        assert (await _replace(client, document_id)).status_code == 403
        assert (await _delete(client, document_id)).status_code == 403
        document = await _document_row(factory, document_id)
        assert document is not None and document.status == "active"
        assert await _job_count(factory) == 1

    _scenario(body)


def test_a_cross_site_origin_cannot_replace_or_delete() -> None:
    """A browser attaches Origin to a cross-site request, so the guard stops it first."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)

        assert (await _replace(client, document_id, origin=FOREIGN_ORIGIN)).status_code == 403
        assert (await _delete(client, document_id, origin=FOREIGN_ORIGIN)).status_code == 403
        document = await _document_row(factory, document_id)
        assert document is not None and document.status == "active"
        # Refused before any body was read, so nothing was staged.
        assert await _job_count(factory) == 1

    _scenario(body)


# --------------------------------------------------------------------------
# what a replacement refuses
# --------------------------------------------------------------------------


def test_replacing_an_unknown_document_returns_404() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")

        response = await _replace(client, "DOC-404")

        assert response.status_code == 404
        assert await _job_count(factory) == 0

    _scenario(body)


def test_a_second_replacement_while_one_is_running_returns_409() -> None:
    """Two live jobs would overwrite each other's staged policy."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)

        first = await _replace(client, document_id, title="اول", access_role="manager")
        assert first.status_code == 202
        second = await _replace(client, document_id, title="دوم", access_role="employee")

        assert second.status_code == 409
        document = await _document_row(factory, document_id)
        assert document is not None
        assert document.staged_title == "اول"
        assert document.staged_access_role == "manager"
        assert await _job_count(factory) == 2

    _scenario(body)


def test_replacing_a_deleted_document_returns_409() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        assert (await _delete(client, document_id)).status_code == 204

        response = await _replace(client, document_id)

        assert response.status_code == 409
        assert await _job_count(factory) == 1

    _scenario(body)


# The identifier shape is asserted in two places on purpose. The pattern itself
# decides what the route accepts, and the raw ASGI test decides what actually
# reaches it: an HTTP client is free to normalise a path before it is sent, so only
# the server side can say what a separator or an escape does here.
# A leading digit is legitimate and must stay accepted: a server-generated id is a
# UUID, and a UUID may begin with a digit.
ACCEPTED_IDS = [
    "DOC-001",
    "doc_001",
    "A",
    "0",
    "1bad-start",
    "a" * 64,
    "b3f1c2de-0a1b-4c2d-8e3f-4a5b6c7d8e9f",
]
REJECTED_IDS = [
    "",
    "-leading-dash",
    ".leading-dot",
    "DOC-001/..",
    "DOC-001/sections",
    "DOC%2F001",
    "DOC-001?x=1",
    "DOC-001#frag",
    "DOC 001",
    "a" * 65,
    "../DOC-001",
    "DOC-001;drop",
]


@pytest.mark.parametrize("document_id", ACCEPTED_IDS)
def test_the_identifier_pattern_accepts_the_shapes_it_intends(document_id: str) -> None:
    assert re.fullmatch(DOCUMENT_ID_PATTERN, document_id)


@pytest.mark.parametrize("document_id", REJECTED_IDS)
def test_the_identifier_pattern_refuses_anything_else(document_id: str) -> None:
    """Each of these would either change which document is named or reach a query
    a downstream statement would misread."""
    assert re.fullmatch(DOCUMENT_ID_PATTERN, document_id) is None


@pytest.mark.parametrize("document_id", ["-leading-dash", "a" * 65, "DOC 001"])
def test_a_malformed_document_id_is_refused_by_the_route(document_id: str) -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")

        response = await _replace(client, document_id)

        assert response.status_code == 422, response.text
        assert await _job_count(factory) == 0

    _scenario(body)


def test_a_raw_path_with_a_separator_never_reaches_the_route() -> None:
    """Sent past any client-side path normalisation, so this is what the server sees."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login(client, "manager")
        payload = _multipart(size=16)

        for path in (
            f"{UPLOAD_PATH}/DOC-001%2Fsections",
            f"{UPLOAD_PATH}/DOC-001/../DOC-002",
            f"{UPLOAD_PATH}/DOC-001;sections",
        ):
            status, _ = await _raw_write(
                client,
                payload,
                method="PUT",
                path=path,
                token=token,
                declared_length=len(payload),
            )
            # Rejected as a route or a validation failure, and above all never 202.
            assert status in (404, 405, 422), (path, status)

        assert await _job_count(factory) == 0

    _scenario(body)


def test_both_document_id_shapes_are_accepted() -> None:
    """A corpus id and a server-generated UUID must both work."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        generated = await _create(client)
        await _settle(factory, generated)
        assert (await _replace(client, generated)).status_code == 202

        async with factory() as session:
            session.add(
                db_models.Document(
                    document_id="DOC-001",
                    title="متن دستی",
                    content_version="unpublished",
                    access_role="employee",
                    current_revision=None,
                    status="active",
                    created_at=datetime_now(),
                    updated_at=datetime_now(),
                )
            )
            await session.commit()

        assert (await _replace(client, "DOC-001")).status_code == 202

    _scenario(body)


def datetime_now() -> Any:
    from datetime import UTC, datetime

    return datetime.now(UTC)


# --------------------------------------------------------------------------
# a replacement accepts exactly what a create accepts
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "expected"),
    [
        ({"name": "report.pdf"}, 400),
        ({"name": "notes"}, 400),
        ({"content": b"\xff\xfe\x00bad"}, 400),
        ({"access_role": "admin"}, 400),
        ({"access_role": ""}, 400),
    ],
)
def test_a_replacement_rejects_what_a_create_would(
    overrides: dict[str, Any], expected: int
) -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)

        response = await _replace(client, document_id, **overrides)

        assert response.status_code == expected, response.text
        document = await _document_row(factory, document_id)
        assert document is not None
        # Nothing was staged by the refused request.
        assert document.staged_title is None
        assert await _job_count(factory) == 1

    _scenario(body)


def test_a_replacement_requires_a_title_and_a_role() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)

        no_title = await client.put(
            f"{UPLOAD_PATH}/{document_id}",
            data={"access_role": "employee"},
            files={"file": (DOCUMENT_NAME, REPLACEMENT_TEXT.encode(), "text/markdown")},
            headers={"Origin": VALID_ORIGIN},
        )
        no_role = await client.put(
            f"{UPLOAD_PATH}/{document_id}",
            data={"title": "بدون نقش"},
            files={"file": (DOCUMENT_NAME, REPLACEMENT_TEXT.encode(), "text/markdown")},
            headers={"Origin": VALID_ORIGIN},
        )

        assert no_title.status_code == 400
        assert no_role.status_code == 400
        assert await _job_count(factory) == 1

    _scenario(body)


def test_a_successful_replacement_returns_no_document_text() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)

        response = await _replace(client, document_id)

        assert response.status_code == 202
        body = response.text
        assert "بازپرداخت" not in body
        assert set(response.json()) == {
            "job_id",
            "document_id",
            "revision",
            "status",
            "attempt",
            "safe_error",
            "created_at",
            "finished_at",
        }

    _scenario(body)


# --------------------------------------------------------------------------
# the ceiling reaches the replacement, not just the create
# --------------------------------------------------------------------------


def _multipart(size: int) -> bytes:
    """Build a real multipart body, so the guard is exercised as in production."""

    def field(name: str, value: str) -> bytes:
        return (
            f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
        ).encode()

    part = (
        (
            f"--{BOUNDARY}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="f.md"\r\n'
            f"Content-Type: text/markdown\r\n\r\n"
        ).encode()
        + b"x" * size
        + b"\r\n"
    )
    return (
        field("title", "بزرگ")
        + field("access_role", "employee")
        + part
        + f"--{BOUNDARY}--\r\n".encode()
    )


async def _raw_write(
    client: AsyncClient,
    payload: bytes,
    *,
    method: str,
    path: str,
    token: str,
    declared_length: int | None,
) -> tuple[int, int]:
    """Send the body straight at the ASGI app and count the bytes it pulled.

    ``declared_length`` of ``None`` omits ``Content-Length``, which is how a chunked
    request arrives; the ceiling must not depend on it.
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
        "method": method,
        "path": path,
        "raw_path": path.encode(),
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


def test_an_oversized_replacement_body_is_refused_before_it_is_parsed() -> None:
    """413, not the 400 a route-level size check would have produced."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login(client, "manager")
        payload = _multipart(size=3 * 1024 * 1024)

        status, _ = await _raw_write(
            client,
            payload,
            method="PUT",
            path=f"{UPLOAD_PATH}/DOC-001",
            token=token,
            declared_length=len(payload),
        )

        assert status == 413
        assert await _job_count(factory) == 0

    _scenario(body)


def test_a_chunked_oversized_replacement_body_is_refused_too() -> None:
    """The absence of Content-Length must not remove the limit."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login(client, "manager")
        payload = _multipart(size=3 * 1024 * 1024)

        status, consumed = await _raw_write(
            client,
            payload,
            method="PUT",
            path=f"{UPLOAD_PATH}/DOC-001",
            token=token,
            declared_length=None,
        )

        assert status == 413
        # The application is what buffers, so what it was handed is what matters.
        assert consumed <= upload_body_ceiling(_settings()) + 65536, consumed
        assert await _job_count(factory) == 0

    _scenario(body)


def test_a_deeper_path_under_the_upload_path_is_not_guarded() -> None:
    """The guard covers the create and replace endpoints only, so it cannot widen.

    There is no such route, so this is a 404 from the router rather than a 413 from
    the guard. If the guard ever grew to cover grandchildren, this would change.
    """

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        token = await _login(client, "manager")
        payload = _multipart(size=3 * 1024 * 1024)

        status, _ = await _raw_write(
            client,
            payload,
            method="PUT",
            path=f"{UPLOAD_PATH}/DOC-001/sections",
            token=token,
            declared_length=len(payload),
        )

        assert status == 404, status

    _scenario(body)


# --------------------------------------------------------------------------
# deletion
# --------------------------------------------------------------------------


def test_deleting_a_document_returns_204_and_marks_it_inactive() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)

        response = await _delete(client, document_id)

        assert response.status_code == 204
        assert response.content == b""
        document = await _document_row(factory, document_id)
        assert document is not None
        assert document.status == "inactive"

    _scenario(body)


def test_deleting_twice_and_deleting_an_unknown_id_are_both_204() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)

        assert (await _delete(client, document_id)).status_code == 204
        assert (await _delete(client, document_id)).status_code == 204
        assert (await _delete(client, "DOC-404")).status_code == 204

    _scenario(body)


def test_a_deleted_document_is_shown_as_inactive_in_the_list() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)

        await _delete(client, document_id)
        response = await client.get(UPLOAD_PATH, headers={"Origin": VALID_ORIGIN})

        assert response.status_code == 200
        rows = [row for row in response.json()["documents"] if row["document_id"] == document_id]
        assert len(rows) == 1
        assert rows[0]["content_status"] == "inactive"

    _scenario(body)


def test_the_list_reports_indexed_content_independently_of_the_latest_job() -> None:
    """Part 10 review: a pending or failed replacement says nothing about indexing.

    ``version`` cannot stand in for this, because it is the declared version and an
    untrusted file may declare the ``unpublished`` sentinel itself.
    """

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)
        assert (await _replace(client, document_id)).status_code == 202

        async with factory() as session:
            document = await session.get(db_models.Document, document_id)
            assert document is not None
            # A published revision plus a replacement that is still queued.
            document.current_revision = "an-indexed-revision"
            await session.commit()

        row = _row(await client.get(UPLOAD_PATH, headers={"Origin": VALID_ORIGIN}), document_id)
        assert row["processing_status"] == "pending"
        assert row["has_published_revision"] is True

        async with factory() as session:
            await session.execute(
                db_models.IngestionJob.__table__.update()
                .where(db_models.IngestionJob.document_id == document_id)
                .values(
                    status="failed", safe_error="forced", lease_token=None, lease_expires_at=None
                )
            )
            await session.commit()

        row = _row(await client.get(UPLOAD_PATH, headers={"Origin": VALID_ORIGIN}), document_id)
        assert row["processing_status"] == "failed"
        assert row["has_published_revision"] is True

        # A document that never published anything reports no indexed content, even
        # once its job says "ready".
        await _create(client, title="هرگز منتشر نشد")
        never = _row(
            await client.get(UPLOAD_PATH, headers={"Origin": VALID_ORIGIN}),
            _only_id(
                await client.get(UPLOAD_PATH, headers={"Origin": VALID_ORIGIN}), "هرگز منتشر نشد"
            ),
        )
        assert never["has_published_revision"] is False

    _scenario(body)


def test_deleting_a_document_fails_its_open_replacement() -> None:
    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)
        staged = await _replace(client, document_id)
        assert staged.status_code == 202

        assert (await _delete(client, document_id)).status_code == 204

        async with factory() as session:
            row = await session.get(db_models.IngestionJob, staged.json()["job_id"])
        assert row is not None
        assert row.status == "failed"
        assert "deleted" in (row.safe_error or "")
        assert row.lease_token is None and row.lease_expires_at is None

    _scenario(body)


def test_a_document_can_be_replaced_again_after_the_first_replacement_settles() -> None:
    """The 409 is about work in flight, not a one-way door."""

    async def body(engine: AsyncEngine, factory: Any, client: AsyncClient) -> None:
        await _login(client, "manager")
        document_id = await _create(client)
        await _settle(factory, document_id)
        assert (await _replace(client, document_id)).status_code == 202

        # Once that replacement is terminal a new one is accepted.
        await _settle(factory, document_id)

        assert (await _replace(client, document_id, title="سوم")).status_code == 202

    _scenario(body)
