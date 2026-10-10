"""Tests for the document list and the source section endpoints.

The property that carries this part is **indistinguishability**. A caller must not be able
to tell a document that does not exist from one they may not read from one whose revision
has been replaced, because any of those three answering differently turns this endpoint into
a corpus enumerator: probe ids, watch which answer, learn the catalogue. So the negative
tests compare the three responses to each other - status, parsed body *and* raw bytes -
rather than asserting each is merely a 404, which would pass while the bodies differed.

Every request goes through the real login flow and the real session row, so a test cannot
pass by constructing an actor the product would never build.
"""

import asyncio
from collections.abc import Coroutine
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.api.auth import get_settings  # noqa: F401 - documents routes depend on it too
from app.auth import service as auth_service
from app.db import models as db_models
from app.db.engine import create_engine, create_session_factory
from app.main import create_app
from app.settings import Settings
from tests.test_manager_api import (
    FOREIGN_ORIGIN,
    TEST_PASSWORDS,
    _login_as,
)
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
    _worker,
)

STALE_REVISION = "00000000-0000-0000-0000-000000000000"


def _settings(**overrides: Any) -> Settings:
    return Settings(
        db_name="enterprise_knowledge_copilot_test",
        seed_employee_password=TEST_PASSWORDS["employee"],
        seed_manager_password=TEST_PASSWORDS["manager"],
        **overrides,
    )


@pytest.fixture(autouse=True)
def pinned_test_database() -> None:
    """Guard against ever pointing this file at the application database."""
    assert _settings().db_name == "enterprise_knowledge_copilot_test"


def _client(engine: AsyncEngine) -> AsyncClient:
    app = create_app()
    app.state.db_engine = engine
    app.state.db_session_factory = create_session_factory(engine)
    return AsyncClient(transport=_transport(app), base_url="http://test")


def _transport(app: Any) -> Any:
    from httpx import ASGITransport

    return ASGITransport(app=app)


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    """One coroutine on one event loop; asyncpg requires it."""
    return asyncio.run(coroutine)


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


async def _publish_documents(factory: async_sessionmaker[AsyncSession]) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )
    await _publish(factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager")


async def _revision_of(factory: async_sessionmaker[AsyncSession], document_id: str) -> str:
    async with factory() as session:
        document = await session.get(db_models.Document, document_id)
    assert document is not None and document.current_revision, document_id
    return document.current_revision


async def _section_id_of(factory: async_sessionmaker[AsyncSession], document_id: str) -> str:
    async with factory() as session:
        rows = (
            await session.execute(
                select(db_models.Section.section_id)
                .where(db_models.Section.document_id == document_id)
                .order_by(db_models.Section.ordinal)
            )
        ).all()
    assert rows, document_id
    return str(rows[0][0])


def _scenario[Result](body: Any) -> Result:
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


def _source_url(document_id: str, section_id: str, revision: str) -> str:
    return f"/api/sources/{document_id}/sections/{section_id}?revision={revision}"


# --------------------------------------------------------------------------
# GET /api/documents
# --------------------------------------------------------------------------


def test_an_employee_sees_only_employee_documents() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        assert response.status_code == 200, response.text
        listed = response.json()["documents"]
        assert [row["document_id"] for row in listed] == [EMPLOYEE_DOCUMENT]
        assert all(row["access_role"] == "employee" for row in listed)

    _scenario(body)


def test_a_manager_sees_both_roles_documents() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "manager")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        assert response.status_code == 200, response.text
        assert {row["document_id"] for row in response.json()["documents"]} == {
            EMPLOYEE_DOCUMENT,
            MANAGER_DOCUMENT,
        }


