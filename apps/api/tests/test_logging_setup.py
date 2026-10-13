"""Tests for the structured log formatter.

Two properties carry the whole design and both are asserted against a *negative*: the
formatter must render the fields the answer endpoint depends on, and it must not render a
field nobody allowlisted. The second is the one that matters - a formatter that printed
every attribute on a record would pass the first test and leak whatever a caller passed.
"""

import json
import logging

import pytest

from app.logging_setup import (
    STRUCTURED_KEYS,
    StructuredFormatter,
    install_structured_logging,
)


def render(**extra: object) -> str:
    """One record carrying `extra`, rendered exactly as the process would render it."""
    record = logging.LogRecord(
        name="app.api.answers",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="answer refused",
        args=(),
        exc_info=None,
    )
    for key, value in extra.items():
        setattr(record, key, value)
    return StructuredFormatter("%(levelname)s %(name)s: %(message)s").format(record)


class TestRendersWhatTheEndpointDependsOn:
    def test_every_documented_field_reaches_the_line(self) -> None:
        line = render(
            request_id="req-1",
            role="manager",
            reason="deadline_exceeded",
            attempts=2,
            duration_ms=60000,
        )
        assert 'request_id="req-1"' in line
        assert 'role="manager"' in line
        assert 'reason="deadline_exceeded"' in line
        assert "attempts=2" in line
        assert "duration_ms=60000" in line

    def test_the_message_is_never_rewritten(self) -> None:
        line = render(request_id="req-1")
        assert line.startswith("WARNING app.api.answers: answer refused")

    def test_a_string_role_stays_distinguishable_from_another(self) -> None:
        # Two bare words read the same once a log line is scanned by eye; the quotes are
        # what keep `role=manager` from being read as a field called "role=manager".
        assert 'role="manager"' in render(role="manager")
        assert 'role="employee"' in render(role="employee")


class TestRefusesWhatNobodyAllowlisted:
    def test_an_unknown_key_is_not_rendered(self) -> None:
        line = render(request_id="req-1", question="what is the leave policy?")
        assert "leave policy" not in line
        assert "question" not in line

    def test_a_key_that_looks_like_a_diagnostic_is_still_refused(self) -> None:
        # The allowlist is by name, so a plausible field name someone might reach for is
        # dropped unless it is listed. This is the leak the design exists to prevent.
        #
        # The assertion is on the *structured* portion: the logger name is
        # `app.api.answers` and the message is `answer refused`, so "answer" legitimately
        # appears in the line. Reading it as a leak would be the test being wrong, not the
        # formatter - and a test that fails for a harmless reason gets deleted rather than
        # fixed, which is how a real leak survives.
        line = render(request_id="req-1", prompt="...", answer="...", quote="...", text="...")
        structured = line.split(" | ", 1)[1]
        for forbidden in ("prompt", "answer", "quote", "text"):
            assert forbidden not in structured

    def test_the_allowlist_contains_no_key_that_could_carry_content(self) -> None:
        # A guard on the list itself: someone adding a content-bearing key here would break
        # every test above at once, and this names the failure before it ships.
        for key in STRUCTURED_KEYS:
            assert key in {
                "abstained",
                "attempts",
                "claims",
                "duration_ms",
                "missing_parts",
                "reason",
                "request_id",
                "role",
                "sources",
                "provider",
                "model",
                "input_tokens",
                "output_tokens",
                "cost",
                "currency",
            }, key


class TestUnknownStaysUnknown:
    def test_an_absent_field_is_omitted_rather_than_zeroed(self) -> None:
        # Section 9: unreported consumption must not be reported as zero. `attempts=None`
        # means usage was never returned, which is not the same claim as "no attempts".
        line = render(request_id="req-1", attempts=None)
        assert "attempts" not in line

    def test_a_record_with_no_extra_is_unchanged(self) -> None:
        # Uvicorn's own startup lines carry no structured fields; they must not grow a
        # dangling separator.
        assert render().endswith("answer refused")


class TestUnrenderableValues:
    def test_a_self_referential_value_does_not_take_down_the_line(self) -> None:
        # `default=str` handles an ordinary object, but json.dumps still raises ValueError
        # on a circular reference, so the guard has a real trigger.
        circular: list[object] = []
        circular.append(circular)
        line = StructuredFormatter("%(message)s").format(_record_with("missing_parts", circular))
        assert 'missing_parts="unrenderable"' in line
        assert line.startswith("answer refused")

    def test_an_object_whose_dunder_str_raises_does_not_take_down_the_line(self) -> None:
        # The other escape: `default=str` calls `str()`, and that call can itself raise,
        # which no `except (TypeError, ValueError)` would catch.
        class Hostile:
            def __str__(self) -> str:
                raise RuntimeError("no")

        line = StructuredFormatter("%(message)s").format(_record_with("reason", Hostile()))
        assert 'reason="unrenderable"' in line

    def test_the_rest_of_the_line_survives_a_bad_field(self) -> None:
        # One unrenderable field must cost that field, not the record: a handler that
        # raises is reported by `logging` and the structured line is lost entirely.
        circular: list[object] = []
        circular.append(circular)
        line = render(request_id="req-1", role="manager", missing_parts=circular)
        assert 'request_id="req-1"' in line
        assert 'role="manager"' in line
        assert "unrenderable" in line


def _record_with(key: str, value: object) -> logging.LogRecord:
    record = logging.LogRecord(
        "app.api.answers", logging.WARNING, __file__, 1, "answer refused", (), None
    )
    setattr(record, key, value)
    return record


class TestInstall:
    def test_uvicorn_loggers_lose_their_own_handlers(self) -> None:
        # Uvicorn installs its handlers at start-up. Left alone they bypass the root
        # formatter entirely, and the fix would appear to do nothing.
        logging.getLogger("uvicorn.error").addHandler(logging.NullHandler())
        install_structured_logging()
        try:
            assert logging.getLogger("uvicorn.error").handlers == []
        finally:
            logging.getLogger().handlers.clear()

    def test_installing_twice_does_not_duplicate_output(self) -> None:
        install_structured_logging()
        install_structured_logging()
        try:
            assert len(logging.getLogger().handlers) == 1
        finally:
            logging.getLogger().handlers.clear()


def test_json_output_is_parseable() -> None:
    # Operators and log shippers parse these lines. A hand-rolled format that only a human
    # can read is the usual outcome; parsing one proves the shape is real.
    line = render(request_id="req-1", attempts=2, role="manager")
    fields = dict(piece.split("=", 1) for piece in line.split(" | ", 1)[1].split(" "))
    assert json.loads(fields["attempts"]) == 2
    assert json.loads(fields["role"]) == "manager"


@pytest.mark.parametrize("key", sorted(STRUCTURED_KEYS))
def test_each_allowlisted_key_is_actually_rendered(key: str) -> None:
    # If a key is on the list but never emitted, the list is lying about what it covers.
    line = render(**{key: "value"})
    assert f"{key}=" in line
