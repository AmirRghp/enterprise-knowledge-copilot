"""Public manager flow, credentials, ordering and fail-closed fallback."""

import asyncio
import json
from dataclasses import replace
from uuid import uuid4

import httpx
import pytest
from cryptography.fernet import Fernet
from pydantic import SecretStr, ValidationError
from sqlalchemy import delete, update

from app.api.auth import get_settings
from app.db.models import EmbeddingReindex, ProviderChain, ProviderConfig
from app.provider_config.contracts import (
    ProviderConfigurationError,
    ProviderInput,
    decrypt,
    encrypt,
    validate_url,
)
from app.provider_config.runtime import (
    Connection,
    EmbeddingChain,
    GenerationChain,
    Runtime,
    bind_runtime,
)
from app.provider_config.transport import ProviderTransport, addresses
from app.providers.base import (
    EmbeddingModelChangedError,
    EmbeddingProviderError,
    EvidenceItem,
    RerankCandidate,
)
from app.providers.generation import (
    GenerationEvidenceError,
    GenerationProviderError,
    GenerationReferenceError,
)
from app.providers.retry import RetryableError
from app.settings import Settings
from tests.test_manager_api import _login_as, _scenario

KEY = Fernet.generate_key().decode()
ORIGIN = {"Origin": "http://localhost:3000"}


@pytest.fixture(autouse=True)
def panel_dns(monkeypatch):
    async def resolved(host, port):
        return ["127.0.0.1"] if host == "localhost" else ["93.184.216.34"]

    monkeypatch.setattr("app.api.providers.addresses", resolved)


def payload(version=0, **extra):
    return {
        "name": "مدل شرکت الف",
        "kind": "openai_compatible",
        "model": "model-a",
        "base_url": "https://models.example/v1",
        "api_key": "private-sentinel",
        "version": version,
        **extra,
    }


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
def test_name_boundary(name):
    with pytest.raises(ValidationError):
        ProviderInput(**payload(name=name))


@pytest.mark.parametrize("value", [0, 0.7, 2])
def test_chat_temperature_accepts_numeric_boundaries(value):
    parsed = ProviderInput(**payload(temperature=value))
    parsed.for_purpose("chat")
    assert parsed.temperature == value


@pytest.mark.parametrize("value", [-0.1, 2.1, float("nan"), float("inf"), True, "0.7", None])
def test_chat_temperature_rejects_invalid_values(value):
    with pytest.raises(ValidationError):
        ProviderInput(**payload(temperature=value))


@pytest.mark.parametrize("purpose", ["rerank", "embedding"])
def test_temperature_cannot_be_set_for_non_chat_providers(purpose):
    with pytest.raises(ValueError, match="temperature only applies to chat"):
        ProviderInput(**payload(temperature=0.7)).for_purpose(purpose)


