import React from "react";
import {
  CartesianGrid,
  Line,
  LineChart as RechartsLineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Chart,
  ChartTooltip,
  barChartSpec,
  compact,
  DataComponent,
  DataTable,
  ExecutiveSummary,
  Filters,
  Icon,
  percentage,
  RichNarrative,
  SectionHeader,
  SortableItem,
  SortableRegion,
  useDataApp,
  useDashboardTabs,
} from "../../data-app-public.jsx";
import "./example.css";
import { queueHistory as aggregateQueueHistory } from "./queue-metrics.js";

const regionColors = {
  "US East": "var(--infra-region-us-strong)",
  "US West": "var(--infra-region-us-soft)",
  "Western Europe": "var(--infra-region-europe-strong)",
  "Northern Europe": "var(--infra-region-europe-soft)",
  Japan: "var(--infra-region-asia-strong)",
  Singapore: "var(--infra-region-asia-soft)",
};

const operatingEnvelopeSpec = {
  type: "line",
  x: "interval",
  y: "utilizationRate",
  series: "region",
  showXAxisLabel: false,
  showYAxisLabel: true,
  yLabel: "Serving utilization",
  yAxisPosition: "right",
  showLegend: true,
  startAtZero: false,
  colors: {
    ...regionColors,
    "Selected average": "var(--infra-reference)",
  },
};

const demandTrendSpec = {
  type: "line",
  x: "hourLabel",
  y: "Observed",
  fields: ["Observed", "Plan"],
  showXAxisLabel: false,
  showYAxisLabel: false,
  showLegend: true,
  startAtZero: false,
  yAxisPosition: "right",
  colors: {
    Observed: "var(--infra-data-strong)",
    Plan: "var(--infra-reference)",
  },
};

const failoverMarginSpec = {
  type: "line",
  x: "hourLabel",
  y: "Margin",
  showXAxisLabel: false,
  showYAxisLabel: false,
  showLegend: false,
  startAtZero: false,
  yAxisPosition: "right",
  colors: { Margin: "var(--infra-data-2)" },
};

const placementDelaySpec = {
  type: "line",
  x: "hourLabel",
  y: "P95 delay",
  showXAxisLabel: false,
  showYAxisLabel: false,
  showLegend: false,
  startAtZero: false,
  yAxisPosition: "right",
  colors: { "P95 delay": "var(--infra-data-3)" },
};

const admissionFailureSpec = {
  type: "line",
  x: "hourLabel",
  y: "Failed",
  showXAxisLabel: false,
  showYAxisLabel: false,
  showLegend: false,
  startAtZero: false,
  yAxisPosition: "right",
  colors: { Failed: "var(--infra-data-4)" },
};

function microLineSpec(y, color) {
  return {
    type: "line",
    x: "hourLabel",
    y,
    showXAxisLabel: false,
    showYAxisLabel: false,
    showLegend: false,
    startAtZero: false,
    colors: { [y]: color },
  };
}

const availableTrendSpec = microLineSpec("Available", "var(--infra-data-5)");
const utilizationTrendSpec = microLineSpec("Utilization", "var(--infra-data-6)");
const unavailableTrendSpec = microLineSpec("Unavailable", "var(--infra-data-7)");
const queueDepthTrendSpec = microLineSpec("Queued", "var(--infra-data-strong)");

const pressureSpec = {
  type: "line",
  x: "hourLabel",
  y: "utilizationRate",
  series: "region",
  showXAxisLabel: false,
  showYAxisLabel: false,
  showLegend: true,
  startAtZero: false,
  yAxisPosition: "right",
  colors: regionColors,
};

const poolLoadRegions = Object.entries(regionColors)
  .map(([name, color]) => ({ name, color }));

const poolLoadPools = [
  { name: "H100", strength: 66 },
  { name: "H200", strength: 83 },
  { name: "B200", strength: 100 },
];

const poolLoadColors = Object.fromEntries(poolLoadRegions.flatMap(({ name: region, color }) =>
  poolLoadPools.map(({ name: pool, strength }) => [
    `${region} · ${pool}`,
    strength === 100 ? color : `color-mix(in srgb, ${color} ${strength}%, var(--surface))`,
  ])));

const regionalPoolLoadSpec = {
  type: "stackedArea",
  x: "interval",
  y: "demandUnits",
  series: "series",
  showXAxisLabel: false,
  yLabel: "Active demand · GPU-equivalent slots",
  yAxisPosition: "left",
  xTickLabelLayout: "date-time",
  showLegend: true,
  startAtZero: true,
  legend: { position: "right" },
  colors: poolLoadColors,
};

function groupBy(rows, field, measures) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!groups.has(key)) groups.set(key, { [field]: key });
    const group = groups.get(key);
    for (const measure of measures) group[measure] = (group[measure] ?? 0) + (Number(row[measure]) || 0);
  }
  return [...groups.values()];
}

function latestPair(rows) {
  const ordered = [...rows].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  return [ordered.at(-1), ordered.at(-2)];
}

function intervalLabel(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(timestamp)).replace(",", " ·");
}

function compactIntervalLabel(timestamp) {
  const date = new Date(timestamp);
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: date.getUTCMinutes() ? "2-digit" : undefined,
    timeZone: "UTC",
  }).format(date);
  return `${day} · ${time}`;
}

function lineBounds(rows, series, includeZero = false) {
  const values = rows.flatMap((row) => series.map(({ key }) => Number(row[key])))
    .filter((value) => Number.isFinite(value));
  if (!values.length) return [0, 1];
  const observedMinimum = Math.min(...values);
  const observedMaximum = Math.max(...values);
  let minimum = observedMinimum;
  let maximum = observedMaximum;
  if (includeZero) {
    minimum = Math.min(0, minimum);
    maximum = Math.max(0, maximum);
  }
  if (minimum === maximum) {
    const fallback = Math.max(Math.abs(minimum) * 0.1, 1);
    minimum -= fallback;
    maximum += fallback;
  }
  const span = maximum - minimum;
  const paddedMinimum = minimum - span * 0.08;
  const paddedMaximum = maximum + span * 0.08;
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const normalized = span / magnitude;
  const step = normalized <= 2 ? magnitude * 0.5 : normalized <= 5 ? magnitude : magnitude * 2;
  const lower = includeZero && observedMinimum >= 0 ? 0 : Math.floor(paddedMinimum / step) * step;
  const upper = includeZero && observedMaximum <= 0 ? 0 : Math.ceil(paddedMaximum / step) * step;
  return [lower, upper];
}

