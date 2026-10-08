"""Quote-to-source matching for citation quotes.

A claim arrives with a ``quote`` and an evidence handle. This module decides whether
that quote refers to a span of the authorized text, and if so, *where* - never whether
the model's own string is acceptable as the citation.

Why the tolerance exists, measured rather than assumed: in this project's own corpus 87
of 109 chunks contain a ZWNJ, 459 occurrences across 33,262 characters, about 1.4% of
every character. A hundred-character quote therefore has roughly a 75% chance of
containing at least one, and a bare ``quote in source`` test rejects about three out of
four perfectly good quotes. The service would abstain on questions it could answer, and
the operator would have no way to tell a policy gap from a character class.

What the tolerance does *not* do is let the model's string become the citation. The
matcher returns a span of ``source``, and the caller serves that span. So the text a
reader compares against the document is text the document contains, even when the model
agreed with the document only after normalization. ``normalize_for_search`` is reused
here as a *comparison* form; ``chunk_text`` and ``source_text`` are never rewritten
(CODE_STYLE.md section 6).

Two rules make the span honest:

* **Contiguity.** A quote must match a run of adjacent tokens. Two real fragments of a
  chunk spliced together quote nothing, and a matcher that accepted one would certify a
  citation no sentence in the document supports.
* **A token floor.** One word alone is not a quotation. ``مهلت`` is load-bearing, and at
  four characters a character floor tuned to reject it would also reject legitimate short
  policy phrases, so the floor counts tokens instead.

A matched quote proves *grounding* - the claim rests on text the document really
contains. It does not prove the sentence follows from that text; that is a human
judgement, and ``evaluation-guide.md`` scores it as one.
"""

from __future__ import annotations

from typing import Final

from app.documents.normalize import normalize_for_search

#: A quotation has to be more than a single word. Two, not one, because one word is
#: usually a term rather than a span, and not a character count because Persian words
#: are short enough that any character floor tuned to exclude one word would also
#: exclude real policy phrases such as "سقف سه ماه".
MIN_QUOTE_TOKENS: Final = 2


#: Whether ``character`` separates two words.
#:
#: Derived from ``normalize_for_search`` rather than restated, and that is the whole
#: point: this function is reached once per claim over a chunk of at most 1200
#: characters, which is nothing next to the alternative. The obvious spellings are both
#: wrong. ``str.isspace`` alone splits "نیم‌فاصله" into one word because a ZWNJ is not
#: whitespace in Python, while normalization rewrites it to a space, so one side of a
#: comparison would carry one token and the other two. A hand-written class duplicating
#: normalize.py's would be a second list to forget to update. Asking normalization what
#: it does to a single character cannot drift from it.
def _separates(character: str) -> bool:
    return character.isspace() or not normalize_for_search(character).strip()


def quote_token_count(quote: str) -> int:
    """Return how many tokens ``quote`` has.

    Normalization is applied per token so a ZWNJ counts as the boundary it is: a model
    that wrote ``نیم فاصله`` and a document that wrote ``نیم‌فاصله`` describe the same two
    words and must not be scored as one word and two.
    """
    return len(_tokens_with_spans(quote))


def find_quote(quote: str, source: str) -> tuple[int, int] | None:
    """Return the ``source`` span that ``quote`` refers to, or ``None``.

    The verbatim check comes first because it is exact and needs no comparison form: if
    the model's string is already in the document, that occurrence is the citation, at
    its own boundaries rather than a token-aligned widening of them.

    Failing that, both sides are compared in their normalized token form, and a run of
    adjacent tokens in the source that equals the quote's tokens gives the span. The
    returned offsets are always into ``source``: the earliest match wins, so a phrase
    that occurs twice always cites the same passage and the output is deterministic.

    A quote with no tokens resolves to ``None`` even when the empty string is trivially
    "in" any source at offset 0 - an empty citation must not be able to pass as one.
    """
    wanted = [key for key, _, _ in _tokens_with_spans(quote)]
    if not wanted:
        return None

    verbatim = source.find(quote)
    if verbatim >= 0:
        return verbatim, verbatim + len(quote)

    source_tokens = _tokens_with_spans(source)
    keys = [key for key, _, _ in source_tokens]
    span = len(wanted)
    for index in range(len(keys) - span + 1):
        if keys[index : index + span] == wanted:
            start = source_tokens[index][1]
            end = source_tokens[index + span - 1][2]
            return start, end
    return None


def _tokens_with_spans(text: str) -> list[tuple[str, int, int]]:
    """Return ``(comparison_key, start, end)`` per token of ``text``.

    The key is the normalized token, used only for comparison. ``start`` and ``end`` are
    offsets into the *original* ``text``, which is what makes the resolved span verbatim:
    normalization is allowed to change what is compared, never what is cited.
    """
    tokens: list[tuple[str, int, int]] = []
    start: int | None = None
    for index, character in enumerate(text):
        if _separates(character):
            if start is not None:
                tokens.append((normalize_for_search(text[start:index]), start, index))
                start = None
        elif start is None:
            start = index
    if start is not None:
        tokens.append((normalize_for_search(text[start:]), start, len(text)))
    return tokens
