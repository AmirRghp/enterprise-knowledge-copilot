"""Tests for the retrieval report CLI.

The report is the Part 11 review surface, so what it must *not* print matters more
than what it prints: an operator pastes it into a ticket, and an employee's report
must not carry a line of a manager-only document. These tests pin that contract on
the built report rather than on the formatted output, so changing the layout cannot
quietly add a field.
"""

import asyncio
import json
import re
from collections.abc import Coroutine
from typing import Any

import pytest
from sqlalchemy import delete

from app.cli import retrieval_report
from app.db import models as db_models
from app.db import url as db_url
from app.db.engine import create_engine, create_session_factory
from app.domain.models import Actor, Role
from app.retrieval.contracts import RetrievalConfig, RetrievalHit
from app.settings import Settings

#: The report is a report about identifiers and ranks. Anything longer than an
#: identifier is treated as leaked prose.
_IDENTIFIER = re.compile(r"^[A-Za-z0-9_.:#@-]*$")

#: Field names that would carry document content. One of these appearing in a
#: report row is a leak, whatever its value.
CONTENT_FIELDS = frozenset(
    {"text", "chunk_text", "search_text", "source_text", "title", "embedding", "question", "quote"}
)


def _settings() -> Settings:
    return Settings(db_name="enterprise_knowledge_copilot_test")


def _run[Result](coroutine: Coroutine[Any, Any, Result]) -> Result:
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def isolated_database() -> None:
    assert _settings().db_name == "enterprise_knowledge_copilot_test"
    assert db_url.PROJECT_DATABASES == {
        "enterprise_knowledge_copilot",
        "enterprise_knowledge_copilot_test",
    }


#: Child rows first, so a foreign key never blocks the teardown.
_WIPE_ORDER = (
    db_models.Chunk,
    db_models.Section,
    db_models.IngestionJob,
    db_models.Document,
    db_models.Session,
    db_models.User,
)


async def _wipe(engine: Any) -> None:
    async with engine.begin() as connection:
        for model in _WIPE_ORDER:
            await connection.execute(delete(model))


def _hit(
    *,
    document_id: str = "DOC-001",
    section_id: str = "DOC-001-S1",
    revision: str = "11111111-1111-1111-1111-111111111111",
    role: Role = "employee",
    text: str = "متن محرمانه‌ای که نباید در گزارش بیاید",
    lexical_rank: int | None = 1,
    vector_rank: int | None = 2,
) -> Any:
    """Build a real ``RetrievalHit`` whose text is unmistakable if it ever leaks."""
    from app.documents.chunking import ChunkRecord

    return RetrievalHit(
        chunk=ChunkRecord(
            chunk_id="22222222-2222-2222-2222-222222222222",
            document_id=document_id,
            revision=revision,
            section_id=section_id,
            ordinal=0,
            text=text,
            access_role=role,
        ),
        lexical_rank=lexical_rank,
        vector_rank=vector_rank,
        fused_score=0.016393,
    )


def _reranked(*, score: float) -> Any:
    """A hit the reranker actually scored."""
    return _hit().with_rerank_score(score)


def _report(
    *, role: Role = "employee", hits: list[Any] | None = None, config: RetrievalConfig | None = None
) -> dict[str, Any]:
    return retrieval_report._build_report(
        login=role,
        role=role,
        config=config or RetrievalConfig(),
        hits=hits if hits is not None else [_hit()],
    )


# --------------------------------------------------------------------------
# the report must not carry document text
# --------------------------------------------------------------------------


def test_the_report_carries_no_document_text() -> None:
    report = _report(hits=[_hit(text="متن محرمانه‌ای که نباید در گزارش بیاید")])
    rows: list[dict[str, Any]] = report["hits"]
    assert rows
    for row in rows:
        assert not (CONTENT_FIELDS & set(row)), row
        for key, value in row.items():
            if isinstance(value, str):
                assert _IDENTIFIER.match(value), (key, value)


