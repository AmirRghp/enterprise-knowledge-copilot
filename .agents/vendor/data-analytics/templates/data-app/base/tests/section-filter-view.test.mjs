import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let server, useSectionFilters, DataAppContext;
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  ({ useSectionFilters } = await server.ssrLoadModule("/src/use-section-filters.js"));
  ({ DataAppContext } = await server.ssrLoadModule("/src/DataAppContext.jsx"));
});
after(async () => { await server?.close(); });

const queries = {
  scoped: { rows: [{ segment: "A", week: "2026-07-06", value: 7 },
    { segment: "B", week: "2026-07-13", value: 5 }] },
  other: { rows: [{ segment: "unrelated", week: "2026-07-20", value: 100 }] },
};
const definitions = [{ id: "segment", field: "segment", defaultValue: "all", queryIds: ["scoped"] }];

function fixture(sectionViews = {}) {
  const changes = [];
  const shell = { snapshot: { filters: definitions, queries }, queries, filters: { segment: "all" },
    activeTabId: "overview", sectionViews,
    setSectionView(key, values) {
      changes.push({ key, values });
      shell.sectionViews = { ...shell.sectionViews, [key]: values };
    } };
  function render(scope = { id: "accounts" }, fields = definitions, initial = {}) {
    let result;
    function Capture() { result = useSectionFilters(fields, initial, scope); return null; }
    renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: shell }, React.createElement(Capture)));
    return result;
  }
  return { shell, changes, render };
}

test("named section views hydrate before rendering and remain separate from page, sibling and tab scopes", () => {
  const { shell, changes, render } = fixture({ "overview:accounts": { segment: "A" },
    "overview:engagement": { segment: "B" }, "details:accounts": { segment: "B" } });
  assert.deepEqual(render().reviewedRows("scoped"), [queries.scoped.rows[0]]);
  assert.deepEqual(render({ id: "engagement" }).reviewedRows("scoped"), [queries.scoped.rows[1]]);
  shell.activeTabId = "details";
  assert.equal(render().values.segment, "B");
  shell.activeTabId = "overview";
  render().setFilter("segment", "B");
  assert.equal(render().values.segment, "B", "A remounted section reads the shell's current selection");
  assert.deepEqual(shell.filters, { segment: "all" });
  assert.deepEqual(changes, [{ key: "overview:accounts", values: { segment: "B" } }]);
  shell.filters.segment = "A";
  assert.deepEqual(render().reviewedRows("scoped"), [], "A restored section cannot broaden or replace page scope");
});

test("section view updates preserve explicit All, empty arrays and other effective defaults", () => {
  const fields = [{ ...definitions[0], multiple: true, defaultValue: ["A"] },
    { id: "period", field: "week", mode: "through", defaultValue: "2026-07-06", queryIds: ["scoped"] }];
  const { shell, changes, render } = fixture();
  const scope = { rowId: "sales-row", componentIds: ["sales"], label: "Sales filters" };
  render(scope, fields).setFilter("segment", []);
  assert.deepEqual(changes[0], { key: "overview:sales-row", values: { segment: [], period: "2026-07-06" } });
  render(scope, fields).setFilter("period", "all");
  const restored = render(scope, fields);
  assert.deepEqual(restored.values, { segment: [], period: "all" });
  assert.deepEqual(restored.reviewedRows("scoped", ["segment", "week"]), queries.scoped.rows);
  assert.deepEqual(restored.filterProps.sectionScope, scope);
  assert.deepEqual(restored.componentProps("scoped").sectionFilters, restored.filterProps);
  shell.sectionViews = {};
  assert.deepEqual(render(scope, fields).values, { segment: ["A"], period: "2026-07-06" },
    "A blank complete view resets section state to declared defaults, including after a history change");
});

test("received section values validate against declared queries and retain only supported fields", () => {
  const { shell, changes, render } = fixture({ "overview:accounts": { segment: "unrelated", unknown: "secret" } });
  assert.deepEqual(render(undefined, definitions, { segment: "A" }).values, { segment: "A" });
  for (const value of [null, 10, ["A"], { segment: "A" }, "A".repeat(2001)]) {
    shell.sectionViews = { "overview:accounts": { segment: value } };
    assert.deepEqual(render().values, { segment: "all" });
  }
  render().setFilter("unknown", "secret");
  assert.deepEqual(changes, []);
  shell.sectionViews = { "overview:accounts": { segment: "A" } };
  assert.equal(render().values.segment, "A");
});

test("explicit section identity controls sharing without forcing movable-row filter placement", () => {
  const { changes, render } = fixture({ "overview:fixed": { segment: "B" }, "overview:row": { segment: "A" } });
  const fixed = render({ id: "fixed" });
  assert.equal(fixed.values.segment, "B");
  assert.equal(fixed.filterProps.sectionScope, undefined);
  assert.equal(fixed.componentProps("scoped").sectionFilters, undefined);
  assert.equal(render({ id: "fixed", rowId: "row", componentIds: ["sales"] }).values.segment, "B",
    "Explicit semantic identity takes precedence over layout placement");
  const anonymous = render(null, definitions, { segment: "A" });
  assert.equal(anonymous.values.segment, "A");
  anonymous.setFilter("segment", "B");
  assert.deepEqual(changes, [], "An unnamed local section must not invent a URL identity");
});

test("section temporal ranges restore full selected coverage and explicit all-date resets", () => {
  const fields = [{ id: "period", field: "week", mode: "through", defaultValue: "2026-07-06", queryIds: ["scoped"] }];
  const { shell, render } = fixture({ "overview:accounts": { period: "2026-07-06..2026-07-13" } });
  assert.deepEqual(render(undefined, fields).reviewedRows("scoped", ["week"]), queries.scoped.rows);
  shell.sectionViews["overview:accounts"].period = "2026-07-06..2026-07-20";
  assert.equal(render(undefined, fields).values.period, "2026-07-06", "An unrelated query cannot enlarge the valid range");
  shell.sectionViews["overview:accounts"].period = "all";
  assert.deepEqual(render(undefined, fields).reviewedRows("scoped", ["week"]), queries.scoped.rows);
});
