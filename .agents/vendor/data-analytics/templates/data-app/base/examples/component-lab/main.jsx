import React, { useState } from "react";
import { createRoot } from "react-dom/client";

import { DataAppShell } from "../shell.jsx";
import {
  Chart,
  DataComponent,
  Dropdown,
  barChartSpec,
  ExecutiveSummary,
  Filters,
  MetricCardTabs,
  SectionHeader,
  SegmentedControl,
  Switch,
  SortableItem,
  SortableRegion,
  useDataApp,
  useDashboardTabs,
} from "../../src/data-app-public.jsx";
import { snapshot, planToneColors, categoryToneColors } from "./data.js";
import "./component-lab.css";
import { LibraryInventory } from "./Library.jsx";

const planColors = { Enterprise: "var(--chart-1)", Growth: "var(--chart-2)", Starter: "var(--chart-4)" };

const axisChartDefinitions = [
  { type: "horizontalBar", queryId: "category_performance", title: "Horizontal bar", x: "segment", y: "value",
    spec: { sortOrder: "descending", showValues: true, showXAxisLabel: false, showYAxisLabel: false,
      yAxisPosition: "left" } },
  { type: "stackedBar", queryId: "account_composition", title: "Stacked bar", x: "region", y: "accounts",
    series: "plan", spec: { showXAxisLabel: false, showYAxisLabel: false, colors: planToneColors } },
  { type: "stackedBar100", queryId: "account_composition", title: "100% stacked bar", x: "region", y: "accounts",
    series: "plan", spec: { showXAxisLabel: false, showYAxisLabel: false, colors: planToneColors } },
  { type: "horizontalStackedBar", queryId: "account_composition", title: "Horizontal stacked bar",
    x: "region", y: "accounts", series: "plan",
    spec: { showXAxisLabel: false, showYAxisLabel: false, yAxisPosition: "left", colors: planToneColors } },
  { type: "horizontalStackedBar100", queryId: "account_composition", title: "100% horizontal stack",
    x: "region", y: "accounts", series: "plan",
    spec: { showXAxisLabel: false, showYAxisLabel: false, yAxisPosition: "left", colors: planToneColors } },
  { type: "histogram", queryId: "response_distribution", title: "Histogram", x: "team", y: "responseMinutes",
    spec: { showYAxisLabel: false, showValues: true, colors: { responseMinutes: "var(--chart-5)" } } },
];

const axisCharts = axisChartDefinitions.map((definition) => ({
  ...definition,
  id: definition.type.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase(),
  description: `${definition.title} with its standard configuration.`,
  height: 250,
  spec: {
    type: definition.type,
    x: definition.x,
    y: definition.y,
    ...(definition.series ? { series: definition.series } : {}),
    ...definition.spec,
  },
}));

const axislessCharts = [
  { id: "leaderboard", queryId: "category_performance", title: "Leaderboard",
    description: "Compact ranked category comparison.",
    breakdown: ["segment"],
    additionalRows: [
      { segment: "Professional", value: 21 },
      { segment: "Nonprofit", value: 18 },
      { segment: "Agencies", value: 15 },
      { segment: "Developer", value: 12 },
      { segment: "Personal", value: 9 },
    ],
    experimentalBarSpec: { presentation: "rankedList", category: "segment", value: "value",
      sort: "descending", visibleRows: 10,
      style: { color: "color-mix(in srgb, var(--text) 9%, transparent)",
        thickness: 36, radius: 8, gap: 8, textColor: "var(--text)" } } },
  { id: "ranked-list", queryId: "category_performance", title: "Ranked list",
    description: "Expandable ranked category comparison.",
    breakdown: ["segment"],
    experimentalBarSpec: {
      presentation: "groupedList",
      category: "segment",
      value: "value",
      series: [
        { key: "value", label: "This week", color: "var(--chart-1)",
          colors: Object.values(categoryToneColors),
          textColors: ["white", "white", "white", "light-dark(#1a1c1f, #111)", "light-dark(#1a1c1f, #111)"],
        },
        { key: "target", label: "Last week", color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--text)" },
      ],
      style: { thickness: 36, radius: 7, gap: 15 },
    } },
  { id: "funnel", queryId: "activation_funnel", title: "Funnel", description: "Ordered activation progression.",
    spec: { type: "funnel", x: "stage", y: "accounts", colors: { accounts: "var(--chart-2)" } } },
].map((entry) => ({ ...entry, height: entry.height ?? 250 }));

