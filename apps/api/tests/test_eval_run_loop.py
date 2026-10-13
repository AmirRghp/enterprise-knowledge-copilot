"""Execution-level tests for the runner's loop.

These drive ``_run`` and ``_run_sample`` themselves rather than the functions that build a
report. Two properties live in the loop and are invisible from a single call:

* **A failing sample must not end the run.** An embedding server that restarts, a digest that
  changes, a retrieval that raises - these are ordinary outcomes of an evaluation. Handled
  at the sample boundary they become a failed row and the artifact still holds everything
  before them; unhandled they throw past the loop, the ``finally`` closes the clients and the
  results so far are gone.
* **The stop rule is about consecutive failures.** Scattered errors mean the endpoint
  answered in between, so summing the whole history calls a working endpoint "refused".

No provider and no live database: the collaborators are replaced at the seam, so the tests
are about the loop's decisions and not about retrieval or generation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from app.cli import eval_run
from tests.test_retrieval import _actor as account_actor


class _FakeSessionFactory:
    """A session factory for a run whose collaborators are all stubbed.

    The runner opens one per sample and both collaborators are replaced, so most of these
    sessions carry nothing. The exception is the **corpus fingerprint**, which the artifact
    builder reads after the loop to version what the run searched over: that query is
    answered here with an empty domain, so the artifact records a real count of zero rather
    than a digest invented by the test.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        """Accepts whatever ``create_session_factory(engine)`` passes and ignores it."""
        return None

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return _Session()

    def __enter__(self) -> Any:
        return object()

    async def __aenter__(self) -> Any:
        return object()

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class _Session:
    """Answers the fingerprint query, and nothing else."""

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self

    async def execute(self, statement: Any) -> Any:
        return _EmptyRows()

    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *exc: Any) -> bool:
        return False


class _EmptyRows:
    def all(self) -> list[Any]:
        return []

    def __exit__(self, *exc: Any) -> bool:
        return False


class _Roles:
    async def __call__(self, factory: Any, login: str) -> Any:
        from tests.test_retrieval import _actor

        return _actor(login)


@pytest.fixture(autouse=True)
def _no_engine(monkeypatch):
    """Replace the engine, the accounts and both providers at their call sites.

    Patching the names the runner uses rather than the factories they come from: a stub that
    replaces the very factory under test would silence the code being exercised, which is the
    mistake this project's tests have made more than once.
    """
    monkeypatch.setattr(eval_run, "create_engine", lambda settings: _Engine())
    monkeypatch.setattr(eval_run, "create_session_factory", _FakeSessionFactory)
    monkeypatch.setattr(eval_run, "_actor_for", _Roles())
    monkeypatch.setattr(eval_run, "load_settings", lambda: None)


class _Engine:
    async def dispose(self) -> None:
        return None


def _sample(sample_id: str, **overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": sample_id,
        "category": "direct",
        "role": "employee",
        "question": f"سؤال {sample_id}",
        "expected_behavior": "answer",
        "expected_answer": "پاسخ",
        "required_facts": [" fact"],
        "gold_sources": [{"document_id": "HR-001", "section_id": "HR-001-S1"}],
        "forbidden_document_ids": [],
    }
    base.update(overrides)
    return base


class _Settings:
    embedding_provider = "ollama"
    ollama_embed_model = "nomic-embed-text-v2-moe:latest"
    ollama_embed_digest = "ff9c2f10ef5e"
    embedding_dimension = 768
    openrouter_rerank_model = "rerank-model"
    rerank_enabled = False
    generation_max_tokens = 4096
    generation_request_timeout = 30.0
    ingestion_lease_seconds = 120.0

    class _Key:
        def get_secret_value(self) -> str:
            return "key"

    openrouter_api_key = _Key()

    @property
    def _provider_runtime(self):
        from app.settings import Settings
        from tests.provider_fixtures import panel_settings

        configured = panel_settings(
            Settings(
                openrouter_api_key=self.openrouter_api_key.get_secret_value(),
                rerank_enabled=self.rerank_enabled,
            )
        )
        return configured._provider_runtime


def _hit(document_id: str = "HR-001", section_id: str = "HR-001-S1", revision: str = "r"):
    from app.retrieval.contracts import RetrievalHit

    class _Chunk:
        pass

    chunk = _Chunk()
    chunk.document_id = document_id
    chunk.section_id = section_id
    chunk.revision = revision
    return RetrievalHit(
        chunk=chunk, lexical_rank=1, vector_rank=1, fused_score=0.03, rerank_score=None
    )


#: Calls the fake adapter counted, so a test can check the artifact's figure against the
#: adapter's own rather than against a number the test wrote down.
EMBED_CALLS: list[str] = []


class _Adapter:
    """The embedding adapter's real method names, counting its own calls."""

    async def embed_query(self, text: str) -> list[float]:
        EMBED_CALLS.append(text)
        return [0.0]

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        EMBED_CALLS.extend(texts)
        return [[0.0] for _ in texts]


def _stub_embedding(monkeypatch):
    """Replace the embedding provider where the runner imports it from.

    ``build_provider`` is pulled in from ``run_worker`` inside ``_run``, so it is patched on
    that module rather than on ``eval_run``. A patch on a name the runner does not have fails
    loudly, which is better than one that silently does nothing.
    """
    import app.cli.run_worker as worker

    monkeypatch.setattr(worker, "build_provider", lambda settings, **kw: object())


def _write_set(tmp_path, samples, name="questions.jsonl") -> Path:
    """Write the samples as a real set file so the loop runs *these* samples.

    The first version of this file passed ``--limit len(samples)`` and let the loop read the
    project's real 40-sample standard, so a test asserted on ids it had never chosen and on
    a count that changed whenever the standard did. A test that measures the fixed standard
    by accident is a test that fails for reasons nobody can see.
    """
    path = tmp_path / name
    path.write_text(
        "\n".join(json.dumps(sample, ensure_ascii=False) for sample in samples) + "\n",
        encoding="utf-8",
    )
    return path


def _run_with(
    monkeypatch,
    tmp_path,
    samples,
    *,
    retrieve_side_effect=None,
    answer_side_effect=None,
    answer=None,
    real_embedding=False,
    retrieve_calls_embedding=False,
    generator=None,
    sessions=None,
):
    """Run the loop over ``samples`` with scripted retrieval and answer outcomes.

    ``retrieve_side_effect`` and ``answer_side_effect`` are lists consumed one entry per call;
    an entry may be an exception to raise, ``None`` for success. ``answer`` replaces the
    whole answer collaborator, for the tests that need to control what was cited.
    """
    calls = {
        "retrieve": list(retrieve_side_effect or []),
        "answer": list(answer_side_effect or []),
    }

    async def fake_retrieve(session, *, actor, question, config, provider, rerank_provider=None):
        effect = calls["retrieve"].pop(0) if calls["retrieve"] else None
        if isinstance(effect, BaseException):
            raise effect
        if retrieve_calls_embedding:
            # The stub skips the adapter entirely otherwise, which leaves the call counter
            # at zero - and then the test is asserting that an unwired counter reads zero.
            await provider.embed_query(question)
        return [_hit()]

    async def fake_answer(
        factory, *, actor, question, config, vector_provider, generator=None, **kw
    ):
        effect = calls["answer"].pop(0) if calls["answer"] else None
        if isinstance(effect, BaseException):
            raise effect
        from app.answer.schemas import AnswerResult

        return AnswerResult(
            answer="متن", claims=[], sources=[], abstained=False, missing_parts=[], usage=None
        )

    monkeypatch.setattr(eval_run, "retrieve", fake_retrieve)
    monkeypatch.setattr(eval_run, "answer", answer or fake_answer)
    monkeypatch.setattr(
        eval_run,
        "build_generation_provider",
        lambda settings, **kw: generator if generator is not None else _Generator(),
    )
    if not real_embedding:
        _stub_embedding(monkeypatch)
    else:
        import app.cli.run_worker as worker

        monkeypatch.setattr(worker, "build_provider", lambda settings, **kw: _Adapter())
    monkeypatch.setattr(eval_run, "httpx", _FakeHttpx())
    if sessions is not None:
        # Applied after the autouse fixture, which installed the stub. A session that
        # answers the corpus fingerprint is the only thing a test needs to vary; everything
        # else is stubbed at the collaborator.
        monkeypatch.setattr(eval_run, "create_session_factory", lambda engine: sessions)

    arguments = eval_run._parser().parse_args(
        [
            "--set",
            str(_write_set(tmp_path, samples)),
            "--out",
            str(tmp_path / "run.json"),
        ]
    )
    import asyncio

    return asyncio.run(eval_run._run(arguments, _Settings()))


