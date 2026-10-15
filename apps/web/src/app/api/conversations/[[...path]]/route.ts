import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) =>
  Response.json({ detail: "request could not be completed" }, { status, headers });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

async function readBounded(request: NextRequest): Promise<Uint8Array[] | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return chunks;
    size += chunk.value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
}

function allowed(method: string, path: string[]) {
  if (path.length === 0) return method === "GET" || method === "POST";
  if (path.length === 1) return UUID.test(path[0]) && ["GET", "PATCH", "DELETE"].includes(method);
  if (path.length === 2) return UUID.test(path[0]) && path[1] === "turns" && method === "POST";
  return (
    path.length === 4 &&
    UUID.test(path[0]) &&
    path[1] === "turns" &&
    UUID.test(path[2]) &&
    ["retry", "cancel"].includes(path[3]) &&
    method === "POST"
  );
}

async function forward(request: NextRequest, context: { params: Promise<{ path?: string[] }> }) {
  try {
    const method = request.method;
    const { path = [] } = await context.params;
    if (!METHODS.has(method) || !allowed(method, path)) return failure(404);
    const config = serverConfig();
    const origin = request.headers.get("origin");
    if (
      (method !== "GET" && origin !== config.webOrigin) ||
      (origin && origin !== config.webOrigin)
    )
      return failure(403);
    if (!(await currentIdentity())) return failure(401);

    const upstreamHeaders = new Headers({ Origin: config.webOrigin });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) upstreamHeaders.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    let body: BodyInit | undefined;
    const bodylessTurnAction =
      method === "POST" && path.length === 4 && ["retry", "cancel"].includes(path[3]);
    if ((method === "POST" || method === "PATCH") && !bodylessTurnAction) {
      if (!request.headers.get("content-type")?.startsWith("application/json")) return failure(415);
      if (!request.body) return failure(400);
      const chunks = await readBounded(request);
      if (chunks === null) return failure(413);
      body = Buffer.concat(chunks) as BodyInit;
      upstreamHeaders.set("Content-Type", "application/json");
    }
    const query = new URLSearchParams();
    for (const [key, value] of request.nextUrl.searchParams) {
      if (!["cursor", "limit"].includes(key) || query.has(key)) return failure(422);
      query.set(key, value);
    }
    const suffix = path.map(encodeURIComponent).join("/");
    const upstream = await fetch(
      `${config.apiOrigin}/api/conversations${suffix ? `/${suffix}` : ""}${query.size ? `?${query}` : ""}`,
      {
        method,
        headers: upstreamHeaders,
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (upstream.status === 204) return new Response(null, { status: 204, headers });
    if (!upstream.ok)
      return failure(
        [401, 403, 404, 409, 422, 429, 502, 503, 504].includes(upstream.status)
          ? upstream.status
          : 502,
      );
    return Response.json(await upstream.json(), { status: upstream.status, headers });
  } catch {
    return failure(502);
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
export const PUT = forward;
