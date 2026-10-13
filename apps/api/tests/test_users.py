"""Part 22: account boundaries and races on the isolated test database."""

import asyncio
from uuid import UUID

import pytest
from sqlalchemy import func, select, update

from app.db.engine import create_session_factory
from app.db.models import Session, User
from tests.test_auth import VALID_ORIGIN, _client, _run, _with_engine

HEADERS = {"Origin": VALID_ORIGIN}
PASSWORD = "part22-private-password"


async def setup(client, email="admin@example.com"):
    return await client.post(
        "/api/auth/setup",
        json={"email": email, "password": PASSWORD, "first_name": "مدیر", "last_name": "آزمایش"},
        headers=HEADERS,
    )


def test_setup_is_once_normalized_and_preserves_existing_accounts():
    async def scenario(engine):
        async with _client(engine) as client:
            assert (await client.get("/api/auth/setup")).json() == {"setup_required": True}
            response = await setup(client, "  Admin@EXAMPLE.com  ")
            assert response.status_code == 201
            assert response.json() == {"login": "admin@example.com", "role": "manager"}
            assert (await client.get("/api/auth/me")).status_code == 200
            assert (await client.get("/api/auth/setup")).json() == {"setup_required": False}
            assert (await setup(client, "other@example.com")).status_code == 409
            async with create_session_factory(engine)() as session:
                user = (await session.execute(select(User))).scalar_one()
                assert user.password_hash.startswith("$argon2id$")
                await session.execute(update(User).values(is_active=False))
                await session.commit()
            assert (await setup(client)).status_code == 409

    _run(_with_engine(scenario))


def test_two_concurrent_setups_create_exactly_one_account_and_session():
    async def scenario(engine):
        async with _client(engine) as first, _client(engine) as second:
            responses = await asyncio.gather(setup(first), setup(second, "second@example.com"))
            assert sorted(r.status_code for r in responses) == [201, 409]
        async with create_session_factory(engine)() as session:
            assert await session.scalar(select(func.count()).select_from(User)) == 1
            assert await session.scalar(select(func.count()).select_from(Session)) == 1

    _run(_with_engine(scenario))


@pytest.mark.parametrize(
    "extra",
    [
        {"role": "employee", "first_name": "کارمند", "last_name": "آزمایش"},
        {"password": "short"},
        {"email": "bad"},
        {"email": "a@b@example.com"},
        {"password": "x" * 513},
    ],
)
def test_setup_invalid_input_is_safe(extra):
    async def scenario(engine):
        async with _client(engine) as client:
            response = await client.post(
                "/api/auth/setup",
                json={
                    "email": "admin@example.com",
                    "password": PASSWORD,
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                    **extra,
                },
                headers=HEADERS,
            )
            assert response.status_code == 422
            assert PASSWORD not in response.text
        async with create_session_factory(engine)() as session:
            assert await session.scalar(select(func.count()).select_from(User)) == 0

    _run(_with_engine(scenario))


def test_manager_lifecycle_and_session_revocation():
    async def scenario(engine):
        async with _client(engine) as manager, _client(engine) as employee:
            assert (await setup(manager)).status_code == 201
            created = await manager.post(
                "/api/manager/users",
                json={
                    "email": "Employee@example.com",
                    "password": PASSWORD,
                    "role": "employee",
                    "first_name": "کارمند",
                    "last_name": "آزمایش",
                },
                headers=HEADERS,
            )
            assert created.status_code == 201
            user_id = created.json()["user_id"]
            assert "password" not in created.text
            duplicate = await manager.post(
                "/api/manager/users",
                json={
                    "email": "EMPLOYEE@example.com",
                    "password": PASSWORD,
                    "role": "manager",
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                },
                headers=HEADERS,
            )
            assert duplicate.status_code == 409
            login = await employee.post(
                "/api/auth/login",
                json={"login": " EMPLOYEE@EXAMPLE.com ", "password": PASSWORD},
                headers=HEADERS,
            )
            assert login.status_code == 200
            assert (await employee.get("/api/manager/users")).status_code == 403
            for changes in (
                {"role": "manager", "first_name": "مدیر", "last_name": "آزمایش"},
                {"is_active": False},
            ):
                changed = await manager.patch(
                    f"/api/manager/users/{user_id}", json=changes, headers=HEADERS
                )
                assert changed.status_code == 200
                assert (await employee.get("/api/auth/me")).status_code == 401
                if changes.get("role"):
                    assert (
                        await employee.post(
                            "/api/auth/login",
                            json={"login": "employee@example.com", "password": PASSWORD},
                            headers=HEADERS,
                        )
                    ).status_code == 200
            assert (
                await manager.patch(
                    f"/api/manager/users/{user_id}", json={"is_active": True}, headers=HEADERS
                )
            ).status_code == 200
            assert (
                await employee.post(
                    "/api/auth/login",
                    json={"login": "employee@example.com", "password": PASSWORD},
                    headers=HEADERS,
                )
            ).status_code == 200
            assert (
                await manager.put(
                    f"/api/manager/users/{user_id}/password",
                    json={"password": "replacement-password"},
                    headers=HEADERS,
                )
            ).status_code == 204
            assert (await employee.get("/api/auth/me")).status_code == 401
            assert (
                await employee.post(
                    "/api/auth/login",
                    json={"login": "employee@example.com", "password": PASSWORD},
                    headers=HEADERS,
                )
            ).status_code == 401
            listing = (await manager.get("/api/manager/users")).json()
            assert listing["total"] == 2 and len(listing["users"]) == 2
            assert (await manager.get("/api/manager/users?page=2")).json()["users"] == []

    _run(_with_engine(scenario))


