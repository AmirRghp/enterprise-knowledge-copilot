"""Targeted checks for document parsing and chunking (Part 6).

Covers the three Part 6 obligations: build stable section identifiers, split
inside the approved ceilings, and reject invalid input without ever trusting file
metadata for authorization. No provider is contacted, so the whole file runs
offline except where the real tokenizer is explicitly loaded.
"""

import itertools
from pathlib import Path

import pytest

from app.documents.chunking import (
    DOCUMENT_PREFIX,
    MAX_CHARS,
    MAX_TOKENS,
    OVERLAP_CHARS,
    ChunkingError,
    chunk_sections,
)
from app.documents.normalize import normalize_for_search
from app.documents.parse import (
    DocumentParseError,
    parse_document,
    split_front_matter,
)
from app.documents.tokenizer import TokenCounter


class FixedTokenCounter:
    """Deterministic counter so ceilings can be driven without the network."""

    def __init__(self, chars_per_token: int = 10) -> None:
        self.chars_per_token = chars_per_token

    def count(self, text: str) -> int:
        return (len(text) + self.chars_per_token - 1) // self.chars_per_token + 1


def _document(body: str, *, title: str = "سند", sections: int = 1) -> str:
    parts = [f"# {title}"]
    for index in range(1, sections + 1):
        parts.append(f"## S{index} — بخش {index}\n\nمتن بخش {index}. " * 3)
    return "\n\n".join(parts) + "\n\n" + body


# --- normalization ---


def test_normalization_maps_arabic_letters_and_digits() -> None:
    assert normalize_for_search("ي ك ۱۵ نیم‌فاصله") == normalize_for_search("ی ک 15 نیم فاصله")


def test_normalization_is_idempotent() -> None:
    samples = ["كتاب", "متن‌پنهان", "۱۴۰۳", "a  b"]
    for sample in samples:
        once = normalize_for_search(sample)
        assert normalize_for_search(once) == once


def test_normalization_does_not_touch_latin_text_meaning() -> None:
    assert normalize_for_search("HR-001") == "HR-001"


# --- front matter is parsed but never authoritative ---


def test_front_matter_is_returned_as_untrusted_claims() -> None:
    text = (
        "---\ndocument_id: X-1\naccess_role: manager\nversion: 2.0\n---\n\n"
        "# عنوان\n\n## X-1-S1 — بخش\n\nمتن.\n"
    )
    parsed = parse_document(text)
    assert parsed.seed_document_id == "X-1"
    assert parsed.claimed_access_role == "manager"


def test_a_file_claiming_manager_cannot_escalate_chunk_access() -> None:
    """The caller's confirmed role is what lands on every chunk."""
    text = (
        "---\ndocument_id: X-1\naccess_role: manager\n---\n\n"
        "# عنوان\n\n## X-1-S1 — بخش\n\nمتن محرمانه.\n"
    )
    parsed = parse_document(text)
    assert parsed.claimed_access_role == "manager"

    records = chunk_sections(
        parsed,
        document_id="X-1",
        revision="1.0",
        access_role="employee",  # confirmed by the manager, not the file
        counter=FixedTokenCounter(),
    )
    assert records
    assert all(record.access_role == "employee" for record in records)


def test_unterminated_front_matter_is_rejected() -> None:
    with pytest.raises(DocumentParseError):
        split_front_matter("---\ndocument_id: X-1\n\n# بدون پایان\n")


def test_document_without_front_matter_is_accepted() -> None:
    claims, body = split_front_matter("# عنوان\n\nمتن.")
    assert claims == {}
    assert "عنوان" in body


# --- section identity ---


def test_section_ids_from_headings_are_preserved() -> None:
    text = (
        "---\ndocument_id: HR-001\n---\n\n# مرخصی\n\n"
        "## HR-001-S1 — برنامه‌ریزی\n\nمتن.\n\n"
        "## HR-001-S2 — تأیید\n\nمتن.\n"
    )
    parsed = parse_document(text)
    assert [s.section_id for s in parsed.sections] == ["HR-001-S1", "HR-001-S2"]


