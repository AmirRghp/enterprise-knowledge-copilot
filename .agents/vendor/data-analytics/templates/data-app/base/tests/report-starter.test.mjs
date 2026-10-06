import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { adoptionBrief } from "../src/content/report/adoption-brief.js";
import { scopedMetricDefinitions } from "../src/source-provenance.js";

const snapshot = JSON.parse(await readFile(new URL("../src/data.json", import.meta.url), "utf8"));
const aggregate = (id, week) => snapshot.queries[id].rows.filter((row) => row.week === week && row.segment === "all" && row.region === "all");
const [latest] = aggregate("usage_summary", "2026-07-27");
const [previous] = aggregate("usage_summary", "2026-07-20");
const drivers = aggregate("growth_drivers", latest.week);
const segments = snapshot.queries.segment_usage.rows.filter((row) => row.week === latest.week);
const accounts = snapshot.queries.account_health.rows;

test("the report chart hands the same latest-period rows to editing and rendering", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null }, appType: "custom",
    plugins: [{ name: "report-row-handoff", enforce: "pre", resolveId(source, importer) {
      if (source === "../../data-app-public.jsx" && importer?.endsWith("/content/report/ReportContent.jsx")) return "\0report-row-handoff";
    }, load(id) {
      if (id !== "\0report-row-handoff") return;
      return `export const ChartRenderer = () => null;
        export const DataComponent = () => null;
        export const MetricCard = () => null;
        export const ReportSection = () => null;
        export const RichNarrative = () => null;
        export const SortableItem = () => null;
        export const SortableRegion = () => null;
        const queries = ${JSON.stringify(snapshot.queries)};
        export const useDataApp = () => ({ snapshot: {status:'fixture'}, chartOverrides: {}, chartProps: () => ({}), visible: () => true,
          reviewedPeriodRows: id => queries[id].rows,
          reviewedAggregatePeriodRows: (id, options = {}) => queries[id].rows.filter(row => row.segment === 'all' && row.region === 'all'
            && (!options.period || row.week === (options.period === 'latest' ? '2026-07-27' : '2026-07-20'))) });`;
    } }],
  });
  try {
    const { ReportContent } = await server.ssrLoadModule("/src/content/report/ReportContent.jsx");
    const visit = node => [node, ...[].concat(node?.props?.children ?? []).flatMap(visit)].filter(Boolean);
    const chart = visit(ReportContent()).find(node => node.props?.kind === "chart" && node.props.queryId === "growth_drivers");
    assert.deepEqual(chart.props.displayRows, drivers);
    assert.equal(chart.props.displayRows, chart.props.sourceRows);
    assert.equal(chart.props.displayRows, chart.props.children.props.rows);
  } finally { await server.close(); }
});

test("report prose links remain recognizable without accent-colored text", async () => {
  const css = await readFile(new URL("../src/content/report/report.css", import.meta.url), "utf8");
  assert.match(css, /\.report-page \.report-content :is\(\.rich-narrative-content, \.report-rich-editable\) a \{\s*color: inherit;[\s\S]*?text-decoration-style: dotted;/u);
  assert.match(css, /a:focus-visible \{\s*outline: 2px solid currentColor;/u);
});

test("the short report answers performance, reconciles growth, and identifies a supported next investigation", () => {
  const result = adoptionBrief(latest, previous, drivers, segments, accounts);
  assert.equal(result.title, "Active accounts are above plan");
  assert.match(result.text, /12,480[\s\S]*\+510[\s\S]*480 above the 12,000/u);
  assert.equal(result.bridgeValid, true);
  assert.match(result.bridgeText, /455[\s\S]*220[\s\S]*165[\s\S]*\+510[\s\S]*24\.4%/u);
  assert.match(result.attention, /Search[\s\S]*88\.0%[\s\S]*180 of 395[\s\S]*45\.6%/u);
  assert.match(result.attention, /before deciding on an intervention/u);
  assert.equal(result.accounts.length, 2);
  assert.ok(result.accounts.every((row) => row.segment === "Search" && row.nextAction));
  assert.equal(result.conversionComparison, "+0.6 pp");
});

test("missing, mismatched, and duplicate evidence cannot create a driver explanation", () => {
  for (const missing of [undefined, null, NaN, "12480"]) {
    const result = adoptionBrief({ ...latest, activeUsers: missing }, previous, drivers, segments);
    assert.equal(result.title, "Active accounts are unavailable");
    assert.equal(result.bridgeValid, false);
    assert.equal(result.accountComparison, "");
  }
  assert.equal(adoptionBrief(latest, undefined, drivers, segments).bridgeValid, false);
  assert.equal(adoptionBrief(latest, previous, [...drivers, drivers[0]], segments).bridgeValid, false);
  assert.equal(adoptionBrief(latest, { ...previous, activeUsers: previous.activeUsers + 1 }, drivers, segments).bridgeValid, false);
  assert.equal(adoptionBrief({ ...latest, conversion: null }, previous).conversionComparison, "");
  assert.equal(adoptionBrief(latest, { ...previous, conversion: null }).conversionComparison, "");
  assert.match(adoptionBrief(latest, previous, drivers, [{...segments[0], retention:null}, ...segments.slice(1)]).attention, /unavailable/u);
  assert.match(adoptionBrief(latest, previous, drivers, [...segments, segments[0]]).attention, /unavailable/u);
  assert.match(adoptionBrief(latest, previous, drivers, segments.slice(0, 2)).attention, /coverage gap/u);
  assert.match(adoptionBrief(latest, previous, drivers, segments.map((row) => ({...row, retention: .9}))).attention, /share the lowest/u);
  assert.match(adoptionBrief(latest, previous, drivers, segments.map((row) => ({...row, retention: -0.1}))).attention, /unavailable/u);
  assert.match(adoptionBrief(latest, previous, drivers, segments.map((row) => ({...row, atRiskUsers: -1}))).attention, /unavailable/u);
});

test("the short report exposes definitions for its actual source-backed components", () => {
  const expected = {usage_summary: {"report-summary":"Active users", "report-metric-active":"Active users", "report-metric-conversion":"Conversion"},
    growth_drivers: {"report-trend":"Driver contribution", "report-drivers":"Net growth"},
    segment_usage: {"report-methods":"Retention"}, account_health: {"report-methods":"Risk tier"}};
  for (const [queryId, components] of Object.entries(expected)) for (const [id, label] of Object.entries(components)) {
    assert.ok(scopedMetricDefinitions(snapshot.queries[queryId].source.metricDefinitions, id).some((definition) => definition.label === label), `${queryId}/${id}/${label}`);
  }
});
