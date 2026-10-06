import React, { useMemo, useState } from "react";
import { EvidenceChart, DataComponent, DataTable, Dropdown, Filters, Icon, MetricCardTabs, SectionHeader, SortableItem, SortableRegion,
  useDataApp, useDashboardTabs } from "../../data-app-public.jsx";
import { buildProductModel, delta, eligibleFor, feedbackFlow, feedbackStages, featureFields, humanDate, number, percent } from "./product-model.js";
import "./dashboard.css";
import { AdoptionMap, FeatureScorecard, FeedbackRecords } from "./ProductVisuals.jsx";

const filterIds = ["week", "plan", "channel", "region"];
const tabs = [
  { id: "dashboard", label: "Overview", filterIds },
  { id: "activation", label: "Activation & retention", filterIds },
  { id: "features", label: "Feature adoption", filterIds, focusFields: ["feature"] },
  { id: "workspaces", label: "Workspaces", filterIds: [...filterIds, "cohort"], focusFields: ["workspaceId"] },
];
const line = (y, fields = [y]) => ({ type: "line", x: "week", y, fields, showXAxisLabel: false, showYAxisLabel: false, showLegend: fields.length > 1,
  legend: { labels: { activeWorkspaces: "Active workspaces", returningRate: "Weekly continuation", activationRate: "7-day activation", automationRate: "Automation adoption", adoptionRate: "Adoption", completedTasks: "Completed tasks", eventsPerAdopter: "Events per using workspace" } } });
