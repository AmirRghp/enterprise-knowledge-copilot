import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const realRequire = createRequire(import.meta.url);
function load(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => (name in imports ? imports[name] : realRequire(name)),
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}
const origin = "http://localhost:3000";
let identity = { role: "manager" };
const common = {
  "@/lib/auth-server": { currentIdentity: async () => identity },
  "@/lib/server-config": {
    serverConfig: () => ({ webOrigin: origin, apiOrigin: "http://local.test" }),
  },
  "../../../read-proxy": {
    PROXY_HEADERS: { "Cache-Control": "no-store" },
    proxyFailure: (status) =>
      Response.json({ detail: "request could not be completed" }, { status }),
  },
};
const contract = load("../src/lib/user-contract.ts");
const route = load("../src/app/api/manager/users/[[...path]]/route.ts", {
  ...common,
  "@/lib/user-contract": contract,
});
const auth = load("../src/app/api/auth/[action]/route.ts", {
  ...common,
  "@/lib/auth-contract": load("../src/lib/auth-contract.ts"),
});
const user = {
  user_id: "00000000-0000-4000-8000-000000000001",
  login: "user@example.com",
  role: "employee",
  is_active: true,
  created_at: "2026-10-13T00:00:00Z",
  first_name: "علی",
  last_name: "احمدی",
};
let sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  sent.push({ url, ...options });
  if (url.includes("/password")) return new Response(null, { status: 204 });
  if (url.endsWith("/auth/setup"))
    return options.method === "GET"
      ? Response.json({ setup_required: true })
      : Response.json(
          { login: "admin@example.com", role: "manager" },
          {
            status: 201,
            headers: { "Set-Cookie": "ekc_session=synthetic; HttpOnly; Path=/; SameSite=Lax" },
          },
        );
  return Response.json(options.method === "GET" ? { users: [user], total: 1, page: 1 } : user, {
    status: options.method === "POST" ? 201 : 200,
  });
};
function request(method, path, { query = "", headers = {}, body = {}, stream } = {}) {
  const nextUrl = new URL(`http://localhost:3000/${path.join("/")}${query}`);
  return {
    method,
    nextUrl,
    headers: new Headers({ Origin: origin, "Content-Type": "application/json", ...headers }),
    cookies: { get: () => ({ value: "synthetic" }) },
    body: stream ?? new Response(JSON.stringify(body)).body,
  };
}
async function managerCall(method, path = [], options) {
  return route[method](request(method, path, options), { params: Promise.resolve({ path }) });
}
try {
  for (const [method, path, query] of [
    ["GET", ["invalid"], ""],
    ["GET", [], "?page=0"],
    ["GET", [], "?page=1&page=2"],
    ["GET", [], "?role=manager"],
    ["POST", [], "?page=1"],
    ["PUT", [user.user_id], ""],
    ["PATCH", [user.user_id, "password"], ""],
  ]) {
    assert.equal((await managerCall(method, path, { query })).status, 404);
  }
  assert.equal(sent.length, 0, "disallowed requests never forwarded");
  assert.equal(
    (await managerCall("POST", [], { headers: { Origin: "https://foreign.test" } })).status,
    403,
  );
  identity = null;
  assert.equal((await managerCall("GET")).status, 401);
  identity = { role: "employee" };
  assert.equal((await managerCall("POST")).status, 403);
  assert.equal(sent.length, 0);
  identity = { role: "manager" };
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal((await managerCall("POST", [], { stream })).status, 413);
  assert(cancelled, "oversized stream cancelled");
  assert.equal(sent.length, 0);
  const listing = await managerCall("GET", [], { query: "?page=1" });
  assert.deepEqual(await listing.json(), { users: [user], total: 1, page: 1 });
  assert.equal(listing.headers.get("cache-control"), "no-store");
  const created = await managerCall("POST", [], {
    headers: { "X-Role": "manager", Authorization: "Bearer forged" },
    body: { email: user.login, password: "synthetic-password", role: "employee" },
  });
  assert.equal(created.status, 201);
  assert(!sent.at(-1).headers.has("X-Role") && !sent.at(-1).headers.has("Authorization"));
  const changed = await managerCall("PATCH", [user.user_id], { body: { role: "employee" } });
  assert.equal(changed.status, 200);
  const reset = await managerCall("PUT", [user.user_id, "password"], {
    body: { password: "replacement-password" },
  });
  assert.equal(reset.status, 204);
  assert.equal(await reset.text(), "");
  const setupStatus = await auth.GET(request("GET", ["setup"]), {
    params: Promise.resolve({ action: "setup" }),
  });
  assert.deepEqual(await setupStatus.json(), { setup_required: true });
  const setup = await auth.POST(
    request("POST", ["setup"], {
      body: {
        email: "admin@example.com",
        password: "synthetic-password",
        first_name: "مدیر",
        last_name: "آزمایش",
        organization_name: "شرکت نمونه",
      },
    }),
    { params: Promise.resolve({ action: "setup" }) },
  );
  assert.equal(setup.status, 201);
  assert(setup.headers.get("set-cookie").includes("HttpOnly"));
  const forged = await auth.POST(
    request("POST", ["setup"], {
      body: { email: "a@example.com", password: "synthetic-password", role: "employee" },
    }),
    { params: Promise.resolve({ action: "setup" }) },
  );
  assert.equal(forged.status, 422);
  for (const bad of [
    { ...user, role: "admin" },
    { ...user, is_active: "true" },
    { ...user, created_at: "bad" },
  ])
    assert.throws(() => contract.parseUser(bad));
  assert.throws(() => contract.parseUsers({ users: [user, user], total: 2, page: 1 }));
  const { UserForm } = load("../src/components/user-form.tsx", {
    "next/navigation": { useRouter: () => ({}) },
  });
  const setupMarkup = renderToStaticMarkup(React.createElement(UserForm, { setup: true }));
  const createMarkup = renderToStaticMarkup(React.createElement(UserForm));
  const editMarkup = renderToStaticMarkup(React.createElement(UserForm, { user }));
  assert(createMarkup.includes('name="first_name"') && createMarkup.includes('name="last_name"'));
  assert(
    !/<input[^>]*name="password"[^>]*required/.test(editMarkup),
    "edit password stays optional",
  );
  assert(editMarkup.includes('value="علی"') && editMarkup.includes('value="احمدی"'));
  const { UserRow } = load("../src/components/user-row.tsx");
  const rowMarkup = renderToStaticMarkup(React.createElement(UserRow, { user, onEdit: () => {} }));
  assert(
    rowMarkup.includes("ویرایش") &&
      rowMarkup.includes("علی احمدی") &&
      !rowMarkup.includes("<input"),
  );
  const { UserDialog } = load("../src/components/user-dialog.tsx", { "./user-form": { UserForm } });
  const { ManagerUsers } = load("../src/components/manager-users.tsx", {
    "next/navigation": { useRouter: () => ({}) },
    "./user-row": { UserRow },
    "./user-dialog": { UserDialog },
    "@/lib/user-contract": contract,
  });
  const managerMarkup = renderToStaticMarkup(React.createElement(ManagerUsers));
  assert(
    managerMarkup.includes("کاربر جدید") && !managerMarkup.includes("<form"),
    "creation form hidden until button opens dialog",
  );
  assert(!setupMarkup.includes('name="role"'));
  assert(setupMarkup.includes('name="organization_name"'));
  assert(createMarkup.includes('name="role"'));
  assert(setupMarkup.includes('name="confirm"') && setupMarkup.includes('minLength="12"'));
  console.log(
    "PASS user proxy allowlists, permissions, streamed cap, DTO validation, setup cookie and account form rendering",
  );
} finally {
  globalThis.fetch = realFetch;
}
