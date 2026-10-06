import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createDataAppWorker } from "../src/data-app-worker.js";
import { createQueryDataStore } from "../src/query-data-store.js";

// The runtime also supports Node 20; SQLite integration tests use Node 22.13+.
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch (error) {
  if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
}
const sqliteTest = (name, run) => test(name, { skip: !DatabaseSync && "Requires node:sqlite" }, run);

const owner = "publisher@example.com";
const executedAt = "2026-09-07T09:30:00.000Z";
const seed = {
  generatedAt: "2026-09-01T12:00:00.000Z",
  queries: {
    sql: { source: { label: "SQL", sql: "SELECT amount FROM totals", executedAt: "2026-09-01T11:00:00.000Z" }, rows: [{ amount: 10 }] },
    api: { source: { label: "API", evidenceFlow: [{ title: "Get totals", detail: "Fetch the current month" }] }, methods: [{ language: "calculation", code: "Sum amounts" }], rows: [{ amount: 20 }] },
    untouched: { source: { label: "Other" }, rows: [{ amount: 30 }] },
  },
};
const updates = [
  { queryId: "sql", rows: [{ amount: 11 }], executedAt },
  { queryId: "api", rows: [{ amount: 22 }], executedAt: "2026-09-07T09:35:00.000Z" },
];

// Exercise real SQL and transaction rollback through the D1 interface.
function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const db = {
    sqlite,
    prepare(sql) {
      const stmt = {
        values: [],
        bind(...values) { this.values = values; return this; },
        async first() { return sqlite.prepare(sql).get(...this.values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...this.values) }; },
        async run() {
          const prepared = sqlite.prepare(sql);
          if (sql.startsWith("SELECT")) return this.all();
          return { meta: { changes: prepared.run(...this.values).changes } };
        },
      };
      return stmt;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return db;
}
function client(db) {
  const worker = createDataAppWorker({ html: "<main>Dashboard</main>", seedSnapshot: seed });
  const environment = { DB: db, DATA_APP_OWNER_EMAIL_SHA256: createHash("sha256").update(owner).digest("hex") };
  return {
    snapshot: async () => (await worker.fetch(new Request("https://dashboard.chatgpt.site/api/snapshot"), environment)).json(),
    put: (body, path = "/api/queries", email = owner) => worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, {
      method: "PUT", headers: { "content-type": "application/json", "oai-authenticated-user-email": email }, body: JSON.stringify(body),
    }), environment),
  };
}

sqliteTest("a multi-source refresh commits rows and execution times together and survives reload", async (t) => {
  const db = database(t);
  const api = client(db);
  assert.equal((await api.put({ updates })).status, 200);
  const saved = await client(db).snapshot();
  for (const update of updates) {
    const original = seed.queries[update.queryId];
    assert.deepEqual(saved.queries[update.queryId], { ...original, rows: update.rows,
      source: { ...original.source, executedAt: update.executedAt } });
  }
  assert.deepEqual(saved.queries.untouched, seed.queries.untouched);
  assert.notEqual(saved.generatedAt, seed.generatedAt);
});

