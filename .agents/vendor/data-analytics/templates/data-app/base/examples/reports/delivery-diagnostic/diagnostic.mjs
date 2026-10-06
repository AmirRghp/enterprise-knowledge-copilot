import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reportQuestion, summarize, supportsPickupContext } from "./report-model.mjs";

const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

export function analyze(packet) {
  assert.equal(packet.fictional, true, "This reference must identify its synthetic evidence");
  assert.equal(packet.current.start, "2026-07-20");
  assert.equal(new Set(packet.weekly.map((row) => row.week)).size, 8);
  for (const row of packet.weekly) {
    assert.match(row.week, /^2026-\d{2}-\d{2}$/u);
    assert.ok(row.week >= packet.baseline.start && row.week <= packet.current.end);
    assert.ok(Number.isInteger(row.orders) && row.orders > 0);
    assert.ok(Number.isInteger(row.lateOrders) && row.lateOrders >= 0 && row.lateOrders <= row.orders);
  }
  assert.equal(packet.weekly.filter((row) => row.week < packet.current.start).length, 4);
  const totals = summarize(packet.weekly);
  for (const rows of [packet.warehouses, packet.timing]) {
    for (const [field, total] of [["beforeOrders", totals.beforeOrders], ["currentOrders", totals.orders],
      ["beforeLate", totals.beforeLate], ["currentLate", totals.late]]) assert.equal(sum(rows, field), total);
    for (const row of rows) for (const prefix of ["before", "current"]) {
      assert.ok(Number.isInteger(row[`${prefix}Orders`]) && row[`${prefix}Orders`] > 0);
      assert.ok(Number.isInteger(row[`${prefix}Late`]) && row[`${prefix}Late`] >= 0
        && row[`${prefix}Late`] <= row[`${prefix}Orders`]);
    }
  }
  assert.equal(sum(packet.stages, "beforeLate"), totals.beforeLate);
  assert.equal(sum(packet.stages, "currentLate"), totals.late);
  assert.deepEqual(packet.stages.map((row) => row.stage), ["Missed dispatch", "After handoff"]);
  for (const row of packet.stages) for (const field of ["beforeLate", "currentLate"])
    assert.ok(Number.isInteger(row[field]) && row[field] >= 0);
  const baselineRate = totals.beforeLate / totals.beforeOrders;
  const stages = packet.stages.map((row) => ({ ...row,
    expectedAtCurrentVolume: row.beforeLate * totals.orders / totals.beforeOrders,
    extraLateOrders: row.currentLate - row.beforeLate * totals.orders / totals.beforeOrders }));
  const volumeExtra = (totals.orders - totals.beforeOrders) * baselineRate;
  assert.equal(volumeExtra + sum(stages, "extraLateOrders"), totals.late - totals.beforeLate);
  return { ...totals, baselineRate, currentRate: totals.late / totals.orders, volumeExtra, stages,
    deterioration: sum(stages, "extraLateOrders"),
    quoteCost: packet.offer.costPerDay * packet.offer.weekdays };
}