@pytest.mark.parametrize("kind", ["ollama", "openai", "openai_compatible", "openrouter"])
def test_each_fallback_connection_sends_its_own_temperature(monkeypatch, kind):
    async def body():
        settings = configured(monkeypatch, kind=kind)
        items = settings._provider_runtime.connections["chat"]
        items[:] = [replace(c, temperature=t) for c, t in zip(items, [0.0, 1.25], strict=True)]
        sent = []

        def transport(request):
            sent.append(json.loads(request.content)["temperature"])
            return httpx.Response(503) if len(sent) == 1 else httpx.Response(200, json=completion())

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            from app.providers.retry import RetryPolicy

            chain = GenerationChain(settings, client=client, policy=RetryPolicy(attempts=1))
            await chain.generate(question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")])
            assert sent == [0.0, 1.25]

    asyncio.run(body())


def test_chat_temperature_defaults_persists_and_invalidates_the_old_probe(monkeypatch):
    async def body(engine, factory, client):
        import app.api.providers as module

        await reset(engine, client)
        await _login_as(client, "manager")
        response = await client.post("/api/manager/providers/chat", json=payload(), headers=ORIGIN)
        row = response.json()["chat"]["providers"][0]
        assert row["temperature"] == 0.7

        async def generate(self, **kwargs):
            assert self.items[0].temperature == 0.7

        monkeypatch.setattr(module.GenerationChain, "generate", generate)
        assert (
            await client.post(
                f"/api/manager/providers/chat/{row['id']}/test", json={"version": 1}, headers=ORIGIN
            )
        ).json() == {"status": "passed"}
        response = await client.put(
            f"/api/manager/providers/chat/{row['id']}",
            json=payload(1, temperature=0, api_key=""),
            headers=ORIGIN,
        )
        saved = response.json()["chat"]["providers"][0]
        assert saved["temperature"] == 0 and saved["test_status"] is None
        assert saved["has_api_key"]
        configured = await bind_runtime(
            client._transport.app.dependency_overrides[get_settings](), factory
        )
        assert configured._provider_runtime.connections["chat"][0].temperature == 0
        # An older client omitting the new field must not reset an edited value.
        response = await client.put(
            f"/api/manager/providers/chat/{row['id']}",
            json=payload(2, api_key=""),
            headers=ORIGIN,
        )
        assert response.json()["chat"]["providers"][0]["temperature"] == 0

    _scenario(body)


def test_ollama_probe_without_live_digest_cannot_activate(monkeypatch):
    async def body(engine, factory, client):
        import app.api.providers as module

        await reset(engine, client)
        await _login_as(client, "manager")
        created = await client.post(
            "/api/manager/providers/embedding",
            json=payload(
                kind="ollama", model="sample:latest", base_url="http://localhost:11434", api_key=""
            ),
            headers=ORIGIN,
        )
        provider_id = created.json()["embedding"]["providers"][0]["id"]

        async def query(self, text):
            return [0.1, 0.2]

        async def documents(self, texts):
            return [[0.3, 0.4]]

        monkeypatch.setattr(module.EmbeddingChain, "embed_query", query)
        monkeypatch.setattr(module.EmbeddingChain, "embed_documents", documents)
        result = await client.post(
            f"/api/manager/providers/embedding/{provider_id}/test",
            json={"version": 1},
            headers=ORIGIN,
        )
        assert result.json() == {"status": "failed"}
        activation = await client.post(
            f"/api/manager/providers/embedding/{provider_id}/activate",
            json={"version": 1, "confirmed": False},
            headers=ORIGIN,
        )
        assert activation.status_code == 409

        async def pinned_query(self, text):
            self.last_digest = "a" * 64
            return [0.1, 0.2]

        monkeypatch.setattr(module.EmbeddingChain, "embed_query", pinned_query)
        result = await client.post(
            f"/api/manager/providers/embedding/{provider_id}/test",
            json={"version": 1},
            headers=ORIGIN,
        )
        assert result.json() == {"status": "passed"}
        activation = await client.post(
            f"/api/manager/providers/embedding/{provider_id}/activate",
            json={"version": 1, "confirmed": False},
            headers=ORIGIN,
        )
        assert activation.json() == {"requires_confirmation": False, "total": 0, "active": True}

    _scenario(body)


@pytest.mark.parametrize(
    "url",
    [
        "http://10.0.0.1:80",
        "http://169.254.169.254",
        "https://10.0.0.1",
        "https://169.254.169.254",
        "https://user:key@example.com",
        "https://example.com?token=secret",
        "https://example.com#token",
    ],
)
def test_bad_endpoint(url):
    with pytest.raises(ValueError):
        validate_url(url)


def test_credential_encryption_and_wrong_key_fail_closed():
    ciphertext = encrypt("secret-sentinel", SecretStr(KEY))
    assert ciphertext and b"secret-sentinel" not in ciphertext
    assert decrypt(ciphertext, SecretStr(KEY)) == "secret-sentinel"
    with pytest.raises(ProviderConfigurationError) as caught:
        decrypt(ciphertext, SecretStr(Fernet.generate_key().decode()))
    assert "secret-sentinel" not in str(caught.value)


async def reset(engine, client):
    async with engine.begin() as db:
        await db.execute(delete(EmbeddingReindex))
        await db.execute(delete(ProviderConfig))
        await db.execute(
            update(ProviderChain).values(version=0, enabled=False, active_provider_id=None)
        )
    client._transport.app.dependency_overrides[get_settings] = lambda: Settings(
        db_name="enterprise_knowledge_copilot_test", app_encryption_key=KEY
    )


def test_manager_crud_order_versions_and_secrets():
    async def body(engine, factory, client):
        await reset(engine, client)
        assert (await client.get("/api/manager/providers")).status_code == 401
        await _login_as(client, "employee")
        assert (await client.get("/api/manager/providers")).status_code == 403
        await _login_as(client, "manager")
        assert (await client.post("/api/manager/providers/chat", json=payload())).status_code == 403
        response = await client.post("/api/manager/providers/chat", json=payload(), headers=ORIGIN)
        assert response.status_code == 201, response.text
        first = response.json()["chat"]["providers"][0]
        assert first["name"] == "مدل شرکت الف" and first["has_api_key"]
        assert "private-sentinel" not in response.text and "api_key_encrypted" not in response.text
        assert (
            await client.post("/api/manager/providers/chat", json=payload(), headers=ORIGIN)
        ).status_code == 409
        response = await client.post(
            "/api/manager/providers/chat", json=payload(1, name="شرکت ب"), headers=ORIGIN
        )
        second = response.json()["chat"]["providers"][1]
        response = await client.put(
            "/api/manager/providers/chat/order",
            json={"version": 2, "ids": [second["id"], first["id"]]},
            headers=ORIGIN,
        )
        assert response.status_code == 200, response.text
        assert response.json()["chat"]["providers"][0]["name"] == "شرکت ب"
        response = await client.put(
            "/api/manager/providers/chat/" + first["id"],
            json=payload(3, api_key="", name="الف جدید"),
            headers=ORIGIN,
        )
        assert (
            response.status_code == 200 and response.json()["chat"]["providers"][1]["has_api_key"]
        )
        async with factory() as session:
            row = await session.get(ProviderConfig, first["id"])
            assert row.api_key_encrypted and b"private-sentinel" not in row.api_key_encrypted
        response = await client.request(
            "DELETE",
            "/api/manager/providers/chat/" + first["id"],
            json={"version": 4},
            headers=ORIGIN,
        )
        assert response.status_code == 204 and not response.content
        assert (
            await client.patch(
                "/api/manager/providers/rerank",
                json={"version": 0, "enabled": True},
                headers=ORIGIN,
            )
        ).status_code == 422
        assert (
            await client.post(
                "/api/manager/providers/chat",
                content=b"x" * 65537,
                headers={**ORIGIN, "Content-Type": "application/json"},
            )
        ).status_code == 413
        # Panel emptiness is real, not a default taken from the old .env.
        await reset(engine, client)
        configured = await bind_runtime(Settings(app_encryption_key=KEY), factory)
        with pytest.raises(ProviderConfigurationError):
            GenerationChain(configured, client=client)

    _scenario(body)


def test_unconfigured_upload_does_not_stage():
    async def body(engine, factory, client):
        await reset(engine, client)
        await _login_as(client, "manager")
        response = await client.post(
            "/api/manager/documents", headers=ORIGIN, files={"file": ("a.md", b"# Text")}
        )
        assert response.status_code == 503

    _scenario(body)


def configured(monkeypatch, kind="openai_compatible"):
    items = [
        Connection(uuid4(), 1, kind, "model-" + str(i), "https://example.com/v1", "a" * 12, "key")
        for i in range(2)
    ]
    runtime = Runtime(
        None, {"chat": items, "rerank": items, "embedding": items}, False, items[0].id
    )

    async def check(self, c):
        pass

    monkeypatch.setattr(Runtime, "check", check)
    settings = Settings(_env_file=None)
    object.__setattr__(settings, "_provider_runtime", runtime)
    return settings


def completion():
    return {
        "choices": [
            {
                "finish_reason": "stop",
                "message": {
                    "content": json.dumps(
                        {
                            "claims": [
                                {
                                    "text": "نام شرکت نمونه است.",
                                    "evidence_id": "E1",
                                    "quote": "نام شرکت",
                                }
                            ],
                            "abstained": False,
                            "missing_parts": [],
                            "answer": "",
                        }
                    )
                },
            }
        ],
        "usage": {"prompt_tokens": 3, "completion_tokens": 4},
    }


@pytest.mark.parametrize("kind", ["ollama", "openai", "openai_compatible", "openrouter"])
def test_ollama_structured_generation_disables_thinking_without_changing_other_providers(
    monkeypatch, kind
):
    async def body():
        settings = configured(monkeypatch, kind=kind)
        sent = []

        def transport(request):
            payload = json.loads(request.content)
            sent.append(payload)
            assert payload["response_format"]["type"] == "json_schema"
            if kind == "ollama" and payload.get("reasoning_effort") != "none":
                return httpx.Response(
                    200,
                    json={"choices": [{"finish_reason": "length", "message": {"content": ""}}]},
                )
            return httpx.Response(200, json=completion())

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = GenerationChain(settings, client=client)
            result = await chain.generate(
                question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")]
            )
            assert len(result.claims) == 1 and len(sent) == 1
            if kind == "ollama":
                assert sent[0]["reasoning_effort"] == "none"
            else:
                assert "reasoning_effort" not in sent[0]

    asyncio.run(body())


def test_fallback_refresh_and_usage(monkeypatch):
    async def body():
        settings = configured(monkeypatch)
        sent = []
        refreshes = []

        def transport(request):
            sent.append(json.loads(request.content))
            return httpx.Response(
                401 if len(sent) == 1 else 200,
                json={"usage": {"prompt_tokens": 1, "completion_tokens": 0}}
                if len(sent) == 1
                else completion(),
            )

        async def refresh():
            refreshes.append(1)
            return [
                EvidenceItem(
                    "E1", "نام شرکت تازه است." if len(refreshes) > 1 else "نام شرکت قدیمی است."
                )
            ]

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = GenerationChain(settings, client=client)
            await chain.generate(
                question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")], refresh=refresh
            )
            assert len(sent) == 2 and len(refreshes) == 2
            assert (
                "تازه" in sent[1]["messages"][1]["content"]
                and "قدیمی" not in sent[1]["messages"][1]["content"]
            )
            assert "provider" not in sent[1]
            assert len(chain.last_usages) == 2 and chain.last_usage.input_tokens == 4
            assert chain.last_usage.cost is None

    asyncio.run(body())


def test_revocation_stops_fallback_before_second_send(monkeypatch):
    async def body():
        settings = configured(monkeypatch)
        sent = []
        calls = []

        def transport(request):
            sent.append(1)
            return httpx.Response(401, json={})

        async def refresh():
            calls.append(1)
            return [EvidenceItem("E1", "نام شرکت")] if len(calls) == 1 else []

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = GenerationChain(settings, client=client)
            with pytest.raises(GenerationEvidenceError):
                await chain.generate(
                    question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")], refresh=refresh
                )
            assert len(sent) == 1

    asyncio.run(body())


def test_invented_handle_does_not_fallback(monkeypatch):
    async def body():
        settings = configured(monkeypatch)
        sent = []

        def transport(request):
            sent.append(1)
            data = completion()
            data["choices"][0]["message"]["content"] = data["choices"][0]["message"][
                "content"
            ].replace("E1", "E99")
            return httpx.Response(200, json=data)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            with pytest.raises(GenerationReferenceError):
                await GenerationChain(settings, client=client).generate(
                    question="?", evidence=[EvidenceItem("E1", "نام شرکت")]
                )
            assert len(sent) == 1

    asyncio.run(body())


def test_digest_change_is_terminal(monkeypatch):
    async def body():
        settings = configured(monkeypatch, kind="ollama")
        sent = []

        def transport(request):
            sent.append(1)
            return httpx.Response(200, json={"models": [{"name": "model-0", "digest": "b" * 64}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            with pytest.raises(EmbeddingModelChangedError):
                await EmbeddingChain(settings, client=client).embed_query("query")
            assert len(sent) == 1

    asyncio.run(body())


def test_embedding_failure_never_falls_back_to_another_connection(monkeypatch):
    async def body():
        settings = configured(monkeypatch, kind="ollama")
        runtime = settings._provider_runtime
        model = "nomic-embed-text-v2-moe:latest"
        runtime.connections["embedding"] = [
            replace(c, model=model, base_url=f"http://localhost:{11434 + i}", key="")
            for i, c in enumerate(runtime.connections["embedding"])
        ]
        sent = []

        def transport(request):
            sent.append(request.url.port)
            if request.url.port == 11434:
                return httpx.Response(503)
            if request.url.path == "/api/tags":
                return httpx.Response(200, json={"models": [{"name": model, "digest": "a" * 64}]})
            assert json.loads(request.content)["truncate"] is False
            return httpx.Response(200, json={"embeddings": [[0.1] * 768]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = EmbeddingChain(settings, client=client, attempt_timeout=3)
            with pytest.raises((RetryableError, EmbeddingProviderError)):
                await chain.embed_query("synthetic query")
            assert sent and set(sent) == {11434}

    asyncio.run(body())


def test_dns_rejects_private_addresses(monkeypatch):
    async def body():
        async def resolve(*args, **kwargs):
            return [(2, 1, 6, "", ("10.1.2.3", 443))]

        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
        with pytest.raises(ProviderConfigurationError):
            await addresses("public.example", 443)

    asyncio.run(body())


def test_transport_pins_ip_and_keeps_tls_hostname(monkeypatch):
    async def body():
        import app.provider_config.transport as module

        async def resolved(*args):
            return ["8.8.8.8"]

        monkeypatch.setattr(module, "addresses", resolved)
        real_client = httpx.AsyncClient
        captured = []

        def handle(request):
            captured.append(request)
            return httpx.Response(200, json={"ok": True})

        monkeypatch.setattr(
            module.httpx,
            "AsyncClient",
            lambda **kwargs: real_client(transport=httpx.MockTransport(handle)),
        )
        result = await ProviderTransport().handle_async_request(
            httpx.Request("POST", "https://models.example/v1/chat/completions", json={})
        )
        assert result.status_code == 200
        assert captured[0].url.host == "8.8.8.8" and captured[0].headers["Host"] == "models.example"
        assert captured[0].extensions["sni_hostname"] == "models.example"

    asyncio.run(body())


def test_two_simultaneous_creates_cannot_share_a_version():
    async def body(engine, factory, client):
        await reset(engine, client)
        await _login_as(client, "manager")
        results = await asyncio.gather(
            *[
                client.post("/api/manager/providers/chat", json=payload(name=name), headers=ORIGIN)
                for name in ("شرکت الف", "شرکت ب")
            ]
        )
        assert sorted(r.status_code for r in results) == [201, 409]
        listing = (await client.get("/api/manager/providers")).json()
        assert listing["chat"]["version"] == 1 and len(listing["chat"]["providers"]) == 1

    _scenario(body)


def test_embedding_candidates_can_use_distinct_models_before_first_index():
    async def body(engine, factory, client):
        await reset(engine, client)
        await _login_as(client, "manager")
        embedding = payload(
            kind="ollama",
            model="nomic-embed-text-v2-moe:latest",
            base_url="http://localhost:11434",
            api_key="",
            expected_digest="a" * 12,
        )
        assert (
            await client.post("/api/manager/providers/embedding", json=embedding, headers=ORIGIN)
        ).status_code == 201
        second = {
            **embedding,
            "version": 1,
            "name": "اتصال دوم",
            "base_url": "http://localhost:11435",
        }
        response = await client.post(
            "/api/manager/providers/embedding", json=second, headers=ORIGIN
        )
        assert response.status_code == 201
        first = response.json()["embedding"]["providers"][0]["id"]
        changed = {**embedding, "version": 2, "expected_digest": "b" * 12}
        assert (
            await client.put(
                "/api/manager/providers/embedding/" + first, json=changed, headers=ORIGIN
            )
        ).status_code == 200

    _scenario(body)


def test_deleted_connection_is_fenced_before_any_send():
    async def body(engine, factory, client):
        await reset(engine, client)
        await _login_as(client, "manager")
        await client.post("/api/manager/providers/chat", json=payload(), headers=ORIGIN)
        configured = await bind_runtime(Settings(app_encryption_key=KEY), factory)
        async with engine.begin() as db:
            await db.execute(delete(ProviderConfig))
        sent = []

        def transport(request):
            sent.append(request)
            return httpx.Response(200, json=completion())

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as upstream:
            with pytest.raises(GenerationProviderError):
                await GenerationChain(configured, client=upstream).generate(
                    question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")]
                )
        assert not sent

    _scenario(body)


def test_timeout_keeps_usage_unknown_and_gives_next_provider_time(monkeypatch):
    async def body():
        settings = configured(monkeypatch)
        calls = []

        async def transport(request):
            calls.append(request)
            if len(calls) == 1:
                await asyncio.sleep(1)
            return httpx.Response(200, json=completion())

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = GenerationChain(settings, client=client)
            import time

            chain.runtime.deadline = time.monotonic() + 0.08
            await chain.generate(question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")])
            assert len(calls) == 2 and len(chain.last_usages) == 2
            assert chain.last_usages[0].cost is None and chain.last_usage.input_tokens is None

    asyncio.run(body())


def test_empty_rerank_gate_is_terminal(monkeypatch):
    async def body():
        from app.provider_config.runtime import RerankChain
        from app.providers.rerank import RerankEvidenceError

        settings = configured(monkeypatch)
        sent = []
        refreshes = []

        async def refresh():
            refreshes.append(1)
            return []

        def transport(request):
            sent.append(request)
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            with pytest.raises(RerankEvidenceError):
                await RerankChain(settings, client=client).rerank(
                    "query",
                    [RerankCandidate(uuid4(), "text")],
                    top_n=1,
                    refresh=refresh,
                )
        assert not sent and len(refreshes) == 1

    asyncio.run(body())


def test_late_probe_result_cannot_mark_an_edited_connection_healthy(monkeypatch):
    async def body(engine, factory, client):
        import app.api.providers as module

        await reset(engine, client)
        await _login_as(client, "manager")
        created = await client.post("/api/manager/providers/chat", json=payload(), headers=ORIGIN)
        id = created.json()["chat"]["providers"][0]["id"]

        async def generate(self, **kwargs):
            async with engine.begin() as db:
                await db.execute(update(ProviderConfig).values(config_version=2, test_status=None))
            return None

        monkeypatch.setattr(module.GenerationChain, "generate", generate)
        result = await client.post(
            "/api/manager/providers/chat/" + id + "/test", json={"version": 1}, headers=ORIGIN
        )
        assert result.status_code == 409
        async with factory() as session:
            row = await session.get(ProviderConfig, id)
            assert row.test_status is None

    _scenario(body)


def test_resident_worker_waits_without_claiming_and_resumes_from_panel(monkeypatch):
    async def body(engine, factory, client):
        from app.cli.run_worker import PanelWorker
        from app.db.models import IngestionJob
        from app.ingestion.worker import IngestionWorker
        from tests.test_ingestion import WordCounter, _upload

        await reset(engine, client)
        await _login_as(client, "manager")
        embedding = payload(
            kind="ollama",
            model="nomic-embed-text-v2-moe:latest",
            api_key="",
            base_url="http://localhost:11434",
            expected_digest="a" * 12,
        )
        created = await client.post(
            "/api/manager/providers/embedding", json=embedding, headers=ORIGIN
        )
        id = created.json()["embedding"]["providers"][0]["id"]
        job = await _upload(factory)
        removed = await client.request(
            "DELETE",
            "/api/manager/providers/embedding/" + id,
            json={"version": 1},
            headers=ORIGIN,
        )
        assert removed.status_code == 204
        worker = PanelWorker(
            Settings(db_name="enterprise_knowledge_copilot_test", app_encryption_key=KEY),
            "hot-panel",
        )
        calls = []

        def transport(request):
            calls.append(request)
            if request.url.path == "/api/tags":
                return httpx.Response(
                    200,
                    json={
                        "models": [
                            {
                                "name": embedding["model"],
                                "digest": "a" * 64,
                            }
                        ]
                    },
                )
            assert request.url.path == "/api/embed"
            body = json.loads(request.content)
            assert body["truncate"] is False
            return httpx.Response(200, json={"embeddings": [[0.1] * 768 for _ in body["input"]]})

        monkeypatch.setattr(
            "app.provider_config.transport.provider_client",
            lambda **kwargs: httpx.AsyncClient(transport=httpx.MockTransport(transport)),
        )
        monkeypatch.setattr(
            "app.cli.run_worker.IngestionWorker",
            lambda **kwargs: IngestionWorker(counter=WordCounter(), **kwargs),
        )
        try:
            assert await worker.process_next_job() is None
            async with factory() as session:
                row = await session.get(IngestionJob, job.job_id)
                assert row.status == "pending" and row.attempt_count == 0
            rejected = await client.post(
                "/api/manager/providers/embedding",
                json={**embedding, "version": 2, "expected_digest": "b" * 12},
                headers=ORIGIN,
            )
            assert rejected.status_code == 201
            resumed = await client.post(
                "/api/manager/providers/embedding", json={**embedding, "version": 3}, headers=ORIGIN
            )
            assert resumed.status_code == 201, resumed.text
            assert await worker.process_next_job() is None
            assert not calls
        finally:
            await worker.aclose()

    _scenario(body)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1, True, 0.5])
def test_invalid_usage_numbers_stay_unknown(value):
    from app.providers.generation import _UsageAccumulator
    from app.providers.rerank import _usage_from

    accumulator = _UsageAccumulator()
    accumulator.record({"usage": {"prompt_tokens": value, "cost": value}})
    usage = accumulator.finish(provider="openai_compatible", model="m")
    assert usage.input_tokens is None
    if value != 0.5:
        assert usage.cost is None
        assert _usage_from({"total_tokens": value, "cost": value}, "custom", "m").cost is None


@pytest.mark.parametrize("key", ["api\nkey", "api\rkey", "api key", "کلید"])
def test_credentials_that_cannot_form_a_header_are_rejected_without_input(key):
    with pytest.raises(ValidationError) as caught:
        ProviderInput(**payload(api_key=key))
    assert key not in str(caught.value)


def test_provider_version_is_a_json_integer_not_a_boolean():
    with pytest.raises(ValidationError):
        ProviderInput(**payload(version=True))


def test_usage_record_keeps_provider_identity_and_unknown_figures():
    from app.providers.base import ProviderUsage
    from app.providers.usage import usage_record

    record = usage_record(
        ProviderUsage(provider="openai_compatible", model="company-model", attempts=2)
    )
    assert record["provider"] == "openai_compatible" and record["model"] == "company-model"
    assert record["attempts"] == 2 and record["cost"] is None and record["input_tokens"] is None


def test_unknown_currency_does_not_combine_different_provider_costs():
    from decimal import Decimal

    from app.providers.base import ProviderUsage
    from app.providers.usage import summarize_usage

    usages = [
        ProviderUsage(provider=kind, model="m", cost=Decimal("1"))
        for kind in ("openai", "openrouter")
    ]
    assert summarize_usage(usages).cost is None


@pytest.mark.parametrize("filtered", [True, False])
def test_valid_policy_refusal_does_not_send_to_the_next_provider(monkeypatch, filtered):
    from app.providers.generation import GenerationRefusalError

    async def body():
        settings = configured(monkeypatch)
        calls = []

        def transport(request):
            calls.append(request)
            result = completion()
            if filtered:
                result["choices"][0]["finish_reason"] = "content_filter"
            else:
                result["choices"][0]["message"]["refusal"] = "synthetic policy refusal"
            return httpx.Response(200, json=result)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            chain = GenerationChain(settings, client=client)
            with pytest.raises(GenerationRefusalError):
                await chain.generate(question="نام؟", evidence=[EvidenceItem("E1", "نام شرکت")])
            assert len(calls) == 1 and len(chain.last_usages) == 1

    asyncio.run(body())


def test_evaluation_retains_both_ranking_calls_even_without_generation(monkeypatch):
    from contextlib import asynccontextmanager
    from decimal import Decimal
    from types import SimpleNamespace

    from app.cli import eval_run
    from app.providers.base import ProviderUsage
    from app.retrieval.contracts import RetrievalConfig
    from tests.test_eval_run import _sample

    class Reranker:
        def __init__(self):
            self.last_usages = []
            self.last_usage = None

        async def rerank(self):
            self.last_usages = [
                ProviderUsage(
                    provider="openrouter",
                    model="rerank",
                    attempts=1,
                    cost=Decimal("1"),
                    currency="credits",
                )
            ]
            return []

    @asynccontextmanager
    async def factory():
        yield None

    async def retrieve(*args, **kwargs):
        await kwargs["rerank_provider"].rerank()
        return []

    async def answer(*args, **kwargs):
        await kwargs["rerank_provider"].rerank()
        return SimpleNamespace(
            abstained=True,
            missing_parts=["insufficient_evidence"],
            claims=[],
            sources=[],
            usage=None,
        )

    monkeypatch.setattr(eval_run, "retrieve", retrieve)
    monkeypatch.setattr(eval_run, "answer", answer)

    from tests.test_retrieval import _actor

    async def body():
        reranker = eval_run._CountingReranker(Reranker())
        for _ in range(2):
            record = await eval_run._run_sample(
                factory,
                _actor("employee"),
                _sample(),
                None,
                None,
                False,
                retrieval_config=RetrievalConfig(rerank_enabled=True),
                rerank_provider=reranker,
            )
            assert not record.usage["provider_was_called"]
            assert len(record.usage["provider_usages"]) == 2
            assert [r["cost"] for r in record.usage["provider_usages"]] == ["1", "1"]

    asyncio.run(body())


def test_localhost_can_use_ipv4_when_ipv6_is_not_listening(monkeypatch):
    from app.provider_config.transport import provider_client

    async def body():
        requests = []

        async def handler(reader, writer):
            requests.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(handler, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]

        async def resolve(host, requested_port):
            assert host == "localhost" and requested_port == port
            return ["::1", "127.0.0.1"]

        monkeypatch.setattr("app.provider_config.transport.addresses", resolve)
        try:
            async with provider_client(timeout=1) as client:
                response = await client.get(f"http://localhost:{port}/api/tags")
                assert response.status_code == 200
            assert len(requests) == 1 and f"Host: localhost:{port}".encode() in requests[0]
        finally:
            server.close()
            await server.wait_closed()

    asyncio.run(body())


def test_dns_rebinding_stops_retry_and_fallback(monkeypatch):
    async def body():
        settings = configured(monkeypatch)
        resolutions = []

        async def resolve(*args, **kwargs):
            resolutions.append(args[0])
            return [(2, 1, 6, "", ("10.1.2.3", 443))]

        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", resolve)
        async with httpx.AsyncClient(transport=ProviderTransport()) as client:
            chain = GenerationChain(settings, client=client)
            with pytest.raises(ProviderConfigurationError):
                await chain.generate(
                    question="synthetic", evidence=[EvidenceItem("E1", "synthetic")]
                )
            assert resolutions == ["example.com"]

    asyncio.run(body())


@pytest.mark.parametrize("error", [TimeoutError(), RetryableError("private-sentinel")])
def test_transient_embedding_probe_is_a_sanitized_failed_test(monkeypatch, error):
    async def body(engine, factory, client):
        import app.api.providers as module

        await reset(engine, client)
        await _login_as(client, "manager")
        created = await client.post(
            "/api/manager/providers/embedding",
            json=payload(
                kind="ollama",
                model="nomic-embed-text-v2-moe:latest",
                base_url="http://localhost:11434",
                api_key="",
                expected_digest="a" * 12,
            ),
            headers=ORIGIN,
        )
        provider_id = created.json()["embedding"]["providers"][0]["id"]

        async def embed_query(self, text):
            raise error

        monkeypatch.setattr(module.EmbeddingChain, "embed_query", embed_query)
        response = await client.post(
            f"/api/manager/providers/embedding/{provider_id}/test",
            json={"version": 1},
            headers=ORIGIN,
        )
        assert response.status_code == 200 and response.json() == {"status": "failed"}
        assert "private-sentinel" not in response.text
        listing = (await client.get("/api/manager/providers")).json()
        assert listing["embedding"]["providers"][0]["test_status"] == "failed"

    _scenario(body)
