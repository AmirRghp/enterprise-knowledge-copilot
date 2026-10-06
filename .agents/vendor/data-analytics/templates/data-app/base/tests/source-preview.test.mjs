import assert from "node:assert/strict";
import test from "node:test";
import { sourcePreviewForHref, sourcePreviewLineIndex, sourcePreviewPosition, sourcePreviewProvider } from "../src/source-preview.js";

const href = "https://example.com/readout";
const entry = { title: "Readout", summary: "The source records the result, not a rollout decision.",
  source: "Experiment review", date: "August 2026", approvedForReport: true };
test("source provider icons follow validated destinations, never authored labels or lookalike hosts", () => {
  const cases = [
    ["https://docs.google.com/document/d/example/edit", "google-docs", "Google Docs"],
    ["https://docs.google.com/spreadsheets/d/example/edit", "google-sheets", "Google Sheets"],
    ["https://docs.google.com/presentation/d/example/edit", "google-slides", "Google Slides"],
    ["https://drive.google.com/file/d/example/view", "google-drive", "Google Drive"],
    ["https://workspace.slack.com/archives/example", "slack", "Slack"],
    ["https://www.notion.so/example", "notion", "Notion"],
    ["https://workspace.notion.site/example", "notion", "Notion"],
    ["https://github.com/example/project", "github", "GitHub"],
    ["https://console.statsig.com/example", "database", "Statsig"],
    ["https://warehouse.example.test/query", "web", "Source"],
    ["https://app.snowflake.com/example", "database", "Snowflake"],
    ["https://console.cloud.google.com/bigquery", "database", "BigQuery"],
  ];
  for (const [url, id, label] of cases) assert.deepEqual(sourcePreviewProvider(url), { id, label });
  for (const url of [undefined, "javascript:alert(1)", "http://slack.com/x", "https://slack.com.evil.example/x",
    "https://not-slack.com/x", "https://docs.google.com.evil.example/document/x", "https://example.com/Google-Docs",
    "https://user:secret@github.com/x", "https://github.com/x?token=secret"])
    assert.deepEqual(sourcePreviewProvider(url), { id: "web", label: "Source" });
});
test("source previews require exact links and explicitly audience-approved content", () => {
  assert.deepEqual(sourcePreviewForHref({ [href]: entry }, href), { href, title: entry.title,
    summary: entry.summary, source: entry.source, date: entry.date });
  assert.equal(sourcePreviewForHref({ [href]: entry }, `${href}?other=1`), null);
  assert.equal(sourcePreviewForHref(Object.create({ [href]: entry }), href), null);
  for (const changed of [{ approvedForReport: false }, { approvedForReport: undefined }, { title: "" },
    { summary: "" }, { summary: "x".repeat(901) }])
    assert.equal(sourcePreviewForHref({ [href]: { ...entry, ...changed } }, href), null);
  for (const unsafe of ["javascript:alert(1)", "file:///private/tmp/source", "https://user:secret@example.com", "/relative",
    "http://example.com/source", `${href}?token=secret`, `${href}#secret`, "https://example.com/access-token/secret"])
    assert.equal(sourcePreviewForHref({ [unsafe]: entry }, unsafe), null);
});
test("source tooltips prefer above, fall below near the top, and stay in the viewport", () => {
  assert.deepEqual(sourcePreviewPosition({ left: 330, width: 40, top: 600, bottom: 620 },
    { width: 366, height: 220 }, { width: 390, height: 844 }), { left: 12, top: 372, maxHeight: 580 });
  assert.deepEqual(sourcePreviewPosition({ left: 400, width: 100, top: 100, bottom: 120 },
    { width: 360, height: 200 }, { width: 1000, height: 800 }), { left: 270, top: 128, maxHeight: 660 });
  assert.deepEqual(sourcePreviewPosition({ left: 400, width: 100, top: 400, bottom: 420 },
    { width: 360, height: 200 }, { width: 1000, height: 800 }), { left: 270, top: 192, maxHeight: 380 });
  assert.deepEqual(sourcePreviewPosition({ left: 20, width: 100, top: 1200, bottom: 1220 },
    { width: 360, height: 220 }, { width: 1000, height: 600 }), { left: 12, top: 368, maxHeight: 568 });
  assert.deepEqual(sourcePreviewPosition({ left: 350, width: 30, top: 240, bottom: 260 },
    { width: 360, height: 576 }, { width: 390, height: 600 }), { left: 18, top: 268, maxHeight: 320 });
});

test("wrapped source links anchor to the pointed line and default to the first for keyboard", () => {
  const rects = [{ left: 300, right: 500, top: 100, bottom: 120 },
    { left: 100, right: 220, top: 124, bottom: 144 }];
  assert.equal(sourcePreviewLineIndex(rects), 0);
  assert.equal(sourcePreviewLineIndex(rects, { x: 350, y: 110 }), 0);
  assert.equal(sourcePreviewLineIndex(rects, { x: 160, y: 134 }), 1);
  assert.equal(sourcePreviewLineIndex(rects, { x: 230, y: 135 }), 1);
  assert.equal(sourcePreviewLineIndex([], { x: 0, y: 0 }), 0);
});
