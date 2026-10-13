import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

function compiled(path, jsx = false) {
  return ts
    .transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: jsx ? "react" : undefined,
      },
    })
    .outputText.split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("export {"))
    .map((line) => line.replace(/^export /, ""))
    .join("\n");
}
const contracts = new Function(
  compiled("../src/lib/provider-contract.ts") +
    ";return {parseProviders,purposes,kinds,kindLabels,supports};",
)();
const id = "12345678-1234-1234-1234-123456789abc";
const row = {
  id,
  name: "شرکت الف",
  kind: "openai_compatible",
  model: "model-a",
  base_url: "https://example.com/v1",
  expected_digest: "",
  priority: 0,
  has_api_key: true,
  test_status: null,
  tested_at: null,
  api_key: "never-return-this",
};
const listing = {
  chat: { version: 1, enabled: false, providers: [row] },
  rerank: { version: 0, enabled: false, providers: [] },
  embedding: { version: 0, enabled: false, providers: [] },
};
assert.equal(contracts.parseProviders(listing).chat.providers[0].api_key, undefined);
assert.throws(() =>
  contracts.parseProviders({
    ...listing,
    chat: { ...listing.chat, providers: [{ ...row, name: " " }] },
  }),
);
assert.throws(() =>
  contracts.parseProviders({ ...listing, embedding: { ...listing.embedding, providers: [row] } }),
);
const ProviderForm = new Function(
  "React",
  "useEffect",
  "useRef",
  "useState",
  "kinds",
  "kindLabels",
  "supports",
  compiled("../src/components/provider-form.tsx", true) + ";return ProviderForm;",
)(
  React,
  React.useEffect,
  React.useRef,
  React.useState,
  contracts.kinds,
  contracts.kindLabels,
  contracts.supports,
);
for (const purpose of ["chat", "rerank", "embedding"]) {
  const html = renderToStaticMarkup(
    React.createElement(ProviderForm, { purpose, provider: null, onClose() {}, async onSave() {} }),
  );
  assert(html.indexOf('id="provider-name"') < html.indexOf('id="provider-kind"'));
  assert(html.includes("name") && html.includes('maxLength="100"'));
  if (purpose === "embedding")
    assert(html.includes("nomic-embed-text-v2-moe:latest") && html.includes("provider-digest"));
}
const edit = renderToStaticMarkup(
  React.createElement(ProviderForm, {
    purpose: "chat",
    provider: row,
    onClose() {},
    async onSave() {},
  }),
);
assert(edit.includes("شرکت الف") && edit.includes("کلید ثبت شده است"));
assert(!edit.includes("never-return-this"));
let identity = { role: "manager" };
let upstream = listing;
let calls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  calls++;
  return Response.json(upstream);
};
const PROXY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
const route = new Function(
  "currentIdentity",
  "serverConfig",
  "parseProviders",
  "purposes",
  "PROXY_HEADERS",
  "proxyFailure",
  compiled("../src/app/api/manager/providers/[[...path]]/route.ts") + ";return handle;",
)(
  () => Promise.resolve(identity),
  () => ({ webOrigin: "http://localhost:3000", apiOrigin: "http://localhost:8000" }),
  contracts.parseProviders,
  contracts.purposes,
  PROXY_HEADERS,
  (status) =>
    Response.json({ detail: "request could not be completed" }, { status, headers: PROXY_HEADERS }),
);
function request(method = "GET", body, origin = "http://localhost:3000") {
  const r = new Request("http://localhost:3000/api/manager/providers", {
    method,
    headers: { ...(origin ? { Origin: origin } : {}), "Content-Type": "application/json" },
    body,
  });
  r.nextUrl = new URL(r.url);
  r.cookies = {
    get() {
      return { value: "synthetic-token" };
    },
  };
  return r;
}
async function call(path = [], method = "GET", body, origin) {
  return route(request(method, body, origin), { params: Promise.resolve({ path }) });
}
try {
  let result = await call();
  assert.equal(result.status, 200);
  assert(!JSON.stringify(await result.json()).includes("never-return-this"));
  const previous = calls;
  assert.equal((await call(["chat"], "POST", "{}", "https://foreign.example")).status, 403);
  assert.equal((await call(["chat"], "POST", "{}", null)).status, 403);
  identity = { role: "employee" };
  assert.equal((await call()).status, 403);
  assert.equal(calls, previous);
  identity = null;
  assert.equal((await call()).status, 401);
  identity = { role: "manager" };
  assert.equal((await call(["chat"], "POST", "x".repeat(65537))).status, 413);
  assert.equal((await call(["unknown"])).status, 404);
  assert.equal((await call(["chat", id], "GET")).status, 404);
  upstream = { ...listing, chat: { ...listing.chat, providers: [{ ...row, id: "wrong" }] } };
  assert.equal((await call()).status, 502);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("Provider panel: all contract, form and proxy checks passed");
