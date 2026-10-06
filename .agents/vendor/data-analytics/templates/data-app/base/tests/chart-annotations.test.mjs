import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationChartTypes,
  benchmarkAnnotationDomain,
  bindChartAnnotationAxes,
  chartAnnotationFields,
  maxChartAnnotations,
  normalizeChartAnnotations,
  resolveChartAnnotations,
} from "../src/charting/chart-annotations.js";
import { chartDataShape, projectChartSpec, secondaryAxisFields } from "../src/charting/chart-data-shape.js";
import { pivot } from "../src/charting/chart-transforms.js";
import { displayValue } from "../src/charting/chart-theme.js";

const days = ["2026-01-01", "2026-01-02", "2026-01-03"];
const annotations = [
  { id: "target", kind: "benchmark", label: "Reviewed target", field: "target", measure: "amount" },
  { id: "launch", kind: "event", label: "Launch", field: "event", at: days[1] },
  { id: "window", kind: "range", label: "Review window", at: days[0], end: days[2] },
  { id: "peak", kind: "point", label: "Observed peak", field: "amount", at: days[2] },
];
const spec = { type: "line", x: "date", y: "amount", annotations };
const rows = [
  { date: days[0], amount: 10, target: 20, event: "", privateNote: "unrelated" },
  { date: days[1], amount: 14, target: 20, event: "Public launch", privateNote: "unrelated" },
  { date: days[2], amount: 19, target: 20, event: false, privateNote: "unrelated" },
];
const projectRows = (chart, data) => {
  const fields = chartDataShape(chart, data).rowFields;
  return data.map((row) => Object.fromEntries(fields.filter((field) => Object.hasOwn(row, field)).map((field) => [field, row[field]])));
};
const resolve = (annotation, data = rows, overrides = {}, options) =>
  resolveChartAnnotations({ ...spec, ...overrides, annotations: [annotation] }, data, options);

test("numeric annotations follow their plotted measure's axis without changing authored evidence", () => {
  const data = rows.map((row, index) => ({ ...row, conversion: 0.4 + index / 10, conversionTarget: 0.9 }));
  const chart = { ...spec, fields: ["amount", "conversion"], annotations: [...annotations,
    { id: "rate-target", kind: "benchmark", label: "Rate target", measure: "conversion", field: "conversionTarget" },
    { id: "rate-point", kind: "point", label: "Rate observation", field: "conversion", at: days[2] },
  ] };
  const before = structuredClone(chart);
  const resolved = resolveChartAnnotations(chart, data);
  const right = secondaryAxisFields(chart, data, chart.fields);
  assert.deepEqual(right, ["conversion"]);
  const bound = bindChartAnnotationAxes(resolved, right);
  assert.deepEqual(bound.map(({ valueAxisId }) => valueAxisId), [0, 0, 0, 0, "secondary", "secondary"]);
  assert.deepEqual(bound.map(({ valueAxisId, ...annotation }) => annotation), resolved);
  assert.deepEqual(chart, before);
  assert.ok(bindChartAnnotationAxes(resolved, []).every(({ valueAxisId }) => valueAxisId === 0),
    "Explicitly opting out of a secondary axis returns all annotations to the primary axis");
  const reassigned = bindChartAnnotationAxes(resolved, ["amount"]);
  assert.deepEqual(reassigned.map(({ valueAxisId }) => valueAxisId), ["secondary", 0, 0, "secondary", 0, 0]);
  assert.deepEqual(bindChartAnnotationAxes(resolveChartAnnotations(chart, data, { visibleFields: ["conversion"] }), right)
    .map(({ id }) => id), ["launch", "window", "rate-target", "rate-point"]);
  assert.deepEqual(bindChartAnnotationAxes(resolveChartAnnotations({ ...chart, showAnnotations: false }, data), right), []);
});

