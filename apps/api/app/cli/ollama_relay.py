"""Optional Linux Docker Engine bridge to host Ollama's loopback listener."""

import asyncio
import os
from pathlib import Path

SOCKET_DIR = Path("/run/ollama-relay")
SOCKET = SOCKET_DIR / "ollama.sock"
APP_UID = 10001


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    finally:
        writer.close()


async def relay(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter) -> None:
    try:
        host_reader, host_writer = await asyncio.open_connection("127.0.0.1", 11434)
    except OSError:
        client_writer.close()
        await client_writer.wait_closed()
        return
    tasks = {
        asyncio.create_task(pipe(client_reader, host_writer)),
        asyncio.create_task(pipe(host_reader, client_writer)),
    }
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    for writer in (host_writer, client_writer):
        writer.close()
        await writer.wait_closed()
    for task in done:
        if not task.cancelled() and task.exception():
            raise task.exception()


async def main() -> None:
    # The helper starts as root only to prepare its private named volume.
    SOCKET_DIR.mkdir(mode=0o700, exist_ok=True)
    os.chown(SOCKET_DIR, APP_UID, APP_UID)
    os.chmod(SOCKET_DIR, 0o700)
    SOCKET.unlink(missing_ok=True)
    os.setgid(APP_UID)
    os.setuid(APP_UID)
    os.umask(0o177)
    server = await asyncio.start_unix_server(relay, path=str(SOCKET))
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
