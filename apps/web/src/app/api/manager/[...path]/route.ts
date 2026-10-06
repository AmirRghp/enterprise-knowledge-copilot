import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number) =>
  Response.json({ detail: "request could not be completed" }, { status, headers: responseHeaders });

async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const documents = path.length === 1 && path[0] === "documents";
  const job =
    path.length === 2 &&
    path[0] === "jobs" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path[1]);
  if (request.nextUrl.search || (!documents && !job)) return failure(404);
  if (request.method !== "GET" && !(documents && request.method === "POST")) return failure(405);
  try {
    const config = serverConfig();
    const origin = request.headers.get("origin");
    if ((request.method === "POST" || origin !== null) && origin !== config.webOrigin)
      return failure(403);
    const identity = await currentIdentity();
    if (!identity) return failure(401);
    if (identity.role !== "manager") return failure(403);
    const headers = new Headers({ Origin: config.webOrigin });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    let body: Uint8Array | undefined;
    if (request.method === "POST") {
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
        if (size > 1024 * 1024 + 64 * 1024) {
          await reader.cancel();
          return failure(413);
        }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks);
      headers.set("Content-Type", contentType);
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
        [400, 401, 403, 404, 413, 422].includes(upstream.status) ? upstream.status : 502,
      );
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
