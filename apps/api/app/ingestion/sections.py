"""Stable section identifiers across a replacement.

ARCHITECTURE.md section 6: on replacement the mapping of preserved sections must
survive and a genuinely new section takes the next free identifier. Section id is
the citation handle, so an identifier that moves between sections would make an
existing citation quote the wrong text.

Two decisions make that safe:

* **Preservation is matched on title.** Position is not stable once a section is
  inserted or removed, and the parsed document carries no other durable key. The
  first incoming section with a given title inherits that title's previous id;
  a section whose title is new gets a fresh id.
* **"Next free" means above the high-water mark, never a reused gap.** If a
  section is removed, its id becomes unused, and handing that id to a *different*
  section would silently repoint every citation that referenced it. Ids this
  document has ever used are therefore never recycled.

The high-water mark is passed in rather than derived from ``previous``, because
the base revision is not the whole history. A document that once had sections
``S1`` and ``S3``, then dropped ``S3``, has a base of only ``S1`` while ``S3`` is
still spent; deriving the mark from the base would hand it to the next new section.
The caller therefore takes the mark across every revision of the document, which
means this rule depends on published revisions keeping their rows - the policy
recorded in DATABASE.md. If that policy ever changes, the mark has to be persisted
instead of recomputed.

The function is pure and does no I/O, so the rule can be tested exhaustively
without a database.
"""

import re
from collections.abc import Iterable, Sequence

from app.documents.parse import ParsedSection

# The trailing "-S<n>" or "S<n>" a parser assigns, e.g. "S0" or "DOC-001-S3".
_TRAILING_NUMBER = re.compile(r"^(?P<prefix>.*-)?S(?P<number>\d+)$")

_WHITESPACE = re.compile(r"\s+")


def _split(identifier: str) -> tuple[str | None, int]:
    """Return ``(prefix, number)`` for a trailing ``-S<n>`` id, else ``(None, -1)``."""
    match = _TRAILING_NUMBER.match(identifier)
    if match is None:
        return None, -1
    prefix = match.group("prefix")
    return (prefix or ""), int(match.group("number"))


def _normalize_title(title: str) -> str:
    """Collapse whitespace and case so a retyped heading still counts as preserved."""
    return _WHITESPACE.sub(" ", title).strip().casefold()


def highest_section_number(identifiers: Iterable[str]) -> int:
    """Return the largest numeric suffix in ``identifiers``, or -1 if there is none.

    Unparseable identifiers are ignored rather than guessed at: the store uses this
    to read the document's whole history out of the rows that exist, and an id this
    module cannot read is an id it must also not hand out.
    """
    return max((_split(identifier)[1] for identifier in identifiers), default=-1)


def stable_section_ids(
    previous: Sequence[tuple[str, str]],
    incoming: Sequence[ParsedSection],
    *,
    historical_high_water: int,
) -> list[str]:
    """Return the identifier to persist for each incoming section, in order.

    ``previous`` is the base revision's ``(section_id, title)`` pairs, oldest first.
    ``incoming`` is the freshly parsed document, whose own identifiers are
    positional and therefore treated as provisional.
    ``historical_high_water`` is the largest numeric identifier suffix this document
    has ever used, across every revision and including the incoming provisional
    ones the caller can see. Pass ``-1`` only for a document with no history at all.

    The mark is an input rather than something derived from ``previous``, because the
    base revision is not the whole history: a document that once had ``S1`` and
    ``S3`` and then dropped ``S3`` has a base of only ``S1``, and deriving the mark
    from it would hand ``S3`` to the next new section.
    """
    if not previous and historical_high_water < 0:
        # The first revision of a document: there is no citation to protect and no
        # history to stay above, so the parser's identifiers stand. Both halves of
        # that condition matter - a missing base with a real history falls through
        # to the general rule rather than handing out parser ids that could collide.
        return [section.section_id for section in incoming]

    # One shared prefix keeps a document's new ids in its established style; a
    # document whose previous ids disagree falls back to the bare "S<n>" form.
    prefixes = {_split(identifier)[0] or "" for identifier, _ in previous}
    prefix = prefixes.pop() if len(prefixes) == 1 else ""

    # A title can map to several previous ids; hand them out in order so two
    # incoming sections with the same title still get distinct ids.
    by_title: dict[str, list[str]] = {}
    for identifier, title in previous:
        by_title.setdefault(_normalize_title(title), []).append(identifier)

    # Incoming identifiers count toward the mark too, so an allocated id can never
    # collide with one the incoming document already used and we chose not to keep.
    high_water = max(
        [historical_high_water]
        + [_split(identifier)[1] for identifier, _ in previous]
        + [_split(section.section_id)[1] for section in incoming]
        + [-1]
    )

    assigned: list[str] = []
    for section in incoming:
        candidates = by_title.get(_normalize_title(section.title))
        if candidates:
            assigned.append(candidates.pop(0))
            continue
        high_water += 1
        assigned.append(f"{prefix}S{high_water}" if prefix else f"S{high_water}")
    return assigned
