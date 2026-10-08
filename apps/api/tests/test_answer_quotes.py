"""Tests for the quote-to-source matcher.

The rule this module implements exists because of a measurement, not a preference. In
this project's own corpus, 87 of 109 chunks contain a ZWNJ - 459 occurrences across
33,262 characters, about 1.4% of every character. A hundred-character quote therefore
has roughly a 75% chance of containing at least one, so a bare ``quote in source`` test
rejects about three out of four perfectly good quotes and the service abstains on
questions it could answer.

So the matcher accepts a quote that is *equivalent* to a span of the source rather than
byte-identical to it - but it never reports the model's own string as the citation. It
returns the verbatim span from the source, so whatever a reader later compares against
the document is text the document actually contains. Matching happens on a normalized
comparison only; ``source_text`` and ``chunk_text`` are never rewritten.

Every test below asserts the *span*, not just a boolean, because a matcher that says
"found it" without saying where is indistinguishable from one that guessed.
"""

from app.answer.quotes import MIN_QUOTE_TOKENS, find_quote, quote_token_count

ZWNJ = "‌"

# The drifting code points, named rather than pasted. An Arabic yeh or kaf is
# indistinguishable by eye from the Persian letter beside it, so a literal in a test file
# cannot be trusted to still contain one after a formatter or a Persian keyboard pass.
# Driving the substitution from the Persian form makes the drift explicit.
ARABIC_YEH = "ي"
ARABIC_KAF = "ك"
PERSIAN_YEH = "ی"
PERSIAN_KAF = "ک"

# Real corpus text, taken from the shape the ingested documents actually have. The ZWNJ
# in "نیم‌فاصله" is the character the whole tolerance rule exists for.
SOURCE = "مهلت جبران خدمت حداکثر سه ماه است و برای نیم‌فاصله بین دو واژه یک فاصله می‌ماند."


def _from_source(phrase: str) -> str:
    """Return ``phrase`` after asserting it really occurs in ``SOURCE``.

    A Persian literal in a test file can differ from the one in ``SOURCE`` by a single
    near-identical letter, and the failure that produces looks like a matcher bug rather
    than a typo - this file first contained "خدامت" where the source has "خدمت", so the
    substitution under test silently became a no-op and the test failed for a reason
    that had nothing to do with Arabic letters. Checking the phrase first turns that
    class of mistake into a failure that says what it is.
    """
    assert phrase in SOURCE, f"test phrase is not in SOURCE: {phrase!r}"
    return phrase


def test_a_verbatim_quote_resolves_to_its_exact_offset() -> None:
    quote = _from_source("حداکثر سه ماه است")

    found = find_quote(quote, SOURCE)

    assert found is not None
    start, end = found
    assert SOURCE[start:end] == quote


def test_a_quote_with_a_zwnj_matches_its_space_form() -> None:
    """The measurement above, as a test: the source has the ZWNJ, the model did not."""
    quote = _from_source(f"برای نیم{ZWNJ}فاصله بین دو واژه").replace(ZWNJ, " ")

    found = find_quote(quote, SOURCE)

    assert found is not None
    start, end = found
    # The span comes from the source, so it carries the ZWNJ the model did not send.
    assert SOURCE[start:end] == "برای نیم‌فاصله بین دو واژه"
    assert ZWNJ in SOURCE[start:end]


def test_the_reported_span_is_source_text_even_when_the_quote_differed() -> None:
    """The served citation is the document's own text, never the model's string."""
    quote = _from_source(f"برای نیم{ZWNJ}فاصله بین دو واژه").replace(ZWNJ, " ")

    found = find_quote(quote, SOURCE)

    assert found is not None
    start, end = found
    assert SOURCE[start:end] != quote  # the model's own string is not what is served
    assert SOURCE[start:end] in SOURCE


def test_an_arabic_kaf_quote_matches_the_persian_source() -> None:
    """Symmetry: this corpus is clean Persian, so the model's drift is the likely case."""
    quote = _from_source("جبران خدمت حداکثر سه ماه").replace(PERSIAN_KAF, ARABIC_KAF)

    found = find_quote(quote, SOURCE)

    assert found is not None
    start, end = found
    assert SOURCE[start:end] == "جبران خدمت حداکثر سه ماه"