def test_no_report_value_contains_a_manager_only_chunk_text() -> None:
    """The whole report, serialized, must not contain the chunk text at all."""

    secret = "متن محرمانه‌ای که نباید در گزارش بیاید"
    report = _report(hits=[_hit(document_id="MGR-001", role="manager", text=secret)])

    assert secret not in json.dumps(report, ensure_ascii=False)
    assert "متن" not in json.dumps(report["hits"], ensure_ascii=False)


def test_the_report_states_the_permitted_roles_it_applied() -> None:
    """A report a reviewer cannot audit is a report nobody can trust."""

    employee = _report(role="employee")
    manager = _report(role="manager")

    assert employee["permitted_roles"] == ["employee"]
    assert manager["permitted_roles"] == ["employee", "manager"]
    assert employee["config"] == manager["config"], "the shape must not vary by role"


def test_the_report_records_the_configuration_it_used() -> None:
    report = _report(config=RetrievalConfig(lexical_top_k=7, vector_top_k=9, rrf_k=11))

    assert report["config"] == {
        "lexical_top_k": 7,
        "vector_top_k": 9,
        "rrf_k": 11,
        "rerank_enabled": False,
        "rerank_top_k": 20,
        "final_top_k": 5,
    }


def test_the_report_states_whether_reranking_ran() -> None:
    """A report must say which ranking produced it, or the two are indistinguishable.

    Reading a report with reranking on and one with it off would otherwise be
    impossible unless the reader knew how the command was invoked.
    """
    assert _report()["config"]["rerank_enabled"] is False
    assert _report(config=RetrievalConfig(rerank_enabled=True))["config"]["rerank_enabled"] is True


def test_a_hit_says_whether_the_reranker_scored_it() -> None:
    """``None`` means "no reranker looked at this", which is not the same as zero."""
    assert _report()["hits"][0]["rerank_score"] is None

    scored = _report(hits=[_reranked(score=0.9)])
    assert scored["hits"][0]["rerank_score"] == 0.9


def test_the_report_numbers_hits_from_one() -> None:
    report = _report(
        hits=[
            _hit(document_id="DOC-001", revision="33333333-3333-3333-3333-333333333333"),
            _hit(document_id="DOC-002", revision="44444444-4444-4444-4444-444444444444"),
        ]
    )

    assert [row["rank"] for row in report["hits"]] == [1, 2]
    assert report["returned"] == 2


def test_an_empty_result_is_reported_rather_than_hidden() -> None:
    report = _report(hits=[])

    assert report["returned"] == 0
    assert report["hits"] == []


# --------------------------------------------------------------------------
# the CLI refuses what it cannot answer
# --------------------------------------------------------------------------


def test_an_empty_question_is_refused_before_any_database_work() -> None:
    assert retrieval_report.main(["--question", "   "]) == retrieval_report.EXIT_USAGE


def test_an_unknown_login_is_refused_rather_than_assumed_employee() -> None:
    """A typo must not silently widen or narrow the report to the default role."""

    async def scenario() -> int:
        engine = create_engine(_settings())
        try:
            factory = create_session_factory(engine)
            await _wipe(engine)
            return await retrieval_report._actor_for(factory, "manager")
        finally:
            await engine.dispose()

    assert _run(scenario()) is None


def test_the_role_comes_from_the_users_row_not_from_the_argument() -> None:
    """A ``--login`` of an employee cannot be used to report a manager's view."""

    async def scenario() -> Role | None:
        from datetime import UTC, datetime

        from app.auth import service as auth_service

        engine = create_engine(_settings())
        try:
            factory = create_session_factory(engine)
            await _wipe(engine)
            now = datetime.now(UTC)
            async with factory() as session:
                for login, role in (("employee", "employee"), ("manager", "manager")):
                    session.add(
                        db_models.User(
                            login=login,
                            password_hash=auth_service.hash_password("irrelevant-for-this-test"),
                            role=role,
                            is_active=True,
                            created_at=now,
                            updated_at=now,
                        )
                    )
                await session.commit()
            return await retrieval_report._actor_for(factory, "employee")
        finally:
            await engine.dispose()

    actor = _run(scenario())
    assert actor is not None and actor.role == "employee"