def test_missing_section_ids_get_stable_server_ids() -> None:
    text = "# سند\n\n## اول\n\nمتن.\n\n## دوم\n\nمتن.\n"
    parsed = parse_document(text)
    assert [s.section_id for s in parsed.sections] == ["S1", "S2"]


def test_section_ids_are_unique() -> None:
    text = "# سند\n\n## X-S1 — یک\n\nمتن.\n\n## X-S1 — دو\n\nمتن.\n"
    with pytest.raises(DocumentParseError):
        parse_document(text)


def test_heading_path_records_the_document_title_and_section_title() -> None:
    parsed = parse_document("# عنوان سند\n\n## S1 — بخش\n\nمتن.\n")
    assert parsed.sections[0].heading_path == ("عنوان سند", "S1 — بخش")
    # The identifier prefix is metadata, not part of the human title.
    assert parsed.sections[0].title == "S1 — بخش"


def test_section_title_drops_a_leading_identifier() -> None:
    parsed = parse_document("# سند\n\n## HR-001-S2 — تأیید و تحویل\n\nمتن.\n")
    assert parsed.sections[0].section_id == "HR-001-S2"
    assert parsed.sections[0].title == "تأیید و تحویل"


def test_section_ordinals_are_sequential() -> None:
    parsed = parse_document("# سند\n\n## S1 — یک\n\nمتن.\n\n## S2 — دو\n\nمتن.\n")
    assert [s.ordinal for s in parsed.sections] == [0, 1]


# --- invalid input is rejected permanently ---


@pytest.mark.parametrize(
    "text",
    ["", "   \n  ", "# فقط عنوان بدون بخش"],
)
def test_unusable_input_is_rejected(text: str) -> None:
    with pytest.raises(DocumentParseError):
        parse_document(text)


def test_a_section_without_body_is_rejected() -> None:
    with pytest.raises(DocumentParseError):
        parse_document("# سند\n\n## S1 — خالی\n\n")


# --- ceilings ---


def test_every_chunk_respects_the_character_ceiling() -> None:
    parsed = parse_document(_document("مرخصی سالانه. " * 400))
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert records
    assert all(len(record.text) <= MAX_CHARS for record in records)


def test_every_chunk_respects_the_token_ceiling_including_prefix() -> None:
    counter = FixedTokenCounter()
    parsed = parse_document(_document("مرخصی سالانه. " * 400))
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=counter,
    )
    assert all(counter.count(f"{DOCUMENT_PREFIX}{record.text}") <= MAX_TOKENS for record in records)


def test_chunks_never_cross_a_section_boundary() -> None:
    parsed = parse_document(
        "# سند\n\n## S1 — یک\n\n" + "الف. " * 200 + "\n\n## S2 — دو\n\n" + "ب. " * 200
    )
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    for record in records:
        source = next(s for s in parsed.sections if s.section_id == record.section_id)
        # Every chunk must be a substring of its own section, never a blend.
        assert record.text in source.text


def test_overlap_is_limited_to_adjacent_chunks_of_the_same_section() -> None:
    parsed = parse_document(_document("مرخصی سالانه. " * 400, sections=1))
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert len(records) > 1
    overlapped = 0
    for previous, following in itertools.pairwise(records):
        if previous.section_id != following.section_id:
            continue
        tail = previous.text[-OVERLAP_CHARS:]
        if tail and tail in following.text:
            overlapped += 1
    assert overlapped >= 1


def test_no_source_content_is_dropped() -> None:
    """Regression: an early exit once produced one chunk and lost the tail."""
    body = "مرخصی سالانه. " * 400
    parsed = parse_document(_document(body, sections=1))
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert len(records) > 1
    joined = "".join(record.text.replace(" ", "") for record in records)
    assert body.replace(" ", "")[:200] in joined
    assert body.replace(" ", "")[-200:] in joined


def test_ordinals_are_unique_within_a_section() -> None:
    parsed = parse_document(_document("مرخصی سالانه. " * 400, sections=2))
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    keys = [(r.document_id, r.revision, r.section_id, r.ordinal) for r in records]
    assert len(keys) == len(set(keys))


