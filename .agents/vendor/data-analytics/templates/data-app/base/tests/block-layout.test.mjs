import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  defaultBlockMinimumSpans,
  directionalBlockTilt,
  moveBlockBefore,
  normalizeBlockLayouts,
  preserveHiddenBlockPositions,
  rebalanceBlockRow,
  reconcileBlockOrder,
  reconcileBlockRows,
  resizeBlockRow,
  resolveBlockInsertion,
  resolveCanvasInsertion,
  resolveCanvasMove,
  resolveFreeformGridInsertion,
  validateBlockLayouts,
  validBlockLayoutId,
} from "../src/block-layout.js";
import {
  mergePresentationChanges,
  normalizePresentation,
  readLocalPresentation,
  validatePresentation,
  writeLocalPresentation,
} from "../src/presentation-state.js";
import { keyboardBlockTarget } from "../src/use-sortable-blocks.js";

test("a lone canvas block can keep an explicitly resized span and grow back to full width", () => {
  const rows = [{ id: "row", items: ["chart"] }];
  const blocks = { chart: { kind: "chart", span: 12, minSpan: 4 } };
  const smaller = resizeBlockRow({ rows, blocks, activeId: "chart", span: 6 });
  assert.equal(smaller.spans.chart, 6);
  assert.deepEqual(rebalanceBlockRow(["chart"], blocks, { currentSpans: smaller.spans,
    preferredSpans: smaller.preferredSpans, fill: false }), { chart: 6 });
  assert.equal(resizeBlockRow({ ...smaller, blocks, activeId: "chart", span: 12 }).spans.chart, 12);
  assert.equal(resizeBlockRow({ rows, blocks, activeId: "chart", span: 1 }), null);
  assert.equal(resizeBlockRow({ rows, blocks: { chart: { ...blocks.chart, locked: true } }, activeId: "chart", span: 6 }), null);
  const persisted = { canvas: { order: ["chart"], rows, spans: { chart: 6 }, soloSpans: { chart: 6 } } };
  assert.deepEqual(validateBlockLayouts(persisted), persisted);
  assert.throws(() => validateBlockLayouts({ canvas: { ...persisted.canvas, soloSpans: { chart: 13 } } }));
  const previous = { blockLayouts: { canvas: { order: ["chart"], rows, spans: { chart: 12 } } } };
  assert.deepEqual(mergePresentationChanges(previous, { blockLayouts: persisted }, previous).blockLayouts, persisted);
});

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value),
  };
}

test("retired section metadata does not discard saved card order or widths", () => {
  const layout = { order: ["b", "a"], rows: [{ id: "row", items: ["b", "a"], sectionId: "heading" }],
    spans: { b: 8, a: 4 }, preferredSpans: { b: 8 }, soloSpans: { a: 6 }, authoredRevision: 2 };
  const expected = { canvas: { ...layout, rows: [{ id: "row", items: ["b", "a"] }] } };
  assert.deepEqual(normalizeBlockLayouts({ canvas: layout }), expected);
  assert.deepEqual(validateBlockLayouts({ canvas: layout }), expected);
  assert.throws(() => validateBlockLayouts({ canvas: { ...layout,
    rows: [{ ...layout.rows[0], sectionId: "__proto__" }] } }));
});

function rect(left, top, width = 100, height = 80) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

test("canvas reorder previews retain standalone widths, including across repeated insertions", () => {
  const blocks = Object.fromEntries(["first", "second", "solo"].map((id) => [id, { kind: "chart", span: 6 }]));
  const original = { rows: [{ id: "top", items: ["first", "second"] }, { id: "bottom", items: ["solo"] }],
    spans: { first: 6, second: 6, solo: 9 }, preferredSpans: { solo: 9 }, soloSpans: { solo: 9 } };
  let layout = original;
  for (const placement of ["after", "before", "after", "before"]) {
    const reversed = placement === "before";
    layout = resolveCanvasInsertion({ rows: layout.rows, spans: layout.spans,
      preferredSpans: layout.preferredSpans, soloSpans: layout.soloSpans, blocks, activeId: "first",
      items: [{ id: "first", rect: rect(reversed ? 120 : 0, 0) },
        { id: "second", rect: rect(reversed ? 0 : 120, 0) }, { id: "solo", rect: rect(0, 100, 160) }],
      pointer: { x: reversed ? 10 : 210, y: 40 } });
    assert.deepEqual(layout.order, reversed ? ["first", "second", "solo"] : ["second", "first", "solo"]);
    assert.deepEqual(layout.soloSpans, { solo: 9 });
    assert.equal(layout.spans.solo, 9);
  }
  const joined = resolveCanvasMove({ ...original, blocks, activeId: "first", targetId: "solo", placement: "before" });
  const separated = resolveCanvasMove({ ...joined, blocks, activeId: "first", targetId: "second", placement: "before" });
  assert.equal(separated.spans.solo, 9, "The standalone width is restored when a temporary neighbor leaves");
  const movedSolo = resolveCanvasMove({ ...original, blocks, activeId: "solo", targetId: "first", placement: "above" });
  assert.equal(movedSolo.spans.solo, 9, "Moving the standalone row preserves its own explicit width");
});

test("sortable blocks retain stable semantic IDs and reconcile authored revisions", () => {
  assert.equal(validBlockLayoutId("dashboard:overview:metrics"), true);
  for (const invalid of ["", " padded ", "__proto__", "constructor", "prototype", "x".repeat(201), 3]) {
    assert.equal(validBlockLayoutId(invalid), false);
  }
  assert.deepEqual(reconcileBlockOrder(["new", "trend", "accounts"],
    ["removed", "accounts", "trend", "accounts"]), ["accounts", "trend", "new"]);
  assert.deepEqual(reconcileBlockOrder(["trend", "accounts"],
    ["trend", "hidden", "accounts"], ["hidden"]), ["trend", "hidden", "accounts"]);
});

test("sortable movement preserves neighboring order and suppresses no-op drops", () => {
  const original = ["summary", "trend", "accounts", "evidence"];
  assert.deepEqual(moveBlockBefore(original, "evidence", "trend"),
    ["summary", "evidence", "trend", "accounts"]);
  assert.deepEqual(moveBlockBefore(original, "trend", null),
    ["summary", "accounts", "evidence", "trend"]);
  assert.equal(moveBlockBefore(original, "trend", "accounts"), original);
  assert.equal(moveBlockBefore(original, "missing", "accounts"), original);
  assert.deepEqual(original, ["summary", "trend", "accounts", "evidence"]);
});