const teamCharts = [
  {
    id: "team-delivery-benchmark",
    queryId: "team_delivery_weekly",
    title: "Delivery vs target",
    description: "Completed work by day, with the team target shown as a benchmark line.",
    breakdown: ["day"],
    height: 320,
    experimentalBarSpec: {
      category: "day",
      value: "completed",
      markers: [{ value: 20, label: "Target 20", color: "var(--secondary)" }],
      domain: [0, 30],
      style: { color: "var(--chart-2)", thickness: 22, radius: 5 },
      barCategoryGap: "18%",
    },
  },
  {
    id: "team-rituals-heatmap",
    queryId: "team_rituals",
    title: "Team rituals",
    description: "A weekly check-in map for the routines that keep the team aligned.",
    breakdown: ["day", "ritual"],
    height: 250,
    spec: {
      type: "heatmap",
      x: "day",
      y: "completed",
      series: "ritual",
      showXAxisLabel: false,
      showYAxisLabel: false,
      showLegend: false,
      categoryOrder: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      seriesOrder: ["Standup", "Planning", "Review", "Retro"],
      rowHeight: 40,
      markRadius: 8,
      colorBands: [
        { max: 0.5, color: "color-mix(in srgb, var(--text) 6%, var(--surface))", label: "Missed" },
        { color: "var(--chart-3)", label: "Complete" },
      ],
      cellLabel: { showWhen: 1, text: "✓", color: "var(--surface)", fontSize: 13, fontWeight: 800 },
    },
  },
  {
    id: "team-focus-windows",
    queryId: "team_focus_windows",
    title: "Focus windows",
    description: "Protected focus time for each team across the shared workday.",
    breakdown: ["team"],
    height: 320,
    experimentalBarSpec: {
      orientation: "horizontal",
      category: "team",
      value: "focusHours",
      range: ["beforeFocus", "focusEnd"],
      track: true,
      grid: false,
      xLabel: "Hours into workday",
      domain: [0, 9],
      categoryWidth: 78,
      style: { color: "var(--chart-4)", thickness: 22, radius: 7 },
      rangeLabelField: "focusHoursLabel",
    },
  },
  {
    id: "team-capacity-mix",
    queryId: "team_capacity_mix",
    title: "Capacity mix",
    description: "How each team divides its available time across core work.",
    breakdown: ["team", "workType"],
    height: 250,
    spec: {
      type: "horizontalStackedBar100",
      x: "team",
      y: "share",
      series: "workType",
      colors: {
        "Product work": "var(--chart-1)",
        Reliability: "color-mix(in srgb, var(--chart-1) 76%, var(--surface))",
        Support: "color-mix(in srgb, var(--chart-1) 52%, var(--surface))",
        Planning: "color-mix(in srgb, var(--chart-1) 28%, var(--surface))",
      },
      showXAxisLabel: false,
      showYAxisLabel: false,
      showLegend: true,
      yAxisPosition: "left",
    },
  },
];

const standardBarCharts = [
  ...axisCharts,
  teamCharts.find(({ id }) => id === "team-capacity-mix"),
  axislessCharts.find(({ id }) => id === "funnel"),
].filter(Boolean);

const experimentalCatalogCharts = [
  ...teamCharts.filter(({ experimentalBarSpec }) => experimentalBarSpec),
  ...axislessCharts.filter(({ experimentalBarSpec }) => experimentalBarSpec),
];