const column = (field, label, extra = {}) => ({ field, label, ...extra });
const changeTone = (_, row) => row.change == null || row.change === 0 ? "neutral" : row.change > 0 ? "positive" : "negative";
function ChartCard({ id, title, description, spec, rows, sourceRows, queryId = "workspace_activity", height = 240, actions, variant = "card", headerControls, minPlotWidth, footer, onSankeySelection }) {
  return <EvidenceChart variant={variant} id={id} queryId={queryId} title={title} description={description}
    spec={spec} rows={rows} sourceRows={sourceRows} height={height} headerControls={headerControls}
    chartOptions={{ getMarkActions: actions, onSankeySelection }}
    renderPlot={minPlotWidth ? (plot, chart) => <div className="product-chart-scroll" role="region" aria-label={`${title} chart`} tabIndex={0}>
      <div style={{ minWidth: minPlotWidth }}>{chart.type === "sankey" && <div className="product-flow-stages"><span>Feedback source</span><span>Theme</span><span>Feature</span><span>Roadmap status</span></div>}{plot}</div>
    </div> : undefined}>
    {footer}
  </EvidenceChart>;
}
function TableCard({ id, title, description, rows, sourceRows, columns, onSelect, controls, queryId = "workspace_activity" }) {
  return <DataComponent variant="card" id={id} queryId={queryId} title={title} description={description} kind="table" displayRows={rows} sourceRows={sourceRows}>
    <DataTable rows={rows} columns={columns} pageSize={8} rowKey={rows[0]?.workspaceId ? "workspaceId" : columns[0]?.field} onRowSelect={onSelect}
      rowActionLabel={row => `Inspect ${row.workspace ?? row.feature ?? row.plan ?? row.channel}`} toolbarControls={controls} />
  </DataComponent>;
}
export function DashboardContent({ initialView = {} }) {
  const shell = useDataApp(), { snapshot, queries, filters, setFilter, visible } = shell;
  const { activeTabId } = useDashboardTabs(tabs);
  const tab = initialView.tab ?? (tabs.some(item => item.id === activeTabId) ? activeTabId : "dashboard");
  const model = useMemo(() => buildProductModel(queries, filters), [queries, filters]);
  const { current, previous } = model;
  const [localFeature, setLocalFeature] = useState("Automations"), [status, setStatus] = useState("all");
  const [selectedMetric, setSelectedMetric] = useState("active"), [feedbackSelections, setFeedbackSelections] = useState({});
  const [selectedFlow, setSelectedFlow] = useState([]), [showFeedback, setShowFeedback] = useState(false);
  const feedback = useMemo(() => feedbackFlow(model.feedback, feedbackSelections), [model.feedback, feedbackSelections]);
  const feedbackRecords = useMemo(() => feedback.sourceRows.filter(row => selectedFlow.every(item => String(row[item.field] ?? "") === item.name)), [feedback, selectedFlow]);
  const feature = shell.viewFocus?.feature ?? localFeature;
  const workspacePool = model.workspaces;
  const selected = workspacePool.find(row => row.workspaceId === shell.viewFocus?.workspaceId) ?? workspacePool[0];
  const chooseWorkspace = row => {
    if (tab === "workspaces") shell.setDashboardFocus?.({ workspaceId: row.workspaceId });
    else shell.exploreDashboard?.("workspaces", { filters, focus: { workspaceId: row.workspaceId } });
    if (tab === "workspaces") requestAnimationFrame(() => document.getElementById("workspace-detail")?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
  const chooseFeature = row => shell.exploreDashboard?.("features", { filters, focus: { feature: row.feature } });
  const cards = [];
  const add = (id, row, span, node, kind = "chart") => cards.push({ id, row, span, node, kind });
  const chart = (id, row, span, title, description, spec, rows, sourceRows = model.activity, extra = {}) =>
    add(id, row, span, <ChartCard {...{ id, title, description, spec, rows, sourceRows, ...extra }} />);
  const table = (id, row, span, title, description, rows, columns, extra = {}) =>
    add(id, row, span, <TableCard {...{ id, title, description, rows, columns, sourceRows: model.activity, ...extra }} />, "table");
  const metrics = [
    ["active", "Active workspaces", "activeWorkspaces", false, "Workspaces completing a task in the selected week; distinct from members or registered workspaces."],
    ["activation", "7-day activation", "activationRate", true, "Last four fully observed signup cohorts. Completed a first task within 7 days / eligible created workspaces."],
    ["continuation", "Weekly continuation", "returningRate", true, "Last week's active workspaces that also completed a task this week / last week's active workspaces."],
    ["automation", "Automation adoption", "automationRate", true, "Active Team and Business workspaces running an automation / active Team and Business workspaces. Starter is not eligible."],
  ];
  if (tab === "dashboard") {
    const metricItems = metrics.map(([id, title, field, rate, description], index) => ({ id, title, field, description,
      color: `var(--chart-${index + 1})`, value: rate ? percent(current[field]) : number(current[field]),
      comparison: delta(current[field], previous?.[field], rate), negative: current[field] < previous?.[field],
      trendValues: model.history.map(row => row[field]) }));
    add("product-metric-overview", "metrics", 12, <MetricCardTabs items={metricItems} selectedId={selectedMetric}
      onChange={setSelectedMetric} ariaLabel="Product growth metric">
      {({ item }) => <ChartCard id={item.id === "active" ? "product-growth" : `product-${item.id}-trend`}
        title={item.title} description={item.description} variant="plain" rows={model.history} height={300}
        sourceRows={item.id === "activation" ? model.roster : model.activity}
        queryId={item.id === "activation" ? "workspace_roster" : "workspace_activity"}
        spec={{ ...line(item.field), colors: { [item.field]: item.color }, annotations: [{ id: "setup-release", kind: "event",
          at: "2026-07-20", field: "rollout", label: "Guided setup launched" }] }}
        actions={({ row }) => [{ label: "Inspect this week", onSelect: () => shell.exploreDashboard?.("workspaces", { filters: { ...filters, week: row.week } }) }]} />}
    </MetricCardTabs>);
    chart("product-bridge", "growth", 5, "Weekly workspace movement", "New = first active week; Returning = resumed after at least one inactive week; Dormant = active last week, not this week. Counts reconcile exactly.",
      { type: "waterfall", x: "stage", y: "change", showXAxisLabel: false, showYAxisLabel: false }, model.bridge);
    table("product-plan-scorecard", "growth", 7, "Growth and depth by plan", "Each workspace belongs to exactly one plan. Week 4 retention includes only fully observed signup cohorts.",
      model.plans.map(row => ({ ...row, tasksPerWorkspace: row.tasksPerWorkspace == null ? null : Math.round(row.tasksPerWorkspace), retention: percent(row.retentionRate) })),
      [column("plan", "Plan"), column("active", "Active"), column("change", "Weekly change", { deltaTone: changeTone, renderCell: value => `${value > 0 ? "+" : ""}${number(value)}` }), column("tasksPerWorkspace", "Tasks / active"), column("retention", "Week 4 retention")],
      { onSelect: row => shell.exploreDashboard?.("workspaces", { filters: { ...filters, plan: row.plan } }) });
    add("product-feature-scorecard", "investigate", 12, <DataComponent variant="card" id="product-feature-scorecard" queryId="workspace_activity" kind="custom"
      title="Feature adoption" description="Using / eligible active workspaces. Changes compare last week in percentage points. Select a feature to explore its workspace evidence."
      sourceRows={model.activity} displayRows={model.featureSummary}>
      <FeatureScorecard rows={model.featureSummary} onSelect={chooseFeature} />
    </DataComponent>);
    chart("product-feedback-flow", "feedback", 12, "From feedback to roadmap",
      "Feedback submitted in the four complete weeks through the selected week. Counts are records, not distinct customers. Each record has one primary theme and its disposition at submission. Unplanned requests intentionally skip the feature stage.",
      { type: "sankey", x: "feedbackSource", y: "mentions", stages: feedbackStages, showLegend: false, showValues: true,
        labelMaxLength: 18, sankeyNodeWidth: 18, sankeyLabelFontSize: 13, sankeyValueFontSize: 11,
        colors: { feedbackSource: "var(--chart-2)", theme: "var(--chart-4)", feature: "var(--chart-3)",
          Prioritized: "var(--chart-1)", Backlog: "var(--secondary)", Unplanned: "var(--negative)" } },
      feedback.rows, feedback.sourceRows, { queryId: "workspace_feedback", height: 480, minPlotWidth: 680, onSankeySelection: setSelectedFlow,
        footer: <div className="product-flow-footer"><span>{selectedFlow.map(item => item.name).join(" → ")}</span>
          <button type="button" className="button" onClick={() => setShowFeedback(true)}>View {feedbackRecords.length} feedback records</button></div>,
        headerControls: <div className="product-feedback-filters" role="group" aria-label="Feedback flow filters">
          {feedbackStages.map((field, index) => <Dropdown key={field} label={["Source", "Theme", "Feature", "Roadmap status"][index]} showLabel multiple
            value={feedbackSelections[field] ?? []} choices={[...new Set(model.feedback.map(row => row[field]).filter(Boolean))]}
            onChange={values => setFeedbackSelections(current => ({ ...current, [field]: values }))} />)}
          {feedbackStages.some(field => feedbackSelections[field]?.length) && <button className="product-back" type="button" onClick={() => setFeedbackSelections({})}>Reset feedback filters</button>}
        </div> });
  }
  if (tab === "activation") {
    chart("product-onboarding", "onboarding", 12, "Onboarding funnel", `Same ${model.activation.eligible} workspaces in the last four mature signup cohorts; all steps measured within 7 days.`,
      { type: "funnel", x: "stage", y: "count", showXAxisLabel: false, showYAxisLabel: false }, model.funnel, model.recentCohorts, { queryId: "workspace_roster", height: 290 });
    chart("product-cohort-trends", "cohort-trends", 12, "Activation and week 4 retention", "One point per signup cohort. Activation is within 7 days; retention means activity in calendar week 4. Recent cohorts remain unobserved, not zero.",
      { ...line("activationRate", ["activationRate", "retentionRate"]), x: "cohort", colors: { activationRate: "var(--chart-1)", retentionRate: "var(--chart-2)" }, legend: { labels: { activationRate: "7-day activation", retentionRate: "Week 4 retention" } } }, model.cohorts, model.activity,
      { height: 290 });
    table("product-channels", "channels", 12, "Acquisition channel performance", "All selected signup cohorts through the selected week. Rate denominators differ because 7-day and week-4 windows mature at different times.",
      model.channels.map(row => ({ ...row, activation: percent(row.activationRate), retention: percent(row.retentionRate) })),
      [column("channel", "Channel"), column("created", "Created"), column("eligible", "7-day eligible"), column("activated", "Activated"), column("activation", "Activation"), column("retainedEligible", "Week 4 eligible"), column("retained", "Returned"), column("retention", "Week 4 retention")],
      { onSelect: row => shell.exploreDashboard?.("workspaces", { filters: { ...filters, channel: row.channel } }) });
    chart("product-retention", "retention", 12, "Retention by signup cohort", "Rows are signup cohorts; columns are calendar weeks since signup. Each cell is active / created workspaces. Future weeks have no value. Week 0 is the signup week, not a 100% baseline.",
      { type: "heatmap", x: "age", y: "retentionRate", series: "signupWeek", showXAxisLabel: false, showYAxisLabel: false,
        colorDomain: [0, 1], tooltipFields: [{ field: "signupWeek", label: "Signup week" }, { field: "retentionRate", label: "Retention" },
          { field: "retained", label: "Active" }, { field: "created", label: "Created" }],
        legend: { labels: { retentionRate: "Retention" } }, rowHeight: 26 }, model.retention.map(({ cohort, week, ...row }) => ({ ...row,
          cohortIndex: model.weeks.indexOf(cohort), weekIndex: model.weeks.indexOf(week), signupWeek: humanDate(cohort) })), model.activity,
      { height: 430, actions: ({ row }) => row.retentionRate == null ? [] : [{ label: "View cohort workspaces", context: `${row.signupWeek} · ${row.age}`,
        onSelect: () => shell.exploreDashboard?.("workspaces", { filters: { ...filters, week: model.weeks[row.weekIndex], cohort: model.weeks[row.cohortIndex] } }) }] });
  }
  if (tab === "features") {
    const byId = new Map(model.currentRows.map(row => [row.workspaceId, row]));
    add("product-adoption-map", "adoption-map", 12, <DataComponent variant="card" id="product-adoption-map" title="Workspace adoption map" kind="table" queryId="workspace_activity"
      sourceRows={model.currentRows} displayRows={model.currentRows} description="Activity in the selected week. Not included means the plan does not offer the feature, not failed adoption. Select a workspace for its history.">
      <AdoptionMap rows={model.workspaces.map(row => ({ ...byId.get(row.workspaceId), ...row }))} onSelect={chooseWorkspace} />
    </DataComponent>, "table");
    const featureRows = model.featureHistory.filter(row => row.feature === feature);
    const eligible = model.currentActive.filter(row => eligibleFor(row, feature));
    chart("product-feature-trend", "feature-trends", 7, `${feature} adoption`, "Feature-using workspaces / eligible active workspaces each week. Plan restrictions are accounted for before calculating rates.",
      line("adoptionRate"), featureRows, model.activity, { height: 270 });
    chart("product-feature-frequency", "feature-trends", 5, "Usage per adopting workspace", "Total feature events / workspaces using this feature. This excludes eligible non-users; inspect them in the table below.",
      line("eventsPerAdopter"), featureRows, model.activity, { height: 270 });
    table("product-feature-workspaces", "feature-evidence", 12, `${feature} usage by workspace`, "Only active workspaces eligible for this feature. A zero means eligible but not using it. Select a row for full workspace context.",
      eligible.map(row => ({ ...row, events: row[featureFields[feature]], usage: row[featureFields[feature]] ? "Using" : "Not using" })).sort((a,b) => a.events - b.events),
      [column("workspace", "Workspace"), column("plan", "Plan"), column("channel", "Acquisition"), column("completedTasks", "Tasks completed"), column("events", "Feature events"), column("usage", "Usage")],
      { sourceRows: eligible, onSelect: chooseWorkspace });
  }
  if (tab === "workspaces") {
    const listed = workspacePool.filter(row => status === "all" || row.status === status);
    const listedIds = new Set(listed.map(row => row.workspaceId));
    table("product-workspace-list", "workspaces", 12, "Workspace health", "Active means at least one completed task. Slipping means tasks fell more than 25% versus the preceding week; it is a usage signal, not churn or a renewal prediction.",
      listed.map(row => ({ ...row, changeLabel: delta(row.completedTasks, row.previousTasks) ?? "—" })),
      [column("workspace", "Workspace", { presentation: "identity", secondaryField: "plan" }), column("channel", "Acquisition"), column("completedTasks", "Completed tasks"), column("changeLabel", "Weekly change", { deltaTone: changeTone }), column("trend", "8-week trend", { presentation: "sparkline" }), column("featuresUsed", "Features used"), column("status", "Status", { presentation: "status" })],
      { sourceRows: model.activity.filter(row => listedIds.has(row.workspaceId)), onSelect: chooseWorkspace, controls: <Dropdown label="Status" value={status} choices={["all", "Active", "Slipping", "New", "Inactive"]} onChange={setStatus} showLabel /> });
    if (selected) {
      const rows = model.activity.filter(row => row.workspaceId === selected.workspaceId);
      add("product-workspace-heading", "detail-header", 12, <div id="workspace-detail" className="product-workspace-detail"><SectionHeader id="workspace-detail-heading" title="Workspace detail"
        filters={<Dropdown label="Workspace" value={selected.workspace} choices={workspacePool.map(row => row.workspace)} onChange={name => shell.setDashboardFocus?.({ workspaceId: workspacePool.find(row => row.workspace === name).workspaceId })} showLabel />} /></div>, "content");
      chart("product-workspace-trend", "workspace-detail", 6, "Completed tasks", "Tasks completed by this workspace each week. No tasks means no qualifying activity, not a missing observation.", line("completedTasks"), rows, rows);
      table("product-workspace-profile", "workspace-detail", 3, "Workspace context", "Member count is the workspace roster, not a count of active people.",
        [{ detail: "Created", value: humanDate(selected.cohort) }, { detail: "Plan", value: selected.plan }, { detail: "Acquisition", value: selected.channel },
          { detail: "Members", value: number(selected.members) }, { detail: "First task", value: selected.activationDay == null ? "Not completed" : `Day ${selected.activationDay}` }],
        [column("detail", "Detail"), column("value", "Value")], { queryId: "workspace_roster", sourceRows: [selected] });
      table("product-workspace-features", "workspace-detail", 3, "Feature usage this week", "Ineligible features are labeled Not included rather than zero adoption.",
        Object.entries(featureFields).map(([feature, field]) => ({ feature, events: eligibleFor(selected, feature) ? number(rows.at(-1)[field]) : "Not included" })),
        [column("feature", "Feature"), column("events", "Events")], { sourceRows: rows });
    }
  }
  const rows = [...new Set(cards.map(card => card.row))].map(row => ({ id: `product:${tab}:${row}`, items: cards.filter(card => card.row === row).map(card => card.id) }));
  return <div className="product-tracker">
    <Filters sticky filters={snapshot.filters.filter(filter => tabs.find(item => item.id === tab).filterIds.includes(filter.id))}
      queries={queries} values={filters} onChange={setFilter} clearLabel="Reset tab" ariaLabel={`${tabs.find(item => item.id === tab).label} filters`} />
    {shell.canReturnFromExploration && <button type="button" className="product-back" onClick={shell.returnFromExploration}><Icon name="chevronLeft" size={14} />Back to previous view</button>}
    {tab === "features" && <SectionHeader id="product-feature-heading" title="Feature detail" filters={<Dropdown label="Feature" value={feature}
      choices={Object.keys(featureFields)} onChange={value => { setLocalFeature(value); shell.setDashboardFocus?.({ feature: value }); }} showLabel />} />}
    {showFeedback && <FeedbackRecords rows={feedbackRecords} onClose={() => setShowFeedback(false)} onSelect={chooseWorkspace} />}
    <SortableRegion id={`product:${tab}`} variant="canvas" label="Product growth blocks" spacing="standard" rows={rows} authoredRevision={tab === "dashboard" ? 2 : tab === "features" ? 2 : 1}>
      {cards.filter(card => visible(card.id)).map(card => <SortableItem key={card.id} id={card.id} kind={card.kind} span={card.span} minSpan={card.kind === "metric" ? 2 : 3}>{card.node}</SortableItem>)}
    </SortableRegion>
  </div>;
}
