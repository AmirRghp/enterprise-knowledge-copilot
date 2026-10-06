import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { chartDataShape } from "../src/charting/chart-data-shape.js";
import { chartAnnotationFields } from "../src/charting/chart-annotations.js";
import { resolveChartSpec } from "../src/charting/chart-overrides.js";
import { reviewedSource, scopedMetricDefinitions } from "../src/source-provenance.js";

const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");
const start = inspector.indexOf("function componentEvidence(");
const end = inspector.indexOf("  const dateRange =", start);
assert.ok(start >= 0 && end > start, "The canonical inspector's provenance scope must be present");
const scope = `${inspector.slice(start, end)}\nreturn { chart, displayedFields, visibleDefinitions, source };\n}\nresult = componentEvidence({ component, query, rows, chartOverride, chartEdited });`;

// Exercise the canonical component's dependency-free scope calculation without a JSX loader.
function resolve({ component, query, rows = query.rows, chartEdited = false, chartOverrides }) {
  const sandbox = {
    chartDataShape,
    chartAnnotationFields,
    resolveChartSpec,
    reviewedSource,
    scopedMetricDefinitions,
    chartOverride: chartOverrides?.[component.id],
    component,
    query,
    rows,
    chartEdited,
  };
  runInNewContext(scope, sandbox);
  return sandbox.result;
}

const definition = (field, componentIds) => ({
  label: field,
  definition: `Reviewed ${field}.`,
  field,
  ...(componentIds ? { componentIds } : {}),
});
const visibleFields = (result) => result.visibleDefinitions.map(({ field }) => field);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

