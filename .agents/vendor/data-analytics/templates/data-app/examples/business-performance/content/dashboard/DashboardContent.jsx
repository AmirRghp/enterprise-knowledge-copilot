import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChartRenderer, Icon, Switch, DataComponent, DataTable, Dropdown, Filters, MetricCard, Section, SectionHeader,
  SortableItem, SortableRegion, useDataApp, useDashboardTabs, useSectionFilters } from "../../data-app-public.jsx";
import { usePerformanceModel } from "./use-performance-model.js";
import { CohortTable } from "./CohortTable.jsx";
import { ProductEconomics, RevenueMovers, RetentionByProduct } from "./OverviewVisuals.jsx";
import { captureCohortOrigin, cohortDrillFocus, restoreCohortOrigin, revealCohortCustomers } from "./retention-interaction.js";
import { supportedGrains, periodRange, buildPerformance, change, chartRows, cohortCells, cohortMembers, context, comparedProductRows, dateRangeLabel, deepDiveModel, dimensions, dollars, fieldLabels, humanDate, humanMonth,
  labeledChart, metricEvidence, retentionEvidence, cohortEvidence, migratedTitle, moneyRows, number, percent, queryId, revenueRowsForChart, rosterQueryId, signedPercent } from "./performance-data.js";

export const performanceTabs = [
  { id: "dashboard", label: "Overview", previousLabels: ["Dashboard"], filterIds: ["date", "product", "region", "segment"] },
  { id: "revenue", label: "Revenue & economics", filterIds: ["date", "product", "region", "segment"] },
  { id: "adoption", label: "Adoption", previousLabels: ["Adoption & retention"], filterIds: ["date", "product", "region", "segment"] },
  { id: "retention", label: "Retention", filterIds: ["product", "region", "segment"], focusFields: ["cohort", "age", "entryStart", "entryEnd", "asOf", "status"] },
  { id: "customers", label: "Customers", filterIds: ["date", "product", "region", "segment"], focusFields: ["accountId"] },
];
const labels = { ...fieldLabels, revenueUsd: "Revenue", subscriptionUsd: "Subscription revenue", usageUsd: "Usage revenue",
  grossProfitUsd: "Gross profit", topFiveShare: "Top 5 revenue share", multiProductShare: "Multi-product accounts",
  churnedAccounts: "Churned accounts", activationRate: "Activated within 7 days", costPerThousandRunsUsd: "Cost per 1K runs",
  grossMarginRate: "Gross margin", seatUtilizationRate: "Seat utilization", netRevenueRetention: "Net revenue retention",
  grossRevenueRetention: "Gross revenue retention", paidAccountRetention: "Paid-account retention" };
const fmt = (field, value) => field.endsWith("Usd") ? dollars(value)
  : /Rate$|Retention$|Share$/.test(field) ? percent(value) : number(value);
const column = (field, label = labels[field] ?? field, presentation) => ({ field, label, ...(presentation ? { presentation } : {}) });
const line = (y, fields = [y]) => ({ type: "line", x: "date", y, fields, showXAxisLabel: false, showYAxisLabel: false, stackable: false });
const series = (type, y) => ({ type, x: "plotDate", y, series: "seriesLabel", showXAxisLabel: false, showYAxisLabel: false, startAtZero: false, stackable: false });

function Control({ label, value, choices, onChange, labels }) {
  return <Dropdown label={label} value={value} choices={choices} onChange={onChange}
    formatChoice={choice => labels?.[choice] ?? choice} allLabel={labels?.all ?? "All"} showLabel />;
}
export function DashboardContent({ initialView = {} }) {
  const shell = useDataApp();
  const { snapshot, queries, filters, setFilter, chartProps, chartOverrides, visible, appTitle, setAppTitle } = shell;
  const { activeTabId } = useDashboardTabs(performanceTabs);
  const tab = initialView.tab ?? (performanceTabs.some(item => item.id === activeTabId) ? activeTabId : "dashboard");
  const [tabOptions, setTabOptions] = useState({});
  const visitedTabs = useRef(new Set());
  useEffect(() => {
    if (visitedTabs.current.has(tab)) return;
    visitedTabs.current.add(tab);
    const explicitDate = new URLSearchParams(globalThis.location?.search ?? "").has("f.date");
    const next = snapshot.filters.find(filter => filter.id === "date")?.defaultValue;
    if (snapshot.status === "fixture" && filters.date === "2026-05-18..2026-08-16" && next && !explicitDate) setFilter("date",next);
  }, [tab,snapshot.status]);
  const compare = tabOptions[tab]?.compare ?? initialView.compare ?? true;
  const modelFilters = { ...filters, date: filters.date ?? snapshot.filters.find(filter => filter.id === "date")?.defaultValue ?? "all" };
  const grains = supportedGrains(periodRange(modelFilters.date, queries[queryId].source.coverage));
  const requestedGrain = tabOptions[tab]?.grain ?? initialView.grain ?? (periodRange(modelFilters.date, queries[queryId].source.coverage)?.days <= 45 ? "day" : "week");
  const grain = grains.includes(requestedGrain) ? requestedGrain : grains[0];
  const dimension = tabOptions[tab]?.dimension ?? initialView.dimension ?? "product";
  const setOption = (key, value) => setTabOptions(current => ({ ...current, [tab]: { ...current[tab], [key]: value } }));
  const setCompare = value => setOption("compare", value);
  const setGrain = value => setOption("grain", value);
  const setDimension = value => setOption("dimension", value);
  const accountId = initialView.accountId ?? shell.viewFocus?.accountId ?? "";
  const { result, layoutResult, pending, error, localChanges = [] } = usePerformanceModel(queries, modelFilters, { grain, dimension, accountId });
  const displayModel = result ?? layoutResult;
  useLayoutEffect(() => { shell.setDashboardBusy?.(pending); }, [pending,shell.setDashboardBusy]);
  useLayoutEffect(() => () => shell.setDashboardBusy?.(false), [shell.setDashboardBusy]);
  const comparisonControl = <Switch size="compact" label="Previous period" checked={compare} onChange={setCompare} />;
  const interval = <Control label="Interval" value={grain} choices={grains} onChange={setGrain}
    labels={{ day:"Daily",week:"Weekly",month:"Monthly",quarter:"Quarterly",year:"Yearly" }} />;
  return <>
    <Filters sticky filters={snapshot.filters.filter(filter => performanceTabs.find(item => item.id === tab).filterIds.includes(filter.id))} queries={queries} values={filters} onChange={setFilter}
      ariaLabel={`${performanceTabs.find(item => item.id === tab)?.label} filters`} clearLabel="Reset tab"
      trailingControls={tab === "retention" ? undefined : <>{interval}{comparisonControl}</>} />
    {!displayModel ? error ? <p className="bp-notice" role="alert">This view could not be calculated. Try another date range or reload.</p>
      : <PerformanceSkeleton tab={tab} />
      : <PerformanceBody {...{ initialView, tab, compare, grain, dimension, setDimension, model:displayModel.model, deep:displayModel.deep,
        loadingAll:!result, localChanges, localError:error }} />}
  </>;
}

