import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changeChartEditorSpec,
  changeChartEditorState,
  chartEditorChoices,
  chartEditorPresentationsEqual,
  chartEditorPreviewState,
  chartEditorShortcut,
  chartEditorSpecsEqual,
  copyChartEditorPresentation,
  createChartEditorState,
  resetChartEditorState,
  saveChartEditorPresentation,
  stepChartEditorHistory,
} from "../src/charting/chart-editor-state.js";

const original = {
  chart: { type: "line", x: "week", y: "wau", colors: { wau: "#0285ff" } },
  title: "Weekly active users",
  description: "Reviewed weekly observations",
};

test("editor equality expands defaults without rewriting authored chart specs", () => {
  const state = createChartEditorState(original);
  assert.deepEqual(state.draft, original);
  assert.equal(Object.hasOwn(state.draft.chart, "fields"), false);
  assert.equal(
    chartEditorSpecsEqual(original.chart, {
      ...original.chart,
      fields: ["wau"],
      series: "",
      showLegend: true,
      showValues: false,
      startAtZero: true,
      sortOrder: "original",
    }),
    true,
  );
  assert.equal(chartEditorSpecsEqual(original.chart, { ...original.chart, showXAxisLabel: false }), false);
  assert.equal(
    chartEditorSpecsEqual(
      { type: "rankedList", y: "wau" },
      {
        type: "rankedList",
        y: "wau",
        sortOrder: "descending",
      },
    ),
    true,
  );
  assert.equal(chartEditorPresentationsEqual(original, { ...original, title: "Changed" }), false);
});

test("changing a long-form split never leaves pivot labels as raw measure fields", () => {
  const chart = { type: "line", x: "week", y: "wau", series: "plan", fields: ["Free", "Team"] };
  const reviewed = { columns: ["week", "plan", "country", "wau", "dau"] };
  assert.deepEqual(changeChartEditorSpec(chart, "series", "", reviewed), {
    ...chart,
    series: "",
    fields: ["wau"],
  });
  assert.deepEqual(changeChartEditorSpec(chart, "series", "country", reviewed), {
    ...chart,
    series: "country",
    fields: ["wau"],
  });
  assert.deepEqual(changeChartEditorSpec(chart, "x", "plan", reviewed), {
    ...chart,
    x: "plan",
    series: "",
    fields: ["wau"],
  });
  assert.deepEqual(changeChartEditorSpec(chart, "y", "dau", reviewed), {
    ...chart,
    y: "dau",
    fields: ["dau"],
  });
  assert.deepEqual(changeChartEditorSpec(chart, "series", "plan", reviewed), chart);
  assert.deepEqual(changeChartEditorSpec(chart, "series", ""), { ...chart, series: "", fields: ["wau"] });
  assert.deepEqual(chart.fields, ["Free", "Team"]);
});

test("wide-form measures survive split changes and the return to no series", () => {
  const chart = {
    type: "line",
    x: "week",
    y: "activeUsers",
    fields: ["activeUsers", "targetUsers"],
  };
  const reviewed = { columns: ["week", "plan", "country", "activeUsers", "targetUsers"] };
  const split = changeChartEditorSpec(chart, "series", "plan", reviewed);
  assert.deepEqual(split, { ...chart, series: "plan" });
  assert.deepEqual(changeChartEditorSpec(split, "series", "country", reviewed), {
    ...chart,
    series: "country",
  });
  const cleared = changeChartEditorSpec(split, "series", "", reviewed);
  assert.deepEqual(cleared, { ...chart, series: "" });
  assert.equal(chartEditorSpecsEqual(cleared, chart), true);
  assert.deepEqual(changeChartEditorSpec(split, "x", "plan", reviewed), {
    ...chart,
    x: "plan",
    series: "",
  });

  const changedMeasure = changeChartEditorSpec(split, "y", "targetUsers", reviewed);
  assert.deepEqual(changedMeasure.fields, ["targetUsers"]);
  assert.deepEqual(changeChartEditorSpec(changedMeasure, "series", "", reviewed).fields, ["targetUsers"]);
  assert.deepEqual(chart.fields, ["activeUsers", "targetUsers"]);

  let state = createChartEditorState({ ...original, chart });
  state = changeChartEditorState(state, { ...state.draft, chart: split }, "series");
  state = changeChartEditorState(state, { ...state.draft, chart: cleared }, "series");
  assert.equal(state.dirty, false);
  assert.deepEqual(stepChartEditorHistory(state, -1).draft.chart, split);
  assert.deepEqual(stepChartEditorHistory(stepChartEditorHistory(state, -1), -1).draft.chart, chart);
});