test("only edge benchmarks reserve bounded value-domain room while preserving zero and reviewed values",()=>{
  const domain=[160,194],before=structuredClone(domain);
  const result=benchmarkAnnotationDomain([180],domain,260);
  assert.deepEqual(result,[0,266.75]);
  assert.deepEqual(domain,before);
  assert.deepEqual(benchmarkAnnotationDomain([-180],[-194,-160],260),[-266.75,0]);
  const mixed=benchmarkAnnotationDomain([-180,180],[-194,194],260);
  assert.ok(mixed[0]<-194&&mixed[1]>194);
  assert.equal(benchmarkAnnotationDomain([190],domain,260,false)[0],160,"An explicitly nonzero axis keeps its lower bound");
  assert.deepEqual(benchmarkAnnotationDomain([190],[160,192,null,undefined,""," ","0"],260,false),
    benchmarkAnnotationDomain([190],[160,192],260,false),"Missing values never become zero on a focused axis");
  assert.equal(benchmarkAnnotationDomain([190],[0,160,192],260,false)[0],0,"A real reviewed zero remains in the domain");
  for(const height of[1,100,260,600]) {
    const [low,high]=benchmarkAnnotationDomain([180],domain,height);
    assert.equal(low,0);assert.ok((high-194)/high<=0.3+1e-12,"Headroom is at most30% of the displayed range");
  }
  for(const [values,bounds,height,zero,ratio]of[
    [[],domain,260,true,false],[[90],[0,194],260,true,false],[[0.9],[0,1],260,true,true],
    [[180],domain,Infinity,true,false],[[1],[NaN,Infinity],260,true,false],
    [[1e308],[-1e308,1e308],260,true,false],[[Number.MAX_VALUE],[0,Number.MAX_VALUE],260,true,false],
  ])assert.equal(benchmarkAnnotationDomain(values,bounds,height,zero,ratio),undefined,
    "No benchmark, interior threshold, bounded ratio, or unsafe arithmetic retains the normal axis");
  const hidden=resolveChartAnnotations(spec,rows,{visibleFields:[]});
  assert.equal(benchmarkAnnotationDomain(hidden.filter(a=>a.kind==="benchmark").map(a=>a.y),domain,260),undefined);
});

test("bar annotations do not misrepresent sorted periods or grouped mark positions", () => {
  for (const type of ["bar", "horizontalBar"]) {
    assert.deepEqual(resolve(annotations[2], rows, { type, sortOrder: "descending" }), []);
    assert.equal(resolve(annotations[2], rows, { type }).length, 1);
    assert.deepEqual(resolve(annotations[3], rows, { type, fields: ["amount", "target"] }), []);
    assert.equal(resolve(annotations[3], rows, { type, fields: ["amount", "target"] }, { visibleFields: ["amount"] }).length, 1);
  }
});

test("range annotations require a chronological rendered domain without reordering reviewed rows", () => {
  const shuffled = [rows[0], { date: "2026-01-04", amount: 21 }, rows[1], rows[2]];
  const before = structuredClone(shuffled);
  for (const type of annotationChartTypes) {
    assert.deepEqual(resolve(annotations[2], shuffled, { type }), [],
      "An out-of-range date between the endpoints must not be shaded as part of the interval");
    assert.equal(resolve(annotations[2], rows, { type }).length, 1);
    assert.deepEqual(resolve(annotations[2], rows, { type }, { data: shuffled }), [],
      "The rendered domain, not only the raw input order, determines range eligibility");
  }
  assert.deepEqual(shuffled, before);

  const dates = ["2026-01-01T00:00:00Z", "2026-01-01T02:00:00+03:00", "2026-01-01T03:00:00Z"];
  const offsetRows = dates.map((date, index) => ({ date, amount: index + 1 }));
  const range = { ...annotations[2], at: dates[0], end: dates[2] };
  assert.deepEqual(resolve(range, offsetRows), [], "ISO offsets are compared as instants, not strings");
  assert.equal(resolve(range, [offsetRows[1], offsetRows[0], offsetRows[2]]).length, 1);
});

test("benchmarks disappear when their intended measure is edited or hidden", () => {
  assert.deepEqual(resolve(annotations[0], rows, { y: "target" }), []);
  assert.deepEqual(resolve(annotations[0], rows, {}, { visibleFields: ["other"] }), []);
  assert.deepEqual(resolve(annotations[0], rows, { fields: ["amount"], barFields: ["amount"] }), []);
  assert.throws(() => normalizeChartAnnotations([{ id: "target", kind: "benchmark", label: "Target", field: "target" }]), /plotted measure/u);
});

