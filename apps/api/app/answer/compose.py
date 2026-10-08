"""Composing the text a user actually sees.

The served string is built here and nowhere else, from two inputs: the validated claims,
and the fixed sentences that stand in for whatever the model could not support. It never
reads ``GenerationResult.answer``. That field is the model's own prose, kept so an
operator can see what the model said, and ``ARCHITECTURE.md`` section 7 is explicit that
it is never shown to a user - a model that produced a fluent, plausible and wrong
paragraph is precisely the reason this module exists.

Every refusal sentence is ours, fixed, and closed-set. ``technical-details.md`` subject 6
specifies a fixed neutral message per reason, and a neutral message cannot be composed at
call time: any sentence built from the model's own words would be a second channel for
unsupported text into the answer.

The wording carries one security property beyond being neutral. Read as an employee who
has just been refused, none of these sentences may assert, deny or hint at the existence,
title or content of a document that employee cannot read. ``evaluation-guide.md`` calls
that a leak even when the answer text is clean: a refusal saying "there is no managers'
compensation policy" tells the reader that a document of that name exists. Each sentence
therefore speaks only about the set the reader can already see - "the documents available
to you" - and says what that set does not settle, never what is absent from it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Final

from app.answer.schemas import ValidatedClaim
from app.providers.base import MissingPart

#: The fixed refusal per reason. Wording is deliberate on one point beyond neutrality:
#: each sentence describes the caller's own authorized documents and what they fail to
#: settle, and none of them says a document is absent, because absence is information
#: about a set the reader is not entitled to know.
REFUSAL_BY_PART: Final[Mapping[MissingPart, str]] = {
    "insufficient_evidence": "بر پایهٔ اسناد در دسترس، پاسخ کامل به این پرسش ممکن نیست.",
    "ambiguous": "اسناد در دسترس دربارهٔ این پرسش روشن و یک‌دست نیستند.",
    "conflict": "اسناد در دسترس دربارهٔ این پرسش با یکدیگر تعارض دارند.",
}

#: Used when the model abstained without naming a reason, which the schema permits and a
#: real generation has done. A generic sentence is the honest floor here: refusing the
#: question over a missing reason string would be an abstention caused by our own
#: formatting requirement, and inventing a reason would put a claim in a user's face that
#: nobody established.
UNNAMED_REFUSAL: Final = "بر پایهٔ اسناد در دسترس، پاسخی برای این پرسش تأیید نشد."

#: One claim or sentence per line, so a reader and a screen reader both get boundaries
#: without the text having to embed formatting.
_LINE_SEPARATOR: Final = "\n"


def compose_answer(
    claims: Sequence[ValidatedClaim],
    missing_parts: Sequence[MissingPart],
    abstained: bool,
) -> str:
    """Return the served text: the validated claims, then a fixed refusal if any.

    Consumes only the *flags* of the generation - ``abstained`` and which reasons it
    gave - and never any model prose. ``technical-details.md`` subject 6 fixes that
    shape: the final text comes from the validated claims plus a fixed message.

    Raises ``ValueError`` when there is neither a claim nor an abstention. ``validate_generation``
    rejects that generation before this is reached, so reaching it means the two were
    called inconsistently - and returning ``""`` would turn that inconsistency into a blank
    reply that looks like a successful answer.
    """
    if not claims and not abstained:
        raise ValueError("compose_answer needs a claim or an abstention")

    lines = [claim.text for claim in claims]
    if abstained:
        lines.extend(REFUSAL_BY_PART[part] for part in missing_parts)
        if not missing_parts:
            lines.append(UNNAMED_REFUSAL)
    return _LINE_SEPARATOR.join(lines)
