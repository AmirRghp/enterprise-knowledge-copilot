"""Fresh user authority belongs in the SQL allowlist, including in-flight work."""

import pytest
from sqlalchemy import update

from app.db.models import User
from app.retrieval import store
from tests.test_retrieval import (
    EMPLOYEE_DOCUMENT,
    EMPLOYEE_TEXT,
    MANAGER_DOCUMENT,
    MANAGER_TEXT,
    _actor,
    _publish,
    _scenario,
)


@pytest.mark.parametrize(
    "changes,expected", [({"role": "employee"}, {EMPLOYEE_DOCUMENT}), ({"is_active": False}, set())]
)
def test_cached_manager_actor_loses_forbidden_documents_at_every_read(changes, expected):
    async def scenario(engine, factory):
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        await _publish(
            factory, document_id=MANAGER_DOCUMENT, text=MANAGER_TEXT, access_role="manager"
        )
        actor = _actor("manager")
        async with factory() as session:
            old = await store.read_eligible_chunks(session, actor)
        async with factory() as session:
            await session.execute(
                update(User).where(User.user_id == actor.user_id).values(**changes)
            )
            await session.commit()
        async with factory() as session:
            assert {
                x.document_id for x in await store.list_retrievable_documents(session, actor)
            } == expected
            rows = await store.read_ranked_chunks(
                session, actor, chunk_ids=[x.chunk_id for x in old]
            )
            assert {x.document_id for x in rows.values()} == expected

    _scenario(scenario)


def test_disabled_account_cannot_send_evidence_on_generation_retry():
    import httpx

    from app.answer.schemas import AnswerConfig
    from app.answer.service import answer
    from app.providers.generation import OpenRouterGenerationProvider
    from app.providers.retry import RetryPolicy
    from tests.test_retrieval import FakeProvider

    async def scenario(engine, factory):
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        actor = _actor("employee")
        requests = []

        async def transport(request):
            requests.append(request)
            async with factory() as session:
                await session.execute(
                    update(User).where(User.user_id == actor.user_id).values(is_active=False)
                )
                await session.commit()
            return httpx.Response(503)

        async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
            generator = OpenRouterGenerationProvider(
                client,
                base_url="https://local.test/v1",
                model="fake",
                api_key="synthetic",
                policy=RetryPolicy(attempts=2, base_backoff_seconds=0),
            )
            result = await answer(
                factory,
                actor=actor,
                question="درخواست سفر",
                config=AnswerConfig(),
                vector_provider=FakeProvider(),
                generator=generator,
            )
            assert result.abstained and not result.claims and not result.sources
        assert len(requests) == 1

    _scenario(scenario)


def test_disabled_account_refuses_answer_after_provider_returns():
    from app.answer.schemas import AnswerConfig, InvalidGeneration, InvalidReason
    from app.answer.service import answer
    from tests.test_answer_service import _good_result
    from tests.test_retrieval import FakeProvider

    async def scenario(engine, factory):
        await _publish(
            factory, document_id=EMPLOYEE_DOCUMENT, text=EMPLOYEE_TEXT, access_role="employee"
        )
        actor = _actor("employee")

        class Generator:
            last_usage = None

            async def generate(self, **kwargs):
                async with factory() as session:
                    await session.execute(
                        update(User).where(User.user_id == actor.user_id).values(is_active=False)
                    )
                    await session.commit()
                return _good_result("E1")

        with pytest.raises(InvalidGeneration) as caught:
            await answer(
                factory,
                actor=actor,
                question="درخواست سفر",
                config=AnswerConfig(),
                vector_provider=FakeProvider(),
                generator=Generator(),
            )
        assert caught.value.reason == InvalidReason.EVIDENCE_REVOKED

    _scenario(scenario)
