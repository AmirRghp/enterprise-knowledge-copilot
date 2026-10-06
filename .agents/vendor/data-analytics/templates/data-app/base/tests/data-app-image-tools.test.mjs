import assert from "node:assert/strict";
import test from "node:test";

import { createDataAppImageTools } from "../src/data-app-image-tools.js";

function target(id, { hidden = false, title = "Same title", attributes = {} } = {}) {
  return {
    component: { id, title, kind: "chart", queryId: "reviewed", scopeFilters: [{ field: "region", value: "West" }] },
    element: {
      isConnected: true, closest: () => hidden ? {} : null,
      getAttribute: (name) => attributes[name] ?? null,
      hasAttribute: (name) => Object.hasOwn(attributes, name),
      getClientRects: () => [{ width: 200, height: 100 }],
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility: "visible" }) } },
    },
  };
}

function fixture({ targets = [target("first"), target('second["\\]')], renderImage } = {}) {
  const state = { targets, view: { surface: "dashboard", tabId: "overview", filters: { region: "West" } } };
  const calls = [];
  const registry = createDataAppImageTools({
    getTargets: () => state.targets, getViewState: () => state.view,
    renderImage: async (element, options) => {
      calls.push({ element, options });
      return renderImage ? renderImage(element, options) : {
        blob: new Blob([Uint8Array.of(0, 127, 128, 255)], { type: "image/png" }), width: 400, height: 200,
      };
    },
  });
  return { state, calls, ...registry,
    call: (name, input) => registry.tools.find((tool) => tool.name === name).execute(input) };
}

test("discovery and export use exact IDs despite matching titles and selector characters", async () => {
  const { call, calls, state, tools } = fixture();
  const listing = await call("list_data_app_cards", {});
  assert.deepEqual(listing.cards.map(({ cardId }) => cardId), ["first", 'second["\\]']);
  assert.ok(listing.cards.every(({ imageAvailable }) => imageAvailable));
  assert.ok(tools.every(({ annotations }) => annotations.readOnlyHint && annotations.untrustedContentHint));
  const image = await call("get_data_app_card_image", { cardId: 'second["\\]', scale: 3 });
  assert.equal(calls[0].element, state.targets[1].element);
  assert.deepEqual(calls[0].options, { scale: 3 });
  assert.deepEqual(Buffer.from(image.data, "base64"), Buffer.from([0, 127, 128, 255]));
  assert.deepEqual([image.width, image.height, image.mimeType, image.encoding], [400, 200, "image/png", "base64"]);
  assert.equal(image.cardId, 'second["\\]');
  assert.deepEqual(image.view, state.view);
  assert.deepEqual(image.queryIds, ["reviewed"]);
  assert.deepEqual(image.scopeFilters, [{ field: "region", value: "West" }]);
  assert.ok(image.filename.endsWith(".png"));
});

test("batch validates all IDs before rendering and preserves requested order", async () => {
  const { call, calls } = fixture();
  await assert.rejects(call("get_data_app_card_images", { cardIds: ["first", "missing"] }), /not mounted/u);
  assert.equal(calls.length, 0);
  const result = await call("get_data_app_card_images", { cardIds: ['second["\\]', "first"] });
  assert.deepEqual(result.images.map(({ cardId }) => cardId), ['second["\\]', "first"]);
  assert.equal(calls.length, 2);
});

test("hidden, ambiguous, disconnected and missing IDs never silently select a card", async () => {
  const { call, calls, state } = fixture({ targets: [target("hidden", { hidden: true }), target("duplicate"), target("duplicate")] });
  const { cards } = await call("list_data_app_cards", {});
  assert.deepEqual(cards.map(({ unavailableReason }) => unavailableReason), ["hidden", "duplicate_id", "duplicate_id"]);
  assert.ok(cards.every(({ imageAvailable }) => !imageAvailable));
  for (const [cardId, error] of [["hidden", /hidden/u], ["duplicate", /ambiguous/u], ["unknown", /not mounted/u]]) {
    await assert.rejects(call("get_data_app_card_image", { cardId }), error);
  }
  state.targets = [target("detached")];
  state.targets[0].element.isConnected = false;
  await assert.rejects(call("get_data_app_card_image", { cardId: "detached" }), /hidden/u);
  assert.equal(calls.length, 0);
});

