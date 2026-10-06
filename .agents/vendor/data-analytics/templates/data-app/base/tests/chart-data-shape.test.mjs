import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { funnelLayout, funnelRibbonSegments, funnelStages } from "../src/charting/chart-transforms.js";

import {
  axisTitleVisibility,
  categoryAxisLayout,
  chartDataShape,
  groupAdditiveCategories,
  groupAdditiveSeries,
  isTemporalCategory,
  orderCalendarRows,
  secondaryAxisFields,
  orderedDistribution,
  projectChartSpec,
  rankedListCapacity,
  heatmapCellSize,
  lineGradients,
  resolvedChartType,
  scatterTooltipIdentityField,
  temporalAxisTicks,
  temporalTimeTicks,
  temporalAxisLayout,
  visibleGroupedCategories,
} from "../src/charting/chart-data-shape.js";
import {
  boxPlots,
  boxPlotSummaryFields,
  heatmap,
  histogram,
  pivot,
  sankeyGraph,
  waterfall,
} from "../src/charting/chart-transforms.js";
import { funnelStageColor, tick } from "../src/charting/chart-theme.js";
import { resolveChartSpec } from "../src/charting/chart-overrides.js";
import { assertChartSpec, getChartSpecError } from "../src/charting/chart-spec-validation.js";

test("raw chart bindings reject array measures before projection with a concrete correction", () => {
  const malformed = { type: "line", x: "week", y: ["siteA", "siteB"] };
  assert.equal(projectChartSpec(malformed).y, undefined, "Projection cannot substitute for validation");
  assert.match(getChartSpecError(malformed, { id: "throughput" }),
    /Invalid chart "throughput": chart\.y must be a single field name.*y: "siteA", fields: \["siteA","siteB"\]/u);
  assert.throws(() => assertChartSpec(malformed), /not an array/u);
  const corrected = { ...malformed, y: "siteA", fields: ["siteA", "siteB"] };
  assert.equal(getChartSpecError(corrected), null);
  assert.deepEqual(chartDataShape(corrected, [{ week: "2026-08-03", siteA: 18, siteB: 12 }]).fields,
    ["siteA", "siteB"]);
});

test("durable wide charts preserve field counts and names beyond inline payload budgets", () => {
  const fields = Array.from({ length: 41 }, (_, index) => `reviewed-${"column-".repeat(30)}${index}`);
  const spec = { type: "line", x: "week", y: fields[0], fields };
  const rows = [{ week: "2026-08-03", ...Object.fromEntries(fields.map((field, index) => [field, index])) }];
  assert.equal(getChartSpecError(spec), null);
  assert.deepEqual(chartDataShape(spec, rows).requiredRowFields, ["week", ...fields]);
});

test("binding validation rejects malformed provided fields without guessing data semantics", () => {
  const spec = { type: "line", x: "week", y: "value" };
  for (const invalid of [
    { y: "" }, { y: 42 }, { x: ["week"] }, { fields: "value" }, { fields: [] },
    { fields: ["value", ["baseline"]] }, { fields: ["value", " "] },
    { series: ["site"] }, { source: {} }, { target: true }, { stages: ["site", false] },
  ]) assert.ok(getChartSpecError({ ...spec, ...invalid }), JSON.stringify(invalid));
  assert.equal(getChartSpecError({ ...spec, barFields: [] }), null, "Clearing a combination is allowed");
  assert.equal(getChartSpecError({ type: "line", x: "week", fields: ["value", "baseline"] }), null,
    "Existing wide charts may specify their measures entirely through fields");
  const long = { ...spec, series: "site", barFields: ["Site B"] };
  assert.equal(getChartSpecError(long), null);
  assert.deepEqual(chartDataShape(long, [{ week: "2026-08-03", site: "Site B", value: 0 }]).fields,
    ["Site B"], "Long-form series names are pivoted values, not row columns");
  for (const rows of [[], [{ week: "2026-08-03", value: 0 }], [{ week: "2026-08-03", value: null }]]) {
    assert.equal(getChartSpecError(spec), null);
    assert.doesNotThrow(() => chartDataShape(spec, rows));
  }
});

test("binding validation preserves chart family exceptions and presentation-only snapshots", () => {
  for (const spec of [
    { type: "histogram", y: "latency" },
    { type: "sankey", y: "users", source: "origin", target: "destination" },
    { type: "sankey", y: "users", stages: ["origin", "destination"] },
    { type: "boxPlot", x: "plan", y: "duration" },
    { type: "horizontal-bar", x: "plan", y: "users" },
  ]) assert.equal(getChartSpecError(spec), null, spec.type);
  assert.match(getChartSpecError({ type: "sankey", y: "users", stages: ["origin"] }), /two stage fields/u);
  assert.equal(getChartSpecError({ type: "bar", showLegend: false }, { partial: true }), null);
  assert.match(getChartSpecError({ y: ["users"] }, { partial: true }), /not an array/u);
});

test("saved chart edits override authored settings and preserve cleared presentation values", () => {
  const authored = {
    type: "line", x: "week", y: "adoptionRate", fields: ["adoptionRate"], series: "plan",
    xLabel: "Week", yLabel: "Adoption", showXAxisLabel: true, showYAxisLabel: true,
    showLegend: true, startAtZero: true,
    colors: { adoptionRate: "blue", users: "red" }, legend: { labels: { users: "Old label" } },
  };
  const saved = {
    type: "bar", x: "plan", y: "users", fields: ["users"], series: "",
    xLabel: "", yLabel: "", showXAxisLabel: false, showYAxisLabel: false,
    showLegend: false, startAtZero: false, colors: { users: "green" }, legend: {},
  };
  const chart = resolveChartSpec(authored, saved);
  const shape = chartDataShape(chart, [{ week: "2026-08-24", plan: "Pro", users: 10, adoptionRate: .5 }]);
  assert.equal(chart.type, "bar");
  assert.deepEqual(shape.requiredRowFields, ["plan", "users"]);
  assert.deepEqual(shape.fields, ["users"]);
  assert.equal(shape.longForm, false);
  assert.equal(chart.xLabel, "");
  assert.equal(chart.yLabel, "");
  assert.deepEqual(axisTitleVisibility(chart), { x: false, y: false });
  assert.equal(chart.showLegend, false);
  assert.equal(chart.startAtZero, false);
  assert.deepEqual(chart.colors, { users: "green" });
  assert.deepEqual(chart.legend, {});
  assert.equal(authored.type, "line");
});

test("current waterfall inputs stay separate from saved visualization settings", () => {
  const rows = [{ driver: "Expansion", change: 40 }, { driver: "Churn", change: -15 }];
  for (const type of ["waterfall", "bar"]) {
    const saved = { type, x: "driver", y: "change", startAtZero: false, beginning: 10, ending: 35 };
    const authored = { ...saved, type: "line", startAtZero: true, beginning: 100, ending: 125 };
    const legacy = resolveChartSpec(authored, saved);
    assert.equal(legacy.type, type);
    assert.equal(legacy.beginning, 100, "Current legacy inputs replace totals captured in an older saved spec");
    assert.equal(legacy.ending, 125);
    const savedLegacy = JSON.parse(JSON.stringify(legacy));
    const restoredLegacy = resolveChartSpec(savedLegacy ?? authored, savedLegacy);
    assert.equal(restoredLegacy.beginning, 100, "Legacy authored code that selects saved specs must retain totals after Save");
    assert.equal(restoredLegacy.ending, 125);

    const chart = resolveChartSpec(authored, saved, {
      beginning: 0, ending: 25, type: "pie", x: "wrong", y: "wrong", startAtZero: true,
    });
    assert.equal(chart.type, type, "Data inputs cannot change the selected visualization");
    assert.equal(chart.startAtZero, false);
    assert.equal(chart.x, "driver");
    assert.equal(chart.y, "change");
    const bridge = waterfall(rows, chart.y, {
      categoryField: chart.x, beginning: chart.beginning, ending: chart.ending,
    });
    assert.deepEqual(bridge.map(({ driver, balance }) => [driver, balance]), [
      ["Beginning", 0], ["Expansion", 40], ["Churn", 25], ["Ending", 25],
    ]);
    const persisted = JSON.parse(JSON.stringify(chart));
    const refreshed = resolveChartSpec(persisted ?? authored, persisted, { beginning: 1000, ending: 1025 });
    assert.equal(refreshed.type, type);
    assert.equal(refreshed.beginning, 1000);
    assert.equal(refreshed.ending, 1025);
    assert.equal(persisted.beginning, 0, "Current inputs replace serialized totals without rewriting the saved snapshot");
    assert.equal(chart.beginning, 0);
    assert.equal(saved.beginning, 10, "Resolving current data does not mutate saved settings");
    assert.equal(authored.beginning, 100);
  }
});