const adoptionMetricDefinitions = [
  {
    id: "active-teams",
    title: "Active teams",
    queryId: "weekly_activity",
    field: "activeTeams",
    color: "var(--chart-1)",
    chart: { type: "line", x: "week", y: "activeTeams" },
    comparison: "+5.5%",
    format: (value) => new Intl.NumberFormat().format(value),
  },
  {
    id: "completed-tasks",
    title: "Completed tasks",
    queryId: "weekly_activity",
    field: "completedTasks",
    color: "var(--chart-5)",
    chart: { type: "area", x: "week", y: "completedTasks" },
    comparison: "+5.6%",
    format: (value) => new Intl.NumberFormat().format(value),
  },
  {
    id: "tasks-per-team",
    title: "Tasks per team",
    queryId: "weekly_activity",
    field: "tasksPerTeam",
    color: "var(--chart-2)",
    chart: { type: "bar", x: "week", y: "tasksPerTeam" },
    comparison: "Stable",
    tone: "neutral",
    format: (value) => new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value),
  },
  {
    id: "team-mix",
    title: "Team mix",
    queryId: "weekly_composition",
    field: "activeTeams",
    color: "var(--chart-3)",
    chart: { type: "stackedArea", x: "week", y: "activeTeams", series: "plan", colors: planColors },
    comparison: "+6.1%",
    summarize: (rows) => {
      const lastWeek = rows.at(-1)?.week;
      return rows.filter(({ week }) => week === lastWeek)
        .reduce((total, { activeTeams }) => total + activeTeams, 0);
    },
    format: (value) => new Intl.NumberFormat().format(value),
  },
  {
    id: "segment-score",
    title: "Top segment score",
    queryId: "category_performance",
    field: "value",
    color: "var(--chart-4)",
    chart: { type: "horizontalBar", x: "segment", y: "value", sortOrder: "descending", showValues: true },
    comparison: "Above target",
    summarize: (rows) => Math.max(...rows.map(({ value }) => value)),
    format: (value) => new Intl.NumberFormat().format(value),
  },
];

const formatExperimentalCurrency = (value) => new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
}).format(value);

const goalProgressRows = [
  { goal: "Sleep", value: 7.7, target: 8, unit: "hours", color: "var(--chart-2)" },
  { goal: "Steps", value: 10000, target: 10000, unit: "steps", color: "var(--chart-3)" },
  { goal: "Exercise", value: 30, target: 30, unit: "minutes", color: "var(--chart-7)" },
];

const fleetCashRows = [
  242000, 251400, 250800, 242600, 241900, 256300, 259800,
  254700, 252900, 260400, 269700, 293700, 285600,
].map((balance, index) => ({
  week: `W${index + 1}`,
  balance,
  reserveBase: Math.min(balance, 250000),
  reserveOverflow: Math.max(0, balance - 250000),
}));

const fleetCostRows = [
  { category: "Driver pay", amount: 54900, color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--secondary)" },
  { category: "Fuel", amount: 43700, color: "var(--negative)", textColor: "white" },
  { category: "Vehicle maintenance", amount: 22500, color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--secondary)" },
  { category: "Warehousing", amount: 17800, color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--secondary)" },
  { category: "Insurance", amount: 12900, color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--secondary)" },
  { category: "Software and systems", amount: 9700, color: "color-mix(in srgb, var(--text) 10%, transparent)", textColor: "var(--secondary)" },
];

const pipelineComparisonRows = [
  { period: "This quarter", discovery: 196000, proposal: 402000, commit: 358000, closedWon: 100000 },
  { period: "Last quarter", discovery: 238000, proposal: 352000, commit: 318000, closedWon: 86000 },
];

const pipelineComparisonSeries = [
  { key: "discovery", label: "Discovery", color: "#B5DAF6", comparisonColor: "#DCE1E6" },
  { key: "proposal", label: "Proposal", color: "#75AFE1", comparisonColor: "#C8CDD3" },
  { key: "commit", label: "Commit", color: "#3475BD", comparisonColor: "#AEB5BE" },
  { key: "closedWon", label: "Closed Won", color: "#91CFAB", comparisonColor: "#8E98A4" },
];

const dayComparisonRows = [
  { day: "Saturday", steps: 3830, color: "var(--chart-4)", textColor: "white" },
  { day: "Sunday", steps: 6654, color: "color-mix(in srgb, var(--text) 9%, transparent)", textColor: "var(--text)" },
];

const spendRows = [
  { category: "Rent and utilities", amount: 678, total: 1724, color: "#075F2B" },
  { category: "Groceries", amount: 342, total: 1724, color: "#079447" },
  { category: "Subscriptions", amount: 230, total: 1724, color: "#4BCB82" },
  { category: "Medical", amount: 176, total: 1724, color: "#8EDCB0" },
  { category: "Miscellaneous", amount: 144, total: 1724, color: "#91C5F4" },
  { category: "Transit", amount: 91, total: 1724, color: "#4CA4E8" },
  { category: "Saving", amount: 63, total: 1724, color: "#167DC1" },
];

const spendCompositionRow = {
  period: "January",
  rent: 678,
  groceries: 342,
  subscriptions: 230,
  medical: 176,
  miscellaneous: 144,
  transit: 91,
  saving: 63,
};

