import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { operatingStoryAnnotations, withOperatingStory } from "../examples/reports/adoption-retention/annotation-stories.mjs";

import { periodComparison } from "../src/charting/chart-theme.js";
import { reviewedNarrativeQueries, reviewedSource } from "../src/source-provenance.js";
import { reportAggregateRows, reportReviewedRows } from "../src/use-data-app.js";

const example = new URL("../examples/reports/adoption-retention/", import.meta.url);
const raw = await readFile(new URL("data.json", example));
const snapshot = JSON.parse(raw);
const { queries, filters } = snapshot;
const aggregate = (id, options) => reportAggregateRows(queries[id].rows, filters, {}, id, options);

test("the substantial example preserves its exact published reviewed fixture and five sources", () => {
  assert.equal(createHash("sha256").update(raw).digest("hex"),
    "5bd93c29f97b2152a90004e1f6af29f7fb7a10ef1fd5772d286ca02e5a5f82a6");
  assert.deepEqual(Object.keys(queries), ["usage_summary", "segment_usage", "growth_drivers", "forecast_outlook", "account_health"]);
  for (const query of Object.values(queries)) {
    assert.ok(query.rows.length > 0);
    assert.equal(reviewedSource(query.source).sql, query.source.sql, "Source inspection retains exact reviewed SQL");
    assert.deepEqual(reviewedSource(query.source).tables, query.source.tables);
    assert.ok(reviewedSource(query.source).definitions.length > 0);
  }
});

test("the showcase uses six compatible periods and the exact 0.6 percentage-point comparison", () => {
  const history = aggregate("usage_summary", { period: "history" });
  const [latest] = aggregate("usage_summary", { period: "latest" });
  const [previous] = aggregate("usage_summary", { period: "previous", currentPeriod: latest.week });
  assert.equal(history.length, 6);
  assert.ok(history.every((row) => row.segment === "all" && row.region === "all"));
  assert.equal(((latest.conversion - previous.conversion) * 100).toFixed(1), "0.6");
  assert.match(periodComparison(latest.conversion, previous.conversion, { percentagePoints: true }).comparison, /\+0\.6 pp/u);
  assert.deepEqual(aggregate("usage_summary", { period: "previous", currentPeriod: history[0].week }), []);
});

test("forecast values stay distinct from observations and scoped narrative rows stay reviewed", () => {
  const outlook = aggregate("forecast_outlook", { period: "history" });
  assert.ok(outlook.length > 0);
  assert.ok(outlook.every((row) => Number.isFinite(row.actualUsers) && Number.isFinite(row.projectedUsers)
    && Number.isFinite(row.targetUsers)));
  assert.ok(outlook.some((row) => row.actualUsers !== row.projectedUsers));
  const [latest] = aggregate("usage_summary", { period: "latest" });
  const scoped = {
    usage_summary: aggregate("usage_summary", { period: "history" }),
    segment_usage: reportReviewedRows(queries.segment_usage.rows, filters, {}, "segment_usage", {
      period: "latest", currentPeriod: latest.week, breakdown: ["segment"],
    }),
    growth_drivers: reportReviewedRows(queries.growth_drivers.rows, filters, {}, "growth_drivers", {
      period: "latest", currentPeriod: latest.week, breakdown: ["driver"],
    }),
    forecast_outlook: outlook,
    account_health: reportReviewedRows(queries.account_health.rows, filters, {}, "account_health", {
      period: "latest", currentPeriod: latest.week,
    }),
  };
  assert.equal(reviewedNarrativeQueries({ id: "showcase", kind: "narrative", queryId: "usage_summary",
    queryIds: Object.keys(scoped), sourceRowsByQuery: scoped }, queries).length, 5);
});