test("saved snapshots retain omitted settings after JSON reload without restoring authored defaults", () => {
  const authored = {
    type: "line", x: "week", y: "energy", fields: ["energy", "cost"], rightAxisFields: ["energy"],
    xLabel: "Authored week", annotations: [{ id: "threshold", kind: "threshold", value: 2000, label: "Old threshold" }],
  };
  const rows = [{ week: "2026-08-24", energy: 3000, cost: 30 }];
  for (const saved of [undefined, null]) assert.deepEqual(resolveChartSpec(authored, saved), authored);
  const saved = JSON.parse(JSON.stringify({ ...authored, rightAxisFields: undefined, xLabel: undefined, annotations: undefined }));
  const chart = resolveChartSpec(authored, saved);
  for (const key of ["rightAxisFields", "xLabel", "annotations"]) {
    assert.equal(Object.hasOwn(saved, key), false);
    assert.equal(Object.hasOwn(chart, key), false, `The saved snapshot must not reintroduce ${key}`);
  }
  assert.deepEqual(secondaryAxisFields(chart, rows, chart.fields), ["cost"]);
  const shared = resolveChartSpec(authored, { ...saved, rightAxisFields: [] });
  assert.deepEqual(secondaryAxisFields(shared, rows, shared.fields), []);
});

test("chart data inputs preserve explicit unsets and ignore inherited values", () => {
  const saved = { type: "waterfall", x: "driver", y: "change", beginning: 50, ending: 75 };
  const authored = Object.assign(Object.create({ beginning: 999 }), { ...saved, ending: 125 });
  delete authored.beginning;
  assert.equal(resolveChartSpec(authored, saved).beginning, 50, "Inherited authored totals are not current data inputs");
  const dataInputs = Object.assign(Object.create({ ending: 999 }), { beginning: undefined });
  const chart = resolveChartSpec(authored, saved, dataInputs);
  assert.equal(Object.hasOwn(chart, "beginning"), true);
  assert.equal(chart.beginning, undefined, "Explicitly unavailable current data must clear an old saved total");
  assert.equal(chart.ending, 125, "Inherited explicit inputs must not replace current authored inputs");
  assert.equal(saved.beginning, 50);
});

test("line gradients preserve explicit stops and shared currency metadata without extension payloads", () => {
  const spec = projectChartSpec({type:"line",x:"day",y:"revenue",currency:"USD",lineGradients:{
    revenue:["#123456","var(--chart-1)"],
    cost:[{offset:0,color:"red",private:"omit"},{offset:.58,color:"green"},{offset:1,color:"blue"}],
    invalid:[{offset:1,color:"red"},{offset:0,color:"blue"}],
  }});
  assert.equal(spec.currency,"USD");
  assert.deepEqual(spec.lineGradients.revenue,[{offset:0,color:"#123456"},{offset:1,color:"var(--chart-1)"}]);
  assert.equal(spec.lineGradients.cost[1].offset,.58);
  assert.ok(!("invalid" in spec.lineGradients));
  assert.ok(!JSON.stringify(spec).includes("private"));
  assert.deepEqual(lineGradients({bad:["red"],infinite:[{offset:0,color:"red"},{offset:Infinity,color:"blue"}]}),{});
});

test("calendar categories use weekday and month chronology without rewriting reviewed data", () => {
  const rows = ["Fri", "Mon", "Sat", "Sun", "Thu", "Tue", "Wed"].map((day) => ({ day, value: 1 }));
  assert.deepEqual(orderCalendarRows(rows, "day").map((row) => row.day), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
  assert.equal(rows[0].day, "Fri");
  assert.equal(orderCalendarRows(rows, "day", { sortOrder: "original" }), rows);
  assert.equal(orderCalendarRows(rows, "day", { sortOrder: "descending" }), rows);
  assert.equal(orderCalendarRows(rows, "day", { categoryOrder: ["Sun", "Mon"] })[0].day, "Sun");
  const repeated = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue"]
    .map((day, index) => ({ day, id: index + 1 }));
  assert.equal(orderCalendarRows(repeated, "day"), repeated,
    "Repeated weekdays can span multiple weeks and must retain their reviewed chronology");
  assert.equal(orderCalendarRows(repeated, "day", { sortOrder: "original" }), repeated);
  assert.equal(orderCalendarRows([{ day: "Monday" }, { day: "Mon" }], "day")[0].day, "Monday",
    "Weekday aliases do not establish unique calendar grain");
  assert.deepEqual(orderCalendarRows([{ m: "2026-01" }, { m: "2025-12" }], "m").map((row) => row.m), ["2025-12", "2026-01"]);
  assert.equal(isTemporalCategory("2026-08"), true);
  assert.equal(isTemporalCategory("2026-13"), false);
  assert.equal(tick("2026-08"), "Aug 2026");
  assert.equal(tick("2026-08-21", { includeYear: true }), "Aug 21, 2026");
});

test("different-scale measures get separate axes but category series and stacks do not", () => {
  const rows = [{ energy: 3000, cost: 30, rate: .75 }, { energy: -1000, cost: -10, rate: .5 }];
  const spec = { type: "bar", x: "city", y: "energy", fields: ["energy", "cost"] };
  assert.deepEqual(secondaryAxisFields(spec, rows, spec.fields), ["cost"]);
  assert.deepEqual(secondaryAxisFields({ ...spec, rightAxisFields: [] }, rows, spec.fields), []);
  assert.deepEqual(secondaryAxisFields({ ...spec, rightAxisFields: ["energy"] }, rows, spec.fields), ["energy"]);
  assert.deepEqual(secondaryAxisFields({ ...spec, barFields: ["energy"], rightAxisFields: ["cost"] }, rows,
    spec.fields), ["cost"]);
  assert.deepEqual(secondaryAxisFields({ ...spec, series: "plan" }, rows, spec.fields), []);
  assert.deepEqual(secondaryAxisFields({ ...spec, type: "stackedBar" }, rows, spec.fields), []);
  assert.deepEqual(secondaryAxisFields(spec, [{ energy: 30, cost: 20 }], spec.fields), []);
  assert.deepEqual(secondaryAxisFields(spec, [{ energy: 0, cost: 0 }], spec.fields), []);
  assert.deepEqual(secondaryAxisFields(spec, [{ energy: null, cost: 20 }], spec.fields), []);
  assert.deepEqual(secondaryAxisFields(spec, [{ energy: 3, rate: .75 }], ["energy", "rate"]), ["rate"]);
  const momentum = [{ previousGrowthRate: .174, currentGrowthRate: -.024 }, { previousGrowthRate: .04, currentGrowthRate: .11 }];
  assert.deepEqual(secondaryAxisFields({ type: "horizontalBar" }, momentum, ["previousGrowthRate", "currentGrowthRate"]), []);
  assert.deepEqual(secondaryAxisFields({ type: "bar" }, [{ previousUsers: 1000, currentUsers: 10 }], ["previousUsers", "currentUsers"]), [],
    "A large change does not turn two periods of the same measure into two different scales");
  assert.deepEqual(secondaryAxisFields({ type: "horizontalBar", rightAxisFields: ["currentGrowthRate"] }, momentum,
    ["previousGrowthRate", "currentGrowthRate"]), ["currentGrowthRate"], "Explicit axes remain authoritative");
});

test("axis titles omit redundant defaults while preserving authored labels and distinct scales", () => {
  for (const type of ["line", "bar", "horizontalBar", "area", "heatmap"]) {
    assert.deepEqual(axisTitleVisibility({ type, x: "week", y: "conversionRate" }), { x: false, y: false });
  }
  assert.deepEqual(axisTitleVisibility({ type: "line", xLabel: "First-use week", yLabel: "Revenue (USD)" }), { x: true, y: true });
  assert.deepEqual(axisTitleVisibility({ type: "line", showXAxisLabel: true }), { x: true, y: false });
  assert.deepEqual(axisTitleVisibility({ type: "heatmap", xLabel: "Age", yLabel: "Cohort", showXAxisLabel: false }), { x: false, y: true });
  assert.deepEqual(axisTitleVisibility({ type: "line" }, true), { x: false, y: true });
  assert.deepEqual(axisTitleVisibility({ type: "scatter" }), { x: true, y: true });
  assert.deepEqual(axisTitleVisibility({ type: "histogram" }), { x: true, y: false });
  assert.deepEqual(axisTitleVisibility({ type: "scatter", showXAxisLabel: false, showYAxisLabel: false }), { x: false, y: false });
});

function project(spec, rows) {
  const shape = chartDataShape(spec, rows);
  const projected = rows.map((row) =>
    Object.fromEntries(
      shape.rowFields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]]),
    ),
  );
  return { shape, rows: projected };
}

test("crowded additive categories retain reviewed leaders and reconcile the exact Other total", () => {
  const rows = [
    { plan: "Plus", users: 4791905, reviewedMetadata: "preserved" },
    { plan: "Pro Lite", users: 410586 },
    { plan: "Pro", users: 389654 },
    { plan: "Team", users: 313530 },
    { plan: "Free", users: 181026 },
    { plan: "Business", users: 96976 },
    { plan: "Enterprise usage", users: 5173 },
    { plan: "Education", users: 3594 },
    { plan: "Enterprise", users: 2587 },
    { plan: "Self-serve usage", users: 1559 },
    { plan: "Education Plus", users: 251 },
    { plan: "Education Pro", users: 58 },
  ];
  const result = groupAdditiveCategories(rows, { categoryField: "plan", valueField: "users", enabled: true });
  assert.equal(result.length, 7);
  assert.equal(result[0], rows[0], "Reviewed leading rows retain their original fields");
  assert.deepEqual(result.at(-1), { plan: "Other", users: 13222 });
  assert.equal(result.reduce((total, row) => total + row.users, 0), rows.reduce((total, row) => total + row.users, 0));
  assert.equal(rows.length, 12, "Grouping must not modify the reviewed source rows");

  const preserved = groupAdditiveCategories(rows, {
    categoryField: "plan",
    valueField: "users",
    preserveCategories: ["Education Pro"],
    enabled: true,
  });
  assert.ok(preserved.some((row) => row.plan === "Education Pro"));
  assert.equal(preserved.reduce((total, row) => total + row.users, 0), rows.reduce((total, row) => total + row.users, 0));
});

