import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";
import { parseUser, parseUsers } from "@/lib/user-contract";
import { PROXY_HEADERS, proxyFailure } from "../../../read-proxy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function bounded(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string> {
  const reader = stream?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError("body too large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function handle(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  const path = (await context.params).path ?? [];
  const method = request.method;
  const list = path.length === 0 && method === "GET";
  const create = path.length === 0 && method === "POST";
  const change = path.length === 1 && UUID.test(path[0]) && method === "PATCH";
  const password =
    path.length === 2 && UUID.test(path[0]) && path[1] === "password" && method === "PUT";
  if (!list && !create && !change && !password) return proxyFailure(404);
  const query = request.nextUrl.searchParams;
  if (
    [...query.keys()].some((key) => !list || key !== "page") ||
    query.getAll("page").length > 1 ||
    (query.has("page") &&
      (!/^[1-9]\d{0,6}$/.test(query.get("page")!) || Number(query.get("page")) > 1_000_000))
  )
    return proxyFailure(404);
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
    let body: string | undefined;
    if (method !== "GET") {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
        return proxyFailure(415);
      body = await bounded(request.body, 8192);
      headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(
      `${config.apiOrigin}/api/manager/users${path.length ? "/" + path.join("/") : ""}${request.nextUrl.search}`,
      {
        method,
        headers,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!upstream.ok)
      return proxyFailure(
        [401, 403, 404, 409, 413, 415, 422, 429].includes(upstream.status) ? upstream.status : 502,
      );
    if (password) {
      if (upstream.status !== 204) return proxyFailure(502);
      return new Response(null, { status: 204, headers: PROXY_HEADERS });
    }
    const data = JSON.parse(await bounded(upstream.body, 256 * 1024));
    return Response.json(list ? parseUsers(data) : parseUser(data), {
      status: upstream.status,
      headers: PROXY_HEADERS,
    });
  } catch (error) {
    return proxyFailure(error instanceof RangeError ? 413 : 502);
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
