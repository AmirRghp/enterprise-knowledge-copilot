"""Structured generation through OpenRouter chat completions.

Source: https://openrouter.ai/docs/guides/features/structured-outputs
Source: https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
Source: https://openrouter.ai/docs/api_reference/errors-and-debugging
Source: https://openrouter.ai/docs/guides/routing/provider-selection

Three facts from those pages shape this module, and each one has a trap behind it.

**The schema is requested, not promised.** ``response_format`` with
``type: "json_schema"`` is a request. OpenRouter documents that a parameter a provider
does not support is *ignored* rather than refused, and that if no endpoint of the model
supports it the request is still routed with the parameter dropped. An ignored
``response_format`` returns fluent prose that happens to contain braces, which parses as
nothing useful and looks like a schema violation rather than a silent downgrade. So the
request sets ``provider.require_parameters: true``, which is documented to make an
unsupported parameter disqualify the endpoint instead of being dropped. That is the
whole difference between a guarantee and a hope.

**That same setting makes the parameter list a correctness concern.** Every parameter
sent must be supported by the chosen endpoint, or the request stops being routable at
all. The adapter sends ``model``, ``messages``, ``response_format``, ``provider`` and
``stream``, plus the panel's configured ``temperature`` and token ceiling. OpenRouter
must support these parameters; an incompatible endpoint is refused rather than silently
dropping the manager's setting. ``stream: false`` is explicit.

**A 200 does not mean success.** The error reference states that a non-streaming
request can receive ``200 OK`` whose body holds only an ``error`` object and no
``choices``, and that ``finish_reason`` may be ``error``, ``length`` or
``content_filter``. Reading ``choices[0]`` without looking would raise an untyped
``IndexError`` on a provider failure. Every one of those is refused here with a typed
error, and ``length`` is deliberately **not** retried: the same page states that a
truncated generation is fixed by raising ``max_tokens``, not by asking again.

The document text in the evidence is untrusted input, so the prompt states that it is
data rather than instruction. That is a boundary declaration, not a defence: a model
that follows an instruction embedded in the evidence is still wrong, and Part 14 is what
refuses such a claim by checking the quote against the authorized text.
"""

from __future__ import annotations

import asyncio
import json
import random
from collections.abc import Awaitable, Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any, Final

import httpx

from app.providers.base import (
    MISSING_PARTS,
    MISSING_PARTS_BY_NAME,
    Claim,
    ConversationTurn,
    EvidenceItem,
    GenerationProvider,
    GenerationResult,
    MissingPart,
    ProviderUsage,
)
from app.providers.retry import RetryableError, RetryPolicy, is_retryable_status
from app.settings import Settings
from app.system_prompts import DEFAULT_SYSTEM_PROMPT

GENERATION_PATH: Final = "/chat/completions"
DEFAULT_PROVIDER_NAME: Final = "openrouter"

#: ``technical-details.md`` subject 6: two attempts of thirty seconds each, shared by
#: the network retry and the single repair. Raising the attempt count here would let the
#: budget double without anyone deciding to double it.
DEFAULT_GENERATION_POLICY: Final = RetryPolicy(attempts=2, attempt_timeout_seconds=30.0)

#: The schema every attempt is sent with. Strict mode needs the closing braces
#: ``strict: true`` relies on: every property listed in ``required`` and
#: ``additionalProperties: false``, because a provider enforcing the schema cannot invent
#: a field or omit one and strict mode means what it says. ``answer`` is required but
#: may be the empty string, which is how the model declines to write prose; only a
#: nullable type would avoid that and the published schema does not document one.
GENERATION_SCHEMA: Final[Mapping[str, Any]] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["claims", "abstained", "missing_parts", "answer"],
    "properties": {
        "claims": {
            "type": "array",
            "description": "Assertions supported by the evidence, or empty when abstaining.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["evidence_id", "quote", "text"],
                "properties": {
                    "evidence_id": {
                        "type": "string",
                        "description": "The exact id of the evidence item this rests on.",
                    },
                    "quote": {
                        "type": "string",
                        "description": "A verbatim span of that evidence item.",
                    },
                    "text": {
                        "type": "string",
                        "description": "The assertion itself, in Persian.",
                    },
                },
            },
        },
        "abstained": {
            "type": "boolean",
            "description": "True when the evidence does not support a complete answer.",
        },
        "missing_parts": {
            "type": "array",
            "description": "Why the answer is incomplete. Empty when it is not.",
            "items": {"type": "string", "enum": list(MISSING_PARTS)},
        },
        "answer": {
            "type": "string",
            "description": "Prose summary, or the empty string when there is nothing to say.",
        },
    },
}