class _Generator:
    """A provider with the runner's real surface.

    ``generate`` exists and counts, because the runner now decides whether a sample reached
    the provider by watching that call. A stub without it reads as "nothing was sent", which
    is the safe direction but would let a wrapper that stopped counting pass unnoticed.
    """

    provider_name = "stub"
    model = "stub"
    last_usage = None
    generations = 0

    async def generate(self, **kwargs: Any) -> Any:
        self.generations += 1
        return None


class _FakeHttpx:
    class AsyncClient:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def aclose(self) -> None:
            return None


def _read(tmp_path):
    return json.loads((tmp_path / "run.json").read_text(encoding="utf-8"))


# --- A failing sample does not end the run ------------------------------------------------


def test_a_retrieval_failure_is_recorded_and_the_run_continues(tmp_path, monkeypatch):
    from app.providers.base import EmbeddingProviderError

    samples = [_sample("D1"), _sample("D2"), _sample("D3")]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        retrieve_side_effect=[
            EmbeddingProviderError("synthetic-marker"),
            None,
            None,
        ],
    )
    artifact = _read(tmp_path)
    # The marker the review used is not in the artifact: an exception message can quote the
    # question back, and this is a report that ends up in tickets.
    assert "synthetic-marker" not in json.dumps(artifact, ensure_ascii=False)
    assert artifact["executed"] == 3
    assert artifact["failed"] == 1
    assert artifact["complete"] is False
    assert artifact["errors_by_reason"] == {"retrieval_error": 1}
    first = artifact["samples"][0]
    assert first["error"].startswith("retrieval_error:")
    # A retrieval that never ran is not a retrieval that found nothing.
    assert first["retrieval_measured"] is False
    assert artifact["samples"][1]["retrieval_measured"] is True


def test_a_failure_after_a_success_keeps_the_earlier_results(tmp_path, monkeypatch):
    from app.providers.base import EmbeddingProviderError

    samples = [_sample(f"D{n}") for n in range(1, 6)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        retrieve_side_effect=[None, None, EmbeddingProviderError("boom"), None, None],
    )
    artifact = _read(tmp_path)
    assert [row["sample_id"] for row in artifact["samples"]] == [
        "D1",
        "D2",
        "D3",
        "D4",
        "D5",
    ]
    assert artifact["executed"] == 5
    assert artifact["samples"][0]["retrieval_measured"] is True
    assert artifact["samples"][4]["retrieval_measured"] is True


def test_an_index_mismatch_is_its_own_reason(tmp_path, monkeypatch):
    from app.retrieval.store import IndexProvenanceMismatchError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[IndexProvenanceMismatchError("digest"), None],
    )
    artifact = _read(tmp_path)
    assert artifact["samples"][0]["error"] == "index_inconsistent"
    assert artifact["executed"] == 2


def test_a_retrieval_failure_inside_answer_is_caught(tmp_path, monkeypatch):
    # `answer` runs its own retrieval; an error raised there used to escape, because the
    # boundary covered only the provider exceptions.
    from app.providers.base import EmbeddingProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        answer_side_effect=[EmbeddingProviderError("inside"), None],
    )
    artifact = _read(tmp_path)
    assert artifact["executed"] == 2
    assert artifact["samples"][0]["error"].startswith("retrieval_error:")
    assert artifact["samples"][1]["error"] is None


def test_a_rerank_failure_is_recorded_and_does_not_end_the_run(tmp_path, monkeypatch):
    from app.retrieval.rerank import RerankUnavailableError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[RerankUnavailableError("rerank down"), None],
    )
    artifact = _read(tmp_path)
    assert artifact["errors_by_reason"] == {"retrieval_error": 1}
    assert artifact["executed"] == 2


def test_a_too_large_domain_is_recorded_rather_than_raising(tmp_path, monkeypatch):
    from app.retrieval.store import RetrievalDomainTooLargeError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[RetrievalDomainTooLargeError("capacity"), None],
    )
    artifact = _read(tmp_path)
    assert "RetrievalDomainTooLargeError" in artifact["samples"][0]["error"]
    assert artifact["executed"] == 2


# --- The stop rule is about consecutive failures -------------------------------------------


def _provider_error():
    from app.providers.generation import GenerationProviderError

    return GenerationProviderError("stub")


def test_three_scattered_errors_do_not_stop_the_run(tmp_path, monkeypatch):
    # error, success, error, success, error, success, success - the endpoint answered in
    # between, so this is a flaky endpoint rather than a refused one.
    samples = [_sample(f"D{n}") for n in range(1, 8)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        answer_side_effect=[
            _provider_error(),
            None,
            _provider_error(),
            None,
            _provider_error(),
            None,
            None,
        ],
    )
    artifact = _read(tmp_path)
    assert artifact["executed"] == 7
    assert artifact["stopped_early_reason"] is None
    assert artifact["failed"] == 3


def test_three_consecutive_errors_stop_the_run(tmp_path, monkeypatch):
    samples = [_sample(f"D{n}") for n in range(1, 8)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        answer_side_effect=[
            None,
            _provider_error(),
            _provider_error(),
            _provider_error(),
        ],
    )
    artifact = _read(tmp_path)
    assert artifact["executed"] == 4
    assert "consecutive provider errors" in artifact["stopped_early_reason"]
    assert artifact["complete"] is False


def test_three_consecutive_non_provider_errors_do_not_stop_the_run(tmp_path, monkeypatch):
    # The same three errors, but none of them from the provider. Stopping here and writing
    # "the endpoint refused the run" would send an operator to look at OpenRouter when the
    # cause is a corpus, an index or a validation rule - three services, and none of them
    # the one the message names.
    from app.providers.generation import GenerationResponseError

    samples = [_sample(f"D{n}") for n in range(1, 8)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        answer_side_effect=[GenerationResponseError("stub")] * 3,
    )
    artifact = _read(tmp_path)
    assert artifact["stopped_early_reason"] is None
    assert artifact["executed"] == 7
    assert artifact["failed"] == 3
    assert artifact["errors_by_reason"] == {"unusable_response": 3}


def test_a_success_resets_the_counter(tmp_path, monkeypatch):
    samples = [_sample(f"D{n}") for n in range(1, 8)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        answer_side_effect=[
            _provider_error(),
            _provider_error(),
            None,
            _provider_error(),
            _provider_error(),
            None,
            None,
        ],
    )
    artifact = _read(tmp_path)
    # Two errors, a success, two more, a success, a success: never three in a row, so all
    # seven ran. A sum over the whole history would have stopped this run after the fifth.
    assert artifact["stopped_early_reason"] is None
    assert artifact["executed"] == 7
    assert artifact["failed"] == 4


# --- Provenance ----------------------------------------------------------------------------


def test_the_effective_rerank_setting_reaches_both_retrievals(tmp_path, monkeypatch):
    # The review's second finding: `RetrievalConfig()` ignored the deployment's setting, so
    # an evaluation of an enabled configuration measured the un-reranked path. Both
    # retrievals of a sample are checked, because they are two calls with two chances to
    # disagree about what was configured.
    seen: list[bool] = []

    async def spy_retrieve(session, *, actor, question, config, provider, rerank_provider=None):
        seen.append(config.rerank_enabled)
        seen.append(rerank_provider is not None)
        return [_hit()]

    class _Enabled(_Settings):
        rerank_enabled = True

    async def ok_answer(factory, *, actor, question, config, vector_provider, generator=None, **kw):
        from app.answer.schemas import AnswerResult

        return AnswerResult(
            answer="متن", claims=[], sources=[], abstained=False, missing_parts=[], usage=None
        )

    monkeypatch.setattr(eval_run, "retrieve", spy_retrieve)
    monkeypatch.setattr(eval_run, "answer", ok_answer)
    monkeypatch.setattr(eval_run, "build_generation_provider", lambda settings, **kw: _Generator())
    _stub_embedding(monkeypatch)
    import app.providers.rerank as rerank_module

    monkeypatch.setattr(eval_run, "httpx", _FakeHttpx())
    monkeypatch.setattr(rerank_module, "build_rerank_provider", lambda settings, client: object())

    import asyncio

    arguments = eval_run._parser().parse_args(
        [
            "--set",
            str(_write_set(tmp_path, [_sample("D1")])),
            "--out",
            str(tmp_path / "run.json"),
        ]
    )
    asyncio.run(eval_run._run(arguments, _Enabled()))
    # Two values per retrieval call: the config flag and whether a reranker was actually
    # built. One retrieval ran here because ``answer`` is stubbed, so the pair appears once -
    # and the flag alone would have passed with a missing adapter, which is why the second
    # value is read at all.
    assert seen == [True, True]