def test_invalid_ceilings_are_rejected() -> None:
    parsed = parse_document(_document("متن.", sections=1))
    with pytest.raises(ChunkingError):
        chunk_sections(
            parsed,
            document_id="D",
            revision="r",
            access_role="employee",
            max_chars=0,
            counter=FixedTokenCounter(),
        )
    with pytest.raises(ChunkingError):
        chunk_sections(
            parsed,
            document_id="D",
            revision="r",
            access_role="employee",
            overlap=MAX_CHARS,
            counter=FixedTokenCounter(),
        )


def test_chunk_text_is_verbatim_so_a_quote_can_be_matched() -> None:
    marker = "مهلت ثبت درخواست سه روز کاری است."
    parsed = parse_document(f"# سند\n\n## S1 — بخش\n\n{marker}\n")
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert any(marker in record.text for record in records)


def test_search_text_is_derived_and_normalized() -> None:
    parsed = parse_document("# سند\n\n## S1 — بخش\n\nكتاب عربي ۱۵\n")
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert any("کتاب عربی 15" in record.search_text for record in records)
    # The citable text itself must stay unchanged.
    assert any("كتاب عربي ۱۵" in record.text for record in records)


# --- real tokenizer ---


def test_real_tokenizer_respects_ceilings_on_a_synthetic_document() -> None:
    """Uses the model-matched tokenizer; skipped only if the hub is unreachable."""
    from app.documents.tokenizer import TokenizerUnavailableError, load_token_counter

    try:
        counter = load_token_counter()
    except TokenizerUnavailableError as error:  # pragma: no cover - offline
        pytest.skip(f"model tokenizer unavailable: {error}")

    parsed = parse_document(_document("نمونهٔ آزمون توکن‌ساز " * 80))
    records = chunk_sections(
        parsed,
        document_id="sample",
        revision="preview",
        access_role="employee",
        counter=counter,
    )
    assert records
    for record in records:
        assert len(record.text) <= MAX_CHARS
        assert counter.count(f"{DOCUMENT_PREFIX}{record.text}") <= MAX_TOKENS


def test_prefix_tokens_are_counted_against_the_ceiling() -> None:
    """The provider receives prefix plus text, so the prefix must be included."""
    from app.documents.tokenizer import TokenizerUnavailableError, load_token_counter

    try:
        counter = load_token_counter()
    except TokenizerUnavailableError as error:  # pragma: no cover - offline
        pytest.skip(f"model tokenizer unavailable: {error}")

    body = "متن آزمایشی. "
    assert counter.count(f"{DOCUMENT_PREFIX}{body}") > counter.count(body)


# --- regressions from the Part 6 review ---


def test_tail_after_an_earlier_boundary_is_not_dropped() -> None:
    """The end condition must follow the chosen chunk, not the window."""
    marker = "انتهای مهم"
    parsed = parse_document(f"# عنوان\n\n## بخش\n\nابتدا. {marker}")
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=load_real_counter(),
    )
    assert any(marker in record.text for record in records)


def test_long_tail_at_the_end_of_text_survives() -> None:
    marker = "دنبالهٔ مهم در انتهای متن."
    body = "متن میانی. " * 120 + marker
    parsed = parse_document(f"# عنوان\n\n## بخش\n\n{body}")
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=load_real_counter(),
    )
    assert len(records) > 1
    joined = "".join(record.text for record in records)
    assert marker in joined
    assert "متن میانی." in joined


def test_overlap_does_not_reconsume_text() -> None:
    """Consecutive chunks must advance; repeated tails would be a red flag."""
    body = "متن میانی. " * 120
    parsed = parse_document(f"# عنوان\n\n## بخش\n\n{body}")
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=load_real_counter(),
    )
    texts = [record.text for record in records]
    assert len(texts) == len(set(texts)), "a chunk repeated the previous tail"
    # A degenerate chunk this small can only come from a broken advance step.
    assert all(len(text.strip()) > 3 for text in texts)


def test_code_only_section_keeps_its_content() -> None:
    text = "# عنوان\n\n## بخش کد\n\n```python\nprint(1)\n```\n"
    parsed = parse_document(text)
    assert "print(1)" in parsed.sections[0].text
    records = chunk_sections(
        parsed,
        document_id="D",
        revision="r",
        access_role="employee",
        counter=FixedTokenCounter(),
    )
    assert records
    assert any("print(1)" in record.text for record in records)


