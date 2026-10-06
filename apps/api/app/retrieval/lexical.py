"""BM25 over the eligible chunks, in memory, per request.

ARCHITECTURE.md section 6 fixes this design: ``rank_bm25`` scores the same chunks
the vector path searches, so the two paths can only ever disagree about ranking,
never about membership.

Two properties matter and are easy to get wrong:

* **The derived text, never the source.** Scores are computed over
  ``search_text``, which Part 6 already normalized when it was stored. Retrieval
  normalizes the question the same way and compares the two forms. ``chunk_text``
  is never passed to the tokenizer, so nothing here can alter a quotable string.
* **An empty domain is not an error.** A question asked with nothing searchable
  returns no lexical candidates rather than raising, and neither does a domain
  where every chunk normalized to no tokens.
"""

from app.documents.normalize import normalize_for_search
from app.retrieval.store import EligibleChunk


def tokenize(text: str) -> list[str]:
    """Split already-normalized search text into terms.

    Whitespace splitting, not stemming: the corpus is Persian, and a stemmer that
    was not built for Persian would quietly merge terms that are not the same.
    Part 6's normalizer already maps the Arabic yeh/kaf variants and folds ZWNJ to
    a space, so a ZWNJ-joined compound and its spaced form arrive here as equal.
    """
    return [term for term in normalize_for_search(text).split() if term]


def lexical_ranking(
    chunks: list[EligibleChunk], question: str, *, top_k: int
) -> list[tuple[str, int]]:
    """Return ``(chunk_id, one-based rank)`` for the best lexical matches.

    "Matched" is decided by **token overlap**, never by the score's sign.
    ``rank_bm25``'s ``BM25Okapi`` floors a negative IDF at a fraction of the corpus's
    *average* IDF, and on a small corpus where a term appears in every document the
    average is negative too - so a chunk that matches perfectly scores negative.
    A ``score > 0`` test would then return nothing at all for a query that matches
    everywhere, which is the worst failure a search path can have. Overlap is exact
    and does not depend on the library's arithmetic.
    """
    # rank_bm25 ships no py.typed marker; the only thing used is BM25Okapi's
    # ``get_scores``, whose contract is checked by the tests around it.
    from rank_bm25 import BM25Okapi  # type: ignore[import-untyped]

    terms = set(tokenize(question))
    if not terms or not chunks:
        return []

    corpus = [tokenize(chunk.chunk_text) for chunk in chunks]
    if not any(corpus):
        # Every chunk normalized to nothing; BM25 would divide by a zero average.
        return []

    scores = BM25Okapi(corpus).get_scores(sorted(terms))
    # A chunk sharing no term with the question is not a weak match, it is no match.
    matched = [index for index, chunk_terms in enumerate(corpus) if terms.intersection(chunk_terms)]
    ranked = sorted(matched, key=lambda index: (-scores[index], chunks[index].chunk_id))
    return [
        (str(chunks[index].chunk_id), rank) for rank, index in enumerate(ranked[:top_k], start=1)
    ]