_SYSTEM_PROMPT: Final = DEFAULT_SYSTEM_PROMPT


class GenerationProviderError(RuntimeError):
    """Raised when the provider refused the request or could not be reached.

    A refusal that is permanent - bad credentials, a blocked request, a model that
    cannot serve it - is not retried, because no number of attempts changes it.
    """


class GenerationResponseError(GenerationProviderError):
    """Raised when the provider answered with something that cannot be used.

    Separated from the parent so a caller can tell "the model declined" from "the model
    answered and the answer is unusable". Only the second is worth a single repair, and
    only within the same attempt budget.
    """


class GenerationReferenceError(GenerationResponseError):
    """An invented evidence handle is not a recoverable transport failure."""


class GenerationEvidenceError(GenerationProviderError):
    """Raised when no authorized evidence is left to generate from.

    Not a provider failure and not a response problem: **nothing was sent**. The caller's
    evidence disappeared between two authorization checks - a narrowing, a deletion, a
    replacement - so there is no answer to judge and no schema anyone ignored.

    It gets its own type for two reasons, both of them about what a caller would tell an
    operator. Reporting it as ``GenerationResponseError`` made the commands say the
    provider had broken its schema, which is false and sends somebody hunting for an
    endpoint problem. And it must not be repairable: a repair asks the model to try again
    with evidence the caller is no longer allowed to send, so it would spend an attempt
    to reach the same refusal.
    """


class GenerationRefusalError(GenerationResponseError):
    """An explicit policy refusal must not be routed to another model."""


#: Fixed words for the refusal conditions this adapter can recognise. An operator who
#: sees "the provider could not answer" goes looking for an outage; one who sees "the
#: daily free-tier quota is exhausted" knows to wait until midnight. Phrased here rather
#: than echoed from the provider, because the provider's own wording can quote the
#: request, and this way the wording is ours.
DAILY_QUOTA_REFUSAL: Final = "the daily free-tier quota is exhausted"
RATE_LIMITED_REFUSAL: Final = "the provider is rate limiting this account"


def _error_of(body: object) -> object:
    """The ``error`` object inside a decoded body, or the body itself.

    The metadata lives one level down: a real 429 body carries
    ``{"error": {"message": ..., "metadata": {"limit_source": ...}}}``, so looking for
    ``metadata`` on the body itself finds nothing and every quota exhaustion would be
    reported as an ordinary rate limit.
    """
    if isinstance(body, dict):
        inner = body.get("error")
        if isinstance(inner, dict):
            return inner
    return body


def _refusal_of(embedded: object, status: int) -> str | None:
    """Name the refusal when it is one this adapter can recognise, else ``None``.

    Measured, not assumed: this project's free generation endpoint answers ``429`` with
    ``metadata.limit_source`` of ``openrouter_free_tier_daily`` and a limit of fifty
    requests per day, which ``technical-details.md`` had recorded as unmeasured and
    assumed absent. The distinction is only reported for ``429``; anything else is the
    provider's business rather than this adapter's.
    """
    if status != 429:
        return None
    source: object = None
    if isinstance(embedded, dict):
        metadata = embedded.get("metadata")
        if isinstance(metadata, dict):
            source = metadata.get("limit_source")
    if source == "openrouter_free_tier_daily":
        return DAILY_QUOTA_REFUSAL
    return RATE_LIMITED_REFUSAL