test("hidden blocks retain their authored location while visible siblings move", () => {
  assert.deepEqual(preserveHiddenBlockPositions(
    ["summary", "hidden", "trend", "evidence"], ["evidence", "summary", "trend"], ["hidden"],
  ), ["evidence", "hidden", "summary", "trend"]);
  assert.deepEqual(preserveHiddenBlockPositions(
    ["summary", "trend"], ["trend", "summary", "new"], [],
  ), ["trend", "summary", "new"]);
});

test("stack insertion follows vertical midpoints and honors locked blocks", () => {
  const order = ["summary", "trend", "accounts"];
  const items = [
    { id: "summary", rect: rect(0, 0) },
    { id: "trend", rect: rect(0, 100) },
    { id: "accounts", rect: rect(0, 200) },
  ];
  assert.deepEqual(resolveBlockInsertion({
    order, items, activeId: "accounts", pointer: { x: 20, y: 120 },
  })?.order, ["summary", "accounts", "trend"]);
  assert.equal(resolveBlockInsertion({
    order, items, activeId: "summary", pointer: { x: 20, y: 220 }, lockedIds: ["summary"],
  }), null);
  assert.equal(resolveBlockInsertion({
    order, items, activeId: "accounts", pointer: { x: 20, y: 20 }, lockedIds: ["summary"],
  }), null);
  assert.equal(resolveBlockInsertion({
    order, items, activeId: "summary", pointer: { x: 20, y: 260 }, lockedIds: ["trend"],
  }), null, "Moving around a locked item must never displace its existing slot");
});

test("Home and End target the nearest unlocked boundary without crossing locked blocks", () => {
  assert.deepEqual(keyboardBlockTarget(["locked", "first", "last"], "last", "Home", ["locked"]),
    { index: 1, id: "first" });
  assert.deepEqual(keyboardBlockTarget(["first", "last", "locked"], "first", "End", ["locked"]),
    { index: 1, id: "last" });
  assert.deepEqual(keyboardBlockTarget(["before", "locked", "first", "last"], "last", "Home", ["locked"]),
    { index: 2, id: "first" });
  assert.equal(keyboardBlockTarget(["first", "locked", "last"], "first", "ArrowRight", ["locked"]), null);
  assert.equal(keyboardBlockTarget(["locked", "first"], "first", "Home", ["locked"]), null);
});

test("grid insertion follows horizontal midpoints and advances across rows", () => {
  const order = ["first", "second", "third", "fourth"];
  const items = [
    { id: "first", rect: rect(0, 0) },
    { id: "second", rect: rect(120, 0) },
    { id: "third", rect: rect(0, 100) },
    { id: "fourth", rect: rect(120, 100) },
  ];
  assert.deepEqual(resolveBlockInsertion({
    order, items, activeId: "fourth", pointer: { x: 135, y: 40 }, variant: "grid",
  })?.order, ["first", "fourth", "second", "third"]);
  assert.deepEqual(resolveBlockInsertion({
    order, items, activeId: "first", pointer: { x: 190, y: 135 }, variant: "grid",
  })?.order, ["second", "third", "fourth", "first"]);
  assert.equal(resolveBlockInsertion({
    order, items, activeId: "fourth", pointer: { x: 171, y: 40 }, variant: "grid",
    hysteresis: 8, previousBeforeId: "second",
  }), null);
});

test("small freeform items displace a featured block without inheriting its size", () => {
  const order = ["featured", "segment", "small", "trend"];
  const items = [
    { id: "featured", rect: rect(0, 0, 220, 180) },
    { id: "segment", rect: rect(230, 0, 100, 85) },
    { id: "small", rect: rect(340, 0, 100, 85) },
    { id: "trend", rect: rect(230, 95, 100, 85) },
  ];
  const displaced = resolveBlockInsertion({
    order,
    items,
    activeId: "small",
    pointer: { x: 38, y: 42 },
    dragRect: rect(12, 12, 100, 85),
    dragDirection: { x: -1, y: 0 },
    variant: "freeform",
  });
  assert.deepEqual(displaced?.order, ["small", "featured", "segment", "trend"],
    "Dropping a small tile at the featured tile's leading edge must push the large tile aside");
  assert.equal(displaced?.targetId, "featured");
  assert.equal(displaced?.placement, "before");
});

test("mixed-size freeform grids move blocks by their actual authored footprint", () => {
  const order = ["featured", "first", "second", "third", "fourth"];
  const grid = {
    columns: 4,
    left: 0,
    top: 0,
    columnWidth: 100,
    columnGap: 10,
    rowHeight: 80,
    rowGap: 10,
    footprints: {
      featured: { columns: 2, rows: 2 },
      first: { columns: 1, rows: 1 },
      second: { columns: 1, rows: 1 },
      third: { columns: 1, rows: 1 },
      fourth: { columns: 1, rows: 1 },
    },
  };

  assert.equal(resolveFreeformGridInsertion({ order, activeId: "featured", grid,
    dragRect: rect(20, 10, 210, 170) }), null,
  "A featured card must not jump until its projected footprint reaches another grid cell");
  assert.deepEqual(resolveFreeformGridInsertion({ order, activeId: "featured", grid,
    dragRect: rect(110, 0, 210, 170) })?.order,
  ["first", "featured", "second", "third", "fourth"],
  "Moving a two-column card one cell right should move one small card left");
  assert.deepEqual(resolveFreeformGridInsertion({ order, activeId: "featured", grid,
    dragRect: rect(0, 90, 210, 170) })?.order,
  ["first", "second", "third", "fourth", "featured"],
  "Dragging a featured card down should fill the vacated row with its smaller neighbors");
  assert.deepEqual(resolveFreeformGridInsertion({ order, activeId: "second", grid,
    dragRect: rect(0, 0, 100, 80) })?.order,
  ["second", "featured", "first", "third", "fourth"],
  "A small card should displace a featured card without changing either footprint");
  assert.equal(resolveFreeformGridInsertion({ order, activeId: "featured", grid,
    dragRect: rect(110, 0, 210, 170), lockedIds: ["first"] }), null,
  "Footprint-aware placement must never displace a locked card");
});

