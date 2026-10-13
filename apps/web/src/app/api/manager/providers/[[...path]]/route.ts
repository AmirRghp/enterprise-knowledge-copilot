import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";
import { parseProviders, purposes } from "@/lib/provider-contract";
import { PROXY_HEADERS, proxyFailure } from "../../../read-proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 64 * 1024;
async function bounded(
  stream: ReadableStream<Uint8Array> | null,
  limit = LIMIT,
): Promise<Uint8Array> {
  const reader = stream?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > limit) {
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
async function handle(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path ?? [];
  const purpose = path[0];
  const known = purposes.includes(purpose as (typeof purposes)[number]);
  const item = known && path.length === 2 && UUID.test(path[1]);
  const order = known && path.length === 2 && path[1] === "order";
  const test = known && path.length === 3 && UUID.test(path[1]) && path[2] === "test";
  const method = request.method;
  const allowed =
    (path.length === 0 && method === "GET") ||
    (known && path.length === 1 && method === "POST") ||
    (purpose === "rerank" && path.length === 1 && method === "PATCH") ||
    (item && ["PUT", "DELETE"].includes(method)) ||
    (order && method === "PUT") ||
    (test && method === "POST");
  if (request.nextUrl.search || !allowed) return proxyFailure(404);
  try {
    const config = serverConfig();
    const origin = request.headers.get("origin");
    if (
      method === "GET"
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
    if (method !== "GET") {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
        return proxyFailure(415);
      body = await bounded(request.body);
      headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(
      `${config.apiOrigin}/api/manager/providers${path.length ? "/" + path.join("/") : ""}`,
      {
        method,
        headers,
        body: body as BodyInit | undefined,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(test ? 25_000 : 15_000),
      },
    );
    if (!upstream.ok)
      return proxyFailure(
        [401, 403, 404, 409, 413, 415, 422, 502, 503, 504].includes(upstream.status)
          ? upstream.status
          : 502,
      );
    if (upstream.status === 204) return new Response(null, { status: 204, headers: PROXY_HEADERS });
    const data = JSON.parse(new TextDecoder().decode(await bounded(upstream.body, 1024 * 1024)));
    const result = test
      ? { status: ["passed", "failed"].includes(data.status) ? data.status : "failed" }
      : parseProviders(data);
    return Response.json(result, { status: upstream.status, headers: PROXY_HEADERS });
  } catch (error) {
    return proxyFailure(error instanceof RangeError ? 413 : 502);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
