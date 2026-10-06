import assert from "node:assert/strict";
import test from "node:test";

import { resolveSectionRows } from "../src/use-data-app.js";

test("multi-select intersects scopes and clears to the same aggregate-aware all state", () => {
  const rows = [
    { region: "all", value: 30 }, { region: "EMEA", value: 10 },
    { region: "Americas", value: 12 }, { region: "APAC", value: 8 },
  ].map(Object.freeze);
  const definitions = [{ id: "region", field: "region", multiple: true, queryIds: ["regional"] }];
  const resolve = (value, localValue = "all", query = "regional", breakdown = []) => resolveSectionRows(
    rows, definitions, { region: value }, definitions, { region: localValue }, query, breakdown,
  );
  assert.deepEqual(resolve(["EMEA", "Americas"]), rows.slice(1, 3));
  assert.deepEqual(resolve(["EMEA", "Americas"], ["Americas", "APAC"]), [rows[2]]);
  assert.deepEqual(resolve(["EMEA"], ["APAC"]), []);
  assert.deepEqual(resolve([]), [rows[0]]);
  assert.deepEqual(resolve([], [], "regional", ["region"]), rows.slice(1));
  assert.deepEqual(resolve(["EMEA"], [], "unrelated"), rows);
});

test("section filters intersect page scope before aggregate collapse without sharing local IDs or mutating rows", () => {
  const rows = [
    { segment: "all", value: 12 },
    { segment: "A", value: 7 },
    { segment: "B", value: 5 },
  ].map(Object.freeze);
  Object.freeze(rows);
  const page = [{ id: "segment", field: "segment", defaultValue: "all" }];
  const local = [{ id: "segment", field: "segment", queryIds: ["scoped"], defaultValue: "all" }];
  const resolve = (pageValue, localValue, query = "scoped", breakdown = []) => resolveSectionRows(
    rows, page, { segment: pageValue }, local, { segment: localValue }, query, breakdown,
  );
  assert.deepEqual(resolve("all", "A"), [rows[1]], "Local scope must not filter already-collapsed page aggregate rows");
  assert.deepEqual(resolve("A", "all"), [rows[1]], "All in a section must not broaden the page scope");
  assert.deepEqual(resolve("A", "B"), [], "Conflicting scopes must be empty, not silently overridden");
  assert.deepEqual(resolve("all", "A", "unrelated"), [rows[0]]);
  assert.deepEqual(resolve("all", "all"), [rows[0]]);
  assert.deepEqual(resolve("all", "all", "scoped", ["segment"]), rows.slice(1));
  assert.deepEqual(resolveSectionRows(rows, page, {}, local, {}, "scoped"), [rows[0]]);
  assert.equal(rows.length, 3);
});

test("section date ranges select only available scoped endpoints and preserve all-date history", () => {
  const rows = [
    { week: "2026-07-06", segment: "A", value: 10 },
    { week: "2026-07-13", segment: "A", value: 15 },
    { week: "2026-07-20", segment: "B", value: 20 },
  ];
  const page = [{ id: "segment", field: "segment", defaultValue: "A" }];
  const local = [{ id: "period", field: "week", mode: "through", defaultValue: "all" }];
  const resolve = (value, breakdown = []) => resolveSectionRows(rows, page, {}, local,
    { period: value }, "summary", breakdown);
  assert.deepEqual(resolve("2026-07-06..2026-07-20"), [rows[1]]);
  assert.deepEqual(resolve("2026-07-06..2026-07-20", ["week"]), rows.slice(0, 2));
  assert.deepEqual(resolve("all"), rows.slice(0, 2));
  assert.deepEqual(resolve("2026-08-01..2026-08-20"), []);
});
