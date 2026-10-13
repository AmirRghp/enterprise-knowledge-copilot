"""Panel configuration: public fields and secrets have separate representations."""

import ipaddress
import re
from typing import Literal
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator, model_validator

Purpose = Literal["chat", "rerank", "embedding"]
Kind = Literal["ollama", "openai", "openai_compatible", "openrouter"]
PURPOSES: tuple[Purpose, ...] = ("chat", "rerank", "embedding")
NOMIC_MODEL = "nomic-embed-text-v2-moe:latest"


class ProviderConfigurationError(RuntimeError):
    """Safe failure; never carries credential or endpoint input."""


class ProviderConflictError(ValueError):
    pass


class ProviderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", hide_input_in_errors=True)
    version: int = Field(ge=0, strict=True)
    name: str = Field(min_length=1, max_length=100)
    kind: Kind
    model: str = Field(min_length=1, max_length=200)
    base_url: str = Field(default="", max_length=2048)
    api_key: SecretStr = Field(default=SecretStr(""), repr=False, max_length=4096)
    expected_digest: str = Field(default="", max_length=64)

    @field_validator("name", "model", "base_url", "expected_digest")
    @classmethod
    def trim(cls, value: str) -> str:
        return value.strip()

    @field_validator("api_key")
    @classmethod
    def key_header(cls, value: SecretStr) -> SecretStr:
        key = value.get_secret_value().strip()
        if any(not 33 <= ord(char) <= 126 for char in key):
            raise ValueError("credential must be a printable token")
        return SecretStr(key)

    @model_validator(mode="after")
    def valid_fields(self) -> "ProviderInput":
        if not self.name or not self.model:
            raise ValueError("name and model are required")
        if self.kind == "openai":
            self.base_url = "https://api.openai.com/v1"
        elif self.kind == "openrouter":
            self.base_url = "https://openrouter.ai/api/v1"
        else:
            validate_url(self.base_url)
            self.base_url = self.base_url.rstrip("/")
        return self

    def for_purpose(self, purpose: Purpose) -> None:
        if purpose == "rerank" and self.kind not in ("openrouter", "openai_compatible"):
            raise ValueError("rerank endpoint not supported")
        if purpose == "embedding":
            if self.kind != "ollama" or self.model != NOMIC_MODEL:
                raise ValueError("only the approved Nomic model is supported")
            if not re.fullmatch("[0-9a-f]{12,64}", self.expected_digest):
                raise ValueError("expected model digest is required")
        elif self.expected_digest:
            raise ValueError("digest only applies to embedding")


class OrderInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0, strict=True)
    ids: list[str] = Field(max_length=100)


class ChainInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)


class VersionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=0, strict=True)


def validate_url(value: str) -> None:
    try:
        url = urlsplit(value)
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username is not None
            or url.password is not None
            or url.query
            or url.fragment
            or (url.port is not None and url.port <= 0)
        ):
            raise ValueError
        if url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError
        try:
            ip = ipaddress.ip_address(url.hostname)
        except ValueError:
            ip = None
        if ip is not None and not (ip.is_loopback or ip.is_global):
            raise ValueError
    except ValueError:
        raise ValueError("provider endpoint is not allowed") from None


def cipher(key: SecretStr) -> Fernet:
    try:
        return Fernet(key.get_secret_value().encode("ascii"))
    except (ValueError, UnicodeError):
        raise ProviderConfigurationError("provider encryption is not configured") from None


def encrypt(value: str, key: SecretStr) -> bytes | None:
    return cipher(key).encrypt(value.encode()) if value else None


def decrypt(value: bytes | None, key: SecretStr) -> str:
    if value is None:
        return ""
    try:
        return cipher(key).decrypt(value).decode()
    except (InvalidToken, UnicodeError):
        raise ProviderConfigurationError("provider credential cannot be decrypted") from None
