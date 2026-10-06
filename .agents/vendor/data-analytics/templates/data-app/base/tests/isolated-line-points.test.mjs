import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isolatedPointIndexes, pivot } from "../src/charting/chart-transforms.js";

const rows = (values) => values.map((value) => ({ value }));

test("isolated line points are exactly the one-point runs between missing observations", () => {
  for (const [values, expected] of [
    [[], []],
    [[120], [0]],
    [
      [120, null, 145],
      [0, 2],
    ],
    [[120, 130, 145], []],
    [[null, 120, 130, null, 145, null, 160, 170, null], [4]],
    [
      [120, null, 130, 140, null, 145],
      [0, 5],
    ],
    [[null, undefined, NaN, Infinity, -Infinity], []],
    [
      [0, null, -2, undefined, -3, -4, null, 0],
      [0, 2, 7],
    ],
  ]) {
    assert.deepEqual(isolatedPointIndexes(rows(values), "value"), expected, String(values));
  }
  assert.deepEqual(isolatedPointIndexes([{ value: 1 }, {}, { value: 2 }], "value"), [0, 2]);
});

test("isolated indexes follow the displayed post-zoom, post-pivot rows and each series", () => {
  const observations = [
    { week: "2026-01-01", series: "Active", value: 100 },
    { week: "2026-01-01", series: "Target", value: 120 },
    { week: "2026-01-08", series: "Active", value: null },
    { week: "2026-01-08", series: "Target", value: 130 },
    { week: "2026-01-15", series: "Active", value: 145 },
    { week: "2026-01-15", series: "Target", value: 140 },
    { week: "2026-01-22", series: "Active", value: 155 },
  ];
  const full = pivot(observations, "week", "series", "value");
  assert.deepEqual(isolatedPointIndexes(full, "Active"), [0]);
  assert.deepEqual(isolatedPointIndexes(full, "Target"), []);
  const zoomed = pivot(
    observations.filter((row) => row.week <= "2026-01-15"),
    "week",
    "series",
    "value",
  );
  assert.deepEqual(isolatedPointIndexes(zoomed, "Active"), [0, 2]);
  assert.deepEqual(isolatedPointIndexes(zoomed, "Target"), []);
  const singleWeek = pivot(
    observations.filter((row) => row.week === "2026-01-15"),
    "week",
    "series",
    "value",
  );
  assert.deepEqual(isolatedPointIndexes(singleWeek, "Active"), [0]);
});

test("the canonical line renderer uses filtered native dots without changing hover or sparklines", async () => {
  const renderer = await readFile(new URL("../src/charting/ChartRenderer.jsx", import.meta.url), "utf8");
  assert.match(renderer, /new Map\(\s*type === "line" \? lineFields\.map/u);
  assert.match(renderer, /new Set\(isolatedPointIndexes\(data, field\)\)/u);
  assert.match(
    renderer,
    /function IsolatedLineDot\(\{ indexes, index, cx, cy, stroke, fill, strokeWidth, strokeOpacity, className \}\)/u,
  );
  assert.match(renderer, /if \(!indexes\.has\(index\)\) return null/u);
  assert.match(renderer, /<Dot\s+cx=\{cx\}\s+cy=\{cy\}\s+r=\{3\}\s+stroke=\{stroke\}\s+fill=\{stroke \?\? fill\}/u);
  assert.match(renderer, /className=\{\["recharts-line-dot", className\]/u);
  assert.match(renderer, /data-isolated-point="true"/u);
  assert.match(renderer, /connectNulls=\{false\}/u);
  assert.match(renderer, /activeDot=\{\{ r: 5, strokeWidth: 3, stroke: "var\(--surface\)" \}\}/u);
  assert.match(renderer, /<IsolatedLineDot indexes=\{isolatedPoints\.get\(field\)\} \/> : false/u);
});
