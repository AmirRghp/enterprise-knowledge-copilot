import { invoiceSummary, filterInvoices, invoiceStatuses } from "./invoices.js";
import { compareOperatingCosts } from "./costs.js";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  Chart,
  ChartMark,
  ChartTooltip,
  Dropdown,
  DataComponent,
  DataTable,
  MetricSparkline,
  SegmentedControl,
  SectionHeader,
  percentage,
  useDataApp,
  useDashboardTabs,
} from "../../data-app-public.jsx";
import "./example.css";

const currency = (value, compact = false) => new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  notation: compact ? "compact" : "standard",
  maximumFractionDigits: compact ? 1 : 0,
}).format(value);

const financialSpec = {
  currency: "USD",
  valueDecimals: 0,
  type: "line",
  x: "week",
  y: "revenue",
  fields: ["revenue", "operatingCost", "operatingProfit"],
  colors: {
    revenue: "var(--chart-1)",
    operatingCost: "var(--chart-5)",
    operatingProfit: "var(--chart-3)",
  },
  lineGradients: {
    revenue: ["#0057ff", "#61c7ff"],
    operatingCost: ["#dd2670", "#ff9fd0"],
    operatingProfit: ["#00963d", "#8ce4a8"],
  },
  showXAxisLabel: false,
  showYAxisLabel: false,
};

const deliveryProgressSpec = {
  type: "line",
  x: "hour",
  y: "completed",
  fields: ["planned", "completed", "riskPoint"],
  colors: {
    planned: "var(--secondary)",
    completed: "var(--chart-1)",
    riskPoint: "var(--negative)",
  },
  showXAxisLabel: false,
  showYAxisLabel: false,
};

const costSpec = {
  type: "rankedList",
  x: "category",
  y: "amount",
  sortOrder: "descending",
  initialVisibleCount: 6,
};

const regionalVolumeSpec = {
  type: "bar",
  x: "week",
  y: "Northeast",
  fields: ["Northeast", "Central", "West"],
  colors: {
    Northeast: "oklch(48% 0.14 145)",
    Central: "oklch(65% 0.14 145)",
    West: "oklch(80% 0.1 145)",
  },
  showLegend: true,
  startAtZero: true,
  markRadius: 5,
  markStartRadius: 1,
  showXAxisLabel: false,
  showYAxisLabel: false,
};

const deliveryCostSpec = {
  currency: "USD",
  valueDecimals: 2,
  type: "line",
  x: "week",
  y: "costPerDelivery",
  fields: ["costPerDelivery", "target"],
  legend: { labels: { costPerDelivery: "Cost per delivery", target: "Cost ceiling" } },
  colors: {
    costPerDelivery: "var(--chart-1)",
    target: "color-mix(in srgb, var(--secondary) 70%, transparent)",
  },
  format: "currency",
  showLegend: true,
  showXAxisLabel: false,
  showYAxisLabel: false,
};

const invoiceColumns = [
  { field: "customer", label: "Company", presentation: "identity", secondaryField: "region" },
  { field: "dueDate", label: "Due date" },
  { field: "contact", label: "Contact" },
  { field: "status", label: "Status" },
  { field: "amount", label: "Value" },
];