const spendSeries = [
  { key: "rent", label: "Rent and utilities", color: "#075F2B" },
  { key: "groceries", label: "Groceries", color: "#079447" },
  { key: "subscriptions", label: "Subscriptions", color: "#4BCB82" },
  { key: "medical", label: "Medical", color: "#8EDCB0" },
  { key: "miscellaneous", label: "Miscellaneous", color: "#91C5F4" },
  { key: "transit", label: "Transit", color: "#4CA4E8" },
  { key: "saving", label: "Saving", color: "#167DC1" },
];

const portfolioRows = [
  { category: "Stocks", amount: 45320, total: 100937, color: "#075F2B" },
  { category: "ETFs", amount: 24225, total: 100937, color: "#079447" },
  { category: "Bonds", amount: 18500, total: 100937, color: "#4BCB82" },
  { category: "Crypto", amount: 7893, total: 100937, color: "#8EDCB0" },
  { category: "Cash", amount: 4999, total: 100937, color: "#91C5F4" },
];

const portfolioPieSpec = {
  type: "pie",
  x: "category",
  y: "amount",
  currency: "USD",
  valueDecimals: 0,
  showLegend: false,
  colors: Object.fromEntries(portfolioRows.map(({ category, color }) => [category, color])),
};

function ExperimentalBarExamples({ catalog }) {
  const [pipelineLabelsRight, setPipelineLabelsRight] = useState(false);
  const progressSpec = {
    presentation: "progress",
    category: "goal",
    value: "value",
    track: { max: "target" },
    unitField: "unit",
    format: { maximumFractionDigits: 1 },
    style: { colorField: "color", thickness: 3, gap: 16, fontSize: 14 },
  };
  const comparisonSpec = {
    presentation: "comparison",
    category: "day",
    value: "steps",
    labels: { position: "above", suffix: " steps" },
    style: { colorField: "color", textColorField: "textColor", thickness: 32, radius: 6, gap: 18, fontSize: 14 },
    format: { maximumFractionDigits: 0 },
  };
  const categoryProgressSpec = {
    presentation: "progress",
    category: "category",
    value: "amount",
    track: { max: "total" },
    labels: { value: "formatted" },
    style: { colorField: "color", thickness: 5, gap: 15, fontSize: 14 },
    format: { style: "currency", currency: "USD", maximumFractionDigits: 0 },
  };

  return <section className="experimental-bar-examples" aria-labelledby="experimental-bar-examples-title">
    <SectionHeader id="experimental-bar-examples-title" as="h2"
      title="Bar examples in context" description="Compositions and styling variations built with the shared Chart API." />
    <div className="experimental-bar-examples-grid">
      <DataComponent id="experimental-daily-goals" queryId="experimental_bar_examples" kind="custom" title="Today’s goals"
        description="Compact goal completion tracks." displayRows={goalProgressRows} sourceRows={goalProgressRows}
        variant="card" padding="spacious">
        <Chart rows={goalProgressRows} spec={barChartSpec(progressSpec)} />
      </DataComponent>
      <DataComponent id="experimental-day-comparison" queryId="experimental_bar_examples" kind="custom" title="Steps"
        description="You took 2,824 more steps yesterday than the day before."
        displayRows={dayComparisonRows} sourceRows={dayComparisonRows} variant="card" padding="spacious">
        <Chart rows={dayComparisonRows} spec={barChartSpec(comparisonSpec)} />
      </DataComponent>
      <DataComponent id="experimental-spend-composition" queryId="experimental_bar_examples" kind="custom" title="Spend by category"
        description="January spending shown as a total composition and category-level progress."
        displayRows={spendRows} sourceRows={spendRows} variant="card" padding="spacious">
        <div className="experimental-bar-example-summary"><span>January</span><strong>{formatExperimentalCurrency(spendRows.reduce((sum, row) => sum + row.amount, 0))}</strong></div>
        <Chart rows={[spendCompositionRow]} spec={barChartSpec({
          presentation: "segmented",
          category: "period",
          series: spendSeries,
          style: { thickness: 44, radius: 10, segmentGap: 3 },
        })} />
        <Chart rows={spendRows} spec={barChartSpec(categoryProgressSpec)} />
      </DataComponent>
      <DataComponent id="experimental-portfolio-distribution" queryId="experimental_bar_examples" kind="custom" title="Portfolio distribution"
        description="Five holdings across three accounts." displayRows={portfolioRows} sourceRows={portfolioRows}
        variant="card" padding="spacious">
        <div className="experimental-bar-example-summary"><span>Current allocation</span><strong>{formatExperimentalCurrency(portfolioRows.reduce((sum, row) => sum + row.amount, 0))}</strong></div>
        <div className="experimental-portfolio-layout">
          <Chart spec={portfolioPieSpec} rows={portfolioRows} height={260} />
          <Chart rows={portfolioRows} spec={barChartSpec(categoryProgressSpec)} />
        </div>
      </DataComponent>
      <DataComponent id="experimental-fleet-cash" queryId="experimental_bar_examples" kind="custom"
        title="Fleet cash balance" description="Weekly cash balance compared with the operating reserve target."
        displayRows={fleetCashRows} sourceRows={fleetCashRows} variant="card" padding="spacious">
        <div className="experimental-bar-example-summary">
          <span>Target {formatExperimentalCurrency(250000)}</span>
          <strong>{formatExperimentalCurrency(fleetCashRows.at(-1).balance)}</strong>
        </div>
        <Chart rows={fleetCashRows} height={220} spec={barChartSpec({
          category: "week",
          value: "balance",
          series: [
            { key: "reserveBase", label: "Reserve", color: "color-mix(in srgb, var(--text) 13%, transparent)", stackId: "cash" },
            { key: "reserveOverflow", label: "Over target", color: "var(--negative)", stackId: "cash" },
          ],
          tooltipFields: [
            { key: "balance", label: "Value", color: "color-mix(in srgb, var(--text) 13%, transparent)" },
            { key: "reserveOverflow", label: "Over target", color: "var(--negative)" },
          ],
          markers: [{ value: 250000, label: "Target", color: "var(--secondary)" }],
          axes: { category: true, value: false },
          grid: false,
          domain: [0, 320000],
          style: { thickness: 24, radius: 3 },
          barCategoryGap: "12%",
          format: { style: "currency", currency: "USD", maximumFractionDigits: 0 },
        })} />
      </DataComponent>
      <DataComponent id="experimental-fleet-costs" queryId="experimental_bar_examples" kind="custom"
        title="Costs by category" description="Latest weekly fleet operating costs by category."
        displayRows={fleetCostRows} sourceRows={fleetCostRows} variant="card" padding="spacious">
        <p className="experimental-fleet-cost-insight">Fuel costs have risen <strong>2.5×</strong> this week</p>
        <Chart rows={fleetCostRows} spec={barChartSpec({
          presentation: "rankedList",
          category: "category",
          value: "amount",
          style: { colorField: "color", textColorField: "textColor", thickness: 28, radius: 5, gap: 12 },
          format: { style: "currency", currency: "USD", notation: "compact", minimumFractionDigits: 1, maximumFractionDigits: 1 },
        })} />
      </DataComponent>
      <DataComponent id="experimental-pipeline-comparison" queryId="experimental_bar_examples" kind="custom"
        title="Pipeline by stage" description="This quarter compared with last quarter across each pipeline stage."
        displayRows={pipelineComparisonRows} sourceRows={pipelineComparisonRows} variant="card" padding="spacious"
        className="experimental-bar-example--wide">
        <div className="experimental-pipeline-controls">
          <Switch label="Right-align labels" checked={pipelineLabelsRight} onChange={setPipelineLabelsRight} />
        </div>
        <Chart rows={pipelineComparisonRows} spec={barChartSpec({
          presentation: "segmented",
          category: "period",
          series: pipelineComparisonSeries,
          comparison: true,
          annotations: "auto",
          labels: { align: pipelineLabelsRight ? "right" : "left" },
          style: { thickness: 36, radius: 7, roundedSegments: true, segmentGap: 2, fontSize: 14 },
          format: { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 0 },
        })} />
      </DataComponent>
    </div>
    <SectionHeader id="experimental-bar-catalog-title" as="h3"
      title="Additional bar variations" description="Reusable bar layouts built with Chart." />
    {catalog}
  </section>;
}