def test_last_manager_refused_even_when_two_managers_demote_themselves():
    async def scenario(engine):
        async with _client(engine) as first, _client(engine) as second:
            await setup(first)
            first_id = (await first.get("/api/auth/me")).json()["user_id"]
            for payload in (
                {"role": "employee", "first_name": "کارمند", "last_name": "آزمایش"},
                {"is_active": False},
            ):
                assert (
                    await first.patch(
                        f"/api/manager/users/{first_id}", json=payload, headers=HEADERS
                    )
                ).status_code == 409
            created = await first.post(
                "/api/manager/users",
                json={
                    "email": "second@example.com",
                    "password": PASSWORD,
                    "role": "manager",
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                },
                headers=HEADERS,
            )
            second_id = created.json()["user_id"]
            await second.post(
                "/api/auth/login",
                json={"login": "second@example.com", "password": PASSWORD},
                headers=HEADERS,
            )
            results = await asyncio.gather(
                first.patch(
                    f"/api/manager/users/{first_id}",
                    json={"role": "employee", "first_name": "کارمند", "last_name": "آزمایش"},
                    headers=HEADERS,
                ),
                second.patch(
                    f"/api/manager/users/{second_id}",
                    json={"role": "employee", "first_name": "کارمند", "last_name": "آزمایش"},
                    headers=HEADERS,
                ),
            )
            assert sorted(r.status_code for r in results) == [200, 409]

    _run(_with_engine(scenario))


@pytest.mark.parametrize("path", ["/api/auth/setup", "/api/manager/users"])
def test_origin_and_streaming_limit_before_database(path):
    async def scenario(engine):
        async with _client(engine) as client:
            assert (
                await client.post(path, json={}, headers={"Origin": "https://foreign.example"})
            ).status_code == 403

            if path == "/api/manager/users":
                await setup(client)

            async def stream():
                for _ in range(20):
                    yield b"x" * 1024

            assert (
                await client.post(
                    path, content=stream(), headers={**HEADERS, "Content-Type": "application/json"}
                )
            ).status_code == 413

    _run(_with_engine(scenario))


def test_setup_failure_rolls_back_the_account_and_session(monkeypatch):
    from app.auth import service

    async def broken(*args, **kwargs):
        raise RuntimeError("session failure")

    async def scenario(engine):
        async with _client(engine) as client:
            with monkeypatch.context() as patcher:
                patcher.setattr(service, "issue_session", broken)
                with pytest.raises(RuntimeError, match="session failure"):
                    await setup(client)
            async with create_session_factory(engine)() as session:
                assert await session.scalar(select(func.count()).select_from(User)) == 0
                assert await session.scalar(select(func.count()).select_from(Session)) == 0
            assert (await setup(client)).status_code == 201

    _run(_with_engine(scenario))


