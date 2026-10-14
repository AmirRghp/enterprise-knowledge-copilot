"""Resolve, validate and pin each connection; proxies and redirects are never trusted."""

import asyncio
import ipaddress
import os
import socket

import httpx

from app.provider_config.contracts import ProviderConfigurationError, validate_url

MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DOCKER_NETWORKS = tuple(
    ipaddress.ip_network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)


async def addresses(host: str, port: int) -> list[str]:
    try:
        results = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        ips = list(dict.fromkeys(str(result[4][0]) for result in results))
    except OSError:
        raise httpx.ConnectError("provider DNS resolution failed") from None
    local = host in ("localhost", "127.0.0.1", "::1")
    if not ips:
        raise httpx.ConnectError("provider DNS resolution failed")

    def allowed(ip: str) -> bool:
        address = ipaddress.ip_address(ip)
        # Only the named Compose service may use RFC1918; metadata/link-local stays blocked.
        if host == "host.docker.internal" and port == 11434:
            return any(address in network for network in DOCKER_NETWORKS)
        return address.is_loopback if local else address.is_global

    if any(not allowed(ip) for ip in ips):
        raise ProviderConfigurationError("provider destination is not allowed")
    return ips


class ProviderTransport(httpx.AsyncBaseTransport):
    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            validate_url(str(request.url))
        except ValueError:
            raise ProviderConfigurationError("provider endpoint is not allowed") from None
        host = request.url.host
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        relay_socket = os.environ.get("OLLAMA_RELAY_SOCKET")
        use_relay = bool(
            relay_socket
            and request.url.scheme == "http"
            and host == "host.docker.internal"
            and port == 11434
        )
        destinations = [host] if use_relay else await addresses(host, port)
        # Pin network requests to validated IPs; the relay uses only the private socket.
        headers = request.headers.copy()
        headers["Host"] = "localhost:11434" if use_relay else request.url.netloc.decode()
        extensions = {**request.extensions, "sni_hostname": host}
        content = await request.aread()
        transport = httpx.AsyncHTTPTransport(uds=relay_socket) if use_relay else None
        async with httpx.AsyncClient(
            transport=transport, trust_env=False, follow_redirects=False
        ) as client:
            response = None
            for index, ip in enumerate(destinations):
                outbound = httpx.Request(
                    request.method,
                    request.url if use_relay else request.url.copy_with(host=ip),
                    headers=headers,
                    content=content,
                    extensions=extensions,
                )
                try:
                    response = await client.send(outbound, stream=True)
                    break
                except (httpx.ConnectError, httpx.ConnectTimeout):
                    if index == len(destinations) - 1:
                        raise
            if response is None:
                raise httpx.ConnectError("provider destination is unavailable")
            try:
                if 300 <= response.status_code < 400:
                    raise ProviderConfigurationError("provider redirect is not allowed")
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise httpx.ReadError("provider response is too large")
                    chunks.append(chunk)
                response_headers = response.headers.copy()
                response_headers.pop("content-encoding", None)
                response_headers.pop("content-length", None)
                return httpx.Response(
                    response.status_code,
                    headers=response_headers,
                    content=b"".join(chunks),
                    request=request,
                )
            finally:
                await response.aclose()


def provider_client(timeout: float = 30) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=ProviderTransport(), trust_env=False, follow_redirects=False, timeout=timeout
    )
