"""Browser Origin enforcement for state-changing requests.

SECURITY.md section 5 requires state-changing requests, login included, to carry
an Origin that matches the configured web origin; a missing or mismatched
browser Origin is rejected. Because the browser reaches the API through the
same-origin Next.js proxy, a legitimate request always has that Origin.

This is not CORS. CORS governs whether a browser lets a script read a response;
this guard rejects the request server-side before any work happens.
"""

from urllib.parse import urlsplit

from fastapi import Request

from app.settings import Settings

# Methods that change state and therefore require a verified Origin.
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Endpoints a browser may reach without an Origin header. Kept to an explicit
# allowlist so a new public POST is never added implicitly.
ORIGIN_EXEMPT_PATHS = frozenset({"/api/health"})


class OriginRejectedError(Exception):
    """Raised when a state-changing request has no acceptable Origin."""


def _origin_of(settings: Settings) -> str:
    """Normalize the configured web origin to scheme://host[:port]."""
    parts = urlsplit(str(settings.web_origin))
    if not parts.scheme or not parts.netloc:
        return str(settings.web_origin).rstrip("/")
    return f"{parts.scheme}://{parts.netloc}"


def is_allowed_origin(settings: Settings, origin: str | None) -> bool:
    """Return whether a browser Origin header is acceptable."""
    if origin is None:
        return False
    candidate = origin.strip()
    if not candidate or candidate.lower() == "null":
        return False
    return candidate.rstrip("/") == _origin_of(settings)


def enforce_origin(request: Request, settings: Settings) -> None:
    """Raise :class:`OriginRejectedError` when the request Origin is unacceptable.

    Skips safe methods and explicitly exempt paths. The Origin value is never
    echoed in an error message, so the check cannot be used as an oracle.
    """
    if request.method.upper() not in UNSAFE_METHODS:
        return
    if request.url.path in ORIGIN_EXEMPT_PATHS:
        return
    if not is_allowed_origin(settings, request.headers.get("origin")):
        raise OriginRejectedError("request origin is not allowed")