def test_an_inactive_account_has_no_role_to_report() -> None:
    from datetime import UTC, datetime

    from app.auth import service as auth_service

    async def scenario() -> Role | None:
        engine = create_engine(_settings())
        try:
            factory = create_session_factory(engine)
            await _wipe(engine)
            now = datetime.now(UTC)
            async with factory() as session:
                session.add(
                    db_models.User(
                        login="retired",
                        password_hash=auth_service.hash_password("irrelevant-for-this-test"),
                        role="manager",
                        is_active=False,
                        created_at=now,
                        updated_at=now,
                    )
                )
                await session.commit()
            return await retrieval_report._actor_for(factory, "retired")
        finally:
            await engine.dispose()

    assert _run(scenario()) is None


# --------------------------------------------------------------------------
# a provider failure must not print the question it was handed
# --------------------------------------------------------------------------


def _seeded(login: str, role: Role) -> None:
    """Create one account, then tear the engine down inside its own event loop.

    ``main`` calls ``asyncio.run`` and therefore owns its loop; asyncpg binds a
    connection to the loop that made it. Seeding on a separate engine that is
    disposed on the same loop keeps the two from sharing connections, which would
    fail with "Event loop is closed" for a reason that has nothing to do with the
    behaviour under test.
    """

    async def seed() -> None:
        engine = create_engine(_test_settings())
        try:
            factory = create_session_factory(engine)
            await _wipe(engine)
            await _seed_account(factory, login, role)
            from tests.provider_fixtures import seed_panel

            await seed_panel(engine, _test_settings())
        finally:
            await engine.dispose()

    _run(seed())


async def _seed_account(factory: Any, login: str, role: Role) -> None:
    """Create one active account so ``--login`` resolves to a real role."""
    from datetime import UTC, datetime

    from app.auth import service as auth_service

    now = datetime.now(UTC)
    async with factory() as session:
        session.add(
            db_models.User(
                login=login,
                password_hash=auth_service.hash_password("irrelevant-for-this-test"),
                role=role,
                is_active=True,
                created_at=now,
                updated_at=now,
            )
        )
        await session.commit()


def _echoing_transport(secret: str) -> Any:
    """An HTTP transport whose failure body echoes ``secret`` back.

    This is the exact shape of the risk: Ollama's own error string quotes the input
    it refused, the adapter keeps up to 200 characters of that string, and a CLI
    that prints the adapter's message therefore prints the question.
    """
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"error": f"invalid input: {secret} ({len(request.content)} bytes)"},
        )

    return httpx.MockTransport(handler)


#: A hex digest the settings validator accepts, and that the fake transport reports.
TEST_DIGEST = "a" * 64


def _test_settings() -> Settings:
    """The isolated database, with a digest this test controls.

    The real ``.env`` pins a digest that no fake transport will reproduce, and the
    adapter refuses to start without one that matches. These settings exist so the
    digest a test asserts against is a literal in the test.
    """
    return Settings(
        db_name="enterprise_knowledge_copilot_test",
        ollama_embed_digest=TEST_DIGEST,
    )


def _make_provider(settings: Settings, transport: Any) -> Any:
    import httpx

    from app.providers.embedding import OllamaEmbeddingProvider

    return OllamaEmbeddingProvider(
        httpx.AsyncClient(timeout=5.0, transport=transport),
        base_url=str(settings.ollama_base_url),
        model=settings.ollama_embed_model,
        dimension=settings.embedding_dimension,
        expected_digest=settings.ollama_embed_digest,
    )


