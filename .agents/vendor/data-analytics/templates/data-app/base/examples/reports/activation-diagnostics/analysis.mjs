import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const fields = ["week_start", "acquisition_channel", "signups", "activated_users", "paid_conversions", "revenue_usd", "support_tickets"];
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const aggregate = (rows) => {
  const counts = Object.fromEntries(fields.slice(2).map((field) => [field, sum(rows, field)]));
  return { ...counts, activationRate: ratio(counts.activated_users, counts.signups) };
};

// This deliberately validates the bundled fixture, not arbitrary CSV dialects or datasets.
export function analyzeProductGrowth(input) {
  const [header, ...lines] = input.trim().split(/\r?\n/u);
  assert.deepEqual(header.split(","), fields, "Unexpected bundled CSV schema");
  const cells = lines.map((line) => line.split(","));
  assert.ok(cells.every((row) => row.length === fields.length), "Unexpected CSV field count");
  const raw = cells.map((row) => Object.fromEntries(row.map((value, index) => [fields[index], index > 1 ? Number(value) : value])));
  const channels = [...new Set(raw.map((row) => row.acquisition_channel))];
  const weeks = [...new Set(raw.map((row) => row.week_start))].sort();
  const checks = {
    rowCount: raw.length, weekCount: weeks.length, channelCount: channels.length,
    missingCells: cells.flat().filter((value) => !value.trim()).length,
    duplicateKeys: raw.length - new Set(raw.map((row) => `${row.week_start}|${row.acquisition_channel}`)).size,
    missingWeekChannels: weeks.flatMap((week) => channels.map((channel) => [week, channel]))
      .filter(([week, channel]) => !raw.some((row) => row.week_start === week && row.acquisition_channel === channel)).length,
    invalidNumericCells: raw.flatMap((row) => fields.slice(2).map((field) => row[field]))
      .filter((value) => !Number.isInteger(value) || value < 0).length,
    funnelViolations: raw.filter((row) => row.paid_conversions > row.activated_users || row.activated_users > row.signups).length,
    nonWeeklyGaps: weeks.slice(1).filter((week, index) => Date.parse(week) - Date.parse(weeks[index]) !== 7 * 86400000).length,
  };
  for (const name of ["missingCells", "duplicateKeys", "missingWeekChannels", "invalidNumericCells", "funnelViolations", "nonWeeklyGaps"]) {
    assert.equal(checks[name], 0, name);
  }
  assert.equal(checks.rowCount, 32, "Bundled fixture row count");
  assert.equal(checks.weekCount, 8, "Bundled fixture week count");
  assert.equal(checks.channelCount, 4, "Bundled fixture channel count");
  const beforeRows = raw.filter((row) => row.week_start < "2026-05-01");
  const afterRows = raw.filter((row) => row.week_start >= "2026-05-01");
  const before = aggregate(beforeRows);
  const after = aggregate(afterRows);
  const forChannel = (rows, channel) => channel === "All channels" ? rows
    : rows.filter((row) => row.acquisition_channel === channel);
  const periodRows = [["April", beforeRows], ["May", afterRows]].flatMap(([period, rows]) =>
    ["All channels", ...channels].map((channel) => ({ period, channel, ...aggregate(forChannel(rows, channel)) })));
  const channelRows = channels.map((channel) => {
    const earlier = aggregate(forChannel(beforeRows, channel));
    const later = aggregate(forChannel(afterRows, channel));
    assert.ok(Number.isFinite(earlier.activationRate) && Number.isFinite(later.activationRate), "Comparable channel denominators");
    const beforeShare = earlier.signups / before.signups;
    const afterShare = later.signups / after.signups;
    return { channel, beforeSignups: earlier.signups, afterSignups: later.signups,
      beforeActivated: earlier.activated_users, afterActivated: later.activated_users,
      beforeRate: earlier.activationRate, afterRate: later.activationRate,
      changePp: 100 * (later.activationRate - earlier.activationRate), beforeShare, afterShare,
      withinPp: 100 * (beforeShare + afterShare) / 2 * (later.activationRate - earlier.activationRate),
      mixPp: 100 * (earlier.activationRate + later.activationRate) / 2 * (afterShare - beforeShare) };
  });
  const withinPp = sum(channelRows, "withinPp");
  const mixPp = sum(channelRows, "mixPp");
  const changePp = 100 * (after.activationRate - before.activationRate);
  const baselineFixedWithinPp = 100 * channelRows.reduce((total, row) =>
    total + row.beforeShare * (row.afterRate - row.beforeRate), 0);
  const laterRateMixPp = 100 * channelRows.reduce((total, row) =>
    total + row.afterRate * (row.afterShare - row.beforeShare), 0);
  assert.ok(Math.abs(withinPp + mixPp - changePp) < 1e-12, "Symmetric bridge reconciliation");
  assert.ok(Math.abs(baselineFixedWithinPp + laterRateMixPp - changePp) < 1e-12, "Alternative bridge reconciliation");
  const weekly = weeks.flatMap((week) => {
    const rows = raw.filter((row) => row.week_start === week);
    return ["Paid Search", "Other channels"].map((channel) => ({ week, channel,
      ...aggregate(rows.filter((row) => (row.acquisition_channel === "Paid Search") === (channel === "Paid Search"))) }));
  });
  const endpoints = ["All channels", ...channels].map((channel) => {
    const rows = forChannel(raw, channel);
    const earlier = aggregate(rows.filter((row) => row.week_start === weeks[0]));
    const later = aggregate(rows.filter((row) => row.week_start === weeks.at(-1)));
    return { channel, beforeRate: earlier.activationRate, afterRate: later.activationRate,
      changePp: 100 * (later.activationRate - earlier.activationRate) };
  });
  return { inputSha256: createHash("sha256").update(input).digest("hex"), raw, checks, weeks, channels,
    before, after, changePp, withinPp, mixPp, baselineFixedWithinPp, laterRateMixPp,
    channelRows, periodRows, weekly, endpoints };
}

