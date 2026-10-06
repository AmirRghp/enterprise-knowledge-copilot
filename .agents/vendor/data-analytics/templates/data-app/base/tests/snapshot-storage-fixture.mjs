import assert from "node:assert/strict";
import { createHash } from "node:crypto";
let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); }
catch (error) { if (error.code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error; }
export const sqliteUnavailable = !DatabaseSync && "Real SQLite fixture requires node:sqlite; run with the bundled Codex Node runtime.";

export const fingerprint = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const bytes = value => Buffer.byteLength(JSON.stringify(value));
export const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
export function reviewedSeed(count = 41, label = "initial") {
  return {
    id: "bounded-snapshot-fixture", title: label, generatedAt: "2026-01-01T00:00:00.000Z",
    queries: Object.fromEntries([
      ["reviewed", { sql: "SELECT reviewed", rows: Array.from({ length: count }, (_, index) => ({
        index, value: index / 7, label: index % 2 ? "Quotes \" \\ café 日本語 🧪" : null,
      })) }],
      ["__proto__", { source: { kind: "fixture" }, rows: [{ value: null }] }],
      ["empty", { rows: [] }],
    ]),
  };
}

// Execute real SQLite JSON/window/transaction semantics behind D1's small API.
// Deterministic hooks run before a transaction to test overlapping requests.
export function fixtureDatabase() {
  if (!DatabaseSync) throw new Error(sqliteUnavailable);
  const sqlite = new DatabaseSync(":memory:");
  const operations = [], pages = [];
  let before;
  const record = async (kind, statements) => {
    const operation = { kind, statements, bytes: bytes(statements) };
    for (const statement of statements) assert.ok(statement.params.length <= 100);
    if (kind === "batch") assert.ok(operation.bytes <= 256 * 1024);
    operations.push(operation);
    await before?.(operation);
  };
  function prepare(sql, params = []) {
    const execute = () => sqlite.prepare(sql);
    return {
      sql, params,
      bind(...values) { return prepare(sql, values); },
      runNow() {
        const result = execute().run(...params);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      allNow() { return { success: true, results: execute().all(...params) }; },
      async run() { await record("run", [{ sql, params }]); return this.runNow(); },
      async first() { await record("first", [{ sql, params }]); return execute().get(...params) ?? null; },
      async all() {
        await record("all", [{ sql, params }]);
        const result = this.allNow();
        if (sql.includes("AS page_bytes")) {
          const page = { rows: result.results.length, bytes: result.results.reduce((sum, row) => sum + Buffer.byteLength(row.row_json), 0) };
          assert.ok(page.bytes <= 256 * 1024);
          pages.push(page);
        }
        return result;
      },
    };
  }
  const db = {
    prepare,
    async batch(statements) {
      await record("batch", statements.map(({ sql, params }) => ({ sql, params })));
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map(statement => /^\s*SELECT\b/iu.test(statement.sql) ? statement.allNow() : statement.runNow());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return { db, operations, pages, sqlite, hook(value) { before = value; }, close() { sqlite.close(); } };
}
