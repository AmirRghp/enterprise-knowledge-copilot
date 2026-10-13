import { type NextRequest } from "next/server";
import { identityFrom } from "@/lib/auth-contract";
import { serverConfig } from "@/lib/server-config";

const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function failure(status: number) {
  return Response.json(
    { detail: "request could not be completed" },
    { status, headers: responseHeaders },
  );
}

async function handle(request: NextRequest, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!["login", "logout", "me", "setup"].includes(action) || request.nextUrl.search)
    return failure(404);
  if (
    action === "setup"
      ? !["GET", "POST"].includes(request.method)
      : request.method !== (action === "me" ? "GET" : "POST")
  )
    return failure(405);
  try {
    const config = serverConfig();
    const headers = new Headers();
    if (request.method === "POST") {
      if (request.headers.get("origin") !== config.webOrigin) return failure(403);
      headers.set("Origin", config.webOrigin);
    }
    const token = request.cookies.get("ekc_session")?.value;
    if (token) headers.set("Cookie", `ekc_session=${encodeURIComponent(token)}`);
    let body: string | undefined;
    if (action === "login" || (action === "setup" && request.method === "POST")) {
      if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json")
        return failure(415);
      const reader = request.body?.getReader();
      if (!reader) return failure(422);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return failure(413);
        }
        chunks.push(chunk.value);
      }
      try {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const login = action === "setup" ? input?.email : input?.login;
        if (
          action === "setup" &&
          Object.keys(input ?? {}).some(
            (key) => !["email", "password", "first_name", "last_name"].includes(key),
          )
        )
          return failure(422);
        if (
          typeof login !== "string" ||
          typeof input?.password !== "string" ||
          !login.length ||
          login.length > 200 ||
          !input.password.length ||
          input.password.length > 512
        )
          return failure(422);
        if (
          action === "setup" &&
          [input.first_name, input.last_name].some(
            (name) => typeof name !== "string" || !name.trim().length || name.length > 100,
          )
        )
          return failure(422);
        body = JSON.stringify(
          action === "setup"
            ? {
                email: login,
                password: input.password,
                first_name: input.first_name,
                last_name: input.last_name,
              }
            : { login, password: input.password },
        );
      } catch {
        return failure(422);
      }
      headers.set("Content-Type", "application/json");
    }
    const upstream = await fetch(`${config.apiOrigin}/api/auth/${action}`, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!upstream.ok) {
      const result = failure(
        [401, 403, 409, 413, 415, 422, 429].includes(upstream.status) ? upstream.status : 502,
      );
      const retry = upstream.headers.get("retry-after");
      if (upstream.status === 429 && retry && /^\d+$/.test(retry))
        result.headers.set("Retry-After", retry);
      return result;
    }
    let result: Response;
    if (action === "logout") {
      if (upstream.status !== 204) return failure(502);
      result = new Response(null, { status: 204, headers: responseHeaders });
    } else {
      const data = await upstream.json();
      if (action === "setup" && request.method === "GET") {
        if (typeof data.setup_required !== "boolean") return failure(502);
        result = Response.json(
          { setup_required: data.setup_required },
          { headers: responseHeaders },
        );
      } else if (action === "me")
        result = Response.json(identityFrom(data), { headers: responseHeaders });
      else {
        if (typeof data.login !== "string" || !["employee", "manager"].includes(data.role))
          return failure(502);
        result = Response.json(
          { login: data.login, role: data.role },
          { status: upstream.status, headers: responseHeaders },
        );
      }
    }
    for (const cookie of upstream.headers.getSetCookie()) {
      if (cookie.startsWith("ekc_session=") && !/;\s*domain=/i.test(cookie))
        result.headers.append("Set-Cookie", cookie);
    }
    return result;
  } catch {
    return failure(502);
  }
}

export const GET = handle;
export const POST = handle;