test("the example derives its operating implications from reconciled contributions and risk concentration", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null }, appType: "custom",
    plugins: [{ name: "example-public-api", enforce: "pre", resolveId(source, importer) {
      if (source === "../../data-app-public.jsx" && importer?.endsWith("/examples/reports/adoption-retention/ReportContent.jsx")) {
        return fileURLToPath(new URL("../src/data-app-public.jsx", import.meta.url));
      }
    } }],
  });
  try {
    const { adoptionEvidence } = await server.ssrLoadModule("/examples/reports/adoption-retention/ReportContent.jsx");
    const [latest] = aggregate("usage_summary", { period: "latest" });
    const [previous] = aggregate("usage_summary", { period: "previous", currentPeriod: latest.week });
    const input = { latest, previous,
      segmentRows: reportReviewedRows(queries.segment_usage.rows, filters, {}, "segment_usage", {
        period: "latest", currentPeriod: latest.week, breakdown: ["segment"],
      }),
      growthDriverRows: reportReviewedRows(queries.growth_drivers.rows, filters, {}, "growth_drivers", {
        period: "latest", currentPeriod: latest.week, breakdown: ["driver"],
      }),
      forecastRows: aggregate("forecast_outlook", { period: "history" }),
      accountRows: reportReviewedRows(queries.account_health.rows, filters, {}, "account_health", {
        period: "latest", currentPeriod: latest.week,
      }),
    };
    const result = adoptionEvidence(input);
    assert.deepEqual([result.additions, result.losses, result.net, result.reconciles], [675, 165, 510, true]);
    assert.equal((result.lossShare * 100).toFixed(1), "24.4");
    assert.deepEqual([result.segmentTotal, result.segmentRisk, result.lowestRetention.segment], [12480, 395, "Search"]);
    assert.equal((result.lowestRetention.activeUsers / result.segmentTotal * 100).toFixed(1), "33.7");
    assert.equal((result.lowestRetention.atRiskUsers / result.segmentRisk * 100).toFixed(1), "45.6");
    assert.deepEqual([result.elevatedRisk, result.focusRisk, result.forecastLift, result.realizedForecastError], [175, 135, 580, 0]);
    assert.deepEqual(result.focusAccounts.map(({ account }) => account), ["Meridian Signals", "Lighthouse Query"]);
    assert.equal(result.segmentCoverage, true);
    assert.equal(result.reconciliationNote, "The account bridge reconciles.");
    const unreconciled = adoptionEvidence({ ...input, previous: { ...previous, activeUsers: 1 } });
    assert.equal(unreconciled.reconciles, false);
    assert.match(unreconciled.reconciliationNote, /does not reconcile/u);
    assert.equal(adoptionEvidence({ ...input, forecastRows: [] }).forecastLift, undefined);
    const replaceSearch = (changes) => input.segmentRows.map((row) => row.segment === "Search" ? { ...row, ...changes } : row);
    for (const segmentRows of [input.segmentRows.slice(1), replaceSearch({ activeUsers: null }),
      replaceSearch({ atRiskUsers: null }), replaceSearch({ retention: null }),
      replaceSearch({ retention: 1.2 }), replaceSearch({ atRiskUsers: 5000 }),
      [...input.segmentRows, input.segmentRows[0]]]) {
      const incomplete = adoptionEvidence({ ...input, segmentRows });
      assert.equal(incomplete.segmentCoverage, false);
      assert.equal(incomplete.lowestRetention, undefined, "Incomplete or invalid segments cannot establish a priority");
      assert.deepEqual(incomplete.focusAccounts, []);
    }
    const missingRisk = adoptionEvidence({ ...input, segmentRows: replaceSearch({ atRiskUsers: null }) });
    assert.equal(missingRisk.segmentRisk, undefined, "Missing risk values are not zero");
    const tied = adoptionEvidence({ ...input, segmentRows: replaceSearch({ retention: .91 }) });
    assert.equal(tied.segmentCoverage, true);
    assert.equal(tied.retentionTied, true);
    assert.equal(tied.lowestRetention, undefined, "Tied retention does not justify selecting the first row");
    assert.deepEqual(tied.focusAccounts, []);
  } finally {
    await server.close();
  }
});

test("the example consumes current public components and labels modeled outcomes honestly", async () => {
  const report = await readFile(new URL("ReportContent.jsx", example), "utf8");
  const build = await readFile(new URL("build.mjs", example), "utf8");
  assert.match(report, /DataTable, MetricCard, percentage/u);
  assert.doesNotMatch(report, /content\/shared\/MetricCard|\.\.\/shared\/MetricCard|reportFilterVisible/u);
  assert.match(report, /technical \? "Technical summary" : "Executive summary"/u);
  assert.match(report, /modeled scenario, not an observed future outcome/u);
  assert.match(report, /target belongs to the current reporting week/u);
  assert.match(report, /does not estimate the probability of churn/u);
  assert.match(report, /\$\{evidence\.reconciliationNote\}/u);
  assert.match(report, /!evidence\.segmentCoverage/u);
  assert.match(report, /fields: \["actualUsers", "projectedUsers", "targetUsers"\]/u);
  assert.match(build, /showTables: args\.includes\("--technical"\)/u);
  assert.match(report, /<DataTable rows=\{accountDisplayRows\} caption="Reviewed account-level evidence"/u);
  for (const id of ["report-conversion-trend", "report-growth-driver-bridge", "report-segment-retention",
    "report-forecast-outlook", "report-account-risk"]) assert.ok(report.includes(id));
});

const history = queries.usage_summary.rows.filter((row) => row.segment === "all");
const segments = queries.segment_usage.rows.filter((row) => row.week === history.at(-1).week);

test("visible operating comparisons do not generate annotations without additional context", () => {
  const original = structuredClone({ history, segments });
  assert.deepEqual(operatingStoryAnnotations(history, segments), { growth: [], activation: [], retention: [] });
  assert.deepEqual(operatingStoryAnnotations([], []), { growth: [], activation: [], retention: [] });
  assert.deepEqual({ history, segments }, original);
});

test("retiring operating labels preserves custom annotations, explicit deletions, and saved chart edits", () => {
  for (const [id, label] of [
    ["latest-above-target", "Growth keeps pulling ahead of plan"],
    ["latest-activation", "Activation improves week after week"],
    ["search-retention-tension", "Search grows, but retention trails"],
  ]) {
    const retired = { id, label, kind: "point", field: "activeUsers", at: history.at(-1).week };
    const custom = { ...retired, label: "An author's separately sourced context" };
    const unrelated = { ...retired, id: "user-note" };
    const saved = { type: "area", x: "week", y: "activeUsers", colors: { activeUsers: "#123456" },
      hiddenSeries: ["targetUsers"], annotations: [retired, custom, unrelated] };
    const original = structuredClone(saved);
    assert.deepEqual(withOperatingStory({}, saved, [], id), { ...saved, annotations: [custom, unrelated] });
    assert.deepEqual(saved, original, "Saved presentation objects are not mutated");
    const empty = { ...saved, annotations: [] };
    assert.deepEqual(withOperatingStory({}, empty, [], id), empty);
    assert.deepEqual(withOperatingStory(saved, undefined, [], id).annotations, [custom, unrelated],
      "Authored custom notes are preserved too");
    assert.deepEqual(withOperatingStory({}, { type: "line" }, [], id), { type: "line", annotations: [] });
  }
});
