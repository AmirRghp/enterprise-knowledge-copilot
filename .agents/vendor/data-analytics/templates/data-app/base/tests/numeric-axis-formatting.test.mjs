import assert from "node:assert/strict";
import { minimumValue, maximumValue } from "../src/charting/chart-extrema.js";
import test from "node:test";

import {
  compact, formatChartValue, percentageAxisMode, comparisonSeriesBase, heatmapTextColor,
  displayValue,
  mergeNumericAxisTicks,
  numericAxisFormatter,
  wholePercentTicks,
  percentage,
  ratioMetric,
} from "../src/charting/chart-theme.js";

const labels = (values, options = {}) => values.map(numericAxisFormatter(values, { locale: "en-US", ...options }));

test("chart extrema inspect every value without an argument-count limit", () => {
  const values = Array.from({ length: 610_080 }, () => 2);
  values[0] = -3;
  values[values.length - 1] = 91;
  assert.equal(minimumValue(values), -3);
  assert.equal(maximumValue(values), 91);
  for (const input of [[], [0, -0], [-0], [Infinity, -Infinity], [1, NaN, 4]]) {
    assert.ok(Object.is(minimumValue(input), Math.min(...input)));
    assert.ok(Object.is(maximumValue(input), Math.max(...input)));
  }
  assert.equal(minimumValue([], 0), 0);
  assert.equal(maximumValue([], 1), 1);
});

test("axis formatting retains the final observation beyond the JS argument limit", () => {
  const values = Array.from({ length: 140_000 }, (_, index) => index + 1);
  values.push(1_000_000_000);
  const format = numericAxisFormatter(values, { locale: "en-US" });
  assert.equal(format(values.at(-1)), "1B");
  assert.notEqual(format(values.at(-2)), format(values.at(-3)));
});

test("explicit currency formats axes and hover values without mutating SVG labels", () => {
  assert.deepEqual(labels([-20000,0,20000],{currency:"USD"}),["-$20K","$0","$20K"]);
  assert.deepEqual(labels([91.1,91.2,91.3],{currency:"USD"}),["$91.1","$91.2","$91.3"]);
  assert.equal(formatChartValue(91.27,"costPerDelivery",{currency:"USD",decimals:2}),"$91.27");
  assert.equal(formatChartValue(null,"costPerDelivery",{currency:"USD"}),"—");
});

test("ordinary numeric axes keep grouped integers distinct across compact boundaries", () => {
  assert.deepEqual(labels([960, 980, 1000, 1020, 1040]), ["960", "980", "1,000", "1,020", "1,040"]);
  assert.deepEqual(labels([-1040, -1020, -1000, -980, -960]), ["-1,040", "-1,020", "-1,000", "-980", "-960"]);
  assert.deepEqual(labels([-0.0002, 0, 0.0002]), ["-0.0002", "0", "0.0002"]);
  assert.deepEqual(labels([-0.0002, 0]), ["-0.0002", "0"], "Rounded negative zero must not count as distinct");
});

test("large-value axes retain compact labels unless a narrow range needs exact grouped values", () => {
  assert.deepEqual(labels([960e6, 980e6, 1e9, 1.02e9, 1.04e9]), ["960M", "980M", "1B", "1.02B", "1.04B"]);
  assert.deepEqual(labels([1e9, 1e9 + 25, 1e9 + 50]), ["1,000,000,000", "1,000,000,025", "1,000,000,050"]);
  assert.deepEqual(labels([999950, 1e6, 1000050]), ["999,950", "1,000,000", "1,000,050"]);
  const extreme = labels([1e100, 1.0000000000000002e100, 1.0000000000000004e100]);
  assert.equal(new Set(extreme).size, 3);
  assert.ok(extreme.every((value) => value.includes("E")));
});