def test_a_disabled_rerank_builds_no_provider(tmp_path, monkeypatch):
    calls: list[Any] = []
    import app.providers.rerank as rerank_module

    monkeypatch.setattr(
        rerank_module, "build_rerank_provider", lambda settings, client: calls.append(1)
    )
    # Part 12 requires zero provider work when rerank is off; no adapter is built.
    config = eval_run.effective_retrieval_config(_Settings())
    assert config.rerank_enabled is False
    assert eval_run._build_rerank_provider(_Settings(), config, object()) is None
    assert calls == []


def test_an_enabled_rerank_with_no_key_is_refused_rather_than_skipped(tmp_path, monkeypatch):
    # A wiring error is a wiring error. Building no reranker under a configuration that
    # claims one would evaluate the un-reranked path and file the result as a reranked run,
    # which is the silent-degradation shape this project has been bitten by before.
    class _NoKey(_Settings):
        rerank_enabled = True

        class _Empty:
            def get_secret_value(self) -> str:
                return ""

        openrouter_api_key = _Empty()

    from app.retrieval.rerank import RerankUnavailableError

    config = eval_run.effective_retrieval_config(_NoKey())
    with pytest.raises(RerankUnavailableError):
        eval_run._build_rerank_provider(_NoKey(), config, object())


def test_a_run_with_no_provider_key_stops_before_spending_anything(tmp_path, monkeypatch):
    # The reachable form of the same guarantee: `_run` refuses an empty key before it opens
    # a client or runs a sample, so no artifact is written and nothing is billed. A run that
    # produced an artifact here would be a report of a measurement nobody made.
    class _NoKey(_Settings):
        class _Empty:
            def get_secret_value(self) -> str:
                return ""

        openrouter_api_key = _Empty()

    monkeypatch.setattr(eval_run, "build_generation_provider", lambda settings, **kw: _Generator())
    _stub_embedding(monkeypatch)
    monkeypatch.setattr(eval_run, "httpx", _FakeHttpx())

    import asyncio

    arguments = eval_run._parser().parse_args(
        [
            "--set",
            str(_write_set(tmp_path, [_sample("D1")])),
            "--out",
            str(tmp_path / "run.json"),
        ]
    )
    assert asyncio.run(eval_run._run(arguments, _NoKey())) == eval_run.EXIT_NO_KEY
    assert not (tmp_path / "run.json").exists()


def test_the_configuration_records_the_set_that_actually_ran(tmp_path, monkeypatch):
    samples = [_sample("D1")]
    _run_with(monkeypatch, tmp_path, samples)
    configuration = _read(tmp_path)["configuration"]
    # The exact path this run was given, not a fixed one that happens to match today: an
    # artifact naming `eval/questions.jsonl` after a `--dev` run is a lie a reader cannot
    # detect from the artifact.
    assert configuration["set"]["path"] == str(_write_set(tmp_path, samples))
    assert configuration["generation"]["max_tokens"] == 4096
    assert configuration["code"]["schema_version"] == eval_run.ARTIFACT_SCHEMA_VERSION


def test_the_prompt_hash_is_the_prompt_and_changes_with_it(tmp_path, monkeypatch):
    # `startswith("sha256:")` is satisfied by any constant, including a placeholder, which
    # is exactly the kind of assertion that proves nothing. The hash is compared against the
    # prompt's own digest, and a different prompt is shown to produce a different hash.
    from app.providers.generation import _SYSTEM_PROMPT

    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    recorded = _read(tmp_path)["configuration"]["generation"]["system_prompt_sha256"]
    assert recorded == eval_run._digest_of_text(_SYSTEM_PROMPT)
    assert recorded != eval_run._digest_of_text(_SYSTEM_PROMPT + " ")

    other = tmp_path / "other"
    other.mkdir()
    monkeypatch.setattr(eval_run, "_SYSTEM_PROMPT", "a different prompt")
    _run_with(monkeypatch, other, [_sample("D1")])
    changed = json.loads((other / "run.json").read_text(encoding="utf-8"))["configuration"][
        "generation"
    ]["system_prompt_sha256"]
    assert changed != recorded


def test_the_schema_hash_is_the_response_schema(tmp_path, monkeypatch):
    # The same argument as the prompt: a hash of the schema is only useful if it is the
    # hash of the schema.
    from app.providers.generation import GENERATION_SCHEMA

    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    recorded = _read(tmp_path)["configuration"]["generation"]["schema_sha256"]
    assert recorded == eval_run._digest_of_text(eval_run._json_dumps(GENERATION_SCHEMA))


def test_the_schema_hash_does_not_depend_on_dictionary_ordering():
    # A schema built from a differently ordered mapping hashes the same, so two artifacts
    # are not declared incomparable over a change that changed nothing.
    left = eval_run._json_dumps({"b": 1, "a": {"d": 2, "c": 3}})
    right = eval_run._json_dumps({"a": {"c": 3, "d": 2}, "b": 1})
    assert eval_run._digest_of_text(left) == eval_run._digest_of_text(right)


def test_a_change_in_max_tokens_changes_the_artifact(tmp_path, monkeypatch):
    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    before = _read(tmp_path)["configuration"]["generation"]["max_tokens"]

    class _Different(_Settings):
        generation_max_tokens = 100

    import asyncio

    monkeypatch.setattr(eval_run, "create_session_factory", _FakeSessionFactory)
    monkeypatch.setattr(eval_run, "_actor_for", _Roles())
    arguments = eval_run._parser().parse_args(
        [
            "--set",
            str(_write_set(tmp_path, [_sample("D1")])),
            "--out",
            str(tmp_path / "other.json"),
        ]
    )
    asyncio.run(eval_run._run(arguments, _Different()))
    after = json.loads((tmp_path / "other.json").read_text(encoding="utf-8"))
    assert after["configuration"]["generation"]["max_tokens"] != before


def test_the_revision_of_each_evidence_row_is_recorded(tmp_path, monkeypatch):
    # Without the revision, a document that has since been replaced is the same pair
    # pointing at different text, and a reviewer cannot tell which one the run saw.
    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    artifact = _read(tmp_path)
    row = artifact["samples"][0]["retrieval_ranks"][0]
    assert row["revision"] == "r"
    assert artifact["samples"][0]["cited"] == []


def test_a_cited_source_records_the_revision_it_was_served_from(tmp_path, monkeypatch):
    # The retrieval row and the citation are two separate records, and only the first is
    # covered by a test that cites nothing - so the citation's revision needs its own.
    class _Source:
        document_id = "HR-001"
        section_id = "HR-001-S1"
        revision = "22222222-2222-4222-8222-222222222222"

    async def citing_answer(
        factory, *, actor, question, config, vector_provider, generator=None, **kw
    ):
        from app.answer.schemas import AnswerResult

        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[_Source()],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    _run_with(monkeypatch, tmp_path, [_sample("D1")], answer=citing_answer)
    cited = _read(tmp_path)["samples"][0]["cited"]
    assert cited == [
        {
            "document_id": "HR-001",
            "section_id": "HR-001-S1",
            "revision": "22222222-2222-4222-8222-222222222222",
        }
    ]


def test_a_row_carries_the_forbidden_ids_a_rescore_needs(tmp_path, monkeypatch):
    # The leak check is recomputed by `eval_score` from the stored pairs and these ids, so
    # a row without them cannot be re-scored for leakage at all - and the omission is
    # invisible in the artifact because the key is present as an empty list.
    sample = _sample("A1", forbidden_document_ids=["MGR-002"])
    _run_with(monkeypatch, tmp_path, [sample])
    row = _read(tmp_path)["samples"][0]
    assert row["forbidden_document_ids"] == ["MGR-002"]
    assert row["gold_sources"] == [["HR-001", "HR-001-S1"]]


# --- The adapter's own errors, not only the retrieval layer's wrapper -------------------
#
# `retrieval/rerank.py` raises `RerankUnavailableError`, which is what the boundary caught.
# The adapter underneath raises `RerankProviderError` on an HTTP failure or an unusable
# payload, and that is a plain `RuntimeError` that nothing caught: with rerank on, one
# failed rerank call ended the whole run and took the artifact with it.


def test_the_real_rerank_adapter_error_is_caught_at_the_sample_boundary(tmp_path, monkeypatch):
    from app.providers.rerank import RerankProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[RerankProviderError("synthetic-marker"), None],
    )
    artifact = _read(tmp_path)
    # The adapter's message is not copied either: it can quote the text it was sent.
    assert "synthetic-marker" not in json.dumps(artifact, ensure_ascii=False)
    assert artifact["executed"] == 2
    # The *named* reason, not merely that the exception was caught. With the name removed
    # from the boundary the catch-all still records it, as `unexpected_error:...`, and an
    # assertion on the class name alone passes for both - which is the difference between
    # "we know what failed" and "something failed".
    assert artifact["samples"][0]["error"] == "retrieval_error:RerankProviderError"
    assert artifact["errors_by_reason"] == {"retrieval_error": 1}
    assert artifact["samples"][1]["error"] is None
    assert artifact["complete"] is False


