"""OpenRouter rerank adapter.

Reranking is **optional and off by default** (ARCHITECTURE.md section 6). When
``RERANK_ENABLED`` is false nothing here is constructed and nothing is sent, so the
disabled path costs zero provider calls rather than one that returns after a request.

**What leaves the process.** A rerank call sends the user's question and the text of
the candidate chunks to OpenRouter. That is the first time this project sends
document content to an external service, and it is why the default is off. Only the
project's synthetic, non-personal corpus is permitted on the free endpoint; real or
personal data needs a privacy review first (SECURITY.md section 2).

**What never leaves the process.** Neither the question nor any chunk text is logged,
returned in a report, or placed in an error message. The adapter's errors carry a
status code and a bounded provider detail; every caller that reports a failure to a
human prints a fixed line instead, for the same reason Part 11's report prints no
document text.

**Trust.** The response is trusted for ``index``, ``relevance_score`` and ``usage``,
and for nothing else. The echoed ``document`` is deliberately ignored: if it were
authoritative, a provider that reformatted the text would decide which chunk a score
attaches to. ``index`` is validated defensively because the published schema types it
as a plain integer with no stated bounds.
"""

import math
from collections.abc import Awaitable, Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any, Final

import httpx

from app.providers.base import (
    ProviderUsage,
    RerankCandidate,
    ScoredCandidate,
)
from app.providers.retry import (
    RetryableError,
    RetryPolicy,
    arun_with_retry,
    is_retryable_status,
)
from app.settings import Settings

RERANK_PATH = "/rerank"
DEFAULT_PROVIDER_NAME: Final = "openrouter"

#: ``technical-details.md`` subject 5: rerank gets at most two attempts of at most ten
#: seconds each, which is exactly ``RetryPolicy``'s default. The budget is passed in
#: rather than hard-coded here so one figure reaches both the HTTP client and the
#: per-attempt deadline; passing the policy's default instead would leave the two
#: disagreeing, which is the bug Part 8's review found in the worker's wiring.
DEFAULT_RERANK_POLICY: Final = RetryPolicy(attempts=2, attempt_timeout_seconds=10.0)

#: A provider detail is kept only to say which class of failure occurred. It is
#: truncated because a gateway may echo the request body, which is the question.
_MAX_DETAIL = 200


class RerankProviderError(RuntimeError):
    """The rerank provider could not be reached or refused the request."""


class RerankResponseError(RerankProviderError):
    """The provider answered with a payload this adapter cannot validate.

    Separate from the parent so a caller can tell "the call failed" from "the answer is
    not trustworthy" without matching on message text. A response that cannot be
    validated fails closed: accepting a partial or reordered list would silently change
    which chunk the caller serves, with no way for the caller to notice.
    """