test("authored annotation schema is bounded, scalar-only, exact, and immutable", () => {
  assert.equal(maxChartAnnotations, 8);
  assert.deepEqual(normalizeChartAnnotations(undefined), []);
  const normalized = normalizeChartAnnotations(annotations);
  assert.deepEqual(normalized, annotations);
  assert.notEqual(normalized, annotations);
  assert.notEqual(normalized[0], annotations[0]);
  assert.deepEqual(chartAnnotationFields(annotations), ["target", "event", "amount"]);
  assert.deepEqual(normalizeChartAnnotations([{ ...annotations[0], id: " target ", label: " Target " }])[0], {
    ...annotations[0], id: "target", label: "Target",
  });

  for (const invalid of [
    null, {}, "annotations", Array.from({ length: 9 }, (_, index) => ({ ...annotations[0], id: String(index) })),
    [annotations[0], { ...annotations[1], id: " target " }],
    [{ ...annotations[0], kind: "__proto__" }],
    [{ ...annotations[0], kind: { nested: "benchmark" } }],
    [{ ...annotations[0], id: "" }],
    [{ ...annotations[0], label: "x".repeat(161) }],
    [{ ...annotations[0], field: "" }],
    [{ ...annotations[0], field: { rows: [1] } }],
    [{ ...annotations[0], value: 20 }],
    [{ ...annotations[0], rows: [{ target: 20 }] }],
    [{ ...annotations[0], provenance: { sql: "secret" } }],
    [{ ...annotations[0], at: null }],
    [{ ...annotations[1], at: Infinity }],
    [{ ...annotations[1], at: {} }],
    [{ ...annotations[1], at: "Release A" }],
    [{ ...annotations[1], at: "2026-02-30" }],
    [{ ...annotations[2], field: "amount" }],
    [{ ...annotations[2], end: days[0] }],
    [{ ...annotations[2], at: "2026-02-30", end: "2026-03-04" }],
    [{ ...annotations[2], at: 1, end: 2 }],
    [{ ...annotations[3], end: days[2] }],
  ]) assert.throws(() => normalizeChartAnnotations(invalid), /annotation/i, JSON.stringify(invalid));
});

test("all four kinds resolve only reviewed coordinates and readable evidence", () => {
  const result = resolveChartAnnotations(spec, rows);
  assert.deepEqual(result.map(({ id, x, xEnd, y }) => ({ id, x, xEnd, y })), [
    { id: "target", x: undefined, xEnd: undefined, y: 20 },
    { id: "launch", x: days[1], xEnd: undefined, y: undefined },
    { id: "window", x: days[0], xEnd: days[2], y: undefined },
    { id: "peak", x: days[2], xEnd: undefined, y: 19 },
  ]);
  assert.match(result[0].evidence, /Target = 20/u);
  assert.match(result[1].evidence, /Public launch/u);
  assert.equal(result[2].evidence, `Date: ${displayValue(days[0])} to ${displayValue(days[2])}`);
  assert.equal(result[3].evidence, `Amount = 19 at ${displayValue(days[2])}`);
  assert.deepEqual(resolveChartAnnotations(spec, rows), result, "resolution does not mutate source rows");
});

test("annotation visibility hides all four kinds without deleting their authored evidence", () => {
  const before = structuredClone({ spec, rows });
  const visible = resolveChartAnnotations(spec, rows);
  assert.equal(visible.length, 4, "Existing charts show annotations when the setting is absent");
  assert.deepEqual(resolveChartAnnotations({ ...spec, showAnnotations: true }, rows), visible);
  const hidden = { ...spec, showAnnotations: false };
  assert.deepEqual(resolveChartAnnotations(hidden, rows), []);
  assert.deepEqual(hidden.annotations, before.spec.annotations);
  assert.deepEqual(resolveChartAnnotations({ ...hidden, showAnnotations: true }, rows), visible,
    "Showing annotations again restores the same coordinates and evidence");
  assert.deepEqual({ spec, rows }, before);
});

