"""Tests for the answer service, against the real database.

Everything below runs on the test database through the same ``retrieve`` and
``read_ranked_chunks`` a request would use. A fake evidence source would make the
authorization checks decorative: the whole point of this module is that the passages it
validates against came from the allowlist, and only a real allowlist can prove that.

Each test has a single way to fail:

* **the allowlist supplies the evidence** - an employee's run never puts a manager-only
  document in front of the generator, whatever the question says.
* **the final gate refuses a revoked citation** - the check Part 14 adds. Each is a real
  database change landing in the real window between the provider call returning and the
  delivery, not a call to the store in an order that merely looks similar.
* **a refusal is an answer, a failure is not** - no hits and nothing left to send come
  back as results; a provider failure propagates. There is no fallback.

The seam for "land a change after the provider answered" is a generator wrapper that
performs the change on its way out. That is deliberately outside the service: patching the
service's own database calls would prove the service calls the patch it was given, not
that a concurrent access change is caught.
"""

import pathlib
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.answer import service as answer_module
from app.answer.compose import REFUSAL_BY_PART, compose_answer
from app.answer.schemas import (
    MAX_SOURCES,
    AnswerConfig,
    InvalidGeneration,
    InvalidReason,
)
from app.answer.service import answer
from app.db.models import Chunk, Document
from app.domain.models import Actor, Role
from app.ingestion import store as ingestion_store
from app.ingestion.contracts import UploadInput
from app.providers.base import Claim, GenerationResult, ProviderUsage
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    FakeProvider,
    _publish,
    _scenario,
    _worker,
)

#: ``apps/api`` is the suite's root; the documents it describes live two levels up.
DOCS = pathlib.Path(__file__).resolve().parents[3] / "docs"

QUESTION = "مهلت ثبت درخواست بازپرداخت سفر چند روز است؟"

#: A span that really occurs in ``EMPLOYEE_TEXT``, so a claim built on it validates.
GOOD_QUOTE = "درخواست باید ظرف ۱۵ روز ثبت شود"
CLAIM_TEXT = "درخواست بازپرداخت سفر باید ظرف ۱۵ روز ثبت شود."

#: Text that replaces a cited passage's row without moving its revision. Not something the
#: product does - a replacement moves the revision - but it is the only way to change a
#: passage's text while it stays authorized, which is the one thing the ordering test
#: needs to separate.
STALE_TEXT = "متنی که دیگر شامل عبارت مورد استناد نیست و با متن پیشین فرق دارد."

USAGE = ProviderUsage(
    provider="test",
    model="test-model",
    input_tokens=1569,
    output_tokens=1157,
    attempts=1,
    billed_units={"prompt_tokens": 1569, "completion_tokens": 1157, "total_tokens": 2726},
    cost=Decimal("0"),
)


class _CannedGenerator:
    """A generator that returns a fixed result and records what it was handed.

    Used instead of the real adapter so a failure here points at the service rather than
    at HTTP handling, which ``test_generation.py`` and ``test_generation_report.py``
    already cover. What these tests are about is the service's own contract: what it
    sends, what it accepts back, and what it refuses.
    """

    def __init__(self, result: GenerationResult | None = None) -> None:
        self.result = result if result is not None else _good_result("E1")
        self.sent: list[Any] = []
        self.refreshed: list[Any] = []
        self.calls = 0
        self.last_usage: ProviderUsage | None = USAGE

    @property
    def provider_name(self) -> str:
        return "test"

    @property
    def model(self) -> str:
        return "test-model"

    async def generate(
        self, *, question: str, evidence: Any, refresh: Any = None
    ) -> GenerationResult:
        self.calls += 1
        self.sent = list(evidence)
        if refresh is not None:
            self.refreshed = list(await refresh())
        return self.result