def test_the_list_carries_exactly_the_citation_fields() -> None:
    """A list a caller cannot cite from is a list that is missing the revision."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        row = response.json()["documents"][0]
        assert set(row) == {"document_id", "title", "access_role", "revision"}
        assert row["revision"]
        assert row["title"]

    _scenario(body)


def test_an_unauthenticated_list_is_refused() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        response = await client.get("/api/documents")

        assert response.status_code == 401

    _scenario(body)


def test_a_cross_site_request_is_refused_on_the_unsafe_method() -> None:
    """Where the API itself enforces Origin.

    ``enforce_origin`` skips safe methods on purpose: a non-browser client sends no Origin
    header at all, and this API has to serve it. The cross-site *read* is closed by the
    browser refusing a response it has no CORS grant for, and by the proxy refusing a
    foreign origin upstream. The method this API can refuse alone is the write, and that is
    the one whose every call costs a third party.
    """

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.post(
            "/api/answers",
            json={"question": "مهلت ثبت درخواست چقدر است؟"},
            cookies={"ekc_session": token},
            headers={"Origin": FOREIGN_ORIGIN},
        )

        assert response.status_code == 403
        assert "question" not in response.text

    _scenario(body)


def test_a_cross_site_read_is_served_and_carries_no_cors_grant() -> None:
    """Pinned so the tolerance reads as a decision rather than an oversight.

    A foreign Origin on a GET is accepted, which is only safe because the response grants
    no CORS access - so a browser will not hand the body to the requesting script - and
    because the proxy refuses it upstream. If a CORS middleware is ever added, this is the
    test that should fail.
    """

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get(
            "/api/documents",
            cookies={"ekc_session": token},
            headers={"Origin": FOREIGN_ORIGIN},
        )

        assert response.status_code == 200
        assert "access-control-allow-origin" not in response.headers

    _scenario(body)


def test_the_list_is_read_only() -> None:
    """No write verb on this collection: nothing here can change a document."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "manager")

        response = await client.post("/api/documents", json={}, cookies={"ekc_session": token})

        assert response.status_code == 405

    _scenario(body)


def test_a_cross_origin_write_is_refused_before_the_body_is_read() -> None:
    """Origin is checked before the body, so a hostile payload never gets parsed."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.post(
            "/api/answers",
            json={"question": "سؤال"},
            cookies={"ekc_session": token},
            headers={"Origin": FOREIGN_ORIGIN},
        )

        assert response.status_code == 403
        assert "question" not in response.text

    _scenario(body)


# --------------------------------------------------------------------------
# GET /api/sources/...
# --------------------------------------------------------------------------


def test_the_current_revision_returns_the_section_verbatim() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")
        revision = await _revision_of(factory, EMPLOYEE_DOCUMENT)
        section_id = await _section_id_of(factory, EMPLOYEE_DOCUMENT)

        response = await client.get(
            _source_url(EMPLOYEE_DOCUMENT, section_id, revision),
            cookies={"ekc_session": token},
        )

        assert response.status_code == 200, response.text
        body_ = response.json()
        assert set(body_) == {
            "document_id",
            "section_id",
            "revision",
            "title",
            "heading_path",
            "text",
        }
        # The ingested text, not the normalized derivation: this is what a reader
        # compares a claim's quote against.
        assert body_["text"] in EMPLOYEE_TEXT
        assert body_["revision"] == revision
        assert body_["section_id"] == section_id

    _scenario(body)


def test_a_manager_reads_a_manager_section() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "manager")
        revision = await _revision_of(factory, MANAGER_DOCUMENT)
        section_id = await _section_id_of(factory, MANAGER_DOCUMENT)

        response = await client.get(
            _source_url(MANAGER_DOCUMENT, section_id, revision),
            cookies={"ekc_session": token},
        )

        assert response.status_code == 200, response.text
        assert "مدیران" in response.json()["text"]

    _scenario(body)


def test_the_three_refusals_are_byte_identical() -> None:
    """The property this endpoint exists to keep.

    Absent, forbidden and stale each have their own way of being true, and each is asserted
    against the others rather than against a status code: a test asserting only "404" would
    pass while the bodies differed, and a differing body is the leak.
    """

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")
        manager_revision = await _revision_of(factory, MANAGER_DOCUMENT)
        manager_section = await _section_id_of(factory, MANAGER_DOCUMENT)
        employee_section = await _section_id_of(factory, EMPLOYEE_DOCUMENT)
        cookies = {"ekc_session": token}

        absent = await client.get(
            _source_url("NO-SUCH-DOC", "NO-SUCH-SECTION", manager_revision), cookies=cookies
        )
        forbidden = await client.get(
            _source_url(MANAGER_DOCUMENT, manager_section, manager_revision), cookies=cookies
        )
        stale = await client.get(
            _source_url(EMPLOYEE_DOCUMENT, employee_section, STALE_REVISION), cookies=cookies
        )

        assert absent.status_code == forbidden.status_code == stale.status_code == 404
        assert absent.json() == forbidden.json() == stale.json()
        assert absent.content == forbidden.content == stale.content

    _scenario(body)


def test_a_refusal_names_no_document_and_no_reason() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")
        revision = await _revision_of(factory, MANAGER_DOCUMENT)
        section_id = await _section_id_of(factory, MANAGER_DOCUMENT)

        response = await client.get(
            _source_url(MANAGER_DOCUMENT, section_id, revision),
            cookies={"ekc_session": token},
        )

        rendered = response.text.lower()
        assert MANAGER_DOCUMENT.lower() not in rendered
        assert "مدیران" not in rendered
        # Words that would say *why*. "not found" is deliberately absent from this list: it
        # is the detail, and it is the only string true of all three refusals.
        for word in ("forbidden", "unauthorized", "access", "role", "revision", "stale"):
            assert word not in rendered, word

    _scenario(body)


def test_a_source_request_without_a_session_is_refused() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        response = await client.get(_source_url(EMPLOYEE_DOCUMENT, "S0", STALE_REVISION))

        assert response.status_code == 401

    _scenario(body)


def test_a_malformed_revision_is_refused_before_the_database() -> None:
    """Measured: every revision in this corpus is a UUID, so the shape is a real allowlist."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.get(
            _source_url(EMPLOYEE_DOCUMENT, "S0", "not-a-uuid"),
            cookies={"ekc_session": token},
        )

        assert response.status_code == 422

    _scenario(body)


