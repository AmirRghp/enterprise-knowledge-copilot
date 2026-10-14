import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const realRequire = createRequire(import.meta.url);
function load(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => (name in imports ? imports[name] : realRequire(name)),
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const id = "00000000-0000-4000-8000-000000000009";
const customId = "00000000-0000-4000-8000-000000000010";
const body = {
  version: 3,
  prompts: [
    {
      prompt_id: id,
      name: "پیش‌فرض",
      prompt_text: "هستهٔ ثابت",
      created_by: null,
      is_default: true,
      is_active: false,
      can_edit: false,
      revision: 1,
    },
    {
      prompt_id: customId,
      name: "پاسخ کوتاه",
      prompt_text: "کوتاه پاسخ بده",
      created_by: id,
      is_default: false,
      is_active: true,
      can_edit: true,
      revision: 2,
    },
  ],
};
const contract = load("../src/lib/system-prompt-contract.ts");
assert.deepEqual(contract.parseSystemPrompts(body), body);
assert.throws(() => contract.parseSystemPrompts({ ...body, prompts: body.prompts.slice(1) }));
assert.throws(() =>
  contract.parseSystemPrompts({
    ...body,
    prompts: body.prompts.map((prompt) => ({ ...prompt, prompt_text: " ".repeat(16_001) })),
  }),
);

let identity = { role: "manager" };
const origin = "http://localhost:3000";
const sent = [];
let status = 200;
globalThis.fetch = async (url, options) => {
  sent.push({ url, options });
  if (options.method === "PUT") return new Response(null, { status: 204 });
  return Response.json(body, { status });
};
const route = load("../src/app/api/manager/system-prompts/[[...path]]/route.ts", {
  "@/lib/auth-server": { currentIdentity: async () => identity },
  "@/lib/server-config": {
    serverConfig: () => ({ webOrigin: origin, apiOrigin: "http://api.test" }),
  },
  "@/lib/system-prompt-contract": contract,
  "../../../read-proxy": {
    PROXY_HEADERS: { "Cache-Control": "no-store" },
    proxyFailure: (value) => Response.json({ error: "request rejected" }, { status: value }),
  },
});

function request(method, { requestOrigin = origin, query = "", body: data = {} } = {}) {
  return {
    method,
    nextUrl: { search: query },
    headers: new Headers({ Origin: requestOrigin, "Content-Type": "application/json" }),
    cookies: { get: () => ({ value: "synthetic" }) },
    body: new Response(JSON.stringify(data)).body,
  };
}
const call = (method, path = [], options = {}) =>
  route[method](request(method, options), { params: Promise.resolve({ path }) });

assert.equal((await call("GET")).status, 200);
assert.equal((await call("GET", [], { requestOrigin: "http://foreign.test" })).status, 403);
identity = { role: "employee" };
assert.equal((await call("GET")).status, 403);
identity = null;
assert.equal((await call("GET")).status, 401);
identity = { role: "manager" };
assert.equal((await call("POST", ["unknown"])).status, 404);
assert.equal((await call("GET", [], { query: "?page=1" })).status, 404);
const created = await call("POST", [], { body: { name: "new", prompt_text: "text" } });
assert.equal(created.status, 200);
assert.equal(sent.at(-1).options.headers.get("Cookie"), "ekc_session=synthetic");
assert.equal(sent.at(-1).options.headers.get("Authorization"), null);
assert.equal((await call("PUT", [customId])).status, 204);
status = 409;
assert.equal((await call("POST", [customId, "activate"])).status, 409);
console.log("PASS system prompt DTO and same-origin manager proxy checks");