test("Other grouping declines non-additive, ambiguous, and explicitly preserved source data", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ category: `Category ${index}`, count: index + 1 }));
  const options = { categoryField: "category", valueField: "count", enabled: true };
  assert.equal(groupAdditiveCategories(rows, { categoryField: "category", valueField: "count" }), rows,
    "Unknown category populations must never be combined without explicit reviewed additivity");
  const overlappingProducts = rows.map(({ category, count }) => ({ product: category, users: count }));
  assert.equal(groupAdditiveCategories(overlappingProducts, { categoryField: "product", valueField: "users" }),
    overlappingProducts, "Overlapping product audiences must not be inferred as mutually exclusive");
  assert.equal(groupAdditiveCategories(rows, { ...options, enabled: false }), rows);
  assert.equal(groupAdditiveCategories(rows.slice(0, 7), options).length, 7);
  assert.equal(groupAdditiveCategories(rows, { ...options, maxCategories: 8 }), rows);
  assert.equal(groupAdditiveCategories(rows, { ...options, preserveCategories: rows.map((row) => row.category) }), rows);

  for (const field of ["adoptionRate", "percentage", "averageUsers", "users_per_account", "audienceShare"]) {
    const nonadditive = rows.map(({ category, count }) => ({ category, [field]: count / 10 }));
    assert.equal(groupAdditiveCategories(nonadditive, { categoryField: "category", valueField: field, enabled: true }),
      nonadditive);
  }
  for (const field of ["feature", "productExperience", "surface", "funnelStage"]) {
    const overlapping = rows.map(({ category, count }) => ({ [field]: category, count }));
    assert.equal(groupAdditiveCategories(overlapping, { categoryField: field, valueField: "count" }),
      overlapping);
  }
  const reviewedFeatureObservations = rows.map(({ category, count }) => ({ feature: category, observations: count }));
  assert.equal(groupAdditiveCategories(reviewedFeatureObservations, {
    categoryField: "feature", valueField: "observations", enabled: true,
  }).length, 7, "Explicitly verified additive observations must not be rejected because of a dimension's name");

  for (const invalid of [
    [...rows.slice(0, -1), rows[0]],
    [...rows.slice(0, -1), { category: "Other", count: 8 }],
    [...rows.slice(0, -1), { category: "Invalid", count: -1 }],
    [...rows.slice(0, -1), { category: "Invalid", count: Number.NaN }],
  ]) assert.equal(groupAdditiveCategories(invalid, options), invalid);
});

test("crowded additive plan histories preserve stable leaders and reconcile Other for every reviewed period", () => {
  const plans = ["Plus", "Pro", "Team", "Free", "Business", "Enterprise", "Education", "Education Pro"];
  const rows = ["2026-08-18", "2026-08-19"].flatMap((period, dateIndex) => plans.map((plan, index) => ({
    period,
    plan,
    users: (plans.length - index) * (dateIndex + 1),
    reviewedMetadata: `${period}:${plan}`,
  })));
  const options = { groupField: "period", categoryField: "plan", valueField: "users", enabled: true };
  assert.equal(groupAdditiveSeries(rows, { groupField: "period", categoryField: "plan", valueField: "users" }), rows,
    "Even familiar category names cannot prove that reviewed audiences are mutually exclusive");
  const grouped = groupAdditiveSeries(rows, options);
  assert.equal(grouped.length, 14);
  for (const period of ["2026-08-18", "2026-08-19"]) {
    const reviewed = rows.filter((row) => row.period === period);
    const displayed = grouped.filter((row) => row.period === period);
    assert.equal(displayed.length, 7);
    assert.equal(displayed.reduce((total, row) => total + row.users, 0),
      reviewed.reduce((total, row) => total + row.users, 0));
    assert.deepEqual(displayed.at(-1), {
      period,
      plan: "Other",
      users: reviewed.slice(6).reduce((total, row) => total + row.users, 0),
    });
    assert.equal(displayed[0], reviewed[0], "Reviewed leading rows retain their source identity");
  }
  assert.equal(rows.length, 16, "Grouping does not modify reviewed source rows");

  const preserved = groupAdditiveSeries(rows, { ...options, preserveCategories: ["Education Pro"] });
  assert.ok(preserved.some((row) => row.plan === "Education Pro"));
  assert.equal(groupAdditiveSeries(rows, { ...options, enabled: false }), rows);
  assert.equal(groupAdditiveSeries(rows, { ...options, maxCategories: 8 }), rows);
  assert.equal(groupAdditiveSeries(rows, { ...options, valueField: "adoptionRate" }), rows);

  for (const categoryField of ["feature", "experience", "surface", "product", "category"]) {
    const unverified = rows.map(({ plan, ...row }) => ({ ...row, [categoryField]: plan }));
    assert.equal(groupAdditiveSeries(unverified, { ...options, categoryField, enabled: false }), unverified);
  }
  for (const invalid of [
    [...rows, rows[0]],
    rows.map((row, index) => index ? row : { ...row, plan: "Other" }),
    rows.map((row, index) => index ? row : { ...row, users: -1 }),
  ]) assert.equal(groupAdditiveSeries(invalid, options), invalid);
});

test("grouped totals exclude filtered source categories without changing reviewed leaders", () => {
  const categories = ["Plus", "Pro", "Team", "Free", "Business", "Enterprise", "Education", "Education Pro"];
  const categoryRows = categories.map((plan, index) => ({ plan, users: categories.length - index }));
  const groupedCategories = groupAdditiveCategories(categoryRows, {
    categoryField: "plan", valueField: "users", enabled: true,
  });
  const visibleCategories = new Set(categories.filter((plan) => plan !== "Education"));
  const filteredCategories = visibleGroupedCategories(categoryRows, groupedCategories, {
    categoryField: "plan", valueField: "users", visibleCategories,
  });
  assert.deepEqual(filteredCategories.at(-1), { plan: "Other", users: 1 },
    "A hidden constituent must not remain counted in the visible donut slice");
  assert.deepEqual(filteredCategories.slice(0, -1), groupedCategories.slice(0, -1),
    "Filtering an Other constituent must preserve the reviewed leader identities");

  const seriesRows = ["2026-08-18", "2026-08-19"].flatMap((period, index) =>
    categoryRows.map((row) => ({ period, ...row, users: row.users * (index + 1) })));
  const groupedSeries = groupAdditiveSeries(seriesRows, {
    groupField: "period", categoryField: "plan", valueField: "users", enabled: true,
  });
  const filteredSeries = visibleGroupedCategories(seriesRows, groupedSeries, {
    groupField: "period", categoryField: "plan", valueField: "users", visibleCategories,
  });
  assert.deepEqual(filteredSeries.filter((row) => row.plan === "Other"), [
    { period: "2026-08-18", plan: "Other", users: 1 },
    { period: "2026-08-19", plan: "Other", users: 2 },
  ], "Each reviewed period must independently exclude hidden constituent categories");
});

test("explicitly reviewed additive series group regardless of dimension names", () => {
  const channels = ["Direct", "Organic", "Referral", "Paid", "Email", "Partner", "Community", "Events"];
  const rows = ["2026-08-18", "2026-08-19"].flatMap((period) => channels.map((channel, index) => ({
    period, channel, signups: channels.length - index,
  })));
  const grouped = groupAdditiveSeries(rows, {
    groupField: "period", categoryField: "channel", valueField: "signups", enabled: true,
  });
  for (const period of ["2026-08-18", "2026-08-19"]) {
    const reviewed = rows.filter((row) => row.period === period);
    const displayed = grouped.filter((row) => row.period === period);
    assert.equal(displayed.length, 7);
    assert.equal(displayed.at(-1).channel, "Other");
    assert.equal(displayed.reduce((total, row) => total + row.signups, 0),
      reviewed.reduce((total, row) => total + row.signups, 0));
  }
});

test("reviewed quarter labels choose current leaders without lexicographic period sorting", () => {
  const plans = ["Legacy", "Standard", "Business", "Growth", "Current", "Emerging", "Pilot", "New"];
  const rows = ["Q4 2025", "Q1 2026"].flatMap((period, periodIndex) => plans.map((plan, index) => ({
    period,
    plan,
    users: periodIndex ? (index + 1) * 10 : plans.length - index,
  })));
  const grouped = groupAdditiveSeries(rows, {
    groupField: "period", categoryField: "plan", valueField: "users", maxCategories: 3, enabled: true,
  });
  assert.deepEqual(grouped.filter((row) => row.period === "Q1 2026").map((row) => row.plan),
    ["Pilot", "New", "Other"],
    "Latest-quarter leaders must follow reviewed chronological order rather than sorting quarter names");

  const numericRows = [20, 10].flatMap((period, periodIndex) => plans.map((plan, index) => ({
    period,
    plan,
    users: periodIndex ? index + 1 : (plans.length - index) * 10,
  })));
  const numeric = groupAdditiveSeries(numericRows, {
    groupField: "period", categoryField: "plan", valueField: "users", maxCategories: 3, enabled: true,
  });
  assert.deepEqual(numeric.filter((row) => row.period === 20).map((row) => row.plan),
    ["Legacy", "Standard", "Other"], "Numeric periods must continue to select their highest reviewed value");
});