def test_an_unusable_rerank_payload_is_caught_too(tmp_path, monkeypatch):
    # A subclass of the same parent, named separately because the two failures mean
    # different things to an operator: one is a call that failed, the other is an answer
    # that arrived and could not be validated.
    from app.providers.rerank import RerankResponseError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[RerankResponseError("synthetic-marker"), None],
    )
    artifact = _read(tmp_path)
    assert artifact["executed"] == 2
    assert artifact["samples"][0]["error"] == "retrieval_error:RerankResponseError"


def test_a_rerank_failure_preserves_the_earlier_samples(tmp_path, monkeypatch):
    from app.providers.rerank import RerankProviderError

    samples = [_sample(f"D{n}") for n in range(1, 6)]
    _run_with(
        monkeypatch,
        tmp_path,
        samples,
        retrieve_side_effect=[None, None, RerankProviderError("boom"), None, None],
    )
    artifact = _read(tmp_path)
    assert [row["sample_id"] for row in artifact["samples"]] == [
        "D1",
        "D2",
        "D3",
        "D4",
        "D5",
    ]
    assert artifact["samples"][0]["retrieval_measured"] is True


# --- A generation failure does not delete a retrieval that happened ---------------------


def test_a_generation_failure_keeps_the_retrieval_it_measured(tmp_path, monkeypatch):
    # The review's second finding. Retrieval ran and returned; only the answer failed. The
    # row's recall is real, and marking the row unmeasured because a *later* stage failed
    # silently dropped measured retrieval from the run's recall.
    from app.providers.generation import GenerationProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        answer_side_effect=[GenerationProviderError("stub")],
    )
    row = _read(tmp_path)["samples"][0]
    assert row["error"] == "provider_error"
    assert row["retrieval_measured"] is True
    assert len(row["retrieval_ranks"]) == 1


def test_a_retrieval_leak_is_caught_even_when_generation_fails(tmp_path, monkeypatch):
    # The other half of the same finding: a forbidden document in the retrieved set is a
    # leak whether or not the model went on to cite it. Checking only on the success path
    # meant the run-level leak figure could not see it.
    from app.providers.generation import GenerationProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("A1", forbidden_document_ids=["HR-001"])],
        answer_side_effect=[GenerationProviderError("stub")],
    )
    row = _read(tmp_path)["samples"][0]
    assert row["error"] == "provider_error"
    assert row["leak"]["leaked"] is True
    assert "retrieval_results" in row["leak"]["via"]


def test_a_first_retrieval_failure_still_leaves_the_row_unmeasured(tmp_path, monkeypatch):
    from app.providers.base import EmbeddingProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        retrieve_side_effect=[EmbeddingProviderError("boom")],
    )
    row = _read(tmp_path)["samples"][0]
    assert row["retrieval_measured"] is False


def test_a_second_retrieval_failure_does_not_erase_the_first_measurement(tmp_path, monkeypatch):
    # `answer` runs its own retrieval. When that one fails, the metrics from the first are
    # still measurements; the review asked for this explicitly.
    from app.providers.base import EmbeddingProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        answer_side_effect=[EmbeddingProviderError("boom")],
    )
    row = _read(tmp_path)["samples"][0]
    assert row["error"].startswith("retrieval_error:")
    assert row["retrieval_measured"] is True


# --- A sample that never generated must not claim the previous one's bill ---------------


def test_a_sample_that_failed_before_generating_claims_no_consumption(tmp_path, monkeypatch):
    from app.providers.base import EmbeddingProviderError, ProviderUsage

    stale = ProviderUsage(
        attempts=2,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        cost=0.2,
        currency="USD",
    )

    class _Stale(_Generator):
        last_usage = stale

    monkeypatch.setattr(eval_run, "build_generation_provider", lambda *a, **k: _Stale())
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        retrieve_side_effect=[EmbeddingProviderError("boom")],
    )
    usage = _read(tmp_path)["usage"]
    assert usage["samples_asked"] == 0
    assert usage["provider_was_called"] is False
    assert usage["attempts"] == 0


def test_a_success_then_a_pre_generation_failure_does_not_double_count(tmp_path, monkeypatch):
    # The review's proof, as a test: the first sample is billed, the second fails before
    # generating, and the run's totals must still describe one sample's spending rather
    # than the same spending twice.
    from app.answer.schemas import AnswerResult
    from app.providers.base import EmbeddingProviderError, ProviderUsage

    served = ProviderUsage(
        attempts=1,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        cost=0.2,
        currency="USD",
    )

    class _Counting(_Generator):
        last_usage = served

    async def answering(factory, *, generator=None, **kwargs):
        # The provider is really called on the first sample, so the run can see it; the
        # second sample fails before that, and must not be charged for it.
        generator.generations = getattr(generator, "generations", 0) + 1
        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=served,
        )

    # A side-effect entry is a value to raise, not a callable: passing a function here
    # would return it and never fail, which would make this test pass for the wrong reason.
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[None, EmbeddingProviderError("boom")],
        answer=answering,
    )
    usage = _read(tmp_path)["usage"]
    # One request, counted once.
    assert usage["samples_asked"] == 1
    assert usage["attempts"] == 1
    assert usage["tokens_subtotal"] == 150


# --- The call counters, which are the only evidence the configured path really ran --------


def test_the_embedding_counter_counts_the_method_the_adapter_actually_has(tmp_path, monkeypatch):
    # Wrapping `embed` instead of `embed_query` looks right and counts nothing: the
    # attribute the retrieval layer calls is `embed_query`, and everything else falls
    # through to the inner adapter, so a counter on the wrong name reports zero.
    from app.cli.eval_run import _CountingEmbedder

    class _Adapter:
        def __init__(self) -> None:
            self.embedded = 0

        async def embed_query(self, text: str) -> list[float]:
            self.embedded += 1
            return [0.0]

        async def embed_documents(self, texts: list[str]) -> list[list[float]]:
            self.embedded += 1
            return [[0.0] for _ in texts]

    adapter = _Adapter()
    counter = _CountingEmbedder(adapter)
    import asyncio

    asyncio.run(counter.embed_query("سؤال"))
    asyncio.run(counter.embed_documents(["a", "b"]))
    assert counter.calls == 2
    assert adapter.embedded == 2


def test_the_rerank_counter_counts_the_method_the_adapter_actually_has():
    from app.cli.eval_run import _CountingReranker

    class _Adapter:
        def __init__(self) -> None:
            self.scored = 0

        async def rerank(self, *args: Any, **kwargs: Any) -> Any:
            self.scored += 1
            return []

    adapter = _Adapter()
    counter = _CountingReranker(adapter)
    import asyncio

    asyncio.run(counter.rerank("q", []))
    assert counter.calls == 1
    assert adapter.scored == 1


def test_the_artifact_reports_the_calls_it_made_to_the_other_providers(tmp_path, monkeypatch):
    # A configuration that says `rerank_enabled: true` and a report whose rankings came
    # from the un-reranked path look identical unless something counts. This is that
    # something, and it has to survive into the artifact.
    #
    # The embedder is real here, not the stub `retrieve`: a stubbed retrieval never calls
    # the adapter, so the count is zero and the test would be asserting that a counter
    # nobody wired reports nothing.
    import app.cli.run_worker as worker

    monkeypatch.setattr(worker, "build_provider", lambda settings, **kw: _Adapter())
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        real_embedding=True,
        retrieve_calls_embedding=True,
    )
    other = _read(tmp_path)["usage"]["other_providers"]
    assert len(EMBED_CALLS) == other["embedding"]["calls"]
    assert other["embedding"]["calls"] > 0
    assert other["embedding"]["billed"] is False
    # Nothing configured a reranker, so nothing called one: an invented call count here
    # would be the opposite error.
    assert other["rerank"]["called"] is False


# --- The boundary that catches what nobody enumerated ------------------------------------
#
# Every operational failure with a known cause is named at the sample boundary, because a
# named cause tells an operator which service to look at. The clause beneath them exists
# for the ones nobody listed: a KeyError from a column, a TypeError from an adapter, an
# exception a third-party library raised on its own.


def test_an_unexpected_exception_is_recorded_and_the_run_continues(tmp_path, monkeypatch):
    # A side-effect entry is a value to *raise*, not a callable: passing a function would
    # return it and never fail, and the test would pass with a run that had no failures.
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[KeyError("a column nobody looked up")] * 2,
    )
    artifact = _read(tmp_path)
    assert artifact["executed"] == 2
    assert artifact["errors_by_reason"] == {"unexpected_error": 2}
    assert artifact["samples"][0]["error"] == "unexpected_error:KeyError"
    assert artifact["complete"] is False


