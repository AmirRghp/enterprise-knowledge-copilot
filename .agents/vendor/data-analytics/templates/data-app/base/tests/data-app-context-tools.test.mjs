import assert from "node:assert/strict";
import test from "node:test";

import { createDataAppContextTools, registerDataAppContextTools } from "../src/data-app-context-tools.js";

function fixture({ rowCount = 1_203, surface = "dashboard" } = {}) {
  const state = {
    snapshot: { id: `${surface}:reviewed`, surface, title: "Authored title", generatedAt: "2026-09-06T12:00:00Z",
      filters: [{ id: "region", field: "region", defaultValue: "all", shareInUrl: false }],
      report: { period: "2026-09", comparisonPeriod: "2026-08", methodology: ["Reviewed sources only"] },
      tabs: [{ id: "overview", filterIds: ["region"] }],
      sourcePlan: { sources: ["approved-source"], refreshInstructions: "Preserve all reviewed rows" },
      extension: { caveats: ["Custom authored metadata must survive"] },
      queries: {
        sales: { label: "Sales", declaredColumns: [{ name: "region", type: "string" }],
          source: { label: "Reviewed source", sql: "SELECT region, revenue FROM reviewed_sales", tables: ["reviewed_sales"],
            metricDefinitions: [{ label: "Revenue", formula: "SUM(revenue)", caveat: "Synthetic" }],
            executedAt: "2026-09-06T11:00:00Z", sourceFiles: [{ id: "file:1", label: "Reviewed file" }] },
          methods: [{ id: "review", label: "Verified" }],
          rows: Array.from({ length: rowCount }, (_, index) => ({ id: index, region: index % 2 ? "East" : "West",
            revenue: index * 10, privateRowMarker: `ROW_ONLY_SENTINEL_${index}`, ...(index === rowCount - 1 ? { lastRowOnlyColumn: true } : {}) })) },
        notes: { source: { query: { description: "Source-only narrative", sql: "SELECT notes FROM reviewed_notes" } },
          methodology: ["Narrative source metadata without quantitative rows"] },
      },
    },
    presentation: { title: "Reviewed current title", theme: "original", appearance: "dark",
      hiddenBlocks: ["hidden-card"], componentTitles: { sales: "Edited sales" },
      chartOverrides: { sales: { type: "line", x: "date", y: "revenue" } },
      textEdits: { intro: "Edited narrative" }, blockLayouts: { dashboard: ["sales", "notes"] },
      tabs: [{ id: "overview", label: "Executive view" }], refreshSchedule: { mode: "manual" } },
    view: { surface, tab: "overview", filters: { region: "West" }, assumptions: { activationLift: 3 },
      sections: { regional: { region: "East" } }, charts: { sales: { visibleSeries: ["Revenue"] } },
      focus: { accountId: "selected-account" }, tabViews: { overview: { filters: { region: "West" } } } },
    dataAppReference: { dataAppId: `${surface}:reviewed`, sourceUrl: "https://dashboard.example/?view=1&f.region=West",
      projectDirectory: "/local/app" },
    viewUrl: "https://dashboard.example/?view=1&f.region=West",
    canEdit: false,
    requestHeaders: { authorization: "DO_NOT_READ_HOST_AUTH" },
    session: { cookie: "DO_NOT_READ_BROWSER_SESSION" },
  };
  const registry = createDataAppContextTools({ getContext: () => state });
  return { state, ...registry, call: (name, input) => registry.tools.find(tool => tool.name === name).execute(input) };
}

test("deferred context keeps exact totals and loads only the requested query for pagination", async () => {
  const f = fixture({ rowCount: 7 });
  const original = f.state.snapshot.queries.sales.rows;
  const columns = Object.keys(original.at(-1));
  delete f.state.snapshot.queries.sales.rows;
  f.state.snapshot._dataAppQueryLoading = { version: 1, snapshotSha256: "a".repeat(64),
    queries: { sales: { rowCount: 7, columns } } };
  const requested = [];
  f.state.queryDataStore = {
    getQueries: () => f.state.snapshot.queries,
    async ensure(ids) {
      requested.push(ids);
      f.state.snapshot.queries.sales = { ...f.state.snapshot.queries.sales, rows: original };
    },
  };
  const before = await f.call("get_data_app_context", {});
  assert.equal(before.queries.sales.rowCount, 7);
  assert.deepEqual(before.queries.sales.columns, columns);
  assert.equal(before.queries.sales.loaded, false);
  assert.deepEqual(requested, []);
  const page = await f.call("get_data_app_query_rows", { queryId: "sales", limit: 3, contextVersion: before.contextVersion });
  assert.deepEqual(requested, [["sales"]]);
  assert.equal(page.contextVersion, before.contextVersion, "loading unchanged immutable rows is not a data revision");
  assert.deepEqual(page.rows, original.slice(0, 3));
  assert.equal(page.totalRows, 7);
  assert.equal(page.nextOffset, 3);
  assert.equal((await f.call("get_data_app_context", {})).queries.sales.loaded, true);
});

