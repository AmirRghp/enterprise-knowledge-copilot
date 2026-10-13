"""Docker names are explicit exceptions, never a general private-network bypass."""

import asyncio

import pytest

from app.db.url import build_database_url
from app.provider_config.contracts import ProviderConfigurationError, ProviderInput, validate_url
from app.provider_config.transport import addresses
from app.settings import Settings


def test_compose_database_keeps_hyphenated_name() -> None:
    settings = Settings(db_name="enterprise-pgvector", db_host="postgres", db_port=5432)
    url = build_database_url(settings)
    assert (url.host, url.port, url.database) == ("postgres", 5432, "enterprise-pgvector")
    assert Settings.model_fields["api_bind_host"].default == "127.0.0.1"
    assert Settings(api_bind_host="0.0.0.0").api_bind_host == "0.0.0.0"
    with pytest.raises(ValueError):
        Settings(api_bind_host="invalid")


def test_only_ollama_provider_can_use_host_endpoint() -> None:
    validate_url("http://host.docker.internal:11434")
    ProviderInput(
        version=0,
        name="Docker",
        kind="ollama",
        model="test",
        base_url="http://host.docker.internal:11434",
    )
    with pytest.raises(ValueError):
        ProviderInput(
            version=0,
            name="Other",
            kind="openai_compatible",
            model="test",
            base_url="http://host.docker.internal:11434",
        )


@pytest.mark.parametrize(
    "url",
    [
        "http://ollama",
        "http://ollama:11434",
        "http://ollama:8000",
        "https://ollama:11434",
        "http://postgres:5432",
        "http://ollama.example:11434",
        "http://172.18.0.2:11434",
    ],
)
def test_compose_exception_does_not_allow_other_endpoints(url: str) -> None:
    with pytest.raises(ValueError):
        validate_url(url)


@pytest.mark.parametrize(
    "ip,allowed",
    [
        ("172.18.0.2", True),
        ("10.2.0.3", True),
        ("192.168.1.2", True),
        ("169.254.169.254", False),
        ("127.0.0.1", False),
        ("8.8.8.8", False),
        ("::1", False),
    ],
)
def test_compose_dns_accepts_only_private_docker_ips(monkeypatch, ip: str, allowed: bool) -> None:
    async def scenario() -> None:
        async def resolve(*args, **kwargs):
            return [(2, 1, 6, "", (ip, 11434))]

        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
        if allowed:
            assert await addresses("host.docker.internal", 11434) == [ip]
        else:
            with pytest.raises(ProviderConfigurationError):
                await addresses("host.docker.internal", 11434)
        if ip.startswith(("172.", "10.", "192.")):
            with pytest.raises(ProviderConfigurationError):
                await addresses("public.example", 11434)

    asyncio.run(scenario())