test("dragged block geometry displaces neighbors before the grab point crosses their midpoint", () => {
  const order = ["first", "second", "third"];
  const horizontalItems = [
    { id: "first", rect: rect(0, 0, 100) },
    { id: "second", rect: rect(100, 0, 100) },
    { id: "third", rect: rect(200, 0, 100) },
  ];
  assert.deepEqual(resolveBlockInsertion({ order, items: horizontalItems,
    activeId: "first", pointer: { x: 105, y: 40 }, dragRect: rect(65, 0, 100),
    dragDirection: { x: 1, y: 0 }, variant: "grid", hysteresis: 8 })?.order,
  ["second", "first", "third"],
  "A dragged block's leading right edge should cross a neighbor midpoint before the cursor gets there");
  assert.deepEqual(resolveBlockInsertion({ order, items: horizontalItems,
    activeId: "third", pointer: { x: 195, y: 40 }, dragRect: rect(135, 0, 100),
    dragDirection: { x: -1, y: 0 }, variant: "grid", hysteresis: 8 })?.order,
  ["first", "third", "second"],
  "Dragging left must mirror the same leading-edge midpoint threshold");

  const verticalItems = [
    { id: "first", rect: rect(0, 0, 100, 80) },
    { id: "second", rect: rect(0, 80, 100, 160) },
    { id: "third", rect: rect(0, 240, 100, 80) },
  ];
  assert.deepEqual(resolveBlockInsertion({ order, items: verticalItems,
    activeId: "first", pointer: { x: 30, y: 105 }, dragRect: rect(0, 90, 100, 80),
    dragDirection: { x: 0, y: 1 } })?.order,
  ["second", "first", "third"],
  "A report section should move when its bottom edge crosses a taller section's midpoint");
  assert.deepEqual(resolveBlockInsertion({ order, items: verticalItems,
    activeId: "third", pointer: { x: 30, y: 195 }, dragRect: rect(0, 145, 100, 80),
    dragDirection: { x: 0, y: -1 } })?.order,
  ["first", "third", "second"],
  "A report section moving upward should use its leading top edge rather than its grab point");
});

test("dashboard rows reconcile saved placement with new and hidden authored blocks", () => {
  const authored = [
    { id: "metrics", items: ["users", "growth"] },
    { id: "evidence", items: ["trend", "accounts"] },
  ];
  assert.deepEqual(reconcileBlockRows(authored, [
    { id: "evidence", items: ["accounts", "users"] },
    { id: "metrics", items: ["growth"] },
  ], ["users", "growth", "trend", "accounts"]), [
    { id: "evidence", items: ["accounts", "users", "trend"] },
    { id: "metrics", items: ["growth"] },
  ]);
  assert.deepEqual(reconcileBlockRows(authored, [
    { id: "metrics", items: ["growth", "users"] },
  ], ["users", "trend", "accounts"], ["growth"]), [
    { id: "metrics", items: ["growth", "users"] },
    { id: "evidence", items: ["trend", "accounts"] },
  ]);
  const addedRows = [authored[0], { id: "activation", items: ["funnel"] },
    { id: "retention", items: ["cohorts"] }, authored[1]];
  const saved = [{ id: "metrics", items: ["growth", "users"] },
    { id: "evidence", items: ["accounts", "trend"] }];
  const ids = ["users", "growth", "funnel", "cohorts", "trend", "accounts"];
  assert.deepEqual(reconcileBlockRows(addedRows, saved, ids),
    [saved[0], addedRows[1], addedRows[2], saved[1]],
    "New rows belong beside their authored neighbors, not at the bottom of an older saved layout");
  const moved = [...saved, addedRows[2], addedRows[1]];
  assert.deepEqual(reconcileBlockRows(addedRows, moved, ids), moved,
    "Already placed rows must retain the user's arrangement");
});

test("dashboard row sizing preserves readable minimums and fills available space", () => {
  const blocks = {
    chart: { kind: "chart", span: 8, minSpan: 6 },
    custom: { kind: "custom", span: 4, minSpan: 3 },
    metric: { kind: "metric", span: 3, minSpan: 3 },
    another: { kind: "metric", span: 3, minSpan: 3 },
    table: { kind: "table", span: 8, minSpan: 8 },
  };
  assert.deepEqual(rebalanceBlockRow(["chart", "custom"], blocks), { chart: 8, custom: 4 });
  assert.deepEqual(rebalanceBlockRow(["chart", "custom", "metric"], blocks),
    { chart: 6, custom: 3, metric: 3 });
  assert.deepEqual(rebalanceBlockRow(["chart", "metric"], blocks,
    { currentSpans: { chart: 12, metric: 3 } }), { chart: 9, metric: 3 });
  assert.deepEqual(rebalanceBlockRow(["metric", "another"], blocks),
    { metric: 6, another: 6 });
  assert.equal(rebalanceBlockRow(["table", "metric", "another"], blocks), null,
    "A table cannot be compressed below its readable minimum to accept additional metrics");
  assert.equal(rebalanceBlockRow(["chart", "custom", "metric"], blocks,
    { autoResize: false }), null,
  "Disabling automatic resizing should reject destinations that need existing blocks to shrink");
  assert.equal(rebalanceBlockRow(["chart", "custom", "metric"], {
    ...blocks, chart: { ...blocks.chart, locked: true }, custom: { ...blocks.custom, locked: true },
  }), null, "Locked block widths cannot be altered to accept a new neighbor");
  assert.equal(rebalanceBlockRow(["chart", "custom"], blocks,
    { minimumSpans: { ...defaultBlockMinimumSpans, chart: 10 } }), null,
  "Live layout policy can raise a block's minimum without bypassing authored constraints");
  assert.equal(rebalanceBlockRow(["chart", "custom"], {
    ...blocks, chart: { ...blocks.chart, measuredMinSpan: 10 },
  }), null, "Measured readable content widths override an otherwise mathematically valid column span");
  assert.deepEqual(rebalanceBlockRow(["chart", "custom"], blocks,
    { currentSpans: { chart: 7, custom: 5 }, preferredSpans: { chart: 8, custom: 4 } }),
  { chart: 7, custom: 5 }, "Current allocated widths remain separate from preserved authored preferences");
  const flexibleCharts = {
    first: { kind: "chart", span: 4, minSpan: 4 },
    second: { kind: "chart", span: 4, minSpan: 4 },
    third: { kind: "chart", span: 4, minSpan: 4 },
  };
  assert.deepEqual(rebalanceBlockRow(["first", "second", "third"], flexibleCharts),
    { first: 4, second: 4, third: 4 },
    "Readable compact charts should support three-column dashboard compositions");
  assert.deepEqual(rebalanceBlockRow(["first", "second"], flexibleCharts,
    { currentSpans: { first: 7, second: 5 } }), { first: 7, second: 5 },
  "Chart pairs should allow asymmetric widths instead of locking both items at half width");
  assert.deepEqual(defaultBlockMinimumSpans,
    { metric: 2, chart: 3, custom: 3, table: 3, block: 3 },
    "Only metrics should have a smaller minimum than other freely resizable dashboard blocks");
  assert.deepEqual(rebalanceBlockRow(["table", "chart", "custom", "block"], {
    table: { kind: "table", span: 3 }, chart: { kind: "chart", span: 3 },
    custom: { kind: "custom", span: 3 }, block: { kind: "block", span: 3 },
  }), { table: 3, chart: 3, custom: 3, block: 3 },
  "Scrollable tables and all other non-metric blocks should support three-column compositions");
  const compactMetrics = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `metric-${index}`, { kind: "metric", span: 2, minSpan: 2 },
  ]));
  assert.deepEqual(rebalanceBlockRow(Object.keys(compactMetrics), compactMetrics),
    Object.fromEntries(Object.keys(compactMetrics).map((id) => [id, 2])),
    "Six genuinely compact metrics should fit across a twelve-column desktop row");
  const compactCharts = Object.fromEntries(Array.from({ length: 4 }, (_, index) => [
    `chart-${index}`, { kind: "chart", span: 3, minSpan: 3 },
  ]));
  assert.deepEqual(rebalanceBlockRow(Object.keys(compactCharts), compactCharts),
    Object.fromEntries(Object.keys(compactCharts).map((id) => [id, 3])),
    "Four readable compact charts should fit across a twelve-column desktop row");
});