def test_a_provider_failure_never_prints_the_question(capsys: Any, monkeypatch: Any) -> None:
    """Review finding: an echoing error body reached stdout as a traceback."""

    secret = "سؤال محرمانهٔ کاربر با عبارت یکتا"
    _seeded("employee", "employee")

    monkeypatch.setattr(retrieval_report, "load_settings", _test_settings)
    monkeypatch.setattr(
        retrieval_report,
        "build_provider",
        lambda settings, *, attempt_timeout: _make_provider(settings, _echoing_transport(secret)),
    )

    code = retrieval_report.main(["--login", "employee", "--question", secret])
    captured = capsys.readouterr()
    assert code == retrieval_report.EXIT_PROVIDER, (code, captured)
    assert code != 0
    assert secret not in captured.out
    assert secret not in captured.err
    # The adapter's own wording is not reprinted either, only the class name.
    assert "invalid input" not in captured.err
    assert retrieval_report.EXIT_MESSAGES[retrieval_report.EXIT_PROVIDER] in captured.err


def test_a_provider_failure_does_not_produce_a_traceback(capsys: Any, monkeypatch: Any) -> None:
    """The process must exit on the failure, not print a stack and keep going."""

    secret = "پرسش دیگر با عبارت یکتا"

    def exploding(settings: Settings, *, attempt_timeout: float) -> Any:
        from app.providers.base import EmbeddingProviderError

        class Exploding:
            provider_name = "fake"
            model = "fake"
            dimension = 768
            last_digest = None

            async def embed_documents(self, texts: list[str]) -> list[list[float]]:
                raise EmbeddingProviderError(f"refused: {secret}")

            async def embed_query(self, text: str) -> list[float]:
                raise EmbeddingProviderError(f"refused: {secret} / echoed: {text}")

        return Exploding()

    _seeded("employee", "employee")

    monkeypatch.setattr(retrieval_report, "load_settings", _test_settings)
    monkeypatch.setattr(retrieval_report, "build_provider", exploding)

    code = retrieval_report.main(["--login", "employee", "--question", secret])
    captured = capsys.readouterr()
    assert code == retrieval_report.EXIT_PROVIDER, (code, captured)
    assert "Traceback" not in captured.err
    assert secret not in captured.err
    assert secret not in captured.out


def _working_provider() -> Any:
    """A ``build_provider`` replacement whose adapter verifies and embeds cleanly."""
    return lambda settings, *, attempt_timeout: _make_provider(settings, _working_transport())


def _working_transport() -> Any:
    """A transport whose provider verifies its digest and returns a valid vector.

    The tag list must name the *configured* model, not a convenient one: the adapter
    compares the full tag, which is exactly the check that stops a report running
    against a model the index was not built with.
    """
    import httpx

    settings = _test_settings()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(
                200,
                json={
                    "models": [{"name": str(settings.ollama_embed_model), "digest": TEST_DIGEST}]
                },
            )
        return httpx.Response(200, json={"embeddings": [[0.5] * 768]})

    return httpx.MockTransport(handler)


def test_a_report_over_an_empty_corpus_succeeds(capsys: Any, monkeypatch: Any) -> None:
    """An empty domain is consistent, so the report runs and simply has no hits.

    This also proves the CLI is wired end to end: the account resolves, the provider
    verifies, the allowlist is read and a report is produced.
    """
    _seeded("employee", "employee")

    monkeypatch.setattr(retrieval_report, "load_settings", _test_settings)
    monkeypatch.setattr(retrieval_report, "build_provider", _working_provider())

    code = retrieval_report.main(["--login", "employee", "--question", "پرسش"])
    captured = capsys.readouterr()
    assert code == retrieval_report.EXIT_OK, (code, captured)
    assert "hits: 0" in captured.out
    assert "searchable documents in the allowlist: 0" in captured.out


