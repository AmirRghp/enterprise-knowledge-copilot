import React from "react";
import { ChartRenderer, DataComponent, DataTable, ReportSection, RichNarrative, useDataApp } from "../../data-app-public.jsx";
import { shortNumber } from "../short-number.mjs";

const number = shortNumber;
const exactNumber = (value) => Number(value).toLocaleString("en-US");
const percent = (value) => `${(value * 100).toFixed(1)}%`;
const points = (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)} pp`;
const columns = (definitions) => definitions.map(([field, label]) => ({ field, label }));
const qualityLabels = { rowCount: "Supplied rows", weekCount: "Observed weeks", channelCount: "Observed channels",
  missingCells: "Blank cells", duplicateKeys: "Repeated week/channel keys", missingWeekChannels: "Missing observed-grid pairs",
  invalidNumericCells: "Invalid numeric values", funnelViolations: "Funnel-order violations", nonWeeklyGaps: "Irregular weekly gaps" };
const trendSpec = { type: "line", x: "week", y: "activationRate", series: "channel",
  yLabel: "Activation ratio", showXAxisLabel: false, startAtZero: true };

function Prose({ id, title, queryId, queryIds, value }) {
  const { visible } = useDataApp();
  if (!visible(id)) return null;
  return <ReportSection id={id} title={title} queryId={queryId} queryIds={queryIds} showHeading={false}>
    <RichNarrative id={`${id}:body`} value={`## ${title}\n\n${value}`} label={`Edit ${title}`} />
  </ReportSection>;
}

function Evidence({ id, title, queryId, sourceRows, rows, fields }) {
  const { visible } = useDataApp();
  if (!visible(id)) return null;
  return <DataComponent id={id} title={title} queryId={queryId} kind="table" displayRows={rows} sourceRows={sourceRows}>
    <DataTable rows={rows} columns={columns(fields)} searchable={false} compactNumbers={false} label={title} />
  </DataComponent>;
}

