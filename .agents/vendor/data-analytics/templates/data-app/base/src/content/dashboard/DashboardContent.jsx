import React, { useEffect, useState } from "react";

import {
  ChartRenderer, compact, DataComponent, DataTable, EvidenceChart, Filters, MetricCard,
  percentage, periodComparison, previousPeriodRows, RichNarrative, SectionHeader, Slider, SortableItem, SortableRegion, useDataApp, useSectionFilters,
} from "../../data-app-public.jsx";
import { aggregateSessions, chronologicalRows, progressPercent, regionalTotals } from "./dashboard-data.js";
import { regionalWorldMapPath } from "./regional-world-map.js";

const adoptionTrend = {
  type: "line",
  x: "week",
  y: "activeUsers",
  fields: ["activeUsers", "targetUsers"],
  showXAxisLabel: false,
  yLabel: "Active accounts",
};

const segmentBreakdown = {
  type: "rankedList",
  x: "feature",
  y: "activeUsers",
  sortOrder: "descending",
  initialVisibleCount: 5,
};

const growthDriverBreakdown = {
  type: "waterfall",
  x: "driver",
  y: "change",
  xLabel: "Growth driver",
  showXAxisLabel: false,
  yLabel: "Net active accounts",
};

const adoptionScenario = {
  type: "line",
  x: "week",
  y: "projectedUsers",
  fields: ["activeUsers", "baselineUsers", "projectedUsers"],
  colors: {
    activeUsers: "var(--chart-1)", baselineUsers: "var(--chart-8)",
    projectedUsers: "var(--chart-2)",
  },
  stackable: false,
  showXAxisLabel: false,
  yLabel: "Active accounts",
};

const segmentComposition = {
  type: "stackedArea",
  x: "week",
  y: "activeUsers",
  series: "segment",
  showXAxisLabel: false,
  yLabel: "Active accounts",
  colors: { Studio: "var(--chart-1)", Search: "var(--chart-2)", API: "var(--chart-3)" },
};

const channelComposition = {
  type: "stackedBar100",
  x: "week",
  y: "activatedUsers",
  series: "channel",
  showXAxisLabel: false,
  yLabel: "Share of activations",
  colors: {
    Organic: "var(--chart-1)",
    Referrals: "color-mix(in srgb, var(--chart-2) 76%, var(--surface))",
    Partnerships: "color-mix(in srgb, var(--chart-3) 70%, var(--surface))",
    Paid: "color-mix(in srgb, var(--chart-4) 64%, var(--surface))",
    Community: "color-mix(in srgb, var(--chart-5) 58%, var(--surface))",
  },
};

const activationFunnel = { type: "funnel", x: "stage", y: "accounts" };
const activationStages = [
  ["signedUp", "Signed up"], ["workspaceCreated", "Created workspace"],
  ["firstAction", "First key action"], ["activated", "Activated"],
];

const engagementHeatmap = {
  type: "heatmap",
  x: "hour",
  y: "sessions",
  series: "day",
  showXAxisLabel: false,
  showYAxisLabel: false,
  rowHeight: 22,
};

const accountEngagement = {
  type: "scatter",
  x: "engagementScore",
  y: "activeUsers",
  series: "segment",
  xLabel: "Engagement score",
  yLabel: "Active accounts",
  colors: { Studio: "var(--chart-1)", Search: "var(--chart-2)", API: "var(--chart-3)" },
};

const engagementFilters = [
  { id: "segment", label: "Product", field: "segment", defaultValue: "all",
    queryIds: ["engagement_intensity", "engagement_profiles"] },
];

const accountHealthFilters = [
  { id: "segment", label: "Product", field: "segment", defaultValue: "all", queryIds: ["account_health"] },
  { id: "riskTier", label: "Risk", field: "riskTier", defaultValue: "all", queryIds: ["account_health"] },
];

const scenarioLevers = [
  { field: "activationLift", label: "Activation lift", min: -20, max: 30 },
  { field: "retentionLift", label: "Retention lift", min: -10, max: 20 },
];

