import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  filterReviewedRows, reportAggregateRows, reportFilterVisible, reportPeriodField,
  reportReviewedRows, useDataApp,
} from "../src/use-data-app.js";

const rows = [
  { week: "2026-07-13", segment: "all", value: 100, conversion: 0.312 },
  { week: "2026-07-13", segment: "A", value: 40, conversion: 0.30 },
  { week: "2026-07-13", segment: "B", value: 60, conversion: 0.32 },
  { week: "2026-07-20", segment: "all", value: 110, conversion: 0.318 },
  { week: "2026-07-20", segment: "A", value: 45, conversion: 0.31 },
  { week: "2026-07-20", segment: "B", value: 65, conversion: 0.33 },
  { week: "2026-07-27", segment: "all", value: 120, conversion: 0.324 },
  { week: "2026-07-27", segment: "A", value: 50, conversion: 0.32 },
  { week: "2026-07-27", segment: "B", value: 70, conversion: 0.34 },
];
const definitions = [
  { id: "period", field: "week" },
  { id: "segment", field: "segment" },
];
const weeks = (values) => values.map((row) => row.week);
const aggregate = rows.filter((row) => row.segment === "all");

test("reports ignore hidden dashboard filters and retain aggregate history", () => {
  assert.deepEqual(reportReviewedRows(rows, definitions,
    { period: "2026-07-27", segment: "A" }, "usage"), aggregate);
  assert.deepEqual(reportReviewedRows(rows, definitions,
    { period: "2026-07-27", segment: "A" }, "usage", { breakdown: ["segment"] }),
  rows.filter((row) => row.segment !== "all"));
});

test("report filter visibility is explicit and query scopes remain effective", () => {
  for (const definition of [
    { visible: true }, { reportVisible: true }, { surface: "report" }, { surfaces: ["report"] },
  ]) assert.equal(reportFilterVisible(definition), true);
  assert.equal(reportFilterVisible({ id: "segment" }, ["segment"]), true);
  assert.equal(reportFilterVisible({ surfaces: "not-a-report" }), false);
  assert.equal(reportFilterVisible({ id: "segment" }, null), false);
  assert.deepEqual(reportReviewedRows(rows, definitions, { segment: "A" }, "usage",
    { visibleFilterIds: ["segment"] }), rows.filter((row) => row.segment === "A"));
  const unrelated = [{ id: "segment", field: "segment", reportVisible: true, queryIds: ["other"] }];
  assert.deepEqual(reportReviewedRows(rows, unrelated, { segment: "A" }, "usage"), rows);
});

test("visible exact dates retain the prior comparable period", () => {
  const visible = definitions.map((definition) => ({ ...definition, reportVisible: true }));
  const filters = { period: "2026-07-27", segment: "A" };
  const latest = reportReviewedRows(rows, visible, filters, "usage", { period: "latest" });
  const previous = reportReviewedRows(rows, visible, filters, "usage", { period: "previous" });
  assert.deepEqual(latest, [rows[7]]);
  assert.deepEqual(previous, [rows[4]]);
  assert.deepEqual(reportReviewedRows(rows, visible, filters, "usage",
    { period: "previous", currentPeriod: "2026-07-20" }), [rows[1]]);
  assert.deepEqual(reportReviewedRows(rows, visible, filters, "usage",
    { period: "previous", currentPeriod: "2026-07-13" }), []);
});

test("report ranges retain history while dashboard ranges keep latest-endpoint behavior", () => {
  const visible = definitions.map((definition) => ({ ...definition, visible: true }));
  const filters = { period: "2026-07-15..2026-07-29", segment: "all" };
  assert.deepEqual(weeks(reportReviewedRows(rows, visible, filters, "usage")),
    ["2026-07-20", "2026-07-27"]);
  assert.deepEqual(reportReviewedRows(rows, visible, filters, "usage", { period: "latest" }), [rows[6]]);
  assert.deepEqual(reportReviewedRows(rows, visible,
    { ...filters, period: "2026-07-25..2026-07-29" }, "usage", { period: "previous" }), [rows[3]]);
  assert.deepEqual(filterReviewedRows(rows, definitions, filters, "usage"), [rows[6]]);
});

test("range endpoints follow the available selected dimension, not another segment's later date", () => {
  const sparse = rows.filter((row) => row !== rows[7]);
  const visible = definitions.map((definition) => ({ ...definition, visible: true }));
  const filters = { period: "2026-07-13..2026-07-27", segment: "A" };
  assert.deepEqual(reportReviewedRows(sparse, visible, filters, "usage", { period: "latest" }), [rows[4]]);
  assert.deepEqual(reportReviewedRows(sparse, visible, filters, "usage", { period: "previous" }), [rows[1]]);
  assert.deepEqual(filterReviewedRows(sparse, definitions, filters, "usage"), [rows[4]]);
});