test("hidden annotations still validate their authored schema before resolution", () => {
  for (const invalid of [null, [{ ...annotations[0], rows }], [{ ...annotations[3], at: null }]]) {
    assert.throws(() => resolveChartAnnotations({ ...spec, showAnnotations: false, annotations: invalid }, rows),
      /annotation/i, "Visibility must not bypass annotation validation");
  }
});

test("benchmarks need a single reviewed numeric value in their current scope", () => {
  const target = annotations[0];
  const changed = rows.map((row, index) => ({ ...row, target: index + 20 }));
  assert.deepEqual(resolve(target, changed), []);
  assert.equal(resolve({ ...target, at: days[1] }, changed)[0].y, 21);
  assert.deepEqual(resolve({ ...target, at: "2026-01-04" }, changed), []);
  for (const value of [null, undefined, "20", NaN, Infinity]) {
    assert.deepEqual(resolve(target, [{ ...rows[0], target: value }]), []);
  }
  assert.deepEqual(resolve(target, [rows[0], { ...rows[1], target: undefined }]), []);
  assert.equal(resolve(target, [rows[0]], {}, { data: [rows[0]], visibleFields: ["amount"] })[0].y, 20,
    "the benchmark need not be a drawn series");
});

test("event, range, and point anchors must survive the exact plotted domain", () => {
  assert.deepEqual(resolve(annotations[1], rows.slice(2)), []);
  assert.deepEqual(resolve(annotations[2], rows.slice(1)), []);
  assert.deepEqual(resolve(annotations[3], rows.slice(0, 2)), []);
  assert.deepEqual(resolve(annotations[3], rows, {}, { data: rows.slice(0, 2), visibleFields: ["amount"] }), []);
  assert.deepEqual(resolve(annotations[3], rows, {}, { data: rows, visibleFields: ["target"] }), []);
  assert.deepEqual(resolve(annotations[3], rows, { barFields: ["amount"] }), []);
  assert.deepEqual(resolve(annotations[2], rows, {}, { visibleFields: [] }), []);
  assert.deepEqual(resolve(annotations[2], [...rows, { date: "Unscheduled", amount: 1 }]), []);
  assert.deepEqual(resolve(annotations[2], [...rows].reverse()), [], "the rendered range cannot run backwards");
  assert.deepEqual(resolve({ ...annotations[3], at: 1 }, [{ date: "1", amount: 10 }]), [], "no string coercion of anchors");
  for (const event of [false, 1, 0, "", "  ", null, {}, []]) {
    assert.deepEqual(resolve(annotations[1], [{ ...rows[1], event }]), []);
  }
  assert.equal(resolve(annotations[1], [{ ...rows[1], event: true }])[0].x, days[1]);
  assert.deepEqual(resolve(annotations[1], [rows[1], { ...rows[1], event: "Conflicting event" }]), []);
  assert.deepEqual(resolve(annotations[1], [{ ...rows[1], event: true }, { ...rows[1], event: "true" }]), []);
  assert.equal(resolve(annotations[1], [rows[1], { ...rows[1], event: " Public launch " }]).length, 1);
  assert.ok(resolve(annotations[1], [{ ...rows[1], event: "x".repeat(10_000) }])[0].evidence.length < 300);
  assert.equal(resolve({ ...annotations[3], field: "active_users" }, [{ ...rows[2], active_users: 12345.6789 }], {
    y: "active_users",
  })[0].evidence, `Active users = ${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 21 }).format(12345.6789)} at ${displayValue(days[2])}`);
  assert.deepEqual(resolve(annotations[3], [rows[2], { ...rows[2], amount: 99 }]), []);
  assert.equal(resolve(annotations[3], [rows[2], { ...rows[2] }])[0].y, 19);
});

