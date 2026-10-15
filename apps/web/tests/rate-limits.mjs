import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const realRequire = createRequire(import.meta.url);
function load(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => (name in imports ? imports[name] : realRequire(name)),
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const value = {
  requests_per_user_per_minute: 6,
  concurrency: { ollama: 1, cloud: 6 },
  max_queued_requests_per_provider: 50,
  version: 1,
};
const contract = load("../src/lib/rate-limit-contract.ts");
assert.deepEqual(contract.parseRateLimitSettings(value), value);
assert.throws(() =>
  contract.parseRateLimitSettings({ ...value, concurrency: { ollama: 0, cloud: 6 } }),
);

let identity = { role: "manager" };
let status = 200;
const sent = [];
globalThis.fetch = async (_url, options) => {
  sent.push(options);
  return status === 200 ? Response.json(value) : new Response(null, { status });
};
const route = load("../src/app/api/manager/settings/rate-limits/route.ts", {
  "@/lib/auth-server": { currentIdentity: async () => identity },
  "@/lib/server-config": {
    serverConfig: () => ({ webOrigin: "http://localhost:3000", apiOrigin: "http://api.test" }),
  },
  "@/lib/rate-limit-contract": contract,
  "../../../read-proxy": {
    PROXY_HEADERS: { "Cache-Control": "no-store" },
    proxyFailure: (code) => new Response(null, { status: code }),
  },
});
const request = (method, origin = "http://localhost:3000") => ({
  method,
  nextUrl: { search: "" },
  headers: new Headers({ Origin: origin, "Content-Type": "application/json" }),
  cookies: { get: () => ({ value: "session" }) },
  body: new Response(JSON.stringify(value)).body,
});
assert.equal((await route.GET(request("GET"))).status, 200);
assert.equal((await route.PUT(request("PUT"))).status, 200);
assert.equal(sent.at(-1).method, "PUT");
assert.equal(sent.at(-1).headers.get("Cookie"), "ekc_session=session");
assert.equal((await route.PUT(request("PUT", "http://foreign.test"))).status, 403);
identity = { role: "employee" };
assert.equal((await route.GET(request("GET"))).status, 403);
identity = null;
assert.equal((await route.GET(request("GET"))).status, 401);
identity = { role: "manager" };
status = 409;
assert.equal((await route.PUT(request("PUT"))).status, 409);

let answerDetail = "سرویس مشغول است؛ کمی بعد دوباره تلاش کنید";
globalThis.fetch = async () => Response.json({ detail: answerDetail }, { status: 503 });
const answers = load("../src/app/api/answers/route.ts", {
  "@/lib/auth-server": { currentIdentity: async () => ({ role: "employee" }) },
  "@/lib/server-config": {
    serverConfig: () => ({ webOrigin: "http://localhost:3000", apiOrigin: "http://api.test" }),
  },
});
const answerRequest = () => ({
  method: "POST",
  headers: new Headers({ Origin: "http://localhost:3000", "Content-Type": "application/json" }),
  cookies: { get: () => ({ value: "session" }) },
  body: new Response(JSON.stringify({ question: "test" })).body,
});
const busy = await answers.POST(answerRequest());
assert.equal(busy.status, 503);
assert.equal((await busy.json()).detail, answerDetail);
answerDetail = "provider configuration unavailable";
const hidden = await answers.POST(answerRequest());
assert.equal(hidden.status, 503);
assert.equal((await hidden.json()).detail, "request could not be completed");
console.log("PASS rate-limit DTO and same-origin manager proxy checks");
