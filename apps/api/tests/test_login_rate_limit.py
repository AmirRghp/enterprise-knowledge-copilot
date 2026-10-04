"""Deterministic window and memory-cap tests, without a server or database."""

from concurrent.futures import ThreadPoolExecutor

from app.auth.rate_limit import LoginRateLimiter


def test_pair_boundary_and_recovery() -> None:
    now = [0.0]
    limiter = LoginRateLimiter(5, 30, 60, 100, lambda: now[0])
    assert all(limiter.retry_after("ip", "employee") is None for _ in range(5))
    assert limiter.retry_after("ip", "employee") == 60
    now[0] = 59.5
    assert limiter.retry_after("ip", "employee") == 1
    now[0] = 60
    assert limiter.retry_after("ip", "employee") is None


def test_ip_limit_across_distinct_logins() -> None:
    limiter = LoginRateLimiter(5, 30, 60, 100, lambda: 0)
    assert all(limiter.retry_after("ip", str(i)) is None for i in range(30))
    assert limiter.retry_after("ip", "another") == 60
    assert limiter.retry_after("other-ip", "another") is None


def test_denied_pair_attempts_still_consume_ip_budget() -> None:
    limiter = LoginRateLimiter(1, 3, 60, 100, lambda: 0)
    assert limiter.retry_after("ip", "same") is None
    assert limiter.retry_after("ip", "same") == 60
    assert limiter.retry_after("ip", "same") == 60
    assert limiter.retry_after("ip", "different") == 60


def test_capacity_rejects_new_keys_without_evicting_active_limits() -> None:
    now = [0.0]
    limiter = LoginRateLimiter(1, 30, 60, 2, lambda: now[0])
    assert limiter.retry_after("ip", "same") is None
    assert limiter.retry_after("another-ip", "new") == 60
    assert len(limiter._buckets) == 2
    assert limiter.retry_after("ip", "same") == 60
    now[0] = 60
    assert limiter.retry_after("another-ip", "new") is None
    assert len(limiter._buckets) == 2


def test_parallel_attempts_cannot_bypass_pair_limit() -> None:
    limiter = LoginRateLimiter(5, 30, 60, 100, lambda: 0)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: limiter.retry_after("ip", "same"), range(20)))
    assert results.count(None) == 5