test("deferred row reads reject a view change while loading and propagate failures", async () => {
  for (const failure of [false, true]) {
    const f = fixture({ rowCount: 1 });
    const rows = f.state.snapshot.queries.sales.rows;
    delete f.state.snapshot.queries.sales.rows;
    f.state.snapshot._dataAppQueryLoading = { version: 1, snapshotSha256: "a".repeat(64),
      queries: { sales: { rowCount: 1, columns: Object.keys(rows[0]) } } };
    f.state.queryDataStore = { getQueries: () => f.state.snapshot.queries, async ensure() {
      if (failure) throw new Error("Published query is unavailable");
      f.state.snapshot.queries.sales.rows = rows;
      f.state.view.tab = "changed";
    } };
    const { contextVersion } = await f.call("get_data_app_context", {});
    await assert.rejects(f.call("get_data_app_query_rows", { queryId: "sales", contextVersion }),
      failure ? /Published query is unavailable/ : /context changed/);
  }
});

test("context includes exact live presentation and all snapshot metadata without reviewed row values", async () => {
  const f = fixture();
  const result = await f.call("get_data_app_context", {});
  const expectedSnapshot = JSON.parse(JSON.stringify(f.state.snapshot));
  for (const query of Object.values(expectedSnapshot.queries)) delete query.rows;
  assert.deepEqual(result.snapshot, expectedSnapshot);
  assert.deepEqual(result.presentation, f.state.presentation);
  assert.deepEqual(result.view, f.state.view);
  assert.deepEqual(result.dataAppReference, f.state.dataAppReference);
  assert.deepEqual(result.artifact, { id: "dashboard:reviewed", surface: "dashboard", title: "Reviewed current title" });
  assert.equal(result.viewUrl, f.state.viewUrl);
  assert.equal(result.generatedAt, f.state.snapshot.generatedAt);
  assert.equal(result.canEdit, false, "readers may retrieve the same already-loaded reviewed context");
  assert.equal(result.live, true);
  assert.equal(result.immutable, false);
  assert.equal(result.rows.included, false);
  assert.equal(result.queries.sales.rowCount, 1_203);
  assert.deepEqual(result.queries.sales.columns, ["id", "region", "revenue", "privateRowMarker", "lastRowOnlyColumn"]);
  assert.equal(result.queries.sales.sql, f.state.snapshot.queries.sales.source.sql);
  assert.deepEqual(result.queries.notes, { rowCount: 0, columns: [], label: "Source-only narrative", sql: "SELECT notes FROM reviewed_notes" });
  assert.doesNotMatch(JSON.stringify(result), /ROW_ONLY_SENTINEL|DO_NOT_READ_HOST_AUTH|DO_NOT_READ_BROWSER_SESSION/u);
  result.snapshot.queries.sales.source.tables.push("changed-by-consumer");
  result.presentation.hiddenBlocks.push("changed-by-consumer");
  result.view.filters.region = "East";
  assert.deepEqual(f.state.snapshot.queries.sales.source.tables, ["reviewed_sales"]);
  assert.deepEqual(f.state.presentation.hiddenBlocks, ["hidden-card"]);
  assert.equal(f.state.view.filters.region, "West");
});