test("explicit row resizing preserves minimums and remembers user-selected preferred widths", () => {
  const blocks = {
    chart: { kind: "chart", span: 8, minSpan: 6 },
    custom: { kind: "custom", span: 4, minSpan: 3 },
    table: { kind: "table", span: 12, minSpan: 8, measuredMinSpan: 12 },
  };
  const rows = [
    { id: "diagnostics", items: ["chart", "custom"] },
    { id: "evidence", items: ["table"] },
  ];
  const layout = { rows, spans: { chart: 8, custom: 4, table: 12 },
    preferredSpans: { chart: 8, custom: 4, table: 12 }, blocks };
  const resized = resizeBlockRow({ ...layout, activeId: "chart", span: 7 });
  assert.deepEqual(resized.spans, { chart: 7, custom: 5, table: 12 });
  assert.deepEqual(resized.preferredSpans, { chart: 7, custom: 4, table: 12 },
    "Only the directly resized block receives a new persistent preferred width");
  assert.equal(resizeBlockRow({ ...layout, activeId: "chart", span: 10 }), null,
    "A boundary drag cannot compress its neighbor below a readable minimum");
  assert.equal(resizeBlockRow({ ...layout, activeId: "table", span: 8 }), null,
    "A dense reviewed table cannot be manually resized below its measured readable width");
  const fullWidth = resizeBlockRow({ ...layout, activeId: "custom", span: 12 });
  assert.deepEqual(fullWidth.rows.map(({ items }) => items), [["chart"], ["custom"], ["table"]],
    "Choosing full width promotes a shared block to its own semantic row");
  assert.equal(fullWidth.preferredSpans.custom, 12);
});

test("same-row dashboard reordering preserves every current and preferred block width", () => {
  const blocks = Object.fromEntries(["first", "second", "third", "fourth"]
    .map((id) => [id, { kind: "metric", span: 3, minSpan: 2 }]));
  const rows = [{ id: "metrics", items: ["first", "second", "third", "fourth"] }];
  const spans = { first: 4, second: 2, third: 3, fourth: 3 };
  const preferredSpans = { first: 3, second: 3, third: 3, fourth: 3 };
  const moved = resolveCanvasMove({ rows, spans, preferredSpans, blocks,
    activeId: "fourth", targetId: "first", placement: "before" });

  assert.deepEqual(moved.rows[0].items, ["fourth", "first", "second", "third"]);
  assert.deepEqual(moved.spans, spans,
    "Changing positions within a row must not rebalance or resize any block");
  assert.deepEqual(moved.preferredSpans, preferredSpans,
    "A reorder must not replace widths previously chosen by the user");

  const movedAgain = resolveCanvasMove({ ...moved, blocks,
    activeId: "fourth", targetId: "second", placement: "after" });
  assert.deepEqual(movedAgain.spans, spans,
    "Repeated drag-preview updates within the same row must also retain the original widths");
});

test("canvas pointer movement never displaces a locked block", () => {
  const blocks = {
    first: { kind: "metric", span: 4, minSpan: 2 },
    locked: { kind: "metric", span: 4, minSpan: 2, locked: true },
    last: { kind: "metric", span: 4, minSpan: 2 },
  };
  const rows = [{ id: "metrics", items: ["first", "locked", "last"] }];
  const spans = { first: 4, locked: 4, last: 4 };
  assert.equal(resolveCanvasMove({ rows, spans, blocks, activeId: "last", targetId: "first",
    placement: "before" }), null,
  "A pointer move across a locked block cannot shift that block's protected position");
  assert.equal(resolveCanvasMove({ rows, spans, blocks, activeId: "first", targetId: "last",
    placement: "after" }), null,
  "Locked canvas positions must remain protected in either drag direction");
});