export function createDeliveryDiagnostic(input, generatedAt = new Date().toISOString(), { id = randomUUID() } = {}) {
  const packet = JSON.parse(input);
  const analysis = analyze(packet);
  const inputSha256 = createHash("sha256").update(input).digest("hex");
  const files = ["src/content/report/evidence/evidence.json", "src/content/report/diagnostic.mjs"];
  const componentIds = ["delivery-summary", "delivery-trend", "delivery-drivers", "delivery-bridge",
    "delivery-timing", "delivery-timing-chart", "delivery-evidence", "delivery-packing-test",
    "delivery-pickup-comparison", "delivery-cost-decision", "delivery-scope"];
  const source = (label, definitions, recordIds) => ({
    label: `Synthetic research packet: ${label}`, files,
    metricDefinitions: Object.entries(definitions).map(([field, definition]) => ({
      field, label: field, definition, componentIds, sourceLineage: [{ files }],
    })),
    evidenceFlow: [
      { title: "Synthetic evidence and scope", detail: `No real company, live query, or interview is represented. ${packet.definition}` },
      ...recordIds.map((recordId) => {
        const records = packet.records.filter((record) => record.id === recordId);
        return { title: recordId, detail: records.length === 1
          ? `${records[0].date} · ${records[0].title}. ${records[0].text}`
          : "No single matching source record; its annotation is omitted." };
      }),
      { title: "Reproduce", detail: `Run node src/content/report/diagnostic.mjs. Source SHA-256: ${inputSha256}. Counts reconcile across every cut. No SQL or external service is used.` },
    ],
  });
  const rateRows = (rows) => rows.map((row) => ({ ...row,
    baselineRate: row.beforeLate / row.beforeOrders, currentRate: row.currentLate / row.currentOrders }));
  const counts = { beforeOrders: "Eligible orders, June 22–July 19, 2026.", currentOrders: "Eligible orders, July 20–August 16, 2026.",
    beforeLate: "Baseline orders delivered after their original promise.", currentLate: "Recent orders delivered after their original promise.",
    baselineRate: "beforeLate / beforeOrders, within this group.", currentRate: "currentLate / currentOrders, within this group." };
  const queries = {
    weekly: { label: "Late deliveries by promised week", reportingField: "week",
      rows: packet.weekly.map((row) => ({ ...row, lateRate: row.lateOrders / row.orders,
        context: row.week === "2026-07-20" && supportsPickupContext(packet.records) ? "East pickup moved to 16:30" : "" })),
      source: source("order outcomes", { week: "Monday of original promised-delivery week, not the exact exposure date.",
        orders: packet.definition, lateOrders: "Orders delivered after the original promise. All have final scans by August 20.",
        lateRate: "lateOrders / orders, displayed as a percentage.", context: "OPS-17 supplies the schedule change. Timing does not establish its causal effect." }, ["OPS-17", "QA-1"]) },
    warehouse: { label: "Warehouse comparison", rows: rateRows(packet.warehouses),
      source: source("warehouse comparison", { warehouse: "Disjoint shipping warehouse assignment.", ...counts }, ["QA-1"]) },
    bridge: { label: "Additional late orders", rows: [{ stage: "Order volume", extraLateOrders: analysis.volumeExtra }, ...analysis.stages],
      source: source("dispatch classification", {
        stage: "Mutually exclusive first failure: missed planned dispatch, or handed off on time but delivered late. Not responsibility or causal attribution.",
        expectedAtCurrentVolume: "Baseline stage count × recent orders / baseline orders.",
        extraLateOrders: `Volume: added orders × baseline late rate. Other stages: recent late orders minus expectedAtCurrentVolume. All three sum to ${analysis.late - analysis.beforeLate} additional late orders.`,
        annotation: "OPS-17 documents East's 16:30 weekday pickup and 16:45 packing start. This contextual note does not attribute the all-warehouse, all-day missed-dispatch increase to that mismatch.",
      }, ["QA-1", "OPS-17"]) },
    timing: { label: "Warehouse and order-time comparison", rows: rateRows(packet.timing),
      source: source("placement-time comparison", { group: "Warehouse and local placement time: before 14:00 or 14:00–16:00. Same service; the four groups exhaust the sample.", ...counts }, ["OPS-17", "STAFF-8"]) },
    economics: { label: "Unaccepted pickup offer", rows: [{ quotePerDay: packet.offer.costPerDay,
      quoteDays: packet.offer.weekdays, quoteCost: analysis.quoteCost, maxParcelsPerDay: packet.offer.maxParcelsPerDay,
      creditPerLateOrder: packet.creditPerLateOrder, accepted: packet.offer.accepted }],
      source: source("carrier offer and credits", {
        quoteCost: `$${packet.offer.costPerDay} per weekday × ${packet.offer.weekdays} collections = $${analysis.quoteCost}. Offer acceptance: ${packet.offer.accepted}.`,
        maxParcelsPerDay: `${packet.offer.maxParcelsPerDay} parcels per extra East weekday collection. Eligibility and delivery benefit are unknown.`,
        creditPerLateOrder: `$${packet.creditPerLateOrder} credit for each late order. Excludes support costs, repeat purchase, and operating costs.`,
      }, ["CARRIER-4", "CX-6"]) },
    research: { label: "Supporting records", rows: packet.records,
      source: source("six source records", { id: "Stable synthetic record ID.", date: "Record date.",
        text: "Complete synthetic source content, not a real internal document." }, packet.records.map((record) => record.id)) },
  };
  return { snapshot: { id, title: "Late deliveries point to a dispatch problem at East", surface: "report",
    status: "fixture", generatedAt, filters: [], report: { asOf: packet.cutoff, originalQuestion: reportQuestion }, queries },
  results: { inputSha256, ...analysis } };
}

export function reproduceDeliveryDiagnostic(existing, input) {
  const { snapshot, results } = createDeliveryDiagnostic(input, existing.generatedAt, { id: existing.id ?? randomUUID() });
  return { snapshot: { ...snapshot, ...existing, id: snapshot.id, queries: snapshot.queries,
    ...(!existing.id && existing.title && !existing.legacyPresentationTitle ? { legacyPresentationTitle: existing.title } : {}) }, results };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const content = dirname(fileURLToPath(import.meta.url));
  const project = resolve(content, "../../..");
  if (content !== join(project, "src/content/report")) throw new Error("Run this in a generated report, or use delivery-diagnostic/build.mjs.");
  const { snapshot, results } = reproduceDeliveryDiagnostic(JSON.parse(readFileSync(join(project, "src/data.json"), "utf8")),
    readFileSync(join(content, "evidence/evidence.json"), "utf8"));
  writeFileSync(join(project, "src/data.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(content, "evidence/results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
}
