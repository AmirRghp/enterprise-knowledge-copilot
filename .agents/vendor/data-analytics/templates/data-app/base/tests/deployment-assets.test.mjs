import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createDataAppWorker } from "../src/data-app-worker.js";
import { fixtureDatabase, reviewedSeed, sqliteUnavailable } from "./snapshot-storage-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const owner = "owner@example.com", token = "synthetic-deployment-test-only";
const authorization = { sha256: hash(token), expiresAt: "2999-01-01T00:00:00.000Z" };
// Node provides Compression Streams but not Workers' FixedLengthStream. This
// fixture enforces its byte-count contract; native R2/Workers need hosted QA.
const originalFixedLengthStream = globalThis.FixedLengthStream;
before(() => {
  if (originalFixedLengthStream) return;
  globalThis.FixedLengthStream = class extends TransformStream {
    constructor(expectedBytes) {
      let bytes = 0;
      super({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > expectedBytes) throw new Error("FixedLengthStream overflow");
          controller.enqueue(chunk);
        },
        flush() {
          if (bytes !== expectedBytes) throw new Error("FixedLengthStream underflow");
        },
      });
    }
  };
});
after(() => {
  if (!originalFixedLengthStream) delete globalThis.FixedLengthStream;
});
function fixture() {
  const seed = reviewedSeed(), payloads = { html: Buffer.from("<!doctype html><title>Reviewed</title>"), snapshot: Buffer.from(JSON.stringify(seed)) };
  const assets = Object.fromEntries(Object.entries(payloads).map(([kind, body]) => {
    const sha256 = hash(body); return [kind, { key: `data-app/${kind}/${sha256}`, sha256, bytes: body.length }];
  }));
  const stored = new Map(), calls = [];
  const bucket = {
    async put(key, stream, options) {
      calls.push({ key, options });
      assert.ok(stream instanceof ReadableStream, "Upload must stay streamed through the Worker");
      const body = Buffer.from(await new Response(stream).arrayBuffer());
      // R2 rejects an incorrect supplied checksum before changing the object.
      if (hash(body) !== options.sha256) throw new Error("R2 checksum mismatch");
      const value = { body, options }; stored.set(key, value);
      return { size: body.length };
    },
    async get(key) {
      const value = stored.get(key);
      if (!value) return null;
      return { size: value.body.length, customMetadata: value.options.customMetadata,
        body: new Response(value.body).body, json: async () => JSON.parse(value.body) };
    },
  };
  const configuration = { deploymentAssets: assets, deploymentUploadAuthorization: authorization };
  return { seed, payloads, assets, stored, calls, bucket, configuration };
}
function upload(kind, body, headers = {}) {
  const request = new Request(`https://dashboard.chatgpt.site/api/deployment-assets/${kind}`, {
    method: "PUT", body,
    headers: { "content-length": String(body.length), "x-data-app-deployment-token": token, ...headers },
  });
  Object.defineProperty(request, "arrayBuffer", { value() { assert.fail("Worker must not buffer the upload"); } });
  return request;
}
const viewerRequest = (path, { email, method = "GET", body, deploymentToken } = {}) => new Request(`https://dashboard.chatgpt.site${path}`, {
  method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { ...(email ? { "oai-authenticated-user-email": email } : {}), ...(deploymentToken ? { "x-data-app-deployment-token": deploymentToken } : {}) },
});

