"""Token-aware chunking inside a single section.

Ceilings come from DATABASE.md section 3 and ARCHITECTURE.md section 6:

- at most 1200 characters per chunk,
- at most 400 tokens per chunk **including the embedding prefix**, measured with
  the tokenizer that matches the embedding model (no character approximation),
- at most 150 characters of overlap with the immediately preceding chunk of the
  same section,
- a chunk never crosses a section boundary.

Chunk text is verbatim source text so a citation quote can be matched exactly;
``search_text`` is the derived, normalized field.
"""

from dataclasses import dataclass
from uuid import UUID, uuid4

from app.documents.normalize import normalize_for_search
from app.documents.parse import ParsedDocument, ParsedSection
from app.documents.tokenizer import TokenCounter, load_token_counter

MAX_CHARS = 1200
MAX_TOKENS = 400
OVERLAP_CHARS = 150

# The exact prefix ARCHITECTURE.md section 6 sends with a document embedding.
DOCUMENT_PREFIX = "search_document: "

# Preferred split points, strongest first. Splitting inside a word would produce
# a chunk whose quote cannot be found in the source.
_SPLIT_SEPARATORS = ("\n\n", "\n", ". ", "؛ ", "، ")


class ChunkingError(ValueError):
    """Raised when a section cannot be chunked within the ceilings."""


@dataclass(frozen=True)
class ChunkRecord:
    """One retrieval unit, scoped to exactly one section."""

    chunk_id: UUID
    document_id: str
    revision: str
    section_id: str
    ordinal: int
    text: str
    access_role: str

    @property
    def search_text(self) -> str:
        """Derived, normalized text for retrieval only."""
        return normalize_for_search(self.text)


def _fits(text: str, counter: TokenCounter, max_tokens: int) -> bool:
    """Return whether ``text`` plus the provider prefix stays within the ceiling.

    The count includes the prefix because the provider receives
    ``DOCUMENT_PREFIX + chunk``; measuring only the bare chunk would let the real
    request exceed the limit and be rejected at embed time.
    """
    return counter.count(f"{DOCUMENT_PREFIX}{text}") <= max_tokens


def _split_points(text: str) -> list[int]:
    """Return candidate cut offsets, strongest boundary first, in order."""
    points: list[int] = []
    for separator in _SPLIT_SEPARATORS:
        start = 0
        while True:
            found = text.find(separator, start)
            if found == -1:
                break
            points.append(found + len(separator))
            start = found + len(separator)
    return sorted(set(points))


def _chunk_text(
    text: str,
    counter: TokenCounter,
    max_chars: int,
    max_tokens: int,
    overlap: int,
) -> list[str]:
    """Split one section's text into overlapping chunks.

    Works back from the last usable boundary inside the ceiling. A section whose
    first window already overflows the token ceiling raises, because trimming it
    would drop citable content silently.
    """
    if not text:
        return []

    chunks: list[str] = []
    cursor = 0
    length = len(text)

    while cursor < length:
        remaining = length - cursor
        # If everything left fits the ceilings, emit it as the final chunk. The
        # overlap applies only between chunks, never to the tail of a section,
        # otherwise a section that already fits would be re-chunked.
        if remaining <= max_chars and _fits(text[cursor:], counter, max_tokens):
            chunks.append(text[cursor:].strip())
            break

        window = text[cursor : cursor + max_chars]

        # Grow to the last boundary inside the window so a chunk carries as much
        # of the section as the ceilings allow. Points are ascending, so keeping
        # the maximum fitting one maximizes chunk size.
        chosen = 0
        for point in _split_points(window):
            if 0 < point <= len(window) and _fits(
                text[cursor : cursor + point], counter, max_tokens
            ):
                chosen = point

        if chosen == 0:
            if _fits(window, counter, max_tokens):
                # No boundary in range but the raw window fits: keep it verbatim.
                chosen = len(window)
            else:
                # Overflow with no aligned boundary: fall back to a token-aligned
                # cut found by bisection. A character-count guess is never used to
                # decide a boundary the tokenizer rejected.
                chosen = _token_aligned_cut(text, cursor, max_chars, counter, max_tokens)

        piece = text[cursor : cursor + chosen].strip()
        if not piece:
            raise ChunkingError("section text cannot be split within the character ceiling")
        chunks.append(piece)
        # Advance past the chosen text, keeping at most ``overlap`` characters as
        # context for the next chunk. The step must be strictly positive or the
        # loop would not progress, but it must also not re-consume the overlap
        # region, which would emit the same tail repeatedly.
        step = chosen - overlap
        if step <= 0:
            step = chosen
        cursor += step
        if cursor >= length:
            break

    return [chunk for chunk in chunks if chunk]


def _token_aligned_cut(
    text: str, cursor: int, max_chars: int, counter: TokenCounter, max_tokens: int
) -> int:
    """Return the largest offset within the char ceiling that fits the token budget."""
    low, high = 1, min(max_chars, len(text) - cursor)
    best = 0
    while low <= high:
        middle = (low + high) // 2
        if _fits(text[cursor : cursor + middle], counter, max_tokens):
            best = middle
            low = middle + 1
        else:
            high = middle - 1

    if best == 0:
        raise ChunkingError(
            "a single character already exceeds the token ceiling; "
            "the section cannot be chunked without dropping content"
        )
    return best


def chunk_sections(
    document: ParsedDocument,
    *,
    document_id: str,
    revision: str,
    access_role: str,
    max_chars: int = MAX_CHARS,
    max_tokens: int = MAX_TOKENS,
    overlap: int = OVERLAP_CHARS,
    counter: TokenCounter | None = None,
) -> list[ChunkRecord]:
    """Split every section of ``document`` into citable chunks.

    ``access_role`` is supplied by the caller from confirmed metadata, never from
    the file's front matter. Chunks never span two sections.
    """
    if max_chars <= 0 or max_tokens <= 0:
        raise ChunkingError("ceilings must be positive")
    if overlap < 0 or overlap >= max_chars:
        raise ChunkingError("overlap must be smaller than the character ceiling")

    token_counter = counter or load_token_counter()

    records: list[ChunkRecord] = []
    for section in document.sections:
        pieces = _chunk_text(section.text, token_counter, max_chars, max_tokens, overlap)
        for ordinal, piece in enumerate(pieces):
            if len(piece) > max_chars:
                raise ChunkingError(
                    f"chunk for section {section.section_id} exceeds the character ceiling"
                )
            if not _fits(piece, token_counter, max_tokens):
                raise ChunkingError(
                    f"chunk for section {section.section_id} exceeds the token ceiling"
                )
            records.append(
                ChunkRecord(
                    chunk_id=uuid4(),
                    document_id=document_id,
                    revision=revision,
                    section_id=section.section_id,
                    ordinal=ordinal,
                    text=piece,
                    access_role=access_role,
                )
            )

    _require_unique_ordinals(records)
    return records


def _require_unique_ordinals(records: list[ChunkRecord]) -> None:
    """Enforce the unique key (document, revision, section, ordinal)."""
    seen: set[tuple[str, str, str, int]] = set()
    for record in records:
        key = (record.document_id, record.revision, record.section_id, record.ordinal)
        if key in seen:
            raise ChunkingError(f"duplicate chunk ordinal for section {record.section_id}")
        seen.add(key)


def sections_of(document: ParsedDocument) -> tuple[ParsedSection, ...]:
    """Expose parsed sections for callers that need the section-level view."""
    return document.sections
