import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dataAppActionRequest } from "../src/data-app-actions.js";
import { reportDateMetadata } from "../src/report-date.js";

test("reports expose their snapshot date without a refresh action", async () => {
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  assert.match(chrome, /generatedAt && canEdit && surface !== "report" && \(\s*<DataAppRefreshControl/u);
  assert.match(chrome, /surface === "report" && <ReportDateLabel asOf=\{reportAsOf\} generatedAt=\{generatedAt\}/u);
  assert.doesNotMatch(chrome, /Update this report/u);
  assert.throws(() => dataAppActionRequest("refresh", { surface: "report" }), /only for dashboards/u);
  assert.throws(() => dataAppActionRequest("schedule-refresh", { surface: "report" }), /only for dashboards/u);
});

test("report cutoff dates are explicit and preparation dates never imply new evidence", () => {
  const generatedAt = "2026-08-19T17:00:00Z";
  const cutoff = reportDateMetadata({ asOf: "2026-08-18", generatedAt });
  assert.equal(cutoff.label, "As of");
  assert.equal(cutoff.timeZone, "UTC");
  assert.equal(cutoff.value, "2026-08-18");
  for (const asOf of [undefined, "2026-02-30", "2026-08-18T12:00:00Z", "invalid"])
    assert.equal(reportDateMetadata({ asOf, generatedAt }).label, "Prepared");
  assert.equal(reportDateMetadata({ generatedAt: "invalid" }), null);
  assert.equal(reportDateMetadata({}), null);
});

test("dashboard refresh still reruns its existing authorized queries", () => {
  const request = dataAppActionRequest("refresh", { surface: "dashboard", title: "Usage" });
  assert.match(request.prompt, /invoke \$build-dashboard to refresh this dashboard/u);
  assert.match(request.prompt, /Read its saved source requests and calculations/u);
  assert.match(request.prompt, /Preserve its layout/u);
});