const accountEvidenceColumns = [
  { field: "account", label: "Account", presentation: "identity", secondaryField: "region" },
  { field: "segment", label: "Product" },
  { field: "activeUsers", label: "Active users" },
  { field: "usageTrend", label: "Usage trend", presentation: "sparkline" },
  { field: "engagementScore", label: "Engagement", presentation: "bar", max: 100 },
  { field: "retention", label: "Retention", presentation: "percent" },
  { field: "netChange", label: "Net change" },
  { field: "riskTier", label: "Risk", presentation: "status" },
  { field: "nextAction", label: "Next action" },
];

const regionalMapLocations = {
  "North America": { x: 142, y: 78, color: "var(--chart-1)" },
  EMEA: { x: 303, y: 79, color: "var(--chart-2)" },
  APAC: { x: 438, y: 120, color: "var(--chart-3)" },
};

function ScenarioLever({ label, value, min, max, onCommit }) {
  const [liveValue, setLiveValue] = useState(value);

  useEffect(() => setLiveValue(value), [value]);

  function updateValue(value) {
    const nextValue = Math.round(Number(value));
    setLiveValue(nextValue);
    onCommit(nextValue);
  }

  return <Slider className="scenario-lever" label={label} labelPlacement="inline"
    min={min} max={max} step={1} value={liveValue} onChange={updateValue}
    formatValue={(nextValue) => percentage(Math.round(nextValue) / 100)} />;
}