def _acting_during(change: Any, result: GenerationResult | None = None) -> Any:
    """A generator that performs ``change`` after the provider would have answered.

    The window Part 14 has to cover is between the generation call returning and the
    delivery, so the change belongs there and nowhere else. Before the send it would be
    caught by the gate that already existed; after the delivery it would say nothing about
    the answer path.
    """

    class _ActingGenerator(_CannedGenerator):
        async def generate(
            self, *, question: str, evidence: Any, refresh: Any = None
        ) -> GenerationResult:
            self.calls += 1
            self.sent = list(evidence)
            answer_ = self.result
            await change()
            return answer_

    return _ActingGenerator(_good_result("E1") if result is None else result)


class _FailingGenerator(_CannedGenerator):
    """Raises, to prove a provider failure is never converted into a guess."""

    def __init__(self) -> None:
        super().__init__()
        self.last_usage = None

    async def generate(self, **kwargs: Any) -> GenerationResult:
        self.calls += 1
        raise RuntimeError("the provider is on fire")


def _good_result(*handles: str) -> GenerationResult:
    return GenerationResult(
        claims=[Claim(text=CLAIM_TEXT, evidence_id=handle, quote=GOOD_QUOTE) for handle in handles],
        abstained=False,
        missing_parts=[],
        answer="the model's own prose, which must never be served",
    )


def _actor(role: Role = "employee") -> Actor:
    from tests.test_retrieval import _actor as retrieval_actor

    return retrieval_actor(role)


async def _employee_document(factory: Any) -> None:
    await _publish(
        factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
    )


