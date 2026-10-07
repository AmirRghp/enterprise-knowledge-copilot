"""Tests for the generation report command.

This is the Part 13 review surface against real deployment data: it runs the adapter
over documents that retrieval actually authorized for an actor. Three things matter
more than the shape of the report.

* **The allowlist is what supplies the evidence.** The report must reach the generator
  only through ``retrieve``, so an employee run can never put a manager-only document in
  front of a third party. A fake evidence source would prove nothing about that.
* **Nothing readable comes back out.** No question, no chunk text, no claim text, no
  quote. The model's prose is a rendering of the document and the claim's own text is
  exactly the sentence Part 14 still has to verify, so printing either would present
  unvalidated output as an answer.
* **A claim is an assertion, not an answer.** The report says so, and it never prints a
  claim's content to be interpreted.

Every database interaction goes through ``_scenario``, which owns the event loop and
wipes the database per test, so a failing assertion cannot leak a connection.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest import mock

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.cli import generation_report, run_worker
from app.providers.generation import DAILY_QUOTA_REFUSAL
from app.settings import Settings, load_settings
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
    _scenario,
)

QUESTION = "مهلت ثبت درخواست بازپرداخت سفر چند روز است؟"

#: Text the model writes, which is a rendering of the document and must never be printed.
_CLAIM_TEXT = "مهلت ثبت درخواست پانزده روز است."


class _AsyncioWithASleeper:
    """The real ``asyncio`` with ``sleep`` replaced and nothing else touched.

    The adapter's own attempt loop sleeps with ``asyncio.sleep`` rather than the retry
    helper's sleeper, so the seam is the module-level ``asyncio`` name inside the adapter.
    A proxy rather than a patch on the module object: patching ``asyncio.sleep`` in place
    would change it for the whole process, including this helper's own wait.
    """

    def __init__(self, real: Any, sleep: Any) -> None:
        self._real = real
        self.sleep = sleep

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


@asynccontextmanager
async def _session(factory: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """Open a session for one call and close it, including when the call raises."""
    async with factory() as session:
        yield session


def _settings(key: str = "k" * 32) -> Settings:
    """Settings pointing at the test database, with a key or without one.

    ``Settings`` is frozen, so the key is varied by rebuilding rather than by assigning.
    Built from the loaded values so a field this module does not know about keeps its
    real default instead of becoming a missing-argument error later.
    """
    return load_settings().__class__(
        **{
            **load_settings().model_dump(),
            "db_name": "enterprise_knowledge_copilot_test",
            "openrouter_api_key": key,
        }
    )


def _arguments(login: str = "employee", **overrides: Any) -> Any:
    values: dict[str, Any] = {"login": login, "question": QUESTION, "json": False}
    values.update(overrides)
    return type("Args", (), values)()


def _claims(handles: list[str] | None = None) -> str:
    chosen = handles if handles is not None else ["E1"]
    return json.dumps(
        {
            "claims": [
                {"evidence_id": handle, "quote": "پانزده روز", "text": _CLAIM_TEXT}
                for handle in chosen
            ],
            "abstained": False,
            "missing_parts": [],
            "answer": _CLAIM_TEXT,
        },
        ensure_ascii=False,
    )


#: Captured at import, because inside the replacement the name ``httpx.AsyncClient``
#: already resolves to the replacement itself and the call would recurse.
_REAL_CLIENT = httpx.AsyncClient


def _transport_client(handler: Any) -> Any:
    """An ``AsyncClient`` factory that pins every body to one transport."""

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(handler)
        return _REAL_CLIENT(**kwargs)

    return make_client


def _completion(content: str) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "gen-test",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": {
                    "prompt_tokens": 1569,
                    "completion_tokens": 1157,
                    "total_tokens": 2726,
                    "cost": 0,
                },
            },
        )

    return httpx.MockTransport(handler)


@pytest.fixture(autouse=True)
def canned_generation(monkeypatch: Any) -> Any:
    """Route every OpenRouter call in this module to a canned transport.

    Patched on the shared httpx module so the client the report builds itself is the real
    one; the transport is the only thing stubbed.
    """
    holder: dict[str, Any] = {"transport": _completion(_claims())}
    real_client = httpx.AsyncClient

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = holder["transport"]
        return real_client(**kwargs)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", make_client)
    # Retrieval needs an embedding provider. The real one is Ollama on a local port, and
    # a test that reached it would fail for a reason that has nothing to do with
    # generation, so it is faked the way every other retrieval test fakes it.
    monkeypatch.setattr(
        run_worker,
        "build_provider",
        lambda settings, *, attempt_timeout: FakeProvider(),
    )
    return holder


async def _employee_document(factory: Any) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )


# --------------------------------------------------------------------------
# the evidence comes from the allowlist
# --------------------------------------------------------------------------


def test_the_report_sends_evidence_from_retrieval(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_OK
        printed = capsys.readouterr().out
        assert "retrieved hits:" in printed
        # The evidence count is bounded by the retrieval result, and the two must agree:
        # every retrieved hit within the ceiling became evidence.
        hits = int(
            next(line for line in printed.splitlines() if "retrieved hits:" in line).split(":")[1]
        )
        evidence = int(
            next(line for line in printed.splitlines() if "evidence sent:" in line).split(":")[1]
        )
        assert hits > 0
        assert evidence == min(hits, generation_report._MAX_EVIDENCE)
        assert "claims returned: 1" in printed

    _scenario(body)


def test_an_employee_never_sends_a_manager_only_document(canned_generation: Any) -> None:
    """The allowlist is the only thing standing between the corpus and a third party."""
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    canned_generation["transport"] = httpx.MockTransport(handler)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        code = await generation_report._report(_arguments(), _settings())
        assert code == generation_report.EXIT_OK

    _scenario(body)

    rendered = json.dumps(sent, ensure_ascii=False)
    employee_lines = [line for line in EMPLOYEE_TEXT.splitlines() if line.strip()]
    manager_only = [
        line for line in MANAGER_TEXT.splitlines() if line.strip() and line not in EMPLOYEE_TEXT
    ]
    assert manager_only, (
        "the manager document must differ from the employee one for this to test anything"
    )
    assert any(line in rendered for line in employee_lines)
    for line in manager_only:
        assert line not in rendered, line


def test_no_hits_is_reported_rather_than_prompting_with_nothing(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_NO_HITS
        assert (
            generation_report.EXIT_MESSAGES[generation_report.EXIT_NO_HITS]
            in capsys.readouterr().err
        )

    _scenario(body)


def test_a_missing_key_is_refused_before_retrieval(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        code = await generation_report._report(_arguments(), _settings(key=""))

        assert code == generation_report.EXIT_NO_KEY
        assert "OpenRouter API key" in capsys.readouterr().err

    _scenario(body)


def test_an_unknown_login_is_refused(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        code = await generation_report._report(_arguments(login="nobody"), _settings())

        assert code == generation_report.EXIT_NO_ACCOUNT
        assert "no active account" in capsys.readouterr().err

    _scenario(body)


# --------------------------------------------------------------------------
# nothing readable comes back out
# --------------------------------------------------------------------------


def test_nothing_readable_is_printed(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(), _settings())
        printed = capsys.readouterr().out

        assert QUESTION not in printed
        for line in EMPLOYEE_TEXT.splitlines():
            if len(line.strip()) > 12:
                assert line not in printed, line
        # The claim's own text and the model's prose are both renderings of the
        # document, and the claim has not been validated against it.
        assert _CLAIM_TEXT not in printed
        assert "پانزده روز" not in printed

    _scenario(body)


def test_the_json_report_carries_no_text(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(json=True), _settings())
        printed = capsys.readouterr().out

        assert QUESTION not in printed
        rendered = json.dumps(json.loads(printed), ensure_ascii=False)
        for line in EMPLOYEE_TEXT.splitlines():
            if len(line.strip()) > 12:
                assert line not in rendered, line
        assert _CLAIM_TEXT not in rendered

    _scenario(body)


def test_the_report_says_the_claims_are_unvalidated(capsys: Any) -> None:
    """A report of model assertions must not read as a report of answers."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(), _settings())

        assert "unvalidated" in capsys.readouterr().out

    _scenario(body)


