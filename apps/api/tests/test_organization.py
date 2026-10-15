"""Organization name setup, public branding and manager-only updates."""

import pytest
from sqlalchemy import select

from app.db.engine import create_session_factory
from app.db.models import OrganizationSettings
from tests.test_auth import VALID_ORIGIN, _client, _run, _with_engine

HEADERS = {"Origin": VALID_ORIGIN}
PASSWORD = "organization-test-password"


def test_setup_persists_trimmed_name_and_public_endpoint_reads_it():
    async def scenario(engine):
        async with _client(engine) as manager:
            setup = await manager.post(
                "/api/auth/setup",
                json={
                    "email": "admin@example.com",
                    "password": PASSWORD,
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                    "organization_name": "  سازمان نمونه  ",
                },
                headers=HEADERS,
            )
            assert setup.status_code == 201
            assert (await manager.get("/api/organization")).json() == {"name": "سازمان نمونه"}
            async with _client(engine) as anonymous:
                assert (await anonymous.get("/api/organization")).json() == {"name": "سازمان نمونه"}
            async with create_session_factory(engine)() as session:
                row = await session.scalar(select(OrganizationSettings))
                assert row is not None and row.name == "سازمان نمونه"

    _run(_with_engine(scenario))


def test_manager_can_change_name_but_employee_cannot():
    async def scenario(engine):
        async with _client(engine) as manager, _client(engine) as employee:
            assert (
                await manager.post(
                    "/api/auth/setup",
                    json={
                        "email": "admin@example.com",
                        "password": PASSWORD,
                        "first_name": "مدیر",
                        "last_name": "آزمایش",
                        "organization_name": "سازمان نخست",
                    },
                    headers=HEADERS,
                )
            ).status_code == 201
            changed = await manager.put(
                "/api/manager/settings/organization",
                json={"name": "  سازمان تازه  "},
                headers=HEADERS,
            )
            assert changed.status_code == 200
            assert changed.json() == {"name": "سازمان تازه"}
            assert (await manager.get("/api/organization")).json() == {"name": "سازمان تازه"}
            assert (
                await manager.put(
                    "/api/manager/settings/organization",
                    json={"name": "x" * 101},
                    headers=HEADERS,
                )
            ).status_code == 422
            assert (
                await manager.post(
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
            ).status_code == 201
            assert (
                await employee.post(
                    "/api/auth/login",
                    json={"login": "employee@example.com", "password": PASSWORD},
                    headers=HEADERS,
                )
            ).status_code == 200
            assert (
                await employee.put(
                    "/api/manager/settings/organization",
                    json={"name": "نباید ذخیره شود"},
                    headers=HEADERS,
                )
            ).status_code == 403
            assert (
                await manager.put("/api/manager/settings/organization", json={"name": "بدون مبدأ"})
            ).status_code == 403

    _run(_with_engine(scenario))


@pytest.mark.parametrize("name", ["", "   ", "x" * 101, 42])
def test_setup_rejects_invalid_organization_name_without_creating_user(name):
    async def scenario(engine):
        async with _client(engine) as manager:
            response = await manager.post(
                "/api/auth/setup",
                json={
                    "email": "admin@example.com",
                    "password": PASSWORD,
                    "first_name": "مدیر",
                    "last_name": "آزمایش",
                    "organization_name": name,
                },
                headers=HEADERS,
            )
            assert response.status_code == 422
            assert (await manager.get("/api/auth/setup")).json() == {"setup_required": True}

    _run(_with_engine(scenario))
