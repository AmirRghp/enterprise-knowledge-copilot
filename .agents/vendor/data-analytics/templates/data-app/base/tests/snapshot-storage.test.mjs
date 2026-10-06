import assert from "node:assert/strict";
import test from "node:test";
import { snapshotResponse, storedQueryExists, updateBoundedQuery, updateBoundedQueries } from "../src/snapshot-storage.js";
import { deferred, fingerprint, fixtureDatabase, reviewedSeed, sqliteUnavailable } from "./snapshot-storage-fixture.mjs";

const response = (db, seed, load = async () => seed) => snapshotResponse(db, load, fingerprint(seed));
const read = async (db, seed, load) => (await response(db, seed, load)).json();
const rowInsert = operation => operation.statements.some(({ sql }) => sql.startsWith("INSERT INTO data_app_rows_v2"));
const storageTest = (name, run) => test(name, { skip: sqliteUnavailable }, run);

storageTest("bounded reads preserve every value and use byte-bounded pages instead of per-row chunks", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(4097); let loads = 0;
  const initial = await response(fixture.db, seed, async () => { loads++; return seed; });
  const chunks = [];
  for await (const chunk of initial.body) chunks.push(chunk);
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), seed);
  assert.ok(chunks.length < 30, "Thousands of rows should not cause thousands of stream pulls");
  assert.ok(fixture.pages.some(page => page.rows === 1024));
  assert.equal(loads, 1);
  assert.deepEqual(await read(fixture.db, seed, async () => { throw new Error("Warm seed parse"); }), seed);
  assert.equal(await storedQueryExists(fixture.db, async () => { throw new Error("Warm seed parse"); }, fingerprint(seed), "__proto__"), true);
  assert.equal(await storedQueryExists(fixture.db, async () => seed, fingerprint(seed), "missing"), false);
});

storageTest("wide escaped rows remain complete across byte-limited write batches and read pages", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(85);
  seed.queries.reviewed.rows.forEach(row => { row.payload = "日本語\\\"".repeat(1800); });
  assert.deepEqual(await read(fixture.db, seed), seed);
  assert.ok(fixture.operations.filter(operation => operation.kind === "batch" && rowInsert(operation)).length > 1);
  assert.ok(fixture.pages.some(page => page.rows > 1 && page.rows < 85));
});

storageTest("warm responses read wide query definitions individually while preserving captured metadata and revisions", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(2);
  seed.queries = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`query-${index}`, {
    sql: `SELECT ${index} /* ${"x".repeat(200_000)} */`,
    source: { title: `Reviewed query ${index}`, evidence: [null, "café 日本語", { verified: true }] },
    rows: [{ index }],
  }]));
  await read(fixture.db, seed);
  const reads = [];
  const record = value => { reads.push(Buffer.byteLength(JSON.stringify(value))); return value; };
  function prepare(sql, params = []) {
    const statement = fixture.db.prepare(sql).bind(...params);
    return { ...statement, bind: (...values) => prepare(sql, values), async first() { return record(await statement.first()); } };
  }
  const database = { prepare, async batch(statements) { return record(await fixture.db.batch(statements)); } };
  const captured = await response(database, seed, async () => { throw new Error("Warm seed parse"); });
  await updateBoundedQuery(fixture.db, "query-0", [{ changed: true }], "2026-02-01T00:00:00.000Z", fingerprint(seed));
  const next = structuredClone(seed);
  next.title = "New generation";
  next.queries["query-1"].sql = "SELECT replacement";
  await read(fixture.db, next);
  // The open response retains the original query metadata and row revisions
  // even when both its row pointer and the live generation change.
  assert.deepEqual(await captured.json(), seed);
  assert.ok(reads.every(bytes => bytes < 256 * 1024), `Unexpected wide metadata read: ${Math.max(...reads)} bytes`);
  assert.ok(reads.filter(bytes => bytes > 200_000).length === 40, "Every complete definition is read separately");
});

