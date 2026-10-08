"""Tests for citation validation.

This is the part of the system where a model's assertion becomes something a user may
act on, so the negative cases are the substance. ``technical-details.md`` subject 6 and
``SECURITY.md`` both settle one rule that shapes most of what follows: validation is
**all or nothing**. One claim that cannot be supported rejects the whole generation,
because a caller that kept the good claims would believe they were the whole answer.

That rule is what makes the "mixed response" case safe. A model that returns two
grounded claims and one fabricated citation is not "mostly right"; it is a model
producing citations, and the only question worth asking is whether the next one will be
grounded too. Dropping the bad claim would answer that question "no" on its behalf.

Everything here is pure: no database, no provider, no network. The inputs are the
adapter's ``GenerationResult`` and the authorized evidence the caller holds, so each
test states a contract violation directly.
"""

import pytest

from app.answer.schemas import (
    MAX_CLAIMS,
    AuthorizedEvidence,
    InvalidGeneration,
    InvalidReason,
    ValidatedClaims,
)
from app.answer.validate import validate_generation
from app.providers.base import Claim, GenerationResult
from app.retrieval.contracts import SourceRef

SOURCE_A = SourceRef(document_id="HR-001", section_id="HR-001-S1", revision="r1")
SOURCE_B = SourceRef(document_id="HR-002", section_id="HR-002-S1", revision="r1")

PASSAGE_A = "مهلت جبران خدمت حداکثر سه ماه است و باید درخواست ثبت شود."
PASSAGE_B = "سقف پرداخت مدیران پانصد میلیون ریال تعیین شده است."

EVIDENCE = {
    "E1": AuthorizedEvidence(handle="E1", text=PASSAGE_A, source=SOURCE_A),
    "E2": AuthorizedEvidence(handle="E2", text=PASSAGE_B, source=SOURCE_B),
}

GOOD_TEXT = "مهلت جبران خدمت حداکثر سه ماه است."
GOOD_QUOTE = "مهلت جبران خدمت حداکثر سه ماه است"


def _result(
    *claims: Claim,
    abstained: bool = False,
    missing_parts: tuple[str, ...] = (),
) -> GenerationResult:
    return GenerationResult(
        claims=list(claims),
        abstained=abstained,
        missing_parts=list(missing_parts),  # type: ignore[arg-type]
        answer=None,
    )


def _good(evidence_id: str = "E1", quote: str = GOOD_QUOTE) -> Claim:
    return Claim(text=GOOD_TEXT, evidence_id=evidence_id, quote=quote)


def test_a_grounded_claim_becomes_a_validated_claim() -> None:
    validated = validate_generation(_result(_good()), EVIDENCE)

    assert isinstance(validated, ValidatedClaims)
    assert len(validated.claims) == 1
    claim = validated.claims[0]
    assert claim.text == GOOD_TEXT
    assert claim.quote == GOOD_QUOTE
    assert claim.source == SOURCE_A


def test_the_served_quote_is_the_source_span_not_the_models_string() -> None:
    """With a ZWNJ in the passage, the model's space form resolves to the source's span.

    The trailing full stop is in the quote because it is in the passage. Punctuation
    inside a quoted span is significant, so leaving it off would make this a different
    test: the citation would be rejected for the punctuation rather than resolved for the
    ZWNJ, and the assertion would pass for a reason opposite to the one it names.
    """
    passage = "برای نیم‌فاصله بین دو واژه یک فاصله می‌ماند."
    evidence = {"E1": AuthorizedEvidence(handle="E1", text=passage, source=SOURCE_A)}
    claim = Claim(
        text="برای نیم فاصله بین دو واژه یک فاصله می‌ماند.",
        evidence_id="E1",
        quote="برای نیم فاصله بین دو واژه یک فاصله می‌ماند.",
    )

    validated = validate_generation(_result(claim), evidence)

    served = validated.claims[0].quote
    assert served == passage
    assert served != claim.quote  # the model's own string is not what is served