test("stable grouped leaders preserve major historical spikes across the reviewed window", () => {
  const channels = ["Earlier leader", "Current leader", "Steady", "Small A", "Small B", "Small C", "Small D", "Small E"];
  const rows = ["Q4 2025", "Q1 2026"].flatMap((period, periodIndex) => channels.map((channel, index) => ({
    period,
    channel,
    signups: channel === "Earlier leader" ? periodIndex ? 1 : 1_000
      : channel === "Current leader" ? periodIndex ? 900 : 2
        : 50 - index,
  })));
  const grouped = groupAdditiveSeries(rows, {
    groupField: "period", categoryField: "channel", valueField: "signups", maxCategories: 3, enabled: true,
  });
  for (const period of ["Q4 2025", "Q1 2026"]) {
    const reviewed = rows.filter((row) => row.period === period);
    const displayed = grouped.filter((row) => row.period === period);
    assert.deepEqual(displayed.map((row) => row.channel), ["Earlier leader", "Current leader", "Other"],
      "One stable leader set must preserve both earlier spikes and currently important categories");
    assert.equal(displayed.reduce((total, row) => total + row.signups, 0),
      reviewed.reduce((total, row) => total + row.signups, 0));
  }
});

test("shareable chart specs retain safe grouping and distribution options", () => {
  assert.deepEqual(projectChartSpec({
    type: "pie",
    x: "plan",
    y: "users",
    groupOther: false,
    maxCategories: 9,
    distribution: true,
    preserveCategories: ["Enterprise", { privateMetadata: true }],
  }), {
    type: "pie",
    x: "plan",
    y: "users",
    groupOther: false,
    maxCategories: 9,
    distribution: true,
    preserveCategories: ["Enterprise"],
  });
});

test("shareable chart specs retain axis placement and category-label visibility", () => {
  assert.deepEqual(projectChartSpec({
    type: "bar",
    x: "segment",
    y: "revenue",
    yAxisPosition: "right",
    showCategoryTicks: false,
  }), {
    type: "bar",
    x: "segment",
    y: "revenue",
    yAxisPosition: "right",
    showCategoryTicks: false,
  });
});

