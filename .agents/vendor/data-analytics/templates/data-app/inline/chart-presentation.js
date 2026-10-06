import { chartDataShape, chartSpecKeys, projectChartSpec, resolvedChartType } from "../base/src/charting/chart-data-shape.js";
import { changeChartEditorSpec } from "../base/src/charting/chart-editor-state.js";
import { chartTypes } from "../base/src/charting/chart-theme.js";

const conventionalTypes = new Set(["line", "area", "bar", "horizontalBar", "sparkline"]);
const stackedTypes = new Set(["stackedArea", "stackedBar", "horizontalStackedBar"]);
const proportionalTypes = new Set(["stackedBar100", "horizontalStackedBar100"]);
const editableKeys = new Set([
  "type",
  "x",
  "y",
  "series",
  "fields",
  "xLabel",
  "yLabel",
  "yAxisPosition",
  "rightAxisFields",
  "showXAxisLabel",
  "showYAxisLabel",
  "startAtZero",
  "showValues",
  "showLegend",
  "showAnnotations",
  "baseColor",
  "colors",
  "sortOrder",
]);
const booleanKeys = new Set([
  "showXAxisLabel",
  "showYAxisLabel",
  "startAtZero",
  "showValues",
  "showLegend",
  "showAnnotations",
]);
const knownKeys = new Set(chartSpecKeys);
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const record = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);

function fail(message) {
  throw new Error(`Cannot apply chart edit: ${message}`);
}

function boundedText(value, label, { empty = false, max = 500 } = {}) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) {
    fail(`${label} must be ${empty ? "text" : "nonempty text"} of at most ${max} characters.`);
  }
  return value.trim();
}

function cleanChart(spec) {
  const chart = projectChartSpec(spec);
  chart.type = resolvedChartType(chart);
  for (const key of Object.keys(chart)) if (chart[key] === undefined) delete chart[key];
  return chart;
}

/** The reviewed payload remains the reset point; no source data enters presentation state. */
export function originalInlineChartPresentation(component) {
  return {
    chart: cleanChart(component.chart),
    title: component.title,
    description: component.description ?? "",
  };
}

function dataFields(rows, original) {
  const columns = [...new Set(rows.flatMap(Object.keys))];
  const originalMeasures = new Set([original.y, ...(original.fields ?? [])]);
  const numeric = columns.filter((field) => {
    const values = rows.map((row) => row[field]).filter((value) => value != null);
    return (
      values.every((value) => typeof value === "number" && Number.isFinite(value)) &&
      (values.length > 0 || originalMeasures.has(field))
    );
  });
  return {
    columns,
    numeric,
    // A reviewed numeric code/year may already be an intentional grouping role.
    categorical: columns.filter((field) => !numeric.includes(field) || field === original.series),
  };
}

function policyFor(original, fields) {
  const composed = Boolean(original.presentation || original.barOptions)
    || (Array.isArray(original.barFields) && original.barFields.length > 0);
  const originalMeasures = original.series ? [original.y] : original.fields ?? [original.y];
  const typedMeasures = originalMeasures.every((field) => fields.numeric.includes(field));
  const fieldsEditable =
    !composed &&
    typedMeasures &&
    (conventionalTypes.has(original.type) || stackedTypes.has(original.type) || proportionalTypes.has(original.type));
  let allowed = new Set([original.type]);
  if (!composed && typedMeasures && conventionalTypes.has(original.type)) {
    allowed = new Set(conventionalTypes);
    if (original.stackable === true) for (const type of stackedTypes) allowed.add(type);
  } else if (!composed && typedMeasures && stackedTypes.has(original.type)) {
    allowed = new Set([...conventionalTypes, ...stackedTypes]);
  } else if (!composed && typedMeasures && proportionalTypes.has(original.type)) {
    allowed = new Set(proportionalTypes);
  }
  if (original.stackable === false) {
    for (const type of allowed)
      if (type !== original.type && type.toLowerCase().includes("stacked")) allowed.delete(type);
  }
  return { fieldsEditable, types: chartTypes.filter((type) => allowed.has(type)) };
}

function mapping(spec) {
  return [
    spec.x ?? "",
    spec.y,
    spec.series ?? "",
    spec.fields ?? [spec.y],
    spec.barFields ?? [],
    spec.source ?? "",
    spec.target ?? "",
    spec.stages ?? [],
  ];
}

function stackedMapping(spec) {
  return mapping(spec.series ? { ...spec, fields: [spec.y] } : spec);
}