class OpenRouterRerankProvider:
    """Reranks candidates through ``POST /api/v1/rerank``.

    The client and retry policy are injected so tests drive this deterministically
    without a network or real waiting, matching the embedding adapter's shape.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        model: str,
        api_key: str,
        policy: RetryPolicy | None = None,
        provider_name: str = DEFAULT_PROVIDER_NAME,
    ) -> None:
        if not api_key:
            # Refused at construction rather than at the first request, so a
            # misconfigured deployment fails while it is being set up instead of during
            # a user's question. An empty key is never worth a round trip to discover.
            raise RerankProviderError("the rerank provider needs an API key")
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._api_key = api_key
        self._policy = policy or DEFAULT_RERANK_POLICY
        self._provider_name = provider_name
        self._usage: ProviderUsage | None = None

    @property
    def provider_name(self) -> str:
        return self._provider_name

    @property
    def model(self) -> str:
        return self._model

    @property
    def last_usage(self) -> ProviderUsage | None:
        return self._usage

    async def rerank(
        self,
        query: str,
        candidates: Sequence[RerankCandidate],
        *,
        top_n: int,
        refresh: Callable[[], Awaitable[list[RerankCandidate]]] | None = None,
    ) -> list[ScoredCandidate]:
        """Return the ``top_n`` best candidates, best first.

        ``candidates`` is ordered, and that order is the meaning of every ``index`` the
        provider returns. The mapping back to chunk ids happens here, so no other layer
        has to reason about positions.
        """
        if not candidates:
            raise ValueError("rerank needs at least one candidate")
        if top_n < 1:
            raise ValueError("top_n must be at least 1")

        # Never ask for more than was sent: a provider answering with an index outside
        # the list it was given would be reporting a result for a document it never saw.
        requested = min(top_n, len(candidates))
        self._usage = None

        async def operation() -> tuple[dict[str, Any], list[RerankCandidate], int]:
            """One attempt, built now rather than replayed.

            ``arun_with_retry`` calls this per attempt, so the candidate list and the
            request body are rebuilt every time. A body prepared in front of the loop
            would be re-sent verbatim by the second attempt: if authorization was
            revoked, the document deleted or the revision replaced during the backoff,
            the retry would transmit text the caller is no longer allowed to send.
            Rebuilding per attempt is what makes "re-check before every send" hold for
            retries and not only for the first try.

            The list and the effective ``top_n`` **travel back with the payload**,
            because an ``index`` in the response means a position in the list this
            attempt actually sent. Returning only the payload left the caller mapping
            against the original ``candidates``: a retry that rebuilt a different list
            in a different order scored the wrong chunk, and a retry that sent fewer
            documents was checked against the wrong expected count.
            """
            current = await refresh() if refresh is not None else list(candidates)
            # The guard is on the refreshed list, not on the callable: testing the
            # callable would always be truthy and would let an empty refresh through,
            # which is the one case the refresh exists to catch. Refusing here rather
            # than sending a shorter list matters because the response is validated
            # against the count that was actually sent.
            #
            # This is not a retryable failure, so ``arun_with_retry`` re-raises it at
            # once: there is nothing to gain from asking again.
            if not current:
                raise RerankResponseError("no candidate remained to rerank on this attempt")
            effective = min(requested, len(current))
            payload = await self._post(self._body(query, current, effective))
            return payload, current, effective

        try:
            payload, sent, effective = await arun_with_retry(operation, policy=self._policy)
        except RetryableError as error:
            # ``arun_with_retry`` re-raises the last transient error once the budget is
            # spent, which suits the embedding adapter because its caller classifies
            # failures itself. A rerank call has no such caller, so the transient error
            # is converted here into the type this adapter's callers already handle.
            # Converting it is not a fallback: the ranking is still refused, it just
            # carries a name the caller can act on.
            raise RerankProviderError(
                f"rerank provider did not answer within {self._policy.attempts} attempts"
            ) from error
        scored = _map_results(payload.get("results"), sent, effective)
        self._usage = _usage_from(payload.get("usage"), self._provider_name, self._model)
        return scored

    def _body(
        self, query: str, candidates: Sequence[RerankCandidate], requested: int
    ) -> dict[str, Any]:
        """Build one request body. Called per attempt, never cached."""
        return {
            "model": self._model,
            "query": query,
            "documents": [candidate.text for candidate in candidates],
            "top_n": requested,
        }

    async def _post(self, body: Mapping[str, Any]) -> dict[str, Any]:
        """One attempt: send the request and return the decoded body."""
        try:
            response = await self._client.request(
                "POST",
                f"{self._base_url}{RERANK_PATH}",
                json=body,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                timeout=self._policy.attempt_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise RetryableError("rerank request timed out") from error
        except httpx.TransportError as error:
            raise RetryableError("rerank transport failure") from error

        if response.status_code >= 400:
            if is_retryable_status(response.status_code):
                raise RetryableError(f"rerank provider returned {response.status_code}")
            raise RerankProviderError(
                f"rerank provider returned {response.status_code}: {_safe_detail(response)}"
            )

        try:
            decoded = response.json()
        except ValueError as error:
            raise RerankResponseError("rerank provider returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise RerankResponseError("rerank provider returned an unexpected payload")
        return decoded


def _map_results(
    raw: object, candidates: Sequence[RerankCandidate], expected: int
) -> list[ScoredCandidate]:
    """Turn results into scored candidates, or refuse the whole answer.

    Five things are checked, and each guards a way this has gone wrong in practice:

    * **count.** Exactly as many results as were requested. Fewer means the provider
      dropped something; more means it invented something. Neither is acceptable, and
      the comparison is against the *effective* request size, not a constant 20, so a
      five-candidate call is held to five.
    * **index type.** ``type(value) is int``, never ``isinstance``. JSON ``true``
      decodes to ``bool``, and ``bool`` is a subclass of ``int``, so an ``isinstance``
      check would accept ``true`` as index ``1`` and attach a real score to the wrong
      chunk.
    * **index range.** Inside the sent list. The published schema gives ``index`` no
      stated bounds, so this is defensive rather than contractual.
    * **index uniqueness.** A repeat would score one chunk twice and no other at all.
    * **score finiteness.** ``NaN`` and the infinities cannot be ordered, so sorting
      them produces a quietly wrong ranking rather than an error.

    The echoed ``document`` is not inspected. Only the position is trusted.
    """
    if not isinstance(raw, list):
        raise RerankResponseError("rerank response carried no results list")
    results = [item for item in raw if isinstance(item, dict)]
    if len(results) != len(raw):
        raise RerankResponseError("rerank results contained a non-object entry")
    if len(results) != expected:
        raise RerankResponseError(
            f"rerank provider returned {len(results)} results for {expected} requested"
        )

    scored: list[ScoredCandidate] = []
    seen: set[int] = set()
    for item in results:
        index = item.get("index")
        if type(index) is not int:
            raise RerankResponseError("rerank result index was not an integer")
        if not 0 <= index < len(candidates):
            raise RerankResponseError("rerank result index was outside the request")
        if index in seen:
            raise RerankResponseError("rerank result repeated an index")
        seen.add(index)

        raw_score = item.get("relevance_score")
        if isinstance(raw_score, bool) or not isinstance(raw_score, (int, float)):
            raise RerankResponseError("rerank result score was not a number")
        # A JSON integer may be arbitrarily long, and ``float(10**400)`` raises
        # OverflowError rather than returning infinity. Left uncaught that is an
        # untyped exception a caller classifies nothing against, so it would surface as
        # a traceback instead of a safe failure. Converting to a float inside a guard
        # keeps the value out of the ranking either way.
        try:
            score = float(raw_score)
        except OverflowError as error:
            raise RerankResponseError("rerank result score was out of range") from error
        if not math.isfinite(score):
            raise RerankResponseError("rerank result score was not finite")

        scored.append(ScoredCandidate(chunk_id=candidates[index].chunk_id, score=score))
    return scored


def _usage_from(raw: object, provider: str, model: str) -> ProviderUsage:
    """Record what the provider said it cost, leaving anything absent unknown.

    Absence is reported as absence. A ``0`` would read as "this was free", which is a
    claim about money that the provider never made, and ``technical-details.md``
    subject 1 requires unreported figures to be recorded as such. A ``cost`` of zero
    that the provider genuinely reported is kept; only a missing one stays ``None``.
    """
    usage = raw if isinstance(raw, dict) else {}

    billed: dict[str, int | float | str] = {}
    for key in ("search_units", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        billed[key] = value

    raw_cost = usage.get("cost")
    cost: Decimal | None = None
    if isinstance(raw_cost, (int, float)) and not isinstance(raw_cost, bool):
        # Same overflow hazard as a score: a huge JSON integer cannot become a float.
        # An unusable cost is reported as unknown rather than raising, because usage is
        # metadata and a missing figure is already a state this function handles.
        try:
            within_range = math.isfinite(float(raw_cost))
        except OverflowError:
            within_range = False
        if within_range:
            cost = Decimal(str(raw_cost))

    return ProviderUsage(
        provider=provider,
        model=model,
        billed_units=billed or None,
        cost=cost,
        currency="credits" if cost is not None else None,
    )


def _safe_detail(response: httpx.Response) -> str:
    """Return a short summary of an error response, truncated.

    A gateway may echo the request body in its error, and the request body is the
    question and the chunk texts. The truncation bounds it; the guarantee that nothing
    sensitive is ever printed from an error path is enforced by the callers, which
    report a fixed line rather than this string.
    """
    try:
        body = response.json()
    except ValueError:
        return "no detail"
    detail = body.get("error") if isinstance(body, dict) else None
    if isinstance(detail, dict):
        detail = detail.get("message")
    if not isinstance(detail, str) or not detail:
        return "no detail"
    return detail[:_MAX_DETAIL]


def build_rerank_provider(
    settings: Settings,
    *,
    client: httpx.AsyncClient,
    policy: RetryPolicy | None = None,
) -> OpenRouterRerankProvider:
    """Assemble the adapter from configuration.

    The model and base URL both come from settings, so the deployed model is a
    configuration value and never a constant in the code. ``RERANK_ENABLED`` is not
    consulted here on purpose: the caller decides whether a reranker exists at all, and
    a factory that quietly returned ``None`` would make "disabled" and "misbuilt" the
    same observable outcome.
    """
    return OpenRouterRerankProvider(
        client,
        base_url=str(settings.openrouter_base_url),
        model=settings.openrouter_rerank_model,
        api_key=settings.openrouter_api_key.get_secret_value(),
        policy=policy,
    )