def test_an_unexpected_exceptions_message_never_reaches_the_artifact(tmp_path, monkeypatch):
    # An exception message is untrusted text about a run whose content is the operator's
    # evaluation material: a driver can quote the question, and an adapter can quote the
    # passage it was handed. Only the type is recorded.
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        retrieve_side_effect=[RuntimeError("secret-passage-quoted-back-from-the-document")],
    )
    blob = json.dumps(_read(tmp_path), ensure_ascii=False)
    assert "secret-passage" not in blob
    assert "unexpected_error:RuntimeError" in blob


def test_a_cancellation_is_not_swallowed_as_a_sample_failure(tmp_path, monkeypatch):
    # Cancelling the run, interrupting it, or asking the process to exit are not sample
    # failures. Treating them as one would leave the task hung and an evaluation
    # un-interruptible, which is a worse failure than losing one sample.
    import asyncio

    with pytest.raises(asyncio.CancelledError):
        _run_with(
            monkeypatch, tmp_path, [_sample("D1")], retrieve_side_effect=[asyncio.CancelledError()]
        )


def test_a_keyboard_interrupt_is_not_swallowed(tmp_path, monkeypatch):
    with pytest.raises(KeyboardInterrupt):
        _run_with(
            monkeypatch, tmp_path, [_sample("D1")], retrieve_side_effect=[KeyboardInterrupt()]
        )


def test_a_system_exit_is_not_swallowed(tmp_path, monkeypatch):
    with pytest.raises(SystemExit):
        _run_with(monkeypatch, tmp_path, [_sample("D1")], retrieve_side_effect=[SystemExit(2)])


def test_a_named_failure_still_gets_its_own_reason(tmp_path, monkeypatch):
    # The catch-all must not swallow the specific causes into `unexpected_error`: an
    # operator reads that reason to know which service to look at, and "unexpected" tells
    # them nothing except that this project guessed.
    from app.providers.base import EmbeddingProviderError

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1"), _sample("D2")],
        retrieve_side_effect=[EmbeddingProviderError("dead"), TypeError("odd")],
    )
    artifact = _read(tmp_path)
    assert artifact["samples"][0]["error"].startswith("retrieval_error:")
    assert artifact["samples"][1]["error"] == "unexpected_error:TypeError"
    assert artifact["errors_by_reason"] == {"retrieval_error": 1, "unexpected_error": 1}


# --- "Did this sample ask the provider?" is answered by the call, not by the position ---
#
# The runner cannot infer it from where it sits in the control flow. `answer` runs its own
# retrieval and re-checks authorization, so it can abstain or fail *before* generating - and
# a flag set at the start of `answer` reads True for both. Only the provider call settles it.


def test_an_abstention_without_generation_claims_no_consumption(tmp_path, monkeypatch):
    # The review's proof, as a test. A generator carrying the previous sample's reading, a
    # retrieval that found nothing, and an `answer` that abstained: nothing was sent, and
    # the run must not report the previous sample's 150 tokens as this one's.
    from app.answer.schemas import AnswerResult
    from app.providers.base import ProviderUsage

    stale = ProviderUsage(
        attempts=2,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        cost=0.2,
        currency="USD",
    )

    class _Stale(_Generator):
        last_usage = stale

    async def no_hits(session, **kwargs):
        return []

    async def abstaining(factory, **kwargs):
        return AnswerResult(
            answer=None,
            claims=[],
            sources=[],
            abstained=True,
            missing_parts=[],
            usage=None,
        )

    monkeypatch.setattr(eval_run, "build_generation_provider", lambda *a, **k: _Stale())
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        retrieve_side_effect=[no_hits],
        answer=abstaining,
    )
    artifact = _read(tmp_path)
    assert artifact["usage"]["samples_asked"] == 0
    assert artifact["usage"]["provider_was_called"] is False
    assert artifact["usage"]["attempts"] == 0
    assert artifact["usage"]["tokens_subtotal"] == 0


def test_a_second_retrieval_failure_claims_no_consumption(tmp_path, monkeypatch):
    # Same path, different cause: `answer` fails in its own retrieval and never reaches the
    # provider. The measurement from the first retrieval still stands; only the billing
    # claim is withdrawn.
    from app.providers.base import EmbeddingProviderError, ProviderUsage

    stale = ProviderUsage(
        attempts=2,
        provider="stub",
        model="stub",
        billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        cost=0.2,
        currency="USD",
    )

    class _Stale(_Generator):
        last_usage = stale

    monkeypatch.setattr(eval_run, "build_generation_provider", lambda *a, **k: _Stale())
    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        answer_side_effect=[EmbeddingProviderError("boom")],
    )
    artifact = _read(tmp_path)
    assert artifact["samples"][0]["retrieval_measured"] is True
    assert artifact["usage"]["samples_asked"] == 0
    assert artifact["usage"]["provider_was_called"] is False


def test_a_generated_sample_still_claims_its_consumption(tmp_path, monkeypatch):
    # The other side of the same gate, so it cannot be satisfied by never reporting
    # anything: a sample that really called the provider is still billed.
    from app.answer.schemas import AnswerResult

    class _Billing(_Generator):
        async def generate(self, **kwargs: Any) -> Any:
            from app.providers.base import ProviderUsage

            self.generations = getattr(self, "generations", 0) + 1
            self.last_usage = ProviderUsage(
                attempts=1,
                provider="stub",
                model="stub",
                billed_units={
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "total_tokens": 150,
                },
                cost=0.2,
                currency="USD",
            )
            raise AssertionError("the sample's own usage is attached by `answer`")

    async def answering(factory, *, generator=None, **kwargs):
        from app.providers.base import ProviderUsage

        generator.generations = getattr(generator, "generations", 0) + 1
        generator.last_usage = ProviderUsage(
            attempts=1,
            provider="stub",
            model="stub",
            billed_units={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
            cost=0.2,
            currency="USD",
        )
        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=generator.last_usage,
        )

    monkeypatch.setattr(eval_run, "build_generation_provider", lambda *a, **k: _Billing())
    _run_with(monkeypatch, tmp_path, [_sample("D1")], answer=answering)
    usage = _read(tmp_path)["usage"]
    assert usage["samples_asked"] == 1
    assert usage["provider_was_called"] is True
    assert usage["tokens_subtotal"] == 150


# --- Provenance is a snapshot of the start, with the change during the run made visible ----


def test_the_artifact_carries_the_snapshot_taken_before_the_first_sample(tmp_path, monkeypatch):
    # Read at the end it would describe the world after the run. A code file changed on disk
    # mid-run is the simplest demonstration: the imported code was already in memory, so a
    # digest of the working tree at the end names files that never ran.
    #
    # The change is applied **between two samples**, not after the run - a change made
    # afterwards cannot distinguish a start snapshot from an end one.
    from pathlib import Path

    real = Path.read_text
    state = {"changed": False}

    def flaky(self, *args: Any, **kwargs: Any) -> str:
        text = real(self, *args, **kwargs)
        if state["changed"] and self.name == "metrics.py":
            return text + "\n# edited while the run was in flight\n"
        return text

    monkeypatch.setattr(Path, "read_text", flaky)

    # First sample runs against the original code.
    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    at_start = _read(tmp_path)["configuration"]["code"]["combined_sha256"]

    # The file changes, then a second run begins and samples against the new one.
    state["changed"] = True
    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    second = _read(tmp_path)

    # The second run's *own* starting snapshot already sees the edited file - which is the
    # honest answer: that run really did execute against it.
    assert second["configuration"]["code"]["combined_sha256"] != at_start
    # And it says so, rather than leaving the change invisible.
    assert second["provenance_during_run"]["status"] == "unchanged"
    assert (
        eval_run.code_provenance()["combined_sha256"]
        == (second["configuration"]["code"]["combined_sha256"])
    )


def test_a_change_between_the_start_and_end_snapshots_is_reported(tmp_path, monkeypatch):
    # The case that actually matters for a long run: the world moves while it is in flight.
    # The starting snapshot is what the artifact reports, and the comparison is what makes
    # the movement visible - a starting snapshot alone would hide it.
    from pathlib import Path

    real = Path.read_text
    state = {"changed": False}

    def flaky(self, *args: Any, **kwargs: Any) -> str:
        text = real(self, *args, **kwargs)
        if state["changed"] and self.name == "metrics.py":
            return text + "\n# edited while the run was in flight\n"
        return text

    monkeypatch.setattr(Path, "read_text", flaky)

    samples = [_sample("D1"), _sample("D2"), _sample("D3")]

    # Flip the file after the first sample has been measured and before the last snapshot.
    original_answer = None

    async def answering(factory, *, generator=None, **kwargs: Any) -> Any:
        from app.answer.schemas import AnswerResult

        if original_answer is None:
            state["changed"] = True
        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    _run_with(monkeypatch, tmp_path, samples, answer=answering)
    artifact = _read(tmp_path)

    # The artifact describes the run's starting point...
    assert (
        artifact["configuration"]["code"]["combined_sha256"]
        != (eval_run.code_provenance()["combined_sha256"])
    )
    # ...and says that the world moved under it.
    assert artifact["provenance_during_run"]["status"] == "changed"
    assert artifact["provenance_during_run"]["code_changed"] is True


