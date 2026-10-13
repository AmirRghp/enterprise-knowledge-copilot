"""Ollama embedding adapter.

Contract sources: ARCHITECTURE.md sections 1, 6 and 12; DATABASE.md sections 3, 5
and 7; and the retry budget in ``technical-details.md``.

Three behaviours are deliberate and load-bearing:

- ``truncate`` is always sent as ``False``. Verified against the running server,
  that makes an over-long input fail with an error, while omitting it lets Ollama
  return a trimmed vector for a silently shortened text.
- The model digest is compared against the configured value and a mismatch fails
  closed, per the index-consistency invariant in DATABASE.md section 5.
- No fallback provider exists. A failure is reported as an operational error
  rather than answered from another model or a cached vector.
"""

import math
from collections.abc import Awaitable, Callable

import httpx

from app.providers.base import (
    DOCUMENT_PREFIX,
    QUERY_PREFIX,
    EmbeddingModelChangedError,
    EmbeddingProviderError,
    EmbeddingValidationError,
)
from app.providers.retry import (
    RetryableError,
    RetryPolicy,
    arun_with_retry,
    is_retryable_status,
)

DEFAULT_PROVIDER_NAME = "ollama"
EMBED_PATH = "/api/embed"
TAGS_PATH = "/api/tags"
# Truncation is never allowed: a shortened vector would silently answer from
# content the caller never sent.
TRUNCATE = False


