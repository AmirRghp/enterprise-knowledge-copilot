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

from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Final, Literal, Protocol, runtime_checkable
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
    #: How many provider calls this usage covers. A number above one means some attempts
    #: were not represented by a single answer - a retry after a transient failure, or a
    #: repair after an unusable one - and their figures are included in the totals.
    #: ``None`` when the caller does not report it.
    attempts: int | None = None
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


# The generation contracts. ``technical-details.md`` subject 6 fixes the shape of the
# value a generator returns, and the boundary it must respect: the free-text ``answer``
# is carried so an operator can see what the model produced, and it is **never** shown
# to a user. Part 14 composes the served text from validated claims instead, so nothing
# in this module treats ``answer`` as something to present.


#: Why the generator could not answer from the evidence it was given. A closed set on
#: purpose: the composed refusal text is a fixed neutral sentence per value, so a value
#: that is not listed here could not be given a sentence at all.
MissingPart = Literal["insufficient_evidence", "ambiguous", "conflict"]

MISSING_PARTS: Final[tuple[MissingPart, ...]] = (
    "insufficient_evidence",
    "ambiguous",
    "conflict",
)

#: The same three names as a lookup, so a caller validating a provider's answer can turn
#: a wire string into the Literal without a cast.
MISSING_PARTS_BY_NAME: Final[Mapping[str, MissingPart]] = {name: name for name in MISSING_PARTS}


@dataclass(frozen=True, slots=True)
class EvidenceItem:
    """One authorized passage, and the handle a claim may cite it by.

    The model is given the text and the ``evidence_id`` and nothing else: no document
    id, no section id, no revision. A claim therefore cannot invent a citation, because
    it can only echo a handle it was given, and Part 14 resolves that handle to a
    ``SourceRef`` **after** re-checking authorization. Putting the citation in the
    model's hands would mean trusting it to name a document it was allowed to read.
    """

    evidence_id: str
    text: str


@dataclass(frozen=True, slots=True)
class Claim:
    """One assertion, the evidence it rests on, and the span it rests on.

    ``quote`` is stored verbatim and unchecked. Whether that span actually appears in the
    cited ``EvidenceItem`` is a question about the corpus, not about the provider, so it
    belongs to Part 14's validation rather than here: this adapter can confirm the
    handle was one it sent, and nothing more.
    """

    text: str
    evidence_id: str
    quote: str


@dataclass(frozen=True, slots=True)
class GenerationResult:
    """What one generation produced, before any of it is believed.

    Every field is the model's claim to its own output. ``claims`` is accepted as a list
    of shapes, ``abstained`` and ``missing_parts`` as flags; none of it has been checked
    against the corpus, and a caller that presents any of it without validating first is
    presenting a model's assertion as a fact.
    """

    claims: list[Claim]
    abstained: bool
    missing_parts: list[MissingPart]
    #: The model's own prose, if it wrote any. Never shown to a user: Part 14 builds the
    #: served text from validated claims. ``None`` when the model left it empty.
    answer: str | None


@runtime_checkable
class GenerationProvider(Protocol):
    """Turns a question and authorized evidence into claims.

    This is the second stage that sends document text outside the process, after
    reranking. It sees the question and the evidence texts and returns claims that
    reference evidence by handle; it never returns a citation, so a provider cannot
    point a user at a document the caller was not allowed to read.
    """

    @property
    def provider_name(self) -> str:
        """The provider label reported alongside usage."""
        ...

    @property
    def model(self) -> str:
        """The model slug that produced the answer."""
        ...

    async def generate(
        self,
        *,
        question: str,
        evidence: Sequence[EvidenceItem],
        refresh: Callable[[], Awaitable[list[EvidenceItem]]] | None = None,
    ) -> GenerationResult:
        """Return claims, abstention flags and usage for this question and evidence.

        ``refresh`` re-reads the authorized evidence and must be called before **every**
        attempt, retries and repairs included. It is the caller's authorization gate
        passed in rather than constructed here, because the adapter is the only component
        that knows when an attempt is about to happen.

        It is optional so a caller with nothing to re-gate - the preflight, which sends
        synthetic passages - is not made to invent a hook. A caller that has one must pass
        it: an implementation that ignores ``refresh`` and sends the evidence it was
        given would replay an earlier attempt's text after an access change landed during
        a backoff.

        Raises rather than returning a partial result. A missing, mis-typed or unknown
        claim is a contract violation, and silently dropping it would let a caller
        believe the remaining claims were the whole answer.
        """
        ...

    @property
    def last_usage(self) -> ProviderUsage | None:
        """Usage of the most recent call, or ``None`` before any has happened."""
        ...
