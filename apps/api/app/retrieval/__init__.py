"""Authorized retrieval: BM25, vector search, and rank fusion.

ARCHITECTURE.md section 6 fixes the order: the allowlist of active, current,
ready, permitted documents is built first, both search paths run inside it, and
their results are fused with RRF. Nothing in this package writes.
"""

from app.retrieval.contracts import RetrievalConfig, RetrievalHit, SourceRef
from app.retrieval.service import retrieve

__all__ = ["RetrievalConfig", "RetrievalHit", "SourceRef", "retrieve"]
