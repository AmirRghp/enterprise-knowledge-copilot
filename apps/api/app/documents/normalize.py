"""Persian search-text normalization.

ARCHITECTURE.md section 6 requires normalization for retrieval to run on a derived
field only. ``source_text`` and ``chunk_text`` stay byte-identical to the upload
so that a citation quote can be matched exactly; this module never rewrites them.
"""

import re
import unicodedata

# Arabic yeh -> Persian yeh, Arabic kaf -> Persian keheh.
_ARABIC_TO_PERSIAN = str.maketrans({"ي": "ی", "ك": "ک", "ى": "ی"})

# Arabic-Indic and Eastern Arabic-Indic digits -> ASCII.
_DIGIT_MAP = {ord(c): str(i) for i, c in enumerate("٠١٢٣٤٥٦٧٨٩")}
_DIGIT_MAP.update({ord(c): str(i) for i, c in enumerate("۰۱۲۳۴۵۶۷۸۹")})

# Zero-width and directional marks carry no meaning for matching but would
# otherwise split otherwise identical search terms.
# Directional marks and the BOM carry no meaning for matching. The ASCII
# hyphen is intentionally excluded: document identifiers such as "HR-001"
# are citation keys, and stripping the hyphen would merge distinct ones.
_INVISIBLE = re.compile(r"[‏‪-‮⁦-⁩﻿]")

# Whitespace variants, including the Persian ZWNJ used as a word joiner.
_ZERO_WIDTH_SPACE = "‌"
# Hyphen and dash characters are deliberately NOT treated as whitespace:
# document identifiers such as "HR-001" are citation keys and must survive.
_WHITESPACE_RUN = re.compile(r"[ \t\r\n\f\v  -   　]+")


def normalize_for_search(text: str) -> str:
    """Return a derived, match-friendly form of ``text``.

    The mapping is idempotent: normalizing an already-normalized string returns
    the same value, which is what makes the derived ``search_text`` column safe
    to recompute.
    """
    normalized = unicodedata.normalize("NFC", text)
    normalized = normalized.translate(_ARABIC_TO_PERSIAN)
    normalized = normalized.translate(_DIGIT_MAP)
    normalized = _INVISIBLE.sub("", normalized)
    # ZWNJ becomes a plain space so "نیم‌فاصله" and "نیم فاصله" match each other.
    normalized = normalized.replace(_ZERO_WIDTH_SPACE, " ")
    normalized = _WHITESPACE_RUN.sub(" ", normalized)
    return normalized.strip()