function CompactLineChart({ rows, xKey = "hourLabel", series, domain, ticks: authoredTicks,
  tickFormatter = compact, valueFormatter = compact, includeZero = false, referenceAt,
  ariaLabel = "Line chart" }) {
  const [hidden, setHidden] = React.useState(() => new Set());
  const tickIndexes = new Set([0, Math.round((rows.length - 1) * 0.25),
    Math.round((rows.length - 1) * 0.5), Math.round((rows.length - 1) * 0.75), rows.length - 1]);
  const xTicks = rows.filter((_, index) => tickIndexes.has(index)).map((row) => row[xKey]);
  const yDomain = domain ?? lineBounds(rows, series, includeZero);
  const yTicks = authoredTicks ?? yDomain;
  const showLegend = series.length > 1;
  const toggleSeries = (key) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  const isolateSeries = (key) => setHidden(new Set(series.map((item) => item.key).filter((name) => name !== key)));

  return <div className="compact-line-visual" data-has-legend={showLegend} role="application"
    aria-label={ariaLabel}>
    <div className="compact-line-plot">
      <ResponsiveContainer width="100%" height="100%">
        <RechartsLineChart data={rows} margin={{ top: 10, right: 10, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--border)" strokeWidth={0.5} vertical={false}
            horizontalValues={yTicks} />
          <XAxis dataKey={xKey} ticks={xTicks} axisLine={false} tickLine={false} tickMargin={8}
            interval="preserveStartEnd" tick={{ fill: "var(--secondary)", fontSize: 10 }} />
          <YAxis orientation="right" domain={yDomain} ticks={yTicks} axisLine={false} tickLine={false}
            tickMargin={0} width={38} tick={{ fill: "var(--secondary)", fontSize: 11, textAnchor: "end", dx: 36 }}
            tickFormatter={(value) => tickFormatter(Number(value))} />
          <RechartsTooltip offset={12} allowEscapeViewBox={{ x: true, y: true }}
            content={<ChartTooltip formatValue={value => valueFormatter(Number(value))}
              formatLabel={item => item.name ?? item.dataKey}
              resolveStyle={item => series.find(series => series.key === item.dataKey)?.reference ? { type: "target" } : undefined} />} />
          {referenceAt !== undefined && <ReferenceLine y={referenceAt} stroke="var(--infra-reference)"
            strokeDasharray="3 4" strokeWidth={1} />}
          {series.map(({ key, color = "var(--infra-data-strong)", reference = false }) =>
            <Line key={key} type="monotone" dataKey={key} stroke={color}
              strokeWidth={reference ? 1.5 : 2.25} strokeDasharray={reference ? "4 4" : undefined}
              opacity={reference ? 0.82 : 1} strokeLinecap="round" strokeLinejoin="round"
              dot={false} hide={hidden.has(key)}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />)}
        </RechartsLineChart>
      </ResponsiveContainer>
    </div>
    {showLegend && <ul className="chart-legend compact-line-legend" aria-label="Chart legend">
      {series.map(({ key, color = "var(--infra-data-strong)" }) => <li key={key}>
        <button type="button" className="chart-legend-button" aria-label={`Toggle ${key}`}
          aria-pressed={!hidden.has(key)} onClick={() => toggleSeries(key)}
          onDoubleClick={() => isolateSeries(key)}>
          <span className="chart-legend-mark line" aria-hidden="true"
            style={{ "--legend-color": color }} />
          <span>{key}</span>
        </button>
      </li>)}
    </ul>}
  </div>;
}

function MicroLineChart({ rows, dataKey, color = "var(--infra-data-strong)", valueFormatter = compact, ariaLabel }) {
  if (!rows.length) return <div className="micro-line-empty">No data</div>;
  const domain = lineBounds(rows, [{ key: dataKey }]);
  const midpoint = (domain[0] + domain[1]) / 2;
  const current = rows.at(-1)?.[dataKey];
  return <div className="micro-line-visual" role="application" aria-label={ariaLabel}>
    <strong className="micro-line-value">{Number.isFinite(current) ? valueFormatter(current) : "—"}</strong>
    <ResponsiveContainer width="100%" height={30}>
      <RechartsLineChart data={rows} margin={{ top: 5, right: 2, bottom: 3, left: 2 }}>
        <XAxis dataKey="hourLabel" hide />
        <YAxis domain={domain} hide />
        <ReferenceLine y={midpoint} stroke="var(--border)" strokeWidth={0.75} />
        <RechartsTooltip offset={12} allowEscapeViewBox={{ x: true, y: true }}
          content={<ChartTooltip formatValue={value => valueFormatter(Number(value))} />} />
        <Line type="monotone" dataKey={dataKey} stroke={color} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
          dot={rows.length === 1 ? { r: 3, fill: color, strokeWidth: 0 } : false}
          activeDot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
      </RechartsLineChart>
    </ResponsiveContainer>
  </div>;
}

function StackedSignalChart({ rows, signals, ariaLabel }) {
  if (!rows.length) return <div className="stacked-signal-empty">No data</div>;
  const firstLabel = rows.at(0)?.hourLabel ?? "—";
  const lastLabel = rows.at(-1)?.hourLabel ?? "—";
  return <div className="stacked-signal-chart" role="application" aria-label={ariaLabel}>
    {signals.map((signal) => {
      const domain = lineBounds(rows, [{ key: signal.key }]);
      const midpoint = (domain[0] + domain[1]) / 2;
      const current = rows.at(-1)?.[signal.key];
      return <div className="stacked-signal-row" key={signal.key}
        style={{ "--signal-color": signal.color }}>
        <div className="stacked-signal-label">
          <span className="stacked-signal-dot" aria-hidden="true" />
          <span>{signal.label}</span>
        </div>
        <div className="stacked-signal-plot">
          <ResponsiveContainer width="100%" height="100%">
            <RechartsLineChart data={rows} margin={{ top: 4, right: 3, bottom: 4, left: 3 }}>
              <XAxis dataKey="hourLabel" hide />
              <YAxis domain={domain} hide />
              <ReferenceLine y={midpoint} stroke="var(--border)" strokeWidth={0.75} />
              <RechartsTooltip offset={12} allowEscapeViewBox={{ x: true, y: true }}
                content={<ChartTooltip formatValue={value => signal.formatter(Number(value))}
                  formatLabel={item => item.payload?.[signal.detailKey] ?? signal.label} />} />
              <Line type="monotone" dataKey={signal.key} name={signal.label} stroke={signal.color}
                strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" dot={false}
                activeDot={{ r: 3, strokeWidth: 2, stroke: "var(--surface)" }} isAnimationActive={false} />
            </RechartsLineChart>
          </ResponsiveContainer>
        </div>
        <strong className="stacked-signal-value">{Number.isFinite(current) ? signal.formatter(current) : "—"}</strong>
      </div>;
    })}
    <div className="stacked-signal-time-row" aria-hidden="true">
      <div className="stacked-signal-time"><span>{firstLabel}</span><span>{lastLabel} UTC</span></div>
    </div>
  </div>;
}

function RegionalPressureChart({ rows, regions, colors }) {
  const plottedRows = [...rows.reduce((groups, row) => {
    const point = groups.get(row.hourLabel) ?? { hourLabel: row.hourLabel };
    point[row.region] = row.utilizationRate;
    groups.set(row.hourLabel, point);
    return groups;
  }, new Map()).values()];
  return <CompactLineChart rows={plottedRows}
    series={regions.map((region) => ({ key: region, color: colors?.[region] }))}
    domain={[0.5, 1]} ticks={[0.5, 1]}
    tickFormatter={(value) => `${Math.round(value * 100)}%`}
    valueFormatter={(value) => percentage(value).replace("+", "")}
    ariaLabel="Regional pressure from 50 to 100 percent" />;
}

function failoverSummaryCopy(failoverMargin) {
  return failoverMargin >= 0
    ? `${compact(failoverMargin)} slots remain before failover reserve is needed.`
    : `${compact(Math.abs(failoverMargin))} slots of failover reserve are in use.`;
}

function ExecutiveSummaryCopy({ available, headroom, failoverMargin, hottestRegion, queue, failures,
  concentration }) {
  const utilization = hottestRegion?.utilizationRate;
  const thresholdGap = Number.isFinite(utilization) ? 0.75 - utilization : null;
  const failoverCopy = failoverSummaryCopy(failoverMargin);
  const thresholdCopy = thresholdGap === null
    ? "Its distance from the next review threshold is not available."
    : thresholdGap >= 0
      ? `It remains ${(thresholdGap * 100).toFixed(1)} percentage points below the 75% review threshold.`
      : `It is ${(Math.abs(thresholdGap) * 100).toFixed(1)} percentage points above the 75% review threshold.`;

  return <>
    <RichNarrative id="capacity-summary-availability" value={`**${compact(available)} accelerator slots remain available.** Headroom is ${percentage(headroom).replace("+", "")}. ${failoverCopy}`} />
    <RichNarrative id="capacity-summary-region" value={`**${hottestRegion?.region ?? "The leading region"} is carrying the highest regional load${Number.isFinite(utilization) ? ` at ${percentage(utilization).replace("+", "")}` : ""}.** ${thresholdCopy}`} />
    <RichNarrative id="capacity-summary-queue" value={`**${compact(queue?.queueDepth ?? 0)} workloads are queued and ${compact(failures ?? 0)} admissions failed in the latest half-hour.** ${concentration?.queueLeader ?? "The leading region"} holds ${percentage(concentration?.queueShare ?? 0).replace("+", "")} of queued work; ${concentration?.failureLeader ?? "the leading failure region"} accounts for ${percentage(concentration?.failureShare ?? 0).replace("+", "")} of failed admissions.`} />
  </>;
}

export function DashboardContent() {
  useDashboardTabs([{ id: "capacity", label: "Capacity" }]);
  const {
    snapshot: dashboard,
    appTitle, setAppTitle,
    queries,
    filters,
    setFilter,
    reviewedRows,
    chartOverrides,
    chartProps,
    visible,
  } = useDataApp();

  React.useEffect(() => {
    if (dashboard.status === "fixture" && ["Inference fleet capacity", "Infrastructure capacity"].includes(appTitle)) setAppTitle(dashboard.title);
  }, [dashboard.title, dashboard.status, appTitle, setAppTitle]);

  const capacitySource = reviewedRows("capacity", ["timestamp", "region", "pool"]);
  const queueSource = reviewedRows("queues", ["timestamp", "region", "pool"]);
  const failureSource = reviewedRows("failures", ["timestamp", "cause", "region", "pool"]);
  const incidentSource = reviewedRows("incidents", ["incident", "region"]);
  const concentrationSource = reviewedRows("concentration", ["timestamp", "region", "pool"]);

  const capacityHistory = groupBy(capacitySource, "timestamp",
    ["capacityUnits", "plannedDemandUnits", "demandUnits", "safeCapacityUnits", "unavailableUnits", "reservedUnits"])
    .map((row) => ({ ...row, interval: intervalLabel(row.timestamp),
      utilizationRate: row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits) }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const queueHistory = aggregateQueueHistory(queueSource)
    .map(row => ({...row,interval:intervalLabel(row.timestamp)}));
  const failureHistory = groupBy(failureSource, "timestamp", ["failures"])
    .map((row) => ({ ...row, hourLabel: row.timestamp.slice(11, 16) }))
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const regionalOperatingHistory = capacitySource.reduce((groups, row) => {
    const key = `${row.timestamp}:${row.region}`;
    const group = groups.get(key) ?? { timestamp: row.timestamp, region: row.region,
      capacityUnits: 0, demandUnits: 0, unavailableUnits: 0 };
    group.capacityUnits += row.capacityUnits;
    group.demandUnits += row.demandUnits;
    group.unavailableUnits += row.unavailableUnits;
    groups.set(key, group);
    return groups;
  }, new Map());
  const operatingEnvelopeRows = [
    ...[...regionalOperatingHistory.values()].map((row) => ({
      timestamp: row.timestamp,
      interval: intervalLabel(row.timestamp),
      region: row.region,
      utilizationRate: row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits),
    })),
    ...capacityHistory.map((row) => ({
      timestamp: row.timestamp,
      interval: row.interval,
      region: "Selected average",
      utilizationRate: row.utilizationRate,
    })),
  ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const compactCapacityHistory = capacityHistory.slice(-24);
  const demandTrendRows = compactCapacityHistory.map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Observed: row.demandUnits,
    Plan: row.plannedDemandUnits,
  }));
  const failoverMarginRows = compactCapacityHistory.map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Margin: Math.max(0, row.safeCapacityUnits - row.unavailableUnits) - row.demandUnits,
  }));
  const placementDelayRows = queueHistory.slice(-24).map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    "P95 delay": row.p95DelaySeconds,
  }));
  const admissionFailureRows = failureHistory.slice(-24).map((row) => ({
    hourLabel: row.hourLabel,
    Failed: row.failures,
  }));
  const availableTrendRows = compactCapacityHistory.map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Available: Math.max(0, row.capacityUnits - row.demandUnits - row.unavailableUnits),
  }));
  const utilizationTrendRows = compactCapacityHistory.map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Utilization: row.utilizationRate,
  }));
  const unavailableTrendRows = compactCapacityHistory.map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Unavailable: row.unavailableUnits,
  }));
  const queueDepthTrendRows = queueHistory.slice(-24).map((row) => ({
    hourLabel: row.timestamp.slice(11, 16),
    Queued: row.queueDepth,
  }));
  const concentrationByRegion = concentrationSource.reduce((groups, row) => {
    const key = `${row.timestamp}:${row.region}`;
    const group = groups.get(key) ?? { timestamp: row.timestamp, hourLabel: row.hourLabel, region: row.region,
      capacityUnits: 0, demandUnits: 0, unavailableUnits: 0, queueDepth: 0, failures: 0 };
    group.capacityUnits += row.capacityUnits;
    group.demandUnits += row.demandUnits;
    group.unavailableUnits += row.unavailableUnits;
    group.queueDepth += row.queueDepth;
    group.failures += row.failures;
    groups.set(key, group);
    return groups;
  }, new Map());
  const concentrationByTimestamp = [...concentrationByRegion.values()].reduce((groups, row) => {
    const group = groups.get(row.timestamp) ?? [];
    group.push({ ...row, utilizationRate: row.demandUnits /
      Math.max(1, row.capacityUnits - row.unavailableUnits) });
    groups.set(row.timestamp, group);
    return groups;
  }, new Map());
  const regionalConcentrationRows = [...concentrationByTimestamp.entries()]
    .sort(([left], [right]) => left.localeCompare(right)).slice(-24)
    .map(([timestamp, regionalRows]) => {
      const utilizationRanked = [...regionalRows].sort((left, right) => right.utilizationRate - left.utilizationRate);
      const queueRanked = [...regionalRows].sort((left, right) => right.queueDepth - left.queueDepth);
      const failureRanked = [...regionalRows].sort((left, right) => right.failures - left.failures);
      const totalQueue = regionalRows.reduce((sum, row) => sum + row.queueDepth, 0);
      const totalFailures = regionalRows.reduce((sum, row) => sum + row.failures, 0);
      return {
        timestamp,
        hourLabel: regionalRows.at(0)?.hourLabel ?? timestamp.slice(11, 16),
        utilizationSpread: (utilizationRanked.at(0)?.utilizationRate ?? 0) -
          (utilizationRanked.at(-1)?.utilizationRate ?? 0),
        utilizationLeader: utilizationRanked.at(0)?.region,
        queueShare: (queueRanked.at(0)?.queueDepth ?? 0) / Math.max(1, totalQueue),
        queueLeader: queueRanked.at(0)?.region,
        failureShare: (failureRanked.at(0)?.failures ?? 0) / Math.max(1, totalFailures),
        failureLeader: failureRanked.at(0)?.region,
      };
    });
  const [currentCapacity] = latestPair(capacityHistory);
  const [currentQueue] = latestPair(queueHistory);
  const [currentFailures] = latestPair(failureHistory);
  const latestTimestamp = currentCapacity?.timestamp;
  const availableNow = Math.max(0, (currentCapacity?.capacityUnits ?? 0) -
    (currentCapacity?.demandUnits ?? 0) - (currentCapacity?.unavailableUnits ?? 0));
  const headroomNow = availableNow / Math.max(1, (currentCapacity?.capacityUnits ?? 0) -
    (currentCapacity?.unavailableUnits ?? 0));
  const failoverMarginNow = Math.max(0, (currentCapacity?.safeCapacityUnits ?? 0) -
    (currentCapacity?.unavailableUnits ?? 0)) - (currentCapacity?.demandUnits ?? 0);
  const executiveSummaryPreview = `${compact(availableNow)} accelerator slots remain available. Headroom is ${
    percentage(headroomNow).replace("+", "")}. ${failoverSummaryCopy(failoverMarginNow)}`;
  const failoverEnvelope = Math.max(1, (currentCapacity?.safeCapacityUnits ?? 0) -
    (currentCapacity?.unavailableUnits ?? 0));
  const failoverMarginShare = Math.max(0, failoverMarginNow) / failoverEnvelope;
  const peakQueue = Math.max(1, ...queueHistory.slice(-24).map((row) => row.queueDepth ?? 0));
  const peakFailures = Math.max(1, ...failureHistory.slice(-24).map((row) => row.failures ?? 0));
  const incidentStatusRows = [...incidentSource.reduce((groups, row) => {
    const group = groups.get(row.status) ?? { status: row.status, incidents: 0 };
    group.incidents += 1;
    groups.set(row.status, group);
    return groups;
  }, new Map()).values()];
  const incidentCount = incidentStatusRows.reduce((total, row) => total + row.incidents, 0);
  const stableIncidentCount = incidentStatusRows
    .filter((row) => row.status === "Monitoring" || row.status === "Resolved")
    .reduce((total, row) => total + row.incidents, 0);
  const incidentResponseProgress = incidentCount ? stableIncidentCount / incidentCount : 0;
  const progressMetrics = [
    {
      id: "failover-envelope-progress",
      title: "Failover margin",
      description: "Share of the N+1 safe envelope remaining after demand and unavailable capacity.",
      queryId: "capacity",
      value: failoverMarginShare,
      detail: `${compact(Math.max(0, failoverMarginNow))} left`,
      color: "var(--infra-data-strong)",
      displayRows: [{ timestamp: latestTimestamp, metric: "Failover margin",
        safeCapacityUnits: currentCapacity?.safeCapacityUnits ?? 0,
        unavailableUnits: currentCapacity?.unavailableUnits ?? 0,
        demandUnits: currentCapacity?.demandUnits ?? 0, marginUnits: Math.max(0, failoverMarginNow),
        progress: failoverMarginShare }],
      sourceRows: capacitySource,
    },
    {
      id: "incident-response-progress",
      title: "Incident response",
      description: "Share of current incidents that are monitoring or resolved.",
      queryId: "incidents",
      value: incidentResponseProgress,
      detail: `${stableIncidentCount} / ${incidentCount} stable`,
      color: "var(--infra-data-2)",
      displayRows: incidentStatusRows,
      sourceRows: incidentSource,
    },
    {
      id: "queue-recovery-progress",
      title: "Queue recovery",
      description: "Share of peak placement backlog cleared during the observed window.",
      queryId: "queues",
      value: (peakQueue - (currentQueue?.queueDepth ?? 0)) / peakQueue,
      detail: `${compact(currentQueue?.queueDepth ?? 0)} left`,
      color: "var(--infra-data-3)",
      displayRows: [{ timestamp: currentQueue?.timestamp, metric: "Queue recovery",
        queueDepth: currentQueue?.queueDepth ?? 0, peakQueueDepth: peakQueue,
        progress: (peakQueue - (currentQueue?.queueDepth ?? 0)) / peakQueue }],
      sourceRows: queueSource,
    },
    {
      id: "admission-recovery-progress",
      title: "Failure recovery",
      description: "Share of peak failed admissions eliminated during the observed window.",
      queryId: "failures",
      value: (peakFailures - (currentFailures?.failures ?? 0)) / peakFailures,
      detail: `${compact(currentFailures?.failures ?? 0)} latest`,
      color: "var(--infra-data-4)",
      displayRows: [{ timestamp: currentFailures?.timestamp, metric: "Failure recovery",
        failures: currentFailures?.failures ?? 0, peakFailures,
        progress: (peakFailures - (currentFailures?.failures ?? 0)) / peakFailures }],
      sourceRows: failureSource,
    },
  ];

  const pressureRows = capacitySource.filter((row) => row.timestamp >= capacityHistory.at(-24)?.timestamp)
    .reduce((groups, row) => {
      const key = `${row.timestamp}:${row.region}`;
      const group = groups.get(key) ?? { timestamp: row.timestamp, hourLabel: row.timestamp.slice(11, 16),
        region: row.region, capacityUnits: 0, demandUnits: 0, unavailableUnits: 0 };
      group.capacityUnits += row.capacityUnits;
      group.demandUnits += row.demandUnits;
      group.unavailableUnits += row.unavailableUnits;
      groups.set(key, group);
      return groups;
    }, new Map());
  const regionalLatest = groupBy(capacitySource.filter((row) => row.timestamp === latestTimestamp), "region",
    ["capacityUnits", "demandUnits", "unavailableUnits"])
    .map((row) => ({ ...row, utilizationRate: row.demandUnits /
      Math.max(1, row.capacityUnits - row.unavailableUnits) }));
  const priorityRegions = new Set([...regionalLatest]
    .sort((left, right) => right.utilizationRate - left.utilizationRate)
    .slice(0, 3).map((row) => row.region));
  const regionalPressureRows = [...pressureRows.values()]
    .map((row) => ({ ...row,
      utilizationRate: row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits) }))
    .filter((row) => priorityRegions.has(row.region));
  const pressureRegionNames = [...new Set(regionalPressureRows.map((row) => row.region))];
  const hottestRegion = [...regionalLatest].sort((left, right) => right.utilizationRate - left.utilizationRate).at(0);

  const poolLoadRegionOrder = new Map(poolLoadRegions.map(({ name }, index) => [name, index]));
  const poolLoadPoolOrder = new Map(poolLoadPools.map(({ name }, index) => [name, index]));
  const regionalPoolLoadGroups = capacitySource.reduce((groups, row) => {
    const key = `${row.timestamp}:${row.region}:${row.pool}`;
    const group = groups.get(key) ?? { timestamp: row.timestamp, region: row.region, pool: row.pool,
      capacityUnits: 0, demandUnits: 0, unavailableUnits: 0 };
    group.capacityUnits += row.capacityUnits;
    group.demandUnits += row.demandUnits;
    group.unavailableUnits += row.unavailableUnits;
    groups.set(key, group);
    return groups;
  }, new Map());
  const regionalPoolLoadRows = [...regionalPoolLoadGroups.values()].map((row) => ({
    ...row,
    interval: compactIntervalLabel(row.timestamp),
    series: `${row.region} · ${row.pool}`,
    usableCapacityUnits: Math.max(0, row.capacityUnits - row.unavailableUnits),
    utilizationRate: row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits),
  })).sort((left, right) => left.timestamp.localeCompare(right.timestamp)
    || (poolLoadRegionOrder.get(left.region) ?? Number.MAX_SAFE_INTEGER) -
      (poolLoadRegionOrder.get(right.region) ?? Number.MAX_SAFE_INTEGER)
    || (poolLoadPoolOrder.get(left.pool) ?? Number.MAX_SAFE_INTEGER) -
      (poolLoadPoolOrder.get(right.pool) ?? Number.MAX_SAFE_INTEGER));
  const availablePoolLoadSeries = new Set(regionalPoolLoadRows.map((row) => row.series));
  const allPoolLoadSeries = poolLoadRegions.flatMap(({ name: region }) =>
    poolLoadPools.map(({ name: pool }) => `${region} · ${pool}`))
    .filter((series) => availablePoolLoadSeries.has(series));

  const operatingEnvelopeChart = chartOverrides["fleet-operating-envelope"] ?? operatingEnvelopeSpec;
  const demandTrendChart = chartOverrides["demand-trend"] ?? demandTrendSpec;
  const failoverMarginChart = chartOverrides["failover-margin"] ?? failoverMarginSpec;
  const placementDelayChart = chartOverrides["placement-delay-trend"] ?? placementDelaySpec;
  const admissionFailureChart = chartOverrides["admission-failure-trend"] ?? admissionFailureSpec;
  const availableTrendChart = chartOverrides["available-trend"] ?? availableTrendSpec;
  const utilizationTrendChart = chartOverrides["utilization-trend"] ?? utilizationTrendSpec;
  const unavailableTrendChart = chartOverrides["unavailable-trend"] ?? unavailableTrendSpec;
  const queueDepthTrendChart = chartOverrides["queue-depth-trend"] ?? queueDepthTrendSpec;
  const pressureChart = chartOverrides["regional-pressure"] ?? pressureSpec;
  const regionalPoolLoadChart = chartOverrides["regional-pool-saturation"] ?? regionalPoolLoadSpec;
  const regionalPoolLoadDisplayChart = {
    ...regionalPoolLoadChart,
    yAxisPosition: "left",
    xTickLabelLayout: "date-time",
    showLegend: false,
    legend: undefined,
  };
  const regionalPoolLoadChartProps = chartProps("regional-pool-saturation");
  const controlledPoolLoadSeries = regionalPoolLoadChartProps.visibleSeries == null
    ? allPoolLoadSeries
    : [...regionalPoolLoadChartProps.visibleSeries].filter((series) => availablePoolLoadSeries.has(series));
  const visiblePoolLoadSeries = controlledPoolLoadSeries.length > 0
    ? controlledPoolLoadSeries : allPoolLoadSeries;
  const visiblePoolLoadSeriesSet = new Set(visiblePoolLoadSeries);
  const poolLoadHasFocus = visiblePoolLoadSeries.length < allPoolLoadSeries.length;
  const focusedPoolLoadRegion = poolLoadRegions.find(({ name: region }) => {
    const regionSeries = poolLoadPools.map(({ name: pool }) => `${region} · ${pool}`)
      .filter((series) => availablePoolLoadSeries.has(series));
    return regionSeries.length === visiblePoolLoadSeries.length
      && regionSeries.every((series) => visiblePoolLoadSeriesSet.has(series));
  })?.name;
  const focusedPoolLoadSeries = visiblePoolLoadSeries.length === 1 ? visiblePoolLoadSeries[0] : null;
  const poolLoadScopeLabel = focusedPoolLoadSeries ?? focusedPoolLoadRegion
    ?? (poolLoadHasFocus ? "Custom selection" : "All regions");

  const updateVisiblePoolLoadSeries = (series) => {
    if (series.length > 0) regionalPoolLoadChartProps.onVisibleSeriesChange?.(series);
  };

  return <article className="page infrastructure-page">
    <SectionHeader id="infrastructure-capacity-title" as="h1" title="Capacity overview" />

    <Filters sticky filters={dashboard.filters ?? []} queries={queries} values={filters} onChange={setFilter} />

    <ExecutiveSummary preview={executiveSummaryPreview} className="infrastructure-executive-summary">
      <ExecutiveSummaryCopy available={availableNow} headroom={headroomNow} failoverMargin={failoverMarginNow}
        hottestRegion={hottestRegion} queue={currentQueue} failures={currentFailures?.failures}
        concentration={regionalConcentrationRows.at(-1)} />
    </ExecutiveSummary>

    <SortableRegion id="infrastructure-capacity:layout" label="Inference capacity dashboard blocks"
      authoredRevision={8} variant="freeform" className="infrastructure-grid">
      {visible("fleet-operating-envelope") && <SortableItem id="fleet-operating-envelope"
        label="Regional operating envelope" kind="chart" className="operating-envelope-item">
        <DataComponent variant="card" padding="spacious" id="fleet-operating-envelope" queryId="capacity"
          kind="chart" chart={operatingEnvelopeChart} title="Regional operating envelope"
          description="Serving utilization for all six regions against the fleet-wide average."
          displayRows={operatingEnvelopeRows} sourceRows={capacitySource} className="operating-envelope-card">
          <div className="operating-envelope-chart-stage">
            <Chart spec={operatingEnvelopeChart} rows={operatingEnvelopeRows} height={260}
              {...chartProps("fleet-operating-envelope")} />
          </div>
        </DataComponent>
      </SortableItem>}

      {visible("demand-trend") && <SortableItem id="demand-trend" label="Live demand"
        kind="chart" className="compact-line-item">
        <DataComponent variant="card" padding="spacious" id="demand-trend" queryId="capacity" kind="chart"
          chart={demandTrendChart} title="Live demand"
          description="Observed accelerator demand against the traffic plan during the rollout window."
          displayRows={demandTrendRows} sourceRows={capacitySource} className="compact-line-card">
          <CompactLineChart rows={demandTrendRows} ariaLabel="Observed demand compared with the traffic plan"
            series={[
              { key: "Observed", color: demandTrendChart.colors?.Observed ?? "var(--infra-data-strong)" },
              { key: "Plan", color: demandTrendChart.colors?.Plan ?? "var(--infra-reference)", reference: true },
            ]} />
        </DataComponent>
      </SortableItem>}

      {visible("failover-margin") && <SortableItem id="failover-margin" label="Failover margin"
        kind="chart" className="compact-line-item">
        <DataComponent variant="card" padding="spacious" id="failover-margin" queryId="capacity" kind="chart"
          chart={failoverMarginChart} title="Failover margin"
          description="Accelerator slots remaining below the N+1 limit; a negative value means reserve is in use."
          displayRows={failoverMarginRows} sourceRows={capacitySource} className="compact-line-card">
          <CompactLineChart rows={failoverMarginRows} includeZero referenceAt={0}
            ariaLabel="Accelerator slots remaining below the N plus one failover limit"
            series={[{ key: "Margin", color: failoverMarginChart.colors?.Margin ?? "var(--infra-data-2)" }]} />
        </DataComponent>
      </SortableItem>}

      {visible("placement-delay-trend") && <SortableItem id="placement-delay-trend" label="Placement delay"
        kind="chart" className="compact-line-item">
        <DataComponent variant="card" padding="spacious" id="placement-delay-trend" queryId="queues" kind="chart"
          chart={placementDelayChart} title="Placement delay"
          description="P95 placement delay in the selected scope, calculated from combined placement frequencies in each half-hour window."
          displayRows={placementDelayRows} sourceRows={queueSource} className="compact-line-card">
          <CompactLineChart rows={placementDelayRows} includeZero
            tickFormatter={(value) => `${Math.round(value)}s`} valueFormatter={(value) => `${value.toFixed(1)}s`}
            ariaLabel="P95 inference workload placement delay"
            series={[{ key: "P95 delay", color: placementDelayChart.colors?.["P95 delay"]
              ?? "var(--infra-data-3)" }]} />
        </DataComponent>
      </SortableItem>}

      {visible("admission-failure-trend") && <SortableItem id="admission-failure-trend" label="Admission failures"
        kind="chart" className="compact-line-item">
        <DataComponent variant="card" padding="spacious" id="admission-failure-trend" queryId="failures" kind="chart"
          chart={admissionFailureChart} title="Admission failures"
          description="Inference workloads rejected during each half-hour window in the rollout."
          displayRows={admissionFailureRows} sourceRows={failureSource} className="compact-line-card">
          <CompactLineChart rows={admissionFailureRows} includeZero ariaLabel="Inference workload admission failures"
            series={[{ key: "Failed", color: admissionFailureChart.colors?.Failed
              ?? "var(--infra-data-4)" }]} />
        </DataComponent>
      </SortableItem>}

      {visible("available-trend") && <SortableItem id="available-trend" label="Available capacity"
        kind="chart" className="micro-line-item">
        <DataComponent variant="card" id="available-trend" queryId="capacity" kind="chart"
          chart={availableTrendChart} title="Available"
          description="Accelerator slots available after demand and unavailable hosts."
          displayRows={availableTrendRows} sourceRows={capacitySource} className="micro-line-card">
          <MicroLineChart rows={availableTrendRows} dataKey="Available" ariaLabel="Available accelerator slots"
            color={availableTrendChart.colors?.Available ?? "var(--infra-data-5)"} />
        </DataComponent>
      </SortableItem>}

      {visible("utilization-trend") && <SortableItem id="utilization-trend" label="Fleet utilization"
        kind="chart" className="micro-line-item">
        <DataComponent variant="card" id="utilization-trend" queryId="capacity" kind="chart"
          chart={utilizationTrendChart} title="Utilization"
          description="Share of usable accelerator capacity serving active demand."
          displayRows={utilizationTrendRows} sourceRows={capacitySource} className="micro-line-card">
          <MicroLineChart rows={utilizationTrendRows} dataKey="Utilization"
            valueFormatter={(value) => percentage(value).replace("+", "")} ariaLabel="Fleet utilization"
            color={utilizationTrendChart.colors?.Utilization ?? "var(--infra-data-6)"} />
        </DataComponent>
      </SortableItem>}

      {visible("unavailable-trend") && <SortableItem id="unavailable-trend" label="Unavailable capacity"
        kind="chart" className="micro-line-item">
        <DataComponent variant="card" id="unavailable-trend" queryId="capacity" kind="chart"
          chart={unavailableTrendChart} title="Offline"
          description="Accelerator slots unavailable because of host health or maintenance."
          displayRows={unavailableTrendRows} sourceRows={capacitySource} className="micro-line-card">
          <MicroLineChart rows={unavailableTrendRows} dataKey="Unavailable" ariaLabel="Unavailable accelerator slots"
            color={unavailableTrendChart.colors?.Unavailable ?? "var(--infra-data-7)"} />
        </DataComponent>
      </SortableItem>}

      {visible("queue-depth-trend") && <SortableItem id="queue-depth-trend" label="Queue depth"
        kind="chart" className="micro-line-item">
        <DataComponent variant="card" id="queue-depth-trend" queryId="queues" kind="chart"
          chart={queueDepthTrendChart} title="Queued"
          description="Inference workloads waiting for accelerator placement."
          displayRows={queueDepthTrendRows} sourceRows={queueSource} className="micro-line-card">
          <MicroLineChart rows={queueDepthTrendRows} dataKey="Queued" ariaLabel="Queued inference workloads"
            color={queueDepthTrendChart.colors?.Queued ?? "var(--infra-data-strong)"} />
        </DataComponent>
      </SortableItem>}

      {visible("regional-concentration") && <SortableItem id="regional-concentration"
        label="Regional concentration" kind="custom" className="stacked-signals-item">
        <DataComponent variant="card" padding="spacious" id="regional-concentration" queryId="concentration"
          kind="custom" title="Regional concentration"
          description="How unevenly utilization, queued work, and failed admissions are distributed across regions."
          displayRows={regionalConcentrationRows} sourceRows={concentrationSource}
          className="stacked-signals-card">
          <StackedSignalChart rows={regionalConcentrationRows}
            ariaLabel="Regional concentration trends for utilization, queued work, and failed admissions"
            signals={[
              { key: "utilizationSpread", label: "Utilization spread", color: "var(--infra-data-2)",
                detailKey: "utilizationLeader", formatter: (value) => `${(value * 100).toFixed(1)} pp` },
              { key: "queueShare", label: "Top queue share", color: "var(--infra-data-4)",
                detailKey: "queueLeader", formatter: (value) => percentage(value).replace("+", "") },
              { key: "failureShare", label: "Top failure share", color: "var(--infra-data-7)",
                detailKey: "failureLeader", formatter: (value) => percentage(value).replace("+", "") },
            ]} />
        </DataComponent>
      </SortableItem>}

      {visible("regional-pressure") && <SortableItem id="regional-pressure" label="Regional pressure"
        kind="chart" className="regional-pressure-item">
        <DataComponent variant="card" padding="spacious" id="regional-pressure" queryId="capacity" kind="chart"
          chart={pressureChart} title="Regional pressure"
          description="Twelve-hour serving-utilization trend for the three regions under the most pressure."
          displayRows={regionalPressureRows} sourceRows={capacitySource}
          className="compact-line-card regional-pressure-card">
          <RegionalPressureChart rows={regionalPressureRows} regions={pressureRegionNames}
            colors={pressureChart.colors ?? pressureSpec.colors} />
        </DataComponent>
      </SortableItem>}

      {progressMetrics.map((metric) => {
        const rows = [{ ...metric.displayRows[0], metric: metric.title, progress: metric.value, goal: 1, detail: metric.detail }];
        const spec = chartOverrides[metric.id] ?? barChartSpec({ presentation: "progress", category: "metric", value: "progress",
          track: { max: "goal" }, detailField: "detail", labels: { position: "summary", value: "formatted" },
          format: { style: "percent", maximumFractionDigits: 1 },
          interaction: { tooltip: false },
          style: { segments: 10, thickness: 7, color: metric.color } });
        return visible(metric.id) && <SortableItem key={metric.id} id={metric.id}
          label={metric.title} kind="chart" className="segmented-progress-item">
          <DataComponent variant="card" id={metric.id} queryId={metric.queryId} kind="chart" chart={spec}
            title={metric.title} description={metric.description} displayRows={rows}
            sourceRows={metric.sourceRows} className="segmented-progress-card">
            <Chart className="segmented-progress-visual" rows={rows} spec={spec} {...chartProps(metric.id)} />
          </DataComponent>
        </SortableItem>;
      })}

    </SortableRegion>

    {visible("regional-pool-saturation") && <section className="regional-pool-saturation-section">
      <DataComponent variant="card" padding="spacious" id="regional-pool-saturation" queryId="capacity"
        kind="chart" chart={regionalPoolLoadChart} title="Regional pool load"
        description="Active GPU-equivalent demand by region and accelerator pool across the rollout window."
        displayRows={regionalPoolLoadRows} sourceRows={capacitySource}
        className="regional-pool-saturation-card">
        <p className="regional-pool-saturation-subtitle" id="regional-pool-load-context" aria-live="polite">
          30-minute intervals · {poolLoadScopeLabel} · {visiblePoolLoadSeries.length} series · UTC
        </p>
        <div className="regional-pool-load-layout">
          <div className="pool-load-chart-stage" id="regional-pool-load-plot" role="group"
            aria-label="Regional pool load chart" aria-describedby="regional-pool-load-context">
            <Chart spec={regionalPoolLoadDisplayChart} rows={regionalPoolLoadRows} height={300}
              {...regionalPoolLoadChartProps} visibleSeries={visiblePoolLoadSeries} />
          </div>
          <aside className="pool-load-series-panel" aria-label="Filter regional pool series">
            <div className="pool-load-series-groups">
              {poolLoadRegions.map(({ name: region, color }) => {
                const regionSeries = poolLoadPools.map(({ name: pool }) => `${region} · ${pool}`)
                  .filter((series) => availablePoolLoadSeries.has(series));
                const regionFocused = region === focusedPoolLoadRegion;
                const regionContainsSolo = focusedPoolLoadSeries?.startsWith(`${region} · `) ?? false;
                const regionMuted = poolLoadHasFocus && !regionFocused && !regionContainsSolo;

                return <section className="pool-load-series-group" key={region}
                  data-muted={regionMuted || undefined} data-context={regionContainsSolo || undefined}
                  data-focused={regionFocused || undefined}>
                  <button className="pool-load-series-header" type="button"
                    aria-label={regionFocused ? `Clear ${region} focus` : `Focus ${region}`}
                    aria-pressed={regionFocused} aria-controls="regional-pool-load-plot"
                    disabled={regionSeries.length === 0}
                    onClick={() => updateVisiblePoolLoadSeries(regionFocused ? allPoolLoadSeries : regionSeries)}>
                    <span className="pool-load-group-swatch" style={{ "--pool-load-group-color": color }}
                      aria-hidden="true" />
                    <span>{region}</span>
                    {regionFocused && <Icon name="cross" size={14} className="pool-load-clear-icon" />}
                  </button>
                  <div className="pool-load-series-options">
                    {poolLoadPools.map(({ name: pool }) => {
                      const series = `${region} · ${pool}`;
                      const seriesAvailable = availablePoolLoadSeries.has(series);
                      const seriesSoloed = focusedPoolLoadSeries === series;
                      const seriesMuted = poolLoadHasFocus && !visiblePoolLoadSeriesSet.has(series);

                      return <button className="pool-load-series-option" type="button" key={series}
                        aria-label={seriesSoloed ? `Clear ${series} focus` : `Focus ${series}`}
                        aria-pressed={seriesSoloed} aria-controls="regional-pool-load-plot"
                        data-muted={seriesMuted || undefined} disabled={!seriesAvailable}
                        onClick={() => updateVisiblePoolLoadSeries(seriesSoloed ? allPoolLoadSeries : [series])}>
                        <span className="pool-load-series-mark"
                          style={{ "--pool-load-series-color": poolLoadColors[series] }} aria-hidden="true" />
                        <span>{pool}</span>
                        {seriesSoloed && <Icon name="cross" size={14} className="pool-load-clear-icon" />}
                      </button>;
                    })}
                  </div>
                </section>;
              })}
            </div>
          </aside>
        </div>
      </DataComponent>
    </section>}
    {visible("capacity-incidents") && <DataComponent variant="card" id="capacity-incidents" queryId="incidents" kind="table"
      title="Incident response" description="Incident status at the snapshot cutoff. Select an incident to scope all capacity, queue and admission charts to its environment, region and pool."
      sourceRows={incidentSource} displayRows={incidentSource}>
      <DataTable rows={incidentSource} columns={[{key:"incident",label:"Incident"},{key:"region",label:"Region"},
        {key:"pool",label:"Pool"},{key:"service",label:"Service"},{key:"status",label:"Status",presentation:"status"},{key:"nextAction",label:"Next step"}]}
        rowKey="incident" rowActionLabel={row => `Inspect ${row.region} ${row.pool}`} onRowSelect={row => {
          setFilter("environment",row.environment); setFilter("region",row.region); setFilter("pool",row.pool);
          document.getElementById("infrastructure-capacity-title")?.scrollIntoView({block:"start",behavior:"smooth"});
        }} />
    </DataComponent>}
  </article>;
}