def test_a_corpus_that_moves_mid_run_is_reported_as_changed(tmp_path, monkeypatch):
    # A document that never reached the top five leaves no trace in the evidence rows, so
    # the recorded revisions cannot reveal this. The only thing that can is a comparison -
    # and the corpus has to move *inside* one run, because two runs are each compared
    # against their own start.
    from app.cli.eval_run import read_domain_fingerprint

    rows = [
        type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S1"})(),
    ]

    class _Rows:
        def all(self) -> list[Any]:
            return list(rows)

    class _RealSession:
        def __call__(self, *args: Any, **kwargs: Any) -> Any:
            return self

        async def execute(self, statement: Any) -> Any:
            return _Rows()

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    # Call 1 is the starting snapshot, before any sample. Call 2+ are inside or after the
    # run, and the corpus moves on the first of those - so the movement lands between the
    # two snapshots rather than inside the starting one.
    calls = {"n": 0}

    async def fingerprint(session: Any, actor: Any) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] > 1 and len(rows) == 1:
            rows.append(
                type(
                    "R",
                    (),
                    {"document_id": "HR-009", "revision": "r9", "section_id": "S1"},
                )()
            )
        return await read_domain_fingerprint(session, actor)

    monkeypatch.setattr(eval_run, "read_domain_fingerprint", fingerprint)

    async def answering(factory: Any, *, generator=None, **kwargs: Any) -> Any:
        from app.answer.schemas import AnswerResult

        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    _run_with(
        monkeypatch,
        tmp_path,
        [_sample("D1")],
        answer=answering,
        sessions=_RealSession,
    )
    drift = _read(tmp_path)["provenance_during_run"]
    assert drift["status"] == "changed"
    assert drift["corpus_changed"] is True
    # The artifact describes the run's starting point, and says so rather than leaving the
    # difference for a reader to infer from two figures that disagree.
    assert drift["code_changed"] is False


def _ok_block(code_digest: str = "a", role_digest: str = "x", chunks: int = 1) -> dict[str, Any]:
    """A snapshot that measured everything it claims to."""
    return {
        "code": {"combined_sha256": code_digest, "files_not_read": []},
        "corpus": {
            "by_role": {
                "employee": {
                    "status": "ok",
                    "sha256": role_digest,
                    "documents": 1,
                    "sections": 1,
                    "chunks": chunks,
                }
            }
        },
    }


def test_a_drift_reporting_failure_is_unmeasured_not_unchanged():
    from app.cli.eval_run import _provenance_drift

    # An end snapshot that could not be taken is not evidence that nothing moved. Reporting
    # it as "unchanged" would turn a missing measurement into a clean bill of health.
    drift = _provenance_drift({"code": {"combined_sha256": "a"}}, {})
    assert drift["status"] == "unmeasured"
    assert drift["code_changed"] is None
    assert "code" in drift["unknown"]


def test_two_unreadable_snapshots_are_not_reported_as_unchanged():
    # The review's finding, as a test. `_corpus_provenance` records a database failure as
    # ``{"status": "unreadable"}`` - a dictionary, not a missing key - so a comparison that
    # only looks for `None` sees two equal blocks and calls the run stable. Two unmeasured
    # fingerprints are identical, and identical unmeasured fingerprints prove nothing.
    from app.cli.eval_run import _provenance_drift

    block = {
        "code": {"combined_sha256": "same", "files_not_read": []},
        "corpus": {"by_role": {"employee": {"status": "unreadable"}}},
    }
    drift = _provenance_drift(block, block)
    # The code digest was readable and equal on both sides, so *something* was compared
    # and nothing moved - which is `incomplete`, not `unmeasured`. Only when no axis at all
    # could be compared does the status become `unmeasured`.
    assert drift["status"] == "incomplete"
    assert drift["code_changed"] is False
    assert drift["corpus_by_role"]["employee"]["status"] == "unreadable"
    assert "employee" in drift["unknown"]
    assert drift["corpus_changed"] is None

    # With the code digest gone as well, nothing is left to compare.
    no_code = {
        "code": {"combined_sha256": None, "files_not_read": ["a.py"]},
        "corpus": block["corpus"],
    }
    assert _provenance_drift(no_code, no_code)["status"] == "unmeasured"


def test_one_unreadable_side_is_incomplete_not_a_change():
    # Start could not be read, end could. Calling that a *change* invents a movement that was
    # never observed, and calling it unchanged invents a stability. It is unknown.
    from app.cli.eval_run import _provenance_drift

    start = {
        "code": {"combined_sha256": "a", "files_not_read": []},
        "corpus": {"by_role": {"employee": {"status": "unreadable"}}},
    }
    drift = _provenance_drift(start, _ok_block())
    # One side partial, the other complete: the code axis was comparable and agreed, the
    # corpus axis was not comparable at all. `incomplete`, not `changed` - nothing moved
    # that anybody saw.
    assert drift["status"] == "incomplete"
    assert drift["corpus_changed"] is None
    assert drift["code_changed"] is False


def test_an_unreadable_file_makes_the_code_axis_incomplete():
    # A file that could not be hashed means the digest covers less than it appears to, and
    # two digests over different subsets can be equal by coincidence. Reporting that as a
    # clean comparison is reporting a partial measurement as a complete one.
    from app.cli.eval_run import _provenance_drift

    partial = {
        "code": {"combined_sha256": "a", "files_not_read": ["app/eval/metrics.py"]},
        "corpus": _ok_block()["corpus"],
    }
    drift = _provenance_drift(partial, _ok_block())
    # The corpus was readable on both sides and agreed, but the code digest omitted a file
    # on one side, so the code axis is unknown and nothing was proven to have moved.
    assert drift["status"] == "incomplete"
    assert drift["code_changed"] is None
    assert "code" in drift["unknown"]
    assert "different file sets" in drift["note"] or "omits" in drift["note"]
    # Both sides partial over the same files leaves nothing to compare either.
    both = _provenance_drift(partial, partial)
    assert both["status"] in {"incomplete", "unmeasured"}


def test_mixed_roles_report_the_one_that_could_not_be_read():
    # One role readable and one not: the run does have a valid fingerprint for a role, and
    # saying nothing at all would hide the measurement that did happen.
    from app.cli.eval_run import _provenance_drift

    def block(manager_status: str) -> dict[str, Any]:
        return {
            "code": {"combined_sha256": "a", "files_not_read": []},
            "corpus": {
                "by_role": {
                    "employee": {
                        "status": "ok",
                        "sha256": "x",
                        "documents": 1,
                        "sections": 1,
                        "chunks": 1,
                    },
                    "manager": {
                        "status": manager_status,
                        "sha256": "y",
                        "documents": 2,
                        "sections": 2,
                        "chunks": 2,
                    },
                }
            },
        }

    drift = _provenance_drift(block("unreadable"), block("ok"))
    assert drift["status"] == "incomplete"
    assert drift["corpus_by_role"]["manager"]["status"] == "unreadable"
    assert "manager" in drift["unknown"]
    # The employee *was* readable on both sides and agreed, so that part was measured -
    # which is why the status is `incomplete` rather than `unmeasured`.
    assert drift["code_changed"] is False
    assert drift["corpus_by_role"]["employee"]["status"] == "compared"


def test_a_known_code_change_survives_an_unknown_corpus():
    # Reporting "incomplete" alone would bury a code edit the run really did hit. The change
    # is reported on its own axis, and the corpus is left unknown beside it.
    from app.cli.eval_run import _provenance_drift

    start = _ok_block(code_digest="a")
    end = _ok_block(code_digest="b")
    end["corpus"] = {"by_role": {"employee": {"status": "unreadable"}}}
    drift = _provenance_drift(start, end)
    assert drift["status"] == "changed"
    assert drift["code_changed"] is True
    assert drift["corpus_changed"] is None


def test_a_missing_fingerprint_is_a_gap_even_when_the_status_says_ok():
    # A role that claims `status: ok` but carries no digest measured nothing, and the
    # equality of two such entries is not a measurement of anything.
    from app.cli.eval_run import _provenance_drift

    partial = {
        "code": {"combined_sha256": "a", "files_not_read": []},
        "corpus": {"by_role": {"employee": {"status": "ok", "chunks": 1}}},
    }
    drift = _provenance_drift(partial, _ok_block())
    # The code axis compared and agreed; the employee corpus claimed `ok` without a digest,
    # so it measured nothing. Nothing moved where anything could be measured.
    assert drift["status"] == "incomplete"
    assert drift["corpus_by_role"]["employee"]["status"] == "unreadable"
    assert "employee" in drift["unknown"]
    # With the code digest gone too, there is nothing left at all to compare.
    no_code = {
        "code": {"combined_sha256": None, "files_not_read": []},
        "corpus": partial["corpus"],
    }
    assert _provenance_drift(no_code, no_code)["status"] == "unmeasured"


