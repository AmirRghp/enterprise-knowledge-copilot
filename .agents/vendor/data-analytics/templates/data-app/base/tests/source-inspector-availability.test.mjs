import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

test("source sections reflect available evidence without treating an empty result as missing", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, entries: [] }, appType: "custom" });
  try {
    const { SourceInspector } = await server.ssrLoadModule("/src/components/SourceInspector.jsx");
    const component = { id: "test-chart", queryId: "reviewed", title: "Reviewed chart", kind: "chart" };
    const render = query => renderToStaticMarkup(React.createElement(SourceInspector, { component, query, rows: query.rows ?? [], filters: [] }));
    const file = render({ source: { files: [{ label: "reviewed.csv" }], caveats: ["Coverage is partial."] } });
    assert.match(file, /reviewed.csv/u);
    assert.match(file, /Coverage is partial/u);
    assert.doesNotMatch(file, /SQL query|Data preview|Evidence flow|Query executed/u);
    const website = render({ source: { url: "https://example.com/reviewed", executedAt: "2026-08-24T00:00:00Z" } });
    assert.match(website, /https:\/\/example.com\/reviewed/u);
    assert.match(website, /Source captured/u);
    assert.doesNotMatch(website, /SQL query|Evidence flow/u);
    const empty = render({ rows: [], source: { sql: "SELECT value FROM reviewed WHERE false" } });
    assert.match(empty, /Data preview/u);
    assert.match(empty, /SQL query/u);
    assert.doesNotMatch(empty, /Evidence flow/u);
    const provided = render({ source: { evidenceFlow: ["Read the supplied file", "Checked the reviewed values"] } });
    assert.match(provided, /Evidence flow/u);
    assert.match(provided, /Read the supplied file/u);
    assert.doesNotMatch(provided, /SQL query|Data preview/u);
    const absent = render({ source: { sql: "  ", evidenceFlow: [null, {}, " "] } });
    assert.doesNotMatch(absent, /role="tab"/u);
    assert.match(absent, /Source details weren’t recorded/u);
  } finally { await server.close(); }
});

test("receipt SQL links retain each query's provider destination and omit unavailable destinations", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), configFile: false, server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, entries: [] }, appType: "custom" });
  try {
    const { SourceInspector } = await server.ssrLoadModule("/src/components/SourceInspector.jsx");
    const receiptQueries = [
      { id: "snowflake", label: "Warehouse result", source: { sql: "SELECT 'warehouse'", queryUrl: "https://app.snowflake.com/org/account/#/worksheets/ws-1" } },
      { id: "databricks", label: "Lakehouse result", source: { sql: "SELECT 'lakehouse'", query: { url: "https://adb-123.4.azuredatabricks.net/sql/editor/123?o=123" } } },
      { id: "unlinked", label: "Recorded SQL only", source: { sql: "SELECT 'offline'", provider: "Snowflake" } },
      { id: "unsafe", label: "Unsafe destination", source: { sql: "SELECT 'unsafe'", queryUrl: "javascript:alert(1)" } },
    ];
    const html = renderToStaticMarkup(React.createElement(SourceInspector, {
      component: { id: "multi-query", queryId: "snowflake", title: "Combined finding" },
      receiptQueries,
    }));
    const sections = [...html.matchAll(/<section[^>]*class="receipt-source-section"[^>]*aria-label="([^"]+)"[^>]*>([\s\S]*?)<\/section>/gu)]
      .filter(([, , body]) => body.includes('class="sql-viewer"'));
    assert.equal(sections.length, receiptQueries.length);
    const links = sections.map(([, label, body]) => {
      assert.doesNotMatch(body, /sql-copy-button/u, "Receipts retain their existing copy policy");
      return { label, anchors: [...body.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gu)].map(([anchor]) => anchor) };
    });
    assert.deepEqual(links.map(({ label }) => label), receiptQueries.map(({ label }) => label));
    for (const [index, provider] of [[0, "Snowflake"], [1, "Databricks"]]) {
      assert.equal(links[index].anchors.length, 1, "Each query receives only its own provider link");
      const anchor = links[index].anchors[0];
      const href = receiptQueries[index].source.queryUrl ?? receiptQueries[index].source.query.url;
      assert.ok(anchor.includes(`href="${href}"`), "Use the exact recorded query destination");
      assert.match(anchor, /target="_blank"/u);
      assert.match(anchor, /rel="noopener noreferrer"/u);
      assert.ok(anchor.includes(`Open in ${provider}`));
    }
    assert.deepEqual(links.slice(2).map(({ anchors }) => anchors), [[], []]);
    assert.doesNotMatch(html, /javascript:/u);
  } finally { await server.close(); }
});