test("split normalization preserves authored raw roles without numeric re-inference", () => {
  const rows = [
    { week: "2026-08-10", plan: "Pro", activeUsers: 12, missingTarget: null, legacyTarget: "14" },
    { week: "2026-08-17", plan: "Team", activeUsers: 13, missingTarget: null, legacyTarget: "15" },
  ];
  const reviewed = { columns: [...new Set(rows.flatMap(Object.keys))] };
  const chart = {
    type: "line",
    x: "week",
    y: "activeUsers",
    fields: ["activeUsers", "missingTarget", "legacyTarget"],
  };
  const split = changeChartEditorSpec(chart, "series", "plan", reviewed);
  assert.deepEqual(split.fields, chart.fields);
  assert.deepEqual(changeChartEditorSpec(split, "series", "", reviewed).fields, chart.fields);
});

test("partially overlapping pivot labels never become a partial wide measure list", () => {
  const chart = { type: "line", x: "week", y: "wau", series: "plan", fields: ["Free", "Team"] };
  const reviewed = { columns: ["week", "plan", "country", "wau", "Free"] };
  for (const [field, value] of [
    ["series", ""],
    ["series", "country"],
    ["x", "plan"],
  ]) {
    assert.deepEqual(changeChartEditorSpec(chart, field, value, reviewed).fields, ["wau"]);
  }
  assert.deepEqual(changeChartEditorSpec(chart, "series", "plan", reviewed), chart);
  assert.deepEqual(chart.fields, ["Free", "Team"]);
});

test("explicit capability roles preserve approved numeric series and all-null measures", () => {
  const chart = { type: "line", x: "week", y: "allNull", series: "cohortYear" };
  const fields = { columns: ["week", "cohortYear", "wau", "allNull"], numeric: ["cohortYear", "wau"] };
  const inferred = chartEditorChoices(chart, chart, fields);
  assert.deepEqual(inferred.yFields, ["cohortYear", "wau"]);
  assert.deepEqual(inferred.seriesFields, ["", "allNull"]);

  const approved = chartEditorChoices(chart, chart, fields, {
    xFields: ["week", "privateColumn"],
    yFields: ["allNull", "privateColumn"],
    seriesFields: ["", "cohortYear", "privateColumn"],
  });
  assert.deepEqual(approved.xFields, ["week"]);
  assert.deepEqual(approved.yFields, ["allNull"]);
  assert.deepEqual(approved.seriesFields, ["", "cohortYear"]);
});

test("a non-stackable authored stacked chart retains only its existing stacked type", () => {
  const chart = { type: "stackedBar", x: "week", y: "wau", stackable: false };
  const fields = { columns: ["week", "wau"], numeric: ["wau"] };
  const inferred = chartEditorChoices(chart, chart, fields);
  assert.deepEqual(
    inferred.availableTypes.filter((type) => type.toLowerCase().includes("stacked")),
    ["stackedBar"],
  );
  const approved = chartEditorChoices(chart, chart, fields, {
    types: ["stackedBar", "stackedArea", "line", "invented"],
  });
  assert.deepEqual(approved.availableTypes, ["line", "stackedBar"]);
});

test("editor history isolates drafts, groups continuous text, and restores clean state", () => {
  let state = createChartEditorState(original);
  const changed = copyChartEditorPresentation(state.draft);
  changed.chart.showLegend = false;
  state = changeChartEditorState(state, changed, "showLegend");
  changed.chart.colors.wau = "#ffffff";
  assert.equal(state.initial.chart.colors.wau, "#0285ff");
  assert.equal(state.draft.chart.colors.wau, "#0285ff");
  assert.equal(state.dirty, true);

  state = changeChartEditorState(state, { ...state.draft, title: "Week" }, "title");
  state = changeChartEditorState(state, { ...state.draft, title: "Weekly users" }, "title");
  assert.equal(state.history.length, 3);
  state = stepChartEditorHistory(state, -1);
  assert.equal(state.draft.title, original.title);
  assert.equal(state.draft.chart.showLegend, false);
  state = stepChartEditorHistory(state, -1);
  assert.equal(state.dirty, false);
  assert.deepEqual(state.draft, original);
  state = stepChartEditorHistory(state, 1);
  assert.equal(state.dirty, true);
  state = changeChartEditorState(state, { ...state.draft, description: "New caption" }, "description");
  assert.equal(state.history.length, 3);
  assert.equal(stepChartEditorHistory(state, 1), state);
});