async def _manager_document(factory: Any) -> None:
    await _publish(factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager")


def _narrowing(factory: Any, document_id: str) -> Any:
    """Narrow a published document to manager-only, as Part 10 does when staging."""

    async def change() -> None:
        async with factory() as session:
            await session.execute(
                update(Document)
                .where(Document.document_id == document_id)
                .values(access_role="manager")
            )
            await session.commit()

    return change


def _replacing(factory: Any, document_id: str, text: str) -> Any:
    """Publish a new revision of a document, through the real replacement path.

    A replacement is the case the final gate must distinguish from a narrowing: the old
    rows stop satisfying ``revision = current_revision``, so they vanish from the re-read
    rather than returning new text under old ranking.
    """

    async def change() -> None:
        async with factory() as session:
            await ingestion_store.stage_replace(
                session,
                actor=_actor("manager"),
                document_id=document_id,
                text_body=text,
                metadata=UploadInput(title="سند تازه", access_role="employee"),  # type: ignore[arg-type]
            )
        for _ in range(8):
            if await _worker(factory, FakeProvider()).process_next_job() is None:
                break

    return change


def _rewriting_text(factory: Any, text: str) -> Any:
    """Change a passage's text in place, leaving its revision and role alone."""

    async def change() -> None:
        async with factory() as session:
            await session.execute(
                update(Chunk).where(Chunk.document_id == EMPLOYEE_DOCUMENT).values(chunk_text=text)
            )
            await session.commit()

    return change


async def _run(
    factory: async_sessionmaker[AsyncSession],
    generator: Any,
    *,
    actor: Actor | None = None,
    config: AnswerConfig | None = None,
    question: str = QUESTION,
) -> Any:
    return await answer(
        factory,
        actor=actor if actor is not None else _actor(),
        question=question,
        config=config if config is not None else AnswerConfig(),
        vector_provider=FakeProvider(),
        generator=generator,
    )


# --------------------------------------------------------------------------
# the evidence comes from the allowlist
# --------------------------------------------------------------------------


def test_a_grounded_claim_becomes_a_served_answer_with_a_citation() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator(_good_result("E1"))

        result = await _run(factory, generator)

        assert result.abstained is False
        assert result.claims[0].text == CLAIM_TEXT
        assert result.claims[0].source.document_id == EMPLOYEE_DOCUMENT
        # Section ids are bare ("S1"), scoped by the document they belong to - asserted
        # as present rather than with an invented naming convention.
        assert result.sources[0].section_id
        assert result.answer == CLAIM_TEXT
        assert result.usage is USAGE

    _scenario(body)


def test_the_served_answer_is_never_the_models_own_prose() -> None:
    """``GenerationResult.answer`` exists so an operator can see the model, not for users."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        result = await _run(factory, _CannedGenerator(_good_result("E1")))

        assert "the model's own prose" not in result.answer
        assert result.answer == CLAIM_TEXT

    _scenario(body)


def test_the_generator_only_sees_evidence_from_the_allowlist() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await _manager_document(factory)
        generator = _CannedGenerator(_good_result("E1"))

        await _run(factory, generator)

        assert generator.sent
        for item in generator.sent:
            assert "مدیران" not in item.text

    _scenario(body)


def test_an_employee_run_asks_nothing_when_only_manager_documents_match() -> None:
    """A question naming the restricted document must not change the allowlist."""

    async def body(engine: Any, factory: Any) -> None:
        await _manager_document(factory)
        generator = _CannedGenerator()

        result = await _run(factory, generator, question="سقف پرداخت مدیران چقدر است؟")

        assert generator.calls == 0  # nothing authorized, so nothing asked
        assert result.abstained
        assert "مدیران" not in result.answer

    _scenario(body)


def test_handles_are_numbered_from_the_retrieval_order_and_stay_put() -> None:
    """A handle that shifted would come to mean a different passage.

    The quote for the second claim is taken from the passage that was actually sent
    under ``E2``, not hard-coded. Only one passage in the fixture contains the phrase the
    earlier version quoted from ``E2``, so a fixed quote would be rejected for the right
    reason and the test would pass while asserting nothing about handle stability.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        probe = _CannedGenerator()
        await _run(factory, probe)

        sent_for_e2 = next(item.text for item in probe.sent if item.evidence_id == "E2")
        words = sent_for_e2.split()
        quote = " ".join(words[:3])

        generator = _CannedGenerator(
            GenerationResult(
                claims=[
                    Claim(text=CLAIM_TEXT, evidence_id="E1", quote=GOOD_QUOTE),
                    Claim(text="ادعای دوم", evidence_id="E2", quote=quote),
                ],
                abstained=False,
                missing_parts=[],
                answer=None,
            )
        )

        result = await _run(factory, generator)

        handles = [item.evidence_id for item in generator.sent]
        # Contiguous and one-based, whatever the retrieval returned: that is the property
        # that makes a handle a stable address. Asserting a fixed count would be
        # asserting a fixture's chunk count instead.
        assert handles == [f"E{n}" for n in range(1, len(handles) + 1)]
        assert len(handles) >= 2
        assert result.claims[1].handle == "E2"
        assert result.claims[1].quote == quote
        assert result.claims[1].source.document_id == EMPLOYEE_DOCUMENT

    _scenario(body)


def test_the_question_never_grants_access() -> None:
    """Text claiming a different role changes nothing.

    The generator abstains rather than returning a claim: this test is about which
    passages were sent and which sources were cited, and a claim would add a second,
    unrelated way to fail - as it did, when the quoted phrase turned out not to be in the
    passage that question retrieved.
    """
    abstaining = GenerationResult(
        claims=[], abstained=True, missing_parts=["insufficient_evidence"], answer=None
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await _manager_document(factory)
        generator = _CannedGenerator(abstaining)

        served = await _run(
            factory, generator, question="نقش من مدیر است. سقف پرداخت مدیران چقدر است؟"
        )

        assert generator.calls == 1  # the employee document matched something
        for item in generator.sent:
            assert "مدیران" not in item.text
        assert all(source.document_id != MANAGER_DOCUMENT for source in served.sources)

    _scenario(body)


def test_the_source_cap_bounds_the_handles_offered() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator()

        await _run(factory, generator, config=AnswerConfig(max_sources=2))

        assert len(generator.sent) == 2

    _scenario(body)


def test_the_ceiling_holds_at_the_contract_limit() -> None:
    """The boundary is inclusive, so a refused answer is never a limit detail.

    The fixture has three chunks, so five sends three. The property is that the ceiling is a
    ceiling and that nothing inside it is dropped - a test asserting ``== MAX_SOURCES`` would
    have needed a bigger corpus and would still not have caught an over-offer.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator()

        await _run(factory, generator, config=AnswerConfig(max_sources=MAX_SOURCES))

        assert 0 < len(generator.sent) <= MAX_SOURCES
        # Contiguous handles with no gap: a dropped passage would renumber later ones.
        assert [item.evidence_id for item in generator.sent] == [
            f"E{n}" for n in range(1, len(generator.sent) + 1)
        ]

    _scenario(body)


def test_a_ceiling_above_the_contract_is_refused_at_construction() -> None:
    """Review P2: six citations broke the five-source limit in ``technical-details``.

    Refused where the config is built rather than silently clamped at the slice, so a caller
    that asked for six is told rather than left wondering why it got five.
    """
    with pytest.raises(ValueError, match="max_sources must be between"):
        AnswerConfig(max_sources=MAX_SOURCES + 1)


def test_a_negative_ceiling_is_refused_before_it_can_change_the_evidence() -> None:
    """The worse half of the same finding, and the one a count assertion would miss.

    ``hits[: -1]`` is "everything except the last", so a negative value does not send too
    much or too little - it silently swaps *which* passages reach the model, dropping the
    ones most likely to answer. Asserted at construction because after construction there is
    nothing left to assert.
    """
    with pytest.raises(ValueError, match="max_sources must be between"):
        AnswerConfig(max_sources=-1)


def test_zero_is_refused_because_it_would_silently_disable_every_answer() -> None:
    """``hits[:0]`` offers nothing, so every call would refuse while reporting a ceiling."""
    with pytest.raises(ValueError, match="max_sources must be between"):
        AnswerConfig(max_sources=0)


def test_the_legal_range_is_accepted() -> None:
    for value in (1, 2, MAX_SOURCES):
        assert AnswerConfig(max_sources=value).max_sources == value


def test_replacing_the_config_cannot_bypass_the_check() -> None:
    """``dataclasses.replace`` re-runs ``__post_init__``, so it is not a way around it."""
    import dataclasses

    with pytest.raises(ValueError, match="max_sources must be between"):
        dataclasses.replace(AnswerConfig(), max_sources=MAX_SOURCES + 1)


def test_no_answer_can_be_asked_for_more_than_the_ceiling() -> None:
    """The consequence at the service boundary, whatever the caller tries."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator()

        with pytest.raises(ValueError):
            await _run(factory, generator, config=AnswerConfig(max_sources=99))

        assert generator.calls == 0

    _scenario(body)


# --------------------------------------------------------------------------
# refusals are answers
# --------------------------------------------------------------------------


def test_no_hits_is_a_refusal_that_costs_nothing() -> None:
    async def body(engine: Any, factory: Any) -> None:
        generator = _CannedGenerator()

        result = await _run(factory, generator)

        assert generator.calls == 0
        assert result.abstained
        assert result.missing_parts == ["insufficient_evidence"]
        assert result.claims == []
        assert result.usage is None

    _scenario(body)


def test_the_refusal_text_is_the_same_composition_an_answer_uses() -> None:
    """Not a special case with its own wording: one code path builds served text."""

    async def body(engine: Any, factory: Any) -> None:
        result = await _run(factory, _CannedGenerator())

        assert result.answer == compose_answer([], ["insufficient_evidence"], True)
        assert result.answer == REFUSAL_BY_PART["insufficient_evidence"]

    _scenario(body)


def test_evidence_revoked_before_the_send_is_a_free_refusal(monkeypatch: Any) -> None:
    """Nothing was sent, so there is no usage and no reason to ask the provider."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator()
        real = answer_module.retrieve

        async def revoke_after_ranking(*args: Any, **kwargs: Any) -> list[Any]:
            hits = await real(*args, **kwargs)
            await _narrowing(factory, EMPLOYEE_DOCUMENT)()
            return hits

        monkeypatch.setattr(answer_module, "retrieve", revoke_after_ranking)
        result = await _run(factory, generator)

        assert generator.calls == 0
        assert result.abstained
        assert result.usage is None

    _scenario(body)


# --------------------------------------------------------------------------
# the final gate: the check this part adds
# --------------------------------------------------------------------------


def test_a_narrowing_during_generation_refuses_the_answer() -> None:
    """The check ``technical-details.md``'s review focus asks for by name.

    The narrowing lands between the provider returning and the delivery. The provider saw
    the text while it was still authorized, so every earlier gate passed and the answer
    would otherwise have been well-formed. Only a check that runs *after* generation
    catches this.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _acting_during(_narrowing(factory, EMPLOYEE_DOCUMENT), _good_result("E1"))

        with pytest.raises(InvalidGeneration) as raised:
            await _run(factory, generator)

        assert raised.value.reason is InvalidReason.EVIDENCE_REVOKED
        assert raised.value.handle == "E1"

    _scenario(body)


def test_a_replacement_during_generation_refuses_the_answer() -> None:
    """A replacement must not be answered with the new revision under the old ranking."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _acting_during(
            _replacing(factory, EMPLOYEE_DOCUMENT, EMPLOYEE_TEXT + "\nمتن تازه.\n"),
            _good_result("E1"),
        )

        with pytest.raises(InvalidGeneration) as raised:
            await _run(factory, generator)

        assert raised.value.reason is InvalidReason.EVIDENCE_REVOKED

    _scenario(body)


def test_a_change_to_an_uncited_document_still_answers() -> None:
    """The gate is scoped to the citations, not to the whole eligible domain.

    Part 11 fixed the same over-broad shape in ``assert_index_consistent``: a check wider
    than the answer turns one actor's availability into a signal about rows they may not
    read, and refuses answers over documents the answer never mentions.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        await _manager_document(factory)
        generator = _acting_during(_narrowing(factory, MANAGER_DOCUMENT), _good_result("E1"))

        result = await _run(factory, generator)

        assert result.abstained is False
        assert result.sources[0].document_id == EMPLOYEE_DOCUMENT

    _scenario(body)


def test_a_quote_is_proved_against_the_text_the_final_gate_read() -> None:
    """The gate-before-validate ordering, asserted through what it would let through.

    A cited passage's text is changed in place while it stays authorized and keeps its
    revision. The claim still quotes what the model was *sent*, so a service that
    validated against the pre-send text would accept it. Because the gate runs first, that
    text is gone by the time the quote is checked and the generation is refused. The test
    fails in one direction only, which is what makes it worth more than a comment.
    """

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _acting_during(_rewriting_text(factory, STALE_TEXT), _good_result("E1"))

        with pytest.raises(InvalidGeneration) as raised:
            await _run(factory, generator)

        assert raised.value.reason is InvalidReason.QUOTE_NOT_FOUND

    _scenario(body)


# --------------------------------------------------------------------------
# invalid generations
# --------------------------------------------------------------------------


def test_an_invented_citation_refuses_the_whole_answer() -> None:
    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _CannedGenerator(_good_result("E1", "E7"))

        with pytest.raises(InvalidGeneration) as raised:
            await _run(factory, generator)

        assert raised.value.reason is InvalidReason.UNKNOWN_EVIDENCE_ID
        assert raised.value.handle == "E7"

    _scenario(body)


def test_a_fabricated_quote_refuses_the_whole_answer() -> None:
    """The mixed response: one grounded claim and one invented one, nothing served."""
    mixed = GenerationResult(
        claims=[
            Claim(text=CLAIM_TEXT, evidence_id="E1", quote=GOOD_QUOTE),
            Claim(
                text="درخواست باید ظرف ۹۰ روز ثبت شود",
                evidence_id="E1",
                quote="درخواست باید ظرف ۹۰ روز ثبت شود",
            ),
        ],
        abstained=False,
        missing_parts=[],
        answer=None,
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        with pytest.raises(InvalidGeneration) as raised:
            await _run(factory, _CannedGenerator(mixed))

        assert raised.value.reason is InvalidReason.QUOTE_NOT_FOUND

    _scenario(body)


def test_a_provider_failure_is_never_turned_into_an_answer() -> None:
    """No fallback, and not a refusal either: a failure is not a product answer."""

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)
        generator = _FailingGenerator()

        with pytest.raises(RuntimeError):
            await _run(factory, generator)

        assert generator.calls == 1

    _scenario(body)


# --------------------------------------------------------------------------
# the composed answer
# --------------------------------------------------------------------------


def test_a_mixed_answer_gives_the_claim_then_the_refusal() -> None:
    """The public half answered, the restricted half refused - without naming either."""
    mixed = GenerationResult(
        claims=[Claim(text=CLAIM_TEXT, evidence_id="E1", quote=GOOD_QUOTE)],
        abstained=True,
        missing_parts=["insufficient_evidence"],
        answer=None,
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        served = await _run(factory, _CannedGenerator(mixed))

        lines = served.answer.split("\n")
        assert lines[0] == CLAIM_TEXT
        assert lines[1] == REFUSAL_BY_PART["insufficient_evidence"]

    _scenario(body)


def test_an_abstention_with_no_claims_cites_nothing() -> None:
    abstained = GenerationResult(
        claims=[], abstained=True, missing_parts=["ambiguous"], answer=None
    )

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        served = await _run(factory, _CannedGenerator(abstained))

        assert served.abstained
        assert served.sources == []
        assert served.answer == REFUSAL_BY_PART["ambiguous"]

    _scenario(body)


def test_usage_is_carried_on_the_answer_even_when_it_abstained() -> None:
    """A refusal after a billed attempt is still billable, and the result says so."""
    abstained = GenerationResult(claims=[], abstained=True, missing_parts=["conflict"], answer=None)

    async def body(engine: Any, factory: Any) -> None:
        await _employee_document(factory)

        served = await _run(factory, _CannedGenerator(abstained))

        assert served.abstained
        assert served.usage is USAGE
        assert served.usage.attempts == 1

    _scenario(body)


# --------------------------------------------------------------------------
# the package map agrees with what is built
# --------------------------------------------------------------------------


def test_the_answer_package_exists_where_the_map_says_it_does() -> None:
    """The map lists ``answer/`` under ``apps/api/app/``; that directory is real."""
    package = pathlib.Path(__file__).resolve().parents[1] / "app" / "answer"
    assert package.is_dir()


def test_the_package_map_does_not_call_the_answer_package_future_work() -> None:
    """Review P3.

    Section 7 described ``answer`` as belonging to a later part, in the same paragraph that
    lists every other package as built. Narrow by design: it looks for that claim in the
    paragraph that carries the package list, so an unrelated rewrite elsewhere cannot fail
    it, and a legitimate rewording of this paragraph still has to say the package exists.
    """
    docs = pathlib.Path(__file__).resolve().parents[3] / "docs"
    architecture = (docs / "ARCHITECTURE.md").read_text(encoding="utf-8")

    listing = next(
        paragraph
        for paragraph in architecture.split("\n\n")
        if "`providers`" in paragraph and "`retrieval`" in paragraph
    )
    assert "`answer`" in listing, "the package map no longer lists the answer package"

    # The property rather than the sentence the review quoted: within the listing, no clause
    # that mentions ``answer`` may also call something future. A phrasing-typed guard misses
    # a reworded regression, which is the only shape one is likely to take.
    clauses = [clause.strip() for clause in listing.replace(".", "؛").split("؛")]
    for clause in clauses:
        if "`answer`" in clause:
            assert "آینده" not in clause, (
                f"the package map still defers the answer package: {clause!r}"
            )
