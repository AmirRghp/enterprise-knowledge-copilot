import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  reviewedComponentClipboard,
  reviewedNarrativeQueries,
  reviewedQueryLabel,
  reviewedRowsAsTsv,
  reviewedSource,
  safeSourceHref,
  scopedMetricDefinitions,
} from "../src/source-provenance.js";

const queries = {
  current: {
    label: "Current results",
    rows: [{ period: "2026-07", value: 12, detail: { count: 3, label: "A" } }],
    source: {
      sql: "SELECT value FROM current_results",
      tables: ["current_results"],
      metricDefinitions: [{ label: "Value", definition: "Current count", componentIds: ["finding"] }],
      evidenceFlow: [{ title: "Current evidence", detail: "Current query" }],
    },
  },
  comparison: {
    rows: [{ period: "2026-06", value: 10 }],
    source: {
      label: "Comparison results",
      sql: "SELECT value FROM comparison_results",
      tables: ["comparison_results"],
      metricDefinitions: [{ label: "Value", definition: "Comparison count", componentIds: ["finding"] }],
      evidenceFlow: [{ title: "Comparison evidence", detail: "Comparison query" }],
    },
  },
};
const component = { id: "finding", kind: "narrative", queryId: "current", queryIds: ["comparison"] };

test("narrative evidence declares ordered, unique, existing query identities", () => {
  assert.deepEqual(reviewedNarrativeQueries({ ...component, queryIds: ["comparison", "current"] }, queries),
    ["current", "comparison"]);
  assert.deepEqual(reviewedNarrativeQueries({ ...component, kind: "custom" }, queries), ["current", "comparison"]);
  assert.deepEqual(reviewedNarrativeQueries({ id: "chart", kind: "chart", queryId: "current" }, queries), ["current"]);
  assert.throws(() => reviewedNarrativeQueries({ ...component, queryIds: "comparison" }, queries), /to be an array/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component, queryIds: [""] }, queries), /non-empty/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component, queryIds: ["missing"] }, queries), /missing reviewed query/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component, queryIds: ["constructor"] }, queries), /missing reviewed query/u);
  for (const kind of ["chart", "table", "metric"]) {
    assert.throws(() => reviewedNarrativeQueries({ ...component, kind }, queries), /explicit displayRows/u);
  }
  assert.throws(() => reviewedNarrativeQueries({ ...component, chart: { x: "period" } }, queries), /explicit displayRows/u);
});

test("quantitative components retain multiple sources without an implicit data join", () => {
  for (const kind of ["chart", "table", "metric"]) {
    const combined = { ...component, kind, displayRows: [{ change: 2 }],
      sourceRowsByQuery: { current: queries.current.rows, comparison: queries.comparison.rows } };
    assert.deepEqual(reviewedNarrativeQueries(combined, queries), ["current", "comparison"]);
    assert.deepEqual(reviewedNarrativeQueries({ ...combined, displayRows: [] }, queries), ["current", "comparison"]);
    assert.throws(() => reviewedNarrativeQueries({ ...combined, displayRows: {} }, queries), /explicit displayRows/u);
    assert.throws(() => reviewedNarrativeQueries({ ...combined, queryIds: ["missing"] }, queries), /missing reviewed query/u);
    assert.throws(() => reviewedNarrativeQueries({ ...combined,
      sourceRowsByQuery: { current: [{ value: 999 }] } }, queries), /non-reviewed rows/u);
    const copied = reviewedComponentClipboard({ ...combined, queryIds: reviewedNarrativeQueries(combined, queries) },
      queries, id => combined.sourceRowsByQuery[id]);
    assert.match(copied, /Current results/u);
    assert.match(copied, /Comparison results/u);
    assert.doesNotMatch(copied, /change/u, "Derived display rows do not replace reviewed source evidence");
  }
});

test("scoped evidence accepts actual snapshot rows independent of object key order", () => {
  const scoped = { current: [{ detail: { label: "A", count: 3 }, value: 12, period: "2026-07" }], comparison: [] };
  assert.deepEqual(reviewedNarrativeQueries({ ...component, sourceRowsByQuery: scoped }, queries),
    ["current", "comparison"]);
  assert.throws(() => reviewedNarrativeQueries({ ...component, sourceRowsByQuery: [] }, queries), /map reviewed query/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component, sourceRowsByQuery: { extra: [] } }, queries), /undeclared/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component, sourceRowsByQuery: { current: {} } }, queries), /array of scoped rows/u);
  assert.throws(() => reviewedNarrativeQueries({ ...component,
    sourceRowsByQuery: { current: [{ ...queries.current.rows[0], value: 99 }] } }, queries), /non-reviewed rows/u);

  const revisedRow = { ...queries.current.rows[0], value: 99 };
  const revisedSnapshot = { ...queries, current: { ...queries.current, rows: [revisedRow] } };
  assert.deepEqual(reviewedNarrativeQueries({ ...component,
    sourceRowsByQuery: { current: [revisedRow] } }, revisedSnapshot), ["current", "comparison"],
  "A requested artifact-data revision becomes the current reviewed snapshot; this is not a permanent value lock");
});