@pytest.mark.parametrize("operation", ["password", "disable"])
def test_login_cannot_issue_a_session_after_a_racing_reset_or_disable(monkeypatch, operation):
    import threading

    from app.auth import service

    reached, release = threading.Event(), threading.Event()
    verify = service.verify_password

    def paused(password, hashed):
        reached.set()
        assert release.wait(10), "login barrier timed out"
        return verify(password, hashed)

    async def scenario(engine):
        async with _client(engine) as manager, _client(engine) as employee:
            await setup(manager)
            created = await manager.post(
                "/api/manager/users",
                json={
                    "email": "employee@example.com",
                    "password": PASSWORD,
                    "role": "employee",
                    "first_name": "کارمند",
                    "last_name": "آزمایش",
                },
                headers=HEADERS,
            )
            user_id = created.json()["user_id"]
            with monkeypatch.context() as patcher:
                patcher.setattr(service, "verify_password", paused)
                login = asyncio.create_task(
                    employee.post(
                        "/api/auth/login",
                        json={"login": "employee@example.com", "password": PASSWORD},
                        headers=HEADERS,
                    )
                )
                try:
                    assert await asyncio.to_thread(reached.wait, 10)
                    if operation == "password":
                        response = await manager.put(
                            f"/api/manager/users/{user_id}/password",
                            json={"password": "new-private-password"},
                            headers=HEADERS,
                        )
                        assert response.status_code == 204
                    else:
                        response = await manager.patch(
                            f"/api/manager/users/{user_id}",
                            json={"is_active": False},
                            headers=HEADERS,
                        )
                        assert response.status_code == 200
                finally:
                    release.set()
                assert (await login).status_code == 401
            async with create_session_factory(engine)() as session:
                assert (
                    await session.scalar(
                        select(func.count()).select_from(Session).where(Session.user_id == user_id)
                    )
                    == 0
                )

    _run(_with_engine(scenario))


def test_manager_authority_rechecked_after_password_hashing(monkeypatch):
    from app.auth import accounts

    async def scenario(engine):
        async with _client(engine) as first, _client(engine) as second:
            await setup(first)
            first_id = (await first.get("/api/auth/me")).json()["user_id"]
            await first.post(
                "/api/manager/users",
                json={
                    "email": "second@example.com",
                    "password": PASSWORD,
                    "role": "manager",
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                },
                headers=HEADERS,
            )
            await second.post(
                "/api/auth/login",
                json={"login": "second@example.com", "password": PASSWORD},
                headers=HEADERS,
            )
            reached, release = asyncio.Event(), asyncio.Event()
            original = accounts.hash_new_password

            async def paused(*args):
                hashed = await original(*args)
                reached.set()
                await release.wait()
                return hashed

            with monkeypatch.context() as patcher:
                patcher.setattr(accounts, "hash_new_password", paused)
                create = asyncio.create_task(
                    first.post(
                        "/api/manager/users",
                        json={
                            "email": "forbidden@example.com",
                            "first_name": "کاربر",
                            "last_name": "آزمایش",
                            "password": PASSWORD,
                            "role": "manager",
                        },
                        headers=HEADERS,
                    )
                )
                await asyncio.wait_for(reached.wait(), 10)
                try:
                    assert (
                        await second.patch(
                            f"/api/manager/users/{first_id}",
                            json={
                                "role": "employee",
                                "first_name": "کارمند",
                                "last_name": "آزمایش",
                            },
                            headers=HEADERS,
                        )
                    ).status_code == 200
                finally:
                    release.set()
                assert (await create).status_code == 403
            async with create_session_factory(engine)() as session:
                assert (
                    await session.scalar(
                        select(User.user_id).where(User.login == "forbidden@example.com")
                    )
                    is None
                )

    _run(_with_engine(scenario))


@pytest.mark.parametrize(
    "changes",
    [
        {"role": "administrator"},
        {"is_active": "false"},
        {},
        {"role": None},
        {"login": "change@example.com"},
    ],
)
def test_invalid_management_fields_are_rejected(changes):
    async def scenario(engine):
        async with _client(engine) as client:
            await setup(client)
            user_id = (await client.get("/api/auth/me")).json()["user_id"]
            result = await client.patch(
                f"/api/manager/users/{user_id}", json=changes, headers=HEADERS
            )
            assert result.status_code == 422
            assert (await client.get("/api/auth/me")).status_code == 200

    _run(_with_engine(scenario))