export function createReportSnapshot(results, generatedAt = new Date().toISOString()) {
  const files = ["src/content/report/evidence/demo-product-growth.csv", "src/content/report/analysis.mjs"];
  const definition = (label, description, componentIds, formula) => ({ label, definition: description,
    componentIds, ...(formula ? { formula } : {}), sourceLineage: [{ files }] });
  const rate = (ids) => definition("Activation ratio", "Supplied activated users divided by supplied signups in the stated period and channel; not verified user-level cohort conversion.", ids, "SUM(activated_users) / SUM(signups)");
  const source = (label, metricDefinitions, transformation) => ({
    label: `Synthetic fixture: ${label}`, files, tables: [], metricDefinitions,
    evidenceFlow: [
      { title: "Read bundled CSV", detail: `${results.checks.rowCount} synthetic rows; SHA-256 ${results.inputSha256}.` },
      { title: "Reproduce calculation", detail: transformation },
      { title: "Reviewed query rows", detail: `The recorded ${label} rows and component-scoped definitions are available in this source panel.` },
    ],
    filters: ["All 32 supplied rows retained.", "April 6–27 versus May 4–25, 2026."],
    caveats: ["The CSV does not define the activation event, cohort maturity, attribution, sampling process, or experimental assignment."],
  });
  const bridgeIds = ["assessment-result", "assessment-mix", "mix-table", "assessment-sensitivity"];
  return { surface: "report", title: "Paid Search activation: a methods assessment", generatedAt,
    status: "fixture", filters: [], queries: {
      raw_growth: { rows: results.raw, reportingField: "week_start", source: source("original product-growth CSV",
        [rate(["assessment-method", "assessment-limits"])], "Exact CSV rows; numeric fields parsed as numbers. No SQL executed.") },
      quality_checks: { rows: Object.entries(results.checks).map(([check, result]) => ({ check, result })),
        source: source("completeness and arithmetic checks", [definition("Completeness", "Checks the observed week/channel grid, numeric counts, weekly spacing, and paid conversions ≤ activated users ≤ signups. No external completeness check is possible.", ["quality-table", "assessment-method"])], "Run src/content/report/reproduce.mjs; checks use every original CSV row.") },
      period_totals: { rows: results.periodRows, source: source("pooled April and May totals",
        [rate(["assessment-result", "aggregate-table"])], "Split April and May; sum numeric fields by period and channel. Ratios use summed counts, never mean weekly rates.") },
      channel_comparison: { rows: results.channelRows, source: source("channel comparison and exact rate bridge", [
        rate([...bridgeIds, "channel-table"]),
        definition("Signup share", "Channel signups divided by all-channel signups in the same period.", [...bridgeIds, "channel-table"], "channel signups / all-channel signups"),
        definition("Within-channel contribution", "Percentage points allocated to rate changes using mean signup shares.", bridgeIds, "100 * mean(beforeShare, afterShare) * (afterRate - beforeRate)"),
        definition("Mix contribution", "Percentage points allocated to share changes using mean activation ratios; accounting identity, not causal effect.", bridgeIds, "100 * mean(beforeRate, afterRate) * (afterShare - beforeShare)"),
      ], "Compute symmetric within/mix contributions and assert reconciliation within 1e-12 percentage points.") },
      weekly_rates: { rows: results.weekly, reportingField: "week", source: source("weekly Paid Search and other channels",
        [rate(["activation-trend"])], "Sum by week for Paid Search and pooled other channels, then divide activated users by signups.") },
      endpoint_comparison: { rows: results.endpoints, source: source("first-to-last-week sensitivity",
        [rate(["assessment-sensitivity"])], "Compare April 6 with May 25, 2026. No extrapolation.") },
    } };
}