test("inline source scoping is an explicit opt-in forwarded through the shared sidebar", () => {
  assert.match(inspector, /export function SourceInspector\(\{[^}]*chartEdited = false/u);
  assert.match(inspector, /export function SourceSidebar\(\{[^}]*chartEdited = false/u);
  assert.match(inspector, /<SourceInspector\b[^>]*chartEdited=\{chartEdited\}/u);

  const component = { id: "trend", chart: { type: "line", x: "week", y: "active" } };
  const query = {
    rows: [{ week: "2026-08-10", active: 10, replacement: 2 }],
    source: {
      metricDefinitions: [
        definition("week"),
        definition("authored-methodology", ["trend"]),
        definition("replacement", ["other-component"]),
      ],
    },
  };
  assert.deepEqual(visibleFields(resolve({ component, query })), ["authored-methodology"]);
  assert.deepEqual(
    visibleFields(resolve({ component: { ...component, title: "A revised title" }, query })),
    ["authored-methodology"],
    "Copy-only changes preserve the original component-owned definitions",
  );

  const override = { type: "bar", x: "week", y: "replacement" };
  const chartOverrides = { trend: override };
  const durable = resolve({ component, query, chartOverrides });
  assert.deepEqual(durable.chart, override);
  assert.deepEqual([...durable.displayedFields], ["replacement"]);
  assert.deepEqual(visibleFields(durable), ["replacement"], "Durable override behavior remains unchanged by default");

  const explicit = resolve({ component, query, chartOverrides, chartEdited: true });
  assert.deepEqual(explicit.chart, override, "The durable shell's applied override remains authoritative");
  assert.deepEqual(visibleFields(explicit), ["week", "replacement"]);
});

test("edited long-form inline charts keep actual dimensions and reviewed metric dependencies", () => {
  const component = freeze({
    id: "usage-trend",
    queryId: "reviewed-usage",
    chart: { type: "line", x: "week", y: "wau", series: "country" },
  });
  const query = freeze({
    rows: [
      { week: "2026-08-03", country: "US", wau: 20, unrelated: 3 },
      { week: "2026-08-10", country: "CA", wau: null, unrelated: 4 },
    ],
    source: {
      label: "Approved usage snapshot",
      executedAt: "2026-08-18T12:00:00Z",
      filters: ["Product: ChatGPT"],
      evidenceFlow: [{ title: "Recorded snapshot", detail: "Reviewed weekly usage." }],
      metricDefinitions: [
        definition("week"),
        definition("country"),
        { ...definition("wau", ["usage-trend"]), dependencies: ["eligible-users"] },
        definition("eligible-users"),
        definition("unrelated", ["other-chart"]),
        definition("US"),
      ],
    },
  });
  const before = JSON.stringify({ component, query });
  const result = resolve({ component, query, chartEdited: true });

  assert.deepEqual([...result.displayedFields], ["wau", "week", "country"]);
  assert.deepEqual(visibleFields(result), ["week", "country", "wau", "eligible-users"]);
  assert.ok(!visibleFields(result).includes("US"), "Pivoted series labels are not raw field dependencies");
  assert.equal(result.source.sql, undefined);
  assert.deepEqual(result.source.links, []);
  assert.equal(result.source.executedAt, query.source.executedAt);
  assert.deepEqual(result.source.filters, query.source.filters);
  assert.deepEqual(result.source.evidenceFlow, query.source.evidenceFlow);
  assert.equal(
    JSON.stringify({ component, query }),
    before,
    "Source, rows, gaps, filters, and timestamps stay unchanged",
  );
});

test("cosmetic edits preserve a summary box plot's conceptual measure definition", () => {
  const originalChart = freeze({ type: "boxPlot", x: "segment", y: "latency" });
  const component = freeze({
    id: "latency-distribution",
    queryId: "reviewed-latency",
    chart: { ...originalChart, showLegend: false },
  });
  const summaryFields = ["minimum", "lowerQuartile", "median", "upperQuartile", "maximum"];
  const query = freeze({
    rows: [{ segment: "A", minimum: 1, lowerQuartile: 2, median: 3, upperQuartile: 4, maximum: 5 }],
    source: {
      label: "Reviewed latency summary",
      metricDefinitions: [
        definition("latency", [component.id]),
        definition("segment"),
        ...summaryFields.map((field) => definition(field)),
        definition("unrelated", ["other-chart"]),
      ],
    },
  });
  const before = JSON.stringify({ component, query });
  assert.ok(query.rows.every((row) => !Object.hasOwn(row, "latency")));
  assert.deepEqual(visibleFields(resolve({ component: { ...component, chart: originalChart }, query })), ["latency"]);

  const result = resolve({ component, query, chartEdited: true });
  assert.deepEqual([...result.displayedFields], ["latency", "segment", ...summaryFields]);
  assert.deepEqual(visibleFields(result), ["latency", "segment", ...summaryFields]);
  assert.ok(!visibleFields(result).includes("unrelated"));
  assert.equal(result.source.sql, undefined);
  assert.deepEqual(result.source.links, []);
  assert.equal(
    JSON.stringify({ component, query }),
    before,
    "A cosmetic edit cannot change reviewed summaries or source",
  );
});

test("edited inline provenance follows canonical special-chart dependencies", () => {
  const cases = [
    {
      chart: { type: "heatmap", x: "day", y: "count" },
      rows: [{ day: "Mon", hour: "09:00", count: 4, unrelated: 7 }],
      expected: ["day", "hour", "count"],
    },
    {
      chart: { type: "sankey", y: "count", stages: ["entry", "activation", "outcome"] },
      rows: [{ entry: "A", activation: "B", outcome: "C", count: 4, unrelated: 7 }],
      expected: ["entry", "activation", "outcome", "count"],
    },
    {
      chart: { type: "boxPlot", x: "segment", y: "median" },
      rows: [{ segment: "A", minimum: 1, lowerQuartile: 2, median: 3, upperQuartile: 4, maximum: 5, unrelated: 7 }],
      expected: ["segment", "minimum", "lowerQuartile", "median", "upperQuartile", "maximum"],
    },
    {
      chart: { type: "scatter", x: "growth", y: "active" },
      rows: [{ growth: 0.2, active: 10, country: "US", unrelated: 7 }],
      expected: ["growth", "active", "country"],
    },
    {
      chart: { type: "waterfall", x: "period", y: "amount" },
      rows: [{ period: "Start", amount: 10, isTotal: true, unrelated: 7 }],
      expected: ["period", "amount", "isTotal"],
    },
  ];

  for (const { chart, rows, expected } of cases) {
    const component = { id: "inline-chart", chart };
    const query = { rows, source: { metricDefinitions: Object.keys(rows[0]).map((field) => definition(field)) } };
    const result = resolve({ component, query, chartEdited: true });
    assert.deepEqual(
      [...result.displayedFields],
      [...new Set([chart.y, ...chartDataShape(chart, rows).rowFields].filter(Boolean))],
      chart.type,
    );
    assert.deepEqual(visibleFields(result), expected, `${chart.type} retains only its actual reviewed fields`);
  }
});