def test_a_missing_revision_parameter_is_refused() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.get(
            f"/api/sources/{EMPLOYEE_DOCUMENT}/sections/S0",
            cookies={"ekc_session": token},
        )

        assert response.status_code == 422

    _scenario(body)


def test_a_malformed_document_id_is_refused() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.get(
            _source_url("not a document id", "S0", STALE_REVISION),
            cookies={"ekc_session": token},
        )

        assert response.status_code in {404, 422}

    _scenario(body)


def test_an_unknown_query_parameter_is_refused() -> None:
    """No open-ended filters: every accepted parameter is one this endpoint serves."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.get(
            f"/api/sources/{EMPLOYEE_DOCUMENT}/sections/S0",
            params={"revision": STALE_REVISION, "debug": "1"},
            cookies={"ekc_session": token},
        )

        assert response.status_code == 422

    _scenario(body)


def test_a_refusal_never_echoes_internals() -> None:
    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        token = await _login_as(client, "employee")

        response = await client.get(
            _source_url("NO-SUCH-DOC", "NO-SUCH-SECTION", STALE_REVISION),
            cookies={"ekc_session": token},
        )

        lowered = response.text.lower()
        assert "Traceback" not in response.text
        for word in ("sqlalchemy", "psycopg", "asyncpg", "select "):
            assert word.lower() not in lowered, word

    _scenario(body)


def test_a_replaced_document_answers_only_at_the_new_revision() -> None:
    """A citation handed out before a replacement must fail, not show text that moved on."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        from app.domain.models import Actor
        from app.ingestion import store as ingestion_store
        from app.ingestion.contracts import UploadInput

        await _publish_documents(factory)
        token = await _login_as(client, "employee")
        old_revision = await _revision_of(factory, EMPLOYEE_DOCUMENT)
        section_id = await _section_id_of(factory, EMPLOYEE_DOCUMENT)
        cookies = {"ekc_session": token}

        before = await client.get(
            _source_url(EMPLOYEE_DOCUMENT, section_id, old_revision), cookies=cookies
        )
        assert before.status_code == 200, before.text

        async with factory() as session:
            await ingestion_store.stage_replace(
                session,
                actor=Actor(user_id=_manager_id(), role="manager", session_id=_session_id()),
                document_id=EMPLOYEE_DOCUMENT,
                text_body=EMPLOYEE_TEXT + "\n## افزوده\n\nمتن تازه.\n",
                metadata=UploadInput(title="سند تازه", access_role="employee"),  # type: ignore[arg-type]
            )
        for _ in range(8):
            if await _worker(factory, FakeProvider()).process_next_job() is None:
                break

        after = await client.get(
            _source_url(EMPLOYEE_DOCUMENT, section_id, old_revision), cookies=cookies
        )
        new_revision = await _revision_of(factory, EMPLOYEE_DOCUMENT)

        assert after.status_code == 404
        assert new_revision != old_revision

    _scenario(body)


def _manager_id() -> Any:
    import uuid

    return uuid.uuid4()


def _session_id() -> Any:
    import uuid

    return uuid.uuid4()


def test_a_wrong_role_cannot_read_a_manager_source_through_the_list() -> None:
    """The list is the only way a user learns a document exists; if it leaks, all leaks."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        assert MANAGER_DOCUMENT not in response.text

    _scenario(body)


def test_the_response_is_not_cacheable() -> None:
    """An authorized answer must not be served from a shared cache to the next reader."""

    async def body(engine: Any, factory: Any, client: AsyncClient) -> None:
        await _publish_documents(factory)
        token = await _login_as(client, "employee")

        response = await client.get("/api/documents", cookies={"ekc_session": token})

        assert "no-store" in response.headers.get("cache-control", "")

    _scenario(body)
