"""Citation validation: does a generation rest on text the caller may read?

``technical-details.md`` subject 6 fixes the shape - ``validate_generation(payload,
evidence) -> ValidatedClaims``, accepting or rejecting every claim together - and this
module is that function. ``SECURITY.md`` gives the reason the rule exists: an invalid
claim in a model's output **is** the failure, so a claim is never quietly dropped. Dropping
it would let the remaining claims read as the whole answer, and would answer on the
model's behalf the one question that matters, which is whether its next citation will be
grounded too.

The evidence this is given is the authorized mapping the caller holds, not a database
handle. Two consequences are deliberate:

* A claim can only be matched against text the caller was allowed to read, because no
  other text is reachable from here.
* ``validate_generation`` cannot widen its own authorization by going to look something
  up. The final re-check under the allowlist happens in the service, before this runs.

The quoted text is the passage's, not the model's. ``find_quote`` resolves the model's
string to a span of the passage and this module stores *that* span, so a citation served
later is text the document contains even when the model agreed with the document only
after normalizing a ZWNJ or an Arabic letter. What a matched quote proves is *grounding* -
the claim rests on text that is really there. It does not prove the sentence follows from
that text; ``evaluation-guide.md`` scores that by human review.
"""

from __future__ import annotations

from collections.abc import Mapping

from app.answer.quotes import MIN_QUOTE_TOKENS, find_quote, quote_token_count
from app.answer.schemas import (
    MAX_CLAIMS,
    AuthorizedEvidence,
    InvalidGeneration,
    InvalidReason,
    ValidatedClaim,
    ValidatedClaims,
)
from app.providers.base import MISSING_PARTS_BY_NAME, GenerationResult, MissingPart


def validate_generation(
    payload: GenerationResult,
    evidence: Mapping[str, AuthorizedEvidence],
) -> ValidatedClaims:
    """Return ``payload``'s claims once every one of them is supported.

    Raises :class:`~app.answer.schemas.InvalidGeneration` naming the first reason found.
    The order of checks matters only for which reason an operator is told, never for
    whether the generation is served - there is exactly one outcome and it is fail-closed.

    An abstention with no named reason is *accepted*: ``missing_parts`` is a required
    field the schema may return empty, and a model that refused without naming a reason
    has still refused. The composed text falls back to a fixed neutral sentence rather
    than refusing a question over a cosmetic gap. A named reason beside a complete answer
    is the opposite case and is rejected, because the answer contradicts the reason.
    """
    missing_parts = _checked_missing_parts(payload)
    claims = _checked_claims(payload, evidence)

    if not claims and not payload.abstained:
        raise InvalidGeneration(InvalidReason.EMPTY_ANSWER)
    if missing_parts and not payload.abstained:
        raise InvalidGeneration(InvalidReason.INCONSISTENT_ABSTENTION)

    return ValidatedClaims(
        claims=claims,
        abstained=payload.abstained,
        missing_parts=missing_parts,
    )


def _checked_claims(
    payload: GenerationResult,
    evidence: Mapping[str, AuthorizedEvidence],
) -> list[ValidatedClaim]:
    if len(payload.claims) > MAX_CLAIMS:
        raise InvalidGeneration(InvalidReason.TOO_MANY_CLAIMS)

    checked: list[ValidatedClaim] = []
    for claim in payload.claims:
        text, handle, quote = claim.text, claim.evidence_id, claim.quote
        if not text.strip() or not handle.strip() or not quote.strip():
            # Checked before the handle lookup so a blank field is reported as what it is
            # rather than as an unknown handle: a blank handle is a malformed claim, and
            # the two would send an operator looking in different places.
            raise InvalidGeneration(
                InvalidReason.MALFORMED_CLAIM,
                handle=handle.strip() or None,
            )

        passage = evidence.get(handle)
        if passage is None:
            raise InvalidGeneration(InvalidReason.UNKNOWN_EVIDENCE_ID, handle=handle)

        span = find_quote(quote, passage.text)
        if span is None:
            raise InvalidGeneration(InvalidReason.QUOTE_NOT_FOUND, handle=handle)
        if quote_token_count(quote) < MIN_QUOTE_TOKENS:
            raise InvalidGeneration(InvalidReason.QUOTE_TOO_SHORT, handle=handle)

        start, end = span
        checked.append(
            ValidatedClaim(
                text=text,
                quote=passage.text[start:end],
                source=passage.source,
                handle=handle,
            )
        )
    return checked


def _checked_missing_parts(payload: GenerationResult) -> list[MissingPart]:
    """Fold the reasons into a valid, deduplicated list, preserving first-use order.

    A repeated reason is collapsed rather than kept: a real generation named one reason
    four times, and composed text that repeated the same sentence four times reads as a
    defect in the document rather than in the answer.
    """
    checked: list[MissingPart] = []
    for name in payload.missing_parts:
        part = MISSING_PARTS_BY_NAME.get(name)
        if part is None:
            raise InvalidGeneration(InvalidReason.UNKNOWN_MISSING_PART)
        if part not in checked:
            checked.append(part)
    return checked
