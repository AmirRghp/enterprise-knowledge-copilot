"""Provider contracts.

CODE_STYLE.md section 4 requires providers to sit behind a small replaceable
interface, so retrieval and ingestion depend on these protocols rather than on a
vendor SDK. ``technical-details.md`` fixes the two embedding entry points and the
Nomic prefixes they must apply.
"""

from typing import Protocol, runtime_checkable

# ARCHITECTURE.md section 1 and DATABASE.md section 3: document text and queries
# are embedded with distinct prefixes because the model was trained on both forms.
DOCUMENT_PREFIX = "search_document: "
QUERY_PREFIX = "search_query: "


class EmbeddingValidationError(ValueError):
    """Raised when a provider returns a vector that cannot be trusted.

    Covers a wrong dimension, a missing or empty vector, and non-finite values.
    DATABASE.md section 7 requires each of these to be rejected rather than
    stored, so a bad vector can never reach the pgvector column.
    """


class EmbeddingProviderError(RuntimeError):
    """Raised when the provider could not be reached or refused the request."""


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Turns text into fixed-dimension vectors.

    The methods are coroutines because the adapter is an async HTTP client; a
    synchronous signature here would not match the implementation and would let a
    caller ``await`` nothing.
    """

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed document chunks with the document prefix."""
        ...

    async def embed_query(self, text: str) -> list[float]:
        """Embed a search query with the query prefix."""
        ...