const spacingPairs = [
  { scope: ".deliveries-column", from: "> .data-section-header .data-section-title", to: "> .delivery-metrics .component-header" },
  { scope: ".delivery-metric", from: ".component-header", to: ".delivery-metric-primary" },
  { scope: ".fleet-trend-card", from: "> .component-header", to: ".gradient-financial-chart" },
  { scope: ".cash-card", from: "> .component-header", to: ".cash-summary" },
  { scope: ".cash-card", from: ".cash-summary", to: ".cash-bars" },
  { scope: ".cash-card", from: ".cash-bars", to: ".cash-footnote" },
  { scope: ".cost-card", from: "> .component-header", to: ".cost-insight" },
  { scope: ".cost-card", from: ".cost-insight", to: ".cost-comparison-list" },
  { scope: ".delivery-additional-grid > .dashboard-component", from: "> .component-header", to: ".chart-frame" },
  { scope: ".delivery-cost-card", from: "> .component-header", to: ".delivery-cost-summary" },
  { scope: ".delivery-cost-card", from: ".delivery-cost-summary", to: ".delivery-cost-trend" },
  { scope: ".invoice-card", from: "> .component-header", to: ".receivables-summary" },
  { scope: ".receivable-stat", from: ".fleet-eyebrow", to: "strong" },
  { scope: ".receivable-stat", from: "strong", to: "> span:last-child" },
  { scope: ".invoice-card", from: ".receivables-summary", to: ".receivables-track" },
  { scope: ".invoice-card", from: ".receivables-track", to: ".invoice-controls-row" },
  { scope: ".invoice-card", from: ".invoice-controls-row", to: ".table-wrap" },
];

function queryWithin(scope, selector) {
  if (!scope || !selector) return null;
  if (selector.startsWith("> ")) return scope.querySelector(`:scope ${selector}`);
  return scope.querySelector(selector);
}

function VerticalSpacingOverlay() {
  const [bands, setBands] = useState([]);

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const next = [];
      spacingPairs.forEach((pair, pairIndex) => {
        document.querySelectorAll(pair.scope).forEach((scope, scopeIndex) => {
          const from = queryWithin(scope, pair.from);
          const to = queryWithin(scope, pair.to);
          if (!from || !to) return;
          const fromRect = from.getBoundingClientRect();
          const toRect = to.getBoundingClientRect();
          const gap = Math.round(toRect.top - fromRect.bottom);
          const left = Math.max(0, Math.max(fromRect.left, toRect.left));
          const right = Math.min(window.innerWidth, Math.min(fromRect.right, toRect.right));
          const top = Math.max(0, fromRect.bottom);
          const bottom = Math.min(window.innerHeight, toRect.top);
          if (gap < 2 || right - left < 40 || bottom - top < 1) return;
          next.push({
            id: `${pairIndex}-${scopeIndex}`,
            gap,
            left,
            top,
            width: right - left,
            height: bottom - top,
          });
        });
      });
      setBands(next);
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    const page = document.querySelector(".fleet-operations-page");
    if (page) resizeObserver.observe(page);
    document.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  return <div className="fleet-spacing-overlay" aria-hidden="true">
    {bands.map((band) => <div key={band.id} className="fleet-spacing-band" style={{
      left: band.left,
      top: band.top,
      width: band.width,
      height: band.height,
    }}>
      <span>{band.gap}px</span>
    </div>)}
    <div className="fleet-spacing-legend">Vertical spacing</div>
  </div>;
}

function GradientFinancialChart({ spec, rows, ...props }) {
  return <div className="gradient-financial-chart"><Chart spec={spec} rows={rows} {...props} /></div>;
}

function DeliveryProgressTooltip({ active, payload }) {
  const row = payload?.find((item) => item?.payload)?.payload;
  if (!active || !row) return null;
  return <div className="chart-tooltip chart-tooltip--plain delivery-progress-tooltip">
    <strong>{row.hour}</strong>
    <span>Planned<b>{row.planned}</b></span>
    {row.completed != null && <span>Completed<b>{row.completed}</b></span>}
    {row.atRisk != null && <span data-tone="negative">At risk<b>{row.atRisk}</b></span>}
  </div>;
}

