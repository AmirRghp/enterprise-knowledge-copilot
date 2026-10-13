"""Infrastructure key is synthetic; integration providers are seeded explicitly."""

import pytest

from tests.provider_fixtures import TEST_ENCRYPTION_KEY


@pytest.fixture(autouse=True)
def test_encryption_key(monkeypatch):
    monkeypatch.setenv("APP_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY)
