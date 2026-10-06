import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextualCases, contextualAnnotations, contextualAnswer, reconcileContextAnnotations } from "../examples/reports/contextual-stories/context.mjs";
import { createContextualStories, joinContextRows, reproduceContextualStories } from "../examples/reports/contextual-stories/stories.mjs";
import { resolveChartAnnotations } from "../src/charting/chart-annotations.js";
import { normalizeInlineChartInput } from "../../../../skills/visualize-data/scripts/inline-chart-input.mjs";

const input = readFileSync(new URL("../examples/reports/contextual-stories/evidence.json", import.meta.url), "utf8");
const evidence = JSON.parse(input);
const generatedAt = "2026-08-20T00:00:00Z";
const { snapshot, results } = createContextualStories(input, generatedAt);
const chartSpec = (story) => ({ type: story.chartType, x: "date", y: story.valueField,
  fields: [story.valueField], yLabel: story.yLabel, showLegend: false });
const rowsFor = (story) => snapshot.queries[story.queryId].rows;
const reviseContext = (story, rows, context) => rows.map((row) => row.contextId === story.recordId ? { ...row, context } : row);

test("three new fictional cases retain exact observations, records, dates, and source hashes", () => {
  assert.equal(evidence.fictional, true);
  assert.equal(results.inputSha256, createHash("sha256").update(input).digest("hex"));
  assert.equal(results.inputSha256, "1d25fd6add04db4ac7202fac21d47b47c5b4710a8508e893b0e7975516ddacaf");
  assert.deepEqual(Object.keys(snapshot.queries), ["operations_history", "adjustment_history", "coverage_history"]);
  assert.deepEqual(results.cases.map(({ rowCount }) => rowCount), [8, 6, 6]);
  for (const story of contextualCases) {
    const source = evidence.cases.find(({ id }) => id === story.id);
    const original = structuredClone(source);
    assert.deepEqual(rowsFor(story), joinContextRows(source.observations, source.contextRecords));
    assert.deepEqual(source, original, "The join does not mutate source evidence");
    assert.ok(rowsFor(story).every((row) => row.date <= generatedAt.slice(0, 10)));
    assert.ok(snapshot.queries[story.queryId].source.metricDefinitions.every((definition) =>
      definition.componentIds.every((id) => [`context-${story.id}-chart`, `context-${story.id}-answer`].includes(id))));
    assert.equal(snapshot.queries[story.queryId].source.sql, undefined, "A file computation must not invent executed SQL");
  }
  assert.equal(results.cases.find(({ id }) => id === "adjustment").withoutOneTime[2].postedBillingsUsd, 13200);
});

test("annotations state contextual records absent from the plotted measures", () => {
  for (const story of contextualCases) {
    const rows = rowsFor(story);
    const [annotation] = contextualAnnotations(story, rows);
    const record = evidence.cases.find(({ id }) => id === story.id).contextRecords[0];
    assert.equal(annotation.label, record.text);
    assert.equal(annotation.at, record.date);
    assert.equal(annotation.field, story.id === "adjustment" ? story.valueField : "context");
    assert.equal(annotation.kind, story.id === "adjustment" ? "point" : "event");
    assert.equal(rows.find((row) => row.context).contextId, story.recordId);
    const [resolved] = resolveChartAnnotations({ ...chartSpec(story), annotations: [annotation] }, rows);
    assert.equal(resolved.x, record.date);
    if (story.id === "adjustment") assert.equal(resolved.y, rows.find(row => row.date === record.date).postedBillingsUsd);
    assert.ok(!contextualAnswer(story, rows).includes(annotation.label), "The prose supplies implications instead of repeating the note");
  }
});