test("scoped evidence follows current reviewed array contents across removals and replacements", () => {
  const first = { account: "first", value: 1 }, second = { account: "second", value: 2 };
  const snapshot = { current: { rows: [first, second] } };
  const validate = (rows) => reviewedNarrativeQueries({ id: "scope", kind: "table", queryId: "current",
    sourceRowsByQuery: { current: rows } }, snapshot);
  const reusedScope = [first];
  assert.deepEqual(validate(snapshot.current.rows), ["current"]);
  assert.deepEqual(validate(reusedScope), ["current"]);
  assert.deepEqual(validate([first]), ["current"], "Fresh scope arrays retain reviewed membership");

  snapshot.current.rows.shift();
  assert.throws(() => validate(reusedScope), /non-reviewed rows/u, "Removed references are no longer reviewed");
  const replacement = { account: "replacement", value: 3 };
  snapshot.current.rows[0] = replacement;
  assert.throws(() => validate([second]), /non-reviewed rows/u, "Same-length replacement invalidates membership");
  assert.deepEqual(validate([replacement]), ["current"]);
  snapshot.current.rows = [first];
  assert.deepEqual(validate(reusedScope), ["current"], "Replacing the reviewed array restores its current rows");
  assert.throws(() => validate([replacement]), /non-reviewed rows/u);
  snapshot.current.rows.length = 0;
  assert.deepEqual(validate([]), ["current"]);
  assert.throws(() => validate(reusedScope), /non-reviewed rows/u);
});

test("scoped evidence rechecks mutable rows and nested copies against current reviewed values", () => {
  const row = { account: "first", value: 1, detail: { label: "A", counts: [2, 3] } };
  const snapshot = { current: { rows: [row] } };
  const scope = [{ detail: { counts: [2, 3], label: "A" }, value: 1, account: "first" }];
  const validate = (rows) => reviewedNarrativeQueries({ id: "scope", kind: "table", queryId: "current",
    sourceRowsByQuery: { current: rows } }, snapshot);
  assert.deepEqual(validate(scope), ["current"]);
  scope[0].value = 9;
  assert.throws(() => validate(scope), /non-reviewed rows/u, "Mutating a previously valid scope cannot retain approval");
  scope[0].value = 1;
  assert.deepEqual(validate(scope), ["current"]);

  row.detail.counts.push(4);
  assert.deepEqual(validate([row]), ["current"], "A reviewed reference reflects the current nested values");
  assert.throws(() => validate(scope), /non-reviewed rows/u, "A prior nested copy becomes stale");
  scope[0].detail.counts.push(4);
  assert.deepEqual(validate(scope), ["current"]);
  scope[0].detail.counts.reverse();
  assert.throws(() => validate(scope), /non-reviewed rows/u, "Nested array order remains significant");
  scope[0].detail.counts.reverse();
  delete row.detail.label;
  assert.throws(() => validate(scope), /non-reviewed rows/u, "Removed nested keys invalidate stale copies");
  delete scope[0].detail.label;
  assert.deepEqual(validate(scope), ["current"]);
  row.value = 7;
  assert.throws(() => validate(scope), /non-reviewed rows/u, "Same row identity does not cache old scalar content");
  scope[0].value = 7;
  assert.deepEqual(validate(scope), ["current"]);
});

test("reviewed membership remains query-specific and supports equivalent rows from distinct objects", () => {
  const current = { period: "current", value: 12 }, comparison = { period: "prior", value: 10 };
  const snapshot = { current: { rows: [current] }, comparison: { rows: [comparison] } };
  const validate = (sourceRowsByQuery) => reviewedNarrativeQueries({ ...component, sourceRowsByQuery }, snapshot);
  assert.deepEqual(validate({ current: [current], comparison: [comparison] }), ["current", "comparison"]);
  assert.throws(() => validate({ current: [comparison] }), /non-reviewed rows/u,
    "A reference reviewed for another declared query cannot cross query boundaries");
  assert.throws(() => validate({ comparison: [{ ...current }] }), /non-reviewed rows/u);
  snapshot.comparison.rows.push({ value: 12, period: "current" });
  assert.deepEqual(validate({ comparison: [current] }), ["current", "comparison"],
    "Content equality with the selected query remains sufficient without shared object identity");
});