test("chart controls preserve reviewed identities, complete labels, and accessible selections", async () => {
  const [explorer, frame, sortable] = await Promise.all([
    readFile(new URL("../src/components/ChartExplorer.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/charting/ChartFrame.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/shared/SortableDashboardLayout.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(explorer, /aria-pressed=\{identity\.explicitColor === token\}/u,
    "Theme colors sharing the same readable label must still have only one selected token");
  assert.match(explorer, /changeChartEditorSpec\(draft \?\? localSpec, field, value/u,
    "Unrelated editor changes must preserve the authored rather than inferred chart type");
  assert.match(frame, /layout\.visibleCount < items\.length/u,
    "The legend expansion control must remain available after scrolling");
  assert.doesNotMatch(frame, /legend\.scrollTop\s*\+\s*legend\.clientHeight/u,
    "Legend overflow is independent of the current scroll position");
  assert.match(sortable, /const stableIdentity = attributes\.id \?\? authored\[0\]\.metadata\.id/u,
    "Conditional sections must not replace stable authored dashboard-region identities");
  assert.match(sortable, /element\.props\.className \?\? ""\)\.split\(\/\\s\+\/u\)\.filter\(Boolean\)/u,
    "Every authored placement class must remain available while measuring custom grid proportions");
  assert.doesNotMatch(sortable, /placementClass\.test/u,
    "Nonstandard authored layout classes must not be discarded by a fixed placement allowlist");
  assert.match(sortable, /row\.items\.sort\(\(left,\s*right\)\s*=>\s*left\.bounds\.left\s*-\s*right\.bounds\.left\)/u,
    "Canvas promotion must preserve measured visual placement rather than authored DOM order");
});

test("ordered numeric and temporal buckets inherit distribution spacing without affecting categories", () => {
  assert.equal(orderedDistribution({ x: "ageBand" }, [
    { ageBand: "< 5 min" }, { ageBand: "5–9 min" }, { ageBand: "10–19 min" }, { ageBand: "30+ min" },
  ]), true);
  assert.equal(orderedDistribution({ x: "interval" }, [
    { interval: "22:55" }, { interval: "23:00" }, { interval: "23:05" },
  ]), true);
  assert.equal(orderedDistribution({ x: "bucket" }, [{ bucket: 0 }, { bucket: 1 }, { bucket: 2 }]), true);
  assert.equal(orderedDistribution({ x: "accountBand" }, [
    { accountBand: "Free" }, { accountBand: "Plus" }, { accountBand: "Enterprise" },
  ]), false);
  assert.equal(orderedDistribution({ x: "plan" }, [
    { plan: "Free" }, { plan: "Plus" }, { plan: "Enterprise" },
  ]), false);
  assert.equal(orderedDistribution({ x: "ageBand", distribution: false }, [
    { ageBand: "0–5" }, { ageBand: "5–10" }, { ageBand: "10–15" },
  ]), false);
  assert.equal(orderedDistribution({ x: "category", distribution: true }, [{ category: "Only" }]), true);
});

test("bucket axes retain a constant stride instead of rounding or appending endpoint labels", () => {
  const dates = Array.from({ length: 28 }, (_, index) =>
    new Date(Date.UTC(2026, 6, 13 + index)).toISOString().slice(0, 10));
  assert.deepEqual(temporalAxisTicks(dates), [dates[0], dates[5], dates[10], dates[15], dates[20], dates[25]]);
  assert.deepEqual(temporalAxisTicks(dates.slice(0, 7)),
    [dates[0], dates[2], dates[4], dates[6]]);
  assert.deepEqual(temporalAxisTicks([dates[0], dates[0], dates[1]]), [dates[0], dates[1]]);
  assert.deepEqual(temporalAxisTicks(["2026-07-13", "2026-07-17", "2026-07-23", "2026-08-01",
    "2026-08-07", "2026-08-09", "2026-08-12"], { maxTicks: 4 }),
  ["2026-07-13", "2026-07-23", "2026-08-07", "2026-08-12"]);
  const weeks = Array.from({ length: 13 }, (_, index) => new Date(Date.UTC(2026, 4, 18 + index * 7)).toISOString().slice(0,10));
  assert.deepEqual(temporalAxisTicks(weeks), [weeks[0], weeks[3], weeks[6], weeks[9], weeks[12]]);
  assert.deepEqual(temporalAxisTicks(weeks, { maxTicks: 3 }), [weeks[0], weeks[5], weeks[10]]);
  assert.deepEqual(temporalAxisTicks([], { maxTicks: 1 }), []);
  assert.deepEqual(temporalAxisTicks(dates, { maxTicks: 2 }), [dates[0], dates[14]]);
  assert.deepEqual(temporalAxisTicks(dates.slice(0,12)),dates.filter((_,i)=>i<12 && i%2===0),
    "The reported twelve-point chart must not have a 50% wider middle gap");
});

test("the reported 28-day axis keeps regular UTC ticks inside its original extent", () => {
  const dates=Array.from({length:28},(_,index)=>new Date(Date.UTC(2026,6,20+index)).toISOString().slice(0,10));
  const layout=temporalAxisLayout(dates,{plotWidth:350,leftRoom:34,rightRoom:14,continuous:true,measureLabel:()=>42});
  const gaps=layout.ticks.slice(1).map((tick,i)=>tick-layout.ticks[i]);
  assert.ok(gaps.length>=2 && gaps.every(gap=>gap===gaps[0]));
  assert.ok(layout.ticks[0]>=Date.parse(dates[0]) && layout.ticks.at(-1)<=Date.parse(dates.at(-1)));
  assert.equal(layout.padding.right,11,"A centered 42px label needs more than the old 14px right margin");
  const narrow=temporalAxisLayout(dates,{plotWidth:130,leftRoom:34,rightRoom:14,continuous:true,measureLabel:()=>42});
  assert.ok(narrow.ticks.length>=2 && narrow.ticks.length<=3);
  assert.ok(narrow.bounds.at(-1).x + 21 <= 130+14-4);
});

test("arbitrary bucket counts retain a strictly regular index cadence", () => {
  for (let size=2;size<=100;size++) for (let maxTicks=2;maxTicks<=6;maxTicks++) {
    const values=Array.from({length:size},(_,i)=>new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10));
    const ticks=temporalAxisTicks(values,{maxTicks});
    assert.equal(ticks[0],values[0]);
    assert.ok(ticks.length>=2 && ticks.length<=maxTicks);
    const indexes=ticks.map(value=>values.indexOf(value));
    const gaps=indexes.slice(1).map((value,i)=>value-indexes[i]);
    assert.ok(gaps.every(gap=>gap>0));
    assert.ok(gaps.every(gap=>gap===gaps[0]));
  }
  assert.deepEqual(temporalAxisTicks(["2026-07-20","2026-08-16"],{maxTicks:1}),["2026-08-16"]);
});

test("regular time ticks align with observations at wide and thinned densities", () => {
  const dates=Array.from({length:12},(_,i)=>new Date(Date.UTC(2026,5,2+i*3)).toISOString().slice(0,10));
  assert.deepEqual(temporalTimeTicks(dates,{maxTicks:12}),dates.map(Date.parse),
    "Jun 5 must be labeled at its actual point, not bracketed by shifted Jun 3/Jun 6 ticks");
  assert.deepEqual(temporalTimeTicks(dates,{maxTicks:6}),dates.filter((_,i)=>i%2===0).map(Date.parse));
  for (const plotWidth of [180,350,741,1200]) {
    const {ticks,bounds,padding}=temporalAxisLayout(dates,{continuous:true,plotWidth,leftRoom:34,rightRoom:14,measureLabel:()=>42});
    for (const tick of ticks) assert.ok(dates.some(date=>Date.parse(date)===tick));
    const step=(plotWidth-padding.left-padding.right)/11;
    bounds.forEach(label=>assert.ok(Math.abs(label.x-padding.left-dates.findIndex(date=>Date.parse(date)===label.value)*step)<1e-7));
    const indices=ticks.map(tick=>dates.findIndex(date=>Date.parse(date)===tick));
    assert.ok(indices.slice(1).every((index,i)=>index-indices[i]===indices[1]-indices[0]));
  }
  for (const months of [["2026-01-01","2026-02-01","2026-03-01","2026-04-01"],
    ["2024-01-31","2024-02-29","2024-03-31","2024-04-30"]]) {
    assert.deepEqual(temporalTimeTicks(months,{maxTicks:12}),months.map(Date.parse));
    assert.deepEqual(temporalTimeTicks(months,{maxTicks:2}),[months[0],months[2]].map(Date.parse));
  }
  const shortDaily=temporalTimeTicks(["2026-08-01","2026-08-03"],{maxTicks:12});
  assert.deepEqual(shortDaily,["2026-08-01","2026-08-03"].map(Date.parse),
    "Sparse regular samples retain their actual dates rather than inventing intermediate labels");
});

test("irregular time scales label calendar intervals without changing evidence or compressing gaps", () => {
  const dates=["2026-06-02","2026-06-05","2026-06-08","2026-06-23","2026-07-02","2026-07-05"];
  const before=[...dates];
  const {ticks,bounds}=temporalAxisLayout(dates,{continuous:true,plotWidth:600,leftRoom:30,rightRoom:30,maxTicks:6,measureLabel:()=>40});
  assert.ok(ticks.length>=3);
  assert.ok(ticks.some(time=>!dates.some(date=>Date.parse(date)===time)),"Ticks are independent of observation dates");
  const slope=(bounds[1].x-bounds[0].x)/(ticks[1]-ticks[0]);
  bounds.slice(1).forEach((point,i)=>assert.ok(Math.abs(point.x-bounds[i].x-(ticks[i+1]-ticks[i])*slope)<1e-7));
  assert.deepEqual(dates,before);
  for (const dates of [["2026-03-07T18:00:00Z","2026-03-09T06:00:00Z"],
    ["2025-12-28","2026-01-15"], ["2024-02-27","2024-03-04"]]) {
    const ticks=temporalTimeTicks(dates,{maxTicks:6});
    const gaps=ticks.slice(1).map((tick,i)=>tick-ticks[i]);
    assert.ok(gaps.length && gaps.every(gap=>gap===gaps[0]),"UTC day/hour intervals do not drift at DST, leap days, or year boundaries");
  }
  const months=temporalTimeTicks(["2025-01-02","2025-06-17","2026-12-31"],{maxTicks:8}).map(time=>new Date(time));
  const indexes=months.map(date=>date.getUTCFullYear()*12+date.getUTCMonth());
  assert.ok(months.length>=3 && months.every(date=>date.getUTCDate()===1));
  assert.ok(indexes.slice(1).every((index,i)=>index-indexes[i]===indexes[1]-indexes[0]));
});

test("date label geometry stays contained and separated across resize, grain, year and font widths", () => {
  const iso = date => date.toISOString().slice(0,10);
  const datasets=[
    Array.from({length:7},(_,i)=>iso(new Date(Date.UTC(2026,6,20+i)))),
    Array.from({length:28},(_,i)=>iso(new Date(Date.UTC(2026,6,20+i)))),
    ...[30,60,90,365].map(count=>Array.from({length:count},(_,i)=>iso(new Date(Date.UTC(2026,0,1+i))))),
    Array.from({length:91},(_,i)=>iso(new Date(Date.UTC(2026,4,18+i)))),
    Array.from({length:13},(_,i)=>iso(new Date(Date.UTC(2026,4,18+i*7)))),
    Array.from({length:18},(_,i)=>iso(new Date(Date.UTC(2026,2,30+i*7)))),
    Array.from({length:12},(_,i)=>iso(new Date(Date.UTC(2025,i,1)))),
    Array.from({length:8},(_,i)=>iso(new Date(Date.UTC(2025,i*3,1)))),
    Array.from({length:6},(_,i)=>iso(new Date(Date.UTC(2020+i,0,1)))),
    ["2025-12-28","2025-12-29","2025-12-30","2025-12-31","2026-01-01","2026-01-02"],
    ["2026-07-20","2026-07-22","2026-08-02","2026-08-16"],
    ["2026-08-16"],
  ];
  for (const values of datasets) for (const plotWidth of [48,80,130,180,240,350,550,1000]) {
    for (const banded of [false,true]) for (const fontWidth of [36,58,94]) {
      const options={plotWidth,leftRoom:24,rightRoom:14,banded,continuous:!banded,measureLabel:()=>fontWidth};
      const {ticks,bounds}=temporalAxisLayout(values,options);
      assert.ok(ticks.every(value=>banded ? values.includes(value) : value>=Date.parse(values[0]) && value<=Date.parse(values.at(-1))),
        "Bucket labels use reviewed dates; time ticks remain inside the reviewed extent");
      bounds.forEach((label,index)=>{
        assert.ok(label.x-label.width/2 >= -20-1e-7,JSON.stringify({options,label}));
        assert.ok(label.x+label.width/2 <= plotWidth+10+1e-7,JSON.stringify({options,label}));
        if(index) assert.ok(label.x-label.width/2 >= bounds[index-1].x+fontWidth/2+12-1e-7);
      });
      if(values.length>2 && plotWidth>=350 && fontWidth===36)
        assert.ok(ticks.length>=3,"Ordinary wide timelines retain interior context regardless of bucket count");
    }
  }
  assert.deepEqual(temporalAxisLayout([]).ticks,[]);
  const weeks=Array.from({length:18},(_,i)=>iso(new Date(Date.UTC(2026,2,30+i*7))));
  const wide={plotWidth:1200,leftRoom:34,rightRoom:14,measureLabel:()=>42};
  assert.deepEqual(temporalAxisLayout(weeks,wide).ticks,weeks,
    "A wide 18-week chart must not collapse to two endpoints because 17 is prime");
  assert.equal(temporalAxisLayout(weeks,{...wide,maxTicks:6}).ticks.length,6,
    "A label ceiling should not collapse a prime interval count to endpoints");
  const uneven=temporalAxisLayout(weeks,{plotWidth:360,leftRoom:24,rightRoom:14,
    measureLabel:value=>value===weeks[0] ? 90 : value===weeks.at(-1) ? 75 : 36});
  assert.ok(uneven.ticks.length>=3);
  assert.ok(uneven.bounds.every((label,index)=>!index || label.x-label.width/2>=
    uneven.bounds[index-1].x+uneven.bounds[index-1].width/2+12));
});

test("axis layouts rotate only dense named categories and honor explicit presentation choices", () => {
  const countries = ["United States", "Japan", "Germany", "South Korea", "Brazil", "United Kingdom",
    "Canada", "Australia", "France", "India", "Netherlands", "Mexico"];
  assert.equal(categoryAxisLayout(countries), "angled");
  assert.equal(categoryAxisLayout(countries.slice(0, 7)), "wrapped");
  assert.equal(categoryAxisLayout(Array.from({ length: 12 }, (_, index) => String(index + 1))), "horizontal");
  assert.equal(categoryAxisLayout(Array.from({ length: 12 }, (_, index) =>
    new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10))), "horizontal");
  assert.equal(categoryAxisLayout(["2026-08-01", "2026-08-02"], { preference: "angled" }), "horizontal");
  assert.equal(categoryAxisLayout(["08:00", "09:00"], { preference: "angled" }), "horizontal");
  assert.equal(categoryAxisLayout(countries, { preference: "horizontal" }), "horizontal");
  assert.equal(categoryAxisLayout(countries, { preference: "wrapped" }), "wrapped");
  assert.equal(categoryAxisLayout(countries.slice(0, 3), { preference: "angled" }), "angled");
  assert.deepEqual(projectChartSpec({ type: "bar", x: "country", y: "users", xTickLabelLayout: "angled" }),
    { type: "bar", x: "country", y: "users", xTickLabelLayout: "angled" });
});

test("Dark Pixel keeps clean semantic chart fills without decorative dithering", async () => {
  const [shell, styles, dashboard, dashboardStyles, theme] = await Promise.all([
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/dashboard.css", import.meta.url), "utf8"),
    readFile(new URL("../../themes/dark-pixel/theme.css", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of Object.entries({ shell, styles, dashboard, dashboardStyles, theme })) {
    assert.doesNotMatch(source, /PixelChartShaders|pixel-chart-dither|data-app-chart-effect|data-chart-effect/u,
      `${name} must not add decorative Dark Pixel shaders or activation metadata`);
  }
  assert.doesNotMatch(dashboard, /regional-map-dots|regional-map-dot-field/u,
    "Regional maps should not retain hidden theme-only dot-pattern assets");
  assert.match(theme, /--card-radius:\s*0/u, "Dark Pixel must retain its distinctive square geometry");
  assert.match(theme, /--font-sans:\s*"Courier New"/u, "Dark Pixel must retain its monospace typography");
  assert.match(theme, /--fixed-theme-scheme:\s*dark/u, "Authored Dark Pixel artifacts must remain genuinely dark");
});

const pick = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
const bridgeValues = (rows, y, x) =>
  waterfall(rows, y, { categoryField: x, includeEnding: true }).map((row) =>
    pick(
      row,
      [
        x,
        "baseline",
        "magnitude",
        "range",
        "change",
        "balance",
        "runningTotal",
        "isTotal",
        "totalType",
        "waterfallRole",
      ].filter(Boolean),
    ),
  );

test("chart types remain explicit while the legacy leaderboard name stays compatible", () => {
  const rows = [
    { category: "Projects", activeUsers: 1800, targetUsers: 1600 },
    { category: "Canvas", activeUsers: 1700, targetUsers: 1550 },
  ];
  const ranking = { type: "horizontalBar", x: "category", y: "activeUsers" };
  assert.equal(resolvedChartType(ranking, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, type: "horizontal-bar" }, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, type: "leaderboard" }, rows), "rankedList");
  assert.equal(resolvedChartType({ ...ranking, xLabel: "Active accounts" }, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, showXAxisLabel: true }, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, fields: ["activeUsers", "targetUsers"] }, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, series: "segment" }, rows), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, colorBySign: true }, rows), "horizontalBar");
  assert.equal(resolvedChartType(ranking, [...rows, { category: "Search", activeUsers: -200 }]), "horizontalBar");
  assert.equal(resolvedChartType(ranking, [...rows, rows[0]]), "horizontalBar");
  assert.equal(resolvedChartType(ranking, [{ category: "2026-08-19", activeUsers: 1800 }]), "horizontalBar");
  assert.equal(resolvedChartType({ ...ranking, type: "stackedBar" }, rows), "stackedBar");
  assert.equal(resolvedChartType({ ...ranking, type: "rankedList" }, rows), "rankedList");
});