def test_complete_and_equal_snapshots_are_unchanged():
    from app.cli.eval_run import _provenance_drift

    block = _ok_block()
    drift = _provenance_drift(block, dict(block))
    assert drift["status"] == "unchanged"
    assert drift["unknown"] == []
    assert drift["code_changed"] is False
    assert drift["corpus_changed"] is False


def test_a_changed_corpus_is_distinguished_from_a_changed_code():
    from app.cli.eval_run import _provenance_drift

    # Both snapshots complete, so a difference on either axis is a measurement of a real
    # change rather than a difference between one reading and one hole.
    corpus_only = _provenance_drift(_ok_block(chunks=1), _ok_block(chunks=2))
    assert corpus_only["status"] == "changed"
    assert corpus_only["corpus_changed"] is True
    assert corpus_only["code_changed"] is False

    code_only = _provenance_drift(_ok_block(code_digest="a"), _ok_block(code_digest="b"))
    assert code_only["status"] == "changed"
    assert code_only["code_changed"] is True
    assert code_only["corpus_changed"] is False


def test_an_unchanged_world_reports_unchanged():
    from app.cli.eval_run import _provenance_drift

    block = {"code": {"combined_sha256": "a"}, "corpus": {"by_role": {}}}
    assert _provenance_drift(block, dict(block))["status"] == "unchanged"


def _real_artifact(tmp_path, monkeypatch) -> dict[str, Any]:
    """Run the loop once and hand back the artifact it wrote.

    A summary test that asserts against a hand-built header is asserting against a shape the
    runner may no longer write. This project's tests have twice passed that way - once on a
    stale ``quotes`` shape and once on an artifact whose ``execution`` block had moved.
    """
    _run_with(monkeypatch, tmp_path, [_sample("D1")])
    return _read(tmp_path)


def test_the_summary_warns_when_the_world_moved_under_the_run(tmp_path, monkeypatch, capsys):
    from app.cli.eval_run import _print_summary

    artifact = _real_artifact(tmp_path, monkeypatch)
    artifact["provenance_during_run"] = {
        "status": "changed",
        "corpus_changed": True,
        "code_changed": False,
    }
    arguments = eval_run._parser().parse_args([])
    _print_summary(artifact, arguments, "/tmp/run.json")
    printed = capsys.readouterr().out
    assert "WARNING" in printed
    assert "not comparable" in printed


def test_the_summary_says_so_when_the_comparison_could_not_be_made(tmp_path, monkeypatch, capsys):
    from app.cli.eval_run import _print_summary

    artifact = _real_artifact(tmp_path, monkeypatch)
    artifact["provenance_during_run"] = {"status": "unmeasured"}
    arguments = eval_run._parser().parse_args([])
    _print_summary(artifact, arguments, "/tmp/run.json")
    printed = capsys.readouterr().out
    assert "could not be ruled out" in printed


# --- The wrapper itself, since every billing decision depends on it ----------------------


def test_the_generation_wrapper_counts_only_the_calls_it_forwards():
    # Every accounting decision in the runner reads this counter. A wrapper that stopped
    # counting would report "nothing was sent" for every sample, and the run's totals would
    # be quietly empty - no error anywhere, just a figure of zero.
    from app.cli.eval_run import _GenerationObserver

    class _Provider:
        async def generate(self, *args: Any, **kwargs: Any) -> Any:
            return "answer"

    wrapper = _GenerationObserver(_Provider())
    assert wrapper.generations == 0
    import asyncio

    assert asyncio.run(wrapper.generate(question="q", evidence=[])) == "answer"
    assert wrapper.generations == 1
    asyncio.run(wrapper.generate(question="q2", evidence=[]))
    assert wrapper.generations == 2


def test_a_provider_that_raises_still_counts_the_call():
    # The count has to happen *before* the call, or a provider failure - the case where the
    # sample most likely was billed - would leave the counter unmoved and the charge
    # unattributed.
    from app.cli.eval_run import _GenerationObserver
    from app.providers.generation import GenerationProviderError

    class _Provider:
        async def generate(self, **kwargs: Any) -> Any:
            raise GenerationProviderError("refused")

    wrapper = _GenerationObserver(_Provider())
    import asyncio

    with pytest.raises(GenerationProviderError):
        asyncio.run(wrapper.generate(question="q", evidence=[]))
    assert wrapper.generations == 1


def test_the_run_wraps_the_provider_it_builds(tmp_path, monkeypatch):
    # The wiring itself: the object the loop holds must be the wrapper, or the counter every
    # sample reads stays at zero and no billing decision is ever made.
    class _Counting(_Generator):
        async def generate(self, **kwargs: Any) -> Any:
            self.generations += 1
            return None

    built = _Counting()

    async def answering(factory_arg, *, generator=None, **kwargs: Any) -> Any:
        from app.answer.schemas import AnswerResult

        if generator is not None:
            await generator.generate(question="q", evidence=[])
        return AnswerResult(
            answer="متن",
            claims=[],
            sources=[],
            abstained=False,
            missing_parts=[],
            usage=None,
        )

    _run_with(monkeypatch, tmp_path, [_sample("D1")], answer=answering, generator=built)
    # The raw provider saw the call - which only happens because the runner wrapped it and
    # the wrapper forwarded.
    assert built.generations == 1
    artifact = _read(tmp_path)
    assert artifact["usage"]["samples_asked"] == 1
    assert artifact["usage"]["provider_was_called"] is True


# --- One role's gap must not erase what another axis proved -------------------------------
#
# The last review's finding, and the sharpest version of the recurring bug: the whole
# comparison was gated on "were both snapshots complete", so a single unreadable role threw
# away a code edit and a moved corpus that were both plainly visible in the two snapshots.


def test_an_unreadable_role_does_not_hide_a_proven_change():
    # The review's proof, as a test.
    from app.cli.eval_run import _provenance_drift

    start = {
        "code": {"combined_sha256": "old", "files_not_read": []},
        "corpus": {
            "by_role": {
                "employee": {"status": "ok", "sha256": "old", "chunks": 1},
                "manager": {"status": "unreadable"},
            }
        },
    }
    end = {
        "code": {"combined_sha256": "new", "files_not_read": []},
        "corpus": {
            "by_role": {
                "employee": {"status": "ok", "sha256": "new", "chunks": 2},
                "manager": {"status": "unreadable"},
            }
        },
    }
    drift = _provenance_drift(start, end)
    assert drift["status"] == "changed"
    assert drift["code_changed"] is True
    # The employee corpus demonstrably moved and that is reported on its own role's row,
    # even though the aggregate says `null` because the manager was not read.
    assert drift["corpus_by_role"]["employee"]["status"] == "compared"
    assert drift["corpus_by_role"]["employee"]["start"]["chunks"] == 1
    assert drift["corpus_by_role"]["employee"]["end"]["chunks"] == 2
    # And the role nobody could read stays unknown, rather than being reported as unchanged.
    assert drift["corpus_by_role"]["manager"]["status"] == "unreadable"
    assert "manager" in drift["unknown"]


def test_a_change_in_code_alone_survives_an_unreadable_corpus():
    from app.cli.eval_run import _provenance_drift

    start = {
        "code": {"combined_sha256": "old", "files_not_read": []},
        "corpus": {"by_role": {"manager": {"status": "unreadable"}}},
    }
    end = {
        "code": {"combined_sha256": "new", "files_not_read": []},
        "corpus": {"by_role": {"manager": {"status": "unreadable"}}},
    }
    drift = _provenance_drift(start, end)
    assert drift["status"] == "changed"
    assert drift["code_changed"] is True
    assert drift["corpus_changed"] is None
    assert drift["unknown"] == ["manager"]


def test_unmeasured_only_when_nothing_at_all_was_comparable():
    from app.cli.eval_run import _provenance_drift

    # No code digest, no readable role: there is no observation to report.
    blind = {
        "code": {"combined_sha256": None, "files_not_read": ["app/eval/metrics.py"]},
        "corpus": {"by_role": {"employee": {"status": "unreadable"}}},
    }
    drift = _provenance_drift(blind, blind)
    assert drift["status"] == "unmeasured"
    assert drift["code_changed"] is None
    assert drift["corpus_changed"] is None
    assert set(drift["unknown"]) == {"code", "employee"}