def test_no_chunk_identifier_is_printed(capsys: Any) -> None:
    """``chunk_id`` is never a user-facing reference, and this is not a user-facing report."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(json=True), _settings())
        rendered = capsys.readouterr().out

        for forbidden in ("chunk_id", "document_id", "section_id", "revision"):
            assert forbidden not in rendered, forbidden

    _scenario(body)


# --------------------------------------------------------------------------
# what the report is allowed to show
# --------------------------------------------------------------------------


def test_handles_flags_and_usage_are_reported(capsys: Any) -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(json=True), _settings())
        report = json.loads(capsys.readouterr().out)

        assert report["cited_evidence_ids"] == ["E1"]
        assert report["abstained"] is False
        assert report["missing_parts"] == []
        assert report["answer_present"] is True
        assert report["usage"]["prompt_tokens"] == "1569"
        assert report["usage"]["total_tokens"] == "2726"
        # A reported zero cost is kept; the currency was never reported.
        assert report["usage"]["cost"] == "0"
        assert report["usage"]["currency"] is None

    _scenario(body)


def test_an_abstention_is_shown_as_a_flag(capsys: Any, canned_generation: Any) -> None:
    canned_generation["transport"] = _completion(
        json.dumps(
            {
                "claims": [],
                "abstained": True,
                "missing_parts": ["insufficient_evidence"],
                "answer": "",
            },
            ensure_ascii=False,
        )
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(json=True), _settings())

        assert code == generation_report.EXIT_OK
        report = json.loads(capsys.readouterr().out)
        assert report["abstained"] is True
        assert report["missing_parts"] == ["insufficient_evidence"]
        assert report["answer_present"] is False
        assert report["claims_returned"] == 0

    _scenario(body)


def test_a_schema_violation_exits_with_its_own_code_and_no_prose(
    canned_generation: Any, capsys: Any
) -> None:
    """Distinguished from a provider failure: no retry fixes a dropped schema."""
    canned_generation["transport"] = _completion("متن آزاد به‌جای JSON")

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_SCHEMA
        captured = capsys.readouterr()
        # The first line is the fixed message and nothing else; anything after it is the
        # sanitized usage line, which is the only other thing allowed on stderr.
        lines = [line for line in captured.err.strip().splitlines() if line]
        assert lines[0] == generation_report.EXIT_MESSAGES[generation_report.EXIT_SCHEMA]
        assert all(line.startswith("usage: ") for line in lines[1:]), lines
        assert "متن آزاد" not in captured.err + captured.out
        assert "Traceback" not in captured.err

    _scenario(body)


def test_an_empty_question_is_refused_by_the_command(capsys: Any) -> None:
    assert generation_report.main(["--login", "employee", "--question", "   "]) == (
        generation_report.EXIT_USAGE
    )
    assert generation_report.EXIT_MESSAGES[generation_report.EXIT_USAGE] in capsys.readouterr().err


def test_the_generation_client_is_closed(monkeypatch: Any) -> None:
    """A one-shot command exits first, so a client never closed is never closed."""
    opened: list[httpx.AsyncClient] = []
    real_client = httpx.AsyncClient

    def make_client(**kwargs: Any) -> httpx.AsyncClient:
        client = real_client(**kwargs)
        opened.append(client)
        return client

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", make_client)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await generation_report._report(_arguments(), _settings())

        assert opened, "no client was opened, so nothing was checked"
        assert all(client.is_closed for client in opened), "a client was left open"

    _scenario(body)


def test_the_evidence_bound_is_applied_to_the_retrieved_hits(monkeypatch: Any) -> None:
    """The bound on egress is applied, not merely declared.

    The constant is not the property; applying it is. So it is shrunk for the test and the
    number of passages that actually reach the provider is asserted. An earlier version of
    this test invented chunk ids and could not survive the egress gate, which is the gate
    working: a fabricated chunk is not an authorized one.
    """
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))
    # Two passages of the five retrieved, so the bound is what decides.
    monkeypatch.setattr(generation_report, "_MAX_EVIDENCE", 2)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_OK
        assert len(sent) == 1
        evidence_block = sent[0]["messages"][1]["content"]
        assert evidence_block.count("<evidence id=") == 2
        # And the handles are the first two of the retrieved set, not re-numbered ones.
        assert "<evidence id=E1>" in evidence_block
        assert "<evidence id=E2>" in evidence_block
        assert "<evidence id=E3>" not in evidence_block

    _scenario(body)


def test_the_declared_evidence_ceiling_is_five() -> None:
    """Pinned so raising it is a visible change rather than a quiet one."""
    assert generation_report._MAX_EVIDENCE == 5


# --------------------------------------------------------------------------
# the review finding: the egress gate runs again, before every send
# --------------------------------------------------------------------------


def _sent_bodies() -> tuple[list[Any], Any]:
    """A transport that records each request body it is handed."""

    def handler(request: httpx.Request) -> httpx.Response:
        _sent_bodies.holder.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    _sent_bodies.holder = []  # type: ignore[attr-defined]
    return _sent_bodies.holder, handler  # type: ignore[attr-defined]


async def _narrow(factory: Any, document_id: str) -> None:
    """Narrow a published document to manager-only, as Part 10 does when staging."""
    from sqlalchemy import update

    from app.db.models import Document

    async with _session(factory) as session:
        await session.execute(
            update(Document)
            .where(Document.document_id == document_id)
            .values(access_role="manager")
        )
        await session.commit()


def test_a_narrowing_after_retrieval_stops_the_text_from_reaching_the_provider(
    monkeypatch: Any,
) -> None:
    """Review P1: the window between retrieval returning and the provider request.

    ``retrieve`` authorizes the chunks, but its last check was *before* the generation
    call. A narrowing that lands in that window would otherwise put the text on the wire
    after the caller had lost the right to read it. The retrieval here is wrapped so the
    change lands exactly in that gap.
    """
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.retrieval.service import retrieve as real_retrieve

        async def narrowing_retrieve(*args: Any, **kwargs: Any) -> list[Any]:
            hits = await real_retrieve(*args, **kwargs)
            # The change lands after retrieval's own final gate and before the send.
            await _narrow(factory, EMPLOYEE_DOCUMENT)
            return hits

        with mock.patch.object(generation_report, "retrieve", narrowing_retrieve):
            code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_NO_HITS
        assert sent == [], "text left the process after the access was narrowed"

    _scenario(body)


def test_a_narrowing_during_a_retry_is_not_re_sent(monkeypatch: Any) -> None:
    """The same gate on the retry, which is a later moment than the last check.

    The first attempt is sent while the document is still authorized, so its text does go
    out - it was allowed then. The narrowing happens in the backoff, and the second
    attempt must not carry it.
    """
    sent: list[Any] = []
    narrowed = False

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        if len(sent) == 1:
            return httpx.Response(503, json={"error": {"code": 503, "message": "unavailable"}})
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.providers import generation as generation_module

        async def narrow_in_backoff(seconds: float) -> None:
            nonlocal narrowed
            if not narrowed and sent:
                narrowed = True
                await _narrow(factory, EMPLOYEE_DOCUMENT)

        proxy = _AsyncioWithASleeper(asyncio, narrow_in_backoff)
        with mock.patch.object(generation_module, "asyncio", proxy):
            code = await generation_report._report(_arguments(), _settings())

        # Not EXIT_SCHEMA: nothing was sent on the retry, so no answer could break a
        # schema. The command says there was no authorized evidence, which is what
        # happened.
        assert code == generation_report.EXIT_NO_HITS
        assert narrowed, "the narrowing never happened, so the gate had nothing to catch"
        # One transmission: the first, sent while the document was still authorized.
        assert len(sent) == 1, sent

    _scenario(body)


def test_a_replacement_between_retrieval_and_the_send_withholds_the_old_revision(
    monkeypatch: Any,
) -> None:
    """A new revision is not permission to keep sending the old one.

    Activating a replacement changes what the document says; the text the caller read is
    no longer the text the index holds, so the gate withholds it rather than sending a
    revision the caller never re-read.
    """
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.retrieval.service import retrieve as real_retrieve

        async def replacing_retrieve(*args: Any, **kwargs: Any) -> list[Any]:
            hits = await real_retrieve(*args, **kwargs)
            # A revision change leaves the row authorized but the text stale.
            await _activate_replacement(factory, EMPLOYEE_DOCUMENT)
            return hits

        with mock.patch.object(generation_report, "retrieve", replacing_retrieve):
            code = await generation_report._report(_arguments(), _settings())

        assert code == generation_report.EXIT_NO_HITS
        assert sent == []

    _scenario(body)


async def _activate_replacement(factory: Any, document_id: str) -> None:
    """Move the document onto a fresh revision, as an activated replacement does.

    The chunk rows the caller read stop satisfying ``revision = current_revision``, so the
    gate read returns nothing for them. The document stays active and its access role is
    untouched, which is the point: nothing here is an authorization failure, only the text
    having moved on.
    """
    from sqlalchemy import update

    from app.db.models import Document

    async with _session(factory) as session:
        await session.execute(
            update(Document)
            .where(Document.document_id == document_id)
            .values(current_revision="22222222-2222-2222-2222-222222222222")
        )
        await session.commit()


def test_the_command_does_not_blame_the_schema_when_nothing_was_sent(
    monkeypatch: Any,
) -> None:
    """The failure an operator must not be sent.

    ``EXIT_SCHEMA`` says the provider answered with something unusable. In this case no
    request was made at all, so that message would send somebody to look for a broken
    endpoint when the document simply stopped being readable.
    """
    sent: list[Any] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.retrieval.service import retrieve as real_retrieve

        async def narrowing_retrieve(*args: Any, **kwargs: Any) -> list[Any]:
            hits = await real_retrieve(*args, **kwargs)
            await _narrow(factory, EMPLOYEE_DOCUMENT)
            return hits

        with mock.patch.object(generation_report, "retrieve", narrowing_retrieve):
            code = await generation_report._report(_arguments(), _settings())

        assert code != generation_report.EXIT_SCHEMA
        assert sent == []

    _scenario(body)


def test_a_revocation_mid_retry_is_not_reported_as_a_schema_failure(monkeypatch: Any) -> None:
    """The same for the retry path, where a request has already been made.

    The first request went out while the document was authorized, so it is not the thing
    being reported here; the retry is what found nothing, and the message must fit that.
    """
    sent: list[Any] = []
    narrowed = False

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        if len(sent) == 1:
            return httpx.Response(503, json={"error": {"code": 503, "message": "unavailable"}})
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.providers import generation as generation_module

        async def narrow_in_backoff(seconds: float) -> None:
            nonlocal narrowed
            if not narrowed and sent:
                narrowed = True
                await _narrow(factory, EMPLOYEE_DOCUMENT)

        proxy = _AsyncioWithASleeper(asyncio, narrow_in_backoff)
        with mock.patch.object(generation_module, "asyncio", proxy):
            code = await generation_report._report(_arguments(), _settings())

        assert narrowed
        assert code == generation_report.EXIT_NO_HITS
        assert code != generation_report.EXIT_SCHEMA

    _scenario(body)


def test_a_failed_call_reports_what_it_cost(monkeypatch: Any, capsys: Any) -> None:
    """Review regression: the accounting is only worth keeping if somebody can read it.

    A 503 carrying usage, then an access revocation during the retry. The adapter keeps
    the figure and the command exits non-zero - and before this, the figure went out of
    the world with the process, so an operator had no way to tell a free attempt from an
    expensive one.
    """
    sent: list[Any] = []
    narrowed = False

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        if len(sent) == 1:
            return httpx.Response(
                503,
                json={
                    "error": {"code": 503, "message": "unavailable"},
                    "usage": {
                        "prompt_tokens": 9,
                        "completion_tokens": 1,
                        "total_tokens": 10,
                        "cost": 0.1,
                    },
                },
            )
        return _completion(_claims()).handle_request(request)

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        from app.providers import generation as generation_module

        async def narrow_in_backoff(seconds: float) -> None:
            nonlocal narrowed
            if not narrowed and sent:
                narrowed = True
                await _narrow(factory, EMPLOYEE_DOCUMENT)

        proxy = _AsyncioWithASleeper(asyncio, narrow_in_backoff)
        with mock.patch.object(generation_module, "asyncio", proxy):
            code = await generation_report._report(_arguments(), _settings())

        captured = capsys.readouterr()
        lines = [line for line in captured.err.strip().splitlines() if line]

        assert code == generation_report.EXIT_NO_HITS
        assert narrowed
        # No second request: the gate found nothing to send.
        assert len(sent) == 1, sent
        # The reason, then the cost of the attempt that did happen.
        assert lines[0] == generation_report.EXIT_MESSAGES[generation_report.EXIT_NO_HITS]
        usage_lines = [line for line in lines if line.startswith("usage: ")]
        assert len(usage_lines) == 1, lines
        usage = usage_lines[0]
        assert "attempts=1" in usage
        assert "prompt=9" in usage
        assert "completion=1" in usage
        assert "total=10" in usage
        assert "cost=0.1" in usage
        # And nothing that could carry the question or a passage.
        for forbidden in ("مهلت", "E1", "<evidence", "traceback"):
            assert forbidden.lower() not in (captured.err + captured.out).lower(), forbidden

    _scenario(body)


def test_a_schema_failure_also_reports_its_cost(monkeypatch: Any, capsys: Any) -> None:
    """The other failure exits carry the same line, so none of them is a silent one."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "متن آزاد به‌جای JSON"},
                    }
                ],
                "usage": {
                    "prompt_tokens": 5,
                    "completion_tokens": 0,
                    "total_tokens": 5,
                    "cost": 0.02,
                },
            },
        )

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(), _settings())

        captured = capsys.readouterr()
        assert code == generation_report.EXIT_SCHEMA
        assert "usage: " in captured.err
        assert "total=10" in captured.err or "total=5" in captured.err

    _scenario(body)


