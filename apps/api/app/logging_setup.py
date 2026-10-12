"""Structured logging for the API process.

``CODE_STYLE.md`` section 9 requires standard logging with structured output and a
``request_id``. The answer endpoint already builds that record - ``request_id``, ``role``,
``reason``, ``attempts``, ``duration_ms`` and the claim and source counts - and passes it as
``extra``, which is the standard library's own mechanism. Uvicorn's default handler prints
only ``record.getMessage()``, so that record never reached an operator: every refusal logged
as a bare ``answer refused`` with no reason, no attempt count and no duration. Diagnosing a
deadline meant reproducing it, and the one field that says whether the retry budget was
already spent was the field that stayed invisible.

An **allowlist**, not a blocklist. The tempting alternative is to print every attribute
``logging`` adds to a record, which would render ``args``, ``exc_info`` and whatever a future
caller passes in ``extra`` - and this codebase's rule is that a question, a prompt or a
document may not reach a log. A key that is not on the list is dropped, so adding a
diagnostic field cannot quietly become a leak: it has to be named here first, in front of
this comment, where the omission is reviewable.

The formatter changes presentation only. It never rewrites a message, never invents a
value, and never reports an unknown usage figure as zero - section 9's third rule. Uvicorn's
own startup lines carry no structured fields and are rendered unchanged.
"""

import json
import logging
from typing import Any

#: The complete set of structured keys this process may render. Every one is a count, a
#: flag, a role, a duration or a fixed reason string; none is derived from a question, an
#: answer, a quote or a document. Adding a key here is the only way to have it logged.
STRUCTURED_KEYS: frozenset[str] = frozenset(
    {
        "abstained",
        "attempts",
        "claims",
        "duration_ms",
        "missing_parts",
        "reason",
        "request_id",
        "role",
        "sources",
    }
)


def _render_value(value: Any) -> str:
    """One value, JSON-encoded, and never a reason for the line to fail.

    ``json.dumps`` rather than ``str`` so a list keeps its brackets and a string keeps its
    quotes - ``role=manager`` and ``role=employee`` stay distinguishable when the line is
    read by eye, which is the whole point of a structured line.

    ``default=str`` covers an ordinary object, but not everything: a self-referential list
    raises ``ValueError``, and an object whose ``__str__`` itself raises escapes ``default``
    entirely as ``RuntimeError``. Neither is exotic to a diagnostic field, and neither may
    take down the request being logged - a logging failure inside a handler is reported by
    ``logging`` itself and the structured line is lost, so a value that cannot be rendered
    degrades to a marker and the rest of the line still says what happened.
    """
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001 - a formatter must not raise; see above.
        return json.dumps("unrenderable")


class StructuredFormatter(logging.Formatter):
    """Render ``message`` followed by the allowlisted ``extra`` keys."""

    def format(self, record: logging.LogRecord) -> str:
        base = super().format(record)
        if not STRUCTURED_KEYS:
            return base

        parts: list[str] = []
        for key in sorted(STRUCTURED_KEYS):
            value = getattr(record, key, None)
            if value is None:
                # `attempts` is deliberately absent rather than zero when usage was never
                # reported: an unreported figure is unknown, and unknown is not zero.
                continue
            parts.append(f"{key}={_render_value(value)}")

        if not parts:
            return base
        return f"{base} | {' '.join(parts)}"


def install_structured_logging(level: int = logging.INFO) -> None:
    """Apply the formatter to the root logger and to uvicorn's own loggers.

    Uvicorn installs its own handlers when it starts, so its loggers are reconfigured here
    as well - a formatter on the root logger alone would be bypassed by them, and the
    failure would look like the fix not working.
    """
    formatter = StructuredFormatter("%(levelname)s %(name)s: %(message)s")
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True
