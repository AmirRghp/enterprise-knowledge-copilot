import assert from "node:assert/strict";
import { test } from "node:test";
import { dataAppBuildState, buildBlocksAction } from "../src/build-state.js";

test("authoring status replaces freshness only while unfinished", () => {
  assert.equal(dataAppBuildState({buildStatus:"creating"}).label, "Creating dashboard…");
  assert.equal(dataAppBuildState({buildStatus:"in-progress"}).label, "Updating dashboard…");
  assert.equal(dataAppBuildState({buildStatus:"paused"}).label, "Dashboard update paused");
  assert.equal(dataAppBuildState({buildStatus:"complete"}).label, null);
  assert.equal(dataAppBuildState({}).label, null);
});
test("active work blocks conflicting actions while exploration remains available", () => {
  for (const buildStatus of ["creating", "updating", "in-progress"]) {
    const snapshot = {buildStatus};
    for (const action of ["sites", "publish", "refresh", "schedule-refresh", "edit-in-chatgpt", "report-correct"])
      assert.equal(buildBlocksAction(snapshot, action), true, action);
    for (const action of ["copy", "copy-data", "sources", "ask", "report-investigate"])
      assert.equal(buildBlocksAction(snapshot, action), false, action);
  }
});
test("paused work permits resumed editing but cannot publish unfinished content", () => {
  assert.equal(dataAppBuildState({buildStatus:"paused"}).active, false);
  assert.equal(buildBlocksAction({buildStatus:"paused"}, "sites"), true);
  assert.equal(buildBlocksAction({buildStatus:"paused"}, "edit-in-chatgpt"), false);
  assert.equal(buildBlocksAction({buildStatus:"complete"}, "sites"), false);
});

test("new status is the sole source of truth even with a stale operation field", () => {
  assert.equal(dataAppBuildState({buildStatus:"updating", buildOperation:"create"}).label, "Updating dashboard…");
  assert.equal(dataAppBuildState({buildStatus:"creating", surface:"report"}).label, "Creating report…");
  assert.equal(dataAppBuildState({buildStatus:"complete", buildOperation:"create"}).active, false);
});