test("empty and mixed source scopes preserve full membership validation", () => {
  const first = { value: 1 }, second = { value: 2 };
  const snapshot = { current: { rows: [first, second] }, comparison: { rows: [] } };
  const validate = (sourceRowsByQuery) => reviewedNarrativeQueries({ ...component, sourceRowsByQuery }, snapshot);
  assert.deepEqual(validate({ current: [], comparison: snapshot.comparison.rows }), ["current", "comparison"]);
  const scope = [first, { value: 2 }, first];
  assert.deepEqual(validate({ current: scope }), ["current", "comparison"],
    "References, equivalent copies and repeated source rows can share a scope");
  scope.push({ value: 3 });
  assert.throws(() => validate({ current: scope }), /non-reviewed rows/u,
    "Accepted reference members cannot hide an unmatched copied row");
  scope.pop();
  scope[0] = { value: 4 };
  assert.throws(() => validate({ current: scope }), /non-reviewed rows/u);
  assert.throws(() => validate({ comparison: [second] }), /non-reviewed rows/u);
});

test("scoped JSON membership agrees with canonical value comparison across deterministic mixed fixtures", () => {
  // This is the original value-based membership contract, independent of reference optimizations.
  const identity = (row) => JSON.stringify(row, (_key, value) => value && typeof value === "object"
    && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
  const copyWithReversedKeys = (value) => Array.isArray(value) ? value.map(copyWithReversedKeys)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse()
      .map(([key, item]) => [key, copyWithReversedKeys(item)])) : value;
  const scalars = [null, true, false, 0, -0, 1e100, "", "quoted\"\\\n", "\ud800"];
  for (let index = 0; index < 64; index += 1) {
    const reviewed = Array.from({ length: 4 }, (_, offset) => JSON.parse(JSON.stringify({
      id: `${index}:${offset}`, detail: { label: scalars[(index + offset) % scalars.length],
        values: [scalars[index % scalars.length], { count: offset, enabled: offset % 2 === 0 }] },
      value: index - offset,
    })));
    const snapshot = { current: { rows: reviewed } };
    const copied = copyWithReversedKeys(reviewed[index % reviewed.length]);
    const unknown = { ...copied, id: `unreviewed:${index}` };
    for (const scope of [reviewed, [], [...reviewed], [copied], [reviewed[0], copied],
      [unknown], [reviewed[0], copied, unknown], [copied, reviewed[0], copied]]) {
      const expected = new Set(reviewed.map(identity));
      const accepted = scope.every((row) => expected.has(identity(row)));
      const validate = () => reviewedNarrativeQueries({ id: "scope", kind: "table", queryId: "current",
        sourceRowsByQuery: { current: scope } }, snapshot);
      if (accepted) assert.deepEqual(validate(), ["current"], `Accepted fixture ${index}`);
      else assert.throws(validate, /non-reviewed rows/u, `Rejected fixture ${index}`);
    }
  }
});

test("copy preserves single-source TSV and includes each selected narrative source", () => {
  const scope = { current: [], comparison: queries.comparison.rows };
  const registered = { ...component, queryIds: reviewedNarrativeQueries(component, queries) };
  const copied = reviewedComponentClipboard(registered, queries, (queryId) => scope[queryId]);
  assert.equal(copied, "Current results\n\n\nComparison results\nperiod\tvalue\n2026-06\t10");
  assert.equal(reviewedComponentClipboard({ queryId: "comparison" }, queries, (id) => scope[id]),
    reviewedRowsAsTsv(queries.comparison.rows));
  assert.equal(reviewedRowsAsTsv([{ label: "one\ttwo\nthree", value: 0 }, { extra: "yes" }]),
    "label\tvalue\textra\none two three\t0\t\n\t\tyes");
  assert.equal(reviewedQueryLabel({ source: { query: { description: "Reviewed query" } } }, "id"), "Reviewed query");
  assert.equal(reviewedQueryLabel(undefined, "id"), "id");
});

test("each narrative source retains its own SQL, evidence and metric definitions", () => {
  for (const queryId of reviewedNarrativeQueries(component, queries)) {
    const source = reviewedSource(queries[queryId].source);
    assert.equal(source.sql, queries[queryId].source.sql);
    assert.deepEqual(source.evidenceFlow, queries[queryId].source.evidenceFlow);
    assert.deepEqual(scopedMetricDefinitions(source.definitions, component.id), queries[queryId].source.metricDefinitions);
  }
  assert.equal(safeSourceHref("https://example.test/query?token=private"), null);
  assert.equal(safeSourceHref("https://example.test/tokens/private"), null);
  assert.equal(safeSourceHref("https://example.test/query/123"), "https://example.test/query/123");
});

test("source selection preserves lazy loading, shared drawer behavior and copy permissions", async () => {
  const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");
  assert.match(inspector, /ready \? getSource\(selectedQueryId\) : null/u);
  assert.match(inspector, /label="Choose reviewed data source"/u);
  assert.match(inspector, /queryIds\.length > 1/u);
  assert.match(inspector, /queryId: selectedQueryId, sourceRows: source\?\.rows/u);
  assert.match(inspector, /<SourceInspector component=\{selectedComponent\} \{\.\.\.source\} allowCopy=\{allowCopy\}/u);
  assert.match(inspector, /<DataTable key=\{component\.queryId\}/u);
  assert.match(inspector, /setCopied\(false\), \[component\.queryId\]/u);
});
