import re
from pathlib import Path
from typing import Annotated, Literal

from pydantic import (
    Field,
    HttpUrl,
    SecretStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict, SettingsError

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
# A digest prefix as recorded in ARCHITECTURE.md section 1: lowercase hex, at
# least 12 characters so a specific revision can be pinned.
_DIGEST_PREFIX = re.compile(r"[0-9a-f]{12,64}")
NonEmptyString = Annotated[str, Field(min_length=1)]


class Settings(BaseSettings):
    # Explicit root path works even when the caller's working directory changes.
    # https://docs.pydantic.dev/latest/concepts/pydantic_settings/#dotenv-env-support
    model_config = SettingsConfigDict(
        env_file=ROOT_ENV,
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
        frozen=True,
    )

    openrouter_api_key: SecretStr = Field(default=SecretStr(""), repr=False)
    openrouter_base_url: HttpUrl = HttpUrl("https://openrouter.ai/api/v1")
    openrouter_model: NonEmptyString = "dots-studio/dots-3-note-preview:free"
    embedding_provider: Literal["ollama"] = "ollama"
    ollama_base_url: HttpUrl = HttpUrl("http://127.0.0.1:11434")
    ollama_embed_model: NonEmptyString = "nomic-embed-text-v2-moe:latest"
    embedding_dimension: int = Field(default=768, ge=768, le=768)
    embedding_max_tokens: int = Field(default=400, gt=0, le=512)
    embedding_truncate: bool = False
    # Live-checked digest of the embedding model (ARCHITECTURE.md section 1).
    # A mismatch fails closed rather than mixing vectors from two models.
    ollama_embed_digest: str = "ff9c2f10ef5e"
    db_host: NonEmptyString = "127.0.0.1"
    db_port: int = Field(default=5433, ge=1, le=65535)
    db_name: Literal["enterprise_knowledge_copilot", "enterprise_knowledge_copilot_test"] = (
        "enterprise_knowledge_copilot"
    )
    db_user: NonEmptyString = "enterprise_knowledge_copilot"
    db_password: SecretStr = Field(default=SecretStr(""), repr=False)
    # A bounded completion for structured claims, sized from measurement rather than
    # taste. Against this model with five chunks of real Persian text, completion tokens
    # ranged from 291 to 2118 across runs, and a ceiling of 1500 truncated some of them -
    # a ``finish_reason: "length"`` failure the error reference says is fixed by raising
    # the ceiling and *not* by retrying. The default therefore sits well above the worst
    # observed rather than near the average; the real bound on latency is the 30-second
    # attempt deadline, not this number.
    #
    # Generation has no enabled/disabled flag on purpose: nothing serves an answer yet, so
    # the caller that wants a generator builds one, exactly as the rerank report builds a
    # reranker only under ``--rerank``.
    generation_max_tokens: int = Field(default=4096, gt=0, le=32768)
    # Part 15. The answer endpoint's per-role window. It guards against a retry loop, a
    # double-submitting client, or one role monopolising an endpoint whose every call
    # reaches a third party. It does **not** protect the daily quota: the free endpoint
    # allows fifty requests a day for the whole account, so no per-role window can stop that
    # budget being spent. Protecting it needs a per-day allowance, which is a product
    # decision about how many questions a user may ask, and no such number is assumed here.
    answer_rate_limit: int = Field(default=6, gt=0, le=1000)
    answer_rate_window_seconds: int = Field(default=60, gt=0, le=3600)
    answer_rate_max_keys: int = Field(default=100, gt=0, le=100_000)
    # The HTTP client's own timeout, deliberately shorter than the request budget below so a
    # stalled socket is abandoned while the request is still inside its deadline and its
    # usage can still be read.
    generation_request_timeout: float = Field(default=30.0, gt=0, le=120)
    rerank_enabled: bool = False
    rerank_provider: Literal["openrouter"] = "openrouter"
    openrouter_rerank_model: NonEmptyString = "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
    web_origin: HttpUrl = HttpUrl("http://localhost:3000")
    api_base_url: HttpUrl = HttpUrl("http://127.0.0.1:8000")
    session_ttl_seconds: int = Field(default=28800, gt=0)
    login_rate_pair_limit: int = Field(default=5, ge=1, le=1000)
    login_rate_ip_limit: int = Field(default=30, ge=1, le=1000)
    login_rate_window_seconds: int = Field(default=60, ge=1, le=3600)
    login_rate_max_keys: int = Field(default=10000, ge=2, le=100000)
    # Upload limits from SECURITY.md section 8. They are fields rather than
    # module constants so a deployment can lower them without a code change, and
    # so a test can shrink the quotas instead of creating a hundred documents.
    upload_max_bytes: int = Field(default=1048576, ge=1, le=1048576)
    upload_max_active_documents: int = Field(default=100, ge=1, le=100000)
    upload_max_current_chunks: int = Field(default=2000, ge=1, le=1000000)
    # Ingestion lease from DATABASE.md section 4: 120 seconds, renewed every 30.
    # The renew interval must be well under the lease so one missed renewal does
    # not expire the lease while the worker is still making progress.
    ingestion_lease_seconds: int = Field(default=120, ge=10, le=3600)
    ingestion_lease_renew_seconds: int = Field(default=30, ge=1, le=1800)
    # Three is the ceiling the ingestion_jobs CHECK constraint allows.
    ingestion_max_attempts: int = Field(default=3, ge=1, le=3)
    seed_employee_password: SecretStr = Field(default=SecretStr(""), repr=False)
    seed_manager_password: SecretStr = Field(default=SecretStr(""), repr=False)

    @field_validator("embedding_truncate")
    @classmethod
    def reject_truncation(cls, value: bool) -> bool:
        if value:
            raise ValueError("Embedding truncation must remain disabled")
        return value

    @field_validator("ollama_embed_digest")
    @classmethod
    def reject_unusable_digest(cls, value: str) -> str:
        """Require a hex digest so an empty or malformed value cannot disable the check.

        DATABASE.md section 5 requires a fail-closed response to a digest change.
        An empty value would silently turn that check off, so it is rejected at
        configuration time rather than tolerated.
        """
        if not _DIGEST_PREFIX.fullmatch(value):
            raise ValueError("OLLAMA_EMBED_DIGEST must be a lowercase hex digest prefix")
        return value

    @model_validator(mode="after")
    def reject_impossible_lease_renewal(self) -> "Settings":
        """Require the renew interval to leave room inside the lease.

        A renew interval at or above the lease duration would let the lease
        expire between two renewals, so a healthy worker would lose its claim
        to another worker while it is still writing.
        """
        if self.ingestion_lease_renew_seconds >= self.ingestion_lease_seconds:
            raise ValueError("the lease renew interval must be shorter than the lease duration")
        return self


class ConfigurationError(Exception):
    """Safe startup error that never carries environment values."""


def load_settings() -> Settings:
    try:
        return Settings()
    except ValidationError as exc:
        # Neither error input nor custom validation text is safe to log.
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc']).upper()}: {error['type']}"
            for error in exc.errors(include_input=False, include_context=False, include_url=False)
        )
        raise ConfigurationError(f"Invalid environment configuration: {details}") from None
    except (SettingsError, OSError, UnicodeError):
        raise ConfigurationError("Cannot read environment configuration; check root .env") from None