function DisclosurePlayground() {
  return <section className="component-lab-disclosure-playground"
    aria-label="Executive summary component">
    <ExecutiveSummary preview="307 active teams · 659 completed tasks · 2.15 tasks per team">
      <p><strong>Product adoption continued to grow.</strong> Active teams and completed tasks both increased during the selected period.</p>
      <p><strong>Task volume remains healthy.</strong> Teams completed an average of 2.15 tasks each.</p>
    </ExecutiveSummary>
  </section>;
}

const feedbackFlowColumns = [
  { field: "feedbackSource", label: "Feedback sources" },
  { field: "theme", label: "Themes" },
  { field: "feature", label: "Features" },
  { field: "roadmap", label: "Priority" },
];
const feedbackFlowStages = feedbackFlowColumns.map(({ field }) => field);
const feedbackFlowPriorityColors = {
  Prioritized: "var(--chart-1)",
  Backlog: "var(--secondary)",
  Unplanned: "var(--negative)",
};
const feedbackFlowPriorityValues = Object.keys(feedbackFlowPriorityColors);
const feedbackFlowChart = {
  type: "sankey",
  x: "feedbackSource",
  y: "mentions",
  stages: feedbackFlowStages,
  showLegend: false,
  showValues: true,
  labelMaxLength: 14,
  sankeyNodeWidth: 18,
  sankeyLabelFontSize: 13,
  sankeyValueFontSize: 11,
  colors: {
    feedbackSource: "var(--chart-2)",
    theme: "var(--chart-4)",
    feature: "var(--chart-3)",
    ...feedbackFlowPriorityColors,
  },
};

