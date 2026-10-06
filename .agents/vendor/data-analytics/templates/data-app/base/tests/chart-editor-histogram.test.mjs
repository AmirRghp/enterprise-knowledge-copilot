import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { chartDataShape } from "../src/charting/chart-data-shape.js";
import { changeChartEditorSpec } from "../src/charting/chart-editor-state.js";
import { histogram } from "../src/charting/chart-transforms.js";
import { displayValue, ratioMetric } from "../src/charting/chart-theme.js";

const rows = Object.freeze([82, 95, 102, 110, 111, 135, 180, 260].map((latencyMs) => Object.freeze({ latencyMs })));
const original = { type: "histogram", y: "latencyMs", stackable: false };

test("histogram title edits retain all eight raw observations and canonical count bins", () => {
  const expected = [
    { start: 0, count: 2, end: 100 },
    { start: 100, count: 5, end: 200 },
    { start: 200, count: 1, end: 300 },
  ];
  assert.deepEqual(histogram(rows, original.y), expected);
  assert.deepEqual(chartDataShape(original, rows).requiredRowFields, ["latencyMs"]);

  const xEdited = changeChartEditorSpec(original, "xLabel", "Latency (ms)");
  const edited = changeChartEditorSpec(xEdited, "yLabel", "Requests");
  assert.equal(edited.xLabel, "Latency (ms)");
  assert.equal(edited.yLabel, "Requests");
  assert.equal(edited.showXAxisLabel, true);
  assert.equal(edited.showYAxisLabel, true);

  const hidden = changeChartEditorSpec(changeChartEditorSpec(edited, "xLabel", ""), "yLabel", "");
  assert.equal(hidden.showXAxisLabel, false);
  assert.equal(hidden.showYAxisLabel, false);
  for (const spec of [original, edited, hidden, { ...edited, startAtZero: false }]) {
    assert.equal(spec.type, "histogram");
    assert.equal(spec.y, "latencyMs");
    assert.equal(Object.hasOwn(spec, "x"), false);
    assert.deepEqual(chartDataShape(spec, rows).rowFields, ["latencyMs"]);
    assert.deepEqual(histogram(rows, spec.y), expected);
    assert.equal(
      histogram(rows, spec.y).reduce((total, bucket) => total + bucket.count, 0),
      rows.length,
    );
  }
});

test("the canonical histogram renders editable measurement/count titles and a fixed count axis", async () => {
  const renderer = await readFile(new URL("../src/charting/ChartRenderer.jsx", import.meta.url), "utf8");
  const explorer = await readFile(new URL("../src/components/ChartExplorer.jsx", import.meta.url), "utf8");
  const histogramBranch = renderer.slice(
    renderer.indexOf('else if (cartesianEnabled && type === "histogram")'),
    renderer.indexOf('else if (categoricalEnabled && type === "heatmap")'),
  );

  assert.match(renderer, /const xTitle = spec\.xLabel \?\? label\(type === "histogram" \? y : x\)/u);
  assert.match(renderer, /const yTitle = spec\.yLabel \?\? \(type === "histogram" \? "Observations"/u);
  assert.match(renderer, /axisTitleVisibility\(spec, separateAxes\)/u);
  assert.match(renderer, /const hasYAxisTitle = showYAxisTitle && Boolean\(yTitle\)/u);
  assert.match(renderer, /horizontal \|\| !hasYAxisTitle\s*\? undefined\s*:\s*\{\s*value: yTitle/u);
  assert.match(
    renderer,
    /xLabel=\{\s*\["sparkline", "pie", "funnel", "sankey"\]\.includes\(type\) \|\| !showXAxisTitle\s*\? ""\s*:\s*xTitle\s*\}/u,
  );
  assert.match(histogramBranch, /histogram\(rows, y\)/u);
  assert.match(
    histogramBranch,
    /React\.cloneElement\(yAxis, \{ domain: \[0, "auto"\], allowDecimals: false, percent: false,\s*percentDigits: undefined, currency: undefined, ticks: undefined \}\)/u,
    "Histogram heights are zero-based integer counts, even for a ratio-valued measurement",
  );
  assert.match(histogramBranch, /dataKey="count"/u);
  assert.doesNotMatch(histogramBranch, /startAtZero/u);

  const hiddenAxes = explorer.match(/const chartsWithoutAxes = new Set\(\[([^\]]*)\]\)/u)?.[1];
  assert.equal(typeof hiddenAxes, "string");
  assert.doesNotMatch(hiddenAxes, /histogram/u);
  assert.match(
    explorer,
    /aria-label="X axis title"\s+value=\{spec\.xLabel \?\? \(spec\.type === "histogram" && spec\.showXAxisLabel !== false \? humanize\(spec\.y\) : ""\)\}/u,
  );
  assert.match(
    explorer,
    /aria-label="Y axis title"\s+value=\{spec\.yLabel \?\? \(spec\.type === "histogram" && spec\.showYAxisLabel === true \? "Observations" : ""\)\}/u,
  );
  assert.match(
    explorer,
    /!\["heatmap", "histogram"\]\.includes\(spec\.type\)\s*&&\s*\(\s*<ChartSwitch\s+label="Start axis at zero"/u,
  );
});

test("histogram tooltips format bucket counts independently of the measured field's ratio units", async () => {
  const rateRows = [{ conversionRate: 0.1 }, { conversionRate: 0.2 }];
  assert.equal(
    ratioMetric(
      "conversionRate",
      rateRows.map((row) => row.conversionRate),
    ),
    true,
  );
  const buckets = histogram(rateRows, "conversionRate");
  assert.deepEqual(buckets.map(({ count }) => count), [1, 1]);
  assert.deepEqual(
    buckets.map((bucket) => displayValue(bucket.count)),
    ["1", "1"],
  );

  const renderer = await readFile(new URL("../src/charting/ChartRenderer.jsx", import.meta.url), "utf8");
  assert.match(
    renderer,
    /formatValue=\{type === "histogram" \? displayValue : formatTooltipValue\}/u,
    "Only histogram tooltips bypass the measured field's percent formatter",
  );
});
