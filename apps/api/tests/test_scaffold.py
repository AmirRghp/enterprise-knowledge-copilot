import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from pydantic_settings import SettingsConfigDict

from app import main, settings


class IsolatedSettings(settings.Settings):
    model_config = SettingsConfigDict(env_file=None)


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in settings.Settings.model_fields:
        monkeypatch.delenv(name.upper(), raising=False)
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(settings, "Settings", IsolatedSettings)


def test_public_health_without_credentials() -> None:
    async def request_health() -> None:
        transport = ASGITransport(app=main.create_app())
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get("/api/health")
            assert response.status_code == 200
            assert response.json() == {"status": "ok"}

    asyncio.run(request_health())


def test_root_dotenv_and_environment_priority(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    env_path = tmp_path / ".env"
    env_path.write_text("DB_PORT=5444\nOPENROUTER_API_KEY=fake-private-key\n", encoding="utf-8")

    class FileSettings(IsolatedSettings):
        model_config = SettingsConfigDict(env_file=env_path)

    monkeypatch.chdir(tmp_path.parent)
    monkeypatch.setattr(settings, "Settings", FileSettings)
    assert settings.load_settings().db_port == 5444
    monkeypatch.setenv("DB_PORT", "5433")
    config = settings.load_settings()
    assert config.db_port == 5433
    assert "fake-private-key" not in repr(config)
    assert settings.ROOT_ENV == Path(__file__).resolve().parents[3] / ".env"


def test_env_example_loads_as_typed_settings() -> None:
    class ExampleSettings(IsolatedSettings):
        model_config = SettingsConfigDict(env_file=settings.ROOT_ENV.with_name(".env.example"))

    config = ExampleSettings()
    assert config.embedding_dimension == 768
    assert config.embedding_truncate is False
    assert config.rerank_enabled is False
    assert config.db_password.get_secret_value() == ""


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("DB_PORT", "0"),
        ("DB_NAME", "postgres"),
        ("EMBEDDING_DIMENSION", "1024"),
        ("OLLAMA_BASE_URL", "file:///tmp/private"),
        ("EMBEDDING_TRUNCATE", "true"),
        ("RERANK_ENABLED", "maybe"),
        ("SESSION_TTL_SECONDS", "-1"),
    ],
)
def test_invalid_configuration_is_safe(
    name: str, value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(name, value)
    with pytest.raises(settings.ConfigurationError, match=name):
        main.create_app()


def test_invalid_value_never_leaks(monkeypatch: pytest.MonkeyPatch) -> None:
    marker = "fake-sensitive-value"
    monkeypatch.setenv("OLLAMA_BASE_URL", marker)
    with pytest.raises(settings.ConfigurationError) as error:
        settings.load_settings()
    assert marker not in str(error.value)
    with pytest.raises(ValidationError) as raw:
        IsolatedSettings()
    assert marker not in str(raw.value)


def test_invalid_startup_exits_without_echoing_values() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "app"],
        env={**os.environ, "DB_PORT": "fake-sensitive-value"},
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 2
    assert "DB_PORT: int_parsing" in result.stderr
    assert "fake-sensitive-value" not in result.stdout + result.stderr
    assert "Traceback" not in result.stderr