test("crowded single-measure vertical bars remain vertical when explicitly authored", () => {
  const rows = ["Enterprise", "Growth", "Starter", "Education", "Community"].map((segment, index) => ({
    segment,
    value: 100 - index * 12,
  }));
  const spec = { type: "bar", x: "segment", y: "value" };
  assert.equal(resolvedChartType(spec, rows), "bar");
  assert.equal(resolvedChartType({ ...spec, xTickLabelLayout: "angled" }, rows), "bar");
  assert.equal(resolvedChartType({ ...spec, fields: ["value", "target"] }, rows), "bar");
  assert.equal(resolvedChartType({ ...spec, showXAxisLabel: true }, rows), "bar");
  assert.equal(resolvedChartType(spec, rows.slice(0, 3)), "bar");
});

test("ranked leaderboards start at five rows and use only genuinely available adjacent height", () => {
  assert.equal(rankedListCapacity({ availableHeight: 196, rowHeight: 36, rowGap: 4, totalCount: 12 }), 5);
  assert.equal(rankedListCapacity({ availableHeight: 316, rowHeight: 36, rowGap: 4, totalCount: 12 }), 8);
  assert.equal(rankedListCapacity({ availableHeight: 800, rowHeight: 36, rowGap: 4, totalCount: 12 }), 12);
  assert.equal(rankedListCapacity({ availableHeight: 20, rowHeight: 36, rowGap: 4, totalCount: 12 }), 5);
  assert.equal(rankedListCapacity({ availableHeight: 316, rowHeight: 36, rowGap: 4, minimumCount: 3, totalCount: 12 }), 8);
});

test("waterfall projection preserves explicit balances and only used total metadata", () => {
  const spec = { type: "waterfall", x: "period", y: "amount" };
  const rows = [
    { period: "FY25", amount: 100, isTotal: true, privateNote: "not chart data" },
    { period: "Expansion", amount: 20 },
    { period: "Interim", amount: 120, isTotal: true },
    { period: "Churn", amount: -10 },
    { period: "FY26", amount: 110, isTotal: true },
  ];
  const projected = project(spec, rows);
  assert.deepEqual(projected.shape.requiredRowFields, ["period", "amount"]);
  assert.deepEqual(projected.shape.optionalRowFields, ["isTotal"]);
  assert.deepEqual(bridgeValues(projected.rows, "amount", "period"), bridgeValues(rows, "amount", "period"));
  assert.deepEqual(
    bridgeValues(projected.rows, "amount", "period").map((row) => row.balance),
    [100, 120, 120, 110, 110],
  );
  assert.ok(projected.rows.every((row) => !Object.hasOwn(row, "privateNote")));

  for (const field of ["totalType", "waterfallRole", "role", "type", "isTotal", "total"]) {
    const flagged = [
      { period: "A", amount: 100, [field]: field.endsWith("Total") || field === "total" ? true : "total" },
      { period: "B", amount: 20 },
    ];
    const result = project(spec, flagged);
    assert.ok(result.shape.rowFields.includes(field), field);
    assert.deepEqual(bridgeValues(result.rows, "amount", "period"), bridgeValues(flagged, "amount", "period"));
  }
  const precedence = [
    { period: "A", amount: 100, totalType: "", role: "beginning", undefined: "ending" },
    { period: "B", amount: 20 },
  ];
  const result = project(spec, precedence);
  assert.ok(result.shape.rowFields.includes("totalType"));
  assert.ok(!result.shape.rowFields.includes("role"));
  assert.ok(!result.shape.rowFields.includes("undefined"));
  assert.deepEqual(bridgeValues(result.rows, "amount", "period"), bridgeValues(precedence, "amount", "period"));
});

test("box plot projection keeps reviewed quartiles or raw observations as appropriate", () => {
  const rows = [
    {
      segment: "A",
      minimum: 1,
      lowerQuartile: 2,
      median: 3,
      upperQuartile: 4,
      maximum: 5,
      privateNote: "not chart data",
    },
  ];
  for (const y of ["median", "latency"]) {
    const spec = { type: "boxPlot", x: "segment", y };
    const result = project(spec, rows);
    assert.equal(result.shape.reviewedBoxPlot, true);
    assert.deepEqual(result.shape.requiredRowFields, ["segment", ...boxPlotSummaryFields]);
    assert.deepEqual(
      boxPlots(result.rows, "segment", y).map((row) => pick(row, ["segment", ...boxPlotSummaryFields, "spread"])),
      boxPlots(rows, "segment", y).map((row) => pick(row, ["segment", ...boxPlotSummaryFields, "spread"])),
    );
    assert.equal(boxPlots(result.rows, "segment", y)[0].spread, 2);
    assert.ok(!result.shape.rowFields.includes("privateNote"));
  }
  const raw = [
    { segment: "A", latency: 1, minimum: -99 },
    { segment: "A", latency: 5, minimum: -99 },
  ];
  const spec = { type: "boxPlot", x: "segment", y: "latency" };
  const result = project(spec, raw);
  assert.equal(result.shape.reviewedBoxPlot, false);
  assert.deepEqual(result.shape.rowFields, ["segment", "latency"]);
  assert.deepEqual(boxPlots(result.rows, "segment", "latency"), boxPlots(raw, "segment", "latency"));
});

test("heatmap projection preserves its inferred dimension and observed intensities", () => {
  const spec = { type: "heatmap", x: "day", y: "count" };
  const rows = [
    { day: "Mon", hour: "09:00", count: 4, privateNote: "first" },
    { day: "Tue", hour: "10:00", count: 7, privateNote: "second" },
  ];
  const result = project(spec, rows);
  assert.equal(result.shape.heatmapGroup, "hour");
  assert.equal(chartDataShape(spec, result.rows).heatmapGroup, "hour");
  assert.deepEqual(result.shape.rowFields, ["day", "hour", "count"]);
  const values = (data) => {
    const value = heatmap(data, "day", "hour", "count");
    return {
      ...value,
      rows: value.rows.map((row) => pick(row, ["day", "hour", "count", "xIndex", "yIndex", "intensity", "__missing"])),
    };
  };
  assert.deepEqual(values(result.rows), values(rows));
  const stringMeasures = [{ day: "Mon", hour: "09:00", count: "4" }];
  const stringResult = project(spec, stringMeasures);
  assert.equal(chartDataShape(spec, stringResult.rows).heatmapGroup, "hour", "Column order survives projection");
  const reversed = heatmap(rows, "day", "hour", "count", {
    xOrder: ["Tue", "Mon"],
    yOrder: ["10:00", "09:00"],
  });
  assert.deepEqual(reversed.xValues, ["Tue", "Mon"]);
  assert.deepEqual(reversed.yValues, ["10:00", "09:00"]);
});