def test_a_provider_refusal_reports_its_cost(monkeypatch: Any, capsys: Any) -> None:
    """Including the refusal name and the figures on the same two lines."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={
                "error": {
                    "code": 429,
                    "message": "Rate limit exceeded: free-models-per-day",
                    "metadata": {"limit_source": "openrouter_free_tier_daily"},
                }
            },
        )

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        code = await generation_report._report(_arguments(), _settings())

        captured = capsys.readouterr()
        assert code == generation_report.EXIT_PROVIDER
        assert DAILY_QUOTA_REFUSAL in captured.err
        # The 429 reported no usage of its own, so the figures are unknown rather than
        # zero, and saying so is the point.
        assert "usage: " in captured.err
        assert "prompt=None" in captured.err
        # Still nothing from the provider's own wording.
        assert "free-models-per-day" not in captured.err

    _scenario(body)


def test_a_refusal_before_any_call_reports_no_usage_line(monkeypatch: Any, capsys: Any) -> None:
    """Nothing was sent, so there is nothing to report and no line to print."""

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover - never called
        raise AssertionError("no request may be made")

    monkeypatch.setattr(generation_report.httpx, "AsyncClient", _transport_client(handler))

    async def body(engine: Any, factory: Any) -> None:
        code = await generation_report._report(_arguments(), _settings(key=""))

        captured = capsys.readouterr()
        assert code == generation_report.EXIT_NO_KEY
        assert "usage: " not in captured.err

    _scenario(body)
