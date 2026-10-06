import assert from "node:assert/strict";
import test from "node:test";

import { createQueryDataStore } from "../src/query-data-store.js";

const snapshotSha256 = "a".repeat(64);
const turn = () => new Promise(resolve => setImmediate(resolve));
const snapshot = ids => ({ queries: Object.fromEntries(ids.map(id => [id, { source: { label: id } }])) });
const response = rows => {
  const result = new Response(JSON.stringify(rows));
  result.json = result.text = () => { throw new Error("Queries must use streaming JSON parsing."); };
  return result;
};
function requests() {
  const calls = [];
  return { calls, request(url, options) {
    return new Promise(resolve => calls.push({ url, options, resolve }));
  } };
}

test("query loading is explicit, deduplicated, identity-preserving, and distinguishes empty results", async () => {
  const network = requests();
  const seed = snapshot(["usage / ?", "unused", "empty"]);
  seed.queries.empty.rows = [];
  const changes = [];
  const store = createQueryDataStore(seed, { snapshotSha256, request: network.request, onChange: value => changes.push(value) });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  assert.equal(store.getQueries(), seed.queries);
  assert.equal(store.isReady(["empty"]), true);
  assert.equal(store.isReady(["usage / ?"]), false);
  assert.equal(store.getVersion(), store.getVersion());
  await store.ensure(["empty"]);
  assert.equal(network.calls.length, 0);
  const first = store.ensure(["usage / ?", "usage / ?"]);
  const second = store.ensure(["usage / ?"]);
  assert.equal(network.calls.length, 1);
  assert.equal(store.pending(["usage / ?"]), true);
  assert.equal(store.error(["usage / ?"]), null);
  assert.equal(network.calls[0].url, `/api/query-rows?queryId=usage%20%2F%20%3F&snapshot=${snapshotSha256}&revision=seed`);
  assert.equal(network.calls[0].options.credentials, "same-origin");
  network.calls[0].resolve(response([{ text: "𠜎 café", nested: { value: null }, count: 3 }]));
  await Promise.all([first, second]);
  const rows = store.getQueries()["usage / ?"].rows;
  assert.deepEqual(rows, [{ text: "𠜎 café", nested: { value: null }, count: 3 }]);
  assert.equal(store.getQueries().empty.rows, seed.queries.empty.rows);
  assert.equal(store.getQueries()["usage / ?"].source, seed.queries["usage / ?"].source);
  assert.equal(seed.queries["usage / ?"].rows, undefined);
  assert.equal(store.getQueries().unused.rows, undefined);
  assert.equal(store.pending(["usage / ?"]), false);
  await store.ensure(["usage / ?"]);
  assert.equal(store.getQueries()["usage / ?"].rows, rows);
  assert.equal(network.calls.length, 1);
  assert.equal(changes.length, 1);
  assert.equal(changes[0], store.getQueries());
  assert.equal(notifications, 2);
  unsubscribe();
  store.replace("empty", [{ count: 1 }]);
  assert.equal(notifications, 2);
  store.dispose();
});

test("loadAll limits concurrent transport to two and preserves every row and query key", async () => {
  const network = requests();
  const seed = snapshot(["first", "second", "third", "__proto__", "last"]);
  const store = createQueryDataStore(seed, { snapshotSha256, request: network.request });
  const complete = store.loadAll();
  assert.equal(network.calls.length, 2);
  const manyRows = Array.from({ length: 10_001 }, (_, index) => ({ index, text: `row ${index}` }));
  network.calls[0].resolve(response(manyRows));
  await turn();
  assert.equal(network.calls.length, 3);
  network.calls[1].resolve(response([]));
  await turn();
  assert.equal(network.calls.length, 4);
  network.calls[2].resolve(response([{ amount: -0.5 }]));
  await turn();
  assert.equal(network.calls.length, 5);
  network.calls[3].resolve(response([{ own: true }]));
  network.calls[4].resolve(response([{ final: true }]));
  await complete;
  assert.deepEqual(store.getQueries().first.rows, manyRows);
  assert.equal(store.getQueries().first.rows.at(-1).index, 10_000);
  assert.equal(Object.hasOwn(store.getQueries(), "__proto__"), true);
  assert.deepEqual(store.getQueries().__proto__.rows, [{ own: true }]);
  assert.deepEqual(store.getQueries().second.rows, []);
  assert.equal(store.isReady(Object.keys(seed.queries)), true);
  store.dispose();
});

