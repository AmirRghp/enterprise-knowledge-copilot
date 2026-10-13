"""Model-matched tokenizer for chunking.

DATABASE.md section 199 and ARCHITECTURE.md section 6 require the chunker to
measure tokens with the tokenizer that matches the embedding model and forbid
approximating the count from character length. The tokenizer is therefore loaded
lazily from the model repository and cached by ``tokenizers``.

There is deliberately no character-based fallback: a wrong token count would let
an over-long chunk reach the provider, and ARCHITECTURE.md section 12 requires
that such input be rejected loudly rather than silently trimmed. Part 6 makes no
provider call at all, so a missing tokenizer surfaces here as a clear error.
"""

from functools import lru_cache
from typing import Any, Protocol

# Must match OLLAMA_EMBED_MODEL; see DATABASE.md section 3.
DEFAULT_TOKENIZER_REPO = "nomic-ai/nomic-embed-text-v2-moe"


class TokenizerUnavailableError(RuntimeError):
    """Raised when the model-matched tokenizer cannot be loaded."""


class TokenCounter(Protocol):
    """Minimal contract the chunker needs from a tokenizer."""

    def count(self, text: str) -> int:
        """Return the token count for ``text`` as the provider would see it."""
        ...


class ByteCounter:
    """Conservative provider-neutral limit; UTF-8 bytes upper-bound common token counts."""

    def count(self, text: str) -> int:
        return len(text.encode("utf-8"))


class HuggingFaceTokenCounter:
    """Counts tokens with the real Nomic tokenizer, including special tokens."""

    def __init__(self, repository: str = DEFAULT_TOKENIZER_REPO) -> None:
        self.repository = repository

    def count(self, text: str) -> int:
        encoding = _tokenizer(self.repository).encode(text)
        return len(encoding.ids)


class _Tokenizer(Protocol):
    """The surface of a tokenizers ``Tokenizer`` this module relies on.

    Declared so the chunker depends on a narrow contract rather than the
    concrete library, while staying assignable from it.
    """

    def encode(self, text: str) -> Any:
        """Encode ``text`` and return an encoding exposing ``ids``."""
        ...


@lru_cache(maxsize=2)
def _tokenizer(repository: str) -> _Tokenizer:
    """Load and cache the tokenizer for ``repository``.

    Import and download happen here rather than at module import so that
    ``GET /api/health`` and the auth endpoints never depend on the hub.
    """
    try:
        from tokenizers import Tokenizer  # noqa: PLC0415
    except ImportError as error:  # pragma: no cover - dependency is locked
        raise TokenizerUnavailableError(
            "the tokenizers package is required for model-matched chunking"
        ) from error

    try:
        loaded: _Tokenizer = Tokenizer.from_pretrained(repository)
    except Exception as error:  # noqa: BLE001  any hub/network/format failure
        raise TokenizerUnavailableError(
            f"could not load the tokenizer for {repository}; "
            "it must be available locally or the hub must be reachable"
        ) from error

    return loaded


def load_token_counter(repository: str = DEFAULT_TOKENIZER_REPO) -> TokenCounter:
    """Return a token counter bound to the embedding model's tokenizer."""
    return HuggingFaceTokenCounter(repository)
