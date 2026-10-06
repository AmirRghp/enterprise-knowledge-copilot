import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { analyzeProductGrowth, createReportSnapshot } from "../examples/reports/activation-diagnostics/analysis.mjs";
import { shortNumber } from "../examples/reports/short-number.mjs";
import { reviewedNarrativeQueries, reviewedSource, scopedMetricDefinitions } from "../src/source-provenance.js";

const input = await readFile(new URL("../../../../assets/demo-product-growth.csv", import.meta.url), "utf8");
const results = analyzeProductGrowth(input);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test("the methods example keeps the exact bundled sample and validates its observed grid", async () => {
  assert.equal(results.inputSha256, "7a417139cf77ba194f8d328db17ca08355edab76f1aef3bd8ef0e75863a6c0f5");
  assert.deepEqual(results.checks, { rowCount: 32, weekCount: 8, channelCount: 4, missingCells: 0,
    duplicateKeys: 0, missingWeekChannels: 0, invalidNumericCells: 0, funnelViolations: 0, nonWeeklyGaps: 0 });
  assert.throws(() => analyzeProductGrowth(input.replace(",248,78,", ",999,78,")), /funnelViolations/u);
  assert.throws(() => analyzeProductGrowth(input.split("\n").filter((_, index) => index !== 1).join("\n")), /missingWeekChannels/u);
});

test("weighted rates and both decomposition conventions reproduce the actual generated analysis", () => {
  assert.equal(results.before.activationRate, 2846 / 4590);
  assert.equal(results.after.activationRate, 3330 / 5599);
  close(results.changePp, (3330 / 5599 - 2846 / 4590) * 100);
  close(results.withinPp + results.mixPp, results.changePp);
  close(results.baselineFixedWithinPp + results.laterRateMixPp, results.changePp);
  const paid = results.channelRows.find((row) => row.channel === "Paid Search");
  assert.equal(paid.beforeRate, 877 / 1537);
  assert.equal(paid.afterRate, 897 / 1980);
  assert.ok(Math.abs(results.withinPp) > Math.abs(results.mixPp));
  assert.ok(results.endpoints.find((row) => row.channel === "Paid Search").changePp < paid.changePp);
});

test("report shorthand is stable and promotes rounded values to the next unit", () => {
  assert.equal(shortNumber(24_538), "24.5k");
  assert.equal(shortNumber(999_950), "1M");
  assert.equal(shortNumber(1_200_000), "1.2M");
  assert.equal(shortNumber(999_999_999), "1B");
  assert.equal(shortNumber(2_500_000_000), "2.5B");
  assert.equal(shortNumber(675), "675");
});

test("derived evidence remains independently inspectable and component scoped", () => {
  const snapshot = createReportSnapshot(results, "2026-08-18T00:00:00Z");
  assert.deepEqual(snapshot.queries.raw_growth.rows, results.raw);
  assert.deepEqual(reviewedNarrativeQueries({ id: "assessment-result", kind: "narrative", queryId: "period_totals",
    queryIds: ["channel_comparison"] }, snapshot.queries), ["period_totals", "channel_comparison"]);
  const definitions = reviewedSource(snapshot.queries.channel_comparison.source).definitions;
  assert.ok(scopedMetricDefinitions(definitions, "mix-table").some(({ label }) => label === "Mix contribution"));
  assert.ok(scopedMetricDefinitions(definitions, "channel-table").every(({ label }) => label !== "Mix contribution"));
  assert.ok(Object.values(snapshot.queries).every(({ source }) => !source.sql && source.files.length === 2
    && reviewedSource(source).evidenceFlow.length === 3));
  const flow = reviewedSource(snapshot.queries.channel_comparison.source).evidenceFlow;
  assert.match(flow[0].detail, /32 synthetic rows; SHA-256/u);
  assert.match(flow[1].detail, /symmetric within\/mix contributions/u);
  assert.equal(flow[2].title, "Reviewed query rows");
});