test("v1 coordinates stay on explicitly supported primary-axis chart types", () => {
  assert.deepEqual(annotationChartTypes, ["line", "area", "bar", "horizontalBar"]);
  for (const type of annotationChartTypes) assert.equal(resolve(annotations[3], rows, { type })[0].y, 19);
  for (const type of ["stackedBar", "stackedBar100", "stackedArea", "leaderboard", "scatter", "sparkline", "pie", "waterfall"]) {
    assert.deepEqual(resolve(annotations[3], rows, { type }), []);
  }
});

test("long-form point evidence maps to the visible reviewed series without trusting pivot collisions", () => {
  const longRows = [
    { date: days[0], metric: "Revenue", value: 10, target: 15, event: "Launch" },
    { date: days[0], metric: "Margin", value: 3, target: 15, event: "" },
    { date: days[1], metric: "Revenue", value: 12, target: 15, event: "" },
  ];
  const point = { id: "revenue", kind: "point", label: "Revenue", field: "Revenue", at: days[0] };
  const chart = { type: "line", x: "date", y: "value", series: "metric", annotations: [point] };
  const run = (data, visibleFields = ["Revenue", "Margin"]) =>
    resolveChartAnnotations(chart, data, { data: pivot(data, "date", "metric", "value"), visibleFields });
  assert.equal(run(longRows)[0].y, 10);
  assert.deepEqual(run(longRows, ["Margin"]), []);
  assert.deepEqual(run([...longRows, { ...longRows[0], value: 100 }]), []);
  assert.equal(run([...longRows, { ...longRows[0] }])[0].y, 10);
  assert.deepEqual(run([...longRows, { ...longRows[0], value: null }]), []);
});

test("projection keeps annotation evidence and strips unrelated source and spec metadata", () => {
  const chart = { ...spec, privateMetadata: { secret: true }, referenceLines: [{ value: 99 }] };
  const projected = projectChartSpec(chart);
  assert.deepEqual(projected, spec);
  assert.notEqual(projected.annotations, annotations);
  assert.throws(() => projectChartSpec({ ...spec, annotations: [{ ...annotations[0], rows }] }), /annotation/i);
  const shape = chartDataShape(projected, rows);
  assert.deepEqual(shape.requiredRowFields, ["date", "amount"]);
  assert.deepEqual(shape.optionalRowFields, ["target", "event"]);
  const projectedRows = projectRows(projected, rows);
  assert.ok(projectedRows.every((row) => !Object.hasOwn(row, "privateNote")));
  assert.deepEqual(resolveChartAnnotations(projected, projectedRows), resolveChartAnnotations(spec, rows));

  const longChart = {
    type: "line", x: "date", y: "value", series: "metric",
    annotations: [annotations[0], annotations[1], { ...annotations[3], field: "Revenue" }],
  };
  const longRows = rows.map((row) => ({ ...row, metric: "Revenue", value: row.amount, Revenue: "not a plotted raw column" }));
  const longProjected = projectRows(longChart, longRows);
  assert.ok(longProjected.every((row) => !Object.hasOwn(row, "Revenue") && !Object.hasOwn(row, "amount")));
  const run = (data) => resolveChartAnnotations(projectChartSpec(longChart), data, {
    data: pivot(data, "date", "metric", "value"), visibleFields: ["Revenue"],
  });
  assert.deepEqual(run(longProjected), run(longRows));
});

test("chart projection retains hidden annotation references and their reviewed fields", () => {
  const before = structuredClone({ spec, rows });
  assert.equal(Object.hasOwn(projectChartSpec(spec), "showAnnotations"), false);
  for (const showAnnotations of [false, true]) {
    const chart = { ...spec, showAnnotations };
    const projected = projectChartSpec(chart);
    assert.deepEqual(projected, chart);
    assert.notEqual(projected.annotations, chart.annotations);
    assert.deepEqual(chartDataShape(projected, rows), chartDataShape(spec, rows));
    const projectedRows = projectRows(projected, rows);
    assert.deepEqual(projectedRows, projectRows(spec, rows),
      "Hiding marks must not discard their source fields from the chart payload");
    assert.deepEqual(resolveChartAnnotations({ ...projected, showAnnotations: true }, projectedRows),
      resolveChartAnnotations(spec, rows));
  }
  assert.deepEqual({ spec, rows }, before);
});
