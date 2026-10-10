"""Reject an oversized or cross-site upload before its body is buffered.

SECURITY.md section 8 caps a document at 1 MiB. Checking the file *after* parsing
is too late: FastAPI parses the whole ``multipart/form-data`` body before any route
code or dependency runs, so a 2 MiB body is buffered before the Origin check runs
or the file is even looked at (Part 8 review, P1).

This module is registered as ASGI middleware, which is the only layer that sees the
request before body parsing. It does two cheap things in that window:

* refuse a request whose ``Origin`` is not the configured web origin, using only
  headers, so a cross-site page cannot make the server buffer anything;
* cap the *entire* request body, streamed. The cap is not the file ceiling alone:
  multipart framing and the two form fields add overhead, so the ceiling plus a
  documented allowance is used. Counting the stream rather than trusting
  ``Content-Length`` means a chunked request with no length header is bounded the
  same way, and so is a request carrying several files.

Both duties cover the replacement request as well as the create one. Part 10 added
``PUT /api/manager/documents/{id}``, which carries the same multipart body through
the same FastAPI body parser, so leaving it unguarded would have reintroduced
exactly the buffering window this middleware exists to close (Part 10).
"""

from collections.abc import Mapping

from fastapi import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.auth.origin import is_allowed_origin
from app.settings import Settings

# Multipart framing overhead allowed on top of the file ceiling: boundary markers,
# the part headers for ``title`` and ``access_role``, and the file part's own
# headers. Generous enough not to reject a legitimate document, small enough that
# the buffered body stays bounded no matter what the client sends.
MULTIPART_OVERHEAD_BYTES = 64 * 1024

# The guard counts a chunk after receiving it, so a client that declares no length
# is read up to one server read-chunk beyond the ceiling before the abort. What
# matters is that the application never sees more than the ceiling, which is what
# bounds what it buffers or spools to disk.
READ_CHUNK_OVERSHOOT_NOTE = "at most one read chunk past the ceiling"

# A filename is client-supplied text that ends up in a part header, so its length is
# capped rather than trusted.
MAX_FILENAME_CHARS = 200

SCOPE_HEADER_NAMES = {"origin": "origin", "content-length": "content-length"}

#: Methods that may carry a document body. ``DELETE`` carries none, so it is not
#: listed: there is nothing to buffer, and its Origin check already runs in the
#: route's manager dependency like every other route's.
GUARDED_METHODS = frozenset({"POST", "PUT"})

#: A JSON body ceiling for the routes that carry no file. The answer request is a single
#: string of at most 2,000 characters, so this is generous by an order of magnitude and
#: still small enough that a hostile body costs almost nothing to refuse. Chosen as a
#: constant rather than derived from the question ceiling because the guard runs before the
#: question is parsed and cannot know how much of the body is the question.
JSON_BODY_CEILING = 64 * 1024


class BodyTooLargeError(HTTPException):
    """Raised from the receive wrapper once the body exceeds the cap.

    It **is** an ``HTTPException``, which is what makes the 413 survive.

    The body parsers - JSON and multipart alike - catch every exception coming out of
    ``receive`` and replace it with ``400 "There was an error parsing the body"``. Raising a
    plain ``Exception`` therefore capped the stream but reported a malformed request, which
    tells a client to fix its request rather than to send less of it, and makes an oversized
    body indistinguishable from corrupt bytes. FastAPI re-raises an ``HTTPException``
    unchanged from that handler, so the status reaches the caller.

    Both layers can answer it, and that is deliberate rather than a race. ``ExceptionMiddleware``
    sits inside user middleware, so in a real request it converts this to a response before the
    guard's own ``except`` can. The guard's handler still runs for a bare ASGI app - the tests
    drive the middleware directly - and is what makes the middleware correct on its own. Both
    produce the same status and the same fixed body, so which one answers is not observable.
    """

    def __init__(self) -> None:
        super().__init__(status_code=413, detail="request body is too large")


def _header(scope: Scope, name: str) -> str | None:
    wanted = SCOPE_HEADER_NAMES[name].encode("latin-1")
    for key, value in scope.get("headers", []):
        if key.lower() == wanted:
            decoded: str = value.decode("latin-1")
            return decoded
    return None


def _response(status: int, detail: str) -> tuple[Message, Message]:
    body = f'{{"detail":"{detail}"}}'.encode()
    return (
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("latin-1")),
            ],
        },
        {"type": "http.response.body", "body": body},
    )