test("missing, ambiguous, or contradictory context removes the annotation instead of trusting its anchor", () => {
  for (const story of contextualCases) {
    const rows = rowsFor(story);
    const recordRow = rows.find((row) => row.contextId === story.recordId);
    for (const context of ["", " ", null, "x".repeat(161)])
      assert.deepEqual(contextualAnnotations(story, reviseContext(story, rows, context)), []);
    assert.deepEqual(contextualAnnotations(story, rows.map((row) => ({ ...row, contextId: "" }))), []);
    assert.deepEqual(contextualAnnotations(story, [...rows, { ...recordRow }]), []);
    assert.deepEqual(contextualAnnotations(story, rows.filter((row) => row !== recordRow)), []);
    assert.deepEqual(contextualAnnotations(story, rows.map((row) => row === recordRow ? { ...row, date: "2026-02-30" } : row)), []);
  }
  const coverage = contextualCases.find(({ id }) => id === "coverage");
  assert.deepEqual(contextualAnnotations(coverage, rowsFor(coverage).map((row) => ({ ...row, coveredLocations: 10 }))), []);
  const adjustment = contextualCases.find(({ id }) => id === "adjustment");
  assert.deepEqual(contextualAnnotations(adjustment, rowsFor(adjustment).map((row) => ({ ...row, oneTimeAmount: 0 }))), []);
});

test("exact joins and receipts omit missing or conflicting date matches", () => {
  for (const change of [
    (source) => { source.contextRecords = []; },
    (source) => { source.contextRecords[0].date = "2026-01-01"; },
    (source) => { source.contextRecords.push({ ...source.contextRecords[0], id: "OTHER-RECORD", text: "Conflicting context" }); },
  ]) {
    const revised = structuredClone(evidence);
    change(revised.cases[0]);
    const result = createContextualStories(JSON.stringify(revised), generatedAt);
    assert.equal(result.results.cases[0].annotationLabel, null);
    assert.equal(result.results.cases[0].annotationDate, null);
    assert.equal(result.snapshot.contextualStories[0].annotationLabel, null);
    assert.deepEqual(contextualAnnotations(contextualCases[0], result.snapshot.queries.operations_history.rows), []);
  }
});

test("generated annotation revisions refresh after repeated context corrections and saved chart edits", () => {
  for (const story of contextualCases) {
    const base = chartSpec(story);
    const rows = rowsFor(story);
    let saved = reconcileContextAnnotations(story, base, undefined, rows);
    saved = { ...saved, colors: { [story.valueField]: "#123456" }, showXAxisLabel: false };
    const revisions = new Set([saved.annotations[0].id]);
    for (const context of ["Additional shift recorded", "Shift schedule revised", "Original change withdrawn"]) {
      const original = structuredClone(saved);
      const next = reconcileContextAnnotations(story, base, saved, reviseContext(story, rows, context));
      assert.equal(next.annotations.length, 1);
      assert.equal(next.annotations[0].label, context);
      assert.equal(next.annotations[0].at, saved.annotations[0].at);
      assert.equal(next.colors, saved.colors);
      assert.equal(next.showXAxisLabel, false);
      assert.deepEqual(saved, original, "Saved presentation objects remain immutable");
      revisions.add(next.annotations[0].id);
      saved = next;
    }
    assert.equal(revisions.size, 4, "The annotation ID identifies the context revision");
    assert.deepEqual(reconcileContextAnnotations(story, base, saved, reviseContext(story, rows, "")).annotations, []);
  }
});

test("custom annotation edits, unknown IDs, and explicit empty lists survive reconciliation", () => {
  for (const story of contextualCases) {
    const base = chartSpec(story);
    const rows = rowsFor(story);
    const [original] = contextualAnnotations(story, rows);
    const revised = reviseContext(story, rows, "Updated context record");
    for (const changes of [{ label: "Author's custom context" }, { at: rows[0].date },
      { field: "customEvidence" }, { kind: original.kind === "point" ? "event" : "point" }, { id: "user-authored-note" }]) {
      const custom = { ...original, ...changes };
      assert.deepEqual(reconcileContextAnnotations(story, base, { ...base, annotations: [custom] }, revised).annotations, [custom]);
      assert.deepEqual(reconcileContextAnnotations(story, base, { ...base, annotations: [custom] }, []).annotations, [custom]);
    }
    const unknown = { ...original, id: "independent-note", label: "Separate source context" };
    const saved = { ...base, annotations: [original, unknown] };
    assert.deepEqual(reconcileContextAnnotations(story, base, saved, []).annotations, [unknown]);
    assert.deepEqual(reconcileContextAnnotations(story, base, { ...base, annotations: [] }, rows).annotations, []);
    assert.equal(reconcileContextAnnotations(story, base, { ...base, type: "area" }, rows).type, "area");
  }
});