class OllamaEmbeddingProvider:
    """Embeds text with a local Ollama server.

    The HTTP client, retry policy, and sleep function are injected so tests drive
    the adapter deterministically without a server or real waiting.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        model: str,
        dimension: int,
        expected_digest: str | None = None,
        policy: RetryPolicy | None = None,
        provider_name: str = DEFAULT_PROVIDER_NAME,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        jitter: Callable[[], float] | None = None,
    ) -> None:
        if dimension < 0:
            raise ValueError("dimension must not be negative")
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._dimension = dimension
        self._expected_digest = expected_digest
        self._policy = policy or RetryPolicy()
        self._provider_name = provider_name
        self._sleep = sleep
        self._jitter = jitter
        self._last_digest: str | None = None

    @property
    def model(self) -> str:
        """Return the configured model tag."""
        return self._model

    @property
    def dimension(self) -> int:
        """Return the required vector dimension."""
        return self._dimension

    @property
    def provider_name(self) -> str:
        """Return the provider label persisted alongside each chunk."""
        return self._provider_name

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        """Embed document chunks, applying the document prefix.

        The returned order matches ``texts``; a provider that reordered or dropped
        an input would silently misalign vectors with their chunks.
        """
        if not texts:
            return []
        prefix = DOCUMENT_PREFIX if self._model == "nomic-embed-text-v2-moe:latest" else ""
        return await self._embed([f"{prefix}{text}" for text in texts])

    async def embed_query(self, text: str) -> list[float]:
        """Embed one search query with the query prefix."""
        if self._model == "nomic-embed-text-v2-moe:latest":
            text = f"{QUERY_PREFIX}{text}"
        elif self._model.startswith("qwen3-embedding:"):
            text = f"Instruct: Given a question, retrieve passages that answer it\nQuery: {text}"
        vectors = await self._embed([text])
        return vectors[0]

    async def model_digest(self) -> str:
        """Return the freshly reported digest for the configured model.

        The tag list is re-read on every call. Caching it would let a model be
        swapped in Ollama without a restart and the change would be accepted
        silently, mixing vectors from two models in one index, which
        DATABASE.md section 5 forbids.
        """
        payload = await arun_with_retry(
            lambda: self._request_json("GET", TAGS_PATH),
            policy=self._policy,
            jitter=self._jitter,
            sleep=self._sleep,
        )
        digest = self._digest_from(payload)

        if self._expected_digest and not digest.startswith(self._expected_digest):
            raise EmbeddingModelChangedError(
                "model digest does not match the configured expectation; "
                "the index must be rebuilt before embedding again"
            )
        self._last_digest = digest
        return digest

    @property
    def last_digest(self) -> str | None:
        """Return the most recently verified digest, or ``None`` before the first call."""
        return self._last_digest

    def _digest_from(self, payload: dict[str, object]) -> str:
        """Extract the configured model's digest from a tags payload."""
        models = payload.get("models")
        if not isinstance(models, list):
            raise EmbeddingProviderError("ollama returned no model list")

        for entry in models:
            if not isinstance(entry, dict):
                continue
            if self._matches(entry.get("name")) or self._matches(entry.get("model")):
                digest = entry.get("digest")
                if isinstance(digest, str) and digest:
                    return digest
                raise EmbeddingProviderError("ollama returned an unusable model digest")

        raise EmbeddingProviderError(
            f"model {self._model} is not available in the local ollama server"
        )

    def _matches(self, candidate: object) -> bool:
        """Compare a reported model name against the configured tag.

        Only the full tag matches. Comparing just the part before the colon would
        treat ``nomic:other`` as ``nomic:latest`` and embed with the wrong model.
        A tag with no colon is normalized to ``:latest`` on both sides, which is
        how Ollama reports an untagged model.
        """
        if not isinstance(candidate, str):
            return False
        return _normalize_tag(candidate) == _normalize_tag(self._model)

    async def _embed(self, prefixed: list[str]) -> list[list[float]]:
        """Verify the model, send one batch, and validate every vector."""
        await self.model_digest()
        payload = await arun_with_retry(
            lambda: self._request_json(
                "POST",
                EMBED_PATH,
                json={"model": self._model, "input": prefixed, "truncate": TRUNCATE},
            ),
            policy=self._policy,
            jitter=self._jitter,
            sleep=self._sleep,
        )
        return self._vectors_from(payload, expected=len(prefixed))

    def _vectors_from(self, payload: dict[str, object], *, expected: int) -> list[list[float]]:
        """Validate the response shape and every vector in it."""
        embeddings = payload.get("embeddings")
        if not isinstance(embeddings, list):
            raise EmbeddingValidationError("ollama response has no embeddings list")
        if len(embeddings) != expected:
            raise EmbeddingValidationError(
                f"expected {expected} vectors, received {len(embeddings)}"
            )

        vectors: list[list[float]] = []
        for index, raw in enumerate(embeddings):
            if not isinstance(raw, list) or not raw:
                raise EmbeddingValidationError(f"vector {index} is missing or empty")
            if self._dimension and len(raw) != self._dimension:
                raise EmbeddingValidationError(
                    f"vector {index} has dimension {len(raw)}, expected {self._dimension}"
                )
            if not self._dimension:
                self._dimension = len(raw)
            vectors.append(self._finite_vector(raw, index))
        return vectors

    def _finite_vector(self, raw: list[object], index: int) -> list[float]:
        """Coerce one vector to floats, rejecting anything not finite."""
        values: list[float] = []
        for component in raw:
            if isinstance(component, bool) or not isinstance(component, (int, float)):
                raise EmbeddingValidationError(f"vector {index} has a non-numeric value")
            number = float(component)
            if not math.isfinite(number):
                raise EmbeddingValidationError(f"vector {index} contains a non-finite value")
            values.append(number)
        return values

    async def _request_json(
        self, method: str, path: str, *, json: object | None = None
    ) -> dict[str, object]:
        """Issue one request under the retry budget and decode JSON."""
        try:
            response = await self._client.request(
                method,
                f"{self._base_url}{path}",
                json=json,
                timeout=self._policy.attempt_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise RetryableError("embedding request timed out") from error
        except httpx.TransportError as error:
            raise RetryableError("embedding transport failure") from error

        if response.status_code >= 400:
            if is_retryable_status(response.status_code):
                raise RetryableError(f"embedding provider returned {response.status_code}")
            raise EmbeddingProviderError(
                f"embedding provider returned {response.status_code}: {_safe_detail(response)}"
            )

        try:
            decoded = response.json()
        except ValueError as error:
            raise EmbeddingProviderError("embedding provider returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise EmbeddingProviderError("embedding provider returned an unexpected payload")
        return decoded


def _normalize_tag(tag: str) -> str:
    """Append ``:latest`` when a tag omits it, so both forms compare equal."""
    return tag if ":" in tag else f"{tag}:latest"


def _safe_detail(response: httpx.Response) -> str:
    """Return a short summary of an error response.

    Ollama's message is included because it explains the failure ("the input
    length exceeds the context length"), truncated in case a server echoes
    something long back.
    """
    try:
        body = response.json()
    except ValueError:
        return "no detail"
    detail = body.get("error") if isinstance(body, dict) else None
    if not isinstance(detail, str) or not detail:
        return "no detail"
    return detail[:200]


class CloudEmbeddingProvider:
    """OpenAI-style embeddings with strict response order and dimensions."""

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        model: str,
        api_key: str,
        dimension: int,
        provider_name: str,
        policy: RetryPolicy | None = None,
    ) -> None:
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._key = api_key
        self._dimension = dimension
        self._provider_name = provider_name
        self._policy = policy or RetryPolicy()
        self.last_digest = ""

    @property
    def model(self) -> str:
        return self._model

    @property
    def dimension(self) -> int:
        return self._dimension

    @property
    def provider_name(self) -> str:
        return self._provider_name

    async def model_digest(self) -> str:
        return ""

    async def embed_query(self, text: str) -> list[float]:
        return (await self._embed([text]))[0]

    async def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return await self._embed(texts) if texts else []

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        async def attempt() -> dict[str, object]:
            try:
                response = await self._client.post(
                    f"{self._base_url}/embeddings",
                    headers={"Authorization": f"Bearer {self._key}"},
                    json={"model": self._model, "input": texts, "encoding_format": "float"},
                    timeout=self._policy.attempt_timeout_seconds,
                )
            except (httpx.TimeoutException, httpx.TransportError) as error:
                raise RetryableError("embedding transport failure") from error
            if is_retryable_status(response.status_code):
                raise RetryableError("embedding provider temporarily unavailable")
            if response.status_code >= 400:
                raise EmbeddingProviderError("embedding provider rejected request")
            try:
                payload = response.json()
            except ValueError as error:
                raise EmbeddingProviderError("embedding provider returned invalid JSON") from error
            if not isinstance(payload, dict):
                raise EmbeddingProviderError("embedding provider returned an unexpected payload")
            return payload

        payload = await arun_with_retry(attempt, policy=self._policy)
        if payload.get("model") != self._model:
            raise EmbeddingValidationError("embedding provider changed the requested model")
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise EmbeddingValidationError("embedding provider returned the wrong vector count")
        values: list[list[float] | None] = [None] * len(texts)
        validator = OllamaEmbeddingProvider(
            self._client,
            base_url=self._base_url,
            model=self._model,
            dimension=self._dimension,
            expected_digest="",
        )
        for item in data:
            if not isinstance(item, dict) or type(item.get("index")) is not int:
                raise EmbeddingValidationError("embedding provider returned an invalid index")
            index = item["index"]
            raw = item.get("embedding")
            if index < 0 or index >= len(texts) or values[index] is not None:
                raise EmbeddingValidationError("embedding provider returned a repeated index")
            if not isinstance(raw, list) or not raw:
                raise EmbeddingValidationError("embedding provider returned an empty vector")
            if self._dimension and len(raw) != self._dimension:
                raise EmbeddingValidationError("embedding provider returned a different dimension")
            if not self._dimension:
                self._dimension = len(raw)
            if len(raw) != self._dimension:
                raise EmbeddingValidationError("embedding provider returned mixed dimensions")
            values[index] = validator._finite_vector(raw, index)
        if any(vector is None for vector in values):
            raise EmbeddingValidationError("embedding provider omitted a vector")
        return [vector for vector in values if vector is not None]


def build_provider(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    model: str,
    dimension: int,
    expected_digest: str | None,
    policy: RetryPolicy | None = None,
) -> OllamaEmbeddingProvider:
    """Construct the adapter from validated settings."""
    return OllamaEmbeddingProvider(
        client,
        base_url=base_url,
        model=model,
        dimension=dimension,
        expected_digest=expected_digest,
        policy=policy,
    )
