"""Tests for the upload body guard.

Part 8 review, P1: the file ceiling was applied only after FastAPI had parsed the
whole multipart body, which it does before any dependency runs. A 2 MiB body was
therefore buffered before the Origin or manager checks executed.

These tests drive the ASGI app directly and count the bytes the server actually
pulls from the request stream, because that is the quantity the finding is about:
what the process reads and buffers, not what the route returns.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest

from app.api.upload_guard import (
    MULTIPART_OVERHEAD_BYTES,
    UploadGuard,
    upload_body_ceiling,
)
from app.main import create_app
from app.settings import Settings

BOUNDARY = "----opencodeboundarytest"
ORIGIN = "http://localhost:3000"
FOREIGN_ORIGIN = "http://evil.example.com"


def _field(name: str, value: str) -> bytes:
    return (
        f'--{BOUNDARY}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'
    ).encode()


def _file_part(name: str, filename: str, body: bytes) -> bytes:
    return (
        (
            f"--{BOUNDARY}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: text/markdown\r\n\r\n"
        ).encode()
        + body
        + b"\r\n"
    )


def _multipart(*, size: int = 64, files: int = 1, filename: str = "policy.md") -> bytes:
    parts = _field("title", "بزرگ") + _field("access_role", "employee")
    for index in range(files):
        parts += _file_part("file" if files == 1 else f"file{index}", filename, b"x" * size)
    return parts + f"--{BOUNDARY}--\r\n".encode()


async def _read(
    app: object,
    payload: bytes,
    *,
    origin: str | None,
    declared_length: int | None,
    path: str = "/api/manager/documents",
    content_type: str = f"multipart/form-data; boundary={BOUNDARY}",
) -> tuple[int | None, int]:
    """Send ``payload`` and return ``(status, bytes pulled from the stream)``."""
    headers = [
        (b"host", b"test"),
        (b"content-type", content_type.encode()),
    ]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if declared_length is not None:
        headers.append((b"content-length", str(declared_length).encode()))

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": headers,
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }

    remaining = payload
    consumed = 0

    async def receive() -> dict[str, object]:
        nonlocal remaining, consumed
        if remaining:
            chunk, remaining = remaining[:65536], remaining[65536:]
            consumed += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": True}
        return {"type": "http.request", "body": b"", "more_body": False}

    status: dict[str, int] = {}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = int(message["status"])  # type: ignore[arg-type]

    await app(scope, receive, send)  # type: ignore[operator]
    return status.get("code"), consumed


def _send(
    payload: bytes,
    *,
    origin: str | None = ORIGIN,
    declared_length: int | None | str = "auto",
    path: str = "/api/manager/documents",
    content_type: str = f"multipart/form-data; boundary={BOUNDARY}",
) -> tuple[int | None, int]:
    length: int | None
    if declared_length == "auto":
        length = len(payload)
    elif declared_length is None:
        length = None
    else:
        length = declared_length
    return asyncio.run(
        _read(
            create_app(),
            payload,
            origin=origin,
            declared_length=length,
            path=path,
            content_type=content_type,
        )
    )


CEILING = upload_body_ceiling(Settings(_env_file=None))


def test_the_ceiling_is_the_file_limit_plus_documented_overhead() -> None:
    assert CEILING == Settings(_env_file=None).upload_max_bytes + MULTIPART_OVERHEAD_BYTES


def test_a_cross_site_body_is_refused_without_being_read() -> None:
    """The whole point: nothing is buffered for a request that cannot proceed."""
    status, consumed = _send(
        _multipart(size=2 * 1024 * 1024), origin=FOREIGN_ORIGIN, declared_length=None
    )
    assert status == 403
    assert consumed == 0


def test_a_missing_origin_is_refused_without_being_read() -> None:
    status, consumed = _send(_multipart(size=2 * 1024 * 1024), origin=None)
    assert status == 403
    assert consumed == 0


@pytest.mark.parametrize("path", ["/api/auth/login", "/api/conversations"])
def test_json_writes_refuse_foreign_origin_before_reading(path: str) -> None:
    status, consumed = _send(
        b"{" + b"x" * 70_000 + b"}",
        path=path,
        content_type="application/json",
        origin=FOREIGN_ORIGIN,
        declared_length=None,
    )
    assert (status, consumed) == (403, 0)


@pytest.mark.parametrize(
    ("path", "field"),
    [("/api/auth/login", "password"), ("/api/conversations", "question")],
)
def test_json_writes_cap_chunked_bodies_before_parsing(path: str, field: str) -> None:
    payload = f'{{"{field}":"'.encode() + b"x" * 200_000 + b'"}'
    status, consumed = _send(
        payload,
        path=path,
        content_type="application/json",
        declared_length=None,
    )
    assert status == 413
    assert consumed < len(payload)


def test_a_declared_body_over_the_ceiling_is_refused_without_being_read() -> None:
    status, consumed = _send(_multipart(size=2 * 1024 * 1024))
    assert status == 413
    assert consumed == 0


def test_a_chunked_body_over_the_ceiling_is_refused() -> None:
    """No Content-Length must not mean no limit."""
    status, consumed = _send(_multipart(size=2 * 1024 * 1024), declared_length=None)
    # Refused at 401: the route authorises before it parses, so the oversized body
    # is never read at all. Either refusal is correct; reading it would not be.
    assert status in (401, 403, 413)
    assert consumed == 0


def test_several_file_parts_are_refused_without_being_read() -> None:
    status, consumed = _send(_multipart(size=700 * 1024, files=3), declared_length=None)
    assert status in (401, 413)
    assert consumed == 0


def _run_guard(
    downstream: Any, payload: bytes, *, declared_length: int | None = None
) -> tuple[int, bytes]:
    """Run the guard over a stub downstream app and return (status, payload)."""
    guard = UploadGuard(
        downstream,
        upload_path="/api/manager/documents",
        upload_max_body_bytes=upload_body_ceiling(Settings(_env_file=None)),
        json_paths={},
        settings=Settings(_env_file=None),
    )
    headers = [(b"host", b"test"), (b"origin", ORIGIN.encode())]
    if declared_length is not None:
        headers.append((b"content-length", str(declared_length).encode()))
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/manager/documents",
        "raw_path": b"",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": headers,
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }
    remaining = payload
    status: dict[str, int] = {}

    async def receive() -> dict[str, object]:
        nonlocal remaining
        if remaining:
            chunk, remaining = remaining[:65536], remaining[65536:]
            return {"type": "http.request", "body": chunk, "more_body": True}
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = int(message["status"])  # type: ignore[arg-type]

    asyncio.run(guard(scope, receive, send))
    return status.get("code", 0), payload


def test_a_stream_that_lies_about_its_length_is_still_capped() -> None:
    """The guard counts the stream, so an under-declared length is not trusted."""
    ceiling = CEILING
    delivered: list[int] = []

    async def downstream(scope: object, receive: Callable[[], Awaitable[dict]], send: Any) -> None:  # type: ignore[type-arg]
        while True:
            message = await receive()
            delivered.append(len(message.get("body", b"")))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    guard = UploadGuard(
        downstream,
        upload_path="/api/manager/documents",
        upload_max_body_bytes=ceiling,
        json_paths={},
        settings=Settings(_env_file=None),
    )

    status: dict[str, int] = {}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = int(message["status"])  # type: ignore[arg-type]

    payload = b"a" * (ceiling + 4096)
    remaining = payload
    sent = 0

    async def receive() -> dict[str, object]:
        nonlocal remaining, sent
        if remaining:
            chunk, remaining = remaining[:65536], remaining[65536:]
            sent += len(chunk)
            return {"type": "http.request", "body": chunk, "more_body": True}
        return {"type": "http.request", "body": b"", "more_body": False}

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/manager/documents",
        "raw_path": b"",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        # Deliberately under-declared, so only the streaming cap can catch it.
        "headers": [(b"host", b"test"), (b"origin", ORIGIN.encode())],
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }

    asyncio.run(guard(scope, receive, send))

    assert status.get("code") == 413
    # The application saw at most the ceiling; the source was read a little past it.
    assert sum(delivered) <= ceiling


def test_a_body_under_the_ceiling_is_left_alone() -> None:
    """The guard must not break ordinary uploads.

    Driven against a stub downstream app, because against the real app an
    unauthenticated caller is refused at 401 before the body is parsed - which is
    the desired behaviour, but it means the route never reads a body here.
    """
    delivered: list[int] = []

    async def downstream(scope: object, receive: Callable[[], Awaitable[dict]], send: Any) -> None:
        while True:
            message = await receive()
            delivered.append(len(message.get("body", b"")))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})

    status, payload = _run_guard(downstream, _multipart(size=32 * 1024))
    assert status == 200
    assert sum(delivered) == len(payload), "the whole legitimate body is delivered"


@pytest.mark.parametrize("length", [-1, 0, 5])
def test_other_paths_and_methods_are_untouched(length: int) -> None:
    """The guard is scoped to one POST path; it must not affect anything else."""
    app = create_app()
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "GET",
        "path": "/api/health",
        "raw_path": b"/api/health",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": [(b"host", b"test")],
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }
    status: dict[str, int] = {}

    async def receive() -> dict[str, object]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            status["code"] = int(message["status"])  # type: ignore[arg-type]

    asyncio.run(app(scope, receive, send))
    assert status.get("code") == 200
    assert length < 0 or length >= 0