test("deployment upload streams both exact assets and serves HTML/permalinks without database work", async () => {
  const fixtureValue = fixture(), worker = createDataAppWorker(fixtureValue.configuration);
  const environment = { BUCKET: fixtureValue.bucket, get DB() { assert.fail("HTML should not initialize D1"); } };
  for (const kind of ["html", "snapshot"]) {
    const response = await worker.fetch(upload(kind, fixtureValue.payloads[kind]), environment);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { kind, sha256: fixtureValue.assets[kind].sha256, bytes: fixtureValue.payloads[kind].length });
  }
  for (const path of ["/", "/index.html", "/_data/charts/safe-id", "/_data/charts/safe-id/detail", "/_data/components/safe-id"]) {
    const response = await worker.fetch(viewerRequest(path), environment);
    assert.equal(response.status, 200); assert.equal(await response.text(), fixtureValue.payloads.html.toString());
    const head = await worker.fetch(viewerRequest(path, { method: "HEAD" }), environment);
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
  }
  const readback = await worker.fetch(viewerRequest("/api/deployment-assets/html", { deploymentToken: token }), environment);
  assert.equal(readback.status, 200);
  assert.equal(readback.headers.get("content-type"), "application/octet-stream");
  assert.equal(await readback.text(), fixtureValue.payloads.html.toString());
  assert.equal(fixtureValue.calls.length, 2);
});

test("gzip deployment uploads store and serve the original bytes for owners and deployment tokens", async () => {
  const value = fixture(), worker = createDataAppWorker(value.configuration);
  const environment = { BUCKET: value.bucket, DATA_APP_OWNER_EMAIL_SHA256: hash(owner) };
  for (const kind of ["html", "snapshot"]) {
    for (const authority of [{}, { "x-data-app-deployment-token": "", "oai-authenticated-user-email": owner }]) {
      const compressed = gzipSync(value.payloads[kind]);
      const result = await worker.fetch(upload(kind, compressed, { "content-encoding": "gzip", ...authority }), environment);
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), { kind, sha256: value.assets[kind].sha256, bytes: value.payloads[kind].length });
      assert.deepEqual(value.stored.get(value.assets[kind].key).body, value.payloads[kind]);
      const readback = await worker.fetch(viewerRequest(`/api/deployment-assets/${kind}`, { deploymentToken: token }), environment);
      assert.equal(readback.status, 200);
      assert.equal(readback.headers.get("content-encoding"), null, "Stored assets must remain uncompressed");
      assert.deepEqual(Buffer.from(await readback.arrayBuffer()), value.payloads[kind]);
    }
  }
});

test("gzip upload corruption, truncation, expansion and checksum failures preserve an existing asset", async t => {
  const value = fixture(), worker = createDataAppWorker(value.configuration), environment = { BUCKET: value.bucket };
  assert.equal((await worker.fetch(upload("snapshot", value.payloads.snapshot), environment)).status, 200);
  const original = value.stored.get(value.assets.snapshot.key);
  const compressed = gzipSync(value.payloads.snapshot);
  const corrupt = Buffer.from(compressed); corrupt[corrupt.length - 8] ^= 1;
  const cases = [
    ["not gzip", value.payloads.snapshot],
    ["corrupt checksum", corrupt],
    ["truncated gzip", compressed.subarray(0, compressed.length - 8)],
    ["decoded bytes too short", gzipSync(value.payloads.snapshot.subarray(1))],
    ["decoded bytes too large", gzipSync(Buffer.alloc(value.payloads.snapshot.length * 100, 120))],
    ["wrong content with exact byte count", gzipSync(Buffer.alloc(value.payloads.snapshot.length, 120))],
  ];
  for (const [name, body] of cases) await t.test(name, async () => {
    const result = await worker.fetch(upload("snapshot", body, { "content-encoding": "gzip" }), environment);
    assert.equal(result.status, 400);
    assert.equal(value.stored.get(value.assets.snapshot.key), original, "An invalid upload must not replace the reviewed bytes");
  });
});

