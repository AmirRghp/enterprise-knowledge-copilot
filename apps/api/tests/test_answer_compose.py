"""Tests for composing the served text.

The composed string is the only part of a generation a user ever sees, and it is built
from validated claims plus fixed sentences - never from ``GenerationResult.answer``,
which is the model's own prose and is retained only so an operator can see what was said.

What the fixed sentences are careful about is not confirming anything the caller could
not already know. Every one of them describes the *caller's own* authorized documents and
what they do not settle. None says whether a document exists, which is the specific
failure ``evaluation-guide.md`` calls a leak in a mixed question: a refusal phrased as
"there is no managers' compensation policy" tells an employee that a document of that
name exists.
"""

import pytest

from app.answer.compose import REFUSAL_BY_PART, UNNAMED_REFUSAL, compose_answer
from app.answer.schemas import ValidatedClaim
from app.providers.base import MISSING_PARTS
from app.retrieval.contracts import SourceRef

SOURCE = SourceRef(document_id="HR-001", section_id="HR-001-S1", revision="r1")


def _claim(text: str, handle: str = "E1") -> ValidatedClaim:
    return ValidatedClaim(text=text, quote="مهلت سه ماه است", source=SOURCE, handle=handle)


def test_validated_claims_become_the_served_text() -> None:
    composed = compose_answer([_claim("مهلت سه ماه است.")], [], False)

    assert composed == "مهلت سه ماه است."


def test_claims_are_kept_in_the_order_validated() -> None:
    composed = compose_answer([_claim("اول"), _claim("دوم"), _claim("سوم")], [], False)

    assert composed.split("\n") == ["اول", "دوم", "سوم"]


def test_model_synthesis_is_served_when_validated_claims_back_the_answer() -> None:
    composed = compose_answer(
        [_claim("مهلت سه ماه است.")], [], False, "درخواست را تا سه ماه ثبت کنید."
    )

    assert composed == "درخواست را تا سه ماه ثبت کنید."


def test_model_prose_cannot_replace_a_standalone_refusal() -> None:
    composed = compose_answer([], ["insufficient_evidence"], True, "پاسخی برای این پرسش ندارم.")

    assert composed == REFUSAL_BY_PART["insufficient_evidence"]


def test_an_abstention_with_no_claims_is_only_the_refusal() -> None:
    composed = compose_answer([], ["insufficient_evidence"], True)

    assert composed == REFUSAL_BY_PART["insufficient_evidence"]


def test_an_abstention_with_no_named_reason_still_says_something() -> None:
    """Better a generic sentence than an empty answer, and never an invented reason."""
    composed = compose_answer([], [], True)

    assert composed == UNNAMED_REFUSAL
    assert composed


def test_a_mixed_answer_gives_the_claims_then_the_refusal() -> None:
    """The shape ``evaluation-guide.md`` scores a success.

    A question with a public part and a restricted part is answered for the public part
    and refused for the rest. Refusing the whole answer would be wrong - the employee is
    entitled to the public half - and answering the whole would be a leak.
    """
    composed = compose_answer(
        [_claim("مهلت ثبت درخواست پانزده روز است.")],
        ["insufficient_evidence"],
        True,
    )

    lines = composed.split("\n")
    assert lines[0] == "مهلت ثبت درخواست پانزده روز است."
    assert lines[1] == REFUSAL_BY_PART["insufficient_evidence"]


def test_several_reasons_each_get_their_own_sentence() -> None:
    composed = compose_answer([], ["ambiguous", "conflict"], True)

    lines = composed.split("\n")
    assert lines == [
        REFUSAL_BY_PART["ambiguous"],
        REFUSAL_BY_PART["conflict"],
    ]


def test_composing_nothing_is_a_caller_error_not_a_silent_empty_answer() -> None:
    """An empty string would render as a blank reply with no explanation and no error."""
    with pytest.raises(ValueError):
        compose_answer([], [], False)


def test_every_missing_part_has_a_sentence() -> None:
    """A closed set on both sides, so no reason can reach a user without wording."""
    assert set(REFUSAL_BY_PART) == set(MISSING_PARTS)


#: Shapes that would tell a reader something about a set they cannot see. Not the bare
#: word for negation: "پاسخ ممکن نیست" negates the answer, which is fine, and "سندی وجود
#: ندارد" denies a document, which is a leak. A word list that cannot tell those apart is
#: a list that has to be weakened until it passes.
LEAK_SHAPES = (
    "وجود ندارد",
    "مدیر",
    "محرمانه",
    "غیرمجاز",
    "دسترسی ندارید",
    "حذف شده",
)

#: Identifier shapes from this project's corpus, which a refusal must never echo: naming a
#: document by id would confirm it exists even to a reader who may not read it.
IDENTIFIER_SHAPES = ("HR-0", "MGR-0", "-S1", "r1")


def test_every_refusal_frames_itself_around_the_callers_own_documents() -> None:
    """The positive half of the property, which a forbidden-word list cannot express.

    Each sentence must speak about the set the reader can already see, so what it denies
    is a conclusion about *those* documents rather than a fact about anything hidden.
    """
    for sentence in (*REFUSAL_BY_PART.values(), UNNAMED_REFUSAL):
        assert "اسناد در دسترس" in sentence, sentence


def test_no_refusal_confirms_anything_about_a_hidden_document() -> None:
    """Read as an employee who has just been refused, per ``evaluation-guide.md``."""
    for sentence in (*REFUSAL_BY_PART.values(), UNNAMED_REFUSAL):
        for shape in LEAK_SHAPES:
            assert shape not in sentence, f"{shape!r} in {sentence!r}"
        for shape in IDENTIFIER_SHAPES:
            assert shape not in sentence, f"{shape!r} in {sentence!r}"


def test_no_refusal_blames_the_reader() -> None:
    """A refusal that explains itself by the reader's permissions teaches them the rules.

    Phrased as a property rather than a word list because the failure is grammatical: any
    construction addressing the reader as the cause is the thing to rule out, and the
    second-person pronoun is the surest marker of it.
    """
    for sentence in (*REFUSAL_BY_PART.values(), UNNAMED_REFUSAL):
        assert "شما" not in sentence, sentence


def test_the_served_text_never_contains_a_handle() -> None:
    """Handles are the model's internal addressing and mean nothing to a reader."""
    composed = compose_answer([_claim("مهلت سه ماه است.", handle="E1")], [], False)

    assert "E1" not in composed