function DeliveryProgressChart({ rows }) {
  const ordered = [...rows].sort((left, right) => left.hourIndex - right.hourIndex);
  const maximum = Math.max(1, ...ordered.map((row) => row.planned));
  const upperBound = Math.ceil(maximum / 20) * 20;
  return <div className="delivery-progress-chart" role="img"
    aria-label="Cumulative planned and completed deliveries by hour, with at-risk check-ins">
    <ResponsiveContainer width="100%" height={320}>
      <ComposedChart data={ordered} margin={{ top: 20, right: 24, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeWidth={0.5} vertical={false} />
        <XAxis dataKey="hour" axisLine={false} tickLine={false}
          tick={{ fill: "var(--secondary)", fontSize: 12 }} interval={1} />
        <YAxis domain={[0, upperBound]} axisLine={false} tickLine={false} width={44}
          tick={{ fill: "var(--secondary)", fontSize: 12 }} />
        <Tooltip cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
          content={<DeliveryProgressTooltip />} />
        <ReferenceLine x="4 PM" stroke="var(--text)" strokeDasharray="4 4" strokeWidth={1}
          label={{ value: "4 PM snapshot", position: "top", fill: "var(--secondary)", fontSize: 12 }} />
        <Line type="monotone" dataKey="planned" name="Planned" stroke="var(--secondary)"
          strokeWidth={2} strokeDasharray="7 6" dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        <Line type="monotone" dataKey="completed" name="Completed" stroke="var(--chart-1)"
          strokeWidth={3} connectNulls={false} dot={false} activeDot={{ r: 5 }} isAnimationActive={false} />
        <Line type="linear" dataKey="riskPoint" name="At risk" stroke="transparent"
          connectNulls={false} dot={{ r: 5, fill: "var(--negative)", stroke: "var(--surface)", strokeWidth: 2 }}
          activeDot={{ r: 6, fill: "var(--negative)", stroke: "var(--surface)", strokeWidth: 2 }}
          isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
    <div className="delivery-progress-legend" aria-hidden="true">
      <span data-series="planned"><i />Planned</span>
      <span data-series="completed"><i />Completed</span>
      <span data-series="risk"><i />At-risk check-in</span>
    </div>
  </div>;
}

function DeliveryProgressInsight({ rows }) {
  const ordered = [...rows].sort((left, right) => left.hourIndex - right.hourIndex);
  const current = ordered.filter((row) => row.completed != null).at(-1);
  if (!current) return null;
  const difference = current.completed - current.planned;
  return <p className="delivery-progress-insight">{difference === 0 ? "On plan"
    : `${Math.abs(difference)} deliveries ${difference > 0 ? "ahead of" : "behind"} plan`}</p>;
}

function DeliveryCostTrendChart({ spec, rows, ...props }) {
  const ordered = [...rows].sort((left, right) => left.week.localeCompare(right.week));
  const first = ordered.at(0);
  const current = ordered.at(-1);
  const targetDelta = current ? current.target - current.costPerDelivery : 0;
  const periodDelta = first && current ? first.costPerDelivery - current.costPerDelivery : 0;

  return <div className="delivery-cost-trend">
    <div className="delivery-cost-summary">
      <div><strong>{current ? currency(current.costPerDelivery) : "—"}</strong><span>Cost / completed delivery</span></div>
      <div><strong>{current ? currency(current.target) : "—"}</strong><span>Cost ceiling · lower is better</span></div>
      <p><span data-tone={targetDelta >= 0 ? "positive" : "negative"}>{current ? `${currency(Math.abs(targetDelta))} ${targetDelta >= 0 ? "under" : "over"} the cost ceiling` : "No cost observations"}</span>
        {ordered.length > 1 && <span data-tone={periodDelta === 0 ? "neutral" : periodDelta > 0 ? "positive" : "negative"}>{currency(Math.abs(periodDelta))} {periodDelta > 0 ? "lower" : periodDelta < 0 ? "higher" : "change"} since {new Date(first.week + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span>}</p>
    </div>
    <Chart spec={spec} rows={ordered} {...props} />
  </div>;
}

function InvoiceTable({ rows }) {
  const [page, setPage] = useState(0);
  const pageSize = 16;
  const filtered = rows;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  useEffect(() => setPage(0), [rows]);

  return <>
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          {invoiceColumns.map((column) => <th key={column.field}
            className={column.field === "amount" ? "numeric" : undefined}>{column.label}</th>)}
        </tr></thead>
        <tbody>{pageRows.map((row) => <tr key={row.invoiceId}>
          <td><span className="table-identity"><strong>{row.customer}</strong><span>{row.region}</span></span></td>
          <td title={row.dueDate}>{new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(`${row.dueDate}T00:00:00Z`))}</td>
          <td>{row.contact}</td>
          <td><span className="table-status" data-status={row.status === "Paid" ? "positive" : row.status === "Overdue" ? "negative" : row.status === "Due soon" ? "warning" : "neutral"}>
            {row.status === "Outstanding" ? "Unpaid" : row.status}
          </span></td>
          <td className="numeric">{row.amount}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {pages > 1 && <div className="toolbar table-pagination">
      <span className="source-value">Page {currentPage + 1} of {pages}</span>
      <div className="actions">
        <button type="button" className="table-page-button" aria-label="Previous page"
          disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>‹</button>
        <button type="button" className="table-page-button" aria-label="Next page"
          disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>›</button>
      </div>
    </div>}
  </>;
}

function DeliveryMetric({ id, title, description, value, comparison, detail, negative, tone, trendValues, sourceRows, scopeFilters }) {
  const delta = typeof comparison === "string" ? comparison.split(/\s+vs\.?\s+/iu)[0] : comparison;
  return <DataComponent variant="plain" id={id} queryId="daily_deliveries" kind="metric"
    title={title} description={description} sourceRows={sourceRows} displayRows={sourceRows} scopeFilters={scopeFilters}
    className={`delivery-metric${tone ? ` delivery-metric--${tone}` : ""}`}>
    <div className="delivery-metric-primary">
      <strong>{value}</strong>
      {delta && <span className="delivery-metric-change">
        <MetricSparkline values={trendValues} negative={negative} />
        <span data-negative={negative || undefined}>{delta}</span>
      </span>}
    </div>
    {detail && <span className="delivery-metric-note">{detail}</span>}
  </DataComponent>;
}

function CashPosition({ rows }) {
  const [activeBar, setActiveBar] = useState(null);
  const ordered = [...rows].sort((left, right) => left.week.localeCompare(right.week));
  const current = ordered.at(-1);
  const maximum = Math.max(...ordered.map((row) => row.balance), current?.reserveTarget ?? 1) * 1.06;
  const aboveTarget = (current?.balance ?? 0) - (current?.reserveTarget ?? 0);
  const activeRow = activeBar == null ? null : ordered[activeBar];
  const activeHeight = activeRow ? Math.max(12, activeRow.balance / maximum * 100) : 0;
  const activeDate = activeRow ? new Intl.DateTimeFormat(undefined,
    { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${activeRow.week}T00:00:00Z`)) : "";

  return <DataComponent variant="plain" id="cash-position" queryId="cash_balance" kind="custom"
    title="Balance and costs" description="Available cash compared with the operating reserve target."
    displayRows={ordered} sourceRows={ordered} className="cash-card">
    <div className="cash-summary">
      <div>
        <strong>{current ? currency(current.balance, true) : "—"}</strong>
      </div>
      <span className="cash-target">Target {current ? currency(current.reserveTarget, true) : "—"}</span>
    </div>
    <div className="cash-bars" aria-label="Weekly cash balance" onMouseLeave={() => setActiveBar(null)}>
      {ordered.map((row, index) => {
        const baseShare = row.balance ? Math.min(row.balance, row.reserveTarget) / row.balance * 100 : 0;
        return <button type="button" key={row.week} className="cash-bar"
          aria-label={`${row.week}: ${currency(row.balance)}`}
          onMouseEnter={() => setActiveBar(index)} onFocus={() => setActiveBar(index)} onBlur={() => setActiveBar(null)}
          style={{
            "--cash-height": `${Math.max(12, row.balance / maximum * 100)}%`,
            "--cash-base-share": `${baseShare}%`,
          }}>
          <span className="cash-bar-overflow" aria-hidden="true" />
          <span className="cash-bar-base" aria-hidden="true" />
        </button>;
      })}
      <span className="cash-target-line" aria-hidden="true"
        style={{ "--target-position": `${current?.reserveTarget / maximum * 100}%` }} />
      {activeRow && <div className="cash-chart-tooltip chart-tooltip chart-tooltip--plain" role="status"
        data-edge={activeBar === 0 ? "start" : activeBar === ordered.length - 1 ? "end" : undefined}
        style={{ left: `${(activeBar + .5) / ordered.length * 100}%`, bottom: `calc(${activeHeight}% + 8px)` }}>
        <strong>{activeDate}</strong>
        <span>Cash balance<b>{currency(activeRow.balance)}</b></span>
        <span>Reserve target<b>{currency(activeRow.reserveTarget)}</b></span>
      </div>}
    </div>
    <p className="cash-footnote" data-tone={aboveTarget >= 0 ? "positive" : "negative"}>
      {aboveTarget >= 0 ? `${currency(aboveTarget, true)} above reserve` : `${currency(Math.abs(aboveTarget), true)} below reserve`}
    </p>
  </DataComponent>;
}

function CostBreakdown({ comparison }) {
  const { rows: currentRows, highlight, baselineWeeks, sourceRows } = comparison;
  const maximum = Math.max(1, ...currentRows.map((row) => row.amount));

  return <DataComponent variant="plain" id="cost-breakdown"
    queryId="route_daily" kind="chart" chart={costSpec} title="Costs by category"
    description={`Latest selected week. Baseline uses cost per scheduled delivery from ${baselineWeeks.length} preceding observed weeks, adjusted to current scheduled volume. It is not a budget or a causal explanation.`}
    displayRows={currentRows} sourceRows={sourceRows} className="cost-card">
    {highlight && <p className="cost-insight" data-tone={highlight.variance < 0 ? "saving" : "increase"}>
      {highlight.category} is <strong>{percentage(Math.abs(highlight.rateChange)).replace("+", "")} {highlight.variance < 0 ? "below" : "above"} its volume-adjusted baseline</strong>
    </p>}
    <ul className="cost-comparison-list" aria-label="Current weekly costs by category" data-chart-interaction-root>
      {currentRows.map((row) => {
        const highlightedCost = row.category === highlight?.category;
        const tone = row.variance < 0 ? "saving" : "increase";
        return <li key={row.category} className="cost-comparison-row"
          data-tone={highlightedCost ? tone : "muted"}>
          <ChartMark className="cost-comparison-mark" aria-label={`${row.category}: ${currency(row.amount)}`}
            context={{ kind: "chart", label: row.category, row }}
            tooltip={<ChartTooltip active label={row.category} details={[
              { label: "This week", value: currency(row.amount) },
              { label: "Volume-adjusted baseline", value: row.expected == null ? "Unavailable" : currency(row.expected) },
              ...(row.variance == null ? [] : [{ label: row.variance < 0 ? "Below baseline" : "Above baseline", value: currency(Math.abs(row.variance)) }]),
            ]} />}>
          <span className="cost-comparison-bar">
            <span className="cost-comparison-fill" aria-hidden="true"
              data-tone={highlightedCost ? tone : "neutral"}
              style={{ width: `${row.amount / maximum * 100}%` }}>
              {highlightedCost && <span className="cost-comparison-name-inverted">{row.category}</span>}
            </span>
            <span className="cost-comparison-name">{row.category}</span>
          </span>
          <strong>{currency(row.amount, true)}</strong>
          </ChartMark>
        </li>;
      })}
    </ul>
  </DataComponent>;
}

function InvoiceWorkspace({ rows, status, setStatus, search, setSearch }) {
  const displayed = filterInvoices(rows, status, search, currency);
  const { paid, dueSoon, unpaid, billed } = invoiceSummary(rows);
  const summary = [
    { label: "Paid", value: paid, tone: "paid" },
    { label: "Due soon", value: dueSoon, tone: "due" },
    { label: "Unpaid", value: unpaid, tone: "unpaid" },
  ];
  const tableRows = displayed.map((row) => ({ ...row, amount: currency(row.amount) }));

  return <DataComponent variant="plain" id="invoice-workspace" queryId="invoice_ledger"
    kind="table" title="Cash collection" description="Invoice balances as of the fixture cutoff, scoped by issue week and region. Status and search narrow only the table; the summary uses all scoped invoices, not recognized revenue."
    displayRows={displayed} sourceRows={rows}
    scopeFilters={[...(status === "All" ? [] : [{ field: "status", label: "Table status", value: status }]), ...(search ? [{ field: "search", label: "Table search", value: search }] : [])]}
    className="invoice-card">
    <div className="receivables-summary">
      {summary.map((item) => <div key={item.label} className="receivable-stat" data-tone={item.tone}>
        <span className="fleet-eyebrow">{item.label}</span>
        <strong>{currency(item.value, true)}</strong>
        <span>{billed ? percentage(item.value / billed).replace("+", "") : "—"}</span>
      </div>)}
    </div>
    <div className="receivables-track" aria-label="Share of total invoice value">
      {summary.map((item) => <span key={item.label} data-tone={item.tone}
        style={{ width: `${billed ? item.value / billed * 100 : 0}%` }} />)}
    </div>
    <div className="invoice-controls-row">
      <SegmentedControl className="invoice-tabs" ariaLabel="Invoice status"
        value={status} options={invoiceStatuses} onChange={setStatus} />
      <div className="invoice-search-group">
        <label className="search-field">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.75" />
            <path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
          </svg>
          <input className="search" aria-label="Search data" placeholder="Search data" value={search}
            onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>
    </div>
    <InvoiceTable rows={tableRows} />
  </DataComponent>;
}

export function DashboardContent() {
  useDashboardTabs([{ id: "dashboard", label: "Dashboard" }]);
  const [selectedDay, setSelectedDay] = useState(null);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [invoiceStatus, setInvoiceStatus] = useState("All");
  const invoiceRef = useRef(null);
  const showSpacingOverlay = new URLSearchParams(window.location.search).get("debugSpacing") === "1";
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

  useEffect(() => {
    if (dashboard.status === "fixture" && ["SMB: Delivery company", "Delivery company", "Fleet operations"].includes(appTitle)) setAppTitle(dashboard.title);
  }, [dashboard.title, dashboard.status, appTitle, setAppTitle]);

  const operationHistory = reviewedRows("operations", ["week"]);
  const dailySource = reviewedRows("daily_deliveries", ["week","date"]);
  const days = [...new Set(dailySource.map(row => row.date))].sort();
  const day = days.includes(selectedDay) ? selectedDay : days.at(-1);
  const dailyRows = dailySource.filter(row => row.date === day);
  const daily = dailyRows[0];
  const dayScope = day ? [{field:"date",label:"Day",value:day}] : [];
  const progressRows = reviewedRows("daily_delivery_progress", ["week","date","hourIndex"]).filter(row => row.date === day);
  const financialRows = reviewedRows("financials", ["week"]);
  const cashRows = reviewedRows("cash_balance", ["week"]);
  const costComparison = compareOperatingCosts(queries.route_daily.rows, operationHistory.map(row => row.week).sort().at(-1), filters.region ?? "all");
  const invoiceRows = reviewedRows("invoice_ledger", ["week"]);
  const routes = reviewedRows("route_daily", ["week", "date", "routeId"]).filter(row => row.date === day);
  const exceptions = routes.filter(row => row.atRisk > 0).sort((a, b) => b.atRisk - a.atRisk);
  const financialChart = chartOverrides["financial-trend"] ?? financialSpec;
  const weeks = [...new Set(queries.operations.rows.map(row => row.week))].sort();
  const dateOptions = [
    {label:"Latest week",value:weeks.at(-1)+".."+weeks.at(-1)},
    ...(weeks.length >= 4 ? [{label:"4 weeks",value:weeks.at(-4)+".."+weeks.at(-1)}] : []),
    {label:"All weeks",value:"all"},
  ];
  const regionOptions = ["all", ...new Set(queries.operations.rows
    .map((row) => row.region).filter((region) => region && region !== "all"))];
  const activeRegion = filters.region ?? "all";
  const regionalOperations = reviewedRows("operations", ["week","region"]);
  const visibleRegions = activeRegion === "all"
    ? regionOptions.filter((region) => region !== "all")
    : [activeRegion];
  const regionalWeeks = [...new Set(regionalOperations.map((row) => row.week))].sort();
  const regionalVolumeRows = regionalWeeks
    .map((week) => ({
      week,
      ...Object.fromEntries(visibleRegions.map((region) => [region,
        regionalOperations.find((row) => row.week === week && row.region === region)?.deliveries ?? 0])),
    }));
  const regionalVolumeChart = {
    ...regionalVolumeSpec,
    ...(chartOverrides["regional-delivery-volume"] ?? {}),
    y: visibleRegions[0],
    fields: visibleRegions,
  };
  const costHistory = operationHistory;
  const deliveryCostRows = costHistory.map((row) => ({ ...row, target: 88 }));
  const deliveryCostChart = chartOverrides["fleet-efficiency"] ?? deliveryCostSpec;

  const scheduledToday = daily?.scheduled ?? 0;
  const completedToday = daily?.completed ?? 0;
  const remainingToday = Math.max(0,scheduledToday-completedToday);
  const atRiskToday = daily?.atRisk ?? 0;
  const routeCount = daily?.routes ?? 0;
  const metrics = [
    {
      id: "fleet-utilization",
      title: "Scheduled",
      description: "Customer deliveries scheduled for the selected day.",
      value: daily ? new Intl.NumberFormat().format(scheduledToday) : "—",
      detail: daily ? `${routeCount} routes` : "No schedule",
    },
    {
      id: "on-time-rate",
      title: "Completed",
      description: "Deliveries completed at the daily snapshot time.",
      value: daily ? new Intl.NumberFormat().format(completedToday) : "—",
      detail: scheduledToday ? `${Math.round(completedToday / scheduledToday * 100)}% of schedule` : "No schedule",
      tone: "positive",
    },
    {
      id: "completed-deliveries",
      title: "At risk",
      description: "Deliveries likely to miss the promised window.",
      value: daily ? new Intl.NumberFormat().format(atRiskToday) : "—",
      detail: atRiskToday ? "Needs attention" : "All on track",
      tone: "negative",
    },
    {
      id: "remaining-deliveries",
      title: "Remaining",
      description: "Scheduled deliveries still to complete at the daily snapshot time.",
      value: daily ? new Intl.NumberFormat().format(remainingToday) : "—",
      detail: remainingToday ? `Est. finish ${daily?.estimatedFinish ?? "—"}` : "Schedule complete",
    },
  ];

  return <article className="page fleet-operations-page" data-dashboard-layout="viewport">
    <section className="filters filter-bar fleet-filter-bar" aria-label="Dashboard filters">
      <SegmentedControl ariaLabel="Region" value={activeRegion}
        options={regionOptions.map((region) => ({
          value: region,
          label: region === "all" ? "All" : region,
        }))} onChange={(region) => setFilter("region", region)} />
      <SegmentedControl className="fleet-date-filter" ariaLabel="Date range"
        value={filters.week ?? dashboard.filters?.find(filter => filter.id === "week")?.defaultValue} options={dateOptions.map((option) => ({
          value: option.value,
          label: option.label,
        }))} onChange={value => setFilter("week",value)} />
    </section>

    <div className="fleet-dashboard-columns">
      <section className="deliveries-column" aria-labelledby="deliveries-title">
        <SectionHeader id="deliveries-title" title="Deliveries" filters={<Dropdown label="Day" showLabel value={day ?? "all"}
          choices={days} formatChoice={value => new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}).format(new Date(value))}
          onChange={setSelectedDay} />} />

        <div className="delivery-metrics">
          {metrics.filter(({ id }) => id === "remaining-deliveries" || visible(id)).map(({
            id, title, description, value, comparison, detail, negative, tone, trendValues,
          }) => <DeliveryMetric key={id} id={id} title={title} description={description}
            sourceRows={dailyRows} scopeFilters={dayScope} value={value}
            comparison={comparison} detail={detail} negative={negative} tone={tone} trendValues={trendValues} />)}
        </div>

        {visible("delivery-progress") && <DataComponent variant="plain"
          id="delivery-progress" queryId="daily_delivery_progress" kind="chart" chart={deliveryProgressSpec}
          title="Delivery progress" description="Illustrative intraday progress through the 4 PM snapshot. Planned and completed curves are modeled, not scan-level observations."
          displayRows={progressRows} sourceRows={progressRows} scopeFilters={dayScope} className="fleet-trend-card delivery-progress-card">
          <DeliveryProgressInsight rows={progressRows} />
          <DeliveryProgressChart rows={progressRows} />
        </DataComponent>}

        {visible("route-exceptions") && <DataComponent variant="plain" id="route-exceptions" queryId="route_daily" kind="table"
          title="Routes needing attention" description="At-risk deliveries at 4 PM. Select a route to inspect invoices for that customer in the current reporting period."
          sourceRows={routes} displayRows={exceptions} scopeFilters={dayScope} className="fleet-route-exceptions">
          <DataTable rows={exceptions} columns={[{key:"routeId",label:"Route"},{key:"customer",label:"Customer"},
            {key:"atRisk",label:"At risk"},{key:"issue",label:"Issue"},{key:"nextAction",label:"Next step"}]}
            rowKey="routeId" rowActionLabel={row => `View invoices for ${row.customer}`} onRowSelect={row => {
              setInvoiceSearch(row.customer); setInvoiceStatus("All");
              invoiceRef.current?.scrollIntoView({block:"nearest",behavior:"smooth"});
            }} />
        </DataComponent>}

        <div className="delivery-lower-grid">
          {visible("cash-position") && <CashPosition rows={cashRows} />}

          {visible("cost-breakdown") && <CostBreakdown comparison={costComparison} />}
        </div>

        <div className="delivery-additional-grid">
          <DataComponent variant="plain" id="regional-delivery-volume" queryId="operations" kind="chart"
            chart={regionalVolumeChart} title="Delivery volume by region"
            description="Completed deliveries compared across operating regions."
            displayRows={regionalVolumeRows} sourceRows={regionalOperations} className="fleet-additional-chart regional-volume-chart">
            <Chart spec={regionalVolumeChart} rows={regionalVolumeRows} height={260}
              {...chartProps("regional-delivery-volume")} />
          </DataComponent>

          <DataComponent variant="plain" id="fleet-efficiency" queryId="operations" kind="chart"
            chart={deliveryCostChart} title="Cost per delivery vs target"
            description="Average weekly delivery cost compared with the $88 target."
            displayRows={deliveryCostRows} sourceRows={costHistory} className="fleet-additional-chart delivery-cost-card">
            <DeliveryCostTrendChart spec={deliveryCostChart} rows={deliveryCostRows} height={220}
              {...chartProps("fleet-efficiency")} />
          </DataComponent>
        </div>

        {visible("financial-trend") && <DataComponent variant="plain"
          id="financial-trend" queryId="financials" kind="chart" chart={financialChart}
          title="Weekly revenue and costs" description="Revenue, operating cost, and operating profit by week."
          displayRows={financialRows} sourceRows={financialRows} className="fleet-trend-card financial-history-card">
          <GradientFinancialChart spec={financialChart} rows={financialRows} height={280}
            {...chartProps("financial-trend")} />
        </DataComponent>}

      </section>

      {visible("invoice-workspace") && (
        <div className="invoice-column" ref={invoiceRef}>
          <InvoiceWorkspace rows={invoiceRows} search={invoiceSearch} setSearch={setInvoiceSearch}
            status={invoiceStatus} setStatus={setInvoiceStatus} />
        </div>
      )}
    </div>
    {showSpacingOverlay && <VerticalSpacingOverlay />}
  </article>;
}
