import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) =>
  Response.json({ detail: "request could not be completed" }, { status, headers: responseHeaders });

// The document identifier shape the API accepts. It is repeated here rather than
// imported so the proxy refuses a malformed id before it is forwarded, which keeps
// the proxy's allowlist and the API's pattern saying the same thing in one place
// each and neither silently becoming the only one.
const DOCUMENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
// The whole request body ceiling: the 1 MiB file limit plus the multipart framing
// allowance. The API applies the same ceiling, so this is the first of the two.
const BODY_CEILING = 1024 * 1024 + 64 * 1024;

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const documents = path.length === 1 && path[0] === "documents";
  const document = path.length === 2 && path[0] === "documents" && DOCUMENT_ID.test(path[1]);
  const job =
    path.length === 2 &&
    path[0] === "jobs" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path[1]);
  if (request.nextUrl.search || (!documents && !document && !job)) return failure(404);
  // A write is only ever accepted on a shape that can carry one: the collection, or
  // one document of it. Anything else is a method the route does not have.
  const allowed =
    request.method === "GET"
      ? documents || document || job
      : documents
        ? request.method === "POST"
        : document
          ? request.method === "PUT" || request.method === "DELETE" || request.method === "PATCH"
          : false;
  if (!allowed) return failure(405);
  const writes = request.method !== "GET";
  try {
    const config = serverConfig();
    const origin = request.headers.get("origin");
    // Every write demands the web origin, not merely tolerates it. A browser
    // attaches Origin to a cross-site write, and DELETE and PUT are not simple
    // methods, so their preflight would fail anyway; requiring it here means the
    // check does not depend on the browser's rules.
    if (writes ? origin !== config.webOrigin : origin !== null && origin !== config.webOrigin)
      return failure(403);
    const identity = await currentIdentity();
    if (!identity) return failure(401);
    if (identity.role !== "manager") return failure(403);
    const headers = new Headers({ Origin: config.webOrigin });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    let body: Uint8Array | undefined;
    // A create and a replacement both carry a multipart body; a delete carries none,
    // and forwarding an empty body with a write method would be a different request.
    if (request.method === "POST" || request.method === "PUT") {
      const contentType = request.headers.get("content-type");
      if (!contentType?.startsWith("multipart/form-data;")) return failure(415);
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > BODY_CEILING) {
          await reader.cancel();
          return failure(413);
        }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks);
      headers.set("Content-Type", contentType);
    }
    if (request.method === "PATCH") {
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
        return failure(415);
      const reader = request.body?.getReader();
      if (!reader) return failure(400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 1024) {
          await reader.cancel();
          return failure(413);
        }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks);
      headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(`${config.apiOrigin}/api/manager/${path.join("/")}`, {
      method: request.method,
      headers,
      body: body as BodyInit | undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok)
      return failure(
        [400, 401, 403, 404, 409, 413, 415, 422, 503].includes(upstream.status)
          ? upstream.status
          : 502,
      );
    // A delete has nothing to report. Answering 204 here keeps the proxy from
    // inventing a body the API deliberately did not send.
    if (upstream.status === 204)
      return new Response(null, { status: 204, headers: responseHeaders });
    const data = await upstream.json();
    // Only processing metadata crosses the proxy, never staging text or provider details.
    const pickJob = (item: Record<string, unknown>) => ({
      job_id: item.job_id,
      document_id: item.document_id,
      revision: item.revision,
      status: item.status,
      attempt: item.attempt,
      safe_error: item.safe_error,
    });
    const result =
      request.method === "GET" && documents
        ? {
            documents: data.documents.map((item: Record<string, unknown>) => ({
              document_id: item.document_id,
              title: item.title,
              access_role: item.access_role,
              version: item.version,
              content_status: item.content_status,
              processing_status: item.processing_status,
              has_published_revision: item.has_published_revision,
              updated_at: item.updated_at,
              job_id: item.job_id,
              safe_error: item.safe_error,
            })),
          }
        : pickJob(data);
    return Response.json(result, { status: upstream.status, headers: responseHeaders });
  } catch {
    return failure(502);
  }
}
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const PATCH = handle;