test("generated rows containing only hidden blocks survive unrelated visible moves", () => {
  const blocks = {
    first: { kind: "metric", span: 6, minSpan: 2 },
    second: { kind: "metric", span: 6, minSpan: 2 },
  };
  const rows = [
    { id: "metrics", items: ["first", "second"] },
    { id: "row:hidden", items: [] },
  ];
  const moved = resolveCanvasMove({ rows, spans: { first: 6, second: 6 }, blocks,
    activeId: "second", targetId: "first", placement: "before", retainedRowIds: ["row:hidden"] });
  assert.deepEqual(moved.rows, [
    { id: "metrics", items: ["second", "first"] },
    { id: "row:hidden", items: [] },
  ], "A hidden-only generated row must remain available for the protected commit to restore its hidden occupants");
  assert.deepEqual(moved.retainedRowIds, ["row:hidden"]);
});

test("shared dashboard dividers resize only their two adjacent blocks", () => {
  const blocks = Object.fromEntries(["first", "second", "third", "fourth"]
    .map((id) => [id, { kind: "metric", span: 3, minSpan: 2 }]));
  const rows = [{ id: "metrics", items: ["first", "second", "third", "fourth"] }];
  const spans = { first: 3, second: 3, third: 3, fourth: 3 };
  const preferredSpans = { ...spans };
  const narrowed = resizeBlockRow({ rows, spans, preferredSpans, blocks,
    activeId: "third", neighborId: "fourth", span: 2 });

  assert.deepEqual(narrowed.spans, { first: 3, second: 3, third: 2, fourth: 4 },
    "Moving a divider must transfer space only across that divider");
  assert.deepEqual(narrowed.preferredSpans, { first: 3, second: 3, third: 2, fourth: 4 },
    "An explicit divider adjustment should remember both adjacent widths");

  const restored = resizeBlockRow({ ...narrowed, blocks,
    activeId: "third", neighborId: "fourth", span: 3 });
  assert.deepEqual(restored.spans, spans,
    "A divider must remain reversible after either neighboring block changes size");
  assert.equal(resizeBlockRow({ rows, spans, preferredSpans, blocks,
    activeId: "third", neighborId: "first", span: 4 }), null,
  "A divider cannot transfer columns to a nonadjacent block");
  assert.equal(resizeBlockRow({ rows, spans, preferredSpans, blocks,
    activeId: "third", neighborId: "fourth", span: 5 }), null,
  "A divider cannot shrink its immediate neighbor below its minimum width");

  const constrained = { first: 2, second: 3, third: 3, fourth: 4 };
  const constrainedBlocks = {
    ...blocks,
    second: { ...blocks.second, minSpan: 3 },
    third: { ...blocks.third, minSpan: 3 },
  };
  const expanded = resizeBlockRow({ rows, spans: constrained, preferredSpans: constrained,
    blocks: constrainedBlocks, activeId: "first", neighborId: "second", span: 3 });
  assert.deepEqual(expanded.spans, { first: 3, second: 3, third: 3, fourth: 3 },
    "A narrow block should draw from the nearest available block when intervening neighbors are already at their minimum");
  assert.equal(expanded.preferredSpans.second, 3,
    "Passing a resize through a constrained neighbor must preserve that neighbor's chosen width");
});

test("dashboard canvas moves individual blocks across columns and semantic rows", () => {
  const blocks = {
    users: { kind: "metric", span: 3, minSpan: 3 },
    growth: { kind: "metric", span: 3, minSpan: 3 },
    chart: { kind: "chart", span: 8, minSpan: 6 },
    custom: { kind: "custom", span: 4, minSpan: 3 },
    table: { kind: "table", span: 12, minSpan: 8 },
  };
  const rows = [
    { id: "metrics", items: ["users", "growth"] },
    { id: "diagnostics", items: ["chart", "custom"] },
    { id: "evidence", items: ["table"] },
  ];
  const spans = { users: 6, growth: 6, chart: 8, custom: 4, table: 12 };
  const inserted = resolveCanvasMove({ rows, spans, blocks,
    activeId: "users", targetId: "custom", placement: "after" });
  assert.deepEqual(inserted.rows, [
    { id: "metrics", items: ["growth"] },
    { id: "diagnostics", items: ["chart", "custom", "users"] },
    { id: "evidence", items: ["table"] },
  ]);
  assert.deepEqual(inserted.spans, { users: 3, growth: 12, chart: 6, custom: 3, table: 12 });

  const newRow = resolveCanvasMove({ ...inserted, blocks,
    activeId: "users", targetId: "chart", placement: "above" });
  assert.deepEqual(newRow.rows.map(({ id, items }) => [id, items]), [
    ["metrics", ["growth"]],
    ["row:users", ["users"]],
    ["diagnostics", ["chart", "custom"]],
    ["evidence", ["table"]],
  ]);
  assert.equal(newRow.spans.users, 12,
    "A block dropped between rows should own a newly created full-width row");
  assert.equal(resolveCanvasMove({ ...newRow, blocks,
    activeId: "users", targetId: "chart", placement: "above" }), null,
  "Repeated pointer samples over the same row boundary must not create duplicate empty rows");

  const returned = resolveCanvasMove({ ...newRow, blocks,
    activeId: "users", targetId: "growth", placement: "after" });
  assert.equal(returned.rows.some((row) => row.id === "row:users"), false,
    "Automatically created rows disappear after their last block moves elsewhere");
  assert.equal(resolveCanvasMove({ rows, spans, blocks,
    activeId: "chart", targetId: "table", placement: "after" }), null,
  "A destination is rejected when its components cannot satisfy their combined minimum widths");
});