test("percentage axes increase precision without changing percentage scale or signs", () => {
  assert.deepEqual(labels([0.5001, 0.5002, 0.5003], { percent: true }), ["50.01%", "50.02%", "50.03%"]);
  assert.deepEqual(labels([0.0995, 0.1, 0.1005], { percent: true }), ["9.95%", "10%", "10.05%"]);
  assert.deepEqual(labels([-0.0002, 0, 0.0002], { percent: true }), ["-0.02%", "0%", "0.02%"]);
  assert.deepEqual(labels([0, 0.25, 0.5, 0.75, 1], { percent: true }), ["0%", "25%", "50%", "75%", "100%"]);
  assert.deepEqual(labels([0.225, 0.24, 0.255, 0.27, 0.285], { percent: true, percentDigits: 0 }),
    ["23%", "24%", "26%", "27%", "29%"]);
  assert.equal(ratioMetric("conversion", [0.0995, 0.1005]), true);
  assert.equal(ratioMetric("conversion", [-0.0002, 0.0002]), false, "Metric inference is unchanged");
  assert.equal(ratioMetric("currentGrowthRate", [-.024, .11, 1.2, null]), true);
  assert.equal(ratioMetric("growthChangePp", [-2.4, 11]), false, "Percentage points are not fractional rates");
  assert.equal(percentageAxisMode(["currentGrowthRate", "previousGrowthRate"], [
    { currentGrowthRate: -.024, previousGrowthRate: .174 },
  ]), true, "Signed growth comparisons keep a shared percentage unit");
});

test("whole percentage axes use distinct whole-number tick positions", () => {
  assert.deepEqual(wholePercentTicks([0.032, 0.064]), [0.04, 0.05, 0.06]);
  assert.deepEqual(wholePercentTicks([0.225, 0.285]), [0.24, 0.26, 0.28]);
  assert.deepEqual(wholePercentTicks([0, 1]), [0, 0.25, 0.5, 0.75, 1]);
});

test("unknown or degenerate tick sets use a non-collapsing fallback", () => {
  for (const values of [[], [1e9], [null, NaN, Infinity, -Infinity, -0, 0, 0]]) {
    const format = numericAxisFormatter(values, { locale: "en-US" });
    assert.notEqual(format(1e9), format(1e9 + 25));
    assert.equal(format(-0), "0");
    assert.equal(format(null), "");
    assert.equal(format(NaN), "");
    assert.equal(format(Infinity), "");
  }
  const tiny = labels([-1e-100, 0, 1e-100]);
  assert.equal(new Set(tiny).size, 3);
  assert.equal(tiny[1], "0");
});

test("axis tick history is monotone within a domain and resets for a different axis or mode", () => {
  const key = JSON.stringify(["y", 0, [960, 1040], false]);
  const initial = mergeNumericAxisTicks(null, key, [1040, 960, 1000, 980, 1020, 1000, NaN]);
  assert.deepEqual(initial.values, [960, 980, 1000, 1020, 1040]);
  assert.equal(
    mergeNumericAxisTicks(initial, key, [1040, 960]),
    initial,
    "Collision filtering must not reduce precision or churn formatter identity",
  );
  const expanded = mergeNumericAxisTicks(initial, key, [1010]);
  assert.deepEqual(expanded.values, [960, 980, 1000, 1010, 1020, 1040]);
  const otherAxis = mergeNumericAxisTicks(expanded, "weekly-change", [1e9, 1e9 + 25]);
  assert.deepEqual(otherAxis.values, [1e9, 1e9 + 25]);
  assert.deepEqual(initial.values, [960, 980, 1000, 1020, 1040], "History inputs are immutable");
});

test("legacy KPI and tooltip formatters are unchanged", () => {
  assert.equal(compact(1020), "1K");
  assert.equal(displayValue(1020), "1,020");
  assert.equal(percentage(0.5001), "+50%");
});

test("chart annotations preserve percentage and money units without converting unknowns to zero", () => {
  assert.equal(formatChartValue(88.888, "Retention (%)", { decimals: 0 }), "89%");
  assert.equal(formatChartValue(0.889, "retentionRate", { ratio: true, decimals: 0 }), "89%");
  for (const value of [null, undefined, "", NaN]) assert.equal(formatChartValue(value, "Retention (%)"), "—");
  assert.equal(formatChartValue(1200, "Revenue (USD)"), "$1,200");
  assert.equal(percentageAxisMode(["Gross margin (%)"], [{ "Gross margin (%)": 81 }]), "points");
  assert.equal(percentageAxisMode(["retentionRate"], [{ retentionRate: 0.8 }]), true);
  assert.equal(comparisonSeriesBase("Workspace · previous", ["Workspace", "Workspace · previous"]), "Workspace");
  assert.equal(comparisonSeriesBase("Previous revenue (USD)", ["Revenue (USD)"]), "Revenue (USD)");
  assert.equal(heatmapTextColor("rgb(15, 45, 95)"), "white");
  assert.equal(heatmapTextColor("rgb(225, 240, 255)"), "black");
});