def test_two_claims_may_rest_on_one_passage() -> None:
    second = Claim(
        text="درخواست باید ثبت شود",
        evidence_id="E1",
        quote="باید درخواست ثبت شود",
    )

    validated = validate_generation(_result(_good(), second), EVIDENCE)

    assert [claim.handle for claim in validated.claims] == ["E1", "E1"]
    assert validated.sources == [SOURCE_A]


def test_sources_are_deduplicated_in_first_use_order() -> None:
    other = Claim(
        text="سقف پرداخت مدیران پانصد میلیون ریال است",
        evidence_id="E2",
        quote="سقف پرداخت مدیران پانصد میلیون ریال",
    )

    validated = validate_generation(_result(_good(), other, _good()), EVIDENCE)

    assert validated.sources == [SOURCE_A, SOURCE_B]


def test_a_claim_citing_an_unknown_handle_is_rejected() -> None:
    """A handle that was never sent is a citation the model invented."""
    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(_good(evidence_id="E9")), EVIDENCE)

    assert raised.value.reason is InvalidReason.UNKNOWN_EVIDENCE_ID
    assert raised.value.handle == "E9"


def test_a_quote_absent_from_its_passage_is_rejected() -> None:
    """The citation must be text the passage contains, not merely one nearby."""
    fabricated = Claim(
        text="مهلت جبران خدمت حداکثر شش ماه است",
        evidence_id="E1",
        quote="مهلت جبران خدمت حداکثر شش ماه است",
    )

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(fabricated), EVIDENCE)

    assert raised.value.reason is InvalidReason.QUOTE_NOT_FOUND
    assert raised.value.handle == "E1"


def test_a_quote_taken_from_the_other_passage_is_rejected() -> None:
    """Right wording, wrong citation. This is the cross-document case by construction."""
    crossed = Claim(
        text="سقف پرداخت مدیران پانصد میلیون ریال است",
        evidence_id="E1",
        quote="سقف پرداخت مدیران پانصد میلیون ریال",
    )

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(crossed), EVIDENCE)

    assert raised.value.reason is InvalidReason.QUOTE_NOT_FOUND
    assert raised.value.handle == "E1"


def test_a_single_word_quote_is_rejected() -> None:
    """It is present, so a containment test passes it; it supports nothing on its own."""
    thin = Claim(text="مهلت", evidence_id="E1", quote="مهلت")

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(thin), EVIDENCE)

    assert raised.value.reason is InvalidReason.QUOTE_TOO_SHORT
    assert raised.value.handle == "E1"


def test_one_bad_claim_rejects_the_whole_generation() -> None:
    """The mixed response. Neither good claim survives, and that is the point."""
    fabricated = Claim(
        text="مهلت جبران خدمت حداکثر شش ماه است",
        evidence_id="E1",
        quote="مهلت جبران خدمت حداکثر شش ماه است",
    )

    with pytest.raises(InvalidGeneration):
        validate_generation(_result(_good(), fabricated, _good()), EVIDENCE)


def test_a_blank_claim_text_is_rejected() -> None:
    blank = Claim(text="   ", evidence_id="E1", quote=GOOD_QUOTE)

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(blank), EVIDENCE)

    assert raised.value.reason is InvalidReason.MALFORMED_CLAIM


def test_a_blank_quote_is_rejected() -> None:
    blank = Claim(text=GOOD_TEXT, evidence_id="E1", quote="  ")

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(blank), EVIDENCE)

    assert raised.value.reason is InvalidReason.MALFORMED_CLAIM


def test_a_blank_handle_is_rejected() -> None:
    blank = Claim(text=GOOD_TEXT, evidence_id="  ", quote=GOOD_QUOTE)

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(blank), EVIDENCE)

    assert raised.value.reason is InvalidReason.MALFORMED_CLAIM