export function PerformanceSkeleton({ tab }) {
  const structure = tab === "dashboard" ? [["Revenue","metric-trend",6],["Active customers","metric-trend",6],["Gross margin","metric-trend",6],["Net revenue retention","metric-trend",6]]
    : tab === "retention" ? [["Paid-customer retention by cohort","table",12],["Cohort customers","table",12]]
      : tab === "customers" ? [["Account portfolio","table",12],["Revenue","metric",4],["Completed runs","metric",4],["Gross margin","metric",4]]
        : tab === "revenue" ? [["Revenue","metric",3],["Subscription revenue","metric",3],["Usage revenue","metric",3],["Gross profit","metric",3],["Subscription and usage revenue","chart",6],["Gross margin by product","chart",6]]
          : [["Active accounts","metric",3],["Completed runs","metric",3],["Seat utilization","metric",3],["Activated within 7 days","metric",3],["Active accounts by product","chart",6],["Runs per active account","chart",6]];
  return <div className="bp-initial-skeleton" data-loading-tab={tab} aria-busy="true" aria-label="Loading dashboard">
    {["retention","adoption"].includes(tab) && <div className="bp-skeleton-section"><SectionHeader id={`loading-${tab}-heading`} title={tab === "retention" ? "Customer retention" : "Activation & engagement"} /></div>}
    {structure.map(([title,kind,span],index) => { const Card = kind.startsWith("metric") ? MetricCard : DataComponent; return <div key={index} data-loading-span={span} style={{gridColumn:`span ${span}`}}><Card variant="card" id={`loading-${tab}-${index}`} queryId={queryId} title={title}
      loading loadingKind={kind} kind={kind.startsWith("metric") ? "metric" : kind} /></div>; })}
  </div>;
}