def upload_body_ceiling(settings: Settings) -> int:
    """Return the largest total request body accepted for an upload."""
    return settings.upload_max_bytes + MULTIPART_OVERHEAD_BYTES


class UploadGuard:
    """Bound and pre-screen the manager upload requests.

    Only the configured upload path and a document directly under it are touched.
    A grandchild path such as ``/documents/DOC-001/sections`` is left alone, so this
    cannot change the behaviour of any route other than the create and replace
    endpoints; every other request passes through untouched.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        upload_path: str,
        upload_max_body_bytes: int,
        json_paths: Mapping[str, int],
        settings: Settings,
    ) -> None:
        self._app = app
        self._upload_path = upload_path
        self._upload_max_body_bytes = upload_max_body_bytes
        # Prefix to ceiling for the body-carrying routes that carry no file. One mapping
        # rather than a second middleware, so the byte counting and the header-only Origin
        # check have a single implementation to be right.
        self._json_paths = json_paths
        self._settings = settings

    def _ceiling_for(self, scope: Scope) -> int | None:
        """Return this request's body ceiling, or ``None`` when it carries no body.

        Returns the ceiling rather than a boolean so the caller cannot read it, check the
        route again and apply a different figure to the two.
        """
        if scope.get("method") not in GUARDED_METHODS:
            return None
        path = scope.get("path", "")
        if path == self._upload_path or self._is_replacement(path):
            return self._upload_max_body_bytes
        for prefix, ceiling in self._json_paths.items():
            if path == prefix or path.startswith(f"{prefix}/"):
                return ceiling
        return None

    def _is_replacement(self, path: str) -> bool:
        """Whether the path names one document of the upload collection."""
        # A replacement names its document: /documents/{id}, one segment only.
        prefix = f"{self._upload_path}/"
        return path.startswith(prefix) and "/" not in path[len(prefix) :]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        ceiling = None if scope.get("type") != "http" else self._ceiling_for(scope)
        if ceiling is None:
            await self._app(scope, receive, send)
            return

        # Origin first: headers only, so a cross-site caller buffers nothing.
        if not is_allowed_origin(self._settings, _header(scope, "origin")):
            start, body = _response(403, "request origin is not allowed")
            await send(start)
            await send(body)
            return

        # A declared length over the ceiling is refused without reading a byte.
        declared = _header(scope, "content-length")
        if declared is not None:
            try:
                length = int(declared)
            except ValueError:
                length = -1
            if length > ceiling:
                start, body = _response(413, "request body is too large")
                await send(start)
                await send(body)
                return

        consumed = 0

        async def limited_receive() -> Message:
            """Deliver the body, refusing it once past the ceiling.

            The count happens after the chunk arrives, so the source is read
            ``READ_CHUNK_OVERSHOOT_NOTE``. The application, which is what allocates
            and spools, never sees the excess.
            """
            nonlocal consumed
            message = await receive()
            if message.get("type") == "http.disconnect":
                return message
            chunk: bytes = message.get("body", b"")
            consumed += len(chunk)
            if consumed > ceiling:
                # Raised from inside the body stream, so the oversized remainder is
                # never delivered and never reaches a temporary file.
                raise BodyTooLargeError
            return message

        try:
            await self._app(scope, limited_receive, send)
        except BodyTooLargeError:
            start, body = _response(413, "request body is too large")
            await send(start)
            await send(body)


def guard_upload_bodies(app: ASGIApp, *, path: str, settings: Settings) -> ASGIApp:
    """Return ``app`` with :class:`UploadGuard` installed for one upload path.

    Kept for callers that only want the multipart ceiling, which is every existing caller.
    The application registers the guard directly in ``main.py`` because it also needs the
    answer path's JSON ceiling, and that belongs with the app rather than in a helper whose
    name says "upload".
    """
    return UploadGuard(
        app,
        upload_path=path,
        upload_max_body_bytes=upload_body_ceiling(settings),
        json_paths={},
        settings=settings,
    )


__all__ = [
    "GUARDED_METHODS",
    "MAX_FILENAME_CHARS",
    "MULTIPART_OVERHEAD_BYTES",
    "READ_CHUNK_OVERSHOOT_NOTE",
    "BodyTooLargeError",
    "UploadGuard",
    "guard_upload_bodies",
    "upload_body_ceiling",
]