test("failed transport, malformed data, and incomplete results stay unavailable until an explicit retry", async t => {
  for (const [name, failed] of [
    ["http", () => new Response("Unavailable", { status: 503 })],
    ["truncated", () => new Response('[{"value":')],
    ["shape", () => response({ value: 3 })],
    ["count", () => response([])],
  ]) await t.test(name, async () => {
    let calls = 0;
    const seed = snapshot(["source"]);
    seed._dataAppQueryLoading = { queries: { source: { rowCount: 1, columns: ["value"] } } };
    const store = createQueryDataStore(seed, { snapshotSha256,
      request: async () => ++calls === 1 ? failed() : response([{ value: 3 }]) });
    await assert.rejects(store.ensure(["source"]));
    assert.equal(store.isReady(["source"]), false);
    assert.equal(store.pending(["source"]), false);
    assert.ok(store.error(["source"]) instanceof Error);
    assert.equal(store.getQueries().source.rows, undefined);
    await turn();
    assert.equal(calls, 1);
    await store.ensure(["source"]);
    assert.equal(calls, 2);
    assert.equal(store.error(["source"]), null);
    assert.deepEqual(store.getQueries().source.rows, [{ value: 3 }]);
    store.dispose();
  });
});

test("owner replacements win over in-flight or queued loads, including ignored aborts", async () => {
  const network = requests();
  const seed = snapshot(["active", "other", "queued"]);
  const store = createQueryDataStore(seed, { snapshotSha256, request: network.request });
  const complete = store.loadAll();
  const activeRows = [{ owner: "new", nested: { exact: 4 } }], queuedRows = [];
  const executedAt = "2026-09-09T08:00:00Z";
  store.replace("active", activeRows, executedAt);
  store.replace("queued", queuedRows);
  assert.equal(network.calls[0].options.signal.aborted, true);
  assert.equal(store.getQueries().active.rows, activeRows);
  assert.deepEqual(store.getQueries().active.source, { ...seed.queries.active.source, executedAt });
  assert.equal(store.getQueries().queued.rows, queuedRows);
  network.calls[0].resolve(response([{ owner: "stale" }]));
  network.calls[1].resolve(response([{ other: true }]));
  await complete;
  await turn();
  assert.equal(network.calls.length, 2);
  assert.equal(store.getQueries().active.rows, activeRows);
  assert.deepEqual(store.getQueries().active.source, { ...seed.queries.active.source, executedAt });
  store.replace("active", activeRows);
  assert.equal(store.getQueries().active.source.executedAt, executedAt);
  assert.equal(store.getQueries().queued.rows, queuedRows);
  assert.deepEqual(store.getQueries().other.rows, [{ other: true }]);
  assert.equal(store.error(["active", "queued"]), null);
  store.dispose();
});

test("dispose aborts active loads, rejects queued waiters, and ignores late responses", async () => {
  const network = requests();
  const store = createQueryDataStore(snapshot(["a", "b", "c"]), { snapshotSha256, request: network.request });
  const complete = store.loadAll();
  const rejected = assert.rejects(complete, /no longer active/u);
  store.dispose();
  await rejected;
  assert.equal(network.calls.length, 2);
  assert.ok(network.calls.every(call => call.options.signal.aborted));
  network.calls.forEach(call => call.resolve(response([{ stale: true }])));
  await turn();
  assert.equal(network.calls.length, 2);
  assert.equal(store.getQueries().a.rows, undefined);
  assert.equal(store.pending(["a", "b", "c"]), false);
  await assert.rejects(store.ensure(["a"]), /no longer active/u);
  assert.throws(() => store.replace("a", []), /no longer active/u);
});

test("query isolation rejects undeclared IDs and invalid results without issuing requests", async () => {
  const network = requests();
  const store = createQueryDataStore(snapshot(["known"]), { snapshotSha256, request: network.request });
  await assert.rejects(store.ensure(["toString"]), /Unknown reviewed query/u);
  await assert.rejects(store.ensure(["known", "missing"]), /Unknown reviewed query/u);
  assert.throws(() => store.replace("known", {}), /must be an array/u);
  assert.equal(network.calls.length, 0);
  assert.equal(store.pending(["known"]), false);
  store.dispose();
});


test("query-parameter routing preserves exact dot-segment IDs", async () => {
  const seen = [];
  const store = createQueryDataStore(snapshot([".", ".."]), { snapshotSha256,
    request: async url => { seen.push(new URL(url, "https://fixture.chatgpt.site")); return response([]); } });
  await store.ensure([".", ".."]);
  assert.deepEqual(seen.map(url => url.pathname), ["/api/query-rows", "/api/query-rows"]);
  assert.deepEqual(seen.map(url => url.searchParams.get("queryId")), [".", ".."]);
  store.dispose();
});