test("dashboard canvas resolves horizontal insertion versus new-row boundaries", () => {
  const rows = [
    { id: "metrics", items: ["users", "growth"] },
    { id: "diagnostics", items: ["chart", "custom"] },
  ];
  const blocks = {
    users: { kind: "metric", span: 3 },
    growth: { kind: "metric", span: 3 },
    chart: { kind: "chart", span: 8 },
    custom: { kind: "custom", span: 4 },
  };
  const items = [
    { id: "users", rect: rect(0, 0, 100, 80) },
    { id: "growth", rect: rect(120, 0, 100, 80) },
    { id: "chart", rect: rect(0, 140, 200, 100) },
    { id: "custom", rect: rect(220, 140, 100, 100) },
  ];
  const options = { rows, spans: { users: 6, growth: 6, chart: 8, custom: 4 },
    blocks, activeId: "users", items };
  assert.equal(resolveCanvasInsertion({ ...options, pointer: { x: 285, y: 185 } }).placement, "after");
  assert.equal(resolveCanvasInsertion({ ...options, pointer: { x: 274, y: 185 }, hysteresis: 8 }), null,
    "The live insertion hysteresis setting should prevent midpoint jitter on the dashboard canvas");
  assert.equal(resolveCanvasInsertion({ ...options, pointer: { x: 120, y: 145 } }).placement, "after",
    "Even the upper edge of a block must prioritize inserting into its existing row");
  const pending = resolveCanvasInsertion({ ...options, pointer: { x: 120, y: 110 } });
  assert.deepEqual(pending, {
    key: "metrics:diagnostics", targetId: "chart", placement: "above", pending: true,
    beforeRowId: "metrics", afterRowId: "diagnostics",
  }, "Only the middle of the actual blank space between rows can request delayed row creation");
  const edgeDriven = resolveCanvasInsertion({ ...options,
    pointer: { x: 120, y: 35 }, dragRect: rect(80, 0, 100, 80),
    dragDirection: { x: 1, y: 0 }, hysteresis: 8 });
  assert.equal(edgeDriven.placement, "after",
    "The dragged block's leading edge must cross its neighbor's midpoint before the pointer does");
  assert.deepEqual(edgeDriven.rows[0].items, ["growth", "users"]);
  assert.equal(resolveCanvasInsertion({ ...options, pointer: { x: 120, y: 91 } }).key,
    "metrics:diagnostics",
    "Wide genuine whitespace must expose the full visible row target even while neighboring blocks settle");
  const confirmed = resolveCanvasInsertion({ ...options,
    pointer: { x: 120, y: 110 }, allowNewRow: true });
  assert.equal(confirmed.placement, "above");
  assert.deepEqual(confirmed.rows[1], { id: "row:users", items: ["users"] },
    "A new row opens only after the pointer's existing gap candidate is explicitly confirmed");
  const shifted = resolveCanvasInsertion({ ...options,
    pointer: { x: 120, y: 185 }, allowNewRow: true, stickyGap: pending.key,
    confirmedGap: pending });
  assert.equal(shifted.rowId, "diagnostics",
    "Returning inside an occupied row must cancel even a previously confirmed sticky gap target");
  assert.equal(resolveCanvasInsertion({ ...options, pointer: { x: 200, y: 84 } }).placement, "after",
    "Existing-row attraction should keep the outer portion of a blank gap attached to its nearest row");
  const tallItems = items.map((item) => item.id === "chart"
    ? { ...item, rect: rect(0, 90, 300, 500) } : item);
  const tallTarget = resolveCanvasInsertion({ ...options, items: tallItems,
    pointer: { x: 150, y: 94 } });
  assert.equal(tallTarget.targetId, "chart",
    "A pointer inside a tall chart's upper edge must target that chart instead of a nearby metric center");
  assert.equal(tallTarget.placement, "after",
    "Tall chart boundaries should not spontaneously create a new dashboard row");
  const first = resolveCanvasInsertion({ ...options, activeId: "custom",
    pointer: { x: 120, y: -20 } });
  assert.equal(first.key, "start:metrics",
    "A visible insertion zone should allow creating a row above the first existing dashboard row");
  const last = resolveCanvasInsertion({ ...options, pointer: { x: 120, y: 260 } });
  assert.equal(last.key, "diagnostics:end",
    "A visible insertion zone should allow creating a row below the final dashboard row");
  const sticky = resolveCanvasInsertion({ ...options, pointer: { x: 120, y: 89 },
    stickyGap: "metrics:diagnostics" });
  assert.equal(sticky.key, "metrics:diagnostics",
    "Once selected, an insertion zone remains sticky while the pointer moves within a forgiving boundary");
});

test("a stretched metric returns to an existing short row before requesting a new row", () => {
  const rows = [
    { id: "metrics", items: ["first", "second"] },
    { id: "charts", items: ["chart", "moving"] },
  ];
  const blocks = {
    first: { kind: "metric", span: 6 }, second: { kind: "metric", span: 6 },
    chart: { kind: "chart", span: 8 }, moving: { kind: "metric", span: 4 },
  };
  const items = [
    { id: "first", rect: rect(0, 0, 150, 100) },
    { id: "second", rect: rect(160, 0, 150, 100) },
    { id: "chart", rect: rect(0, 120, 210, 400) },
    { id: "moving", rect: rect(220, 120, 90, 400) },
  ];
  const options = { rows, spans: { first: 6, second: 6, chart: 8, moving: 4 },
    blocks, activeId: "moving", items, stickyGap: "start:metrics" };
  const returned = resolveCanvasInsertion({ ...options,
    pointer: { x: 180, y: 75 }, dragRect: rect(145, 55, 90, 400),
    dragDirection: { x: -1, y: -1 } });
  assert.equal(returned?.rowId, "metrics",
    "A metric stretched by a chart row must re-enter the short row as soon as its pointer reaches that row");
  assert.equal(returned?.pending, undefined,
    "An occupied existing row must always defeat a sticky or accidental above-row insertion target");
  assert.deepEqual(returned?.rows[0].items, ["first", "moving", "second"]);
  const paddedEdge = resolveCanvasInsertion({ ...options,
    pointer: { x: 180, y: -8 }, dragRect: rect(145, -25, 90, 400),
    dragDirection: { x: -1, y: -1 } });
  assert.equal(paddedEdge?.rowId, "metrics",
    "The first row's top padding must not expose an accidental above-row target while the card is still inside it");
});

test("directional drag tilt is smoothed, symmetric, clamped, and dead-zone aware", () => {
  const left = directionalBlockTilt({ position: 100, velocity: 0 }, 40, 16);
  const right = directionalBlockTilt({ position: 100, velocity: 0 }, 160, 16);
  assert.equal(left.degrees, -right.degrees);
  assert.equal(Math.abs(left.degrees) <= 1.5, true);
  assert.equal(directionalBlockTilt({ position: 100, velocity: 0 }, 100.1, 16).degrees, 0);
});