class OpenRouterGenerationProvider:
    """Generates claims from authorized evidence, with the schema enforced upstream.

    Instances are cheap: one per call site, holding the injected client. ``last_usage``
    belongs to the most recent call, which mirrors the rerank adapter and keeps the
    report the same shape for both.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        base_url: str,
        model: str,
        api_key: str,
        policy: RetryPolicy | None = None,
        max_tokens: int | None = None,
        provider_name: str = DEFAULT_PROVIDER_NAME,
        temperature: float | None = None,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
    ) -> None:
        self._client = client
        self._base_url = base_url
        self._model = model
        self._api_key = api_key
        self._policy = policy or DEFAULT_GENERATION_POLICY
        self._max_tokens = max_tokens
        self._provider_name = provider_name
        self._temperature = temperature
        self.system_prompt = system_prompt
        self._usage: ProviderUsage | None = None
        self._refusal: str | None = None

    @property
    def provider_name(self) -> str:
        return self._provider_name

    @property
    def model(self) -> str:
        return self._model

    @property
    def last_usage(self) -> ProviderUsage | None:
        return self._usage

    @property
    def last_refusal(self) -> str | None:
        """Name the refusal behind the last failure, or ``None`` if there was none.

        Reported separately from the exception because the command-line tools print a
        fixed message plus this, never the provider's wording: a gateway body can quote
        the request, and the request is the question and the evidence texts.
        """
        return self._refusal

    async def generate(
        self,
        *,
        question: str,
        evidence: Sequence[EvidenceItem],
        refresh: Callable[[], Awaitable[list[EvidenceItem]]] | None = None,
        history: Sequence[ConversationTurn] = (),
        refresh_history: Callable[[], Awaitable[list[ConversationTurn]]] | None = None,
    ) -> GenerationResult:
        """Return the model's claims for this question and evidence.

        ``refresh``, when given, is awaited **once per attempt** and its result is what
        that attempt sends. It exists because this is the second stage that puts document
        text outside the process: the caller's last authorization check happened before it
        called this, and a retry or a repair is a *later* moment. Without a re-read, the
        second attempt would carry the first attempt's text after an access narrowing, a
        deletion or a revision replacement had already landed - the same defect Part 12
        fixed for rerank, arriving again one layer over. A refresh that comes back empty
        raises :class:`GenerationEvidenceError`, which stops the call at once: no request
        is sent, and no repair is attempted, because a repair would ask the model again
        with evidence the caller is no longer allowed to send.

        The attempt budget is spent here rather than through ``arun_with_retry`` because a
        repair is not a retry. A retry re-sends the same request after a transient failure;
        a repair re-sends a *different* request, one that tells the model its previous
        output was unusable. Forcing that through a helper whose contract is "retry the
        same operation" would mean raising a ``RetryableError`` for a permanent defect,
        and that error escaping as if it were transient is exactly the bug this class of
        provider already had once. So the loop is here, with three distinct outcomes:
        transient, repairable, and refused.
        """
        if not question.strip():
            raise ValueError("question must not be empty")
        if not evidence:
            raise ValueError("generation needs at least one evidence item")
        # Validated up front so a malformed caller is refused before any request, and
        # again per attempt because a refresh can hand back a different list.
        _handles_of(evidence)

        self._usage = None
        usage = _UsageAccumulator()
        # Repair instructions survive attempts, while the current question/evidence and
        # conversation history are rebuilt per attempt after their authorization refresh.
        extra_turns: list[dict[str, str]] = []
        repair_used = False
        last_error: BaseException | None = None

        # The usage is finalized in a ``finally`` rather than at each place the loop can
        # stop, because that list keeps growing and a new exit path would silently drop
        # the cost of calls that really happened. An empty refresh after a billed
        # response is exactly that case: the exception is right, and the usage behind it
        # still belongs to whoever is being charged.
        try:
            for attempt in range(1, self._policy.attempts + 1):
                # Cleared per attempt, not once before the loop: the value describes the
                # outcome the caller is looking at, so a rate limit on the first attempt
                # that then succeeds must not go on blaming an exhausted quota for a call
                # that worked.
                self._refusal = None
                # Rebuilt per attempt. The body is composed inside this ``try`` and not
                # before it, because a failure raised from an ``else`` clause would bypass
                # every handler on the ``try`` and escape as an internal type a caller
                # cannot classify.
                try:
                    async with asyncio.timeout(self._policy.attempt_timeout_seconds):
                        current = await refresh() if refresh is not None else list(evidence)
                        if not current:
                            # Deliberately not ``_Repairable``. Nothing was sent, so there
                            # is no answer to repair, and the attempt budget belongs to real
                            # calls. This type carries its own name because a caller
                            # reporting it as a response failure would blame the provider
                            # for something the provider was never asked.
                            raise GenerationEvidenceError(
                                "no authorized evidence remained to generate from"
                            )
                        current_history = (
                            await refresh_history()
                            if refresh_history is not None
                            else list(history)
                        )
                        # Checked against what this attempt sends, so a handle the model
                        # cites is known to be one of these.
                        current_handles = _handles_of(current)
                        payload = await self._post(
                            self._body(question, current_history, extra_turns, current), usage
                        )
                        result = _result_from(payload, handles=current_handles)
                except TimeoutError as error:
                    last_error = RetryableError(
                        "generation attempt exceeded its wall-clock deadline"
                    )
                    del error
                except _Repairable as error:
                    # The model answered and the answer cannot be used. One repair, inside
                    # the same budget, and only if there is an attempt left to spend on it:
                    # a repair that had to wait for a fresh budget would silently double
                    # it.
                    if repair_used or attempt >= self._policy.attempts:
                        raise GenerationResponseError(str(error)) from error
                    repair_used = True
                    extra_turns = [*extra_turns, {"role": "user", "content": _REPAIR_PROMPT}]
                    continue
                except RetryableError as error:
                    last_error = error
                else:
                    return result

                # A ``GenerationProviderError`` raised above is not listed here on
                # purpose. It is permanent - bad credentials, a blocked request, a
                # truncated generation - and no handler catches it, so it propagates at
                # once instead of spending the remaining budget on a request that cannot
                # succeed. There is also no catch-all: an exception this code has never
                # seen must keep its own traceback rather than be reported as "the
                # provider did not answer".
                if attempt >= self._policy.attempts:
                    break
                delay = self._policy.backoff_for(attempt, random.random())
                if delay > 0:
                    await asyncio.sleep(delay)

            # The budget is spent, so the failure is permanent.
            if last_error is None:  # pragma: no cover - unreachable without a failure
                raise RuntimeError("generation loop finished without a result or an error")
            raise GenerationProviderError(
                f"generation did not complete within {self._policy.attempts} attempts"
            ) from last_error
        finally:
            # Every exit the loop can take, including one raised by an error type added
            # later, reports what was spent. Idempotent: on the success path it records
            # the same value the removed assignment used to.
            self._usage = usage.finish(provider=self._provider_name, model=self._model)

    def _body(
        self,
        question: str,
        history: Sequence[ConversationTurn],
        extra_turns: Sequence[Mapping[str, str]],
        evidence: Sequence[EvidenceItem],
    ) -> dict[str, Any]:
        """Build one request body. Called per attempt, never cached.

        ``evidence`` is the list this attempt is sending, not the one the caller passed
        in: after a refresh the two differ, and composing the user turn from a stale list
        would send the very text the refresh exists to withhold.
        """
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": self.system_prompt},
                *[
                    message
                    for turn in history
                    for message in (
                        {"role": "user", "content": turn.question},
                        {"role": "assistant", "content": turn.answer},
                    )
                ],
                {"role": "user", "content": _user_message(question, evidence)},
                *[dict(turn) for turn in extra_turns],
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "claims",
                    "strict": True,
                    "schema": dict(GENERATION_SCHEMA),
                },
            },
            # The setting that makes the schema a guarantee: an endpoint that does not
            # support a parameter is skipped instead of silently dropping it. Without it
            # a downgrade to free prose is invisible.
            "provider": {"require_parameters": True},
            "stream": False,
        }
        if self._max_tokens is not None:
            body["max_tokens"] = self._max_tokens
        if self._temperature is not None:
            body["temperature"] = self._temperature
        if self._provider_name != "openrouter":
            body.pop("provider", None)
        if self._provider_name == "openai" and "max_tokens" in body:
            body["max_completion_tokens"] = body.pop("max_tokens")
        if self._provider_name == "ollama":
            # Thinking can exhaust the shared budget before a schema-constrained answer starts.
            body["reasoning_effort"] = "none"
        return body

    async def _post(self, body: Mapping[str, Any], usage: _UsageAccumulator) -> dict[str, Any]:
        """One attempt: send the request and return the decoded body.

        The usage block is recorded here rather than by the caller, because this is the
        only place that sees the response - including the ones about to be raised as
        errors, which are exactly the attempts a caller would otherwise forget to count.
        """
        try:
            response = await self._client.request(
                "POST",
                f"{self._base_url}{GENERATION_PATH}",
                json=body,
                headers={
                    **({"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}),
                    "Content-Type": "application/json",
                },
                timeout=self._policy.attempt_timeout_seconds,
            )
        except httpx.TimeoutException as error:
            raise RetryableError("generation request timed out") from error
        except httpx.TransportError as error:
            raise RetryableError("generation transport failure") from error

        if response.status_code >= 400:
            # Counted before it is raised: the prompt was sent and may have been billed.
            usage.record(_error_body(response))
            if is_retryable_status(response.status_code):
                self._refusal = _refusal_of(_error_of(_error_body(response)), response.status_code)
                raise RetryableError(f"generation provider returned {response.status_code}")
            raise GenerationProviderError(
                f"generation provider returned {response.status_code}: {_safe_detail(response)}"
            )

        try:
            decoded = response.json()
        except ValueError as error:
            raise _Repairable("generation provider returned invalid JSON") from error
        if not isinstance(decoded, dict):
            raise _Repairable("generation provider returned an unexpected payload")
        usage.record(decoded)

        # A non-streaming failure arrives as a 200 whose body is only an error. Reading
        # ``choices`` first would raise IndexError, so the error is looked for first and
        # classified by whether a retry could possibly help.
        embedded = decoded.get("error")
        if embedded is not None:
            self._refusal = _refusal_of(_error_of(embedded), response.status_code)
            _raise_embedded_error(embedded, response.status_code)
        return decoded


class _UsageAccumulator:
    """Adds up what every attempt cost, including the ones whose answer was unusable.

    An unusable answer is still an answer the provider generated and still billed, so a
    total that reported only the successful attempt understates the cost of the call. The
    rules for combining are deliberately conservative: tokens add exactly, and a figure
    any attempt left unreported makes the *total* unreported rather than zero. Dropping it
    would read as "this was free", which is a claim about money that nobody made.
    """

    __slots__ = ("attempts", "cost", "input_tokens", "output_tokens", "total_tokens", "unreported")

    def __init__(self) -> None:
        self.attempts = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.total_tokens = 0
        self.cost: Decimal = Decimal(0)
        #: Figures some attempt did not report, keyed by field name.
        self.unreported: set[str] = set()

    def record(self, body: object) -> None:
        """Add one attempt, given whatever body the provider answered with.

        Called for every response the provider actually produced, successful or not: a
        rejected answer still cost tokens to generate, and a rate-limited one still cost
        the prompt. A request that never reached the provider records nothing, because
        there is nothing to attribute a cost to and inventing a zero would be a claim
        about money nobody made.

        A body carrying no usage block counts as an attempt whose figures are unreported,
        which is what makes the *total* unreported rather than the sum of only the
        attempts that did report.
        """
        raw = body.get("usage") if isinstance(body, dict) else None
        usage = raw if isinstance(raw, dict) else {}
        self.attempts += 1

        for key, target in (
            ("prompt_tokens", "input_tokens"),
            ("completion_tokens", "output_tokens"),
            ("total_tokens", "total_tokens"),
        ):
            value = usage.get(key)
            if type(value) is not int or value < 0:
                self.unreported.add(target)
                continue
            setattr(self, target, getattr(self, target) + int(value))

        raw_cost = usage.get("cost")
        if not isinstance(raw_cost, (int, float)) or isinstance(raw_cost, bool):
            self.unreported.add("cost")
            return
        # A JSON integer may be arbitrarily long and cannot become a float, so the
        # conversion is guarded. An unusable cost leaves the total unknown.
        try:
            if (
                raw_cost < 0
                or float(raw_cost) != float(raw_cost)
                or abs(float(raw_cost)) == float("inf")
            ):
                self.unreported.add("cost")
                return
        except (OverflowError, ValueError):
            self.unreported.add("cost")
            return
        self.cost += Decimal(str(raw_cost))

    def finish(self, *, provider: str, model: str) -> ProviderUsage | None:
        """The combined usage, or ``None`` when no attempt reported any at all."""
        if self.attempts == 0:
            return None
        billed: dict[str, int | float | str] = {}
        # The pairs are (field name, wire key) in that order: ``unreported`` holds field
        # names, because those are what the properties are called, so testing it against
        # the wire key would report a zero for a figure some attempt never sent.
        for field, key, value in (
            ("input_tokens", "prompt_tokens", self.input_tokens),
            ("output_tokens", "completion_tokens", self.output_tokens),
            ("total_tokens", "total_tokens", self.total_tokens),
        ):
            if field not in self.unreported:
                billed[key] = value
        return ProviderUsage(
            provider=provider,
            model=model,
            input_tokens=None if "input_tokens" in self.unreported else self.input_tokens,
            output_tokens=None if "output_tokens" in self.unreported else self.output_tokens,
            billed_units=billed or None,
            cost=None if "cost" in self.unreported else self.cost,
            currency=None,
            attempts=self.attempts,
        )


class _Repairable(Exception):
    """The model answered, and the answer cannot be used.

    Private because it is a control-flow signal inside this module, never something a
    caller classifies against: by the time it reaches one it has become
    ``GenerationResponseError``.
    """


#: The documented error vocabulary, restricted to the codes a retry can actually help.
#: ``timeout`` and ``rate_limit_exceeded`` are here because the same page lists them as
#: transient; every other typed code describes a request that will fail identically next
#: time.
_RETRYABLE_ERROR_TYPES: Final = frozenset(
    {"rate_limit_exceeded", "provider_overloaded", "provider_unavailable", "timeout"}
)


def _error_body(response: httpx.Response) -> object:
    """The response body as an object, or ``None`` when it is not JSON."""
    try:
        return response.json()
    except ValueError:
        return None


def _raise_embedded_error(embedded: object, http_status: int) -> None:
    """Classify an ``error`` object found in a body whose HTTP status was ``200``.

    Classified on the typed code first, and this is not a preference. A real call
    against the free endpoint returns ``200`` with ``error.code`` 502 and
    ``error_type`` ``provider_unavailable``, so classifying on the HTTP status alone
    calls a provider disconnect permanent and burns the whole request on the first
    blip. The error page is explicit that ``error_type`` is the field to switch on.
    """
    code: object = None
    message = ""
    error_type: object = None
    if isinstance(embedded, dict):
        code = embedded.get("code")
        raw_message = embedded.get("message")
        if isinstance(raw_message, str):
            message = raw_message[:_DETAIL_LIMIT]
        metadata = embedded.get("metadata")
        if isinstance(metadata, dict):
            error_type = metadata.get("error_type")

    # The embedded code is the status the provider meant, falling back to the HTTP one
    # when the body omits or misreports it. ``type is int`` because JSON ``true`` is an
    # int in Python and 1 is not a status code.
    status = http_status
    if type(code) is int and 100 <= code <= 599:
        status = code

    if isinstance(error_type, str):
        retryable = error_type in _RETRYABLE_ERROR_TYPES
    else:
        retryable = is_retryable_status(status)

    if retryable:
        raise RetryableError(f"generation provider returned {status}")
    raise GenerationProviderError(f"generation provider returned {status}: {message}")


_DETAIL_LIMIT: Final = 200


def _safe_detail(response: httpx.Response) -> str:
    """A short, single-line excerpt of a failed response, for a log line.

    Truncated because the body can quote the request, and the request is the question
    and the evidence texts. The provider's own wording is diagnostic; its echo of our
    data is a leak.
    """
    try:
        body = response.text
    except (UnicodeDecodeError, httpx.ResponseNotRead):  # pragma: no cover - defensive
        return ""
    collapsed = " ".join(body.split())
    return collapsed[:_DETAIL_LIMIT]


def _handles_of(evidence: Sequence[EvidenceItem]) -> frozenset[str]:
    """The handles a claim is allowed to cite: exactly the ones we sent.

    Refused here rather than later because an unknown ``evidence_id`` is a model
    inventing a citation, and the cheapest place to notice is the boundary where the
    set of legitimate handles still exists.
    """
    seen: set[str] = set()
    for item in evidence:
        if not item.evidence_id.strip():
            raise ValueError("evidence_id must not be empty")
        if item.evidence_id in seen:
            raise ValueError("evidence ids must be unique")
        seen.add(item.evidence_id)
    return frozenset(seen)


def _user_message(question: str, evidence: Sequence[EvidenceItem]) -> str:
    """The user turn: the question, then each passage behind its handle."""
    blocks = [
        "پرسش کاربر:",
        question,
        "",
        "شواهد (هر شناسه فقط یک قطعهٔ مجاز است):",
    ]
    for item in evidence:
        blocks.append(f"<evidence id={item.evidence_id}>")
        blocks.append(item.text)
        blocks.append("</evidence>")
    return "\n".join(blocks)


#: Sent after an unusable answer, and deliberately *not* quoting it back. The broken
#: output is already in the transcript the provider has, repeating it only spends tokens
#: on text the model wrote badly.
_REPAIR_PROMPT: Final = "\n".join(
    (
        "پاسخ قبلی با طرح‌وارهٔ خواسته‌شده سازگار نبود.",
        "دوباره پاسخ بده و این بار فقط یک شیء JSON مطابق طرح‌واره بفرست، بدون متن اضافه.",
    )
)


def _result_from(payload: Mapping[str, Any], *, handles: frozenset[str]) -> GenerationResult:
    """Turn a decoded body into a result, or refuse the whole answer.

    The checks in order: exactly one choice, a finish reason that means the generation
    actually completed, string content, JSON that parses, then the shape. Each one
    closes a way of getting a confident-looking result out of a failed call.
    """
    choices = payload.get("choices")
    if not isinstance(choices, list) or len(choices) != 1:
        raise _Repairable("generation provider did not return exactly one choice")
    choice = choices[0]
    if not isinstance(choice, dict):
        raise _Repairable("generation choice was not an object")

    finish = choice.get("finish_reason")
    if finish == "content_filter":
        raise GenerationRefusalError("generation provider refused the request")
    if finish == "length":
        # Explicitly not retried: the documented fix is a larger token budget, and
        # asking again spends money to produce the same truncation.
        raise GenerationResponseError("generation stopped at the token limit")
    if finish != "stop":
        # ``error``, ``content_filter``, ``tool_calls`` and ``null`` all mean there is no
        # completed generation to read. ``error`` here is the provider failing mid-flight.
        raise GenerationResponseError("generation did not finish successfully")

    message = choice.get("message")
    if not isinstance(message, dict):
        raise _Repairable("generation choice carried no message")
    refusal = message.get("refusal")
    if isinstance(refusal, str) and refusal.strip():
        raise GenerationRefusalError("generation provider refused the request")
    content = message.get("content")
    if not isinstance(content, str):
        # The published schema allows a string, an array of content items, or null.
        # Only a string can hold the JSON the schema promised, and an array here means
        # the endpoint did not honour ``response_format`` at all.
        raise _Repairable("generation message content was not a string")
    if not content.strip():
        # An empty body is the documented shape of a cold start or a reasoning model
        # that spent the whole budget thinking. There is nothing to parse, and retrying
        # is the caller's decision rather than something to assume here.
        raise GenerationResponseError("generation returned no content")

    try:
        decoded = json.loads(content)
    except ValueError as error:
        raise _Repairable("generation content was not JSON") from error
    if not isinstance(decoded, dict):
        raise _Repairable("generation content was not a JSON object")

    return _result_from_object(decoded, handles=handles)


def _result_from_object(decoded: Mapping[str, Any], *, handles: frozenset[str]) -> GenerationResult:
    """Validate the decoded object against the schema and the handles we sent."""
    claims = _claims_from(decoded.get("claims"), handles=handles)

    abstained = decoded.get("abstained")
    # A provider answering ``1`` for a boolean flag has not said what it meant, and the
    # safe reading of "not a boolean" is not "false": refusing keeps the ambiguity
    # visible instead of resolving it in the direction that invents an answer. Written as
    # ``type(x) is bool`` to state the closed set the schema declares, though for this
    # direction ``bool`` being final in Python makes it equivalent to ``isinstance``.
    # The places where ``bool`` really does leak into a number are the usage figures
    # below, and those are guarded separately.
    if type(abstained) is not bool:
        raise _Repairable("generation abstained flag was not a boolean")

    missing = _missing_from(decoded.get("missing_parts"))
    answer = decoded.get("answer")
    if not isinstance(answer, str):
        raise _Repairable("generation answer was not a string")

    return GenerationResult(
        claims=claims,
        abstained=abstained,
        missing_parts=missing,
        # An empty string means the model wrote nothing, which is a real state and not
        # the same as prose it chose to write.
        answer=answer if answer.strip() else None,
    )


def _claims_from(raw: object, *, handles: frozenset[str]) -> list[Claim]:
    if not isinstance(raw, list):
        raise _Repairable("generation claims were not a list")
    claims: list[Claim] = []
    for item in raw:
        if not isinstance(item, dict):
            raise _Repairable("generation claim was not an object")
        # Every field is checked by name so a failure says which one was wrong. A
        # partially valid claim is not kept: a claim missing its quote is a claim with
        # nothing to validate later, and Part 14 has no way to tell that apart from a
        # claim whose quote is simply absent from the text.
        fields: dict[str, str] = {}
        for field in ("text", "evidence_id", "quote"):
            value = item.get(field)
            if not isinstance(value, str):
                raise _Repairable(f"generation claim {field} was not a string")
            fields[field] = value
        # The one claim-level check this adapter can make: the handle must be one we
        # sent. Whether the quote appears in that evidence is Part 14's question, about
        # the corpus rather than about the provider.
        if fields["evidence_id"] not in handles:
            raise GenerationReferenceError("generation claim cited an unknown evidence id")
        claims.append(
            Claim(text=fields["text"], evidence_id=fields["evidence_id"], quote=fields["quote"])
        )
    return claims


def _missing_from(raw: object) -> list[MissingPart]:
    if not isinstance(raw, list):
        raise _Repairable("generation missing_parts was not a list")
    parts: list[MissingPart] = []
    for item in raw:
        # A closed set, checked as membership rather than cast: a value outside it has
        # no composed refusal sentence, so accepting it would leave the caller unable to
        # say anything to the user.
        if not isinstance(item, str):
            raise _Repairable("generation missing_parts carried a non-string value")
        # Resolved through an explicit mapping rather than a membership test: a
        # ``str in tuple[Literal]`` check does not narrow the type, and the mapping says
        # the same thing while making the one-of-three rule impossible to bypass.
        resolved = MISSING_PARTS_BY_NAME.get(item)
        if resolved is None:
            raise _Repairable("generation missing_parts carried an unknown value")
        # Repeated reasons are collapsed, keeping first-seen order. ``missing_parts`` is a
        # set of reasons and the model does repeat them - four identical entries in one
        # real run - so keeping them would make a composed refusal say the same thing
        # four times. Collapsing loses nothing: the value was already in the list.
        if resolved not in parts:
            parts.append(resolved)
    return parts


def _usage_from(raw: object, model: str) -> ProviderUsage:
    """Record what the provider reported, leaving anything absent unknown.

    The same rule as the rerank adapter: absence is recorded as absence. A fabricated
    ``0`` reads as "this was free", which is a claim about money nobody made. The
    published ``ChatUsage`` carries no currency field, so ``currency`` stays ``None``
    rather than guessing the unit a provider counts in.
    """
    usage = raw if isinstance(raw, dict) else {}

    billed: dict[str, int | float | str] = {}
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        billed[key] = value

    cost: Decimal | None = None
    raw_cost = usage.get("cost")
    if isinstance(raw_cost, (int, float)) and not isinstance(raw_cost, bool):
        # A JSON integer may be arbitrarily long and cannot become a float, so the
        # conversion is guarded rather than assumed. Usage is metadata: an unusable
        # figure is reported as unknown instead of raising.
        try:
            if float(raw_cost) == float(raw_cost) and abs(float(raw_cost)) != float("inf"):
                cost = Decimal(str(raw_cost))
        except (OverflowError, ValueError):
            cost = None

    return ProviderUsage(
        provider=DEFAULT_PROVIDER_NAME,
        model=model,
        input_tokens=_int_or_none(billed.get("prompt_tokens")),
        output_tokens=_int_or_none(billed.get("completion_tokens")),
        billed_units=billed or None,
        cost=cost,
        currency=None,
    )


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def build_generation_provider(
    settings: Settings,
    *,
    client: httpx.AsyncClient,
    policy: RetryPolicy | None = None,
    system_prompt: str = DEFAULT_SYSTEM_PROMPT,
) -> GenerationProvider:
    """Assemble the adapter from configuration.

    The model, base URL and token ceiling all come from settings, so the deployed model
    is a configuration value and never a constant in the code.
    """
    from app.provider_config.runtime import GenerationChain

    return GenerationChain(settings, client=client, policy=policy, system_prompt=system_prompt)