def test_two_digests_over_different_file_sets_are_not_compared():
    # Two digests over different subsets can differ because the subsets differ, and be
    # equal by coincidence while a shared file changed. Neither reading licenses "changed"
    # or "unchanged", so the code axis is unknown.
    from app.cli.eval_run import _provenance_drift

    start = {
        "code": {"combined_sha256": "a", "files_not_read": ["app/eval/metrics.py"]},
        "corpus": _ok_block()["corpus"],
    }
    end = {
        "code": {"combined_sha256": "b", "files_not_read": ["app/retrieval/store.py"]},
        "corpus": _ok_block()["corpus"],
    }
    drift = _provenance_drift(start, end)
    assert drift["status"] == "incomplete"
    assert drift["code_changed"] is None
    assert "different file sets" in drift["note"]


def test_the_same_omission_on_both_sides_still_blocks_a_code_comparison():
    # Two runs that both omitted the same file are comparable *with each other*, but this
    # block compares one run's start with its own end, so it says so rather than implying the
    # digest covers what it names.
    from app.cli.eval_run import _provenance_drift

    block = {
        "code": {"combined_sha256": "a", "files_not_read": ["app/eval/metrics.py"]},
        "corpus": _ok_block()["corpus"],
    }
    drift = _provenance_drift(block, dict(block))
    assert drift["code_changed"] is None
    assert "app/eval/metrics.py" in drift["note"]


def test_the_summary_names_the_roles_that_moved_and_the_roles_that_are_unknown(
    tmp_path, monkeypatch, capsys
):
    from app.cli.eval_run import _print_summary

    artifact = _real_artifact(tmp_path, monkeypatch)
    artifact["provenance_during_run"] = {
        "status": "changed",
        "code_changed": True,
        "corpus_changed": None,
        "corpus_by_role": {
            "employee": {
                "status": "compared",
                "start": {"sha256": "old", "chunks": 1},
                "end": {"sha256": "new", "chunks": 2},
            },
            "manager": {"status": "unreadable"},
        },
        "unknown": ["manager"],
        "note": "",
    }
    _print_summary(artifact, eval_run._parser().parse_args([]), "/tmp/run.json")
    printed = capsys.readouterr().out
    # The change is named per axis and per role, not as a single opaque word.
    assert "code" in printed
    assert "corpus(employee)" in printed
    # And the role nobody could read is called unknown rather than left silent.
    assert "manager" in printed
    assert "unknown, not unchanged" in printed


def test_the_summary_says_when_nothing_moved_but_not_everything_compared(
    tmp_path, monkeypatch, capsys
):
    from app.cli.eval_run import _print_summary

    artifact = _real_artifact(tmp_path, monkeypatch)
    artifact["provenance_during_run"] = {
        "status": "incomplete",
        "code_changed": False,
        "corpus_changed": None,
        "corpus_by_role": {"manager": {"status": "unreadable"}},
        "unknown": ["manager"],
        "note": "",
    }
    _print_summary(artifact, eval_run._parser().parse_args([]), "/tmp/run.json")
    printed = capsys.readouterr().out
    # The warning must not read as "the world held still": that is the claim this whole
    # block exists to avoid.
    assert "not every axis could be compared" in printed
    assert "unknown, not unchanged" in printed


# --- Each of the three pieces the code digest rests on, proved separately ----------------


def test_the_corpus_fingerprint_in_the_artifact_is_the_domain_its_own(tmp_path, monkeypatch):
    # A constant fingerprint would make every run look like every other run on this
    # deployment, which is the one thing a corpus version exists to prevent.
    from app.retrieval.store import read_domain_fingerprint

    rows = [
        type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S1"})(),
    ]

    class _Rows:
        def all(self) -> list[Any]:
            return list(rows)

    class _Session:
        def __call__(self, *args: Any, **kwargs: Any) -> Any:
            return self

        async def execute(self, statement: Any) -> Any:
            return _Rows()

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    import hashlib

    async def spy(session: Any, actor: Any) -> dict[str, Any]:
        snapshot = await read_domain_fingerprint(session, actor)
        expected = hashlib.sha256(b"HR-001|r1|S1").hexdigest()
        assert snapshot["fingerprint"] == expected
        return snapshot

    monkeypatch.setattr(eval_run, "read_domain_fingerprint", spy)
    # A session that answers the fingerprint query; the default stub answers it with an
    # empty domain, which would make every digest the digest of nothing.
    monkeypatch.setattr(eval_run, "create_session_factory", lambda engine: _Session)
    artifact = _run_and_read(monkeypatch, [_sample("D1")], tmp_path)
    assert artifact["configuration"]["corpus"]["by_role"]["employee"]["sha256"] == (
        eval_run._digest_of_text(hashlib.sha256(b"HR-001|r1|S1").hexdigest())
    )


def _run_and_read(monkeypatch, samples, tmp_path) -> dict[str, Any]:
    """Run the loop over a temporary set and hand back the artifact it wrote."""
    _run_with(monkeypatch, tmp_path, samples)
    return _read(tmp_path)


def test_every_role_used_by_the_run_is_fingerprinted(tmp_path, monkeypatch):
    # Two roles, two domains. Reporting one under a heading that says `by_role` is a lie
    # about the other, and the review's finding was exactly that shape.

    from app.domain.models import Actor

    domains = {
        "employee": [
            type("R", (), {"document_id": "HR-001", "revision": "r1", "section_id": "S1"})(),
        ],
        "manager": [
            type("R", (), {"document_id": "MGR-002", "revision": "r2", "section_id": "S1"})(),
        ],
    }

    class _Session:
        def __call__(self, *args: Any, **kwargs: Any) -> Any:
            return self

        async def execute(self, statement: Any) -> Any:
            raise AssertionError("the spy supplies its own session")

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *exc: Any) -> bool:
            return False

    async def spy(session: Any, actor: Actor) -> dict[str, Any]:
        class _Rows:
            def all(self) -> list[Any]:
                return domains[actor.role]

        class _S:
            async def execute(self, statement: Any) -> Any:
                return _Rows()

            async def __aenter__(self) -> Any:
                return self

            async def __aexit__(self, *exc: Any) -> bool:
                return False

        from app.retrieval.store import read_domain_fingerprint

        return await read_domain_fingerprint(_S(), actor)

    monkeypatch.setattr(eval_run, "read_domain_fingerprint", spy)
    build, make_record = _artifact_builder()
    artifact = build(
        [make_record()],
        [_sample("D1")],
        roles={"employee": account_actor("employee"), "manager": account_actor("manager")},
        sessions=lambda engine: _Session,
    )
    corpus = artifact["configuration"]["corpus"]["by_role"]
    assert set(corpus) == {"employee", "manager"}
    assert corpus["employee"]["documents"] == 1
    assert corpus["manager"]["documents"] == 1
    assert corpus["employee"]["sha256"] != corpus["manager"]["sha256"]


def _artifact_builder():
    """The artifact builder used by the sibling test module, and its sample factory.

    Imported rather than duplicated: a second copy of `_artifact` would be free to drift
    from the first, and this project's tests have passed against hand-built report shapes
    that the runner no longer writes.
    """
    from test_eval_run import _artifact, _record

    return _artifact, _record


def test_an_unreadable_provenance_file_is_named_and_left_out_of_the_digest(monkeypatch):
    # Silently dropping a file would make two different runs produce the same digest,
    # because the difference was never measured. Naming it says the digest covers less
    # than the file list suggests.
    from pathlib import Path

    real = Path.read_text

    def failing(self: Path, *args: Any, **kwargs: Any) -> str:
        if self.name == "metrics.py":
            raise OSError("gone")
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", failing)
    provenance = eval_run.code_provenance()
    assert provenance["files_not_read"] == ["app/eval/metrics.py"]
    assert "app/eval/metrics.py" not in provenance["files"]
    # And the digest genuinely excludes it, rather than hashing a placeholder for it.
    assert (
        eval_run._digest_of_text(
            "\n".join(f"{k}:{v}" for k, v in sorted(provenance["files"].items()))
        )
        == provenance["combined_sha256"]
    )


def test_a_role_present_on_only_one_side_is_unknown_rather_than_compared():
    # A role that appears at the start and is gone by the end has, in the plainest sense,
    # an unmeasured change: nobody read the end state, so nobody knows what happened to it.
    from app.cli.eval_run import _provenance_drift

    start = _ok_block()
    start["corpus"]["by_role"]["manager"] = {
        "status": "ok",
        "sha256": "m",
        "documents": 1,
        "sections": 1,
        "chunks": 1,
    }
    end = _ok_block()
    drift = _provenance_drift(start, end)
    assert drift["status"] == "incomplete"
    assert drift["corpus_by_role"]["manager"]["status"] == "unreadable"
    assert "manager" in drift["unknown"]
    # The employee was read on both sides and agreed, so that part stands on its own.
    assert drift["corpus_by_role"]["employee"]["status"] == "compared"