test("layout presentation allows only bounded stable region order and integer spans", () => {
  const valid = { "dashboard:metrics": {
    order: ["users", "conversion"], spans: { users: 3 }, preferredSpans: { users: 4 },
    rows: [{ id: "metric-row", items: ["users", "conversion"] }],
  } };
  assert.deepEqual(validateBlockLayouts(valid), valid);
  assert.deepEqual(validateBlockLayouts({ region: { order: ["users"], authoredRevision: 2 } }),
    { region: { order: ["users"], authoredRevision: 2 } },
    "An explicitly versioned authored layout remains safe presentation-only metadata");
  assert.deepEqual(validatePresentation({ blockLayouts: valid }), { blockLayouts: valid });
  assert.deepEqual(normalizePresentation({ blockLayouts: {
    "dashboard:metrics": { order: ["users"] }, broken: { order: ["users", "users"] },
  } }), { blockLayouts: { "dashboard:metrics": { order: ["users"] } } });

  for (const invalid of [
    { region: { order: ["users", "users"] } },
    { region: { order: ["users"], spans: { users: 0 } } },
    { region: { order: ["users"], spans: { users: 13 } } },
    { region: { order: ["users"], spans: { unknown: 3 } } },
    { region: { order: ["users"], preferredSpans: { users: 13 } } },
    { region: { order: ["users"], preferredSpans: { unknown: 3 } } },
    { region: { order: ["users"], authoredRevision: 0 } },
    { region: { order: ["users"], authoredRevision: -1 } },
    { region: { order: ["users"], authoredRevision: 1.5 } },
    { region: { order: ["users"], authoredRevision: 1_000_001 } },
    { region: { order: ["users"], authoredRevision: "2" } },
    { region: { order: ["users"], rows: [{ secret: true }] } },
    { region: { order: ["users"], rows: [{ id: "row", items: [] }] } },
    { region: { order: ["users"], rows: [{ id: "row", items: ["unknown"] }] } },
    { region: { order: ["users"], rows: [
      { id: "row", items: ["users"] }, { id: "row", items: [] },
    ] } },
    { region: { order: ["users"], rows: [
      { id: "first", items: ["users"] }, { id: "second", items: ["users"] },
    ] } },
    { region: { order: ["users"], rows: [{ id: "row", items: ["users"], sql: "select 1" }] } },
    { region: { order: ["constructor"] } },
    { " ": { order: ["users"] } },
    Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`region-${index}`, { order: [] }])),
  ]) {
    assert.throws(() => validatePresentation({ blockLayouts: invalid }), /Block layout/u);
  }
  assert.deepEqual(normalizeBlockLayouts({ region: { order: ["users"], sql: "select 1" } }), {});
});

test("explicit authored redesigns supersede stale concurrent layouts without resetting other presentation", () => {
  const previous = { title: "Keep my title", filters: { segment: "Enterprise" }, blockLayouts: {
    main: { order: ["first", "second"], authoredRevision: 1,
      rows: [{ id: "old", items: ["first", "second"] }], spans: { first: 8, second: 4 } },
    sidebar: { order: ["note", "table"] },
  } };
  const redesigned = { ...previous, blockLayouts: { ...previous.blockLayouts,
    main: { order: ["second", "first"], authoredRevision: 2,
      rows: [{ id: "custom", items: ["second", "first"] }], spans: { first: 5, second: 7 } },
  } };
  const concurrent = { ...previous, title: "Another owner's title", blockLayouts: { ...previous.blockLayouts,
    main: { order: ["second", "first"], authoredRevision: 1,
      rows: [{ id: "old", items: ["second", "first"] }], spans: { first: 6, second: 6 } },
  } };
  const merged = mergePresentationChanges(previous, redesigned, concurrent);
  assert.deepEqual(merged.blockLayouts.main, redesigned.blockLayouts.main,
    "A newer authored revision must replace the stale region even during a hosted write conflict");
  assert.deepEqual(merged.blockLayouts.sidebar, previous.blockLayouts.sidebar,
    "Redesigning one region must preserve an independently customized second region");
  assert.equal(merged.title, "Another owner's title",
    "An explicit layout redesign must not overwrite independently edited dashboard titles");
  assert.deepEqual(merged.filters, previous.filters);

  const staleEdit = { ...previous, blockLayouts: { ...previous.blockLayouts,
    main: { ...previous.blockLayouts.main, order: ["second", "first"] },
  } };
  assert.deepEqual(mergePresentationChanges(previous, staleEdit, redesigned).blockLayouts.main,
    redesigned.blockLayouts.main,
    "An old editor cannot replay stale placement over a newer explicit authored redesign");
});

test("block order persists separately from reviewed rows and merges independent regions", () => {
  const snapshot = { id: "layout-dashboard" };
  const storage = memoryStorage();
  const previous = { blockLayouts: { metrics: { order: ["users", "growth"] } } };
  const next = { blockLayouts: { metrics: { order: ["growth", "users"] } } };
  const concurrent = { blockLayouts: {
    metrics: { order: ["users", "growth"] }, evidence: { order: ["table", "chart"] },
  } };
  assert.equal(writeLocalPresentation(snapshot, next, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), next);
  assert.deepEqual(mergePresentationChanges(previous, next, concurrent), {
    blockLayouts: {
      metrics: { order: ["growth", "users"] }, evidence: { order: ["table", "chart"] },
    },
  });
  assert.throws(() => validatePresentation({ blockLayouts: {
    metrics: { order: ["users"], provenance: { table: "private" } },
  } }), /Block layout/u);
});

test("concurrent same-region moves replay against the latest hosted block order", () => {
  const previous = { blockLayouts: { region: { order: ["a", "b", "c", "d"] } } };
  const mine = { blockLayouts: { region: { order: ["b", "a", "c", "d"] } } };
  const theirs = { blockLayouts: { region: { order: ["a", "b", "d", "c"] } } };
  assert.deepEqual(mergePresentationChanges(previous, mine, theirs), {
    blockLayouts: { region: { order: ["b", "a", "d", "c"] } },
  }, "Independent moves within one region must both survive a hosted revision conflict");
});

test("same-revision owner moves continue merging after an explicit authored redesign", () => {
  const previous = { blockLayouts: { region: {
    order: ["a", "b", "c", "d"], authoredRevision: 3,
  } } };
  const mine = { blockLayouts: { region: {
    order: ["b", "a", "c", "d"], authoredRevision: 3,
  } } };
  const theirs = { blockLayouts: { region: {
    order: ["a", "b", "d", "c"], authoredRevision: 3,
  } } };
  assert.deepEqual(mergePresentationChanges(previous, mine, theirs), {
    blockLayouts: { region: { order: ["b", "a", "d", "c"], authoredRevision: 3 } },
  }, "Versioned layouts must still merge independent owner moves on the same authored revision");
});