def test_preamble_before_the_first_heading_becomes_a_section() -> None:
    text = "# عنوان\n\nمقدمهٔ مهم پیش از نخستین بخش.\n\n## بخش اول\n\nمتن.\n"
    parsed = parse_document(text)
    assert any("مقدمهٔ مهم" in section.text for section in parsed.sections)
    assert [section.ordinal for section in parsed.sections] == [0, 1]


def test_markdown_markers_are_preserved_in_citable_text() -> None:
    text = "# عنوان\n\n## بخش\n\n- **مهم**: متن  \n  با فاصله.\n"
    parsed = parse_document(text)
    citable = parsed.sections[0].text
    assert "- **مهم**: متن" in citable
    assert "```" not in citable  # only because this input has no fence
    # The derived field is where reduction belongs.
    assert "مهم" in parsed.sections[0].search_text


def test_plain_text_without_headings_is_accepted() -> None:
    parsed = parse_document("این یک متن ساده بدون عنوان است.")
    assert len(parsed.sections) == 1
    assert "متن ساده" in parsed.sections[0].text


def test_plain_text_section_id_is_stable_across_parses() -> None:
    first = parse_document("متن سادهٔ نمونه.")
    second = parse_document("متن سادهٔ نمونه.")
    assert first.sections[0].section_id == second.sections[0].section_id


def test_empty_input_is_still_rejected() -> None:
    with pytest.raises(DocumentParseError):
        parse_document("   \n\t ")


def test_heading_inside_a_backtick_fence_is_not_a_section() -> None:
    text = (
        "# عنوان\n\n## بخش واقعی\n\nمتن.\n\n```\n## MGR-999-S1 — جعلی\n```\n\n## بخش دوم\n\nمتن.\n"
    )
    parsed = parse_document(text)
    assert [section.section_id for section in parsed.sections] == ["S1", "S2"]
    assert not any("MGR-999" in section.section_id for section in parsed.sections)


def test_heading_inside_a_tilde_fence_is_not_a_section() -> None:
    text = "# عنوان\n\n## واقعی\n\n~~~\n## جعلی\n~~~\n\n## دوم\n\nمتن.\n"
    parsed = parse_document(text)
    assert len(parsed.sections) == 2