// The canonical pivot does not aggregate duplicate cells. A new mapping must not
// silently discard a reviewed observation or overwrite its category column.
function preservesGrain(rows, x, series) {
  const seen = new Map();
  for (const row of rows) {
    if (!own(row, x) || row[x] == null) return false;
    const group = series ? row[series] : "";
    if (series && (!own(row, series) || group == null || String(group) === x || forbiddenKeys.has(String(group)))) {
      return false;
    }
    const groups = seen.get(row[x]) ?? new Set();
    const key = series ? String(group) : "";
    if (groups.has(key)) return false;
    groups.add(key);
    seen.set(row[x], groups);
  }
  return true;
}

function validateMapping(original, rows, chart, fields, policy) {
  if (!policy.types.includes(chart.type)) fail("that chart type is not compatible with the reviewed data.");
  if (!policy.fieldsEditable && !same(mapping(chart), mapping(original))) {
    fail("this chart's reviewed data mapping is fixed.");
  }
  if (chart.type.toLowerCase().includes("stacked") && !same(stackedMapping(chart), stackedMapping(original))) {
    fail("stacking and percentage normalization require the original reviewed data mapping.");
  }
  const shape = chartDataShape(chart, rows);
  for (const field of shape.requiredRowFields) {
    if (!fields.columns.includes(field)) fail(`the reviewed field ${JSON.stringify(field)} is unavailable.`);
  }
  if (!policy.fieldsEditable) return;
  if (shape.requiresX && (!fields.columns.includes(chart.x) || typeof chart.x !== "string")) {
    fail("choose an available reviewed category field.");
  }
  if (!fields.numeric.includes(chart.y)) fail("choose a numeric reviewed measure.");
  if (chart.series && (chart.series === chart.x || !fields.categorical.includes(chart.series))) {
    fail("choose a reviewed grouping field distinct from the category.");
  }
  if (!chart.series && (chart.fields ?? [chart.y]).some((field) => !fields.numeric.includes(field))) {
    fail("every displayed measure must be a numeric reviewed field.");
  }
  if (
    chart.series &&
    !same(chart.fields, original.fields) &&
    (chart.fields ?? [chart.y]).some((field) => !fields.numeric.includes(field))
  ) {
    fail("every selected measure must be a numeric reviewed field.");
  }
  if (
    (chart.x !== original.x || (chart.series ?? "") !== (original.series ?? "")) &&
    !preservesGrain(rows, chart.x, chart.series)
  ) {
    fail("that grouping would collapse reviewed rows; ask Data for a new aggregation.");
  }
}

/** Choices are derived only from the already serialized, privacy-reviewed rows. */
export function inlineChartEditorCapabilities(component, rows, draftChart = component.chart) {
  const original = cleanChart(component.chart);
  const chart = cleanChart(draftChart);
  const fields = dataFields(rows, original);
  const policy = policyFor(original, fields);
  const accepts = (candidate) => {
    try {
      validateMapping(original, rows, candidate, fields, policy);
      return true;
    } catch {
      return false;
    }
  };
  return {
    types: policy.types.filter((type) => accepts({ ...chart, type })),
    fieldsEditable: policy.fieldsEditable && !chart.type.toLowerCase().includes("stacked"),
    xFields: fields.columns.filter((field) => accepts(changeChartEditorSpec(chart, "x", field, fields))),
    yFields: fields.numeric.filter((field) => accepts(changeChartEditorSpec(chart, "y", field, fields))),
    seriesFields: ["", ...fields.categorical.filter((field) => field !== chart.x)].filter((field) =>
      accepts(changeChartEditorSpec(chart, "series", field, fields)),
    ),
    notice: proportionalTypes.has(original.type)
      ? "Percentage charts keep their reviewed data mapping and normalization. Ask Data for a different measure or grouping."
      : chart.type.toLowerCase().includes("stacked")
        ? "Stacked charts keep their reviewed data mapping. Choose an unstacked chart to select a different measure or grouping."
        : policy.fieldsEditable
          ? null
          : original.presentation
            ? "This bar presentation keeps its reviewed configuration. Its title and description can still be edited."
            : "This chart's reviewed type and data mapping are fixed. Labels, colors, and appearance can still be edited.",
  };
}

