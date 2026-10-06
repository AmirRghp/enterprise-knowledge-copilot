import React from "react";
import { operatingStoryAnnotations, withOperatingStory } from "./annotation-stories.mjs";

import {
  ChartRenderer, DataComponent, DataTable, MetricCard, percentage, periodComparison,
  ReportSection, RichNarrative, SortableItem, SortableRegion, useDataApp,
} from "../../data-app-public.jsx";
import { shortNumber } from "../short-number.mjs";

const trendChart = {
  type: "line",
  x: "week",
  y: "activeUsers",
  fields: ["activeUsers", "targetUsers"],
  xLabel: "Reporting week",
  yLabel: "Active accounts",
};

const segmentChart = {
  type: "horizontalBar",
  x: "segment",
  y: "activeUsers",
  xLabel: "Active accounts",
};

const conversionChart = {
  type: "line",
  x: "week",
  y: "conversion",
  xLabel: "Reporting week",
  yLabel: "Activation rate",
  startAtZero: false,
};

const growthDriverChart = {
  type: "waterfall",
  x: "driver",
  y: "change",
  startAtZero: false,
  xLabel: "Growth driver",
  yLabel: "Active accounts",
};

const retentionChart = {
  type: "horizontalBar",
  x: "segment",
  y: "retention",
  xLabel: "Retention rate",
};

const forecastChart = {
  type: "bar",
  x: "week",
  y: "actualUsers",
  fields: ["actualUsers", "projectedUsers", "targetUsers"],
  xLabel: "Reporting week",
  yLabel: "Active accounts",
};

const accountRiskChart = {
  type: "horizontalBar",
  x: "account",
  y: "riskScore",
  colors: { riskScore: "var(--secondary)" },
  xLabel: "Risk score",
  sortOrder: "descending",
};

const reportSectionOrder = [
  "report-adoption-trend",
  "report-growth-driver-bridge",
  "report-segment-breakdown",
  "report-account-finding",
  "report-recommendations",
  "report-forecast-outlook",
  "report-further-questions",
];

function unsignedPercentage(value) {
  return percentage(value).replace("+", "");
}

const count = shortNumber;
const exactCount = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
const reviewedSum = (rows, field) => rows.every((row) => Number.isFinite(row[field]) && row[field] >= 0)
  ? rows.reduce((total, row) => total + row[field], 0) : undefined;

// This example describes recorded contributions and concentrations, not causal attribution.
export function adoptionEvidence({ latest, previous, segmentRows, growthDriverRows, forecastRows, accountRows }) {
  const movements = growthDriverRows.filter(({ driver }) => !/^(?:before|after|start|end)$/iu.test(String(driver)));
  const changes = movements.filter(({ change }) => Number.isFinite(change));
  const additions = changes.filter(({ change }) => change > 0).reduce((total, row) => total + row.change, 0);
  const losses = -changes.filter(({ change }) => change < 0).reduce((total, row) => total + row.change, 0);
  const before = growthDriverRows.find(({ driver }) => /^(?:before|start)$/iu.test(String(driver)))?.change;
  const after = growthDriverRows.find(({ driver }) => /^(?:after|end)$/iu.test(String(driver)))?.change;
  const net = additions - losses;
  const reconciles = movements.length === changes.length && Number.isFinite(before) && Number.isFinite(after) && before + net === after
    && before === previous?.activeUsers && after === latest?.activeUsers;
  const segmentTotal = reviewedSum(segmentRows, "activeUsers");
  const segmentRisk = reviewedSum(segmentRows, "atRiskUsers");
  const segmentCoverage = segmentRows.length >= 2 && Number.isFinite(latest?.activeUsers)
    && segmentTotal === latest.activeUsers && Number.isFinite(segmentRisk)
    && new Set(segmentRows.map(({ segment }) => segment)).size === segmentRows.length
    && segmentRows.every(({ segment, retention, atRiskUsers, activeUsers }) => typeof segment === "string"
      && segment.length > 0 && segment !== "all" && Number.isFinite(retention) && retention >= 0 && retention <= 1
      && atRiskUsers <= activeUsers);
  const ranked = segmentCoverage ? [...segmentRows].sort((left, right) => left.retention - right.retention) : [];
  const retentionTied = ranked.length > 1 && ranked[0].retention === ranked[1].retention;
  const lowestRetention = !retentionTied ? ranked[0] : undefined;
  const elevated = accountRows.filter(({ riskTier }) => /high|elevated|critical/iu.test(String(riskTier)));
  const elevatedRisk = reviewedSum(elevated, "atRiskUsers");
  const focusAccounts = elevated.filter(({ segment }) => segment === lowestRetention?.segment);
  const focusRisk = reviewedSum(focusAccounts, "atRiskUsers");
  const forecast = forecastRows.at(-1);
  const previousForecast = forecastRows.at(-2);
  return { additions, losses, net, reconciles,
    reconciliationNote: reconciles ? "The account bridge reconciles." : "The account bridge does not reconcile to the selected totals.",
    lossShare: additions > 0 ? losses / additions : undefined,
    segmentTotal, segmentRisk, segmentCoverage, retentionTied, lowestRetention, elevatedRisk, focusAccounts, focusRisk,
    forecastLift: Number.isFinite(forecast?.projectedUsers) && Number.isFinite(forecast?.actualUsers)
      ? forecast.projectedUsers - forecast.actualUsers : undefined,
    realizedForecastError: Number.isFinite(previousForecast?.projectedUsers) && Number.isFinite(forecast?.actualUsers)
      ? forecast.actualUsers - previousForecast.projectedUsers : undefined };
}

