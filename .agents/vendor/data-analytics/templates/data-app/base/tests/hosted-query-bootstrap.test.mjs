import assert from "node:assert/strict";
import test from "node:test";
import { loadHostedSnapshot } from "../src/hosted-query-bootstrap.js";

const hash = "a".repeat(64);
const metadata = { id: "dashboard:test", queries: { q: { source: { sql: "SELECT value" } } },
  _dataAppQueryLoading: { version: 1, snapshotSha256: hash, queries: { q: { rowCount: 1, columns: ["value"] } } } };

test("opted-in bootstrap checks its immutable head without fetching query rows", async () => {
  const calls = [];
  const result = await loadHostedSnapshot(metadata, { request: async url => {
    calls.push(url);
    return Response.json({ supported: true, snapshotSha256: hash, queries: { q: { revision: "seed" } } });
  } });
  assert.equal(result.snapshot, metadata);
  assert.equal(result.deferred, true);
  assert.deepEqual(calls, ["/api/snapshot/head"]);
});

test("ordinary apps and legacy/owner-edited storage retain complete eager data", async () => {
  const full = { queries: { q: { rows: [{ value: 42 }] } } };
  for (const bootstrap of [{ queries: {} }, metadata]) {
    const calls = [];
    const result = await loadHostedSnapshot(bootstrap, { request: async url => {
      calls.push(url);
      return Response.json(url.endsWith("/head") ? { supported: false } : full);
    } });
    assert.equal(result.deferred, false);
    assert.deepEqual(result.snapshot, full);
    assert.deepEqual(calls, bootstrap === metadata ? ["/api/snapshot/head", "/api/snapshot"] : ["/api/snapshot"]);
  }
});

test("new client falls back for an older server but never hides a head failure", async () => {
  for (const status of [404, 405]) {
    const result = await loadHostedSnapshot(metadata, { request: async url => url.endsWith("/head")
      ? new Response(null, { status }) : Response.json({ queries: { q: { rows: [] } } }) });
    assert.equal(result.deferred, false);
  }
  await assert.rejects(loadHostedSnapshot(metadata, { request: async () => new Response(null, { status: 503 }) }), /unavailable/);
});

test("deployment and query identity mismatches never instantiate mixed metadata", async () => {
  for (const head of [
    { supported: true, snapshotSha256: "b".repeat(64), queries: { q: { revision: "seed" } } },
    { supported: true, snapshotSha256: hash, queries: {} },
    { supported: true, snapshotSha256: hash, queries: { q: { revision: "updated" } } },
  ]) await assert.rejects(loadHostedSnapshot(metadata, { request: async () => Response.json(head) }), /deployment changed/);
});
