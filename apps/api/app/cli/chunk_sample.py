"""Print the parse and chunk structure for one document, for manual review.

Read-only and offline: it makes no provider call and writes nothing to the
database. Run from ``apps/api``:

    uv run --locked python -m app.cli.chunk_sample corpus/HR-001.md

The output is intentionally short: section identifiers, chunk sizes against the
approved ceilings, and one short text preview per chunk.
"""

import argparse
import sys
from pathlib import Path

from app.documents.chunking import (
    DOCUMENT_PREFIX,
    MAX_CHARS,
    MAX_TOKENS,
    ChunkingError,
    chunk_sections,
)
from app.documents.parse import DocumentParseError, parse_document
from app.documents.tokenizer import TokenCounter, TokenizerUnavailableError, load_token_counter

PREVIEW_CHARS = 48
ALLOWED_SUFFIXES = {".md", ".txt"}


def _load_text(path: Path) -> str:
    """Read a UTF-8 Markdown/text file, rejecting unsupported extensions."""
    if path.suffix.lower() not in ALLOWED_SUFFIXES:
        raise DocumentParseError(f"unsupported file type: {path.suffix or '(none)'}")
    # utf-8 with a strict decode so a mis-encoded file fails instead of silently
    # producing mojibake that would later be cited.
    return path.read_text(encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path, help="a .md or .txt file to inspect")
    parser.add_argument(
        "--access-role",
        default="employee",
        choices=("employee", "manager"),
        help="role confirmed by the manager; file metadata never sets this",
    )
    parser.add_argument(
        "--revision",
        default="preview",
        help="revision label used only in this preview output",
    )
    arguments = parser.parse_args(argv)

    path: Path = arguments.path
    if not path.is_file():
        print(f"error: no such file: {path}", file=sys.stderr)
        return 2

    try:
        text = _load_text(path)
    except (DocumentParseError, UnicodeDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    try:
        counter: TokenCounter = load_token_counter()
        document = parse_document(text)
        records = chunk_sections(
            document,
            document_id=document.seed_document_id or path.stem,
            revision=arguments.revision,
            access_role=arguments.access_role,
            counter=counter,
        )
    except DocumentParseError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except TokenizerUnavailableError as error:
        # The counter is lazy, so the tokenizer is only touched while counting.
        # The failure therefore has to be handled here, around the chunking work,
        # not just around load_token_counter().
        print(f"error: {error}", file=sys.stderr)
        return 1
    except ChunkingError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    print(f"file                : {path}")
    print(f"seed document_id    : {document.seed_document_id}")
    print(f"title               : {document.title}")
    print(f"version / status    : {document.version} / {document.content_status}")
    print(f"claimed access_role : {document.claimed_access_role} (untrusted, not applied)")
    print(f"applied access_role : {arguments.access_role} (confirmed input)")
    print(f"sections            : {len(document.sections)}")
    print(f"chunks              : {len(records)}")
    print(f"ceilings            : {MAX_CHARS} chars / {MAX_TOKENS} tokens incl. prefix")
    print()

    for section in document.sections:
        print(f"section {section.section_id} — {section.title}")
        section_chunks = [r for r in records if r.section_id == section.section_id]
        for chunk in section_chunks:
            tokens = counter.count(f"{DOCUMENT_PREFIX}{chunk.text}")
            preview = chunk.text[:PREVIEW_CHARS].replace("\n", " ")
            print(
                f"    chunk {chunk.ordinal}: {len(chunk.text):>4} chars, "
                f"{tokens:>3} tokens | {preview}..."
            )
        if not section_chunks:
            print("    (no chunks)")
        print()

    print("no provider was called and no database was touched")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