function conversionComparison(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return "";
  const change = (current - previous) * 100;
  const direction = change > 0 ? "increased" : change < 0 ? "decreased" : "was unchanged";
  const signed = `${change > 0 ? "+" : ""}${change.toFixed(1)}`;
  return `Activation ${direction} from ${unsignedPercentage(previous)} to ${unsignedPercentage(current)} `
    + `(${signed} percentage points versus the previous period).`;
}

function configuredMetrics(snapshot, latest, previous) {
  if (!latest || snapshot.report?.metrics === false) return [];
  const defaults = [
    { field: "activeUsers", label: "Weekly active accounts",
      description: "Distinct accounts active during the reporting week." },
    { field: "conversion", label: "Activation rate", format: "percentage",
      description: "Activated accounts divided by qualified sign-ups." },
  ];
  const definitions = Array.isArray(snapshot.report?.metrics) ? snapshot.report.metrics : defaults;
  return definitions.filter(({ field }) => Number.isFinite(latest[field])).map((metric) => {
    const ratio = metric.format === "percentage" || /(?:rate|conversion|retention|share)$/iu.test(metric.field);
    return {
      ...metric,
      value: ratio ? unsignedPercentage(latest[metric.field]) : shortNumber(latest[metric.field]),
      ...periodComparison(latest[metric.field], previous?.[metric.field], { percentagePoints: ratio }),
    };
  });
}