test("histograms and explicit-stage Sankey charts do not require a nominal x column", () => {
  const histogramSpec = { type: "histogram", y: "latency" };
  const samples = [
    { latency: 12, secret: "A" },
    { latency: 29, secret: "B" },
    { latency: 15, secret: "C" },
  ];
  const histogramInput = project(histogramSpec, samples);
  assert.equal(histogramInput.shape.requiresX, false);
  assert.deepEqual(histogramInput.shape.requiredRowFields, ["latency"]);
  assert.deepEqual(histogram(histogramInput.rows, "latency"), histogram(samples, "latency"));

  const rows = [
    { from: "A", via: "B", to: "C", count: 3, secret: "not chart data" },
    { from: "A", via: "D", to: "C", count: 2, secret: "not chart data" },
  ];
  for (const spec of [
    { type: "sankey", source: "from", target: "to", y: "count" },
    { type: "sankey", stages: ["from", "via", "to"], y: "count" },
  ]) {
    const result = project(spec, rows);
    assert.equal(result.shape.requiresX, false);
    assert.deepEqual(result.shape.requiredRowFields, ["count", ...result.shape.sankeyStages]);
    assert.deepEqual(
      sankeyGraph(result.rows, result.shape.sankeyStages, "count"),
      sankeyGraph(rows, result.shape.sankeyStages, "count"),
    );
    assert.ok(!result.shape.rowFields.includes("secret"));
  }
});

test("histograms use a compact set of evenly spaced nice bins", () => {
  const rows = Array.from({ length: 36 }, (_, index) => ({ latency: 8 + ((index * 11) % 43) + (index % 5) * 2 }));
  const buckets = histogram(rows, "latency");
  assert.ok(buckets.length >= 4 && buckets.length <= 8);
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.count, 0), rows.length);
  assert.equal(new Set(buckets.map((bucket) => bucket.end - bucket.start)).size, 1);
  assert.ok(buckets.every((bucket, index) => index === 0 || bucket.start === buckets[index - 1].end));
  for (const offset of [-100, 0, 100]) {
    assert.deepEqual(
      histogram([1, 5, 9, 11, 19, 21].map((value) => ({ latency: value + offset })), "latency"),
      [
        { start: offset, count: 3, end: offset + 10 },
        { start: offset + 10, count: 2, end: offset + 20 },
        { start: offset + 20, count: 1, end: offset + 30 },
      ],
      "Shifting a distribution must preserve its bin widths and counts",
    );
  }
  for (const value of [-120, 0, 120]) {
    const constant = histogram(Array.from({ length: 6 }, () => ({ latency: value })), "latency");
    assert.equal(constant.length, 1);
    assert.equal(constant[0].count, 6);
    assert.ok(constant[0].start <= value && constant[0].end >= value);
    assert.ok(constant[0].end > constant[0].start);
  }
  assert.deepEqual(histogram([], "latency"), []);
});

test("long-form line barFields name pivoted series; wide-form barFields name raw columns", () => {
  const spec = { type: "line", x: "date", y: "value", series: "metric", barFields: ["Revenue"] };
  const rows = [
    { date: "2026-01-01", metric: "Revenue", value: 12, secret: "A" },
    { date: "2026-01-01", metric: "Target", value: 14, secret: "B" },
    { date: "2026-01-02", metric: "Revenue", value: 15, secret: "C" },
  ];
  const result = project(spec, rows);
  assert.equal(result.shape.longForm, true);
  assert.deepEqual(result.shape.fields, ["Revenue", "Target"]);
  assert.deepEqual(result.shape.barFields, ["Revenue"]);
  assert.deepEqual(result.shape.requiredRowFields, ["date", "value", "metric"]);
  assert.ok(!result.shape.rowFields.includes("Revenue"));
  assert.deepEqual(pivot(result.rows, "date", "metric", "value"), pivot(rows, "date", "metric", "value"));

  const wide = { type: "line", x: "date", y: "Revenue", fields: ["Revenue", "Target"], barFields: ["Growth"] };
  const wideRows = [{ date: "2026-01-01", Revenue: 12, Target: 14, Growth: 3, secret: "A" }];
  const wideResult = project(wide, wideRows);
  assert.equal(wideResult.shape.longForm, false);
  assert.deepEqual(wideResult.shape.requiredRowFields, ["date", "Revenue", "Target", "Growth"]);
  assert.deepEqual(wideResult.rows, [{ date: "2026-01-01", Revenue: 12, Target: 14, Growth: 3 }]);
});

test("scatter projection retains the actual tooltip identities without arbitrary extra columns", () => {
  const spec = { type: "scatter", x: "cost", y: "latency" };
  const rows = [
    { cost: 1, latency: 2, featureName: "Search", name: "unused", secret: "A" },
    { cost: 2, latency: 3, name: "Export", secret: "B" },
  ];
  const result = project(spec, rows);
  assert.deepEqual(
    result.rows.map((row) => row[scatterTooltipIdentityField(row)]),
    ["Search", "Export"],
  );
  assert.ok(!result.shape.rowFields.includes("secret"));
});

test("shareable chart specs retain canonical options and drop extension metadata", () => {
  const spec = {
    type: "line",
    x: "week",
    y: "activeUsers",
    fields: ["activeUsers", "targetUsers"],
    barFields: ["growth"],
    showArea: true,
    stackable: false,
    colorByColumn: true,
    labelMaxLength: 14,
    penultimateLabelAlignment: "right",
    sankeyLabelFontSize: 13,
    sankeyNodeWidth: 18,
    sankeyValueFontSize: 11,
    axisFontSize: 14,
    axisColor: "#f00",
    hoverHighlight: { color: "var(--text)", width: 44, privateMetadata: "secret" },
    colors: { activeUsers: "var(--chart-1)", privateMetadata: { sql: "secret" } },
    colorDomain: [0, 12, "secret"],
    colorBands: [
      { max: 0.2, color: "#f00", label: "Bad", privateMetadata: "secret" },
      { color: "#00f" },
      { max: 1, privateMetadata: "secret" },
    ],
    legend: { position: "right", privateMetadata: "secret" },
    privateMetadata: "secret",
    sql: "secret",
    url: "secret",
  };
  assert.deepEqual(projectChartSpec(spec), {
    type: "line",
    x: "week",
    y: "activeUsers",
    stackable: false,
    colorByColumn: true,
    labelMaxLength: 14,
    penultimateLabelAlignment: "right",
    sankeyLabelFontSize: 13,
    sankeyNodeWidth: 18,
    sankeyValueFontSize: 11,
    hoverHighlight: { color: "var(--text)", width: 44 },
    fields: ["activeUsers", "targetUsers"],
    barFields: ["growth"],
    colors: { activeUsers: "var(--chart-1)" },
    colorDomain: [0, 12],
    colorBands: [{ max: 0.2, color: "#f00", label: "Bad" }, { color: "#00f" }],
    legend: { position: "right" },
  });
});