test("the owned legacy billing event migrates to the bar value without replacing saved edits", () => {
  const story = contextualCases.find(entry => entry.id === "adjustment");
  const rows = rowsFor(story), base = chartSpec(story);
  const legacy = { id: "context-adjustment-BILL-104-5b78af45", kind: "event", field: "context",
    at: "2026-07-20", label: "One-time catch-up invoice for June work posted" };
  const saved = { ...base, type: "area", colors: { postedBillingsUsd: "#123456" }, annotations: [legacy] };
  const next = reconcileContextAnnotations(story, base, saved, rows);
  assert.deepEqual(next.annotations, contextualAnnotations(story, rows));
  assert.equal(next.type, saved.type);
  assert.equal(next.colors, saved.colors);
  assert.equal(saved.annotations[0], legacy);
  for (const changes of [{ label: "User's invoice note" }, { at: "2026-07-13" }, { field: "custom" }, { kind: "point" }]) {
    const custom = { ...legacy, ...changes };
    assert.deepEqual(reconcileContextAnnotations(story, base, { ...saved, annotations: [custom] }, rows).annotations, [custom]);
  }
  assert.deepEqual(reconcileContextAnnotations(story, base, { ...saved, annotations: [] }, rows).annotations, []);
});

test("interpretations respond to corrected context and observations", () => {
  for (const story of contextualCases) {
    const rows = rowsFor(story);
    const baseline = contextualAnswer(story, rows);
    assert.notEqual(contextualAnswer(story, reviseContext(story, rows, "Corrected record")), baseline);
    assert.notEqual(contextualAnswer(story, reviseContext(story, rows, "")), baseline);
    const revised = story.id === "coverage" ? rows.map((row) => ({ ...row, coveredLocations: 10 }))
      : rows.map((row) => ({ ...row, [story.valueField]: 1 }));
    assert.notEqual(contextualAnswer(story, revised), baseline);
  }
});

test("actual inline projection retains explicitly approved contextual text and record provenance without extra plotted fields", () => {
  for (const story of contextualCases) {
    const query = snapshot.queries[story.queryId];
    const chart = reconcileContextAnnotations(story, chartSpec(story), undefined, query.rows);
    const projected = normalizeInlineChartInput({ schemaVersion: 1, id: `context-${story.id}-chart`,
      queryId: story.queryId, title: story.title, description: "Fictional example.",
      chart, rows: query.rows, source: query.source,
      columns: story.id === "adjustment" ? [] : ["context"] });
    if (story.id !== "adjustment") assert.ok(projected.rows.some((row) => row.context === story.originalContext));
    assert.ok(projected.rows.every((row) => !Object.hasOwn(row, "contextId")), "Record IDs belong in provenance, not a forced plotted field");
    const provenance = JSON.stringify(projected.query.source);
    assert.ok(provenance.includes(story.originalContext), "Export retains the contextual source statement even for numeric point anchors");
    assert.ok(provenance.includes(story.recordId));
    if (story.id === "adjustment") assert.ok(provenance.includes("24,000"), "The exact ledger amount remains in source context");
    assert.ok(JSON.stringify(projected.query.source).includes(results.inputSha256));
    assert.ok(JSON.stringify(projected.query.source).includes("src/content/report/evidence/evidence.json"));
    assert.equal(resolveChartAnnotations(projected.component.chart, projected.rows).length, 1);
  }
});