storageTest("oversized rows and metadata fail without activating a partial generation", async t => {
  for (const kind of ["row", "metadata", "query"]) {
    await t.test(kind, async t => {
      const fixture = fixtureDatabase(); t.after(() => fixture.close());
      const seed = reviewedSeed(); await read(fixture.db, seed);
      const oversized = reviewedSeed(41, kind);
      if (kind === "row") oversized.queries.reviewed.rows[40].payload = "x".repeat(256 * 1024);
      if (kind === "metadata") oversized.description = "x".repeat(256 * 1024);
      if (kind === "query") oversized.queries.reviewed.sql = "x".repeat(256 * 1024);
      await assert.rejects(response(fixture.db, oversized), { code: "SNAPSHOT_VALUE_TOO_LARGE" });
      assert.deepEqual(await read(fixture.db, seed), seed);
    });
  }
});

storageTest("failed later batches do not replace visible seed data and retry completes", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(); await read(fixture.db, seed);
  const next = reviewedSeed(2400, "new"); let batches = 0;
  fixture.hook(operation => { if (operation.kind === "batch" && rowInsert(operation) && ++batches === 2) throw new Error("Interrupted upload"); });
  await assert.rejects(response(fixture.db, next), /Interrupted upload/u);
  fixture.hook(null);
  assert.deepEqual(await read(fixture.db, seed), seed);
  assert.deepEqual(await read(fixture.db, next), next);
});

storageTest("streams capture immutable revisions across an owner query update", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(2050); const captured = await response(fixture.db, seed);
  const rows = [{ changed: true }], generatedAt = "2026-02-01T00:00:00.000Z";
  await updateBoundedQuery(fixture.db, "reviewed", rows, generatedAt, fingerprint(seed));
  assert.deepEqual(await captured.json(), seed);
  const expected = structuredClone(seed); expected.generatedAt = generatedAt; expected.queries.reviewed.rows = rows;
  assert.deepEqual(await read(fixture.db, seed), expected);
  await updateBoundedQuery(fixture.db, "empty", [], generatedAt, fingerprint(seed));
  assert.deepEqual(await read(fixture.db, seed), expected);
});

storageTest("a partially staged query replacement leaves its prior complete revision readable", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(); await read(fixture.db, seed);
  const rows = reviewedSeed(2400).queries.reviewed.rows; let batches = 0;
  fixture.hook(operation => { if (operation.kind === "batch" && rowInsert(operation) && ++batches === 2) throw new Error("Interrupted query update"); });
  await assert.rejects(updateBoundedQuery(fixture.db, "reviewed", rows, "2026-02-01T00:00:00.000Z", fingerprint(seed)), /Interrupted query update/u);
  fixture.hook(null);
  assert.deepEqual(await read(fixture.db, seed), seed);
});

storageTest("same-seed concurrent initialization is idempotent and a different winner cannot be overwritten", async t => {
  for (const same of [true, false]) await t.test(same ? "same seed" : "different seed", async t => {
    const fixture = fixtureDatabase(); t.after(() => fixture.close());
    const first = reviewedSeed(61, "first"), second = same ? first : reviewedSeed(31, "second");
    const paused = deferred(), resume = deferred(); let gated = false;
    fixture.hook(async operation => {
      if (!gated && operation.kind === "batch" && rowInsert(operation)) {
        gated = true; paused.resolve(); await resume.promise;
      }
    });
    const waiting = response(fixture.db, first); waiting.catch(() => {});
    await paused.promise;
    assert.deepEqual(await read(fixture.db, second), second);
    resume.resolve();
    if (same) assert.deepEqual(await (await waiting).json(), first);
    else await assert.rejects(waiting, { code: "SNAPSHOT_HEAD_CONFLICT" });
    assert.deepEqual(await read(fixture.db, second), second);
  });
});

