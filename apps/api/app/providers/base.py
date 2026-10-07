"""Provider contracts.

CODE_STYLE.md section 4 requires providers to sit behind a small replaceable
interface, so retrieval and ingestion depend on these protocols rather than on a
vendor SDK. ``technical-details.md`` fixes the two embedding entry points and the
Nomic prefixes they must apply.

The rerank contracts live here too. ``ScoredCandidate`` and ``ProviderUsage`` are
domain values rather than adapter details: the first is what a reranker returns and
retrieval consumes, and the second is what every provider reports and evaluation
records. Keeping them beside the protocols means a caller never has to import an
adapter to name what it received.
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol, runtime_checkable
from uuid import UUID

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


class EmbeddingModelChangedError(EmbeddingProviderError):
    """The live model digest no longer matches the one pinned in configuration.

    Separate from the parent so ingestion can classify it without matching on
    message text: DATABASE.md section 5 treats a digest change as needing a full
    index rebuild, which no number of retries can achieve, so the job must fail
    permanently and wait for an operator.
    """


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


class VectorProvider(EmbeddingProvider, Protocol):
    """An embedding provider that also reports its own identity.

    The identity travels into every chunk row so a later query can fail closed on
    a mixed or stale index (DATABASE.md section 5). It lives here rather than beside
    either caller because **both** callers need it and neither should define it:
    ingestion persists it, and retrieval must match the index it is about to rank
    against the provider that produced the query vector.
    """

    @property
    def provider_name(self) -> str:
        """The provider label persisted alongside each vector."""
        ...

    @property
    def model(self) -> str:
        """The model tag persisted alongside each vector."""
        ...

    @property
    def dimension(self) -> int:
        """The vector dimension persisted alongside each vector."""
        ...

    @property
    def last_digest(self) -> str | None:
        """The digest verified by the most recent embed, or ``None`` before it."""
        ...


@dataclass(frozen=True)
class RerankCandidate:
    """One chunk offered for reranking: the text to send, the id to get back.

    The two travel together because the request needs the text while the response is
    matched by position. Splitting them into two parallel lists would let a caller send
    one chunk's text and believe the score belongs to another, and that mistake would be
    invisible in the result.
    """

    chunk_id: UUID
    text: str

    def __repr__(self) -> str:
        # The text is deliberately absent: a repr carrying document text would put it in
        # a traceback and in every test failure message.
        return f"RerankCandidate(chunk_id={self.chunk_id})"


@dataclass(frozen=True)
class ScoredCandidate:
    """One chunk the reranker scored, identified by the caller's own chunk id.

    ``chunk_id`` is the identity the caller supplied, carried back unchanged. The
    provider also echoes the document it scored, but that echo is not trusted: a model
    that paraphrased or reformatted the text would otherwise decide which chunk a score
    belongs to, and the score would attach to text nobody asked about. Only the
    position is authoritative.
    """

    chunk_id: UUID
    score: float


@dataclass(frozen=True)
class ProviderUsage:
    """What one provider call cost and how it was billed.

    Every field is optional because providers report different things, and because a
    field that is absent is genuinely *unknown*. Reporting an absent field as ``0``
    would fabricate a measurement: a zero cost reads as "this was free", which is a
    claim about money that nobody made. ``technical-details.md`` subject 1 requires
    ``billed_units`` to record "not reported" as such rather than as a number.
    """

    provider: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None
    #: The provider's own units, e.g. ``{"search_units": 1}``. Absent keys stay absent
    #: rather than becoming zero, so an empty dict means "nothing was reported", not
    #: "nothing was used".
    billed_units: dict[str, int | float | str] | None = None
    tariff: dict[str, Decimal] | None = None
    cost: Decimal | None = None
    currency: str | None = None


@runtime_checkable
class RerankProvider(Protocol):
    """Reorders candidates by their relevance to a query.

    The provider sees the query and the candidate texts and returns only scores and
    identities. It never returns text, so a caller cannot mistake a provider's rendering
    of a document for the document itself.
    """

    @property
    def provider_name(self) -> str:
        """The provider label, recorded in usage."""
        ...

    @property
    def model(self) -> str:
        """The model tag actually used, recorded in usage and in the run artifact."""
        ...

    async def rerank(
        self,
        query: str,
        candidates: list[RerankCandidate],
        *,
        top_n: int,
        refresh: Callable[[], Awaitable[list[RerankCandidate]]] | None = None,
    ) -> list[ScoredCandidate]:
        """Return the ``top_n`` best candidates, best first.

        ``refresh``, when given, is awaited **once per attempt** and its result replaces
        the candidates for that attempt. It exists so a caller can re-read and re-check
        authorization between a failure and a retry: a prepared body would otherwise be
        re-sent verbatim, transmitting text the caller may no longer be allowed to send.
        An implementation that retries must rebuild from ``refresh`` on every attempt,
        and must fail closed if the refreshed set no longer matches what ``top_n`` was
        derived from.

        Raises rather than returning a partial list: a missing, repeated or invalid
        result is a contract violation, and silently dropping the affected chunk would
        change what the caller serves without saying so.
        """
        ...

    @property
    def last_usage(self) -> ProviderUsage | None:
        """Usage of the most recent call, or ``None`` before any has happened."""
        ...
