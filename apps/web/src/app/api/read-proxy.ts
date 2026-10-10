import { type NextRequest } from "next/server";
import { currentIdentity } from "@/lib/auth-server";
import { serverConfig } from "@/lib/server-config";

/**
 * Shared plumbing for the read-only proxies.
 *
 * Two routes need the same five things: a session, the web origin on every request that
 * carries one, a narrow upstream status allowlist, and a body that never reaches the
 * caller with an error page instead of JSON. Written once because the Part 16 review found
 * the hard way what happens when one route forgets: an identity lookup outside the error
 * boundary leaves Next's default page as the response, which is HTML where the caller
 * expects JSON and carries no cache directive.
 *
 * `enforce_origin` on the API skips safe methods, so a cross-site GET of a document would be
 * served if this proxy forwarded one. It is closed here instead: the web origin is
 * *required*, not merely tolerated, and the response carries no CORS grant.
 */

export const PROXY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export const proxyFailure = (status: number) =>
  Response.json({ detail: "request could not be completed" }, { status, headers: PROXY_HEADERS });

// Only statuses the API actually serves for a read. Anything else becomes 502 so an
// unexpected upstream status is not relayed as though it were meaningful.
const ALLOWED_UPSTREAM_STATUSES = [401, 403, 404, 422, 502, 504];

/**
 * Forward one authorized read to the API and return its body verbatim.
 *
 * Verbatim matters more here than anywhere else in the app: the API answers a missing,
 * forbidden and stale source with one byte-identical 404, and reshaping that on the way out
 * would let the browser tell them apart - which is the whole thing the single query is for.
 */
export async function forwardRead(
  request: NextRequest,
  upstreamPath: string,
  search: string,
): Promise<Response> {
  try {
    const config = serverConfig();
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== config.webOrigin) return proxyFailure(403);

    // Inside the boundary: a dead auth service leaves as the same fixed 502 as any other
    // failure here, never as an unhandled rejection.
    const identity = await currentIdentity();
    if (!identity) return proxyFailure(401);

    const headers = new Headers({ Origin: config.webOrigin });
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);

    const upstream = await fetch(`${config.apiOrigin}${upstreamPath}${search}`, {
      method: "GET",
      headers,
      cache: "no-store",
      redirect: "error",
      // A read of one section is a database query, not a provider call. The answer
      // route's 70s budget is sized for model latency and would leave a page open for a
      // minute on what should be instant.
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      return proxyFailure(
        ALLOWED_UPSTREAM_STATUSES.includes(upstream.status) ? upstream.status : 502,
      );
    }
    // The body crosses untouched. The route's own `response_model` already decided what a
    // client may see, and re-picking fields here is a second place for that decision to go
    // wrong - and one that would quietly drop a field the contract promises.
    return Response.json(await upstream.json(), { status: 200, headers: PROXY_HEADERS });
  } catch {
    return proxyFailure(502);
  }
}