def test_an_index_mismatch_exits_with_its_own_code(capsys: Any, monkeypatch: Any) -> None:
    """A stale index is an operator problem: its own code, its own message, no crash.

    The check itself is proved in ``test_retrieval.py`` against real rows; what is
    under test here is the report's handling of the refusal, so the raise is injected
    and only the CLI's reaction is observed. A stale index must be named as such and
    not surface as a traceback an operator has to read.
    """
    from app.retrieval.store import IndexProvenanceMismatchError

    _seeded("employee", "employee")

    async def refusing(*args: Any, **kwargs: Any) -> Any:
        raise IndexProvenanceMismatchError(
            "the retrievable index was not built by the active embedding provider"
        )

    monkeypatch.setattr(retrieval_report, "load_settings", _test_settings)
    monkeypatch.setattr(retrieval_report, "build_provider", _working_provider())
    monkeypatch.setattr(retrieval_report, "retrieve", refusing)

    code = retrieval_report.main(["--login", "employee", "--question", "پرسش"])
    captured = capsys.readouterr()

    assert code == retrieval_report.EXIT_INDEX, (code, captured)
    assert code != 0
    assert retrieval_report.EXIT_MESSAGES[retrieval_report.EXIT_INDEX] in captured.err
    assert "Traceback" not in captured.err
    # The store's own message is not reprinted, only the fixed operator wording.
    assert "not built by the active" not in captured.err


def test_a_domain_that_outgrows_the_lexical_path_exits_with_its_own_code(
    capsys: Any, monkeypatch: Any
) -> None:
    """A capacity failure is also an operator problem, with its own code."""
    from app.retrieval import store as retrieval_store

    _seeded("employee", "employee")

    async def too_large(*args: Any, **kwargs: Any) -> None:
        raise retrieval_store.RetrievalDomainTooLargeError("more than 50000 chunks")

    monkeypatch.setattr(retrieval_report, "load_settings", _test_settings)
    monkeypatch.setattr(retrieval_report, "build_provider", _working_provider())
    monkeypatch.setattr(retrieval_store, "read_eligible_chunks", too_large)

    code = retrieval_report.main(["--login", "employee", "--question", "پرسش"])
    captured = capsys.readouterr()

    assert code == retrieval_report.EXIT_CAPACITY, (code, captured)
    assert retrieval_report.EXIT_MESSAGES[retrieval_report.EXIT_CAPACITY] in captured.err
    assert "50000" not in captured.err
    assert "Traceback" not in captured.err


def test_the_failure_messages_are_written_here_and_never_taken_from_an_exception() -> None:
    """Every message is a literal, so no adapter wording can reach the report."""
    import inspect

    module_source = inspect.getsource(retrieval_report)
    for message in retrieval_report.EXIT_MESSAGES.values():
        assert message in module_source, message

    main_source = inspect.getsource(retrieval_report.main)
    # ``str(error)`` is allowed for a configuration error, which is raised by this
    # project's own settings validator and never quotes a question. It must not be
    # used on anything the provider raised.
    assert main_source.count("print(str(error)") == 1, main_source
    assert "EmbeddingProviderError" in main_source
    assert "type(error).__name__" in main_source


def test_the_cli_catches_only_the_failures_it_names() -> None:
    """No catch-all: an unknown bug must keep its traceback rather than look safe.

    A ``except Exception`` around the report would turn every future bug into
    "the provider is unavailable", which is the one failure mode a report must never
    have: quietly wrong.
    """
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(retrieval_report.main))
    handlers = [
        node.type
        for statement in ast.walk(tree)
        if isinstance(statement, ast.Try)
        for node in statement.handlers
    ]
    assert ast.ExceptHandler  # the AST node type exists in this build
    named = {ast.unparse(handler) for handler in handlers}
    assert "Exception" not in named, named
    assert "BaseException" not in named, named
    assert named, named