test("row pagination returns every reviewed row once, exact page totals, and detached values", async () => {
  const f = fixture();
  const { contextVersion, generatedAt } = await f.call("get_data_app_context", {});
  const rows = [];
  let offset = 0;
  do {
    const page = await f.call("get_data_app_query_rows", { queryId: "sales", offset, limit: 500, contextVersion });
    assert.equal(page.totalRows, 1_203);
    assert.equal(page.contextVersion, contextVersion);
    assert.equal(page.generatedAt, generatedAt);
    assert.equal(page.returnedRows, page.rows.length);
    assert.equal(page.returnedRows, offset < 1_000 ? 500 : 203);
    assert.equal(page.offset, offset);
    assert.equal(page.hasMore, page.nextOffset !== null);
    assert.equal(page.live, true);
    assert.equal(page.immutable, false);
    rows.push(...page.rows);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(rows, f.state.snapshot.queries.sales.rows);
  rows[0].revenue = -1;
  assert.equal(f.state.snapshot.queries.sales.rows[0].revenue, 0);
  for (const offset of [1_203, 5_000]) {
    const page = await f.call("get_data_app_query_rows", { queryId: "sales", offset });
    assert.deepEqual(page.rows, []);
    assert.equal(page.totalRows, 1_203);
    assert.equal(page.nextOffset, null);
    assert.equal(page.hasMore, false);
  }
  const defaults = await f.call("get_data_app_query_rows", { queryId: "sales" });
  assert.equal(defaults.limit, 100);
  assert.equal(defaults.returnedRows, 100);
  assert.equal(defaults.nextOffset, 100);
  const narrative = await f.call("get_data_app_query_rows", { queryId: "notes" });
  assert.deepEqual(narrative.rows, []);
  assert.equal(narrative.totalRows, 0);
  assert.equal(narrative.nextOffset, null);
});

test("schemas are enforced even when the host does not validate tool arguments", async () => {
  const f = fixture();
  assert.ok(f.tools.every(tool => tool.annotations.readOnlyHint && tool.annotations.untrustedContentHint));
  await assert.rejects(f.call("get_data_app_context", { includeRows: true }), /Invalid/u);
  for (const input of [null, [], "sales", {}, { queryId: "" }, { queryId: 1 }, { queryId: "x".repeat(1_001) },
    { queryId: "sales", includeRows: true }, Object.create({ queryId: "sales" }),
    ...[-1, 0, 501, 1.5, NaN, Infinity, "10", null].map(limit => ({ queryId: "sales", limit })),
    ...[-1, 1.5, NaN, Infinity, "10", null, Number.MAX_SAFE_INTEGER + 1].map(offset => ({ queryId: "sales", offset })),
    ...[null, false, "", "x".repeat(201)].map(contextVersion => ({ queryId: "sales", contextVersion }))]) {
    await assert.rejects(f.call("get_data_app_query_rows", input));
  }
  await assert.rejects(f.call("get_data_app_query_rows", { queryId: "unknown" }), /does not exist/u);
  await assert.rejects(f.call("get_data_app_query_rows", { queryId: "constructor" }), /does not exist/u);
});

test("exact query identities are safe even with prototype-like names or punctuation", async () => {
  const f = fixture();
  f.state.snapshot.queries = Object.fromEntries(["__proto__", "constructor", 'query["one"]', "same-title"].map((id, index) =>
    [id, { title: "Same title", rows: [{ index }], source: { sql: `SELECT ${index}` } }]));
  const context = await f.call("get_data_app_context", {});
  assert.deepEqual(Object.keys(context.snapshot.queries), ["__proto__", "constructor", 'query["one"]', "same-title"]);
  for (const [index, queryId] of Object.keys(context.snapshot.queries).entries()) {
    const page = await f.call("get_data_app_query_rows", { queryId });
    assert.deepEqual(page.rows, [{ index }]);
  }
  assert.equal(Object.getPrototypeOf(context.snapshot.queries), Object.prototype);
  assert.equal({}.polluted, undefined);
});

test("live context changes invalidate an existing pagination version instead of mixing revisions", async () => {
  const f = fixture();
  const changes = [
    () => { f.state.view.filters.region = "East"; },
    () => { f.state.view.tab = "details"; },
    () => { f.state.presentation.chartOverrides.sales.type = "bar"; },
    () => { f.state.presentation.textEdits.intro = "New reviewed narrative"; },
    () => { f.state.snapshot.generatedAt = "2026-09-06T13:00:00Z"; },
    () => { f.state.snapshot.queries.sales.source.sql = "SELECT region, revenue FROM updated_source"; },
    () => { f.state.snapshot.queries.sales.rows = f.state.snapshot.queries.sales.rows.map(row => ({ ...row, revenue: row.revenue + 1 })); },
    () => { f.state.snapshot.queries.sales.rows = [...f.state.snapshot.queries.sales.rows, { id: 9_999, revenue: 1 }]; },
    () => { f.state.canEdit = true; },
    () => { f.state.viewUrl += "&tab=details"; },
  ];
  for (const change of changes) {
    const before = await f.call("get_data_app_context", {});
    const unchanged = await f.call("get_data_app_context", {});
    assert.equal(unchanged.contextVersion, before.contextVersion);
    change();
    await assert.rejects(f.call("get_data_app_query_rows", { queryId: "sales", offset: 100, contextVersion: before.contextVersion }),
      /context changed/u);
    const after = await f.call("get_data_app_context", {});
    assert.notEqual(after.contextVersion, before.contextVersion);
    const page = await f.call("get_data_app_query_rows", { queryId: "sales", contextVersion: after.contextVersion });
    assert.equal(page.contextVersion, after.contextVersion);
  }
});

test("large dashboards and reports retain complete metadata and presentation without a URL-sized truncation cap", async () => {
  for (const surface of ["dashboard", "report"]) {
    for (const queryCount of [1, 5, 20, 80, 200]) {
      const f = fixture({ rowCount: 3, surface });
      f.state.snapshot.queries = Object.fromEntries(Array.from({ length: queryCount }, (_, index) =>
        [`query-${index}`, { ...f.state.snapshot.queries.sales, title: `Query ${index}` }]));
      f.state.presentation.textEdits = Object.fromEntries(Array.from({ length: 600 }, (_, index) =>
        [`paragraph-${index}`, `Reviewed narrative ${index}: ${"Full paragraph text. ".repeat(20)}`]));
      f.state.presentation.chartOverrides = Object.fromEntries(Array.from({ length: queryCount * 3 }, (_, index) =>
        [`chart-${index}`, { type: index % 2 ? "line" : "bar", x: "region", y: "revenue", title: `Chart ${index}` }]));
      const context = await f.call("get_data_app_context", {});
      assert.equal(Object.keys(context.queries).length, queryCount);
      assert.deepEqual(context.presentation, f.state.presentation);
      assert.deepEqual(context.snapshot.extension, f.state.snapshot.extension);
      assert.equal(context.artifact.surface, surface);
      assert.ok(JSON.stringify(context.presentation).length > 65_536);
      const last = await f.call("get_data_app_query_rows", { queryId: `query-${queryCount - 1}`, contextVersion: context.contextVersion });
      assert.deepEqual(last.rows, f.state.snapshot.queries[`query-${queryCount - 1}`].rows);
    }
  }
});

test("missing or invalid reviewed state fails explicitly and disposal prevents further reads", async () => {
  let state = null;
  const registry = createDataAppContextTools({ getContext: () => state });
  const context = registry.tools[0], rows = registry.tools[1];
  await assert.rejects(context.execute({}), /not available/u);
  state = { snapshot: { queries: { bad: { rows: null } } } };
  await assert.rejects(context.execute({}), /unavailable/u);
  state = { snapshot: { queries: { bad: null } } };
  await assert.rejects(context.execute({}), /unavailable/u);
  state = { snapshot: { queries: {} } };
  await context.execute({});
  registry.dispose();
  await assert.rejects(context.execute({}), /no longer open/u);
  await assert.rejects(rows.execute({ queryId: "bad" }), /no longer open/u);
});

test("registration exposes read-only context tools, reads updated refs, and aborts/unregisters on cleanup", async () => {
  const f = fixture({ rowCount: 1 });
  let current = f.state;
  const registered = [], removed = [], failures = [];
  const cleanup = registerDataAppContextTools({
    registerTool: (tool, options) => { registered.push({ tool, options }); },
    unregisterTool: name => removed.push(name),
  }, () => current, (...args) => failures.push(args));
  assert.deepEqual(registered.map(({ tool }) => tool.name), ["get_data_app_context", "get_data_app_query_rows", "get_data_app_text"]);
  assert.ok(registered.every(({ tool, options }) => tool.annotations.readOnlyHint && !options.signal.aborted));
  const before = await registered[0].tool.execute({});
  current = { ...current, presentation: { ...current.presentation, title: "Updated ref title" } };
  const after = await registered[0].tool.execute({});
  assert.equal(after.artifact.title, "Updated ref title");
  assert.notEqual(before.contextVersion, after.contextVersion);
  cleanup();
  assert.ok(registered.every(({ options }) => options.signal.aborted));
  assert.deepEqual(removed, ["get_data_app_context", "get_data_app_query_rows", "get_data_app_text"]);
  assert.deepEqual(failures, []);
  await assert.rejects(registered[0].tool.execute({}), /no longer open/u);
});

test("unsupported hosts and registration failures do not break dashboard rendering", async () => {
  registerDataAppContextTools(null, () => { throw new Error("Must not read unsupported host"); })();
  const failures = [], attempted = [];
  const cleanup = registerDataAppContextTools({ registerTool: tool => {
    attempted.push(tool.name);
    if (tool.name === "get_data_app_context") throw new Error("sync failure");
    return Promise.reject(new Error("async failure"));
  } }, () => fixture().state, (...args) => failures.push(args));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempted.length, 3);
  assert.equal(failures.length, 3);
  cleanup();
  let reject;
  const lateFailures = [];
  const dispose = registerDataAppContextTools({ registerTool: () => new Promise((_, failure) => { reject = failure; }) },
    () => fixture().state, (...args) => lateFailures.push(args));
  dispose();
  reject(new Error("too late"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(lateFailures, []);
});


test("rendered text retrieval preserves complete authored prose and reads only the requested current target", async () => {
  const f = fixture({ surface: "report" });
  const longText = "Full reviewed narrative paragraph. ".repeat(4_000);
  const calls = [];
  f.state.getText = id => {
    calls.push(id);
    return id === "report-executive-summary" ? longText : id === "empty" ? "" : null;
  };
  const context = await f.call("get_data_app_context", {});
  assert.deepEqual(calls, [], "Default context does not copy page text or invoke the text reader");
  assert.equal(Object.hasOwn(context, "getText"), false);
  assert.equal(Object.hasOwn(context, "renderedText"), false);
  const text = await f.call("get_data_app_text", { id: "report-executive-summary", contextVersion: context.contextVersion });
  assert.equal(text.text, longText);
  assert.equal(text.contextVersion, context.contextVersion);
  assert.equal(text.generatedAt, context.generatedAt);
  assert.equal(text.artifact.surface, "report");
  assert.equal(text.live, true);
  assert.equal(text.immutable, false);
  assert.deepEqual(calls, ["report-executive-summary"]);
  assert.equal((await f.call("get_data_app_text", { id: "empty" })).text, "");
  await assert.rejects(f.call("get_data_app_text", { id: "unmounted" }), /not visible/u);
  f.state.getText = id => id === "report-executive-summary" ? "Updated callback result" : null;
  const updated = await f.call("get_data_app_context", {});
  assert.equal(updated.contextVersion, context.contextVersion, "Callback identity is not serialized view state");
  assert.equal((await f.call("get_data_app_text", { id: "report-executive-summary" })).text, "Updated callback result");
});

test("text retrieval refuses invalid, ambiguous, unavailable, stale, and disposed reads", async () => {
  const f = fixture();
  for (const input of [null, [], {}, { id: "" }, { id: 1 }, { id: "x".repeat(1_001) },
    { id: "summary", includeHidden: true }, { id: "summary", contextVersion: null }]) {
    await assert.rejects(f.call("get_data_app_text", input));
  }
  await assert.rejects(f.call("get_data_app_text", { id: "summary" }), /unavailable/u);
  f.state.getText = () => { throw new Error("Duplicate narrative ID is ambiguous."); };
  await assert.rejects(f.call("get_data_app_text", { id: "summary" }), /Duplicate/u);
  f.state.getText = () => ({ text: "ambiguous" });
  await assert.rejects(f.call("get_data_app_text", { id: "summary" }), /unambiguously/u);
  const before = await f.call("get_data_app_context", {});
  f.state.view.filters.region = "East";
  f.state.getText = () => { throw new Error("Must not read stale text"); };
  await assert.rejects(f.call("get_data_app_text", { id: "summary", contextVersion: before.contextVersion }), /context changed/u);
  f.dispose();
  await assert.rejects(f.call("get_data_app_text", { id: "summary" }), /no longer open/u);
});
