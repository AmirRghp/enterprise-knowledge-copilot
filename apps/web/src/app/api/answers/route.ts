import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const failure = (status: number, headers?: Record<string, string>) =>
  Response.json(
    { detail: "request could not be completed" },
    { status, headers: { ...responseHeaders, ...headers } },
  );

// The whole request body ceiling for this path. The API applies the same figure in
// the ASGI layer before it parses the body, so this is the first of the two. It is
// not derived from the 2,000-character question limit: the guard runs before the
// question is parsed and cannot know how much of the body is the question, and a
// bound loose enough to be meaningless is not a bound.
const BODY_CEILING = 64 * 1024;

// The API's own whole-request budget is 60 seconds. This is that plus margin, so
// the proxy is never the layer that gives up first: a 504 from the API means the
// budget was genuinely spent, while a timeout here would mean the connection broke
// for some other reason and the caller would be told the system failed when it did
// not. Not an absolute guarantee — network latency can still time out — which is
// why the UI treats those two cases as different messages.
const UPSTREAM_TIMEOUT_MS = 70_000;
const QUEUE_BUSY = "سرویس مشغول است؛ کمی بعد دوباره تلاش کنید";

const ALLOWED_UPSTREAM_STATUSES = [400, 401, 403, 404, 413, 422, 429, 502, 503, 504];

/**
 * Read a stream, refusing it past `ceiling` bytes. Returns null when the body is over.
 *
 * Separated from the route for the same reason the API's guard is a class rather than
 * inline code: the rule has to be provable on its own. Asserting this through HTTP
 * could not tell a proxy that refused from one that forwarded and got the same 413
 * back from the API - the very ambiguity that let a deleted guard keep the test green.
 * Here the only question is whether the function stops reading.
 *
 * Counting happens after each chunk, so the source is read up to one chunk beyond the
 * ceiling. That is the cost of streaming; the alternative is trusting Content-Length,
 * which a chunked request does not have.
 */
export async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ceiling: number,
): Promise<Uint8Array[] | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > ceiling) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  return chunks;
}

export async function POST(request: NextRequest) {
  const config = serverConfig();
  // Every write demands the web origin, not merely tolerates it. This endpoint
  // spends money on every call and reads documents, so a cross-site page must not
  // be able to make it.
  if (request.headers.get("origin") !== config.webOrigin) return failure(403);

  // Everything that can fail on its own sits inside this boundary, so a dead auth
  // service or a broken body stream leaves as a 502 carrying the same no-store
  // headers as every other answer from this route - and not as Next's default error
  // page, which would be HTML where the caller expects JSON and would carry no
  // cache directive. The manager proxy keeps its identity call in the same place;
  // this route had it outside, which meant the difference was only visible while the
  // API was up.
  try {
    const identity = await currentIdentity();
    if (!identity) return failure(401);

    const contentType = request.headers.get("content-type");
    if (!contentType?.startsWith("application/json")) return failure(415);
    const reader = request.body?.getReader();
    if (!reader) return failure(400);
    const chunks = await readBounded(reader, BODY_CEILING);
    if (chunks === null) return failure(413);

    const headers = new Headers({ Origin: config.webOrigin, "Content-Type": "application/json" });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    const upstream = await fetch(`${config.apiOrigin}/api/answers`, {
      method: "POST",
      headers,
      body: Buffer.concat(chunks) as BodyInit,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!upstream.ok) {
      if (upstream.status === 503) {
        const body = await upstream.json().catch(() => null);
        if (body && typeof body === "object" && "detail" in body && body.detail === QUEUE_BUSY)
          return Response.json({ detail: QUEUE_BUSY }, { status: 503, headers: responseHeaders });
      }
      // A rate-limited caller needs the retry delay or the header is useless to it.
      const retryAfter = upstream.headers.get("retry-after");
      const passthrough =
        retryAfter && /^\d+$/.test(retryAfter) ? { "Retry-After": retryAfter } : undefined;
      return failure(
        ALLOWED_UPSTREAM_STATUSES.includes(upstream.status) ? upstream.status : 502,
        passthrough,
      );
    }
    // Only the five contract keys cross. Nothing is added and nothing is removed:
    // the proxy is not a place to summarize, and a field it invented would be
    // indistinguishable from one the API promised.
    const data = await upstream.json();
    return Response.json(data, { status: upstream.status, headers: responseHeaders });
  } catch {
    // A timeout or a broken connection. Deliberately not 502-with-detail: the
    // distinction between "too slow" and "unreachable" is the caller's to make
    // from the status alone, and both are 502 here.
    return failure(502);
  }
}