def test_the_parser_reports_the_documented_defaults() -> None:
    arguments = retrieval_report._parser().parse_args(["--question", "پرسش"])

    assert arguments.final_top_k == 5
    assert arguments.lexical_top_k == 20
    assert arguments.vector_top_k == 20
    assert arguments.login == "employee"
    assert arguments.json is False


def test_the_text_renderer_prints_identifiers_only(capsys: Any) -> None:
    retrieval_report._print_text(_report(hits=[_hit(text="متن محرمانه")]))

    printed = capsys.readouterr().out
    assert "DOC-001#DOC-001-S1@" in printed
    assert "متن محرمانه" not in printed


def test_the_module_does_not_import_a_web_framework() -> None:
    """CODE_STYLE.md section 4: a CLI stays a CLI, so it can run without a server."""

    source = __import__("pathlib").Path(retrieval_report.__file__).read_text(encoding="utf-8")

    assert "fastapi" not in source
    assert "starlette" not in source


def test_the_retrieval_package_does_not_import_a_web_framework() -> None:
    import pathlib

    from app import retrieval

    root = pathlib.Path(retrieval.__file__).parent
    for module in sorted(root.glob("*.py")):
        source = module.read_text(encoding="utf-8")
        assert "fastapi" not in source, module.name
        assert "starlette" not in source, module.name


def test_retrieval_writes_nothing() -> None:
    """A read path that could write would have to be reasoned about separately."""

    import pathlib

    from app import retrieval

    root = pathlib.Path(retrieval.__file__).parent
    forbidden = ("session.add(", "session.execute(update", "session.delete(", "insert(", "delete(")
    for module in sorted(root.glob("*.py")):
        source = module.read_text(encoding="utf-8")
        for token in forbidden:
            assert token not in source, f"{module.name} contains {token}"


def test_a_hit_from_a_forbidden_document_is_still_only_identifiers() -> None:
    """Even in the pathological case, the shape carries no content."""

    report = _report(role="manager", hits=[_hit(document_id="MGR-001", role="manager")])
    row: dict[str, Any] = report["hits"][0]

    assert row["document_id"] == "MGR-001"
    assert set(row) == {
        "rank",
        "document_id",
        "section_id",
        "revision",
        "chunk_ordinal",
        "access_role",
        "lexical_rank",
        "vector_rank",
        "fused_score",
        "rerank_score",
        "citation",
    }


def test_a_report_needs_no_session_because_it_reads_nothing_session_scoped() -> None:
    """Only the role crosses into the actor, so no session is consulted or minted."""

    import inspect

    source = inspect.getsource(retrieval_report._actor_for)
    assert "Session" not in source, source
    assert "token" not in source.lower(), source

    actor = Actor(user_id="33333333-3333-3333-3333-333333333333", role="employee", session_id="4")
    assert actor.role == "employee"


def test_the_database_user_row_is_the_only_role_source() -> None:
    """No request header, query parameter or body can reach the report."""

    import inspect

    source = inspect.getsource(retrieval_report)
    assert "headers" not in source
    assert "request" not in source.lower() or "request-id" not in source.lower()


def test_a_real_report_never_returns_a_forbidden_document() -> None:
    """The end-to-end property, on real rows rather than on a built report."""

    from tests.test_retrieval import QUESTION, FakeProvider, _publish, _scenario, _search

    async def body(engine: Any, factory: Any) -> None:
        await _publish(
            factory,
            document_id="DOC-001",
            text="# سند کارمند\n\n## الف\n\nدرخواست بازپرداخت سفر.\n",
            access_role="employee",
        )
        await _publish(
            factory,
            document_id="MGR-001",
            text="# سند مدیر\n\n## ب\n\nدرخواست بازپرداخت سفر.\n",
            access_role="manager",
        )
        hits = await _search(factory, question=QUESTION, role="employee", provider=FakeProvider())
        report = _report(role="employee", hits=hits)

        document_ids = {row["document_id"] for row in report["hits"]}
        assert document_ids <= {"DOC-001"}, document_ids

    _scenario(body)