def test_cli_reports_a_tokenizer_failure_without_a_traceback(
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    from unittest.mock import patch

    from app.cli.chunk_sample import main
    from app.documents.tokenizer import TokenizerUnavailableError

    sample = tmp_path / "sample.md"
    sample.write_text(_document("نمونهٔ آزمون توکن‌ساز"), encoding="utf-8")
    with patch(
        "app.documents.tokenizer._tokenizer",
        side_effect=TokenizerUnavailableError("offline fixture"),
    ):
        code = main([str(sample)])

    assert code == 1
    captured = capsys.readouterr()
    assert "offline fixture" in captured.err
    assert "Traceback" not in captured.err


def load_real_counter() -> TokenCounter:
    """Load the model tokenizer, skipping when it is unreachable."""
    from app.documents.tokenizer import TokenizerUnavailableError, load_token_counter

    try:
        return load_token_counter()
    except TokenizerUnavailableError as error:  # pragma: no cover - offline
        pytest.skip(f"model tokenizer unavailable: {error}")


def test_a_section_that_already_fits_yields_one_chunk() -> None:
    """Overlap applies between chunks only, never to a tail that already fits."""
    counter = load_real_counter()
    parsed = parse_document(_document("این بخش برای آزمون باید در یک قطعه بماند."))
    records = chunk_sections(
        parsed,
        document_id="sample",
        revision="preview",
        access_role="employee",
        counter=counter,
    )
    assert records
    for section in parsed.sections:
        assert counter.count(f"{DOCUMENT_PREFIX}{section.text}") <= MAX_TOKENS
        section_chunks = [r for r in records if r.section_id == section.section_id]
        assert len(section_chunks) == 1, (
            f"{section.section_id} fits the ceilings and must not be re-chunked"
        )


def test_cli_reports_a_chunking_failure_without_a_traceback(
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    from unittest.mock import patch

    from app.cli.chunk_sample import main

    class OversizedCounter:
        """Every input exceeds the ceiling, so no boundary can ever fit."""

        def count(self, _text: str) -> int:
            return 10**6

    sample = tmp_path / "sample.md"
    sample.write_text(_document("نمونهٔ آزمون بخش‌بندی"), encoding="utf-8")
    with patch("app.cli.chunk_sample.load_token_counter", return_value=OversizedCounter()):
        code = main([str(sample)])

    assert code == 1
    captured = capsys.readouterr()
    assert "token ceiling" in captured.err
    assert "Traceback" not in captured.err


# --- regressions from the second Part 6 review ---


def test_preamble_before_the_first_h2_without_an_h1_is_kept() -> None:
    text = "مقدمهٔ مهم نباید حذف شود\n\n## جزئیات\n\nمتن بخش.\n"
    parsed = parse_document(text)
    assert any("نباید حذف شود" in section.text for section in parsed.sections)
    assert [section.section_id for section in parsed.sections] == ["S0", "S1"]


def test_preamble_before_the_first_h1_is_kept() -> None:
    text = "مقدمه پیش از H1 نباید حذف شود.\n\n# عنوان\n\nمتن پس از عنوان.\n"
    parsed = parse_document(text)
    assert any("پیش از H1" in section.text for section in parsed.sections)
    assert "متن پس از عنوان" in parsed.sections[0].text


def test_h1_then_preamble_then_h2_keeps_the_preamble_without_the_title() -> None:
    text = "# عنوان\n\nمقدمه میانی.\n\n## جزئیات\n\nمتن بخش.\n"
    parsed = parse_document(text)
    assert any("مقدمه میانی" in section.text for section in parsed.sections)
    # The document title belongs in heading_path, not duplicated into the body.
    assert not any(section.text.strip().startswith("#") for section in parsed.sections)


def test_four_backtick_fence_is_not_closed_by_three_backticks() -> None:
    text = (
        "# سند\n\n## بخش اصلی\n\n````text\n```\n## جعلی\nمتن نمونه\n````\n\n"
        "## بخش دوم\n\nمتن واقعی\n"
    )
    parsed = parse_document(text)
    titles = [section.title for section in parsed.sections]
    assert not any("جعلی" in title for title in titles)
    assert any("دوم" in title for title in titles), "the real heading after the fence was lost"


def test_four_tilde_fence_is_not_closed_by_three_tildes() -> None:
    text = "# سند\n\n## بخش\n\n~~~~text\n~~~\n## جعلی\nمتن\n~~~~\n\n## دوم\n\nمتن\n"
    parsed = parse_document(text)
    titles = [section.title for section in parsed.sections]
    assert not any("جعلی" in title for title in titles)
    assert any("دوم" in title for title in titles)


def test_closing_fence_with_a_text_suffix_does_not_close_the_block() -> None:
    text = (
        "# سند\n\n## بخش\n\n```text\n```not-a-close\n## جعلی\nمتن نمونه\n```\n\n"
        "## دوم\n\nمتن واقعی\n"
    )
    parsed = parse_document(text)
    titles = [section.title for section in parsed.sections]
    assert not any("جعلی" in title for title in titles)
    assert any("دوم" in title for title in titles)


def test_a_longer_closing_fence_is_valid() -> None:
    """CommonMark: a closing fence may be longer than the opening one."""
    text = "# سند\n\n## بخش\n\n```text\nمتن\n`````\n\n## دوم\n\nمتن واقعی\n"
    parsed = parse_document(text)
    assert any("دوم" in section.title for section in parsed.sections)


def test_a_tilde_fence_is_not_closed_by_backticks() -> None:
    text = "# سند\n\n## بخش\n\n~~~text\n```\n## جعلی\n~~~\n\n## دوم\n\nمتن\n"
    parsed = parse_document(text)
    assert not any("جعلی" in section.title for section in parsed.sections)
    assert any("دوم" in section.title for section in parsed.sections)