test("aggregate comparisons ignore requested breakdowns but retain selected dimensions", () => {
  const options = { period: "latest", breakdown: ["segment"] };
  assert.deepEqual(reportAggregateRows(rows, definitions, {}, "usage", options), [rows[6]]);
  assert.deepEqual(reportAggregateRows(rows, definitions, { segment: "A" }, "usage",
    { ...options, visibleFilterIds: ["segment"] }), [rows[7]]);
  const latest = reportAggregateRows(rows, definitions, {}, "usage", options)[0];
  const previous = reportAggregateRows(rows, definitions, {}, "usage", { period: "previous" })[0];
  assert.equal(Number(((latest.conversion - previous.conversion) * 100).toFixed(1)), 0.6);
});

test("period comparison uses the same numeric-aware ordering for selection and prior periods", () => {
  const numeric = [{ period: 9 }, { period: 10 }, { period: 2 }];
  assert.deepEqual(reportReviewedRows(numeric, [], {}, "usage", { period: "latest" }), [{ period: 10 }]);
  assert.deepEqual(reportReviewedRows(numeric, [], {}, "usage", { period: "previous" }), [{ period: 9 }]);
  assert.deepEqual(reportReviewedRows(numeric, [], {}, "usage",
    { period: "latest", currentPeriod: "9" }), [{ period: 9 }]);
});

test("reporting fields prefer explicit metadata and refuse ambiguous or false temporal matches", () => {
  const values = [{ runtime: 17, week: "2026-07-27", createdAt: "2026-07-01", batch: 3 }];
  assert.equal(reportPeriodField(values, [], "usage"), "week");
  assert.equal(reportPeriodField(values, [], "usage", "batch"), "batch");
  assert.equal(reportPeriodField(values, [], "usage", "missing"), undefined);
  const ambiguous = [{ week: "2026-07-27", eventDate: "2026-07-01" }];
  assert.equal(reportPeriodField(ambiguous, [], "usage"), undefined);
  assert.equal(reportPeriodField(ambiguous, [{ field: "eventDate", queryIds: ["other"] }], "usage"), undefined);
  assert.equal(reportPeriodField(ambiguous, [{ field: "week" }], "usage"), "week");
  assert.equal(reportPeriodField(ambiguous, [{ field: "week" }, { field: "eventDate" }], "usage"), undefined);
  assert.deepEqual(reportReviewedRows(ambiguous, [], {}, "usage"), ambiguous);
  assert.deepEqual(reportReviewedRows(ambiguous, [], {}, "usage", { period: "latest" }), []);
  assert.deepEqual(reportReviewedRows(ambiguous, [], {}, "usage", { period: "previous" }), []);
  assert.deepEqual(reportReviewedRows([], [], {}, "usage", { period: "latest" }), []);
  assert.throws(() => reportReviewedRows([], [], {}, "usage", { period: "future" }), /Unknown report/u);
});

function readHook(snapshot, options = {}) {
  let result;
  function Probe() {
    result = useDataApp(snapshot, options);
    return null;
  }
  renderToStaticMarkup(React.createElement(Probe));
  return result;
}

test("report hook exposes period helpers and hides inactive dashboard-only filter metadata", () => {
  const snapshot = { surface: "report", queries: { usage: { rows, reportingField: "week" } },
    filters: definitions.map((definition) => ({ ...definition,
      defaultValue: definition.id === "period" ? "2026-07-20..2026-07-27" : "A" })) };
  const report = readHook(snapshot, { visibleFilterIds: ["period"] });
  assert.deepEqual(report.reviewedRows("usage"), aggregate.slice(1));
  assert.deepEqual(report.reviewedPeriodRows("usage", { period: "previous" }), [rows[3]]);
  assert.deepEqual(report.reviewedAggregatePeriodRows("usage", { period: "latest" }), [rows[6]]);
  assert.deepEqual(report.activeFilters, [{ field: "week", label: undefined,
    value: "2026-07-20 – 2026-07-27" }]);
  const dashboard = readHook({ ...snapshot, surface: "dashboard" }, {
    initialFilters: { segment: "all" }, authoritativeInitialFilters: { segment: "all" },
  });
  assert.equal(dashboard.filters.segment, "all");
  assert.deepEqual(dashboard.reviewedRows("usage"), [rows[6]]);
  assert.equal(typeof dashboard.replaceFilters, "function");
});