function allowedColor(value) {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    (/^#[\da-f]{6}$/iu.test(value) ||
      /^var\(--(?:chart-[1-8]|secondary|positive|negative)\)$/u.test(value) ||
      /^color-mix\(in srgb, var\(--chart-[1-8]\) 42%, var\(--surface\)\)$/u.test(value))
  );
}

function validateOptions(original, rows, chart) {
  for (const [key, value] of Object.entries(chart)) {
    if (!knownKeys.has(key) || forbiddenKeys.has(key)) fail(`unsupported chart option ${JSON.stringify(key)}.`);
    if (!editableKeys.has(key) && !same(value, original[key])) fail(`${key} is fixed by the reviewed chart.`);
    if (booleanKeys.has(key) && typeof value !== "boolean") fail(`${key} must be a boolean.`);
  }
  for (const key of knownKeys) {
    if (!editableKeys.has(key) && !same(chart[key], original[key])) fail(`${key} is fixed by the reviewed chart.`);
  }
  for (const key of ["x", "y", "series"]) {
    if (chart[key] != null) boundedText(chart[key], key, { empty: key === "series", max: 200 });
  }
  for (const key of ["xLabel", "yLabel"]) {
    if (chart[key] != null) boundedText(chart[key], key, { empty: true });
  }
  if (
    chart.fields != null &&
    (!Array.isArray(chart.fields) ||
      !chart.fields.length ||
      chart.fields.length > 40 ||
      new Set(chart.fields).size !== chart.fields.length)
  )
    fail("choose a bounded list of distinct measures.");
  for (const field of chart.fields ?? []) boundedText(field, "measure", { max: 200 });
  if (chart.yAxisPosition != null && !["left", "right"].includes(chart.yAxisPosition)) {
    fail("choose a supported axis side.");
  }
  if (chart.rightAxisFields !== undefined && !same(chart.rightAxisFields, original.rightAxisFields)) {
    const measures = chart.fields ?? [chart.y];
    if (!Array.isArray(chart.rightAxisFields) || chart.rightAxisFields.length > 40
      || new Set(chart.rightAxisFields).size !== chart.rightAxisFields.length
      || chart.rightAxisFields.some((field) => !measures.includes(field))
      || chart.series || chart.barFields?.length || !["line", "bar", "area", "horizontalBar"].includes(chart.type)) {
      fail("choose a secondary axis from the displayed reviewed measures.");
    }
  }
  if (chart.sortOrder != null && !["original", "ascending", "descending"].includes(chart.sortOrder)) {
    fail("choose a supported sort order.");
  }
  if (chart.baseColor != null && chart.baseColor !== original.baseColor && !allowedColor(chart.baseColor)) {
    fail("choose a supported chart color.");
  }
  if (chart.colors != null) {
    if (!record(chart.colors) || Object.keys(chart.colors).length > 200) fail("chart colors must be a bounded map.");
    const colorKeys = new Set([
      ...rows.flatMap((row) => [
        ...Object.keys(row),
        ...Object.values(row)
          .filter((value) => value != null)
          .map(String),
      ]),
      ...Object.keys(original.colors ?? {}),
    ]);
    for (const [key, value] of Object.entries(chart.colors)) {
      if (
        forbiddenKeys.has(key) ||
        !colorKeys.has(key) ||
        key.length > 500 ||
        typeof value !== "string" ||
        value.length > 200 ||
        (value !== original.colors?.[key] && !allowedColor(value))
      )
        fail("choose a supported reviewed series color.");
    }
  }
}

/** Validate a presentation-only edit without changing the source snapshot or row grain. */
export function validateInlineChartPresentation(component, rows, candidate) {
  if (!record(candidate) || Object.keys(candidate).some((key) => !["chart", "title", "description"].includes(key))) {
    fail("only chart presentation can be changed.");
  }
  if (!record(candidate.chart)) fail("chart configuration is required.");
  const original = cleanChart(component.chart);
  validateOptions(original, rows, candidate.chart);
  const chart = cleanChart(candidate.chart);
  const fields = dataFields(rows, original);
  validateMapping(original, rows, chart, fields, policyFor(original, fields));
  // The shared editor supplies these defaults. Preserve the original authored
  // omissions so changing only copy does not falsely mark source fields as edited.
  if (!own(original, "series") && !chart.series) delete chart.series;
  if (!own(original, "fields") && same(chart.fields, [chart.y])) delete chart.fields;
  return {
    chart,
    title: boundedText(candidate.title, "title"),
    description: boundedText(candidate.description ?? "", "description", { empty: true, max: 2_000 }),
  };
}