export function ReportContent() {
  const { reviewedRows, visible, chartOverrides, chartProps, appTitle, setAppTitle, canEdit, mode } = useDataApp();
  const periods = reviewedRows("period_totals");
  const channels = reviewedRows("channel_comparison");
  const quality = reviewedRows("quality_checks");
  const weekly = reviewedRows("weekly_rates");
  const get = (period, channel = "All channels") => periods.find((row) => row.period === period && row.channel === channel);
  const before = get("April");
  const after = get("May");
  const paid = channels.find((row) => row.channel === "Paid Search");
  const within = channels.reduce((total, row) => total + row.withinPp, 0);
  const mix = channels.reduce((total, row) => total + row.mixPp, 0);
  const fixedWithin = 100 * channels.reduce((total, row) => total + row.beforeShare * (row.afterRate - row.beforeRate), 0);
  const laterMix = 100 * channels.reduce((total, row) => total + row.afterRate * (row.afterShare - row.beforeShare), 0);
  const endpoint = reviewedRows("endpoint_comparison").find((row) => row.channel === "Paid Search");
  const chart = chartOverrides["activation-trend"] ?? trendSpec;

  return <article className="report-content activation-diagnostics-report" aria-label="Paid Search methods assessment">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}>{appTitle}</h1>
      <RichNarrative id="assessment:deck" className="report-deck"
        value="Synthetic demonstration data, April 6–May 25, 2026. Measurement quality, aggregate change, and channel composition." />
    </header>

    <Prose id="assessment-result" title="The decline is concentrated within Paid Search"
      queryId="period_totals" queryIds={["channel_comparison"]}
      value={`Paid Search's pooled activation ratio fell from **${percent(paid.beforeRate)} to ${percent(paid.afterRate)}** between the four April and four May weeks (${points(paid.changePp)}). Signups grew from ${number(paid.beforeSignups)} to ${number(paid.afterSignups)}, while activations moved from ${number(paid.beforeActivated)} to ${number(paid.afterActivated)}.\n\nAcross all channels, the ratio changed by ${points(100 * (after.activationRate - before.activationRate))}. An exact accounting decomposition assigns ${points(within)} to within-channel changes and ${points(mix)} to net channel mix. The next investigation should focus within Paid Search; campaign mix, measurement changes, and cohort behavior remain untested.`} />

    <Prose id="assessment-method" title="Measurement and completeness" queryId="raw_growth" queryIds={["quality_checks"]}
      value="The supplied unit is a **week-start × acquisition-channel aggregate**. Pool April 6–27 against May 4–25: four weeks per channel in each period. Activation ratio is the sum of activated_users divided by the sum of signups, so high-volume weeks receive their proper denominator weight. No rows are excluded or filled.\n\nThe observed grid has 8 weeks × 4 channels. These checks establish internal consistency of the supplied file—not completeness of a production event stream, distinct-user counts, channel exclusivity, or equal cohort follow-up time. The activation event and its time window are not defined." />
    <Evidence id="quality-table" title="File-level checks" queryId="quality_checks" sourceRows={quality}
      rows={quality.map(({ check, result }) => ({ check: qualityLabels[check] ?? check, result }))}
      fields={[["check", "Check"], ["result", "Observed result"]]} />
    <Evidence id="aggregate-table" title="All-channel pooled totals" queryId="period_totals"
      sourceRows={periods.filter((row) => row.channel === "All channels")}
      rows={[before, after].map((row) => ({ period: row.period, signups: row.signups,
        activated: row.activated_users, rate: percent(row.activationRate) }))}
      fields={[["period", "Period"], ["signups", "Signups"], ["activated", "Activated users"], ["rate", "Activation ratio"]]} />

    {visible("activation-trend") && <DataComponent id="activation-trend" title="Weekly activation ratio"
      queryId="weekly_rates" kind="chart" chart={chart} sourceRows={weekly}>
      <ChartRenderer spec={chart} rows={weekly} height={320} {...chartProps("activation-trend")} />
    </DataComponent>}
    <Evidence id="channel-table" title="Pooled activation by channel" queryId="channel_comparison" sourceRows={channels}
      rows={channels.map((row) => ({ channel: row.channel,
        april: `${exactNumber(row.beforeActivated)} / ${exactNumber(row.beforeSignups)}`,
        may: `${exactNumber(row.afterActivated)} / ${exactNumber(row.afterSignups)}`,
        aprilRate: percent(row.beforeRate), mayRate: percent(row.afterRate), change: points(row.changePp) }))}
      fields={[["channel", "Channel"], ["april", "April A / S"], ["may", "May A / S"],
        ["aprilRate", "April rate"], ["mayRate", "May rate"], ["change", "Change"]]} />

    <Prose id="assessment-mix" title="An exact rate-versus-mix bridge" queryId="channel_comparison"
      value={`Write the aggregate ratio as R = Σ wᶜrᶜ, where w is a channel's signup share and r its activation ratio. The symmetric bridge uses **within = 100 × mean(w₀,w₁) × (r₁−r₀)** and **mix = 100 × mean(r₀,r₁) × (w₁−w₀)**, in percentage points. The terms reconcile exactly before rounding.\n\nPaid Search contributes ${points(paid.withinPp)} through its rate decline; the other channels offset ${points(within - paid.withinPp)}. Its signup share rises from ${percent(paid.beforeShare)} to ${percent(paid.afterShare)}, but net mix across all four channels contributes ${points(mix)}. Individual mix terms depend on the decomposition convention; they are not causal effects.`} />
    <Evidence id="mix-table" title="Decomposition of the aggregate change" queryId="channel_comparison" sourceRows={channels}
      rows={[...channels.map((row) => ({ channel: row.channel, aprilShare: percent(row.beforeShare),
        mayShare: percent(row.afterShare), within: points(row.withinPp), mix: points(row.mixPp) })),
      { channel: "Total", aprilShare: "100.0%", mayShare: "100.0%", within: points(within), mix: points(mix) }]}
      fields={[["channel", "Channel"], ["aprilShare", "April share"], ["mayShare", "May share"],
        ["within", "Within, pp"], ["mix", "Mix, pp"]]} />

    <Prose id="assessment-sensitivity" title="Sensitivity to the comparison and decomposition"
      queryId="endpoint_comparison" queryIds={["channel_comparison"]}
      value={`April 6 versus May 25 yields ${percent(endpoint.beforeRate)} → ${percent(endpoint.afterRate)} for Paid Search (${points(endpoint.changePp)}). The endpoint decline is larger than the pooled decline, but the direction agrees. Holding April signup shares fixed gives a within term of ${points(fixedWithin)}; valuing the mix change at May rates supplies ${points(laterMix)}. The allocation changes with convention, while within-channel performance still dominates.`} />
    <Prose id="assessment-limits" title="What remains unresolved" queryId="raw_growth"
      value="This synthetic file has no acquisition cost, campaign or keyword detail, user IDs, event definitions, attribution rules, cohort maturity, product-change history, or randomized assignment. It cannot establish cohort conversion, acquisition efficiency, causality, or a forecast. No confidence interval is reported because the generating and sampling process is unspecified.\n\nA real investigation would first reproduce the ratios from governed signup cohorts with a defined activation event and common observation window, then inspect campaign mix, attribution, and instrumentation.\n\n**Reproduce:** run `node src/content/report/reproduce.mjs` from the generated artifact. The exact CSV, calculation code, and machine-readable results remain under `src/content/report/`. Each evidence block also exposes its reviewed rows and definitions." />
  </article>;
}