export function PerformanceBody({ initialView, tab, compare, grain, dimension, setDimension, model, deep, loadingAll = false, localChanges = [], localError }) {
  const shell = useDataApp();
  const { snapshot, queries, filters, setFilter, chartProps, chartOverrides, visible, appTitle, setAppTitle } = shell;
  const accountScope = useSectionFilters([{ id: "account", field: "account", label: "Account", defaultValue: "all" }],
    { account: queries[rosterQueryId]?.rows.find(row => row.accountId === initialView.accountId)?.account ?? "all" },
    { id: "account-selection" });
  const selectedAccount = model.accounts.find(row => row.accountId === (initialView.accountId ?? shell.viewFocus?.accountId)) ?? model.account;
  const selectAccount = row => {
    if (tab === "customers") {
      shell.setDashboardFocus?.({ accountId: row.accountId });
      requestAnimationFrame(() => document.getElementById("account-detail")?.scrollIntoView({ block: "start" }));
    } else shell.exploreDashboard?.("customers", { filters, focus: { accountId: row.accountId } });
  };
  const exploreProduct = row => shell.exploreDashboard?.("revenue", { filters: { ...filters, product: row.category ?? row.product } });
  const [initialCohortAsOf] = useState(queries[queryId].source.coverage.endDate);
  const cohortWindow = useMemo(() => ({ entryStart: shell.viewFocus?.entryStart ?? "all", entryEnd: shell.viewFocus?.entryEnd ?? "all",
    asOf: shell.viewFocus?.asOf ?? initialCohortAsOf }), [shell.viewFocus?.entryStart, shell.viewFocus?.entryEnd, shell.viewFocus?.asOf, initialCohortAsOf]);
  const setCohortWindow = update => shell.setDashboardFocus?.({ ...shell.viewFocus, ...update(cohortWindow) });
  useEffect(() => {
    if (tab === "retention" && !shell.viewFocus?.asOf) shell.setDashboardFocus?.({ ...shell.viewFocus, ...cohortWindow });
  }, [tab, shell.viewFocus?.asOf, cohortWindow]);
  const cohortContext = useMemo(() => context(queries, filters), [queries, filters.product, filters.region, filters.segment]);
  const cells = useMemo(() => cohortCells(cohortContext, { ...cohortWindow,
    entryStart: cohortWindow.entryStart === "all" ? null : cohortWindow.entryStart,
    entryEnd: cohortWindow.entryEnd === "all" ? null : cohortWindow.entryEnd }), [cohortContext, cohortWindow]);
  const cohort = shell.viewFocus?.cohort ?? cells.find(row => row.mature)?.cohort;
  const age = Number(shell.viewFocus?.age ?? 3);
  const selectedCell = cells.find(row => row.cohort === cohort && row.age === age && row.mature) ?? cells.find(row => row.mature);
  const members = useMemo(() => selectedCell ? cohortMembers(cohortContext, selectedCell.cohort, selectedCell.age, cohortWindow.asOf) : [],
    [cohortContext, selectedCell?.cohort, selectedCell?.age, cohortWindow.asOf]);
  const cohortStatus = shell.viewFocus?.status ?? "all";
  const setCohortStatus = status => shell.setDashboardFocus?.({ ...shell.viewFocus, status });
  const cohortScope = [{ label: "Cohort entry", field: "cohort", value: `${cohortWindow.entryStart} – ${cohortWindow.entryEnd}` },
    { label: "Observation cutoff", field: "asOf", value: cohortWindow.asOf }];
  const [cohortReturn, setCohortReturn] = useState(null);
  const cohortVisit = useRef(0);
  const committedCell = shell.viewFocus?.cohort === selectedCell?.cohort && Number(shell.viewFocus?.age) === selectedCell?.age ? selectedCell : null;
  const selectCell = row => {
    const focus = cohortDrillFocus(shell.viewFocus, row);
    if (!focus) return;
    setCohortReturn({ ...captureCohortOrigin(row), visit: ++cohortVisit.current });
    shell.setDashboardFocus?.(focus);
    requestAnimationFrame(() => revealCohortCustomers());
  };
  const backToCohorts = () => {
    restoreCohortOrigin(cohortReturn);
    setCohortReturn(null);
  };
  useEffect(() => {
    if (tab === "customers" && shell.canReturnFromExploration) requestAnimationFrame(() =>
      document.getElementById("account-detail")?.scrollIntoView({ block: "start" }));
  }, [tab, shell.canReturnFromExploration]);
  useEffect(() => {
    const next = migratedTitle(appTitle, snapshot);
    if (next !== appTitle) setAppTitle(next);
  }, [appTitle, snapshot.title, snapshot.status, setAppTitle]);
  useEffect(() => {
    if (selectedAccount && accountScope.values.account !== selectedAccount.account) accountScope.setFilter("account", selectedAccount.account);
  }, [selectedAccount?.account, accountScope.values.account]);
  const period = { periodStart: model.range?.start, periodEnd: model.range?.end,
    comparisonStart: model.priorRange?.start, comparisonEnd: model.priorRange?.end };
  const evidenceRows = useMemo(() => metricEvidence(queries, filters, model.range, model.priorRange),
    [queries, filters.product, filters.region, filters.segment, period.periodStart, period.periodEnd, period.comparisonStart, period.comparisonEnd]);
  const accountEvidenceRows = useMemo(() => evidenceRows.filter(row => row.accountId === model.account?.accountId),
    [evidenceRows, model.account?.accountId]);
  const currentEvidenceRows = useMemo(() => evidenceRows.filter(row => row.date >= period.periodStart && row.date <= period.periodEnd),
    [evidenceRows, period.periodStart, period.periodEnd]);
  const retentionEvidenceRows = useMemo(() => retentionEvidence(queries, filters, model.retentionTrend),
    [queries, filters.product, filters.region, filters.segment, model.retentionTrend]);
  const cohortEvidenceRows = useMemo(() => cohortEvidence(cohortContext, cells.map(row => row.cohort)), [cohortContext, cells]);
  const memberEvidenceRows = useMemo(() => {
    const ids = new Set(members.filter(row => cohortStatus === "all" || row.status === cohortStatus).map(row => row.accountId));
    return cohortEvidenceRows.filter(row => ids.has(row.accountId));
  }, [cohortEvidenceRows, members, cohortStatus]);
  const evidenceForAccounts = rows => {
    const ids = new Set(rows.map(row => row.accountId));
    return evidenceRows.filter(row => ids.has(row.accountId));
  };
  const periodDescription = `${humanDate(period.periodStart)}–${humanDate(period.periodEnd)}, inclusive completed UTC days.${compare
    ? ` Previous period: ${humanDate(period.comparisonStart)}–${humanDate(period.comparisonEnd)}.` : " Previous-period comparison off."}`;
  const priorColumns = compare ? [column("deltaUsd", "Change (USD)"), column("changeRate", "Growth")] : [];
  const revenueColumns = [column("category", dimensions[dimension]), column("revenueUsd", "Revenue (USD)"), ...priorColumns,
    column("grossMarginRate", "Margin", "percent"), column("payingAccounts", "Paying accounts"), column("seatUtilizationRate", "Seat use", "percent")];
  const accountColumns = [column("account", "Account", "identity"), column("movement", "Movement"),
    column("revenueUsd", "Revenue (USD)"), ...priorColumns];
  const accountRows = model.accounts.map(row => ({ ...row, revenueShare: model.current.revenueUsd > 0 && row.revenueUsd != null ? row.revenueUsd / model.current.revenueUsd : null }));
  const blocks = {};
  function metric(id, field, value, options = {}) {
    const previous = options.previous;
    const delta = /Rate$/.test(field) ? (value != null && previous != null ? `${((value - previous) * 100).toFixed(1)} pp` : null)
      : change(value, previous) == null ? null : signedPercent(change(value, previous));
    blocks[id] = { id, kind: "metric", title: options.title ?? labels[field], span: options.span ?? 3,
      field, value, delta, previous, history: options.history ?? [], sourceRows: options.sourceRows ?? evidenceRows,
      description: options.description ?? `${periodDescription} See source for the metric definition.`, scope: options.scope };
    return id;
  }
  function chart(id, title, data, spec, options = {}) {
    blocks[id] = { id, kind: "chart", title, data, spec, span: options.span ?? 6, height: options.height ?? 190,
      sourceRows: options.sourceRows ?? evidenceRows,
      description: options.description ?? periodDescription, control: options.control, scope: options.scope, query: options.query, actions: options.actions, tooltip: options.tooltip };
    return id;
  }
  function table(id, title, data, columns, options = {}) {
    blocks[id] = { id, kind: "table", title, data, columns, span: options.span ?? 12,
      description: options.description ?? periodDescription, searchable: options.searchable ?? false, scope: options.scope,
      query: options.query ?? queryId, sourceRows: options.sourceRows ?? evidenceRows, control: options.control, onRowSelect: options.onRowSelect };
    return id;
  }
  const metricSet = (prefix, fields, data, span = 3) => fields.map(field => metric(`${prefix}-${field}`, field, data[field], { span,
    previous: deep.prior[field], history: deep.weekly.map(row => row[field]),
    sourceRows: evidenceRows }));
  const overview = metricSet("performance", ["revenueUsd", "activeAccounts", "grossMarginRate", "netRevenueRetention"], { ...deep.current, netRevenueRetention: model.rollingRetention.netRevenueRetention }, 3);
  blocks["performance-netRevenueRetention"].history = model.retentionTrend.map(row => row.netRevenueRetention);
  blocks["performance-netRevenueRetention"].sourceRows = retentionEvidenceRows;
  blocks["performance-netRevenueRetention"].title = "Net revenue retention";
  blocks["performance-netRevenueRetention"].previous = model.rollingRetention.previousNetRevenueRetention;
  blocks["performance-netRevenueRetention"].delta = model.rollingRetention.netRevenueRetention != null && model.rollingRetention.previousNetRevenueRetention != null
    ? `${model.rollingRetention.netRevenueRetention > model.rollingRetention.previousNetRevenueRetention ? "+" : ""}${((model.rollingRetention.netRevenueRetention - model.rollingRetention.previousNetRevenueRetention) * 100).toFixed(1)} pp` : null;
  blocks["performance-netRevenueRetention"].description = "Trailing 28 days versus the preceding 28 at the selected endpoint. Headline and trend endpoint use this same definition, independently of the comparison toggle. The delta compares this same 28-day metric at the preceding selected-period endpoint, in percentage points; uncovered history is unavailable.";
  blocks["performance-activeAccounts"].title = "Active customers";
  const revenueMetrics = metricSet("revenue", ["revenueUsd", "subscriptionUsd", "usageUsd", "grossProfitUsd"], deep.current);
  const adoptionMetrics = metricSet("adoption", ["activeAccounts", "completedRuns", "seatUtilizationRate"], deep.current);
  adoptionMetrics.push(metric("performance-activation", "activationRate", model.activation.activationRate, { sourceRows: currentEvidenceRows,
    description: `${periodDescription} ${model.activation.activatedAccounts ?? "—"} of ${model.activation.eligibleAccounts ?? "—"} mature new paid accounts completed a run within seven inclusive days.` }));

  chart("performance-trend", "Revenue over time", revenueRowsForChart(model.trend, chartOverrides["performance-trend"]),
    line("revenueUsd", ["revenueUsd", "previousRevenueUsd"]), {
      description: `${periodDescription} The tab interval controls displayed trend buckets. Calendar boundary buckets include selected days only.`,
      actions: ({ row }) => row.date && row.throughDate ? [{ label: "View revenue", context: dateRangeLabel(row.date, row.throughDate),
        onSelect: () => shell.exploreDashboard?.("revenue", { filters: { ...filters, date: `${row.date}..${row.throughDate}` } }) }] : [] });
  chart("performance-adoption", "Weekly active accounts", deep.weekly, line("activeAccounts", ["activeAccounts", "previousActiveAccounts"]));
  chart("overview-margin", "Gross margin", deep.weekly, { ...line("grossMarginRate", ["grossMarginRate", "previousGrossMarginRate"]), startAtZero: false });
  chart("overview-nrr", "Net revenue retention", model.retentionTrend, { ...line("netRevenueRetention", ["netRevenueRetention", "previousNetRevenueRetention"]), startAtZero: false }, {
    sourceRows: retentionEvidenceRows, description: blocks["performance-netRevenueRetention"].description });
  table("overview-products", "Product scorecard", deep.products, [column("category", "Product"), column("revenueUsd", "Revenue (USD)"), ...priorColumns,
    column("grossMarginRate", "Margin", "percent"), column("seatUtilizationRate", "Seat use", "percent")], { span: 7, onRowSelect: exploreProduct });
  const movers = [...accountRows.filter(row => row.deltaUsd > 0).toSorted((a, b) => b.deltaUsd - a.deltaUsd).slice(0, 3),
    ...accountRows.filter(row => row.deltaUsd < 0).toSorted((a, b) => a.deltaUsd - b.deltaUsd).slice(0, 3)];
  table("overview-movers", "Account movers", movers.length ? movers : accountRows.slice(0, 5),
    [column("account", "Account"), column("revenueUsd", "Revenue (USD)"), column("deltaUsd", "Change (USD)")], { span: 5, onRowSelect: selectAccount });
  chart("revenue-mix", "Subscription and usage revenue", deep.weekly, line("subscriptionUsd", ["subscriptionUsd", "usageUsd", "previousSubscriptionUsd", "previousUsageUsd"]));
  blocks["overview-products"].kind = "custom";
  blocks["overview-products"].title = "Product economics";
  blocks["overview-products"].description = `${periodDescription} Revenue and gross profit use one common dollar scale across products. Margin is gross profit divided by revenue. Click a product to investigate its economics.`;
  blocks["overview-products"].render = () => <ProductEconomics rows={deep.products} onSelect={exploreProduct} />;
  blocks["overview-movers"].kind = "custom";
  blocks["overview-movers"].description = `${periodDescription} The three largest account revenue gains and declines. Bars share a zero-centered scale; open an account to investigate its movement.`;
  blocks["overview-movers"].render = () => <RevenueMovers rows={blocks["overview-movers"].data} onSelect={selectAccount} />;
  chart("revenue-margin", "Gross margin by product", comparedProductRows(deep.productTrend, compare), series("line", "grossMarginRate"));
  chart("revenue-bridge", "Revenue bridge (USD)", deep.bridge, { type: "waterfall", x: "movement", y: "bridgeUsd", showValues: true,
    showXAxisLabel: false, xTickLabelLayout: "wrap", sortOrder: "original" }, { span: 8,
    description: `${periodDescription} Previous revenue plus nonzero account movements equals current revenue. Zero movements remain explicitly visible in the adjacent table; no missing movement is treated as zero.` });
  table("revenue-movements", "Movement detail", deep.movements,
    [column("movement", "Movement"), column("accounts", "Accounts"), column("deltaUsd", "Change (USD)")], { span: 4 });
  table("performance-segment-table", "Segment economics", deep.segments, revenueColumns, { span: 8,
    onRowSelect: row => shell.exploreDashboard?.("customers", { filters: { ...filters, [dimension]: row.category } }) });
  chart("segment-margin", "Gross margin by segment", deep.segments,
    { type: "bar", x: "category", y: "grossMarginRate", fields: ["grossMarginRate", "previousGrossMarginRate"], stackable: false, showXAxisLabel: false, showYAxisLabel: false, showValues: false }, { span: 4, actions: ({ row }) => [{ label: `View ${row.category} customers`,
      onSelect: () => shell.exploreDashboard?.("customers", { filters: { ...filters, [dimension]: row.category } }) }] });
  table("revenue-weekly", "Financial history", deep.weekly,
    [column("date", "Period starting"), column("revenueUsd", "Revenue (USD)"), column("subscriptionUsd", "Subscriptions (USD)"),
      column("usageUsd", "Usage (USD)"), column("costUsd", "Cost of revenue (USD)"), column("grossProfitUsd", "Gross profit (USD)"), column("grossMarginRate", "Margin", "percent")]);
  chart("adoption-active", "Active accounts by product", comparedProductRows(deep.productTrend, compare), series("line", "activeAccounts"), {
    description: `${periodDescription} Distinct accounts per displayed interval and product. Multi-product accounts overlap; product counts must not be summed.` });
  chart("adoption-intensity", "Runs per active account", deep.weekly, line("runsPerAccount", ["runsPerAccount", "previousRunsPerAccount"]));
  chart("performance-usage", "Completed runs by product", comparedProductRows(deep.productTrend, compare), series("line", "completedRuns"));
  chart("adoption-utilization", "Seat utilization by product", comparedProductRows(deep.productTrend, compare), series("line", "seatUtilizationRate"));
  table("adoption-cohorts", "Activation by signup period", deep.activationCohorts,
    [column("cohortStart", "First paid"), column("eligibleAccounts", "Eligible"), column("activatedAccounts", "Activated"), column("activationRate", "Within 7 days", "percent")], { span: 6,
      description: `${periodDescription} Each row is a new paid-account cohort. Only accounts with seven complete days of follow-up are eligible.` });
  table("adoption-products", "Product engagement", deep.products,
    [column("category", "Product"), column("activeAccounts", "Active accounts"), column("activeUsers", "Active users"),
      column("completedRuns", "Runs"), column("runsPerAccount", "Runs / account")], { span: 6 });
  chart("performance-retention", "Revenue retention", model.retentionTrend,
    line("netRevenueRetention", ["netRevenueRetention", "grossRevenueRetention"]), {
      sourceRows: retentionEvidenceRows, description: "At each displayed endpoint, compare trailing 28 days with the preceding 28. Net includes expansion; gross caps retained revenue at each account's prior revenue. This is an intrinsic retention window, independent of the revenue comparison toggle." });
  table("performance-cohorts", "Paid-customer retention by cohort", cells, [], {
    query: rosterQueryId, sourceRows: cohortEvidenceRows, span: 12, scope: { scopeFilters: cohortScope },
    description: "First-paid-month cohorts and subsequent calendar month ends. Fixed 0–100% scale. Blank cells are not yet mature, never zero. Activity dates do not change cohort membership or observation cutoff." });
  blocks["performance-cohorts"].kind = "cohort";
  const membershipScope = [...cohortScope, { label: "First paid month", field: "cohort", value: selectedCell?.cohort },
    { label: "Months since first paid month", field: "age", value: selectedCell?.age }, { label: "Retention status", field: "status", value: cohortStatus }];
  table("cohort-members", "Cohort customers", members.filter(row => cohortStatus === "all" || row.status === cohortStatus),
    [column("account", "Customer"), column("status", "Status", "status"), column("firstPaid", "First paid"), column("cutoff", "Measured at")], {
    query: rosterQueryId, sourceRows: memberEvidenceRows, scope: { scopeFilters: membershipScope }, searchable: true, onRowSelect: selectAccount,
    control: <><Control label="Cohort" value={selectedCell?.cohort ?? ""} choices={[...new Set(cells.filter(row => row.mature).map(row => row.cohort))]}
      onChange={cohort => shell.setDashboardFocus?.({ ...shell.viewFocus, cohort, age: String(age) })} labels={Object.fromEntries(cells.map(row => [row.cohort, humanMonth(row.cohort)]))} />
      <Control label="Age" value={String(selectedCell?.age ?? 1)} choices={cells.filter(row => row.cohort === selectedCell?.cohort && row.mature).map(row => String(row.age))}
        onChange={age => shell.setDashboardFocus?.({ ...shell.viewFocus, cohort: selectedCell?.cohort, age })} labels={Object.fromEntries(Array.from({length:8}, (_,i) => [String(i+1), `Month ${i+1}`]))} />
      <Control label="Status" value={cohortStatus} choices={["all", "Retained", "Lost"]} onChange={setCohortStatus} labels={{all:"All"}} /></> });
  table("retention-products", "Retention by product", deep.products, [column("category", "Product"),
    column("netRevenueRetention", "NRR", "percent"), column("grossRevenueRetention", "GRR", "percent"), column("paidAccountRetention", "Account retention", "percent"), column("churnedAccounts", "Churned")], { span: 6 });
  blocks["retention-products"].render = () => <RetentionByProduct rows={deep.products} />;
  blocks["retention-products"].description = "Net revenue retention includes expansion; gross revenue retention excludes it. Account retention measures paying customers. The NRR tick marks 100%, where expansion offsets losses.";
  table("retention-losses", compare ? "Accounts losing revenue" : "Account revenue", compare ? accountRows.filter(row => row.deltaUsd < 0) : accountRows.toSorted((a,b) => b.revenueUsd - a.revenueUsd), accountColumns, { span: 6, searchable: true, onRowSelect: selectAccount });
  chart("customers-concentration", "Current revenue concentration", deep.concentration, { type: "bar", x: "account", y: "revenueShare", showXAxisLabel: false, xTickLabelLayout: "wrap", showValues: true }, {
    description: `${periodDescription} Top ten accounts by period revenue; each share uses all selected-scope revenue as its denominator.`,
    actions: ({ row }) => [{ label: `View ${row.account}`, onSelect: () => selectAccount(row) }] });
  table("customers-segments", "Customer mix", deep.products, [column("category", "Product"), column("payingAccounts", "Paying"),
    column("activeAccounts", "Active"), column("revenueUsd", "Revenue (USD)")], { span: 6 });
  table("performance-accounts", "Account portfolio", accountRows, [...accountColumns, column("revenueShare", "Revenue share", "percent"),
    column("grossMarginRate", "Margin", "percent"), column("products", "Products at period end")], { searchable: true, onRowSelect: selectAccount });
  const resolvedScope = model.account ? [{ label: "Account", field: "account", value: model.account.account }] : [];
  const accountEvidence = { ...accountScope.componentProps(queryId, ["date", "contractId"]), scopeFilters: resolvedScope };
  const accountMetrics = ["revenueUsd", "completedRuns", "grossMarginRate"].map(field => metric(`account-${field}`, field, model.account?.[field],
    { span: 4, scope: accountEvidence, previous: model.account?.[`previous${field[0].toUpperCase()}${field.slice(1)}`], history: model.accountTrend.map(row => row[field]), sourceRows: accountEvidenceRows }));
  chart("performance-account-history", "Account revenue history", model.accountTrend, line("revenueUsd", ["revenueUsd", "previousRevenueUsd"]), { scope: accountEvidence, sourceRows: accountEvidenceRows });
  chart("account-usage", "Account usage history", model.accountTrend, line("completedRuns", ["completedRuns", "previousCompletedRuns"]), { scope: accountEvidence, sourceRows: accountEvidenceRows });
  table("performance-account-products", "Account product detail", model.accountProducts,
    [column("product", "Product"), column("revenueUsd", "Revenue (USD)"), column("subscriptionUsd", "Subscriptions (USD)"), column("usageUsd", "Usage (USD)"),
      column("grossMarginRate", "Margin", "percent"), column("completedRuns", "Runs")], { scope: accountEvidence, sourceRows: accountEvidenceRows });
  for (const id of ["overview-movers", "retention-losses"]) blocks[id].sourceRows = evidenceForAccounts(blocks[id].data);
  for (const id of ["adoption-cohorts", "customers-concentration", "customers-segments", "revenue-weekly"]) blocks[id].sourceRows = currentEvidenceRows;
  const row = (id, items, title, control) => ({ id, items, ...(items.every(id => blocks[id].kind === "metric" && !blocks[id].trend) ? { kind: "metrics" } : {}),
    ...(title ? { header: <SectionHeader id={`${id}-title`} title={title} filters={control} /> } : {}) });
  const breakdown = <Control label="Break down by" value={dimension} choices={Object.keys(dimensions)} onChange={setDimension} labels={dimensions} />;
  const observedDates = [...new Set(queries[queryId].rows.map(row => row.date))].sort().reverse();
  const entryChoices = [...new Set(queries[rosterQueryId].rows.map(row => row.startDate.slice(0,7)))].sort();
  const cohortControls = <>
    <Control label="Cohorts from" value={cohortWindow.entryStart} choices={["all", ...entryChoices]} onChange={entryStart => setCohortWindow(current => ({ ...current, entryStart }))}
      labels={Object.fromEntries([["all", "Earliest"], ...entryChoices.map(month => [month, humanMonth(month)])])} />
    <Control label="Cohorts to" value={cohortWindow.entryEnd} choices={["all", ...entryChoices]} onChange={entryEnd => setCohortWindow(current => ({ ...current, entryEnd }))}
      labels={Object.fromEntries([["all", "Latest"], ...entryChoices.map(month => [month, humanMonth(month)])])} />
    <Control label="Measure retention at" value={cohortWindow.asOf} choices={observedDates}
      onChange={asOf => setCohortWindow(current => ({ ...current, asOf }))} labels={Object.fromEntries(observedDates.map(date => [date, humanDate(date)]))} />
  </>;
  for (const [metricId, trendId] of [["performance-revenueUsd", "performance-trend"], ["performance-activeAccounts", "performance-adoption"],
    ["performance-grossMarginRate", "overview-margin"], ["performance-netRevenueRetention", "overview-nrr"]]) {
    blocks[metricId].trend = blocks[trendId];
    blocks[metricId].span = 6;
  }
  const layouts = {
    dashboard: [row("overview:outcomes", overview.slice(0,2)), row("overview:health", overview.slice(2)),
      row("overview:drivers", ["overview-products", "overview-movers"])],
    revenue: [row("revenue:metrics", revenueMetrics), row("revenue:trends", ["revenue-mix", "revenue-margin"]),
      ...(compare ? [row("revenue:movements", ["revenue-bridge", "revenue-movements"], "Revenue movements")] : []),
      row("revenue:segments", ["performance-segment-table", "segment-margin"], "Segment economics", breakdown),
      row("revenue:accounts", ["retention-losses", "retention-products"], "Customer contributions"), row("revenue:weekly", ["revenue-weekly"])],
    adoption: [row("adoption:metrics", adoptionMetrics, "Activation & engagement"),
      row("adoption:reach", ["adoption-active", "adoption-intensity"]), row("adoption:depth", ["performance-usage", "adoption-utilization"]),
      row("adoption:cohorts", ["adoption-cohorts", "adoption-products"])],
    retention: [row("retention:cohorts", ["performance-cohorts"], "Customer retention", cohortControls), row("cohort:detail", ["cohort-members"])],
    customers: [row("customers:portfolio", ["performance-accounts"])],
  };
  function conciseChart(spec, data) {
    if (!spec) return spec;
    const fields = spec.fields ?? [...new Set(data.map(row => row[spec.series]).filter(Boolean))];
    const base = field => field.replace(/^previous/i, "").replace(/ · previous$/i, "").toLowerCase();
    const pair = fields.length === 2 && fields.some(field => /previous/i.test(field)) && base(fields[0]) === base(fields[1]);
    const compact = field => (fieldLabels[field] ?? field).replace(/\s*\((?:USD|%)\)$/i, "");
    return { ...spec, legend: { ...spec.legend, comparisons: "grouped", labels: Object.fromEntries(fields.map(field => [fieldLabels[field] ?? field,
      pair ? /previous/i.test(field) ? "Previous" : "Current" : compact(field)])) } };
  }
  function renderBlock(id) {
    const block = blocks[id];
    if (!visible(id)) return null;
    const { title, kind, span, description, scope } = block;
    const locallyPending = loadingAll || localChanges.includes("dimension") && ["performance-segment-table","segment-margin"].includes(id)
      || localChanges.includes("accountId") && ["account-revenueUsd","account-completedRuns","account-grossMarginRate","performance-account-history","account-usage","performance-account-products"].includes(id);
    if (kind === "metric") {
      const trend = block.trend && visible(block.trend.id) ? block.trend : null;
      const trendData = trend ? chartRows(trend.data) : [];
      const legacy = { currentValue: "revenueUsd", previousValue: "previousRevenueUsd" };
      const override = chartOverrides[id] ?? chartOverrides[trend?.id];
      const rawSpec = override ? { ...override, y: legacy[override.y] ?? override.y,
        fields: override.fields?.map(field => legacy[field] ?? field) } : trend?.spec;
      const fields = rawSpec?.fields?.filter(field => compare || !/^previous/i.test(field));
      const trendSpec = trend ? labeledChart({ ...rawSpec, fields, showYAxisLabel: false, yTickCount: 3,
        legend: { ...rawSpec.legend, labels: Object.fromEntries((fields ?? []).map(field => [fieldLabels[field] ?? field,
          /^previous/i.test(field) ? "Previous" : "Current"])) } }) : undefined;
      return <SortableItem key={id} id={id} label={title} kind={trend ? "chart" : "metric"} span={span} minSpan={trend ? 3 : 2}>
        <MetricCard id={id} title={title} queryId={queryId} value={fmt(block.field, block.value)} chart={trendSpec}
          loading={locallyPending && !localError} loadingError={locallyPending && localError} loadingKind={trend ? "metric-trend" : "metric"}
          comparison={compare ? block.delta : null} negative={block.value < block.previous} trendValues={block.history}
          headerControls={trend?.control} description={description} scopeFilters={scope?.scopeFilters}
          sourceRows={block.sourceRows}
          displayRows={trend ? trendData : [{ ...period, [block.field]: block.value }]}>
          {trend && <ChartRenderer spec={trendSpec} rows={trendData} height={150} {...chartProps(id)} getMarkActions={trend.actions} />}
        </MetricCard>
      </SortableItem>;
    }
    const saved = chartOverrides[id];
    const legacyFields = { currentValue: "revenueUsd", previousValue: "previousRevenueUsd" };
    const spec = saved && id === "performance-trend" ? { ...saved, yLabel: saved.yLabel === "Selected measure" ? undefined : saved.yLabel,
      colors: saved.colors ? Object.fromEntries(Object.entries(saved.colors).map(([key,value]) => [legacyFields[key] ?? key,value])) : undefined, y: legacyFields[saved.y] ?? saved.y,
      fields: saved.fields?.map(field => legacyFields[field] ?? field) } : saved ?? block.spec;
    const data = kind === "chart" ? chartRows(block.data) : block.data;
    const productSpec = block.data[0]?.seriesLabel && spec?.series === "product" ? { ...spec, series: "seriesLabel", x: spec.x === "date" ? "plotDate" : spec.x } : spec;
    const resolvedChart = kind === "chart" ? labeledChart(conciseChart({ ...productSpec, fields: spec.fields?.filter(field => compare || !/^previous/i.test(field)) },data)) : undefined;
    return <SortableItem key={id} id={id} label={title} kind={kind === "cohort" ? "table" : kind} span={span} minSpan={3}
      className={["table", "custom"].includes(kind) ? "bp-content-sized" : undefined}>
      <DataComponent variant="card" id={id} title={title} queryId={block.query ?? queryId} kind={kind === "cohort" ? "table" : kind}
        loading={locallyPending && !localError} loadingError={locallyPending && localError} loadingKind={kind === "cohort" ? "table" : kind}
        headerControls={id === "cohort-members" && cohortReturn ? <button type="button" className="bp-back bp-cohort-back" onClick={backToCohorts}><Icon name="chevronLeft" size={14} />Back to cohorts</button> : kind === "chart" ? block.control : undefined}
        chart={resolvedChart} sourceRows={block.sourceRows} displayRows={data} description={description} scopeFilters={scope?.scopeFilters}>
        {block.render ? block.render() : kind === "cohort" ? <CohortTable cells={cells} selectedCell={committedCell} onSelect={selectCell} /> : kind === "chart"
          ? data.length ? <ChartRenderer spec={resolvedChart} rows={data} height={block.height} {...chartProps(id)} getMarkActions={block.actions} tooltipContent={resolvedChart.type === "heatmap" ? block.tooltip : undefined} />
            : <p className="bp-unavailable">No comparable observations for this selection.</p>
          : <DataTable key={id === "cohort-members" ? `${selectedCell?.cohort}-${selectedCell?.age}-${cohortReturn?.visit ?? 0}` : id} columns={block.columns} rows={moneyRows(data)} searchable={block.searchable} signedDeltas
            rowKey={block.onRowSelect ? data[0]?.accountId ? "accountId" : "category" : undefined} selectedRowKey={selectedAccount?.accountId}
            onRowSelect={block.onRowSelect} toolbarControls={block.control} />}
      </DataComponent>
    </SortableItem>;
  }
  const canvas = (id, rows) => <SortableRegion key={id} id={id} label="Business performance blocks" variant="canvas" columns={12}
    className={id === "performance:canvas" ? "bp-overview-canvas" : undefined}
    spacing="standard" authoredRevision={id === "performance:canvas" ? 5 : ["performance:adoption:canvas", "performance:retention:canvas"].includes(id) ? 6 : 4}
    rows={id === "performance:canvas" ? rows.map((row,index) => ({ ...row, spacing:index === 0 ? "none" : "content" })) : rows}>{rows.flatMap(row => row.items).map(renderBlock)}</SortableRegion>;
  const accountRowsLayout = [row("performance:account", accountMetrics),
    row("account:history", ["performance-account-history", "account-usage"]), row("account:products", ["performance-account-products"])];
  return <>
    {shell.canReturnFromExploration && <button className="bp-back" type="button" onClick={shell.returnFromExploration} aria-label="Back to previous view"><Icon name="chevronLeft" size={14} />Back</button>}
    {!loadingAll && tab !== "retention" && !model.current.complete && <p className="bp-notice" role="status">
      This selection has no complete reviewed coverage. Try another period or scope.
    </p>}
    <div data-performance-tab={tab}>
      {canvas(tab === "dashboard" ? "performance:canvas" : `performance:${tab}:canvas`, layouts[tab])}
      {tab === "customers" && <div id="account-detail" className="bp-account-detail"><Section id="performance:account-detail-title" title="Account detail" filters={selectedAccount &&
          <Control label="Account" value={selectedAccount.account} choices={model.accounts.map(row => row.account)} onChange={value => selectAccount(model.accounts.find(row => row.account === value))} />}>
        {canvas("performance:account:canvas", accountRowsLayout)}
      </Section></div>}
      {tab === "customers" && canvas("performance:customers-context:canvas", [row("customers:mix", ["customers-concentration", "customers-segments"])])}
    </div>
  </>;
}