test("unsupported compression and malformed gzip lengths are rejected before storage", async () => {
  const value = fixture(), worker = createDataAppWorker(value.configuration);
  const compressed = gzipSync(value.payloads.html);
  const headers = [
    { "content-encoding": "br" }, { "content-encoding": "gzip, gzip" },
    ...["", "0", "-1", "1.5", "01", "1e3", "9007199254740992"].map(length => ({ "content-encoding": "gzip", "content-length": length })),
  ];
  const missingLength = upload("html", compressed, { "content-encoding": "gzip" }); missingLength.headers.delete("content-length");
  for (const request of [missingLength, ...headers.map(value => upload("html", compressed, value))]) {
    const result = await worker.fetch(request, { get BUCKET() { assert.fail("Invalid transport must not access storage"); } });
    assert.equal(result.status, 400);
  }
  const plain = await worker.fetch(upload("html", value.payloads.html, { "content-encoding": "identity" }), { BUCKET: value.bucket });
  assert.equal(plain.status, 200);
});

test("missing, incorrect, expired and malformed deployment authority is denied before storage", async t => {
  const cases = [
    ["missing token", authorization, ""], ["wrong token", authorization, "wrong"],
    ["oversized token", authorization, "x".repeat(257)], ["missing config", undefined, token],
    ["expired", { ...authorization, expiresAt: "2000-01-01T00:00:00Z" }, token],
    ["invalid expiry", { ...authorization, expiresAt: "invalid" }, token],
    ["invalid hash", { ...authorization, sha256: "invalid" }, token],
  ];
  for (const [name, deploymentUploadAuthorization, supplied] of cases) await t.test(name, async () => {
    const value = fixture(), worker = createDataAppWorker({ ...value.configuration, deploymentUploadAuthorization });
    const result = await worker.fetch(upload("html", value.payloads.html, { "x-data-app-deployment-token": supplied }), {
      get BUCKET() { assert.fail("Unauthorized request must not access storage"); },
    });
    assert.equal(result.status, 403);
    const compressedResult = await worker.fetch(upload("html", gzipSync(value.payloads.html), {
      "x-data-app-deployment-token": supplied, "content-encoding": "gzip",
    }), { get BUCKET() { assert.fail("Unauthorized compressed request must not access storage"); } });
    assert.equal(compressedResult.status, 403);
    const readback = await worker.fetch(viewerRequest("/api/deployment-assets/html", { deploymentToken: supplied }), {
      get BUCKET() { assert.fail("Unauthorized readback must not access storage"); },
    });
    assert.equal(readback.status, 403);
  });
});

test("upload capability is restricted to known keys, exact size and exact checksum", async () => {
  const value = fixture(), worker = createDataAppWorker(value.configuration), environment = { BUCKET: value.bucket };
  assert.equal((await worker.fetch(upload("html", value.payloads.html), environment)).status, 200);
  const original = value.stored.get(value.assets.html.key);
  for (const path of ["unknown", "html/extra", "../query"]) {
    assert.equal((await worker.fetch(upload(path, value.payloads.html), environment)).status, 404);
  }
  const callCount = value.calls.length;
  assert.equal((await worker.fetch(upload("html", value.payloads.html, { "content-length": "0" }), environment)).status, 400);
  assert.equal(value.calls.length, callCount);
  const wrong = Buffer.alloc(value.payloads.html.length, 120);
  assert.equal((await worker.fetch(upload("html", wrong), environment)).status, 400);
  assert.equal(value.stored.get(value.assets.html.key), original, "Checksum rejection must preserve an existing object");
  assert.equal((await worker.fetch(upload("html", value.payloads.html.subarray(1), { "content-length": String(value.payloads.html.length) }), environment)).status, 400);
  assert.equal(value.stored.get(value.assets.html.key), original);
  assert.equal((await worker.fetch(upload("html", value.payloads.html, { "x-data-app-deployment-token": "", authorization: `Bearer ${token}` }), environment)).status, 403);
});

test("deployment token cannot mutate queries or presentation", async () => {
  const value = fixture(), worker = createDataAppWorker(value.configuration);
  for (const path of ["/api/queries/reviewed", "/api/presentation"]) {
    const response = await worker.fetch(viewerRequest(path, { method: "PUT", deploymentToken: token, body: { rows: [] } }), {
      get DB() { assert.fail("A deployment token must not authorize data or presentation writes"); },
    });
    assert.equal(response.status, 403);
  }
});