test("loading and failed cards stay unavailable until their reviewed data is ready", async () => {
  const loading = { "aria-busy": "true", "data-loading-kind": "chart" };
  const failed = { "data-loading-kind": "table" };
  const { call, calls } = fixture({ targets: [target("ready"), target("loading", { attributes: loading }),
    target("failed", { attributes: failed })] });
  const { cards } = await call("list_data_app_cards", {});
  assert.deepEqual(cards.map(({ imageAvailable, unavailableReason }) => [imageAvailable, unavailableReason]),
    [[true, undefined], [false, "data_unavailable"], [false, "data_unavailable"]]);
  for (const cardId of ["loading", "failed"]) {
    await assert.rejects(call("get_data_app_card_image", { cardId }), /loading or failed to load/u);
    await assert.rejects(call("get_data_app_card_images", { cardIds: ["ready", cardId] }), /loading or failed to load/u);
  }
  assert.equal(calls.length, 0, "A pending card prevents any part of a requested batch from rendering");
  delete loading["aria-busy"];
  delete loading["data-loading-kind"];
  const refreshed = await call("list_data_app_cards", {});
  assert.equal(refreshed.cards.find(({ cardId }) => cardId === "loading").imageAvailable, true);
  const image = await call("get_data_app_card_image", { cardId: "loading" });
  assert.equal(image.cardId, "loading");
  assert.equal(calls.length, 1);
});

test("a card entering a loading or error state cannot complete an in-flight batch", async () => {
  for (const pendingAttributes of [{ "aria-busy": "true" }, { "data-loading-kind": "chart" }]) {
    const attributes = {};
    const f = fixture({ targets: [target("first", { attributes }), target("second")], renderImage: async () => {
      Object.assign(attributes, pendingAttributes);
      return { blob: new Blob(["png"], { type: "image/png" }), width: 1, height: 1 };
    } });
    await assert.rejects(f.call("get_data_app_card_images", { cardIds: ["first", "second"] }), /loading or failed to load/u);
    assert.equal(f.calls.length, 1, "No image is returned and the remaining card is not rendered");
  }
});

test("tool execution enforces schemas even when a host does not validate them", async () => {
  const { call, calls } = fixture();
  for (const input of [null, [], { cardId: "" }, { cardId: 3 }, { cardId: "x".repeat(201) },
    { cardId: "first", unknown: true }, ...[0, 4, NaN, Infinity, "2", null].map((scale) => ({ cardId: "first", scale }))]) {
    await assert.rejects(call("get_data_app_card_image", input));
  }
  for (const cardIds of [[], "first", ["first", "first"], Array.from({ length: 9 }, (_, index) => String(index))]) {
    await assert.rejects(call("get_data_app_card_images", { cardIds }), /unique cardIds/u);
  }
  await assert.rejects(call("list_data_app_cards", { includeRows: true }), /Invalid/u);
  assert.equal(calls.length, 0);
});

test("no stale or partially updated images escape a changing view or replaced card", async () => {
  for (const change of [
    (state) => { state.view.filters.region = "East"; },
    (state) => { state.view.tabId = "details"; },
    (state) => { state.targets[0] = target("first"); },
    (state) => { state.targets[0] = { ...state.targets[0], component: { ...state.targets[0].component, title: "Edited" } }; },
  ]) {
    const f = fixture({ renderImage: async () => {
      change(f.state);
      return { blob: new Blob(["png"], { type: "image/png" }), width: 1, height: 1 };
    } });
    await assert.rejects(f.call("get_data_app_card_images", { cardIds: ["first", 'second["\\]'] }), /changed during/u);
    assert.equal(f.calls.length, 1, "A failed batch must stop before rendering the next card");
  }
});

test("exports reject overlapping calls and release their guard after failure", async () => {
  let reject;
  const f = fixture({ renderImage: () => new Promise((_, failure) => { reject = failure; }) });
  const pending = f.call("get_data_app_card_image", { cardId: "first" });
  await assert.rejects(f.call("get_data_app_card_image", { cardId: "first" }), /already running/u);
  reject(new Error("Rendering failed"));
  await assert.rejects(pending, /Rendering failed/u);
  const retry = f.call("get_data_app_card_image", { cardId: "first" });
  reject(new Error("Retry reached renderer"));
  await assert.rejects(retry, /Retry reached renderer/u);
});

test("disposed tools cannot read or complete an in-flight export", async () => {
  let finish;
  const f = fixture({ renderImage: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.call("get_data_app_card_image", { cardId: "first" });
  f.dispose();
  finish({ blob: new Blob(["png"], { type: "image/png" }), width: 1, height: 1 });
  await assert.rejects(pending, /no longer open/u);
  await assert.rejects(f.call("list_data_app_cards", {}), /no longer open/u);
});

test("image and aggregate byte limits reject oversized payloads instead of returning partial data", async () => {
  for (const [bytes, cardIds] of [[4 * 1024 * 1024 + 1, ["first"]], [3 * 1024 * 1024, ["first", "second", "third"]]]) {
    const f = fixture({ targets: cardIds.map((id) => target(id)), renderImage: async () => ({
      blob: new Blob([new Uint8Array(bytes)], { type: "image/png" }), width: 400, height: 200,
    }) });
    await assert.rejects(f.call("get_data_app_card_images", { cardIds }), /too large/u);
  }
});