test("reset restores the exact original as a draft and remains undoable", () => {
  const applied = { ...original, chart: { ...original.chart, type: "bar", fields: ["wau"], series: "" } };
  let state = createChartEditorState(applied);
  state = resetChartEditorState(state, original);
  assert.deepEqual(state.draft, original);
  assert.equal(Object.hasOwn(state.draft.chart, "fields"), false);
  assert.equal(state.dirty, true);
  assert.deepEqual(stepChartEditorHistory(state, -1).draft, applied);
  assert.deepEqual(state.initial, applied);

  const equivalent = createChartEditorState({ ...original, chart: { ...original.chart, fields: ["wau"] } });
  const resetEquivalent = resetChartEditorState(equivalent, original);
  assert.deepEqual(resetEquivalent.draft.chart, original.chart);
  assert.equal(resetEquivalent.dirty, false);
});

test("validation candidates cannot mutate an editor history snapshot", () => {
  const state = createChartEditorState(original);
  const candidate = copyChartEditorPresentation(state.draft);
  candidate.chart.colors.wau = "#ffffff";
  candidate.title = "Changed";
  assert.deepEqual(state.draft, original);
});

test("rejected validation and save callbacks preserve the original presentation", async () => {
  const state = createChartEditorState(original);
  let writes = 0;
  await assert.rejects(
    saveChartEditorPresentation(state.draft, {
      rows: [{ week: "2026-08-17", wau: 12 }],
      validatePresentation(candidate, rows) {
        assert.equal(rows[0].wau, 12);
        candidate.chart.colors.wau = "#ffffff";
        throw new Error("Unsupported chart mapping");
      },
      onSave() {
        writes += 1;
      },
    }),
    /Unsupported chart mapping/u,
  );
  assert.equal(writes, 0);
  assert.deepEqual(state.draft, original);

  await assert.rejects(
    saveChartEditorPresentation(state.draft, {
      async onSave(chart) {
        chart.colors.wau = "#ffffff";
        throw new Error("Save rejected");
      },
    }),
    /Save rejected/u,
  );
  assert.deepEqual(state.draft, original);
  await assert.rejects(
    saveChartEditorPresentation(state.draft, {
      validatePresentation() {
        return undefined;
      },
      onSave() {
        writes += 1;
      },
    }),
    /presentation is invalid/u,
  );
  assert.equal(writes, 0);
});

test("metadata saves are optional and never change the durable spec-only callback", async () => {
  const calls = [];
  await saveChartEditorPresentation(original, {
    onSave(...args) {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [[original.chart]]);
  await saveChartEditorPresentation(
    { ...original, title: " Updated title ", description: " Caption " },
    {
      editMetadata: true,
      onSave(...args) {
        calls.push(args);
      },
    },
  );
  assert.deepEqual(calls[1], [original.chart, { title: "Updated title", description: "Caption" }]);
  assert.equal(Object.hasOwn(calls[1][0], "title"), false);
  assert.equal(Object.hasOwn(calls[1][0], "description"), false);
  for (const patch of [{ title: " " }, { title: "x".repeat(501) }, { description: "x".repeat(2_001) }]) {
    await assert.rejects(
      saveChartEditorPresentation(
        { ...original, ...patch },
        {
          editMetadata: true,
          onSave() {
            throw new Error("must not save");
          },
        },
      ),
      /Chart (?:title|description) must/u,
    );
  }
});

test("editor shortcuts respect consumed nested events and platform modifiers", () => {
  assert.equal(chartEditorShortcut({ key: "z", metaKey: true }), "undo");
  assert.equal(chartEditorShortcut({ key: "Z", ctrlKey: true, shiftKey: true }), "redo");
  assert.equal(chartEditorShortcut({ key: "s", ctrlKey: true }), "save");
  assert.equal(chartEditorShortcut({ key: "s", metaKey: true, defaultPrevented: true }), null);
  assert.equal(chartEditorShortcut({ key: "z", ctrlKey: true, altKey: true }), null);
  assert.equal(chartEditorShortcut({ key: "z" }), null);
  assert.equal(chartEditorShortcut({ key: "Escape" }), null);
});

test("preview state retains cosmetic selections but drops stale mappings", () => {
  const view = { visibleSeries: ["wau"], zoomRange: { start: "2026-07-01", end: "2026-07-31" } };
  assert.deepEqual(chartEditorPreviewState(original.chart, { ...original.chart, showLegend: false }, view), view);
  for (const patch of [{ type: "bar" }, { x: "day" }, { y: "dau" }, { series: "plan" }, { fields: ["wau", "dau"] }]) {
    assert.deepEqual(chartEditorPreviewState(original.chart, { ...original.chart, ...patch }, view), {
      visibleSeries: undefined,
      zoomRange: undefined,
    });
  }
});