def test_an_arabic_yeh_quote_matches_the_persian_source() -> None:
    # "یک فاصله" rather than anything from the first clause: the yehs near the front of
    # SOURCE sit in "مهلت جبران خدمت", and none of those three words contains one.
    # "_from_source" is what makes confirming that a matter of reading the assertion
    # rather than of re-reading the Persian.
    quote = _from_source("یک فاصله").replace(PERSIAN_YEH, ARABIC_YEH)

    found = find_quote(quote, SOURCE)

    assert found is not None
    start, end = found
    assert SOURCE[start:end] == "یک فاصله"


def test_a_persian_digit_quote_matches_the_ascii_source() -> None:
    source = "سقف پرداخت مدیران 500 میلیون ریال است"

    found = find_quote("سقف پرداخت مدیران ۵۰۰ میلیون ریال", source)

    assert found is not None
    start, end = found
    assert source[start:end] == "سقف پرداخت مدیران 500 میلیون ریال"


def test_double_spacing_still_matches() -> None:
    """Whitespace tolerance comes from token matching, not from rewriting the source.

    No trailing full stop, so this asserts spacing alone. Punctuation is significant and
    has its own test below; asserting both here would let either pass on the strength of
    the other.
    """
    source = "مهلت ثبت درخواست پانزده    روز است"

    found = find_quote("مهلت ثبت درخواست پانزده روز است", source)

    assert found is not None
    start, end = found
    assert source[start:end] == "مهلت ثبت درخواست پانزده    روز است"


def test_punctuation_inside_a_span_is_significant() -> None:
    """Removing a comma from the middle leaves a string the document does not contain."""
    source = "مهلت، سه ماه است."

    assert find_quote("مهلت سه ماه است", source) is None


def test_a_quote_stopping_before_the_full_stop_matches_at_that_prefix() -> None:
    """Stated because it looks like a gap, and somebody will try to "fix" it.

    Dropping a *trailing* full stop leaves a genuine prefix of the source, so it is a
    genuine substring and matching it is correct. Only punctuation that sits inside the
    quoted span can invalidate it, which is the test above. Asserting this keeps the two
    apart: without it, tightening the matcher to reject dropped full stops would break
    verbatim quoting as well.
    """
    source = "مهلت جبران خدمت سه ماه است."

    found = find_quote("مهلت جبران خدمت سه ماه است", source)

    assert found == (0, 26)


def test_a_quote_must_cover_contiguous_tokens() -> None:
    """Two real fragments of the source spliced together quote nothing."""
    source = "الف با ب ج. د با ب و ه."

    found = find_quote("الف با ب د با ب", source)

    assert found is None


def test_a_quote_absent_from_the_source_does_not_resolve() -> None:
    assert find_quote("حداکثر شش ماه است", SOURCE) is None


def test_the_earliest_occurrence_wins() -> None:
    """Deterministic, so a phrase occurring twice always cites the same passage."""
    source = "سه ماه است. سپس سه ماه است."

    found = find_quote("سه ماه است", source)

    assert found is not None
    start, _ = found
    assert start == 0


def test_an_empty_or_blank_quote_resolves_to_nothing() -> None:
    """The empty string is trivially "in" every source at offset 0, and must not pass."""
    assert find_quote("", SOURCE) is None
    assert find_quote("   ", SOURCE) is None
    assert find_quote(ZWNJ * 2, SOURCE) is None


def test_a_whole_chunk_quote_resolves_to_the_whole_span() -> None:
    assert find_quote(SOURCE, SOURCE) == (0, len(SOURCE))


def test_the_token_floor_counts_normalized_tokens() -> None:
    assert quote_token_count("حداکثر سه ماه") == 3
    assert quote_token_count(f"نیم{ZWNJ}فاصله") == 2  # the ZWNJ is a boundary, not a letter
    assert quote_token_count("مهلت") == 1
    assert quote_token_count("  ") == 0


def test_the_floor_is_two_tokens_not_a_character_count() -> None:
    """Persian words are short, so a character floor would be a proxy for word count.

    "مهلت" is a real, load-bearing word a claim could genuinely rest on, and it is four
    characters. A character floor tuned to reject it would also reject legitimate short
    policy phrases; a token floor rejects only a single word left standing alone.
    """
    assert MIN_QUOTE_TOKENS == 2
    assert quote_token_count("مهلت") < MIN_QUOTE_TOKENS
    assert quote_token_count("مهلت جبران") >= MIN_QUOTE_TOKENS


def test_matching_never_rewrites_the_source() -> None:
    """The derived comparison must not become the stored text (CODE_STYLE section 6)."""
    before = SOURCE

    find_quote("برای نیم فاصله بین دو واژه", SOURCE)

    assert SOURCE == before
    assert ZWNJ in SOURCE
