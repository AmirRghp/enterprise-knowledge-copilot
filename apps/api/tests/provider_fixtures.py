"""Explicit panel configuration for isolated tests; no test reads provider environment values."""

import base64
from types import SimpleNamespace
from uuid import uuid4

from pydantic import SecretStr
from sqlalchemy import delete, update

from app.db.models import ProviderChain, ProviderConfig
from app.provider_config.contracts import encrypt
from app.provider_config.runtime import Connection, Runtime
from app.settings import Settings

TEST_ENCRYPTION_KEY = base64.urlsafe_b64encode(b"p" * 32).decode()


class SnapshotFactory:
    def __init__(self, connections):
        self.connections = connections

    def __call__(self):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, model, id):
        row = next((c for c in self.connections if c.id == id), None)
        return SimpleNamespace(config_version=row.version) if row else None


def panel_settings(settings: Settings) -> Settings:
    key = settings.openrouter_api_key.get_secret_value()
    connections = {
        "chat": [
            Connection(
                uuid4(),
                1,
                "openrouter",
                settings.openrouter_model,
                str(settings.openrouter_base_url),
                "",
                key,
            )
        ]
        if key
        else [],
        "rerank": [
            Connection(
                uuid4(),
                1,
                "openrouter",
                settings.openrouter_rerank_model,
                str(settings.openrouter_base_url),
                "",
                key,
            )
        ]
        if key
        else [],
        "embedding": [
            Connection(
                uuid4(),
                1,
                "ollama",
                settings.ollama_embed_model,
                str(settings.ollama_base_url),
                settings.ollama_embed_digest,
                "",
            )
        ],
    }
    factory = SnapshotFactory([c for items in connections.values() for c in items])
    object.__setattr__(
        settings, "_provider_runtime", Runtime(factory, connections, settings.rerank_enabled)
    )
    return settings


async def seed_panel(engine, settings: Settings | None = None):
    settings = settings or Settings(openrouter_api_key="unit-test-key")
    async with engine.begin() as db:
        await db.execute(delete(ProviderConfig))
        await db.execute(
            update(ProviderChain).values(version=0, enabled=False, embedding_digest="")
        )
        await db.execute(
            update(ProviderChain)
            .where(ProviderChain.purpose == "rerank")
            .values(enabled=settings.rerank_enabled)
        )
        for purpose, model in [
            ("chat", settings.openrouter_model),
            ("rerank", settings.openrouter_rerank_model),
            ("embedding", settings.ollama_embed_model),
        ]:
            await db.execute(
                ProviderConfig.__table__.insert().values(
                    provider_id=uuid4(),
                    purpose=purpose,
                    name="اتصال آزمون",
                    kind="ollama" if purpose == "embedding" else "openrouter",
                    model=model,
                    base_url=str(settings.ollama_base_url)
                    if purpose == "embedding"
                    else str(settings.openrouter_base_url),
                    expected_digest=settings.ollama_embed_digest if purpose == "embedding" else "",
                    api_key_encrypted=encrypt(
                        settings.openrouter_api_key.get_secret_value() or "unit-test-key",
                        SecretStr(TEST_ENCRYPTION_KEY),
                    )
                    if purpose != "embedding"
                    else None,
                    config_version=1,
                    priority=0,
                )
            )