test("funnel stages preserve source order and calculate only valid prior-stage conversion", () => {
  const stages = funnelStages(
    [
      { stage: "Visited", accounts: 100 },
      { stage: "Signed up", accounts: 60 },
      { stage: "Activated", accounts: 30 },
    ],
    "stage",
    "accounts",
  );
  assert.deepEqual(
    stages.map(({ __funnelStage, __funnelConversion }) => [__funnelStage, __funnelConversion]),
    [
      ["Visited", undefined],
      ["Signed up", 0.6],
      ["Activated", 0.5],
    ],
  );
  assert.deepEqual(stages.map(({ __funnelShare, __funnelDropoff }) => [__funnelShare, __funnelDropoff]),
    [[1, undefined], [.6, 40], [.3, 30]], "Overall conversion and step conversion must stay distinct");
  assert.deepEqual(stages.map(({ __funnelChange }) => __funnelChange), [undefined, -.4, -.5]);
  const zero = funnelStages(
    [
      { stage: "Empty", accounts: 0 },
      { stage: "Later", accounts: 2 },
    ],
    "stage",
    "accounts",
  );
  assert.equal(zero[1].__funnelConversion, undefined);
  assert.equal(zero[1].__funnelShare, undefined);
  assert.equal(zero[1].__funnelChange, undefined, "A zero denominator cannot imply a percent change");
  assert.equal(funnelStages([{ count: 20 }, { count: 0 }], "stage", "count")[1].__funnelChange, -1);
  const missing = funnelStages(
    [
      { stage: "Known", accounts: 100 },
      { stage: "Unavailable", accounts: null },
      { stage: "Blank", accounts: "" },
      { stage: "Resumed", accounts: 30 },
    ],
    "stage",
    "accounts",
  );
  assert.deepEqual(
    missing.map(({ __funnelValue, __funnelConversion }) => [__funnelValue, __funnelConversion]),
    [
      [100, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [30, undefined],
    ],
  );
});

test("horizontal funnel geometry preserves proportional values, flat endings, gaps, and increases", () => {
  const stages = funnelStages([
    { stage: "First", count: "100" }, { stage: "Second", count: 60 }, { stage: "Third", count: 30 },
  ], "stage", "count");
  const [segment] = funnelRibbonSegments(stages);
  assert.deepEqual(segment.points, [{ x: 50, height: 180 }, { x: 150, height: 108 }, { x: 250, height: 54 }]);
  assert.match(segment.path, /L 300 73 L 300 127/u, "The last stage must not taper to an invented zero");
  const invalid = [null, "", -1, true, {}, Infinity, NaN];
  for (const count of invalid) {
    const rows = funnelStages([{ stage: "First", count: 100 }, { stage: "Missing", count },
      { stage: "Last", count: 20 }], "stage", "count");
    assert.equal(rows[1].__funnelValue, undefined);
    assert.equal(rows[2].__funnelConversion, undefined);
    assert.equal(funnelRibbonSegments(rows).length, 2, "Missing stages must break the ribbon, not become zero");
  }
  const growing = funnelStages([{ stage: "First", count: 50 }, { stage: "Last", count: 100 }], "stage", "count");
  assert.equal(growing[1].__funnelShare, 2);
  assert.equal(growing[1].__funnelDropoff, -50);
  assert.equal(growing[1].__funnelChange, 1, "An increasing stage has a positive change, not a drop-off percentage");
  assert.deepEqual(funnelRibbonSegments(growing)[0].points.map(({ height }) => height), [90, 180]);
  assert.deepEqual(funnelRibbonSegments([]), []);
  assert.deepEqual(funnelRibbonSegments(funnelStages([{ stage: "Empty", count: 0 }], "stage", "count"))[0].points,
    [{ x: 50, height: 0 }], "Zero must remain zero thickness");
});

test("funnel shades start at the unchanged core hue, including single-stage funnels", () => {
  for (const count of [1, 4, 8]) assert.equal(funnelStageColor("var(--chart-2)", 0, count), "var(--chart-2)");
  assert.equal(funnelStageColor("var(--chart-2)", 3, 4), "color-mix(in srgb, var(--chart-2) 24%, var(--surface))");
  assert.notEqual(funnelStageColor("var(--chart-2)", 0, 4, true), funnelStageColor("var(--chart-2)", 0, 4),
    "A fully saturated first stage must still have an active treatment");
});

test("funnel layout follows its own width and stage count at both density boundaries", () => {
  for (const count of [1, 4, 8]) {
    assert.equal(funnelLayout(count * 144, count), "horizontal");
    assert.equal(funnelLayout(count * 144 - 1, count), "compact");
    assert.equal(funnelLayout(count * 120, count), "compact");
    assert.equal(funnelLayout(count * 120 - 1, count), "vertical");
  }
});


test("heatmap hit areas tile without gaps or overlaps at ordinary and dense sizes", () => {
  assert.deepEqual(heatmapCellSize(240,160,4,4), {pitchX:60,pitchY:40,width:55,height:35});
  const dense = heatmapCellSize(100,60,40,30);
  assert.equal(dense.pitchX * 40, 100);
  assert.equal(dense.pitchY * 30, 60);
  assert.ok(dense.width < dense.pitchX && dense.height < dense.pitchY);
  assert.deepEqual(heatmapCellSize(0,0,0,0), {pitchX:0,pitchY:0,width:0,height:0});
});

test("cohort heatmaps preserve unknown cells, fixed scales and safe label metadata", async () => {
  const { heatmap } = await import("../src/charting/chart-transforms.js");
  const data = heatmap([{ age: "M1", cohort: "A", rate: 0 }, { age: "M2", cohort: "A", rate: null },
    { age: "M1", cohort: "B", rate: 0.9 }], "age", "cohort", "rate", { domain: [0, 1], missingValues: "gap" });
  assert.equal(data.minimum, 0); assert.equal(data.maximum, 1);
  assert.equal(data.rows.filter(row => row.__unknown).length, 2);
  assert.equal(data.rows.find(row => row.cohort === "A" && row.age === "M1").rate, 0);
  assert.equal(data.rows.find(row => row.cohort === "B" && row.age === "M2").rate, null);
  const spec = projectChartSpec({ type: "heatmap", missingValues: "gap", reverseRows: true,
    tooltipFields: [{ field: "retained", label: "Retained customers", sql: "private" }] });
  assert.deepEqual(spec.tooltipFields, [{ field: "retained", label: "Retained customers" }]);
  assert.equal(spec.missingValues, "gap");
});

test("vertical funnel percentages sit left of right-aligned values", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(styles,
    /data-funnel-layout="vertical"\] \.chart-funnel-stage-share \{ grid-column: 2; grid-row: 1; padding: 0; \}/u);
  assert.match(styles,
    /data-funnel-layout="vertical"\] \.chart-funnel-stage-value \{ grid-column: 3; grid-row: 1; padding: 0; text-align: end; \}/u);
});

test("repeated weekday observations keep chronological input order", () => {
  const rows = ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"].map((day, index) => ({ day, value: index }));
  assert.deepEqual(orderCalendarRows(rows, "day"), rows);
  assert.deepEqual(orderCalendarRows([{ day: "Wed" }, { day: "Mon" }, { day: "Tue" }], "day"), [{ day: "Mon" }, { day: "Tue" }, { day: "Wed" }]);
});

test("funnel stages preserve source order and calculate only valid prior-stage conversion", () => {
  const stages = funnelStages(
    [
      { stage: "Visited", accounts: 100 },
      { stage: "Signed up", accounts: 60 },
      { stage: "Activated", accounts: 30 },
    ],
    "stage",
    "accounts",
  );
  assert.deepEqual(
    stages.map(({ __funnelStage, __funnelConversion }) => [__funnelStage, __funnelConversion]),
    [
      ["Visited", undefined],
      ["Signed up", 0.6],
      ["Activated", 0.5],
    ],
  );
  assert.deepEqual(stages.map(({ __funnelShare, __funnelDropoff }) => [__funnelShare, __funnelDropoff]),
    [[1, undefined], [.6, 40], [.3, 30]], "Overall conversion and step conversion must stay distinct");
  assert.deepEqual(stages.map(({ __funnelChange }) => __funnelChange), [undefined, -.4, -.5]);
  const zero = funnelStages(
    [
      { stage: "Empty", accounts: 0 },
      { stage: "Later", accounts: 2 },
    ],
    "stage",
    "accounts",
  );
  assert.equal(zero[1].__funnelConversion, undefined);
  assert.equal(zero[1].__funnelShare, undefined);
  assert.equal(zero[1].__funnelChange, undefined, "A zero denominator cannot imply a percent change");
  assert.equal(funnelStages([{ count: 20 }, { count: 0 }], "stage", "count")[1].__funnelChange, -1);
  const missing = funnelStages(
    [
      { stage: "Known", accounts: 100 },
      { stage: "Unavailable", accounts: null },
      { stage: "Blank", accounts: "" },
      { stage: "Resumed", accounts: 30 },
    ],
    "stage",
    "accounts",
  );
  assert.deepEqual(
    missing.map(({ __funnelValue, __funnelConversion }) => [__funnelValue, __funnelConversion]),
    [
      [100, undefined],
      [undefined, undefined],
      [undefined, undefined],
      [30, undefined],
    ],
  );
});

test("horizontal funnel geometry preserves proportional values, flat endings, gaps, and increases", () => {
  const stages = funnelStages([
    { stage: "First", count: "100" }, { stage: "Second", count: 60 }, { stage: "Third", count: 30 },
  ], "stage", "count");
  const [segment] = funnelRibbonSegments(stages);
  assert.deepEqual(segment.points, [{ x: 50, height: 180 }, { x: 150, height: 108 }, { x: 250, height: 54 }]);
  assert.match(segment.path, /L 300 73 L 300 127/u, "The last stage must not taper to an invented zero");
  const invalid = [null, "", -1, true, {}, Infinity, NaN];
  for (const count of invalid) {
    const rows = funnelStages([{ stage: "First", count: 100 }, { stage: "Missing", count },
      { stage: "Last", count: 20 }], "stage", "count");
    assert.equal(rows[1].__funnelValue, undefined);
    assert.equal(rows[2].__funnelConversion, undefined);
    assert.equal(funnelRibbonSegments(rows).length, 2, "Missing stages must break the ribbon, not become zero");
  }
  const growing = funnelStages([{ stage: "First", count: 50 }, { stage: "Last", count: 100 }], "stage", "count");
  assert.equal(growing[1].__funnelShare, 2);
  assert.equal(growing[1].__funnelDropoff, -50);
  assert.equal(growing[1].__funnelChange, 1, "An increasing stage has a positive change, not a drop-off percentage");
  assert.deepEqual(funnelRibbonSegments(growing)[0].points.map(({ height }) => height), [90, 180]);
  assert.deepEqual(funnelRibbonSegments([]), []);
  assert.deepEqual(funnelRibbonSegments(funnelStages([{ stage: "Empty", count: 0 }], "stage", "count"))[0].points,
    [{ x: 50, height: 0 }], "Zero must remain zero thickness");
});

test("funnel shades start at the unchanged core hue, including single-stage funnels", () => {
  for (const count of [1, 4, 8]) assert.equal(funnelStageColor("var(--chart-2)", 0, count), "var(--chart-2)");
  assert.equal(funnelStageColor("var(--chart-2)", 3, 4), "color-mix(in srgb, var(--chart-2) 24%, var(--surface))");
  assert.notEqual(funnelStageColor("var(--chart-2)", 0, 4, true), funnelStageColor("var(--chart-2)", 0, 4),
    "A fully saturated first stage must still have an active treatment");
});

test("funnel layout follows its own width and stage count at both density boundaries", () => {
  for (const count of [1, 4, 8]) {
    assert.equal(funnelLayout(count * 144, count), "horizontal");
    assert.equal(funnelLayout(count * 144 - 1, count), "compact");
    assert.equal(funnelLayout(count * 120, count), "compact");
    assert.equal(funnelLayout(count * 120 - 1, count), "vertical");
  }
});