export function ReportContent() {
  const {
    snapshot, queries, reviewedPeriodRows, reviewedAggregatePeriodRows,
    chartOverrides, chartProps, visible, canEdit, mode, appTitle, setAppTitle,
  } = useDataApp();
  const history = reviewedAggregatePeriodRows("usage_summary", { period: "history" });
  const latestRows = reviewedAggregatePeriodRows("usage_summary", { period: "latest" });
  const latest = latestRows[0];
  const previousRows = reviewedAggregatePeriodRows("usage_summary", {
    period: "previous", currentPeriod: latest?.week,
  });
  const previous = previousRows[0];
  const technical = /technical|methods|scientific/iu.test(
    String(snapshot.report?.audience ?? snapshot.audience ?? ""),
  );
  const summaryHeading = technical ? "Technical summary" : "Executive summary";
  const conversion = conversionComparison(latest?.conversion, previous?.conversion);
  const firstReviewed = history[0];
  const latestGrowth = Number.isFinite(latest?.activeUsers) && Number.isFinite(previous?.activeUsers)
    ? latest.activeUsers - previous.activeUsers : undefined;
  const targetGap = Number.isFinite(latest?.activeUsers) && Number.isFinite(latest?.targetUsers)
    ? latest.activeUsers - latest.targetUsers : undefined;
  const historicalGrowth = Number.isFinite(latest?.activeUsers) && Number.isFinite(firstReviewed?.activeUsers)
    ? latest.activeUsers - firstReviewed.activeUsers : undefined;
  const metrics = configuredMetrics(snapshot, latest, previous);
  const segments = chartOverrides["report-segment-breakdown"] ?? segmentChart;
  const drivers = chartOverrides["report-growth-driver-bridge"] ?? growthDriverChart;
  const driverDataInputs = { beginning: previous?.activeUsers, ending: latest?.activeUsers };
  const outlook = chartOverrides["report-forecast-outlook"] ?? forecastChart;
  const accountRisk = chartOverrides["report-account-risk"] ?? accountRiskChart;
  const segmentRows = reviewedPeriodRows("segment_usage", {
    period: "latest", currentPeriod: latest?.week, breakdown: [segments.x, segments.series].filter(Boolean),
  });
  const stories = operatingStoryAnnotations(history, segmentRows);
  const authoredTrend = withOperatingStory(trendChart, chartOverrides["report-adoption-trend"], stories.growth, "latest-above-target");
  const trend = history.length < 2 && ["line", "area", "stackedArea"].includes(authoredTrend.type)
    ? { ...authoredTrend, type: "bar" } : authoredTrend;
  const conversions = withOperatingStory(conversionChart, chartOverrides["report-conversion-trend"], stories.activation, "latest-activation");
  const retention = withOperatingStory(retentionChart, chartOverrides["report-segment-retention"], stories.retention, "search-retention-tension");
  const accountRows = reviewedPeriodRows("account_health", {
    period: "latest", currentPeriod: latest?.week,
  });
  const growthDriverRows = queries.growth_drivers ? reviewedPeriodRows("growth_drivers", {
    period: "latest", currentPeriod: latest?.week, breakdown: [drivers.x, drivers.series].filter(Boolean),
  }) : [];
  const forecastRows = queries.forecast_outlook
    ? reviewedAggregatePeriodRows("forecast_outlook", { period: "history" }) : [];
  const latestForecast = forecastRows.at(-1);
  const reviewedDriverChanges = growthDriverRows.filter(({ driver, change }) =>
    !/^(?:before|after|start|end)$/iu.test(String(driver)) && Number.isFinite(change));
  const positiveDrivers = reviewedDriverChanges.filter(({ change }) => change > 0)
    .sort((left, right) => right.change - left.change);
  const negativeDrivers = reviewedDriverChanges.filter(({ change }) => change < 0)
    .sort((left, right) => left.change - right.change);
  const accountDisplayRows = accountRows.map(({ account, segment, activeUsers, riskTier, nextAction }) => ({
    account, segment, activeUsers, riskTier, nextAction,
  }));
  const leadingSegment = [...segmentRows].sort((left, right) =>
    (right.activeUsers ?? 0) - (left.activeUsers ?? 0))[0];
  const rankedRetention = segmentRows.filter(({ retention }) => Number.isFinite(retention))
    .sort((left, right) => left.retention - right.retention);
  const lowestRetentionSegment = rankedRetention[0];
  const highestRetentionSegment = rankedRetention.at(-1);
  const atRisk = accountRows.filter(({ riskTier }) => /high|elevated|critical/iu.test(String(riskTier)))
    .sort((left, right) => (right.riskScore ?? 0) - (left.riskScore ?? 0));
  const evidence = adoptionEvidence({ latest, previous, segmentRows, growthDriverRows, forecastRows, accountRows });
  const prioritySegment = evidence.lowestRetention;
  const targetPosition = Number.isFinite(targetGap) ? targetGap >= 0 ? "ahead of" : "below" : undefined;
  const allSegmentsGrowing = evidence.segmentCoverage && segmentRows.every(({ netChange }) => netChange > 0);
  const firstTargetGap = Number.isFinite(firstReviewed?.activeUsers) && Number.isFinite(firstReviewed?.targetUsers)
    ? firstReviewed.activeUsers - firstReviewed.targetUsers : undefined;
  const riskConcentration = prioritySegment && evidence.segmentRisk > 0 && evidence.segmentTotal > 0
    ? `${prioritySegment.segment} has ${unsignedPercentage(prioritySegment.activeUsers / evidence.segmentTotal)} `
      + `of active accounts but ${unsignedPercentage(prioritySegment.atRiskUsers / evidence.segmentRisk)} `
      + `of recorded at-risk users` : "";
  const summarySources = {
    usage_summary: history,
    ...(leadingSegment && lowestRetentionSegment ? { segment_usage: segmentRows } : {}),
    ...(growthDriverRows.length > 0 ? { growth_drivers: growthDriverRows } : {}),
    ...(atRisk.length > 0 ? { account_health: accountRows } : {}),
    ...(latestForecast && Number.isFinite(latestForecast.projectedUsers)
      ? { forecast_outlook: forecastRows } : {}),
  };
  const summaryMarkdown = [
    latest && targetPosition ? `- **The current result is ${targetPosition} plan.** `
      + `${count(latest.activeUsers)} active accounts are ${count(Math.abs(targetGap))} ${targetGap >= 0 ? "above" : "below"} target`
      + `${Number.isFinite(latestGrowth) ? ` after a ${count(Math.abs(latestGrowth))}-account ${latestGrowth >= 0 ? "gain" : "decline"}` : ""}.`
      : "- **The current position cannot yet be established.** A comparable actual and target are not available.",
    ...(evidence.reconciles ? [`- **The bridge explains the recorded movement.** `
      + `${count(evidence.additions)} additions less ${count(evidence.losses)} losses leave `
      + `${count(evidence.net)} net accounts; losses absorb ${unsignedPercentage(evidence.lossShare)} of additions.`] : []),
    ...(riskConcentration ? [`- **Retention follow-up should start in ${prioritySegment.segment}.** `
      + `${riskConcentration}. Its ${unsignedPercentage(prioritySegment.retention)} retention is the lowest of the reviewed segments.`] : []),
    ...(Number.isFinite(evidence.forecastLift) ? [`- **The outlook is a scenario, not another actual.** `
      + `The next-week projection implies ${count(Math.abs(evidence.forecastLift))} ${evidence.forecastLift >= 0 ? "more" : "fewer"} accounts; `
      + "the next-week target is not supplied."] : []),
    ...(technical ? [`- **Scope of the conclusion.** ${evidence.reconciliationNote} The supplied activation rates `
      + "do not include their numerator or denominator. They cannot establish which funnel change caused the rate movement."] : []),
  ].join("\n");
  const recommendations = atRisk.filter(({ nextAction }) => nextAction).map((account, index) =>
    `${index + 1}. **${account.account}: ${account.nextAction}.** `
      + `${Number.isFinite(account.atRiskUsers) ? `${count(account.atRiskUsers)} recorded at-risk users; ` : ""}`
      + `${Number.isFinite(account.retention) ? `${unsignedPercentage(account.retention)} retention; ` : ""}`
      + `source risk tier: ${account.riskTier}.`).join("\n");
  const subtitle = snapshot.report?.subtitle?.trim();
  const caveats = snapshot.report?.caveats ?? [];
  const furtherQuestions = snapshot.report?.furtherQuestions ?? [];
  const showEvidenceTables = snapshot.report?.showTables === true;
  const trendFinding = historicalGrowth > 0 && Number.isFinite(targetGap) && Number.isFinite(firstTargetGap) && targetGap > firstTargetGap
    ? "Growth has widened the lead over the operating target"
    : "The reviewed periods establish the current position";
  const segmentFinding = prioritySegment
    ? `${prioritySegment.segment} is the retention priority${allSegmentsGrowing ? ", even as every segment grows" : ""}`
    : evidence.retentionTied ? "No single segment has the weakest retention" : "The segment comparison has a coverage gap";
  const accountFinding = atRisk.length ? `The risk flags identify ${atRisk.length} named accounts for follow-up`
    : "No current accounts have elevated source risk tiers";
  const growthFinding = evidence.reconciles
    ? `${count(evidence.additions)} additions leave ${count(evidence.net)} after losses`
    : "The recorded movements need reconciliation";
  const forecastFinding = Number.isFinite(evidence.forecastLift)
    ? `The next-week scenario implies ${count(Math.abs(evidence.forecastLift))} ${evidence.forecastLift >= 0 ? "more" : "fewer"} accounts`
    : "Historical results and the projected outlook remain distinct";

  return <article className="report-content adoption-retention-report" aria-label="Analytical report">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        aria-label={canEdit && mode === "edit" ? "Edit report heading" : undefined}
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(
          event.currentTarget.textContent.trim() || appTitle,
        ) : undefined}
        onKeyDown={canEdit && mode === "edit" ? (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        } : undefined}>{appTitle}</h1>
      {subtitle && subtitle !== appTitle && <RichNarrative id="report-subtitle" value={subtitle}
        className="report-deck" label="Edit report subtitle" />}
    </header>

    {visible("report-executive-summary") && <ReportSection id="report-executive-summary"
      queryId="usage_summary" queryIds={Object.keys(summarySources)} title={summaryHeading}
      sourceRows={history} sourceRowsByQuery={summarySources}
      description="Independently scoped adoption, segment, growth, account-health, and forecast evidence."
      className="report-summary" showHeading={false}>
      <RichNarrative id="report-summary-body" value={`## ${summaryHeading}\n\n${summaryMarkdown}`}
        className="report-summary-lead" label={`Edit ${summaryHeading.toLowerCase()}`} />
      {metrics.length > 0 && <div className="report-facts" aria-label="Key metrics" data-reviewed-value>
        {metrics.map(({ field, label, description, value, comparison, negative }) =>
          <MetricCard key={field} id={`report-metric-${field}`} title={label}
            queryId="usage_summary" sourceRows={[...latestRows, ...previousRows]}
            description={description} value={value} comparison={comparison}
            negative={negative} trendValues={history.map((row) => row[field])} headingLevel={3} />)}
      </div>}
    </ReportSection>}

    <SortableRegion id="report:sections" label="Report sections" variant="stack"
      authoredOrder={reportSectionOrder} className="report-sortable-sections">
    {visible("report-trend-finding") && visible("report-adoption-trend")
      && <SortableItem id="report-adoption-trend" label={trendFinding} kind="chart">
      <ReportSection id="report-trend-finding" queryId="usage_summary" sourceRows={history}
        title={trendFinding} showHeading={false}
        description="Reviewed reporting-period history, including the latest and previous observations."
        className="report-section">
        <RichNarrative id="report-trend-interpretation"
          value={`## ${trendFinding}\n\n${history.length > 1 && Number.isFinite(historicalGrowth)
            ? `Across ${history.length} reviewed weeks, active accounts moved from ${count(firstReviewed.activeUsers)} `
              + `to ${count(latest.activeUsers)}: **${historicalGrowth >= 0 ? "+" : ""}${count(historicalGrowth)} `
              + `(${unsignedPercentage(historicalGrowth / firstReviewed.activeUsers)})**.`
            : "The available history is too short to establish a sustained trend."}`
            + `${Number.isFinite(firstTargetGap) && Number.isFinite(targetGap)
              ? ` The margin to the reporting-week target moved from ${count(firstTargetGap)} to ${count(targetGap)} accounts.` : ""}`
            + `${conversion ? `\n\n${conversion}` : ""}`
            + `${Number.isFinite(latest?.conversion) && Number.isFinite(firstReviewed?.conversion) && history.length > 2
              ? ` Over the full window, the rate moved ${((latest.conversion - firstReviewed.conversion) * 100).toFixed(1)} `
                + `percentage points, from ${unsignedPercentage(firstReviewed.conversion)} to ${unsignedPercentage(latest.conversion)}.` : ""}`
            + " The rate movement is separate from the change in account volume. The source supplies rates, "
            + "not activated-account and qualified-sign-up counts, so it cannot distinguish a numerator change from a denominator change."}
          className="report-analysis" label="Edit reporting-period interpretation" />
        <DataComponent id="report-adoption-trend" title="Weekly active accounts and operating target"
          queryId="usage_summary" kind="chart" chart={trend} sourceRows={history}
          displayRows={history} headingLevel={3}
          description="The exact reviewed weekly rows used in the report's trend and period comparison.">
          <ChartRenderer spec={trend} rows={history}
            height={340} {...chartProps("report-adoption-trend")} />
        </DataComponent>
        {history.length > 1 && visible("report-conversion-trend")
          && <DataComponent id="report-conversion-trend" title="Activation rate by reporting week"
            queryId="usage_summary" kind="chart" chart={conversions} sourceRows={history}
            displayRows={history} headingLevel={3}
            description="Activated accounts divided by qualified sign-ups in each reviewed reporting week.">
            <ChartRenderer spec={conversions} rows={history}
              height={240} {...chartProps("report-conversion-trend")} />
          </DataComponent>}
        {caveats[0] && <RichNarrative id="report-trend-caveat" value={caveats[0]}
          className="report-caveat" label="Edit finding caveat" />}
      </ReportSection>
      </SortableItem>}

    {growthDriverRows.length > 1 && visible("report-growth-driver-finding")
      && visible("report-growth-driver-bridge")
      && <SortableItem id="report-growth-driver-bridge" label={growthFinding} kind="chart">
      <ReportSection id="report-growth-driver-finding" queryId="growth_drivers"
        queryIds={["usage_summary"]} sourceRows={growthDriverRows}
        sourceRowsByQuery={{ growth_drivers: growthDriverRows, usage_summary: [...previousRows, ...latestRows] }}
        title={growthFinding} showHeading={false}
        description="Latest reviewed before/after account totals and reconciled driver movements."
        className="report-section">
        <RichNarrative id="report-growth-driver-interpretation"
          value={`## ${growthFinding}\n\n`
            + `${positiveDrivers.map(({ driver, change }) =>
              `${driver} contributed **${count(change)}**${evidence.additions > 0
                ? ` (${unsignedPercentage(change / evidence.additions)} of gross additions)` : ""}`).join("; ")}. `
            + `${negativeDrivers.map(({ driver, change }) => `${driver} removed ${count(Math.abs(change))} accounts`).join("; ")}.`
            + `${evidence.reconciles ? ` Together the signed movements reconcile exactly: `
              + `**${exactCount(previous.activeUsers)} + ${exactCount(evidence.additions)} − ${exactCount(evidence.losses)} = ${exactCount(latest.activeUsers)}**.`
              : " The recorded movements do not reconcile to the selected before/after totals; resolve that gap before attributing the net change."}`
            + `${evidence.additions > 0 ? `\n\n${unsignedPercentage(evidence.lossShare)} of gross additions were lost before reaching the net result. `
              + "Retention therefore matters to the net result. This is an account reconciliation, "
              + "not an estimate of any intervention's effect." : ""}`}
          className="report-analysis" label="Edit growth-driver interpretation" />
        <DataComponent id="report-growth-driver-bridge" title="Activation, expansion, and churn bridge"
          queryId="growth_drivers" kind="chart" chart={drivers} dataInputs={driverDataInputs} sourceRows={growthDriverRows}
          displayRows={growthDriverRows} headingLevel={3}
          description="Reviewed before and after totals reconcile through signed activation, expansion, and churn movements.">
          <ChartRenderer spec={drivers} dataInputs={driverDataInputs}
          rows={growthDriverRows} height={275} {...chartProps("report-growth-driver-bridge")} />
        </DataComponent>
      </ReportSection>
      </SortableItem>}

    {visible("report-segment-finding") && visible("report-segment-breakdown")
      && segmentRows.length > 0
      && <SortableItem id="report-segment-breakdown" label={segmentFinding} kind="chart">
      <ReportSection id="report-segment-finding"
        queryId="segment_usage" sourceRows={segmentRows}
        title={segmentFinding} showHeading={false}
        description="Latest reviewed segment observations only."
        className="report-section">
        <RichNarrative id="report-segment-interpretation"
          value={`## ${segmentFinding}\n\n${!evidence.segmentCoverage
            ? "The supplied segment rows do not provide complete, valid retention and risk measures that reconcile to the current active-account total. Resolve that coverage gap before ranking segments or reporting risk shares."
            : evidence.retentionTied
              ? "Several segments share the lowest reviewed retention. Compare their account-level risk and recorded follow-ups before choosing a priority."
              : `${allSegmentsGrowing ? `All ${segmentRows.length} segments contributed to the latest increase: `
                  + segmentRows.map(({ segment, netChange }) => `${segment} +${count(netChange)}`).join(", ") + ". " : ""}`
                + `${prioritySegment.segment}'s **${unsignedPercentage(prioritySegment.retention)} retention** `
                + `is ${((highestRetentionSegment.retention - prioritySegment.retention) * 100).toFixed(1)} percentage points below `
                + `${highestRetentionSegment.segment}. ${riskConcentration}. `
                + `Current growth does not remove that exposure. The account evidence below identifies the existing follow-ups.`}`}
          className="report-analysis" label="Edit segment interpretation" />
        <div className="report-visual-pair" aria-label="Segment activity and retention">
        <DataComponent id="report-segment-breakdown" title="Active accounts by segment"
          queryId="segment_usage" kind="chart" chart={segments} sourceRows={segmentRows}
          displayRows={segmentRows} headingLevel={3}
          description="Latest reviewed active-account counts grouped by segment.">
          <ChartRenderer spec={segments} rows={segmentRows}
            height={280} {...chartProps("report-segment-breakdown")} />
        </DataComponent>
        {rankedRetention.length > 1 && visible("report-segment-retention")
          && <DataComponent id="report-segment-retention" title="Retention by product segment"
            queryId="segment_usage" kind="chart" chart={retention} sourceRows={segmentRows}
            displayRows={rankedRetention} headingLevel={3}
            description="Latest reviewed retention rates, ranked across the same source-backed product segments.">
            <ChartRenderer spec={retention} rows={rankedRetention}
              height={280} {...chartProps("report-segment-retention")} />
          </DataComponent>}
        </div>
      </ReportSection>
      </SortableItem>}

    {visible("report-account-finding") && accountRows.length > 0
      && <SortableItem id="report-account-finding" label={accountFinding} kind="custom">
      <ReportSection id="report-account-finding"
        queryId="account_health" queryIds={["segment_usage"]} sourceRows={accountRows}
        sourceRowsByQuery={{ account_health: accountRows, segment_usage: segmentRows }}
        title={accountFinding} showHeading={false}
        description="Latest reviewed account-level observations."
        className="report-section">
        <RichNarrative id="report-account-interpretation"
          value={`## ${accountFinding}\n\n${atRisk.length
            ? `${atRisk.length} of ${accountRows.length} named accounts have elevated source risk tiers`
              + `${Number.isFinite(evidence.elevatedRisk) ? `, covering **${count(evidence.elevatedRisk)} recorded at-risk users**` : ""}. `
              + `${evidence.focusAccounts.length > 0 && evidence.elevatedRisk > 0 && Number.isFinite(evidence.focusRisk)
                ? `${evidence.focusAccounts.map(({ account }) => account).join(" and ")} account for `
                  + `${count(evidence.focusRisk)} of those users (${unsignedPercentage(evidence.focusRisk / evidence.elevatedRisk)}). `
                : ""}`
              + "This narrows the first follow-up to named accounts instead of treating the whole customer base as equally at risk. "
              + "Use the source's recorded actions below; the score ranks concern but does not estimate the probability of churn."
            : `${accountRows.length} current accounts have no elevated, high, or critical source risk tiers.`}`}
          className="report-analysis" label="Edit account-level interpretation" />
        {accountRows.some(({ riskScore }) => Number.isFinite(riskScore)) && visible("report-account-risk")
          && <DataComponent id="report-account-risk" title="Risk score by account"
            queryId="account_health" kind="chart" chart={accountRisk} sourceRows={accountRows}
            displayRows={accountRows} headingLevel={3}
            description="Latest reviewed account risk scores on a zero-to-100 scale; higher scores indicate greater concern.">
            <ChartRenderer spec={accountRisk} rows={accountRows}
              height={Math.max(270, accountRows.length * 42)} {...chartProps("report-account-risk")} />
          </DataComponent>}
        {showEvidenceTables && visible("report-account-evidence")
          && <DataComponent id="report-account-evidence" title="Reviewed account-level evidence"
          queryId="account_health" kind="table" sourceRows={accountRows} displayRows={accountDisplayRows}
          headingLevel={3}
          description="The exact latest-period reviewed account rows behind this finding.">
          <DataTable rows={accountDisplayRows} caption="Reviewed account-level evidence" />
        </DataComponent>}
      </ReportSection>
      </SortableItem>}

    {recommendations && visible("report-recommendations")
      && <SortableItem id="report-recommendations" label="Recorded account follow-ups" kind="custom">
      <ReportSection id="report-recommendations"
      queryId="account_health" title="Recorded account follow-ups" sourceRows={accountRows}
      description="Existing next actions from the reviewed account-health source, ordered by its risk score."
      className="report-recommendations" showHeading={false}>
      <RichNarrative id="report-recommendations-body" value={`## Recorded account follow-ups\n\n${recommendations}`}
        label="Edit report recommendations" />
    </ReportSection>
    </SortableItem>}

    {forecastRows.length > 0 && visible("report-forecast-finding") && visible("report-forecast-outlook")
      && <SortableItem id="report-forecast-outlook" label={forecastFinding} kind="chart">
      <ReportSection id="report-forecast-finding" queryId="forecast_outlook" sourceRows={forecastRows}
        title={forecastFinding} showHeading={false}
        description="Reviewed forecast snapshots containing separately labeled actual, modeled, and target values."
        className="report-section">
        <RichNarrative id="report-forecast-interpretation"
          value={`## ${forecastFinding}\n\n`
            + `The latest **actual result** is ${count(latestForecast.actualUsers)}; the **next-week modeled projection** is `
            + `${count(latestForecast.projectedUsers)}.`
            + `${Number.isFinite(evidence.forecastLift) && latestForecast.actualUsers > 0
              ? ` That implies ${unsignedPercentage(evidence.forecastLift / latestForecast.actualUsers)} growth from the latest actual.` : ""}`
            + ` The ${count(latestForecast.targetUsers)} target belongs to the current reporting week, `
            + "so the apparent projected surplus is not a verified next-week plan comparison."
            + `${Number.isFinite(evidence.realizedForecastError)
              ? `\n\nThe preceding snapshot projected ${count(forecastRows.at(-2).projectedUsers)}; `
                + `the next observed result was ${count(latestForecast.actualUsers)}. `
                + "One realized comparison is not enough to establish forecast accuracy or calibration." : ""}`
            + `${technical && Number.isFinite(latestForecast.confidence)
              ? ` The fixture records a ${unsignedPercentage(latestForecast.confidence)} confidence value but supplies no interval or calibration method.` : ""}`
            + " Treat this as a modeled scenario, not an observed future outcome."}
          className="report-analysis" label="Edit forecast interpretation" />
        <DataComponent id="report-forecast-outlook" title="Actual accounts, modeled outlook, and target"
          queryId="forecast_outlook" kind="chart" chart={outlook} sourceRows={forecastRows}
          displayRows={forecastRows} headingLevel={3}
          description="Observed reviewed active accounts, modeled projections, and operating targets remain separately labeled.">
          <ChartRenderer spec={outlook} rows={forecastRows}
            height={285} {...chartProps("report-forecast-outlook")} />
        </DataComponent>
      </ReportSection>
      </SortableItem>}

    {furtherQuestions.length > 0 && visible("report-further-questions")
      && <SortableItem id="report-further-questions" label="Further questions" kind="custom">
      <ReportSection id="report-further-questions" queryId="usage_summary"
        title="Further questions" sourceRows={latestRows} showHeading={false}
        description="Open questions grounded in the latest reviewed evidence.">
        <RichNarrative id="report-further-questions-body"
          value={`## Further questions\n\n${furtherQuestions.map((question) => `- ${question}`).join("\n")}`}
          label="Edit further questions" />
      </ReportSection>
      </SortableItem>}
    </SortableRegion>
  </article>;
}
