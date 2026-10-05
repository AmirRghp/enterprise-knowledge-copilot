"""Deterministic Markdown/text parsing into citable sections.

The parser is intentionally small and has no third-party dependency, because
ARCHITECTURE.md section 12 treats a parse failure as a permanent error rather
than something to retry, and a predictable structure keeps section identifiers
stable across re-ingestion.

Two rules from the specs shape this module:

- Front matter is parsed but is **untrusted**. DATABASE.md section 3 states that
  front matter cannot set ``access_role`` or any other permission; the values are
  surfaced as claims for a manager to confirm, never applied.
- A file without section identifiers gets stable server-assigned ones, per the
  ingestion contract in ARCHITECTURE.md section 6.
"""

import re
from dataclasses import dataclass, field

from app.documents.normalize import normalize_for_search

# ATX headings only: "#" through "######", followed by a space.
_HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")

# A code-fence line: three or more backticks or tildes, then an optional info
# string. Used for both opening and closing fences.
_FENCE_MARKER = re.compile(r"(?P<marker>`{3,}|~{3,})(?P<info>.*)$")

# A heading that carries its own identifier, e.g. "HR-001-S1 — برنامه‌ریزی مرخصی".
_SECTION_ID_HEADING = re.compile(
    r"^(?P<section_id>[A-Za-z0-9][A-Za-z0-9_.-]*-S\d+)\s*[—–\-:]\s*(?P<title>.+)$"
)

# Server-assigned title for content that precedes the first level-2 heading.
PREAMBLE_TITLE = "مقدمه"

# Server-assigned identity for a plain-text document that has no headings.
PLAIN_TEXT_SECTION_ID = "S1"
PLAIN_TEXT_TITLE = "متن سند"

_FRONTMATTER_DELIMITER = "---"
_SIMPLE_FRONTMATTER = re.compile(r"^(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?P<value>.*)$")


class DocumentParseError(ValueError):
    """Raised for input that cannot yield a citable document.

    Permanent by design: ARCHITECTURE.md section 12 forbids unbounded retries for
    deterministic parsing failures.
    """


@dataclass(frozen=True)
class ParsedSection:
    """One citable section of a document.

    ``section_id`` is stable within the document and is the citation handle;
    ``text`` is the verbatim source text used for quotes.
    """

    section_id: str
    title: str
    heading_path: tuple[str, ...]
    text: str
    ordinal: int

    @property
    def search_text(self) -> str:
        """Derived, normalized text for retrieval. Never used for quoting."""
        return derive_search_text(self.title, self.text)


@dataclass(frozen=True)
class ParsedDocument:
    """A parsed document plus the untrusted claims from its front matter."""

    seed_document_id: str | None
    version: str
    content_status: str
    title: str | None
    sections: tuple[ParsedSection, ...]
    claimed_access_role: str | None = None
    metadata: dict[str, str] = field(default_factory=dict)