test("concurrent row moves and independent block resizing survive hosted conflict rebasing", () => {
  const previous = { blockLayouts: { region: {
    order: ["a", "b", "c", "d"],
    rows: [{ id: "first", items: ["a", "b"] }, { id: "second", items: ["c", "d"] }],
    spans: { a: 6, b: 6, c: 6, d: 6 }, preferredSpans: { a: 6, b: 6, c: 6, d: 6 },
  } } };
  const mine = { blockLayouts: { region: {
    order: ["b", "a", "c", "d"],
    rows: [{ id: "first", items: ["b", "a"] }, { id: "second", items: ["c", "d"] }],
    spans: { a: 5, b: 7, c: 6, d: 6 }, preferredSpans: { a: 5, b: 7, c: 6, d: 6 },
  } } };
  const theirs = { blockLayouts: { region: {
    order: ["a", "b", "d", "c"],
    rows: [{ id: "first", items: ["a", "b"] }, { id: "second", items: ["d", "c"] }],
    spans: { a: 6, b: 6, c: 7, d: 5 }, preferredSpans: { a: 6, b: 6, c: 7, d: 5 },
  } } };
  assert.deepEqual(mergePresentationChanges(previous, mine, theirs), {
    blockLayouts: { region: {
      order: ["b", "a", "d", "c"],
      rows: [{ id: "first", items: ["b", "a"] }, { id: "second", items: ["d", "c"] }],
      spans: { a: 5, b: 7, c: 7, d: 5 }, preferredSpans: { a: 5, b: 7, c: 7, d: 5 },
    } },
  });
});

test("concurrent cross-row moves retain the other editor's same-row reorder", () => {
  const previous = { blockLayouts: { region: {
    order: ["a", "b", "c", "d"],
    rows: [{ id: "first", items: ["a", "b"] }, { id: "second", items: ["c", "d"] }],
  } } };
  const mine = { blockLayouts: { region: {
    order: ["b", "c", "a", "d"],
    rows: [{ id: "first", items: ["b"] }, { id: "second", items: ["c", "a", "d"] }],
  } } };
  const theirs = { blockLayouts: { region: {
    order: ["a", "b", "d", "c"],
    rows: [{ id: "first", items: ["a", "b"] }, { id: "second", items: ["d", "c"] }],
  } } };
  assert.deepEqual(mergePresentationChanges(previous, mine, theirs), {
    blockLayouts: { region: {
      order: ["b", "a", "d", "c"],
      rows: [{ id: "first", items: ["b"] }, { id: "second", items: ["a", "d", "c"] }],
    } },
  }, "A local row reassignment should preserve the latest row's independently reordered neighbors");
});

test("protected block reordering is the public authoring contract on both surfaces", async () => {
  const [publicApi, dashboard, report] = await Promise.all([
    "../src/data-app-public.jsx",
    "../src/content/dashboard/DashboardContent.jsx",
    "../src/content/report/ReportContent.jsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.match(publicApi, /export\s*\{\s*SortableItem,\s*SortableRegion\s*\}/u);
  assert.match(dashboard, /<SortableRegion id="dashboard:dashboard:canvas"[\s\S]*?variant="canvas"/u);
  assert.equal((dashboard.match(/<SortableRegion\b/gu) ?? []).length, 1,
    "A dashboard should expose one block canvas without competing nested row drag affordances");
  assert.doesNotMatch(dashboard, /kind="group"/u);
  assert.match(report, /<SortableRegion id="report:sections"/u);
  assert.doesNotMatch(report, /<SortableItem id="report-summary"/u,
    "This starter keeps its opening outside optional report section ordering");

});

test("bespoke dashboard layouts attach protected sortable blocks without relying on minified component names", async () => {
  const adapter = await readFile(new URL("../src/content/shared/SortableDashboardLayout.jsx", import.meta.url), "utf8");
  assert.match(adapter, /variant=\{canvas\s*\?\s*"canvas"\s*:\s*"freeform"\}/u,
    "Compatible authored grids should use the full canvas while genuinely bespoke layouts retain freeform movement");
  assert.match(adapter, /getBoundingClientRect\(\)/u,
    "Canvas promotion must preserve the existing authored row geometry instead of assuming a rigid template");
  assert.match(adapter, /span=\{canvas\?\.spans\[metadata\.id\]\}/u,
    "Measured canvas items must retain explicit widths for neighbor-aware resizing and persistence");
  assert.match(adapter, /rows=\{canvas\?\.rows\}/u,
    "Measured canvas regions need semantic authored rows for coordinated movement and resizing");
  assert.match(adapter, /<SortableItem\s+key=\{metadata\.id\}\s+id=\{metadata\.id\}/u,
    "Movable blocks must retain their stable reviewed component identities");
  assert.match(adapter, /transferGroup=\{!canvas\s*&&\s*!metrics/u,
    "Metrics should not accidentally transfer into unrelated visualization regions");
  assert.match(adapter, /visible\(metadata\.id\)/u,
    "Owner-hidden reviewed blocks must remain hidden in the authored sortable adapter");
  assert.doesNotMatch(adapter, /element\.type\.(?:displayName|name)/u,
    "Production minification must not silently disable the entire dashboard drag system");
});

test("block layout state is isolated and measured constraints invalidate after presentation changes", async () => {
  const [context, shell, sortable] = await Promise.all([
    "../src/DataAppContext.jsx",
    "../src/DataAppShell.jsx",
    "../src/components/SortableRegion.jsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  assert.match(context, /export const DataAppBlockLayoutContext = createContext\(null\)/u);
  assert.match(shell, /const shellContext = useMemo\(/u);
  assert.match(shell, /const blockLayoutContext = useMemo\(/u);
  assert.match(sortable, /useDataAppBlockLayouts\(\)/u);
  assert.match(sortable, /titleOverrides\[itemId\]/u);
  assert.match(sortable, /document\.fonts\?\.addEventListener\?\.\("loadingdone"/u);
  assert.match(sortable, /new MutationObserver\(invalidate\)/u);
});
