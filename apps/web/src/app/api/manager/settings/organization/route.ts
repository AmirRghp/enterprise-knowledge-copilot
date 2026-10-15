import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";
import { parseOrganization } from "@/lib/organization-contract";
import { PROXY_HEADERS, proxyFailure } from "../../../read-proxy";

const LIMIT = 8192;

async function bounded(stream: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  const reader = stream?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LIMIT) {
        await reader.cancel();
        throw new RangeError("body too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function handle(request: NextRequest) {
  if (request.nextUrl.search || !["GET", "PUT"].includes(request.method)) return proxyFailure(404);
  try {
    const config = serverConfig();
    const origin = request.headers.get("origin");
    if (
      request.method === "GET"
        ? origin !== null && origin !== config.webOrigin
        : origin !== config.webOrigin
    )
      return proxyFailure(403);
    const identity = await currentIdentity();
    if (!identity) return proxyFailure(401);
    if (identity.role !== "manager") return proxyFailure(403);
    const headers = new Headers({ Origin: config.webOrigin });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    let body: Uint8Array | undefined;
    if (request.method === "PUT") {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
        return proxyFailure(415);
      body = await bounded(request.body);
      headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(`${config.apiOrigin}/api/manager/settings/organization`, {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok)
      return proxyFailure(
        [401, 403, 413, 415, 422, 503].includes(upstream.status) ? upstream.status : 502,
      );
    return Response.json(
      parseOrganization(JSON.parse(new TextDecoder().decode(await bounded(upstream.body)))),
      { status: upstream.status, headers: PROXY_HEADERS },
    );
  } catch (error) {
    return proxyFailure(error instanceof RangeError ? 413 : 502);
  }
}

export const GET = handle;
export const PUT = handle;
