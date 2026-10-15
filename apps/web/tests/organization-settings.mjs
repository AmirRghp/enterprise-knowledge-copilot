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
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)(
    (name) => (name in imports ? imports[name] : realRequire(name)),
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

const contract = load("../src/lib/organization-contract.ts");
assert.deepEqual(contract.parseOrganization({ name: "سازمان نمونه" }), { name: "سازمان نمونه" });
assert.throws(() => contract.parseOrganization({ name: "  " }));
assert.throws(() => contract.parseOrganization({ name: "x".repeat(101) }));

let identity = { role: "manager" };
let status = 200;
const sent = [];
globalThis.fetch = async (url, options) => {
  sent.push({ url, options });
  return status === 200 ? Response.json({ name: "سازمان نمونه" }) : new Response(null, { status });
};
const route = load("../src/app/api/manager/settings/organization/route.ts", {
  "@/lib/auth-server": { currentIdentity: async () => identity },
  "@/lib/server-config": {
    serverConfig: () => ({ webOrigin: "http://localhost:3000", apiOrigin: "http://api.test" }),
  },
  "@/lib/organization-contract": contract,
  "../../../read-proxy": {
    PROXY_HEADERS: { "Cache-Control": "no-store" },
    proxyFailure: (code) => new Response(null, { status: code }),
  },
});
const request = (method, origin = "http://localhost:3000", body = { name: "سازمان نمونه" }) => ({
  method,
  nextUrl: { search: "" },
  headers: new Headers({ Origin: origin, "Content-Type": "application/json" }),
  cookies: { get: () => ({ value: "session" }) },
  body: new Response(JSON.stringify(body)).body,
});
assert.equal((await route.GET(request("GET"))).status, 200);
assert.equal((await route.PUT(request("PUT"))).status, 200);
assert.equal(sent.at(-1).url, "http://api.test/api/manager/settings/organization");
assert.equal(sent.at(-1).options.headers.get("Cookie"), "ekc_session=session");
assert.equal((await route.PUT(request("PUT", "http://foreign.test"))).status, 403);
identity = { role: "employee" };
assert.equal((await route.GET(request("GET"))).status, 403);
identity = null;
assert.equal((await route.GET(request("GET"))).status, 401);
identity = { role: "manager" };
status = 422;
assert.equal((await route.PUT(request("PUT"))).status, 422);

const { ManagerOrganization } = load("../src/components/manager-organization.tsx", {
  "next/navigation": { useRouter: () => ({}) },
  "@/lib/organization-contract": contract,
});
const markup = renderToStaticMarkup(React.createElement(ManagerOrganization));
assert(markup.includes("نام شرکت یا سازمان"));
assert(
  readFileSync(
    new URL("../src/components/manager-organization.tsx", import.meta.url),
    "utf8",
  ).includes("maxLength={100}"),
);

const organizationName = "سازمان آزمون";
const shell = load("../src/components/workspace-shell.tsx", {
  "next/link": {
    default: ({ children, ...props }) => React.createElement("a", props, children),
  },
  "lucide-react": Object.fromEntries(
    [
      "BookOpen",
      "ChevronLeft",
      "FileText",
      "House",
      "MessagesSquare",
      "ScrollText",
      "Settings",
      "Users",
    ].map((name) => [name, () => React.createElement("i")]),
  ),
  "@/lib/auth-server": { organizationName: async () => organizationName },
  "./session-controls": { SessionControls: () => React.createElement("span") },
});
const shellMarkup = renderToStaticMarkup(
  await shell.WorkspaceShell({
    identity: { login: "admin@example.com", role: "manager", session_expires_at: "" },
    children: React.createElement("main"),
  }),
);
assert.equal(shellMarkup.split(organizationName).length - 1, 2);

const authPageDeps = {
  "next/navigation": { redirect: () => {} },
  "@/lib/auth-server": {
    organizationName: async () => organizationName,
    currentIdentity: async () => null,
    setupRequired: async () => false,
  },
  "@/components/login-form": { LoginForm: () => React.createElement("button") },
  "@/components/user-form": { UserForm: () => React.createElement("form") },
  "@/components/service-unavailable": { ServiceUnavailable: () => null },
};
const login = load("../src/app/login/page.tsx", authPageDeps);
const loginMarkup = renderToStaticMarkup(await login.default());
assert(loginMarkup.includes(organizationName));
const setup = load("../src/app/setup/page.tsx", {
  ...authPageDeps,
  "@/lib/auth-server": { ...authPageDeps["@/lib/auth-server"], setupRequired: async () => true },
});
const setupMarkup = renderToStaticMarkup(await setup.default());
assert(setupMarkup.includes(organizationName));
const overview = load("../src/app/page.tsx", {
  "next/navigation": { redirect: () => {} },
  "@/lib/auth-server": {
    organizationName: async () => organizationName,
    currentIdentity: async () => ({
      login: "admin@example.com",
      role: "manager",
      session_expires_at: "",
    }),
  },
  "@/components/workspace-shell": {
    WorkspaceShell: ({ children }) => React.createElement("div", null, children),
  },
  "@/components/service-unavailable": { ServiceUnavailable: () => null },
});
assert(renderToStaticMarkup(await overview.default()).includes(organizationName));

const layout = load("../src/app/layout.tsx", {
  "next/font/local": { default: () => () => ({ variable: "font" }) },
  "./globals.css": {},
  "@/lib/auth-server": { organizationName: async () => organizationName },
});
assert.equal((await layout.generateMetadata()).title, `فضای دانش | ${organizationName}`);
console.log(
  "PASS organization settings, manager proxy, setup/login/dashboard branding and metadata",
);
