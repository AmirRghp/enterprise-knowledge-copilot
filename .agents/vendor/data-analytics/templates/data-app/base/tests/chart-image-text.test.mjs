import assert from "node:assert/strict";
import test from "node:test";
import { chartImageResolution, wrapChartImageText } from "../src/chart-image.js";

test("PNG pixels use a consistent 3x density for each destination size", () => {
  for (const [width, height] of [[920, 480], [720, 400], [640, 400], [320, 240]]) {
    assert.deepEqual(chartImageResolution(width, height), { width: width * 3, height: height * 3, scale: 3 });
  }
  assert.deepEqual(chartImageResolution(640, 400, 1), { width: 640, height: 400, scale: 1 });
});

test("large exports stay within browser canvas limits while preserving their aspect ratio", () => {
  for (const [width, height] of [[2400, 2400], [2400, 800], [720, 2400], [1366, 400]]) {
    const result = chartImageResolution(width, height);
    assert.ok(result.width <= 4096 && result.height <= 4096);
    assert.ok(result.scale <= 3);
    assert.ok(Math.abs(result.width / result.height - width / height) < .005);
  }
  assert.deepEqual(chartImageResolution(2400, 2400), { width: 4096, height: 4096, scale: 4096 / 2400 });
  for (const invalid of [0, -1, NaN, Infinity, "640"]) {
    assert.throws(() => chartImageResolution(invalid, 400));
    assert.throws(() => chartImageResolution(640, invalid));
    assert.throws(() => chartImageResolution(640, 400, invalid));
  }
});

test("copied chart notes wrap long unbroken labels without clipping", () => {
  const context = { measureText: (text) => ({ width: [...text].length * 8 }) };
  for (const text of ["A".repeat(160), "Evidence " + "界".repeat(200), "Short readable text"]) {
    const lines = wrapChartImageText(context, text, 120);
    assert.ok(lines.every((line) => context.measureText(line).width <= 120));
    assert.equal(lines.join("").replace(/\s/gu, ""), text.replace(/\s/gu, ""));
  }
});