export function DashboardContent() {
  const {
    snapshot, queries, filters, setFilter, reviewedRows, chartOverrides,
    assumptions, setAssumptions, visible, chartProps,
  } = useDataApp();
  const engagementScope = useSectionFilters(engagementFilters, {}, {
    rowId: "dashboard:engagement", componentIds: ["engagement-heatmap", "engagement-scatter"], label: "Engagement filters",
  });
  const accountScope = useSectionFilters(accountHealthFilters, {}, {
    rowId: "dashboard:evidence", componentIds: ["usage-details"], label: "Account health filters",
  });
  const summary = reviewedRows("usage_summary").reduce((latest, row) =>
    !latest || row.week > latest.week ? row : latest, undefined);
  const latestRows = (queryId, breakdown = []) => reviewedRows(queryId, breakdown)
    .filter((row) => row.week === summary?.week);
  const previousRows = (queryId) => previousPeriodRows(
    queries[queryId]?.rows ?? [], snapshot.filters ?? [], filters, queryId, "week", summary?.week,
  );
  const previousSummary = previousRows("usage_summary").at(-1);
  const forecast = latestRows("forecast_outlook").at(-1);
  const previousForecast = previousRows("forecast_outlook").at(-1);
  const accountScopeProps = accountScope.componentProps("account_health");
  const scopedAccountRows = accountScopeProps.sourceRows.filter((row) => row.week === summary?.week);
  const accountRows = latestRows("account_health");
  const accountHistory = reviewedRows("account_health", ["week", "account"]);
  const accountEvidenceRows = scopedAccountRows.map(({ week, segment, region, account, activeUsers, previousUsers, ...details }) => ({
    week, segment, region, account, activeUsers, previousUsers,
    netChange: activeUsers - previousUsers,
    usageTrend: accountHistory.filter((row) => row.account === account)
      .sort((left, right) => left.week.localeCompare(right.week))
      .flatMap((row, index) => index === 0 ? [row.previousUsers, row.activeUsers] : [row.activeUsers])
      .filter(Number.isFinite),
    ...details,
  }));
  const regionalActivity = regionalTotals(accountRows, regionalMapLocations);
  const mappedRegions = regionalActivity.filter(({ x, y }) => Number.isFinite(x) && Number.isFinite(y));
  const unmappedRegions = regionalActivity.filter(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y));
  const maximumRegionalUsers = Math.max(1, ...regionalActivity.map(({ activeUsers }) => activeUsers));
  const trend = chartOverrides["usage-trend"] ?? adoptionTrend;
  const breakdown = chartOverrides["segment-breakdown"] ?? segmentBreakdown;
  const drivers = chartOverrides["growth-drivers"] ?? growthDriverBreakdown;
  const driverDataInputs = { beginning: previousSummary?.activeUsers, ending: summary?.activeUsers };
  const scenario = chartOverrides["adoption-scenario"] ?? adoptionScenario;
  const composition = chartOverrides["segment-composition"] ?? segmentComposition;
  const channels = chartOverrides["channel-composition"] ?? channelComposition;
  const funnel = chartOverrides["activation-funnel"] ?? activationFunnel;
  const funnelSourceRows = latestRows("activation_journey");
  const funnelRows = funnelSourceRows.flatMap(({ week, segment, region, ...counts }) =>
    activationStages.map(([field, stage]) => ({ week, segment, region, stage, accounts: counts[field] })));
  const intensity = chartOverrides["engagement-heatmap"] ?? engagementHeatmap;
  const engagement = chartOverrides["engagement-scatter"] ?? accountEngagement;
  const displayedDriverRows = latestRows("growth_drivers", [drivers.x, drivers.series].filter(Boolean));
  const scenarioHistory = chronologicalRows(reviewedRows("usage_summary", [scenario.x, scenario.series].filter(Boolean)));
  const scenarioFactor = (1 + assumptions.activationLift / 100) * (1 + assumptions.retentionLift / 100);
  const recentGrowth = scenarioHistory.slice(-5).flatMap((row, index, entries) => index && entries[index - 1]?.activeUsers
    ? [row.activeUsers / entries[index - 1].activeUsers - 1] : []);
  const baselineGrowth = Math.max(0.012, Math.min(0.07,
    recentGrowth.reduce((sum, value) => sum + value, 0) / Math.max(1, recentGrowth.length)));
  const scenarioRows = scenarioHistory.map((row, index) => index === scenarioHistory.length - 1
    ? { ...row, baselineUsers: row.activeUsers, projectedUsers: row.activeUsers }
    : { ...row, activeUsers: row.activeUsers });
  if (summary?.week && Number.isFinite(summary.activeUsers)) {
    for (let offset = 1; offset <= 8; offset += 1) {
      const date = new Date(`${summary.week}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset * 7);
      const baselineUsers = Math.round(summary.activeUsers * (1 + baselineGrowth * 0.7) ** offset);
      const assumptionEffect = 1 + (scenarioFactor - 1) * offset / 8;
      scenarioRows.push({ week: date.toISOString().slice(0, 10), baselineUsers,
        projectedUsers: Math.round(baselineUsers * assumptionEffect) });
    }
  }
  const projected = summary && { ...summary, projectedUsers: scenarioRows.at(-1)?.projectedUsers ?? summary.activeUsers };
  const targetAttainment = forecast?.targetUsers > 0
    ? forecast.actualUsers / forecast.targetUsers : undefined;
  const forecastAttainment = forecast?.targetUsers > 0
    ? forecast.projectedUsers / forecast.targetUsers : undefined;
  const segmentHistoryRows = reviewedRows("product_history", [composition.x, composition.series].filter(Boolean));
  const trendRows = reviewedRows("usage_summary", [trend.x, trend.series].filter(Boolean));
  const channelRows = reviewedRows("acquisition_channels", [channels.x, channels.series].filter(Boolean));
  const intensityScope = engagementScope.componentProps("engagement_intensity", [intensity.x, intensity.series].filter(Boolean));
  const intensityRows = aggregateSessions(intensityScope.displayRows, [intensity.x, intensity.series].filter(Boolean));
  const engagementScopeProps = engagementScope.componentProps("engagement_profiles", [engagement.x, engagement.series].filter(Boolean));
  const engagementRows = engagementScopeProps.displayRows;
  const metrics = [
    {
      id: "active-users",
      queryId: "usage_summary",
      title: "Weekly active accounts",
      description: "Distinct accounts active during the reporting week.",
      value: summary ? compact(summary.activeUsers) : "—",
      trendValues: reviewedRows("usage_summary", ["week"]).map(({ activeUsers }) => activeUsers),
      ...periodComparison(summary?.activeUsers, previousSummary?.activeUsers, {
        includePeriod: false,
        previousPeriod: previousSummary?.week ?? "previous week",
      }),
    },
    {
      id: "growth",
      queryId: "usage_summary",
      title: "Week-over-week growth",
      description: "Change in active accounts versus the previous complete week.",
      value: summary ? percentage(summary.growth) : "—",
      trendValues: reviewedRows("usage_summary", ["week"]).map(({ growth }) => growth),
      ...periodComparison(summary?.growth, previousSummary?.growth, {
        includePeriod: false,
        percentagePoints: true,
        previousPeriod: previousSummary?.week ?? "previous week",
      }),
    },
    {
      id: "conversion",
      queryId: "usage_summary",
      title: "Activation rate",
      description: "Activated accounts divided by qualified sign-ups.",
      value: summary ? percentage(summary.conversion).replace("+", "") : "—",
      trendValues: reviewedRows("usage_summary", ["week"]).map(({ conversion }) => conversion),
      ...periodComparison(summary?.conversion, previousSummary?.conversion, {
        includePeriod: false,
        percentagePoints: true,
        previousPeriod: previousSummary?.week ?? "previous week",
      }),
    },
    {
      id: "forecast-gap",
      queryId: "forecast_outlook",
      title: "Forecast to target",
      description: "Reviewed forecast minus the target for the selected scope.",
      value: forecast ? compact(forecast.forecastGap) : "—",
      trendValues: reviewedRows("forecast_outlook", ["week"]).map(({ forecastGap }) => forecastGap),
      ...periodComparison(forecast?.forecastGap, previousForecast?.forecastGap, {
        includePeriod: false,
        previousPeriod: previousForecast?.week ?? "previous week",
      }),
    },
  ];
  const dashboardRows = [
    { id: "dashboard:metrics", className: "metric-strip", kind: "metrics", label: "Key metrics", items: metrics.map(({ id }) => id) },
    { id: "dashboard:trend", className: "dashboard-section", label: "Active accounts over time", items: ["usage-trend"] },
    { id: "dashboard:composition", className: "visual-analysis-grid dashboard-section-start", label: "Adoption and acquisition", items: ["segment-composition", "channel-composition"],
      header: <SectionHeader id="dashboard:adoption-acquisition-title" title="Adoption and acquisition" /> },
    { id: "dashboard:activation", label: "Account activation", items: ["activation-funnel"] },
    { id: "dashboard:engagement", className: "visual-analysis-grid visual-analysis-grid--distribution dashboard-section-start", label: "Engagement patterns", items: ["engagement-heatmap", "engagement-scatter"],
      header: <SectionHeader id="dashboard:engagement-patterns-title" title="Engagement patterns"
        filters={<Filters {...engagementScope.filterProps} ariaLabel="Engagement filters" />} /> },
    { id: "dashboard:diagnostics", className: "diagnostic-layout dashboard-section-start", label: "Growth and outlook", items: ["growth-drivers", "forecast-outlook"],
      header: <SectionHeader id="dashboard:weekly-trends-title" title="Growth and outlook" /> },
    { id: "dashboard:scenario", className: "scenario-section", label: "Scenario analysis", items: ["adoption-scenario"] },
    { id: "dashboard:supporting", className: "analysis-layout dashboard-section-start", label: "Feature and regional adoption", items: ["segment-breakdown", "priority-accounts"],
      header: <SectionHeader id="dashboard:adoption-breakdown-title" title="Feature and regional adoption" /> },
    { id: "dashboard:evidence", className: "dashboard-section evidence-section dashboard-section-start", label: "Account health", items: ["usage-details"],
      header: <SectionHeader id="dashboard:account-evidence-title" title="Account health"
        filters={<Filters {...accountScope.filterProps} ariaLabel="Account health filters" />} /> },
  ];

  return <>
      <Filters sticky filters={snapshot.filters ?? []} queries={queries} values={filters} onChange={setFilter}
        trailingControls={<span className="muted">Compared with previous week</span>} />

      <SortableRegion id="dashboard:dashboard:canvas" label="Dashboard blocks"
        variant="canvas" spacing="standard" authoredRevision={2} columns={12} rows={dashboardRows}>
        {metrics.filter(({ id }) => visible(id)).map(({
          id, queryId, title, description, value, comparison, negative, trendValues,
        }) => (
          <SortableItem key={id} id={id} label={title} kind="metric" span={3} minSpan={2}>
          <MetricCard id={id} title={title} queryId={queryId}
            sourceRows={latestRows(queryId)} description={description}
            value={value} comparison={comparison} negative={negative} trendValues={trendValues} />
          </SortableItem>
        ))}

      {visible("usage-trend") && <SortableItem id="usage-trend" label="Active accounts over time" kind="chart" span={12} minSpan={3}>
        <EvidenceChart variant="card" padding="spacious" id="usage-trend" title="Active accounts over time" queryId="usage_summary"
          spec={adoptionTrend} rows={trendRows} sourceRows={trendRows}
          height={260} className="feature-chart dashboard-panel" />
        </SortableItem>}

        {visible("segment-composition") && <SortableItem id="segment-composition" label="Active accounts by product over time" kind="chart" span={6} minSpan={3}>
        <DataComponent variant="card" id="segment-composition"
          title="Active accounts by product over time" queryId="product_history" kind="chart" chart={composition}
          displayRows={segmentHistoryRows}
          description="Eighteen weeks of reviewed active-account history, broken out by product segment."
          className="visual-analysis-card visual-analysis-card--featured">
          <ChartRenderer spec={composition} rows={segmentHistoryRows} height={210}
            {...chartProps("segment-composition")} />
        </DataComponent>
        </SortableItem>}

        {visible("channel-composition") && <SortableItem id="channel-composition" label="Share of activations by source" kind="chart" span={6} minSpan={3}>
        <DataComponent variant="card" id="channel-composition"
          title="Share of activations by source" queryId="acquisition_channels" kind="chart" chart={channels}
          displayRows={channelRows}
          description="Reviewed weekly activations normalized to show each acquisition channel's share."
          className="visual-analysis-card visual-analysis-card--featured">
          <ChartRenderer spec={channels} rows={channelRows} height={210}
            {...chartProps("channel-composition")} />
        </DataComponent>
        </SortableItem>}

        {visible("activation-funnel") && <SortableItem id="activation-funnel" label="Account activation journey" kind="chart" span={12} minSpan={3}>
        <DataComponent variant="card" padding="spacious" id="activation-funnel"
          title="Account activation journey" queryId="activation_journey" kind="chart" chart={funnel}
          sourceRows={funnelSourceRows} displayRows={funnelRows}
          description="Synthetic sign-up cohorts by reporting week; stages reached as of July 28, 2026. The newest cohort is still incomplete.">
          <ChartRenderer spec={funnel} rows={funnelRows} height={240}
            {...chartProps("activation-funnel")} />
        </DataComponent>
        </SortableItem>}

        {visible("engagement-heatmap") && <SortableItem id="engagement-heatmap" label="When customers are most active" kind="chart" span={6} minSpan={3}>
        <DataComponent variant="card" id="engagement-heatmap"
          title="When customers are most active" queryId="engagement_intensity" kind="chart"
          chart={intensity} {...intensityScope} displayRows={intensityRows}
          description="Reviewed product sessions by day of week and two-hour window; darker blue means more activity."
          className="visual-analysis-card intensity-card">
          <ChartRenderer spec={intensity} rows={intensityRows} height={186}
            {...chartProps("engagement-heatmap")} />
        </DataComponent>
        </SortableItem>}

        {visible("engagement-scatter") && <SortableItem id="engagement-scatter" label="Account size by engagement" kind="chart" span={6} minSpan={3}>
        <DataComponent variant="card" id="engagement-scatter"
          title="Account size by engagement" queryId="engagement_profiles" kind="chart" chart={engagement}
          {...engagementScopeProps}
          description="Reviewed synthetic account-level engagement scores and active users, grouped by product segment."
          className="visual-analysis-card engagement-card">
          <ChartRenderer spec={engagement} rows={engagementRows} height={186}
            {...chartProps("engagement-scatter")} />
        </DataComponent>
        </SortableItem>}


        {visible("growth-drivers") && <SortableItem id="growth-drivers" label="Weekly change in active accounts" kind="chart" span={8} minSpan={3}>
        <DataComponent variant="card" id="growth-drivers"
          title="Weekly change in active accounts" queryId="growth_drivers" kind="chart" chart={drivers} dataInputs={driverDataInputs}
          displayRows={displayedDriverRows} sourceRows={displayedDriverRows}
          description="Reviewed before and after totals reconcile through activation, expansion, and churn."
          className="driver-analysis dashboard-panel">
          <ChartRenderer spec={drivers} dataInputs={driverDataInputs}
            rows={displayedDriverRows} height={196} {...chartProps("growth-drivers")} />
        </DataComponent>
        </SortableItem>}

        {visible("forecast-outlook") && <SortableItem id="forecast-outlook" label="Target attainment" kind="custom" span={4} minSpan={3}>
        <DataComponent variant="card" padding="spacious" id="forecast-outlook"
          title="Target attainment" queryId="forecast_outlook" kind="custom"
          sourceRows={latestRows("forecast_outlook")}
          description="Reviewed current active accounts, operating target, and projected trajectory for the selected scope."
          hideDescriptionTooltip
          className="forecast-panel">
          <p className="forecast-value">{targetAttainment == null ? "—"
            : percentage(targetAttainment).replace("+", "")}</p>
          <RichNarrative id="forecast-outlook:description" value="of this week's active-account target"
            className="analysis-caption" data-source-value label="Target attainment description" />
          <div className="forecast-progress" role="img"
            aria-label={targetAttainment == null ? "Target attainment unavailable"
              : `${percentage(targetAttainment).replace("+", "")} of the reviewed target reached`}>
            <span className="forecast-progress-track" aria-hidden="true">
              <span className="forecast-progress-value"
                style={{ "--forecast-progress": `${progressPercent(targetAttainment)}%` }} />
              <span className="forecast-progress-target" />
              <span className="forecast-progress-projected"
                style={{ "--forecast-projected": `${progressPercent(forecastAttainment)}%` }} />
            </span>
            <span className="forecast-progress-labels" aria-hidden="true">
              <span>0</span><span className="forecast-progress-target-label">Target</span>
              <span>Projected</span>
            </span>
          </div>
          <dl className="forecast-details">
            <div><dt>Active accounts</dt><dd>{forecast ? compact(forecast.actualUsers) : "—"}</dd></div>
            <div><dt>Operating target</dt><dd>{forecast ? compact(forecast.targetUsers) : "—"}</dd></div>
            <div><dt>Projected finish</dt><dd>{forecast ? compact(forecast.projectedUsers) : "—"}</dd></div>
            <div><dt>Projected attainment</dt><dd>{forecastAttainment == null ? "—"
              : percentage(forecastAttainment).replace("+", "")}</dd></div>
          </dl>
        </DataComponent>
        </SortableItem>}

      {visible("adoption-scenario") && <SortableItem id="adoption-scenario" label="Projected active accounts" kind="chart" span={12} minSpan={3}>
        <DataComponent variant="card" padding="spacious" id="adoption-scenario" title="Projected active accounts"
          description="Projected values are modeled estimates, not reviewed observations; they apply your activation and retention assumptions to reviewed active-user data."
          queryId="usage_summary" kind="chart" chart={scenario} displayRows={scenarioRows}
          className="scenario-studio">
          <div className="scenario-layout">
            <aside className="scenario-controls" aria-label="Scenario assumptions">
              <div className="scenario-summary" aria-live="polite">
                <p className="scenario-label">Projected in eight weeks</p>
                <p className="scenario-value">{projected ? compact(projected.projectedUsers) : "—"}</p>
                <p className="scenario-caption">{projected?.activeUsers > 0 ? <>
                  <span className="scenario-change"
                    data-direction={projected.projectedUsers >= projected.activeUsers ? "positive" : "negative"}>
                    {percentage(projected.projectedUsers / projected.activeUsers - 1)}
                  </span>{" "}vs. reviewed baseline
                </> : "No reviewed data for the selected filters"}</p>
              </div>
              <div className="scenario-levers">
                {scenarioLevers.map(({ field, label, min, max }) => <ScenarioLever key={field}
                  label={label} value={assumptions[field]} min={min} max={max}
                  onCommit={(value) => setAssumptions((current) => ({ ...current, [field]: value }))} />)}
              </div>
            </aside>
            <div className="scenario-chart">
              <ChartRenderer spec={scenario} rows={scenarioRows} height={202}
                {...chartProps("adoption-scenario")} />
            </div>
          </div>
        </DataComponent>
        </SortableItem>}

        {visible("segment-breakdown") && <SortableItem id="segment-breakdown" label="Active accounts by feature" kind="chart" span={6} minSpan={3}>
        <DataComponent variant="card" id="segment-breakdown"
          title="Active accounts by feature" queryId="feature_movement" kind="chart" chart={breakdown}
          className="supporting-chart dashboard-panel">
          <ChartRenderer spec={breakdown}
            rows={latestRows("feature_movement", [breakdown.x, breakdown.series].filter(Boolean))}
            height={195} {...chartProps("segment-breakdown")} />
        </DataComponent>
        </SortableItem>}

        {visible("priority-accounts") && <SortableItem id="priority-accounts" label="Active accounts by region" kind="custom" span={6} minSpan={3}>
        <DataComponent variant="card" id="priority-accounts"
          title="Active accounts by region" queryId="account_health" kind="custom"
          sourceRows={accountRows}
          description="Reviewed active accounts grouped by region, with elevated-risk accounts called out."
          className="priority-accounts dashboard-panel">
          {regionalActivity.length ? <>
            <div className="regional-map" role="group" aria-label="Reviewed account activity by region">
              <div className="regional-map-plot">
                <svg className="regional-map-surface" viewBox="0 0 560 220" aria-hidden="true">
                  <path className="regional-map-land" d={regionalWorldMapPath} />
                </svg>
                {mappedRegions.map(({ region, accounts, activeUsers, elevated, x, y, color }) =>
                  <button key={region} type="button" className="regional-marker"
                    aria-label={`${region}: ${compact(activeUsers)} active users, ${accounts} accounts, ${elevated} elevated risk`}
                    style={{ "--regional-x": `${x / 560 * 100}%`, "--regional-y": `${y / 220 * 100}%`,
                      "--regional-color": color, "--regional-size": `${13 + activeUsers / maximumRegionalUsers * 11}px` }}>
                    <span className="regional-marker-halo" />
                    <span className="regional-marker-core" />
                    <span className="regional-marker-value">{compact(activeUsers)}</span>
                    <span className="regional-marker-tooltip" role="tooltip">
                      <strong>{region}</strong>
                      <span>{compact(activeUsers)} active users</span>
                      <span>{accounts} accounts · {elevated} elevated risk</span>
                    </span>
                  </button>)}
              </div>
            </div>
            {unmappedRegions.length > 0 && <p className="analysis-caption" role="status">
              Not plotted: {unmappedRegions.map(({ region, activeUsers }) =>
                `${region} (${compact(activeUsers)} active users)`).join(", ")}. Location unavailable.
            </p>}
            <ol className="priority-list regional-legend chart-legend" data-reviewed-rows aria-label="Regional activity legend">
              {regionalActivity.map(({ region, color }) => <li key={region}>
                <span className="regional-summary-name" style={{ "--regional-color": color }}>{region}</span>
              </li>)}
            </ol>
          </> : <p className="analysis-caption" role="status">No reviewed accounts match the selected filters.</p>}
        </DataComponent>
        </SortableItem>}


      {visible("usage-details") && <SortableItem id="usage-details" label="Reviewed account-level evidence" kind="table" span={12} minSpan={6}>
        <DataComponent variant="card" id="usage-details" title="Reviewed account-level evidence" kind="table"
          queryId="account_health" {...accountScopeProps} sourceRows={scopedAccountRows}
          displayRows={accountEvidenceRows} className="evidence-table dashboard-panel">
          <DataTable rows={accountEvidenceRows} columns={accountEvidenceColumns} signedDeltas />
        </DataComponent>
        </SortableItem>}
      </SortableRegion>
  </>;
}