test("new artifacts get fresh IDs while reproduction preserves identity, title, dates, and metadata", () => {
  assert.notEqual(createContextualStories(input, generatedAt).snapshot.id, snapshot.id);
  const existing = { ...snapshot, title: "Saved report title", generatedAt: "2026-08-19T10:00:00Z",
    legacyPresentationTitle: "Earlier title", report: { asOf: "2026-08-10", audience: "technical" },
    publication: { destination: "existing-private-site" }, customMetadata: { preserve: true } };
  const before = structuredClone(existing);
  const revised = structuredClone(evidence);
  revised.cases[0].contextRecords[0].text = "Updated intake record";
  const { snapshot: reproduced } = reproduceContextualStories(existing, JSON.stringify(revised));
  assert.deepEqual(existing, before);
  for (const key of ["id", "title", "generatedAt", "legacyPresentationTitle", "report", "publication", "customMetadata"])
    assert.deepEqual(reproduced[key], existing[key]);
  assert.equal(reproduced.contextualStories[0].annotationLabel, "Updated intake record");
  assert.ok(reproduced.queries.operations_history.rows.some((row) => row.context === "Updated intake record"));
  const { id: _, legacyPresentationTitle: __, ...legacy } = existing;
  const migrated = reproduceContextualStories(legacy, input).snapshot;
  assert.ok(migrated.id);
  assert.equal(migrated.legacyPresentationTitle, existing.title);
});

test("the generated-project CLI reproduces through a directory alias", () => {
  const project = mkdtempSync(join(tmpdir(), "contextual-reproducer-test-"));
  try {
    const content = join(project, "src/content/report");
    mkdirSync(join(content, "evidence"), { recursive: true });
    for (const file of ["stories.mjs", "context.mjs"])
      cpSync(new URL(`../examples/reports/contextual-stories/${file}`, import.meta.url), join(content, file));
    writeFileSync(join(content, "evidence/evidence.json"), input);
    const existing = { ...snapshot, title: "Saved CLI title", report: { asOf: "2026-08-10" },
      publication: { destination: "existing-private-site" } };
    writeFileSync(join(project, "src/data.json"), JSON.stringify(existing));
    const alias = join(project, "report-alias");
    symlinkSync(content, alias, process.platform === "win32" ? "junction" : "dir");
    const run = spawnSync(process.execPath, [join(alias, "stories.mjs")], { cwd: project, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).inputSha256, results.inputSha256, "The main guard must execute, not silently exit");
    assert.deepEqual(JSON.parse(readFileSync(join(project, "src/data.json"), "utf8")), existing);
    assert.deepEqual(JSON.parse(readFileSync(join(content, "evidence/story-results.json"), "utf8")), results);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("the new gallery keeps shared editing, source wrappers, export disclosure, and a 720px column", () => {
  const root = new URL("../examples/reports/contextual-stories/", import.meta.url);
  const report = readFileSync(new URL("ReportContent.jsx", root), "utf8");
  const css = readFileSync(new URL("report.css", root), "utf8");
  const build = readFileSync(new URL("build.mjs", root), "utf8");
  for (const expected of [/RichNarrative/u, /ReportSection/u, /DataComponent/u, /ChartRenderer/u,
    /chartOverrides\[chartId\]/u, /chartProps\(chartId\)/u, /visible\(chartId\)/u,
    /setAppTitle/u, /description=\{`Fictional example/u, /showLegend: false/u]) assert.match(report, expected);
  assert.match(css, /--data-app-content-width: 720px/u);
  assert.match(build, /Refusing to overwrite an existing project/u);
  assert.match(build, /\["ReportContent.jsx", "context.mjs", "stories.mjs"\]/u);
  assert.doesNotMatch(build, /integrity:authorize|integrity:update|protected-runtime\.json/u);
});