def test_names_required_and_profile_password_update_is_atomic():
    async def scenario(engine):
        async with _client(engine) as manager:
            await setup(manager)
            base = {"email": "profile@example.com", "password": PASSWORD, "role": "employee"}
            for missing in ({}, {"first_name": "علی"}, {"first_name": "  ", "last_name": "احمدی"}):
                response = await manager.post(
                    "/api/manager/users", json={**base, **missing}, headers=HEADERS
                )
                assert response.status_code == 422
            created = await manager.post(
                "/api/manager/users",
                json={**base, "first_name": " علی ", "last_name": " احمدی "},
                headers=HEADERS,
            )
            assert created.status_code == 201
            value = created.json()
            assert value["first_name"] == "علی" and value["last_name"] == "احمدی"
            user_id = value["user_id"]
            changed = await manager.patch(
                f"/api/manager/users/{user_id}",
                json={
                    "email": " New@EXAMPLE.com ",
                    "first_name": "رضا",
                    "last_name": "رضایی",
                    "password": "new-profile-password",
                },
                headers=HEADERS,
            )
            assert changed.status_code == 200
            assert changed.json()["login"] == "new@example.com"
            assert changed.json()["first_name"] == "رضا"
            async with _client(engine) as employee:
                assert (
                    await employee.post(
                        "/api/auth/login",
                        json={"login": "profile@example.com", "password": PASSWORD},
                        headers=HEADERS,
                    )
                ).status_code == 401
                assert (
                    await employee.post(
                        "/api/auth/login",
                        json={"login": "new@example.com", "password": "new-profile-password"},
                        headers=HEADERS,
                    )
                ).status_code == 200
            duplicate = await manager.patch(
                f"/api/manager/users/{user_id}",
                json={
                    "email": "admin@example.com",
                    "first_name": "تغییر",
                    "password": "should-not-be-saved",
                },
                headers=HEADERS,
            )
            assert duplicate.status_code == 409
            async with create_session_factory(engine)() as session:
                user = await session.get(User, UUID(user_id))
                from app.auth.service import verify_password

                assert user.login == "new@example.com" and user.first_name == "رضا"
                assert verify_password("new-profile-password", user.password_hash)

    _run(_with_engine(scenario))


def test_name_only_edit_keeps_session_but_email_change_revokes_it():
    async def scenario(engine):
        async with _client(engine) as manager, _client(engine) as employee:
            await setup(manager)
            created = await manager.post(
                "/api/manager/users",
                json={
                    "email": "profile@example.com",
                    "password": PASSWORD,
                    "role": "employee",
                    "first_name": "علی",
                    "last_name": "احمدی",
                },
                headers=HEADERS,
            )
            user_id = created.json()["user_id"]
            assert (
                await employee.post(
                    "/api/auth/login",
                    json={"login": "profile@example.com", "password": PASSWORD},
                    headers=HEADERS,
                )
            ).status_code == 200
            assert (
                await manager.patch(
                    f"/api/manager/users/{user_id}",
                    json={"first_name": "رضا", "last_name": "احمدی"},
                    headers=HEADERS,
                )
            ).status_code == 200
            assert (await employee.get("/api/auth/me")).status_code == 200
            assert (
                await manager.patch(
                    f"/api/manager/users/{user_id}",
                    json={"email": "renamed@example.com"},
                    headers=HEADERS,
                )
            ).status_code == 200
            assert (await employee.get("/api/auth/me")).status_code == 401

    _run(_with_engine(scenario))


@pytest.mark.parametrize(
    "field,value",
    [
        ("first_name", ""),
        ("last_name", "  "),
        ("first_name", "x" * 101),
        ("last_name", None),
        ("first_name", 42),
    ],
)
def test_names_are_validated_on_setup_and_profile_edits(field, value):
    async def scenario(engine):
        async with _client(engine) as client:
            invalid = await client.post(
                "/api/auth/setup",
                json={
                    "email": "admin@example.com",
                    "password": PASSWORD,
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                    field: value,
                },
                headers=HEADERS,
            )
            assert invalid.status_code == 422
            await setup(client)
            user_id = (await client.get("/api/auth/me")).json()["user_id"]
            assert (
                await client.patch(
                    f"/api/manager/users/{user_id}", json={field: value}, headers=HEADERS
                )
            ).status_code == 422
            assert (await client.get("/api/auth/me")).status_code == 200

    _run(_with_engine(scenario))
