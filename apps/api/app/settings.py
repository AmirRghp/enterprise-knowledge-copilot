from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field, HttpUrl, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict, SettingsError

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"
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
    openrouter_model: NonEmptyString = "google/gemini-2.5-flash"
    embedding_provider: Literal["ollama"] = "ollama"
    ollama_base_url: HttpUrl = HttpUrl("http://127.0.0.1:11434")
    ollama_embed_model: NonEmptyString = "nomic-embed-text-v2-moe:latest"
    embedding_dimension: int = Field(default=768, ge=768, le=768)
    embedding_max_tokens: int = Field(default=400, gt=0, le=512)
    embedding_truncate: bool = False
    db_host: NonEmptyString = "127.0.0.1"
    db_port: int = Field(default=5433, ge=1, le=65535)
    db_name: Literal["enterprise_knowledge_copilot", "enterprise_knowledge_copilot_test"] = (
        "enterprise_knowledge_copilot"
    )
    db_user: NonEmptyString = "enterprise_knowledge_copilot"
    db_password: SecretStr = Field(default=SecretStr(""), repr=False)
    rerank_enabled: bool = False
    rerank_provider: Literal["openrouter"] = "openrouter"
    openrouter_rerank_model: NonEmptyString = "nvidia/llama-nemotron-rerank-vl-1b-v2:free"
    web_origin: HttpUrl = HttpUrl("http://localhost:3000")
    api_base_url: HttpUrl = HttpUrl("http://127.0.0.1:8000")
    session_ttl_seconds: int = Field(default=28800, gt=0)
    seed_employee_password: SecretStr = Field(default=SecretStr(""), repr=False)
    seed_manager_password: SecretStr = Field(default=SecretStr(""), repr=False)

    @field_validator("embedding_truncate")
    @classmethod
    def reject_truncation(cls, value: bool) -> bool:
        if value:
            raise ValueError("Embedding truncation must remain disabled")
        return value


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
