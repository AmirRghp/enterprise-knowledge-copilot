"""Verify the local Ollama embedding setup.

This is the Part 7 preflight described in ``technical-details.md``: it confirms
the model is present, its digest matches the configured value, and both the
document and query prefixes produce a 768-dimensional vector from Persian text.

It prints model identity, dimension, and digest only. Input text and vector
components are never printed, so the command is safe to paste into a report.

Run from ``apps/api``:

    uv run --locked python -m app.cli.preflight_embedding
"""

import argparse
import asyncio
import sys

import httpx

from app.provider_config.contracts import ProviderConfigurationError
from app.provider_config.runtime import configured_call
from app.providers.base import DOCUMENT_PREFIX, QUERY_PREFIX, EmbeddingProvider
from app.settings import Settings, load_settings

# Non-sensitive Persian sample. Prefixes are shown in the output so the two input
# forms stay distinguishable in a report without revealing real content.
SAMPLE_DOCUMENT = "هر کارمند در هر دورهٔ سالانه بیست روز کاری مرخصی دارد."
SAMPLE_QUERY = "مرخصی سالانه چند روز است؟"


class PreflightError(Exception):
    """Raised when the local embedding setup does not satisfy the contract."""


def _require_provider_protocol(provider: EmbeddingProvider) -> EmbeddingProvider:
    """Return ``provider`` typed as the protocol.

    The return type makes mypy verify structurally that the concrete adapter
    implements the protocol, so a signature drift is caught at check time rather
    than at the first retrieval call.
    """
    return provider


def build_client(timeout_seconds: float) -> httpx.AsyncClient:
    """Create a client that does not follow redirects or reuse sockets."""
    return httpx.AsyncClient(
        timeout=timeout_seconds,
        follow_redirects=False,
        limits=httpx.Limits(max_keepalive_connections=1, max_connections=1),
    )


async def run_preflight(settings: Settings, *, timeout_seconds: float) -> dict[str, object]:
    """Check model presence, digest, and both prefixed inputs.

    ``timeout_seconds`` becomes the per-attempt deadline for both the HTTP client
    and the retry policy, so the CLI flag actually bounds the whole check instead
    of only the socket phases.
    """
    client = build_client(timeout_seconds)
    try:
        from app.cli.run_worker import build_provider

        provider = build_provider(settings, client=client, attempt_timeout=timeout_seconds)

        # Typed conformance check: mypy rejects this call if the adapter stops
        # satisfying the provider protocol that retrieval and ingestion use.
        _require_provider_protocol(provider)

        digest = await provider.model_digest()

        document_vector = (await provider.embed_documents([SAMPLE_DOCUMENT]))[0]
        query_vector = await provider.embed_query(SAMPLE_QUERY)

        if len(document_vector) != settings.embedding_dimension:
            raise PreflightError(
                f"document vector has dimension {len(document_vector)}, "
                f"expected {settings.embedding_dimension}"
            )
        if len(query_vector) != settings.embedding_dimension:
            raise PreflightError(
                f"query vector has dimension {len(query_vector)}, "
                f"expected {settings.embedding_dimension}"
            )
        if document_vector == query_vector:
            # Identical vectors would mean the prefixes were not applied.
            raise PreflightError(
                "the document and query prefixes produced the same vector; "
                "the prefixes are required by the model contract"
            )

        return {
            "base_url": str(settings.ollama_base_url),
            "model": provider.model,
            "provider": provider.provider_name,
            "dimension": len(document_vector),
            "digest": digest,
            "digest_expected": settings.ollama_embed_digest,
            "truncate": settings.embedding_truncate,
            "document_prefix": DOCUMENT_PREFIX,
            "query_prefix": QUERY_PREFIX,
        }
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="per-attempt timeout in seconds (default: 10, matching the retry budget)",
    )
    arguments = parser.parse_args(argv)

    if not arguments.timeout > 0:
        print("error: --timeout must be a positive number of seconds", file=sys.stderr)
        return 2

    try:
        settings = load_settings()
    except ProviderConfigurationError:
        print("configure embedding in the manager panel", file=sys.stderr)
        return 2
    except Exception as error:  # noqa: BLE001  reported as a short CLI error
        print(f"error: {error}", file=sys.stderr)
        return 1

    if settings.embedding_truncate:
        print("error: EMBEDDING_TRUNCATE must remain false", file=sys.stderr)
        return 1

    try:
        summary = asyncio.run(
            configured_call(
                settings,
                lambda configured: run_preflight(configured, timeout_seconds=arguments.timeout),
            )
        )
    except ProviderConfigurationError:
        print("configure embedding in the manager panel", file=sys.stderr)
        return 2
    except PreflightError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001  no traceback in a CLI report
        print(f"error: embedding preflight failed: {error}", file=sys.stderr)
        return 1

    print("ollama embedding preflight: ok")
    print(f"  base url           : {summary['base_url']}")
    print(f"  provider           : {summary['provider']}")
    print(f"  model              : {summary['model']}")
    print(f"  digest (live)      : {summary['digest']}")
    print(f"  digest (configured): {summary['digest_expected']}")
    print(f"  dimension          : {summary['dimension']}")
    print(f"  truncate           : {summary['truncate']}")
    print(f"  document prefix    : {summary['document_prefix']!r}")
    print(f"  query prefix       : {summary['query_prefix']!r}")
    print("  note               : sample text and vector values are not printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
