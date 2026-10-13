"""The answer-layer contracts, framework-free.

``CODE_STYLE.md`` section 4 keeps this module free of FastAPI, SQLAlchemy and provider
types so the service, a CLI and a future evaluation runner can all depend on it. The one
borrowed type is ``SourceRef``, which is itself a plain dataclass from the retrieval
contracts and is the project's stable citation handle.

Two of these types exist because of what a model cannot be trusted with.

``AuthorizedEvidence`` is the handle-to-passage mapping the caller holds *after* its
authorization gate. Validation is given this and nothing else, so a claim can only be
matched against text the caller was allowed to read, and a validation function cannot
reach the database to widen that itself.

``InvalidGeneration`` carries a closed set of reasons and a handle, and deliberately no
payload. The reason reaches an operator through a report and eventually a log, and
``CODE_STYLE.md`` section 9 forbids raw document text in logs - but a claim's text and
quote *are* the document rendered by a model. So the exception says which citation
failed without re-introducing the text the check exists to protect.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final

from app.providers.base import MissingPart, ProviderUsage
from app.retrieval.contracts import RetrievalConfig, SourceRef

#: Ceiling on accepted claims. Nothing upstream bounds it: ``GENERATION_SCHEMA`` carries
#: no ``maxItems`` on ``claims``, and the parameters sent to the endpoint are kept
#: deliberately minimal - an unsupported parameter is *silently ignored* by the provider,
#: and with ``require_parameters: true`` an ignored parameter becomes a rejected request.
#: Adding ``maxItems`` to the schema would therefore risk making every generation fail
#: for a bound that can be enforced here, verifiably, without a provider.
#:
#: Twelve is a judgement rather than a measurement: the evidence is capped at five
#: passages, so twelve claims is about two and a half per passage - loose enough for an
#: answer that states several consequences of one rule, tight enough that the composed
#: text stays an answer rather than a dump. ``evaluation-guide.md`` scores the fixed
#: 40-sample set in Part 18, and that run is where the number either holds or does not.
MAX_CLAIMS: Final = 12

#: Ceiling on distinct citations in one answer (``technical-details.md`` subject 6). The
#: service enforces it by capping how many handles it offers, so no answer can reach this
#: many sources; it is kept as a named figure because it is part of the answer contract.
MAX_SOURCES: Final = 5


class InvalidReason(StrEnum):
    """Why a generation could not be believed.

    A closed set, for the same reason ``MissingPart`` is: each value is named in a report
    and each maps to a fixed message, so a reason nobody anticipated has no wording and
    would tempt a caller into printing something it should not.
    """

    #: A claim field was blank, or a reason name was outside the closed set.
    MALFORMED_CLAIM = "malformed_claim"
    #: The claim cited a handle that was never offered.
    UNKNOWN_EVIDENCE_ID = "unknown_evidence_id"
    #: The quote is not in the passage the claim cited.
    QUOTE_NOT_FOUND = "quote_not_found"
    #: The quote is present but too short to be a quotation of anything.
    QUOTE_TOO_SHORT = "quote_too_short"
    #: More claims than ``MAX_CLAIMS``.
    TOO_MANY_CLAIMS = "too_many_claims"
    #: A ``missing_parts`` entry outside ``MISSING_PARTS``.
    UNKNOWN_MISSING_PART = "unknown_missing_part"
    #: Neither claims nor abstention: nothing to compose and no stated reason.
    EMPTY_ANSWER = "empty_answer"
    #: A stated reason beside a complete answer, which the answer contradicts.
    INCONSISTENT_ABSTENTION = "inconsistent_abstention"
    #: A document the claim really cited lost authorization between the send and the
    #: delivery. Separate from ``UNKNOWN_EVIDENCE_ID`` on purpose: an invented handle is
    #: the model building a citation, while this is a real document closing under a real
    #: access change. Telling an operator the model fabricated a citation when a manager
    #: narrowed a document sends them looking at the prompt instead of at the change.
    EVIDENCE_REVOKED = "evidence_revoked"


class InvalidGeneration(ValueError):
    """A generation that cannot be served, and why.

    A ``ValueError`` because the input was well-formed JSON of the wrong content, which
    is the same category as the adapter's own contract violations. It is raised rather
    than returned, because returning a partial result would let a caller believe the
    claims it did get were the whole answer.

    Written out rather than declared as a frozen dataclass, because a dataclass exception
    fails in a way that only surfaces somewhere unrelated. ``frozen=True`` makes
    ``__setattr__`` refuse the ``__traceback__`` assignment CPython performs as an
    exception propagates, and ``slots=True`` rebuilds the class, which strands the
    implicit ``__class__`` closure ``super()`` depends on. The visible symptom is a
    ``TypeError`` raised from inside ``contextlib`` while leaving a ``with`` block - a
    stack trace pointing at neither the dataclass nor the validation that was tested.
    """

    def __init__(self, reason: InvalidReason, *, handle: str | None = None) -> None:
        super().__init__(reason if handle is None else f"{reason} (handle {handle})")
        self.reason = reason
        #: The handle the failure concerns, when there is one. Handles are meaningless to
        #: a user - the model never sees a document id - so naming one leaks nothing.
        self.handle = handle


@dataclass(frozen=True, slots=True)
class AuthorizedEvidence:
    """One passage the caller may read, under the handle a claim cites it by.

    Carries the ``SourceRef`` alongside the text so a validated claim can name its
    document without a second lookup - and, more importantly, so the mapping from a
    model's handle to a real document happens here, after the authorization gate, and
    nowhere the model can reach.
    """

    handle: str
    text: str
    source: SourceRef


@dataclass(frozen=True, slots=True)
class ValidatedClaim:
    """One assertion that rests on text an authorized passage actually contains.

    ``quote`` is the span **from the passage**, not the string the model sent. When the
    two differed - a ZWNJ for a space, an Arabic letter for a Persian one - the passage's
    own text is what a reader and the source inspector both see, so the citation cannot
    drift from the document between the model's answer and the document.

    ``handle`` is kept for the operator report and is meaningless to a user. The model
    was given handles precisely so it could not name a document.
    """

    text: str
    quote: str
    source: SourceRef
    handle: str


@dataclass(frozen=True, slots=True)
class ValidatedClaims:
    """A generation whose every claim has been checked, and the flags beside it.

    ``abstained`` and ``missing_parts`` travel with the claims because they are consumed
    together: the composed text is the claims *and* a fixed refusal when the generation
    said it was incomplete, and a caller that kept the flags separately could compose a
    refusal with no claims to precede it.
    """

    claims: list[ValidatedClaim]
    abstained: bool
    missing_parts: list[MissingPart]

    @property
    def sources(self) -> list[SourceRef]:
        """The distinct sources cited, in first-use order.

        Deduplicated rather than capped: two claims resting on one passage cite it once,
        and silently dropping a citation from a served claim would leave that claim
        unsupported on screen. The ceiling is ``MAX_SOURCES``, enforced where the handles
        are offered.
        """
        ordered: list[SourceRef] = []
        for claim in self.claims:
            if claim.source not in ordered:
                ordered.append(claim.source)
        return ordered


@dataclass(frozen=True, slots=True)
class AnswerConfig:
    """What one ``answer`` call is allowed to do.

    ``retrieval`` is carried whole rather than copied field by field, so a retrieval
    setting added in a later part reaches the answer path without this file having to
    learn about it.
    """

    retrieval: RetrievalConfig = field(default_factory=RetrievalConfig)
    max_sources: int = MAX_SOURCES

    def __post_init__(self) -> None:
        """Refuse a citation ceiling outside ``1..MAX_SOURCES``.

        Checked on the type rather than in ``answer`` so the invalid state cannot exist:
        every construction path runs this, so no caller - present or future - can slip a
        value past the slice that applies it.

        Raising rather than clamping, deliberately. This number bounds how much document
        text is sent to a provider, so exceeding it is a mistake worth surfacing; silently
        serving five instead of six would leave the caller believing it had asked for six.
        Zero is refused for the same reason: it would offer no evidence at all and turn
        every call into a refusal while still reporting a configured ceiling.
        """
        if not 1 <= self.max_sources <= MAX_SOURCES:
            raise ValueError(
                f"max_sources must be between 1 and {MAX_SOURCES}, got {self.max_sources}"
            )


@dataclass(frozen=True, slots=True)
class AnswerResult:
    """One served answer, with everything needed to cite and to bill it.

    ``answer`` is composed from validated claims, never from the model's own prose -
    ``GenerationResult.answer`` exists so an operator can see what the model said, and
    ``ARCHITECTURE.md`` section 7 is explicit that it is never shown to a user.
    """

    answer: str
    claims: list[ValidatedClaim]
    sources: list[SourceRef]
    abstained: bool
    missing_parts: list[MissingPart]
    #: The generation's own accounting, including every attempt. ``None`` only when no
    #: request was made at all - an answer refused for want of authorized evidence cost
    #: nothing, and reporting that as zero would be a claim about money nobody spent.
    usage: ProviderUsage | None
    usages: list[ProviderUsage] = field(default_factory=list)
