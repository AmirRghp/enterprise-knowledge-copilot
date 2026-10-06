import assert from "node:assert/strict";
import test from "node:test";
import { chartExportAppearance, chartExportControls, chartExportFilename, chartExportMetadata, chartExportPresets, chartExportProvenance, chartExportSize, chartExportSpec } from "../src/chart-export.js";

test("export dimensions are finite and bounded, and presets retain their advertised ratios", () => {
  assert.deepEqual(chartExportSize(NaN, Infinity), { width: 1000, height: 600 });
  assert.deepEqual(chartExportSize(-1, 9000), { width: 320, height: 2400 });
  for (const preset of chartExportPresets.filter(item => item.width)) {
    assert.deepEqual(chartExportSize(preset.width, preset.height), { width: preset.width, height: preset.height });
  }
  assert.equal(chartExportFilename("Revenue / Q3?"), "Revenue-Q3.png");
});

test("destination presets retain useful image sizes without mock contexts", () => {
  assert.deepEqual(chartExportPresets.map(({ id }) => id), ["original", "slide", "document", "slack", "custom"]);
  assert.deepEqual(chartExportPresets.filter(item => item.width).map(({ id, width, height }) => [id, width, height]),
    [["slide", 920, 480], ["document", 720, 400], ["slack", 640, 400]]);
  assert.ok(chartExportPresets.find(item => item.id === "document").adaptiveHeight);
  assert.ok(chartExportPresets.find(item => item.id === "slack").adaptiveHeight);
});

test("export options preserve the reviewed spec, filters, annotations and values", () => {
  const chart = Object.freeze({ type: "line", x: "date", y: "value", startAtZero: false,
    annotations: [{ id: "launch", kind: "event", at: "2026-08-01", field: "launch", label: "Launch" }],
    showValues: false, showXAxisLabel: false });
  const next = chartExportSpec(chart, { axes: true, values: true });
  assert.equal(chart.showValues, false);
  assert.equal(next.showValues, true);
  assert.equal(next.showXAxisLabel, false, "export never invents an axis title that was intentionally omitted");
  assert.equal(next.annotations, chart.annotations);
  assert.equal(next.startAtZero, false);
  assert.equal(chartExportControls({ type: "funnel" }).axes, false);
  assert.equal(chartExportControls({ type: "bar", presentation: {} }).values, false);
});

test("provenance uses recorded source metadata without SQL, private file paths, or invented dates", () => {
  const text = chartExportProvenance({ source: { label: "Reviewed workbook", files: ["/private/input/workbook.xlsx"],
    sql: "SELECT confidential FROM internal", executedAt: "invalid", url: "https://example.com/source?token=secret" } },
    [{ label: "Plan", value: "Team" }]);
  assert.match(text, /Reviewed workbook/u);
  assert.match(text, /workbook.xlsx/u);
  assert.match(text, /Plan: Team/u);
  assert.doesNotMatch(text, /private|confidential|internal|secret|Captured/u);
  assert.equal(chartExportProvenance({}), "");
});


test("export appearance is scoped, preserves the current theme, and provides light and dark palettes", () => {
  assert.deepEqual(chartExportAppearance("original", "auto"), { "--surface": "#fff" });
  assert.deepEqual(chartExportAppearance("original", "auto", "dark"), {});
  const light = chartExportAppearance("codex-classic", "light");
  const dark = chartExportAppearance("codex-classic", "dark");
  assert.equal(light.colorScheme, "light");
  assert.equal(light["--surface"], "#fff");
  assert.equal(dark.colorScheme, "dark");
  assert.equal(light["--text"], "#1a1c1f");
  assert.equal(dark["--text"], "#fff");
  assert.notEqual(light["--surface"], dark["--surface"]);
  assert.deepEqual(chartExportAppearance("original", "dark"), dark);
  assert.deepEqual(chartExportAppearance("dark-pixel", "light"), light);
  assert.equal(chartExportAppearance("dark-pixel", "dark")["--surface"], "#181c18");
  assert.equal(chartExportAppearance("scientific-blue", "dark")["--surface"], "#172131");
});


test("source and filters are separate export fields without changing source semantics", () => {
  const metadata = chartExportMetadata({ source: { label: "Reviewed workbook", executedAt: "2026-08-01T00:00:00Z" } },
    [{ label: "Plan", value: "Team" }, { label: "Region", value: "all" }]);
  assert.deepEqual(metadata, { source: "Source: Reviewed workbook · Captured Aug 1, 2026", filters: "Plan: Team" });
  assert.deepEqual(chartExportMetadata({}), { source: "", filters: "" });
});

test("export dates use human-readable labels without changing days, ranges or selections", () => {
  const filters = Object.freeze([
    Object.freeze({ label: "Week of", value: "2026-08-17" }),
    Object.freeze({ label: "Date range", value: "2026-08-17..2026-08-23" }),
    Object.freeze({ label: "Selected days", value: Object.freeze(["2026-08-17", "2026-08-23"]) }),
    Object.freeze({ label: "Plan", value: "Team" }),
  ]);
  const metadata = chartExportMetadata({}, filters);
  assert.match(metadata.filters, /Week of: Aug 17, 2026/u);
  assert.match(metadata.filters, /Date range: Aug 17\s*–\s*23, 2026/u);
  assert.match(metadata.filters, /Selected days: Aug 17, 2026, Aug 23, 2026/u);
  assert.match(metadata.filters, /Plan: Team/u);
  assert.equal(filters[0].value, "2026-08-17");
  assert.match(chartExportMetadata({}, [{ label: "Period", value: "2025-12-29..2026-01-04" }]).filters,
    /Dec 29, 2025\s*–\s*Jan 4, 2026/u);
  assert.equal(chartExportMetadata({}, [{ label: "Date", value: "2026-02-30" }]).filters, "Date: 2026-02-30");
  assert.equal(chartExportMetadata({}, [{ label: "Period", value: "2026-08-23..2026-08-17" }]).filters,
    "Period: 2026-08-23..2026-08-17");
});
