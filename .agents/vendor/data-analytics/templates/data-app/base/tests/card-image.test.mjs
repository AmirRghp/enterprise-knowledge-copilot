import assert from "node:assert/strict";
import test from "node:test";
import { cardImageDimensions, renderDataAppCardImage } from "../src/card-image.js";

test("PNG dimensions retain fractional card bounds at the requested pixel scale", () => {
  assert.deepEqual(cardImageDimensions(799.25, 400.5), { width: 1599, height: 801 });
  assert.deepEqual(cardImageDimensions(799.25, 400.5, 1.5), { width: 1199, height: 601 });
  assert.deepEqual(cardImageDimensions(4000, 4000, 1), { width: 4000, height: 4000 });
});

test("invalid scales, empty layouts, huge dimensions, and excessive pixels fail before canvas allocation", () => {
  for (const scale of [0, 0.99, 3.01, -1, Infinity, NaN, "2", null]) {
    assert.throws(() => cardImageDimensions(100, 100, scale), /scale/u);
  }
  for (const [width, height] of [[0, 100], [100, 0], [-1, 100], [NaN, 100], [100, Infinity]]) {
    assert.throws(() => cardImageDimensions(width, height), /dimensions/u);
  }
  assert.throws(() => cardImageDimensions(4000, 4000, 2), /size limit/u);
  assert.throws(() => cardImageDimensions(16_385, 1, 1), /size limit/u);
  // Rounding is included in the allocation bound, not just the CSS dimensions.
  assert.throws(() => cardImageDimensions(4000.01, 3999.99, 1), /size limit/u);
});

function mountedCard() {
  const document = {
    defaultView: {
      getComputedStyle: (node) => ({ display: "block", opacity: "1", visibility: "visible", ...node.style }),
      requestAnimationFrame: (callback) => callback(),
    },
  };
  return {
    nodeType: 1, isConnected: true, ownerDocument: document, parentElement: null,
    getBoundingClientRect: () => ({ width: 600, height: 320 }),
  };
}

test("only mounted cards with a visible ancestor chain can be exported", async () => {
  for (const card of [null, {}, { ...mountedCard(), isConnected: false }]) {
    await assert.rejects(renderDataAppCardImage(card), /not mounted/u);
  }
  for (const hidden of [
    { hidden: true }, { style: { display: "none" } }, { style: { visibility: "hidden" } },
    { style: { opacity: "0" } }, { style: { contentVisibility: "hidden" } },
  ]) {
    const card = mountedCard();
    card.parentElement = { ...hidden, parentElement: null };
    await assert.rejects(renderDataAppCardImage(card), /hidden/u);
  }
  const empty = mountedCard();
  empty.getBoundingClientRect = () => ({ width: 0, height: 320 });
  await assert.rejects(renderDataAppCardImage(empty), /dimensions/u);
});

test("font readiness has a finite deadline and cannot allocate an image after timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const card = mountedCard();
  let resolveFonts;
  let allocations = 0;
  card.ownerDocument.fonts = { ready: new Promise((resolve) => { resolveFonts = resolve; }) };
  card.ownerDocument.createElement = () => { allocations += 1; throw new Error("Unexpected image allocation"); };
  const result = renderDataAppCardImage(card);
  const rejection = assert.rejects(result, /timed out/u);
  context.mock.timers.tick(10_000);
  await rejection;
  resolveFonts();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(allocations, 0);
});
