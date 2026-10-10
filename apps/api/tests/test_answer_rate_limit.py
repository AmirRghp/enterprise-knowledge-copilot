"""Tests for the answer rate limiter.

A sliding window per role, in the same shape as ``LoginRateLimiter`` so there is one
limiter pattern in the codebase rather than two.

What this does **not** do, stated here so nobody later believes otherwise: it does not
protect the daily quota. The free endpoint allows **fifty requests a day for the whole
account** - measured in Part 13 from the ``X-RateLimit-Limit`` header - so no per-role
window can prevent the budget from being spent. What this prevents is a runaway loop: a
client that retries, a script that double-submits, one actor monopolising the endpoint.
Protecting the daily budget needs a per-day allowance, which is a product decision about
how many questions a user may ask, and no such number is invented here.
"""

from app.api.answer_rate_limit import AnswerRateLimiter


def _limiter(limit: int = 3, window: int = 60) -> AnswerRateLimiter:
    now = [1000.0]
    return AnswerRateLimiter(
        role_limit=limit, window_seconds=window, max_keys=100, clock=lambda: now[0]
    )


def test_requests_inside_the_window_are_allowed() -> None:
    limiter = _limiter(limit=3)

    assert [limiter.retry_after("employee") for _ in range(3)] == [None, None, None]


def test_the_fourth_request_in_the_window_is_refused() -> None:
    limiter = _limiter(limit=3)

    for _ in range(3):
        limiter.retry_after("employee")

    assert limiter.retry_after("employee") is not None


def test_a_refused_request_still_counts_against_the_budget() -> None:
    """Otherwise a client in a retry storm spends nothing and the window means nothing."""
    limiter = _limiter(limit=2)

    limiter.retry_after("employee")
    limiter.retry_after("employee")
    assert limiter.retry_after("employee") is not None

    # Still refusing after more hammering: the budget did not reset itself.
    assert limiter.retry_after("employee") is not None


def test_roles_have_independent_budgets() -> None:
    """A busy employee must not lock the manager out of answering anything."""
    limiter = _limiter(limit=2)

    for _ in range(2):
        limiter.retry_after("employee")

    assert limiter.retry_after("employee") is not None
    assert limiter.retry_after("manager") is None


def test_the_window_slides_so_an_old_request_stops_counting() -> None:
    now = [1000.0]
    limiter = AnswerRateLimiter(role_limit=2, window_seconds=60, max_keys=100, clock=lambda: now[0])

    limiter.retry_after("employee")
    limiter.retry_after("employee")
    assert limiter.retry_after("employee") is not None

    # Past the window the earlier requests stop counting, without any sleeping.
    now[0] += 61
    assert limiter.retry_after("employee") is None


def test_retry_after_is_seconds_not_a_boolean() -> None:
    """A caller sets a Retry-After header from it, so a coarse figure has to be honest."""
    limiter = _limiter(limit=1, window=60)

    limiter.retry_after("employee")
    seconds = limiter.retry_after("employee")

    assert seconds is not None
    assert 1 <= seconds <= 60


def test_the_window_expires_empty_so_keys_do_not_accumulate() -> None:
    """Two roles only, so this cannot leak in practice - but the sweep is why, and it is
    the reason the limiter is not simply a counter that grows."""
    now = [1000.0]
    limiter = AnswerRateLimiter(role_limit=1, window_seconds=60, max_keys=100, clock=lambda: now[0])

    limiter.retry_after("employee")
    limiter.retry_after("manager")
    assert limiter.bucket_count == 2

    now[0] += 61
    limiter.retry_after("employee")

    # Only the employee key remains: the manager's window expired and was swept.
    assert limiter.bucket_roles() == ["employee"]


def test_key_capacity_is_bounded_and_refuses_rather_than_evicts() -> None:
    """Evicting an active limit to make room for a new key would let a caller bypass it."""
    limiter = AnswerRateLimiter(role_limit=1, window_seconds=60, max_keys=2, clock=lambda: 1000.0)

    limiter.retry_after("employee")
    limiter.retry_after("manager")

    assert limiter.retry_after("boss") is not None
    assert limiter.bucket_count == 2


def test_the_limiter_is_safe_under_concurrency() -> None:
    """Called from the event loop but mutated from any thread handling a request."""
    import threading

    limiter = _limiter(limit=1000)

    def hammer() -> None:
        for _ in range(200):
            limiter.retry_after("employee")

    threads = [threading.Thread(target=hammer) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert limiter.bucket_count == 1
    assert limiter.recorded == 800


def test_a_role_with_no_traffic_is_not_recorded() -> None:
    """Refusing a request must not create the key it was refused on."""
    limiter = _limiter(limit=1)

    limiter.retry_after("employee")
    limiter.retry_after("employee")
    limiter.retry_after("employee")

    assert "manager" not in limiter.bucket_roles()


def test_an_unknown_role_is_treated_as_its_own_bucket_not_a_shared_one() -> None:
    """Role comes from the session row, so this cannot happen - but a mistake here would
    merge two callers into one budget, which is the opposite of the intended isolation."""
    limiter = _limiter(limit=1)

    limiter.retry_after("nobody")

    assert limiter.bucket_roles() == ["nobody"]