def split_front_matter(text: str) -> tuple[dict[str, str], str]:
    """Return front-matter claims and the body, without applying the claims."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != _FRONTMATTER_DELIMITER:
        return {}, text

    for index in range(1, len(lines)):
        if lines[index].strip() == _FRONTMATTER_DELIMITER:
            block = lines[1:index]
            return _parse_front_matter(block), "\n".join(lines[index + 1 :])

    # An unterminated block is malformed input rather than an implicit header.
    raise DocumentParseError("front matter block is not terminated")


def _parse_front_matter(block: list[str]) -> dict[str, str]:
    """Parse simple ``key: value`` claims. Values are returned unvalidated."""
    claims: dict[str, str] = {}
    for raw in block:
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = _SIMPLE_FRONTMATTER.match(line.strip())
        if match is None:
            # Nested YAML or lists are not used by this corpus; skip rather than
            # guess, and keep every claim unvalidated either way.
            continue
        claims[match.group("key").strip()] = match.group("value").strip().strip("\"'")
    return claims


@dataclass(frozen=True)
class _Fence:
    """An open fenced code block.

    A closing fence must use the same marker character as the opening one, be at
    least as long, and carry nothing but whitespace after the marker. Without all
    three rules a 4-backtick block would be closed by a 3-backtick line, and a
    line such as `````not-a-close`` would end the block it is meant to sit in.
    This follows CommonMark 0.31.2 "Fenced code blocks".
    """

    char: str
    length: int

    def closes(self, stripped: str) -> bool:
        """Return whether ``stripped`` is a valid closing fence for this block."""
        match = _FENCE_MARKER.fullmatch(stripped)
        if match is None:
            return False
        marker, info = match.group("marker"), match.group("info")
        if marker[0] != self.char or len(marker) < self.length:
            return False
        # An info string is only allowed on the opening fence.
        return info.strip() == ""


def _headings_outside_code_fences(
    lines: list[str],
) -> list[tuple[int, int, str, str]]:
    """Return ATX headings that are not inside a fenced code block.

    A ``## ...`` line inside a code fence is sample content, not structure.
    Treating it as a heading would invent a section and a citation target out of
    an example, so fenced regions are skipped entirely. Both backtick and tilde
    fences are honoured.
    """
    headings: list[tuple[int, int, str, str]] = []
    open_fence: _Fence | None = None

    for index, raw in enumerate(lines):
        stripped = raw.strip()

        if open_fence is not None:
            if open_fence.closes(stripped):
                open_fence = None
            continue

        opening = _FENCE_MARKER.fullmatch(stripped)
        if opening is not None:
            marker = opening.group("marker")
            open_fence = _Fence(char=marker[0], length=len(marker))
            continue

        match = _HEADING.match(raw)
        if match is None:
            continue
        headings.append((index, len(match.group(1)), match.group(2).strip(), raw))

    return headings


def _strip_markdown(text: str) -> str:
    """Return the citable text for a section.

    Markdown markers are deliberately left in place. DATABASE.md section 20
    requires ``source_text`` to stay verbatim so a citation quote can be matched
    exactly, and a section whose body is only a fenced code block must not be
    emptied by cleanup. Marker-free, normalized text is produced separately for
    the derived ``search_text`` field; see :func:`derive_search_text`.
    """
    return text.strip()


def derive_search_text(title: str, text: str) -> str:
    """Build the derived, normalized search text for a section.

    This is the only place Markdown is reduced, and it never feeds a citation.
    """
    without_fences = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    without_inline_code = re.sub(r"`([^`]*)`", r"\1", without_fences)
    without_images = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", without_inline_code)
    without_links = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", without_images)
    without_bullets = re.sub(r"^\s*[-*+]\s+", "", without_links, flags=re.MULTILINE)
    without_emphasis = re.sub(r"[*_]{1,3}([^*_]+)[*_]{1,3}", r"\1", without_bullets)
    flattened = " ".join(without_emphasis.split())
    return normalize_for_search(f"{title} {flattened}".strip())


def parse_document(text: str) -> ParsedDocument:
    """Parse Markdown/plain text into citable sections.

    Raises :class:`DocumentParseError` for empty input, an unterminated front
    matter block, or a document with no sections, since none of those can yield a
    citation.
    """
    if not text.strip():
        raise DocumentParseError("document is empty")

    claims, body = split_front_matter(text)
    stripped_body = body.strip()
    if not stripped_body:
        raise DocumentParseError("document has no body content")

    lines = body.splitlines()
    heading_lines = _headings_outside_code_fences(lines)

    title: str | None = None
    for _index, level, heading_text, _raw in heading_lines:
        if level == 1 and title is None:
            title = heading_text

    if not heading_lines:
        # Part 6 also covers plain text. A non-empty document without headings is
        # given one server-identified section so it stays citable, instead of
        # being rejected for a purely cosmetic reason.
        sections = [
            ParsedSection(
                section_id=PLAIN_TEXT_SECTION_ID,
                title=title or PLAIN_TEXT_TITLE,
                heading_path=(title or PLAIN_TEXT_TITLE,),
                text=_strip_markdown(stripped_body),
                ordinal=0,
            )
        ]
    else:
        sections = _build_sections(body, heading_lines, title)

    return ParsedDocument(
        seed_document_id=claims.get("document_id"),
        version=claims.get("version", "1.0"),
        content_status=claims.get("status", "active"),
        title=title or claims.get("title"),
        sections=tuple(sections),
        # Untrusted claim only; DATABASE.md section 3 forbids front matter from
        # granting access.
        claimed_access_role=claims.get("access_role"),
        metadata=claims,
    )


def _build_sections(
    body: str,
    heading_lines: list[tuple[int, int, str, str]],
    document_title: str | None,
) -> list[ParsedSection]:
    """Split the body at headings and attach stable section identifiers."""
    lines = body.splitlines()
    # Only level-2 headings are citable sections; level 1 is the document title.
    section_headings = [item for item in heading_lines if item[1] == 2]

    if not section_headings:
        # A document with no level-2 heading still needs one citable section.
        # Text before the first heading is kept: it is prepended to that section
        # so a preamble ahead of an H1 is not dropped.
        only = heading_lines[0]
        heading_positions = {item[0] for item in heading_lines}
        before = "\n".join(
            line for index, line in enumerate(lines[0 : only[0]]) if index not in heading_positions
        ).strip()
        after = "\n".join(lines[only[0] + 1 :]).strip()
        combined = "\n\n".join(part for part in (before, after) if part)
        if not combined:
            raise DocumentParseError("document has no section body")
        return [
            ParsedSection(
                section_id="S1",
                title=only[2],
                heading_path=tuple(filter(None, (document_title, only[2]))),
                text=_strip_markdown(combined),
                ordinal=0,
            )
        ]

    sections: list[ParsedSection] = []

    # Any non-heading text before the first citable section is real content. It
    # starts at line 0, not after the first heading, so text that precedes an H1
    # or an H2 is kept rather than dropped. Heading lines are filtered out: the
    # document title is already carried in ``heading_path`` and must not be
    # duplicated into the section body.
    heading_positions = {item[0] for item in heading_lines}
    first_section_line = section_headings[0][0]
    preamble = "\n".join(
        line
        for index, line in enumerate(lines[0:first_section_line])
        if index not in heading_positions
    ).strip()
    if preamble:
        sections.append(
            ParsedSection(
                section_id="S0",
                title=PREAMBLE_TITLE,
                heading_path=tuple(filter(None, (document_title, PREAMBLE_TITLE))),
                text=_strip_markdown(preamble),
                ordinal=0,
            )
        )

    for ordinal, (line_index, _level, heading_text, _raw) in enumerate(section_headings):
        end = (
            section_headings[ordinal + 1][0] if ordinal + 1 < len(section_headings) else len(lines)
        )
        section_body = "\n".join(lines[line_index + 1 : end]).strip()
        if not section_body:
            raise DocumentParseError(
                f"section {ordinal + 1} has no body content and cannot be cited"
            )

        identifier_match = _SECTION_ID_HEADING.match(heading_text)
        section_id = identifier_match.group("section_id") if identifier_match else f"S{ordinal + 1}"
        section_title = (
            identifier_match.group("title").strip() if identifier_match else heading_text
        )

        sections.append(
            ParsedSection(
                section_id=section_id,
                title=section_title,
                heading_path=tuple(filter(None, (document_title, section_title))),
                text=_strip_markdown(section_body),
                ordinal=len(sections),
            )
        )

    _require_unique_ids(sections)
    return sections


def _require_unique_ids(sections: list[ParsedSection]) -> None:
    """Reject duplicate section identifiers, which would break citations."""
    seen: set[str] = set()
    for section in sections:
        if section.section_id in seen:
            raise DocumentParseError(f"duplicate section_id: {section.section_id}")
        seen.add(section.section_id)