sqliteTest("a later database failure rolls back every dataset and freshness value", async (t) => {
  const db = database(t);
  const api = client(db);
  await api.snapshot();
  db.sqlite.exec("CREATE TRIGGER reject_api BEFORE INSERT ON data_app_query_rows WHEN NEW.query_id = 'api' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.equal((await api.put({ updates })).status, 503);
  assert.deepEqual(await client(db).snapshot(), seed);
});

sqliteTest("invalid batches and unauthorized callers cannot partially update a dashboard", async (t) => {
  const api = client(database(t));
  for (const body of [
    { updates: [] }, { updates: [updates[0], updates[0]] },
    { updates: [updates[0], { ...updates[1], queryId: "missing" }] },
    { updates: [updates[0], { ...updates[1], rows: [null] }] },
    { updates: [updates[0], { ...updates[1], executedAt: "yesterday" }] },
    { updates: [updates[0], { ...updates[1], executedAt: undefined }] },
    { updates, queryId: "sql", rows: [] }, { updates: null }, null,
    { updates: [updates[0], { ...updates[1], executedAt: "2026-09-07T09:00:00" }] },
    { updates: [{ ...updates[0], rows: Array(10_001).fill({ amount: 1 }) }] },
  ]) {
    assert.ok([400, 404].includes((await api.put(body)).status), "invalid refresh must be rejected");
    assert.deepEqual(await api.snapshot(), seed);
  }
  assert.equal((await api.put({ updates }, "/api/queries", "viewer@example.com")).status, 403);
  assert.deepEqual(await api.snapshot(), seed);
});

sqliteTest("single-query callers can supply execution time or preserve the existing one", async (t) => {
  const api = client(database(t));
  assert.equal((await api.put({ rows: [], executedAt }, "/api/queries/sql")).status, 200);
  assert.equal((await api.snapshot()).queries.sql.source.executedAt, executedAt);
  assert.equal((await api.put({ rows: [{ amount: 12 }] }, "/api/queries/sql")).status, 200);
  assert.equal((await api.snapshot()).queries.sql.source.executedAt, executedAt);
});

async function registeredTools(t, { initialSnapshot = seed, queryDataStore } = {}) {
  const tools = new Map();
  let snapshot = structuredClone(initialSnapshot);
  let stateUpdates = 0;
  const effects = [];
  const hooks = {
    useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn), useRef: (current) => ({ current }),
    useState: (value) => [typeof value === "function" ? value() : value, () => { stateUpdates++; }],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  const oldDocument = globalThis.document;
  const oldFetch = globalThis.fetch;
  globalThis.__queryRefreshHooks = hooks;
  globalThis.document = { modelContext: { registerTool: (tool) => tools.set(tool.name, tool), unregisterTool: (name) => tools.delete(name) } };
  t.after(() => { globalThis.document = oldDocument; globalThis.fetch = oldFetch; delete globalThis.__queryRefreshHooks; });
  const source = (await readFile(new URL("../src/use-data-app.js", import.meta.url), "utf8"))
    .replace('from "react"', '= globalThis.__queryRefreshHooks')
    .replace('import { useCallback, useEffect, useRef, useState, useSyncExternalStore }', 'const { useCallback, useEffect, useRef, useState, useSyncExternalStore }')
    .replace('"./source-provenance.js"', JSON.stringify(new URL("../src/source-provenance.js", import.meta.url).href));
  const { useDataApp } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${encodeURIComponent(t.name)}`);
  const render = () => {
    useDataApp(snapshot, { hosted: true, queryDataStore, onSnapshotChange: (change) => { snapshot = change(snapshot); } });
    for (const effect of effects.splice(0)) effect();
  };
  render();
  return { tools, render, snapshot: () => snapshot, stateUpdates: () => stateUpdates };
}

test("query tools mark source content untrusted and publish a refresh only after commit", async (t) => {
  const harness = await registeredTools(t);
  const list = harness.tools.get("list_data_app_queries");
  assert.deepEqual(list.annotations, { readOnlyHint: true, untrustedContentHint: true });
  const update = harness.tools.get("update_data_app_query");
  globalThis.fetch = async () => Response.json({ error: "write failed" }, { status: 500 });
  await assert.rejects(update.execute({ updates }), /write failed/);
  assert.deepEqual(harness.snapshot(), seed);
  assert.equal(harness.stateUpdates(), 0);
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/queries");
    assert.deepEqual(JSON.parse(options.body), { updates });
    return Response.json({ updates, generatedAt: executedAt });
  };
  await update.execute({ updates });
  assert.equal(harness.stateUpdates(), 1);
  const definitions = await list.execute();
  for (const update of updates) {
    assert.deepEqual(harness.snapshot().queries[update.queryId].rows, update.rows);
    const definition = definitions.find(({ queryId }) => queryId === update.queryId);
    assert.equal(definition.source.executedAt, update.executedAt);
    assert.equal(Object.hasOwn(definition, "rows"), false);
  }
});

test("deferred queries retain full definitions and committed batch execution times through the query store", async (t) => {
  const initialSnapshot = { ...seed,
    queries: Object.fromEntries(Object.entries(seed.queries).map(([id, { rows, ...definition }]) => [id, definition])),
    _dataAppQueryLoading: { queries: Object.fromEntries(Object.keys(seed.queries).map(id =>
      [id, { columns: ["amount"], rowCount: 1 }])) },
  };
  const reads = [];
  const store = createQueryDataStore(initialSnapshot, { snapshotSha256: "a".repeat(64), request: async url => {
    const id = new URL(url, "https://dashboard.chatgpt.site").searchParams.get("queryId");
    reads.push(id);
    return Response.json(seed.queries[id].rows);
  } });
  t.after(() => store.dispose());
  const harness = await registeredTools(t, { initialSnapshot, queryDataStore: store });
  const before = await harness.tools.get("list_data_app_queries").execute();
  assert.deepEqual(reads, []);
  for (const query of before) {
    assert.equal(query.loaded, false);
    assert.equal(query.rowCount, 1);
    assert.deepEqual(query.columns, ["amount"]);
    assert.deepEqual(query.source, seed.queries[query.queryId].source);
    assert.deepEqual(query.methods, seed.queries[query.queryId].methods);
    assert.equal(Object.hasOwn(query, "rows"), false);
  }
  globalThis.fetch = async () => Response.json({ error: "write failed" }, { status: 500 });
  await assert.rejects(harness.tools.get("update_data_app_query").execute({ updates }), /write failed/);
  assert.deepEqual([...reads].sort(), Object.keys(seed.queries).sort());
  assert.deepEqual(store.getQueries(), seed.queries);
  assert.equal(harness.snapshot().generatedAt, seed.generatedAt);
  assert.equal(harness.stateUpdates(), 0);

  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/queries");
    assert.deepEqual(JSON.parse(options.body), { updates });
    return Response.json({ updates, generatedAt: executedAt });
  };
  const counts = await harness.tools.get("update_data_app_query").execute({ updates });
  assert.deepEqual(counts, { updates: updates.map(({ queryId, rows }) => ({ queryId, rowCount: rows.length })) });
  harness.render();
  const after = await harness.tools.get("list_data_app_queries").execute();
  for (const update of updates) {
    const expected = { ...seed.queries[update.queryId], rows: update.rows,
      source: { ...seed.queries[update.queryId].source, executedAt: update.executedAt } };
    assert.deepEqual(store.getQueries()[update.queryId], expected);
    assert.deepEqual(harness.snapshot().queries[update.queryId], expected);
    const listed = after.find(({ queryId }) => queryId === update.queryId);
    assert.equal(listed.loaded, true);
    assert.deepEqual(listed.source, expected.source);
    assert.deepEqual(listed.methods, expected.methods);
    assert.equal(Object.hasOwn(listed, "rows"), false);
  }
  assert.deepEqual(store.getQueries().untouched, seed.queries.untouched);
  assert.equal(harness.snapshot()._dataAppQueryLoading, undefined);
  assert.equal(harness.snapshot().generatedAt, executedAt);
});