test("deployment token does not grant viewer edit permission", { skip: sqliteUnavailable }, async t => {
  const value = fixture(), worker = createDataAppWorker(value.configuration), storage = fixtureDatabase(); t.after(() => storage.close());
  const response = await worker.fetch(viewerRequest("/api/presentation", { deploymentToken: token }), { DB: storage.db });
  assert.equal((await response.json()).canEdit, false);
});

test("legitimate owner can upload, edit data and retain presentation across redeployment", { skip: sqliteUnavailable }, async t => {
  const value = fixture(), storage = fixtureDatabase(); t.after(() => storage.close());
  const configuration = { ...value.configuration, deploymentUploadAuthorization: undefined, initialPresentation: { title: "Original" } };
  const worker = createDataAppWorker(configuration), environment = { BUCKET: value.bucket, DB: storage.db, DATA_APP_OWNER_EMAIL_SHA256: hash(owner) };
  for (const kind of ["html", "snapshot"]) assert.equal((await worker.fetch(upload(kind, value.payloads[kind], {
    "x-data-app-deployment-token": "", "oai-authenticated-user-email": owner,
  }), environment)).status, 200);
  const editedRows = [{ ownerReviewed: 42 }];
  assert.equal((await worker.fetch(viewerRequest("/api/queries/reviewed", { email: owner, method: "PUT", body: { rows: editedRows } }), environment)).status, 200);
  const update = await worker.fetch(viewerRequest("/api/presentation", { email: owner, method: "PUT", body: { revision: 0, presentation: { title: "Owner edit" } } }), environment);
  assert.equal(update.status, 200);
  const redeployed = createDataAppWorker({ ...configuration, initialPresentation: { title: "Different seed" } });
  const presentation = await (await redeployed.fetch(viewerRequest("/api/presentation", { email: owner }), environment)).json();
  assert.equal(presentation.canEdit, true); assert.equal(presentation.presentation.title, "Owner edit");
  const saved = await (await redeployed.fetch(viewerRequest("/api/snapshot"), environment)).json();
  assert.deepEqual(saved.queries.reviewed.rows, editedRows);
  assert.deepEqual(saved.queries.empty, value.seed.queries.empty);
});

test("missing or mismatched deployment objects fail explicitly before data activation", { skip: sqliteUnavailable }, async t => {
  const value = fixture(), storage = fixtureDatabase(); t.after(() => storage.close());
  const worker = createDataAppWorker(value.configuration), environment = { BUCKET: value.bucket, DB: storage.db, DATA_APP_OWNER_EMAIL_SHA256: hash(owner) };
  assert.equal((await worker.fetch(viewerRequest("/"), environment)).status, 503);
  assert.equal((await worker.fetch(viewerRequest("/api/snapshot"), environment)).status, 503);
  assert.equal(storage.sqlite.prepare("SELECT COUNT(*) AS n FROM data_app_snapshot_head_v2").get().n, 0);
  value.stored.set(value.assets.html.key, { body: value.payloads.html, options: { customMetadata: { sha256: "incorrect" } } });
  assert.equal((await worker.fetch(viewerRequest("/"), environment)).status, 503);
  assert.equal((await worker.fetch(upload("html", value.payloads.html), {})).status, 503);
});

test("malformed content-addressed descriptors are rejected before requests", () => {
  const value = fixture();
  for (const html of [undefined, { ...value.assets.html, key: "arbitrary" }, { ...value.assets.html, bytes: 0 }, { ...value.assets.html, sha256: "invalid" }]) {
    assert.throws(() => createDataAppWorker({ ...value.configuration, deploymentAssets: { ...value.assets, html } }), /descriptor is invalid/u);
  }
});