function PriorityFilter({ selected, onChange }) {
  return <div className="component-lab-priority-picker"><SegmentedControl size="default" className="component-lab-priority-filter"
    ariaLabel="Priority filters" selectionMode="multiple" value={selected.length ? selected : ["all"]}
    onChange={values => onChange(values.includes("all") && selected.length ? [] : values.filter(value => value !== "all"))}
    options={[{ value: "all", label: "All priorities" }, ...feedbackFlowPriorityValues.map((priority) => ({
      value: priority,
      ariaLabel: priority,
      label: <><span className="component-lab-priority-filter-dot" aria-hidden="true"
        style={{ "--priority-color": feedbackFlowPriorityColors[priority] }} /><span className="data-segmented-control-label">{priority}</span></>,
    }))]} /><div className="component-lab-priority-dropdown"><Dropdown label="Priority" showLabel multiple value={selected}
      choices={["all", ...feedbackFlowPriorityValues]} onChange={onChange} /></div></div>;
}

function LabExamples({ view: activeTabId }) {
  const [selectedAdoptionMetric, setSelectedAdoptionMetric] = useState("active-teams");
  const [metricTabSize, setMetricTabSize] = useState("medium");
  const [metricTabOrientation, setMetricTabOrientation] = useState("horizontal");
  const [feedbackFlowFilters, setFeedbackFlowFilters] = useState(() => Object.fromEntries(
    feedbackFlowColumns.map(({ field }) => [field,
    []]),
  ));
  const {
    snapshot: dashboard,
    queries,
    filters,
    setFilter,
    chartOverrides,
    chartProps,
    reviewedRows,
    visible,
  } = useDataApp();

  const weeklyActivity = reviewedRows("weekly_activity", ["week"]);
  const weeklyComposition = reviewedRows("weekly_composition", ["week", "plan"]);
  const categoryPerformance = reviewedRows("category_performance", ["segment"]);
  const feedbackFlowRows = reviewedRows("feedback_roadmap", feedbackFlowStages);
  const matchesFeedbackFlowFilters = (row, selections, skippedField) => feedbackFlowColumns.every(({ field }) => {
    if (field === skippedField) return true;
    const selected = selections[field] ?? [];
    return !selected.length || selected.includes(row[field]);
  });
  const feedbackFlowChoices = Object.fromEntries(feedbackFlowColumns.map(({ field }) => [
    field,
    [...new Set(feedbackFlowRows
      .filter((row) => matchesFeedbackFlowFilters(row, feedbackFlowFilters, field))
      .map((row) => row[field])
      .filter((value) => value != null && value !== ""))],
  ]));
  const filteredFeedbackFlowRows = feedbackFlowRows.filter((row) =>
    matchesFeedbackFlowFilters(row, feedbackFlowFilters));
  const feedbackFlowHasFeatures = !filteredFeedbackFlowRows.length
    || filteredFeedbackFlowRows.some((row) => row.feature != null && row.feature !== "");
  const changeFeedbackFlowFilter = (changedField, values) => {
    setFeedbackFlowFilters((current) => {
      const next = { ...current, [changedField]: values };
      if (changedField === "roadmap") return next;
      for (let pass = 0; pass < feedbackFlowColumns.length; pass += 1) {
        let changed = false;
        for (const { field } of feedbackFlowColumns) {
          if (field === changedField || field === "roadmap" || !next[field]?.length) continue;
          const available = new Set(feedbackFlowRows
            .filter((row) => matchesFeedbackFlowFilters(row, next, field))
            .map((row) => row[field])
            .filter((value) => value != null && value !== ""));
          const retained = next[field].filter((value) => available.has(value));
          if (retained.length !== next[field].length) {
            next[field] = retained;
            changed = true;
          }
        }
        if (!changed) break;
      }
      return next;
    });
  };
  const metricRows = {
    weekly_activity: weeklyActivity,
    weekly_composition: weeklyComposition,
    category_performance: categoryPerformance,
  };
  const adoptionMetrics = adoptionMetricDefinitions.map((definition) => {
    const rows = metricRows[definition.queryId] ?? [];
    const current = definition.summarize?.(rows) ?? rows.at(-1)?.[definition.field];
    return {
      ...definition,
      rows,
      trendValues: rows.slice(-6).map((row) => row[definition.field]).filter(Number.isFinite),
      value: Number.isFinite(current) ? definition.format(current) : "—",
    };
  });
  const catalogById = new Map((queries.chart_catalog?.rows ?? []).map((row) => [row.chartId, row]));
  const filterCharts = (entries) => entries.filter((entry) => {
    const catalogEntry = catalogById.get(entry.id);
    if (!catalogEntry) return true;
    return (dashboard.filters ?? []).every(({ id }) => {
      const selected = filters[id] ?? "all";
      return selected === "all" || catalogEntry[id] === selected;
    });
  });
  const filteredStandardBarCharts = filterCharts(standardBarCharts);
  const filteredExperimentalCharts = filterCharts(experimentalCatalogCharts);

  const renderChart = (entry) => {
    if (!visible(entry.id)) return null;
    const breakdown = entry.breakdown ?? [entry.spec?.x, entry.spec?.series, ...(entry.spec?.stages ?? [])].filter(Boolean);
    const rows = [...reviewedRows(entry.queryId, breakdown), ...(entry.additionalRows ?? [])];
    if (entry.experimentalBarSpec) {
      const chart = chartOverrides[entry.id] ?? barChartSpec(entry.experimentalBarSpec);
      return <SortableItem key={entry.id} id={entry.id} label={entry.title} kind="chart"
        className={entry.className}>
        <DataComponent id={entry.id} queryId={entry.queryId} kind="chart" chart={chart}
          title={entry.title} description={entry.description} displayRows={rows} sourceRows={rows}
          variant="card" padding="spacious">
          <Chart rows={rows} spec={chart} height={entry.height} {...chartProps(entry.id)} />
        </DataComponent>
      </SortableItem>;
    }
    const reviewedChart = chartOverrides[entry.id] ?? entry.spec;
    const chart = { ...reviewedChart, yAxisPosition: reviewedChart.yAxisPosition ?? "right" };
    return <SortableItem key={entry.id} id={entry.id} label={entry.title} kind="chart"
      className={entry.className}>
      <DataComponent id={entry.id} queryId={entry.queryId} kind="chart" chart={chart}
        title={entry.title} description={entry.description} displayRows={rows} sourceRows={rows}
        variant="card" padding="spacious">
        <Chart spec={chart} rows={rows} height={entry.height} {...chartProps(entry.id)} />
      </DataComponent>
    </SortableItem>;
  };

  return <div className="lab-composed-examples">
    {activeTabId === "overview" && <SectionHeader id="component-lab-compositions" as="h2" title="Composed examples" filters={<>
      <SegmentedControl ariaLabel="Metric tab density" value={metricTabSize}
        options={[
          { value: "small", label: "Compact" },
          { value: "medium", label: "Comfortable" },
          { value: "large", label: "Spacious" },
        ]} onChange={setMetricTabSize} />
      <SegmentedControl ariaLabel="Metric tab orientation" value={metricTabOrientation}
        options={[
          { value: "horizontal", label: "Horizontal" },
          { value: "vertical", label: "Vertical" },
        ]} onChange={setMetricTabOrientation} />
    </>} />}
    {activeTabId === "overview" && <>
      <DisclosurePlayground />
      <MetricCardTabs
        size={metricTabSize} orientation={metricTabOrientation}
        ariaLabel="Product adoption metric" items={adoptionMetrics}
        selectedId={selectedAdoptionMetric} onChange={setSelectedAdoptionMetric}>
        {({ item }) => {
          const chart = {
            ...item.chart,
            showLegend: false,
            showXAxisLabel: false,
            showYAxisLabel: false,
            colors: item.chart.colors ?? { [item.field]: item.color },
          };
          const componentId = `adoption-metric-${item.id}`;
          return <DataComponent id={componentId} queryId={item.queryId} kind="chart"
            chart={chart} title={item.title}
            description={`${item.title} across the reviewed data.`}
            displayRows={item.rows} sourceRows={item.rows} variant="plain">
            <Chart spec={chart} rows={item.rows} height={280}
              {...chartProps(componentId)} />
          </DataComponent>;
        }}
      </MetricCardTabs>
      <DataComponent id="feedback-roadmap-flow" queryId="feedback_roadmap" kind="chart"
      chart={feedbackFlowChart} title="From feedback to roadmap"
      description="Feedback sources flow into shared themes, then features, and finally priority. Unplanned feedback skips the feature column instead of inventing one."
      displayRows={filteredFeedbackFlowRows} sourceRows={filteredFeedbackFlowRows}
      className="component-lab-feedback-flow" variant="card" padding="spacious">
      <div className="component-lab-feedback-flow-filters" role="group" aria-label="Feedback flow filters"
        data-has-features={feedbackFlowHasFeatures}>
        {feedbackFlowColumns.slice(0, -1).map(({ field, label }) => <div
          className="component-lab-feedback-flow-filter" data-flow-column={field} key={field}>
          <Dropdown searchable multiple showLabel label={label} value={feedbackFlowFilters[field]}
            choices={["all", ...feedbackFlowChoices[field]]}
            onChange={(values) => changeFeedbackFlowFilter(field, values)} />
        </div>)}
        <PriorityFilter selected={feedbackFlowFilters.roadmap}
          onChange={(priorities) => changeFeedbackFlowFilter("roadmap", priorities)} />
      </div>
      <Chart spec={feedbackFlowChart} rows={filteredFeedbackFlowRows}
        height="clamp(560px, calc(100dvh - 220px), 900px)"
        {...chartProps("feedback-roadmap-flow")} />
      </DataComponent>
    </>}
    {activeTabId === "bar-experiments" && <>
      <Filters filters={dashboard.filters ?? []} queries={queries} values={filters}
        onChange={setFilter} ariaLabel="Bar chart filters" />
      <section className="component-lab-chart-section" aria-labelledby="standard-bar-charts-title">
        <SectionHeader id="standard-bar-charts-title" as="h2" title="Standard bar charts"
          description="Established ChartRenderer bar, histogram, stacked, ranked, and funnel layouts." />
        <SortableRegion id="component-lab:standard-bars" label="Standard bar charts" variant="freeform"
          className="component-lab-grid">
          {filteredStandardBarCharts.map(renderChart)}
        </SortableRegion>
        {!filteredStandardBarCharts.length && <p className="lab-catalog-empty">No standard charts match these filters. <button type="button"
          onClick={() => { setFilter("family", "all"); setFilter("chartType", "all"); }}>Clear catalog filters</button></p>}
      </section>
      <ExperimentalBarExamples catalog={filteredExperimentalCharts.length ?
        <SortableRegion id="component-lab:experimental-bars" label="Experimental bar charts" variant="freeform"
          className="component-lab-grid">
          {filteredExperimentalCharts.map(renderChart)}
        </SortableRegion> : <p className="lab-catalog-empty">No experimental charts match these filters. <button type="button"
          onClick={() => { setFilter("family", "all"); setFilter("chartType", "all"); }}>Clear catalog filters</button></p>
      } />
    </>}
  </div>;
}

export function ComponentLab() {
  useDashboardTabs([
    { id: "inventory", label: "Inventory", aliases: ["overview", "bar-experiments"], previousLabels: ["Overview", "Bar chart experiments"] },
  ]);
  return <article className="page component-lab-page" data-dashboard-layout="full-width">
    <LibraryInventory
      barExamples={<LabExamples view="bar-experiments" />}
      composedExamples={<LabExamples view="overview" />} />
  </article>;
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DataAppShell snapshot={snapshot} hosted={false}><ComponentLab /></DataAppShell>
  </React.StrictMode>,
);
