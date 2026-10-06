import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyze, createDeliveryDiagnostic, reproduceDeliveryDiagnostic } from "../examples/reports/delivery-diagnostic/diagnostic.mjs";
import { actions, authoredChart, chartSpecs, supportsPickupContext } from "../examples/reports/delivery-diagnostic/report-model.mjs";
import { resolveChartAnnotations } from "../src/charting/chart-annotations.js";

const root = new URL("../examples/reports/delivery-diagnostic/", import.meta.url);
const input = readFileSync(new URL("evidence.json", root), "utf8");
const packet = JSON.parse(input);
const { snapshot, results } = createDeliveryDiagnostic(input, "2026-08-20T12:00:00Z");

test("synthetic observations reconcile all cuts, percentages, and the volume-adjusted bridge", () => {
  assert.equal(packet.fictional, true);
  assert.equal(snapshot.status, "fixture");
  assert.equal(results.inputSha256, createHash("sha256").update(input).digest("hex"));
  assert.deepEqual([results.beforeOrders, results.orders, results.beforeLate, results.late], [16000, 20000, 640, 1960]);
  assert.equal(results.baselineRate, 0.04);
  assert.equal(results.currentRate, 0.098);
  assert.equal(results.volumeExtra, 160);
  assert.equal(results.deterioration, 1160);
  assert.deepEqual(results.stages.map((row) => row.extraLateOrders), [1020, 140]);
  assert.equal(snapshot.queries.bridge.rows.reduce((sum, row) => sum + row.extraLateOrders, 0), 1320);
  assert.equal(snapshot.queries.timing.rows[1].currentRate, 0.252);
  assert.equal(results.quoteCost, 9000);
  assert.equal(snapshot.queries.economics.rows[0].accepted, false);
  assert.deepEqual(snapshot.queries.research.rows, packet.records);
});

test("inconsistent, negative, non-synthetic, and duplicate evidence fails instead of producing a report", () => {
  for (const revise of [
    (copy) => { copy.fictional = false; },
    (copy) => { copy.warehouses[0].beforeOrders += 1; },
    (copy) => { copy.timing[0].currentLate += 1; },
    (copy) => { copy.weekly[0].lateOrders = -1; },
    (copy) => { copy.weekly[1].week = copy.weekly[0].week; },
    (copy) => { copy.stages[0].beforeLate = -1; copy.stages[1].beforeLate = 641; },
  ]) {
    const copy = structuredClone(packet);
    revise(copy);
    assert.throws(() => analyze(copy));
  }
});

test("timeline annotation adds verified context without attributing an aggregate bar to one warehouse", () => {
  assert.equal(supportsPickupContext(packet.records), true);
  for (const [kind, queryId] of [["trend", "weekly"]]) {
    const query = snapshot.queries[queryId];
    const spec = authoredChart(kind, query.rows, packet.records);
    assert.equal(resolveChartAnnotations(spec, query.rows).length, 1);
    assert.match(JSON.stringify(query.source), /OPS-17/u);
    assert.match(JSON.stringify(query.source), /16:45/u);
    assert.match(JSON.stringify(query.source), /causal/u);
    assert.ok(query.source.files.includes("src/content/report/evidence/evidence.json"));
    assert.equal(query.source.sql, undefined);
  }
  assert.equal(resolveChartAnnotations(chartSpecs.bridge, snapshot.queries.bridge.rows).length, 0, "A warehouse-specific event must not imply it explains the all-warehouse count");
  assert.equal(chartSpecs.trend.annotations[0].kind, "event", "The schedule record supplies timing, not a causal estimate");
});

test("missing, conflicting, or changed records suppress generated notes including saved defaults", () => {
  const invalidRecords = [[], [...packet.records, packet.records[0]],
    packet.records.map((record) => record.id === "OPS-17" ? { ...record, text: "Schedule change withdrawn." } : record)];
  for (const records of invalidRecords) {
    for (const [kind, queryId] of [["trend", "weekly"]]) {
      const rows = snapshot.queries[queryId].rows;
      assert.deepEqual(authoredChart(kind, rows, records).annotations, []);
      assert.deepEqual(authoredChart(kind, rows, records, { ...chartSpecs[kind] }).annotations, []);
    }
    const changed = createDeliveryDiagnostic(JSON.stringify({ ...packet, records })).snapshot;
    assert.ok(changed.queries.weekly.rows.every((row) => row.context === ""));
  }
});

test("custom annotation edits, explicit removal, and saved chart presentation remain intact", () => {
  for (const [kind, queryId] of [["trend", "weekly"]]) {
    const rows = snapshot.queries[queryId].rows;
    const edited = { ...chartSpecs[kind], colors: { custom: "#123456" },
      annotations: [{ ...chartSpecs[kind].annotations[0], label: "Author-reviewed context" }] };
    const original = structuredClone(edited);
    assert.deepEqual(authoredChart(kind, rows, [], edited), edited);
    assert.deepEqual(edited, original);
    assert.deepEqual(authoredChart(kind, rows, packet.records, { ...edited, annotations: [] }).annotations, []);
  }
});

test("fresh reports get fresh IDs while reproduction preserves title, identity, dates, and publication", () => {
  assert.notEqual(snapshot.id, createDeliveryDiagnostic(input).snapshot.id);
  const existing = { ...snapshot, title: "Revised title", report: { asOf: "2026-08-19", audience: "technical" },
    publication: { destination: "existing-private-site" }, customMetadata: { preserve: true } };
  assert.deepEqual(reproduceDeliveryDiagnostic(existing, input).snapshot, existing);
  const { id: _, ...legacy } = existing;
  const migrated = reproduceDeliveryDiagnostic(legacy, input).snapshot;
  assert.ok(migrated.id);
  assert.equal(migrated.legacyPresentationTitle, legacy.title);
});

test("the compact reference inherits shared cards, disclosure, task links, and 300px chart content", () => {
  const report = readFileSync(new URL("ReportContent.jsx", root), "utf8");
  const build = readFileSync(new URL("build.mjs", root), "utf8");
  for (const pattern of [/ReportDisclosure/u, /ReportTaskLink/u, /height=\{300\}/u,
    /className="report-section"/u, /className="report-recommendations"/u,
    /sourceRowsByQuery/u, /chartOverrides\[id\]/u, /chartProps\(id\)/u,
    /visible\(id\)/u, /setAppTitle/u, /Synthetic research case/u]) assert.match(report, pattern);
  assert.doesNotMatch(report, /reportFollowUpHref|<a\b|<style\b/u);
  assert.doesNotMatch(build, /report\.css|theme\.css|integrity:update|integrity:authorize/u);
  assert.match(build, /Refusing to overwrite an existing project/u);
  assert.match(build, /buildDeliveryDiagnostic/u);
  assert.equal(actions.length, 2);
  for (const action of actions) {
    assert.ok(action.deliverable.length <= 160);
    assert.ok(action.queries.every((queryId) => snapshot.queries[queryId]));
    assert.match(action.text, /^- \*\*/u);
  }
});
