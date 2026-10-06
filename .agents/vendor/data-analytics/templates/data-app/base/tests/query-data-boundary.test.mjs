import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { createQueryDataStore } from "../src/query-data-store.js";

let server, QueryDataBoundary, DataAppContext;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, appType: "custom", logLevel: "silent" });
  ({ QueryDataBoundary } = await server.ssrLoadModule("/src/components/QueryDataBoundary.jsx"));
  ({ DataAppContext } = await server.ssrLoadModule("/src/DataAppContext.jsx"));
});
after(async () => { await server?.close(); });

test("the boundary does not execute row-dependent children until every declared query is available", async () => {
  let childRenders = 0;
  const store = createQueryDataStore({ queries: { empty: { rows: [] }, deferred: {}, unused: {} } }, {
    snapshotSha256: "a".repeat(64), request: async () => new Response('[{"value":5}]'),
  });
  function Child() { childRenders += 1; return React.createElement("p", null, store.getQueries().deferred.rows[0].value); }
  const render = () => renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: { queryDataStore: store } },
    React.createElement(QueryDataBoundary, { queryIds: ["empty", "deferred"] }, React.createElement(Child))));
  const pending = render();
  assert.equal(childRenders, 0);
  assert.match(pending, /role="status"/u);
  assert.match(pending, /aria-label="Loading reviewed data"/u);
  assert.match(pending, /aria-busy="true"/u);
  assert.match(pending, /dashboard-shell-loading-heading/u);
  assert.match(pending, /dashboard-shell-loading-metrics/u);
  assert.match(pending, /dashboard-shell-loading-charts/u);
  assert.equal((pending.match(/dashboard-shell-loading-card/gu) ?? []).length, 6,
    "The waiting tab shows four metric cards and two chart cards");
  assert.doesNotMatch(pending, /dashboard-shell-loading-topbar|<main\b/u,
    "The tab placeholder stays inside the real shell without adding a top bar or landmark");
  await store.ensure(["deferred"]);
  assert.equal(render(), "<p>5</p>");
  assert.equal(childRenders, 1);
  assert.equal(store.getQueries().unused.rows, undefined);
  store.dispose();
});

test("a narrow boundary can retain its component-sized loading placeholder", () => {
  const store = createQueryDataStore({ queries: { deferred: {} } });
  const pending = renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: { queryDataStore: store } },
    React.createElement(QueryDataBoundary, { queryIds: ["deferred"], loadingLayout: "component", loadingKind: "chart" },
      React.createElement("p", null, "unavailable"))));
  assert.match(pending, /role="status"/u);
  assert.match(pending, /component-loading-body/u);
  assert.doesNotMatch(pending, /dashboard-shell-loading-metrics|unavailable/u);
  store.dispose();
});

test("native error and retry affordances replace children after a failed load", async () => {
  let childRenders = 0;
  const store = createQueryDataStore({ queries: { deferred: {} } }, {
    snapshotSha256: "a".repeat(64), request: async () => new Response("missing", { status: 404 }),
  });
  function Child() { childRenders += 1; return React.createElement("p", null, "incorrect data"); }
  await assert.rejects(store.ensure(["deferred"]));
  const html = renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: { queryDataStore: store } },
    React.createElement(QueryDataBoundary, { queryIds: ["deferred"] }, React.createElement(Child))));
  assert.equal(childRenders, 0);
  assert.match(html, /role="alert"/u);
  assert.match(html, /<button[^>]*>Try again<\/button>/u);
  assert.doesNotMatch(html, /incorrect data/u);
  store.dispose();
});

test("ordinary eager content and empty dependency lists pass through without loading placeholders", () => {
  for (const queryDataStore of [undefined, createQueryDataStore({ queries: {} })]) {
    const html = renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: { queryDataStore } },
      React.createElement(QueryDataBoundary, { queryIds: [] }, React.createElement("p", null, "complete"))));
    assert.equal(html, "<p>complete</p>");
    queryDataStore?.dispose();
  }
});


test("a changed immutable snapshot asks for reload instead of retrying a stale revision", async () => {
  const store = createQueryDataStore({ queries: { deferred: {} } }, {
    snapshotSha256: "a".repeat(64), request: async () => new Response("changed", { status: 409 }),
  });
  await assert.rejects(store.ensure(["deferred"]), /Dashboard data changed/u);
  const html = renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: { queryDataStore: store } },
    React.createElement(QueryDataBoundary, { queryIds: ["deferred"] }, "must not render")));
  assert.match(html, /role="alert"/u);
  assert.match(html, /Reload the page to load the current data/u);
  assert.doesNotMatch(html, /Try again|must not render/u);
  store.dispose();
});