def test_claims_without_abstention_are_rejected() -> None:
    """Neither an answer nor a stated reason: nothing for a reader to be told."""
    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(), EVIDENCE)

    assert raised.value.reason is InvalidReason.EMPTY_ANSWER


def test_an_abstention_with_no_named_reason_is_accepted() -> None:
    """Cosmetic gap, not a contract violation.

    ``missing_parts`` is a required field the schema can return empty, and a model that
    abstains without naming a reason has still refused to answer. Refusing the request
    here would be an abstention over a formatting gap, and the composed text falls back
    to a fixed neutral sentence instead of inventing a reason.
    """
    validated = validate_generation(_result(abstained=True), EVIDENCE)

    assert validated.abstained
    assert validated.claims == []
    assert validated.missing_parts == []


def test_a_named_abstention_reason_is_kept() -> None:
    validated = validate_generation(
        _result(abstained=True, missing_parts=("insufficient_evidence",)), EVIDENCE
    )

    assert validated.missing_parts == ["insufficient_evidence"]


def test_a_missing_part_outside_the_closed_set_is_rejected() -> None:
    """An unknown reason has no fixed neutral sentence, so it could not be composed."""
    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(abstained=True, missing_parts=("out_of_scope",)), EVIDENCE)

    assert raised.value.reason is InvalidReason.UNKNOWN_MISSING_PART


def test_repeated_missing_parts_collapse() -> None:
    """A real generation repeated a reason four times; composed text would repeat too."""
    validated = validate_generation(
        _result(
            abstained=True,
            missing_parts=("ambiguous", "ambiguous", "insufficient_evidence", "ambiguous"),
        ),
        EVIDENCE,
    )

    assert validated.missing_parts == ["ambiguous", "insufficient_evidence"]


def test_missing_parts_are_rejected_on_a_generation_that_did_answer() -> None:
    """A stated reason beside a full answer is a claim the answer contradicts."""
    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(_good(), missing_parts=("conflict",)), EVIDENCE)

    assert raised.value.reason is InvalidReason.INCONSISTENT_ABSTENTION


def test_more_claims_than_the_cap_is_rejected() -> None:
    """The cap bounds the composed text, which no other layer bounds.

    Nothing upstream caps it: ``GENERATION_SCHEMA`` has no ``maxItems`` on ``claims``,
    and the strict-schema parameters the endpoint is sent are deliberately minimal
    because an unsupported one is *silently ignored* - and with ``require_parameters``
    an ignored parameter turns into a rejected request. So the bound lives here, where
    it is verifiable without a provider.
    """
    many = [_good() for _ in range(MAX_CLAIMS + 1)]

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(*many), EVIDENCE)

    assert raised.value.reason is InvalidReason.TOO_MANY_CLAIMS


def test_exactly_the_cap_is_accepted() -> None:
    """The boundary is inclusive, so a rejected generation is never a limit detail."""
    at_cap = [_good() for _ in range(MAX_CLAIMS)]

    validated = validate_generation(_result(*at_cap), EVIDENCE)

    assert len(validated.claims) == MAX_CLAIMS


def test_the_error_carries_no_model_text() -> None:
    """The reason reaches an operator through a report and, eventually, a log.

    ``CODE_STYLE.md`` section 9 forbids raw document text in logs, and a claim's text and
    quote are the document rendered by a model. So the exception names the reason and the
    handle and nothing else: an operator learns *which* citation failed without the
    failure re-introducing the text the check exists to protect.
    """
    fabricated = Claim(
        text="مهلت جبران خدمت حداکثر شش ماه است",
        evidence_id="E1",
        quote="مهلت جبران خدمت حداکثر شش ماه است",
    )

    with pytest.raises(InvalidGeneration) as raised:
        validate_generation(_result(fabricated), EVIDENCE)

    rendered = str(raised.value)
    assert "شش ماه" not in rendered
    assert "E1" in rendered
    assert InvalidReason.QUOTE_NOT_FOUND.value in rendered
    assert repr(fabricated.quote) not in rendered