storageTest("concurrent query replacements publish one revision and reject a stale seed update", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(); await read(fixture.db, seed);
  const paused = deferred(), resume = deferred(); let gated = false;
  fixture.hook(async operation => {
    if (!gated && operation.kind === "batch" && rowInsert(operation)) { gated = true; paused.resolve(); await resume.promise; }
  });
  const generatedAt = "2026-02-01T00:00:00.000Z";
  const waiting = updateBoundedQuery(fixture.db, "reviewed", [{ loser: true }], generatedAt, fingerprint(seed)); waiting.catch(() => {});
  await paused.promise;
  await updateBoundedQuery(fixture.db, "reviewed", [{ winner: true }], generatedAt, fingerprint(seed));
  resume.resolve();
  await assert.rejects(waiting, { code: "QUERY_REVISION_CONFLICT" });
  assert.deepEqual((await read(fixture.db, seed)).queries.reviewed.rows, [{ winner: true }]);
  const next = reviewedSeed(3, "next"); await read(fixture.db, next);
  await assert.rejects(updateBoundedQuery(fixture.db, "reviewed", [], generatedAt, fingerprint(seed)), { code: "SNAPSHOT_HEAD_CONFLICT" });
  assert.deepEqual(await read(fixture.db, next), next);
});

storageTest("populated legacy storage is preserved and missing immutable rows fail explicitly", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  fixture.sqlite.exec("CREATE TABLE data_app_query_rows (value TEXT); INSERT INTO data_app_query_rows VALUES ('preserve')");
  await assert.rejects(response(fixture.db, reviewedSeed()), { code: "LEGACY_SNAPSHOT_REQUIRES_MIGRATION" });
  assert.equal(fixture.sqlite.prepare("SELECT value FROM data_app_query_rows").get().value, "preserve");
  fixture.sqlite.exec("DROP TABLE data_app_query_rows");
  const seed = reviewedSeed(); await read(fixture.db, seed);
  fixture.sqlite.exec("DELETE FROM data_app_rows_v2 WHERE position=2");
  await assert.rejects(read(fixture.db, seed), { code: "INCOMPLETE_SNAPSHOT" });
});


storageTest("batch refresh saves rows and source times together while an older stream stays consistent", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(2050), hash = fingerprint(seed);
  const captured = await response(fixture.db, seed);
  const generatedAt = "2026-02-03T00:00:00.000Z";
  const updates = [
    { queryId: "reviewed", rows: [{ value: 42 }], executedAt: "2026-02-01T00:00:00.000Z" },
    { queryId: "empty", rows: [{ value: 7 }], executedAt: "2026-02-02T00:00:00.000Z" },
  ];
  await updateBoundedQueries(fixture.db, updates, generatedAt, hash);
  assert.deepEqual(await captured.json(), seed);
  const expected = structuredClone(seed); expected.generatedAt = generatedAt;
  for (const { queryId, rows, executedAt } of updates) {
    expected.queries[queryId].rows = rows;
    expected.queries[queryId].source = { executedAt };
  }
  assert.deepEqual(await read(fixture.db, seed), expected);
  await updateBoundedQuery(fixture.db, "reviewed", [], generatedAt, hash);
  expected.queries.reviewed.rows = [];
  assert.deepEqual(await read(fixture.db, seed), expected);
});

storageTest("failure when committing a batch keeps every previous dataset and source time", async t => {
  const fixture = fixtureDatabase(); t.after(() => fixture.close());
  const seed = reviewedSeed(); await read(fixture.db, seed);
  fixture.sqlite.exec(`CREATE TRIGGER fail_refresh BEFORE UPDATE ON data_app_generations_v2
    BEGIN SELECT RAISE(ABORT, 'Failed metadata write'); END`);
  const updates = ["reviewed", "empty"].map(queryId => ({
    queryId, rows: [{ value: 42 }], executedAt: "2026-02-01T00:00:00.000Z",
  }));
  await assert.rejects(updateBoundedQueries(fixture.db, updates, "2026-02-02T00:00:00.000Z", fingerprint(seed)), /Failed metadata write/);
  assert.deepEqual(await read(fixture.db, seed), seed);
});
