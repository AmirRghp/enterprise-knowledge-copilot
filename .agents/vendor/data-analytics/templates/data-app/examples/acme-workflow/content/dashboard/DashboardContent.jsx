import { exampleLabels } from "./example-labels.js";
import React, { useState } from "react";

import {
  Chart,
  EvidenceChart,
  barChartSpec,
  DataComponent,
  Filters,
  Icon,
  Menu,
  SortableItem,
  SortableRegion,
  SectionHeader,
  SectionNavigator,
  SegmentedControl,
  Slider,
  Switch,
  Table,
  useDataApp,
  useDashboardTabs,
} from "../../data-app-public.jsx";
import "./example.css";

// Keep editing within the analytical section that owns each card's controls.
function ChartGrid({ id, columns = 2, className = "", children }) {
  const { snapshot } = useDataApp();
  const cards = React.Children.toArray(children);
  const rows = Array.from({ length: Math.ceil(cards.length / columns) }, (_, index) => ({
    id: `${id}:row:${index + 1}`, items: cards.slice(index * columns, (index + 1) * columns).map(card => card.props.id),
  }));
  return <SortableRegion id={id} label="Section charts" variant="canvas" columns={12} rows={rows}
    className={`plugin-editable-grid ${className}`} style={{ "--block-layout-row-gap": "var(--plugin-grid-gap)", "--block-layout-column-gap": "var(--plugin-grid-gap)" }}>
    {cards.map(card => <SortableItem key={card.props.id} id={card.props.id} label={exampleLabels(card.props.title, snapshot.exampleLabels)}
      kind="chart" span={12 / columns} minSpan={3}>{card}</SortableItem>)}
  </SortableRegion>;
}

const timeToSkillColors = {
  "Within 1 hour": "#1859B7",
  "1–6 hours": "#3478D4",
  "6–24 hours": "#5B95E5",
  "Day 1": "#8AB8F8",
  "Days 2–3": "#B9D5FF",
  "Days 4–7": "#DCEBFF",
};

const monthlyCohortPalettes = {
  Jun: ["#DCEBFF", "#B7D4FF", "#8DBAFF", "#5F9BF4", "#2F78D6"],
  Jul: ["#FFE5CC", "#FFC894", "#FFA35C", "#F47B30", "#C94F10"],
  Aug: ["#D5F5EE", "#A8E5D8", "#72CFBE", "#3BB39E", "#16836F"],
};

const planThemeOrder = ["Free", "Pro Lite", "Plus", "Pro", "Business", "Enterprise", "Other", "Edu"];
const planThemeColors = {
  Free: "#DCEBFF",
  "Pro Lite": "#8DBAFF",
  Plus: "#3478D4",
  Pro: "#1859B7",
  Business: "#A78BFA",
  Enterprise: "#6D28D9",
  Other: "#FBCFE8",
  Edu: "#DB2777",
};

const surfaceThemeOrder = [
  "ChatGPT Other", "ChatGPT Mobile — Work", "ChatGPT Web — Work", "ChatGPT Chat",
  "Codex Exec", "Codex IDE", "Codex CLI",
  "Codex Desktop — Work", "Codex Desktop — Codex",
];
const surfaceThemeColors = {
  "ChatGPT Other": "#DCEBFF",
  "ChatGPT Mobile — Work": "#B7D4FF",
  "ChatGPT Web — Work": "#5F9BF4",
  "ChatGPT Chat": "#1859B7",
  "Codex Exec": "#C4B5FD",
  "Codex IDE": "#8B5CF6",
  "Codex CLI": "#5B21B6",
  "Codex Desktop — Work": "#F9A8D4",
  "Codex Desktop — Codex": "#DB2777",
};

const flowSkillGroups = [
  {
    label: "Analyze",
    color: "var(--chart-1)",
    skills: [
      "data-analytics:product-business-analysis", "data-analytics:metric-diagnostics",
      "data-analytics:gather-business-context",
      "data-analytics:validate-data", "data-analytics:analyze-data-quality",
      "data-analytics:design-kpis", "data-analytics:market-sizing",
      "data-analytics:kpi-reporting",
    ],
  },
  {
    label: "Artifacts",
    color: "var(--chart-2)",
    skills: [
      "data-analytics:visualize-data", "data-analytics:build-dashboard",
      "data-analytics:build-report",
    ],
  },
  {
    label: "Output",
    color: "var(--chart-4)",
    skills: [
      "data-analytics:jupyter-notebooks", "data-analytics:create-data-context",
      "data-analytics:convert-to-slides", "data-analytics:publish-artifact-to-sites",
      "data-analytics:convert-to-doc",
    ],
  },
  {
    label: "Other",
    color: "#8F8F8F",
    skills: ["data-analytics:index", "Other skill combination", "No skill"],
  },
];

const flowSkillColors = {
  conversationType: "#B8BEC7",
  contextStatus: "#C9CED5",
  ...Object.fromEntries(flowSkillGroups.flatMap(({ color, skills }) =>
    skills.map((skill) => [skill, color]))),
  "Other skill combination": "#C9CDD3",
  "No skill": "#C9CDD3",
};

function cohortColor(value) {
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(String(value))
    ? new Date(`${value}T00:00:00Z`) : new Date(`${value}, 2026 00:00:00 UTC`);
  if (!Number.isFinite(date.getTime())) return "var(--plugin-primary)";
  const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(date);
  const palette = monthlyCohortPalettes[month] ?? monthlyCohortPalettes.Jun;
  return palette[Math.min(palette.length - 1, Math.floor((date.getUTCDate() - 1) / 7))];
}

const activationCohortRamp = ["#DCEBFF", "#B7D4FF", "#8DBAFF", "#5F9BF4", "#2F78D6", "#1859B7"];

function activationCohortColors(values) {
  const ordered = [...new Set(values)].sort((left, right) => Date.parse(left) - Date.parse(right));
  return Object.fromEntries(ordered.map((value, index) => [
    value,
    activationCohortRamp[Math.round(index * (activationCohortRamp.length - 1) / Math.max(1, ordered.length - 1))],
  ]));
}

const chartSpecs = {
  installedUsers: {
    type: "line", x: "date", y: "installedUsers", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    yAxisPosition: "right",
    colors: { installedUsers: "var(--plugin-primary)" },
  },
  installSurfaces: {
    type: "line", x: "date", y: "value", series: "metric",
    showLegend: true, showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    yAxisPosition: "right",
    dashedFields: ["Codex · distinct users", "ChatGPT · distinct users"],
    colors: {
      "Codex · install records": "#1570EF",
      "Codex · distinct users": "#1570EF",
      "ChatGPT · install records": "#E04F16",
      "ChatGPT · distinct users": "#E04F16",
    },
  },
  dailyInstalls: {
    type: "line", x: "date", y: "installs", fields: ["installs", "negativeUninstalls", "uninstallRate"],
    barFields: ["installs", "negativeUninstalls"], showLegend: true,
    rightAxisFields: ["installs", "negativeUninstalls"], yAxisPosition: "right",
    axisPercentDigits: 0,
    showXAxisLabel: false, showYAxisLabel: false,
    colors: {
      installs: "#3B82F6",
      negativeUninstalls: "#CFE4FF",
      uninstallRate: "#FF6B00",
    },
  },
  installsByCohort: {
    type: "stackedBar100", x: "date", y: "installs", series: "cohort",
    showLegend: true, showXAxisLabel: false, showYAxisLabel: false,
    yAxisPosition: "right",
    axisPercentDigits: 0,
    colors: {
      Established: "#E8ECF2",
      "Joined in last 90d": "#B7D4FF",
      "New this week": "#1570EF",
    },
  },
  installsByRole: {
    type: "bar", x: "role", y: "installBaseShare", fields: ["installBaseShare", "l7ActiveShare"],
    sortOrder: "original", yAxisPosition: "right",
    showLegend: true, showXAxisLabel: false, showYAxisLabel: false, format: "percent",
    axisPercentDigits: 0,
    colors: { installBaseShare: "var(--plugin-secondary)", l7ActiveShare: "#69A7FF" },
  },
  newUserInstallRate: {
    type: "line", x: "date", y: "d1InstallRate", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    format: "percent", colors: { d1InstallRate: "var(--plugin-primary)" },
    yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  d7Activation: {
    type: "line", x: "date", y: "d7ActivationRate", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    format: "percent", colors: { d7ActivationRate: "var(--plugin-primary)" },
    yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  activationBySurface: {
    type: "line", x: "date", y: "activationRate", series: "surface", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    format: "percent", colors: { Codex: "var(--plugin-primary)", ChatGPT: "var(--plugin-secondary)" },
    yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  sameDayActivation: {
    type: "line", x: "date", y: "sameDayActivationRate", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false,
    format: "percent", colors: { sameDayActivationRate: "var(--plugin-tertiary)" },
    yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  activationCohorts: {
    type: "line", x: "week", y: "activationRate", series: "cohort", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: false, format: "percent",
    yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  timeToSkill: {
    type: "horizontalStackedBar100", x: "pluginLabel", y: "users", series: "timeBucket",
    showLegend: false, showXAxisLabel: false, showYAxisLabel: false, showValues: false,
    showCategoryTicks: false,
    markRadius: 6, markStartRadius: 6,
    axisPercentDigits: 0,
    colors: timeToSkillColors,
  },
  dau: {
    type: "line", x: "date", y: "dau", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: { dau: "var(--plugin-primary)" },
  },
  wau: {
    type: "line", x: "date", y: "wau", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: { wau: "var(--plugin-primary)" },
  },
  stickiness: {
    type: "line", x: "date", y: "stickiness", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true, format: "percent",
    yAxisPosition: "right",
    axisPercentDigits: 0,
    colors: { stickiness: "var(--plugin-primary)" },
  },
  wauByPlan: {
    type: "line", x: "date", y: "wau", series: "plan", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: planThemeColors,
  },
  wauMixByPlan: {
    type: "stackedArea", x: "date", y: "wauShare", series: "plan", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true, format: "percent",
    axisPercentDigits: 0,
    colors: planThemeColors,
  },
  wauBySurface: {
    type: "line", x: "date", y: "wau", series: "surface", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: surfaceThemeColors,
  },
  dailyTurns: {
    type: "bar", x: "date", y: "dailyTurns", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    colors: { dailyTurns: "var(--plugin-primary)" },
  },
  weeklyTurns: {
    type: "bar", x: "date", y: "weeklyTurns", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    colors: { weeklyTurns: "var(--plugin-primary)" },
  },
  turnsPerWau: {
    type: "line", x: "date", y: "value", series: "metric", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: { Avg: "var(--plugin-primary)", P50: "var(--chart-4)", P90: "var(--chart-5)" },
  },
  dailyConversations: {
    type: "bar", x: "date", y: "dailyConversations", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    colors: { dailyConversations: "var(--plugin-primary)" },
  },
  weeklyConversations: {
    type: "bar", x: "date", y: "weeklyConversations", showLegend: false,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    colors: { weeklyConversations: "var(--plugin-primary)" },
  },
  conversationsPerWau: {
    type: "line", x: "date", y: "value", series: "metric", showLegend: true,
    showXAxisLabel: false, showYAxisLabel: false, startAtZero: true,
    yAxisPosition: "right",
    colors: { Avg: "var(--plugin-primary)", P50: "var(--chart-4)", P90: "var(--chart-5)" },
  },
  weeklyRetention: {
    type: "line", x: "week", y: "retention", series: "cohort", showLegend: true,
    showXAxisLabel: true, showYAxisLabel: false, startAtZero: true, format: "percent",
    xLabel: "Weeks since activation", yAxisPosition: "right",
    axisPercentDigits: 0,
  },
  retentionTriangle: {
    type: "heatmap", x: "weekLabel", y: "retention", series: "cohortShortLabel",
    tooltipFields: [{ field: "cohortShortLabel", label: "Cohort" }],
    showXAxisLabel: false, showYAxisLabel: false, format: "percent",
    hideMissingCells: true, rowHeight: 40,
    colorBands: [
      { max: 0.10, color: "#B42318", label: "<10%" },
      { max: 0.15, color: "#D92D20", label: "10–15%" },
      { max: 0.20, color: "#F97066", label: "15–20%" },
      { max: 0.235, color: "#DCEBFF", label: "20–23.5%" },
      { max: 0.27, color: "#B9D5FF", label: "23.5–27%" },
      { max: 0.30, color: "#8AB8F8", label: "27–30%" },
      { max: 0.35, color: "#5B95E5", label: "30–35%" },
      { max: 0.40, color: "#3478D4", label: "35–40%" },
      { color: "#1859B7", label: "40%+" },
    ],
  },
  firstConversation: {
    type: "sankey", x: "conversationType", y: "users",
    stages: ["conversationType", "contextStatus", "skill"],
    showLegend: false, showValues: true, labelMaxLength: 40, sankeyLabelFontSize: 14,
    sankeyLinkColorMode: "target", sankeyTerminalLabelAlignment: "right",
    sankeySortNodes: false, colors: flowSkillColors,
  },
};

const flowColumns = [
  { field: "conversationType", label: "First conversation" },
  { field: "contextStatus", label: "User context" },
  { field: "skill", label: "First skill" },
  { field: "users", label: "Users" },
  { field: "share", label: "Share", format: "percent" },
];

const chartHeights = {
  comfortable: {
    standard: 238,
    continuation: 270,
    flow: 480,
    retentionLine: 340,
    retentionTriangle: 520,
  },
  maximum: {
    standard: 140,
    continuation: 160,
    flow: 300,
    retentionLine: 200,
    retentionTriangle: 340,
  },
};

const DEFAULT_CRUNCH = 0;
const DENSITY_OPTIONS = [{ value: 40, label: "Compact" }, { value: 0, label: "Default" }, { value: -20, label: "Spacious" }];
const DensityContext = React.createContext(chartHeights.comfortable);

function scaledDensityValue(comfortable, maximum, crunch) {
  return comfortable - (comfortable - maximum) * (crunch / 100);
}

function densityVariables(crunch) {
  return {
    "--plugin-grid-gap": `${scaledDensityValue(20, 6, crunch)}px`,
    "--plugin-section-gap": `${scaledDensityValue(48, 16, crunch)}px`,
    "--plugin-section-heading-gap": `${scaledDensityValue(20, 8, crunch)}px`,
    "--plugin-chart-card-height": `${scaledDensityValue(322, 180, crunch)}px`,
    "--plugin-chart-card-three-column-height": `${scaledDensityValue(318, 180, crunch)}px`,
    "--plugin-activity-plot-height": `${scaledDensityValue(238, 140, crunch)}px`,
    "--plugin-chart-card-continuation-height": `${scaledDensityValue(354, 210, crunch)}px`,
    "--plugin-flow-card-height": `${scaledDensityValue(590, 360, crunch)}px`,
    "--plugin-retention-line-height": `${scaledDensityValue(474, 280, crunch)}px`,
    "--plugin-retention-triangle-height": `${scaledDensityValue(650, 400, crunch)}px`,
  };
}

function SettingsMenu({ value, onChange, uncarded, onUncardedChange, gutter, onGutterChange }) {
  return <Menu label="Dashboard settings" align="end" contentClassName="plugin-settings-menu"
    trigger={<button type="button" className="icon-button plugin-settings-trigger" aria-label="Dashboard settings" title="Dashboard settings">
      <Icon name="settings" size={20} />
    </button>}>
      <div className="menu-group-label">Density</div>
      <SegmentedControl className="plugin-density-options" ariaLabel="Dashboard density"
        value={value} fullWidth options={DENSITY_OPTIONS} onChange={onChange} />
      <Switch className="crunch-switch-row" label="Cards" checked={!uncarded}
        onChange={(checked) => onUncardedChange(!checked)} />
      {uncarded && <Slider className="uncarded-gutter-control" label="Gutter"
        min={0} max={32} step={4} value={gutter} onChange={onGutterChange}
        formatValue={(amount) => `${amount}px`} />}
  </Menu>;
}

function ChartCard({ id, queryId, title, description, spec, rows, sourceRows, height, className = "" }) {
  const { snapshot } = useDataApp();
  const densityHeights = React.useContext(DensityContext);
  return <EvidenceChart variant="card" id={id} queryId={queryId} spec={spec}
    title={exampleLabels(title, snapshot.exampleLabels)} description={exampleLabels(description, snapshot.exampleLabels)} rows={rows} sourceRows={sourceRows}
    height={height ?? densityHeights.standard} className={`plugin-chart-card ${className}`.trim()} />;
}

const pageSections = [
  { id: "installs-heading", label: "Installs" },
  { id: "activation-heading", label: "Activation" },
  { id: "flow-heading", label: "First Conversation Skill Flow" },
  { id: "activity-heading", label: "Activity" },
  { id: "retention-heading", label: "Retention" },
];

const defaultPresentation = { chartSpecs, surfaceThemeOrder, flowSkillGroups };

export function DashboardContent() {
  const {
    snapshot: dashboard,
    queries,
    filters,
    setFilter,
    reviewedRows,
    chartOverrides,
    chartProps,
    appTitle, setAppTitle,
  } = useDataApp();
  React.useEffect(() => {
    if (dashboard.status === "fixture" && dashboard.id === "acme-workflow-adoption"
      && appTitle === "Acme Cloud · Workflow adoption") setAppTitle(dashboard.title);
  }, [dashboard.id, dashboard.status, dashboard.title, appTitle, setAppTitle]);
  useDashboardTabs([{ id: "deep-dive", label: exampleLabels("Plugin deep dive", dashboard.exampleLabels),
    ...(dashboard.exampleLabels ? { previousLabels: ["Plugin deep dive", "Workflow adoption"] } : {}) }]);
  const { chartSpecs, surfaceThemeOrder, flowSkillGroups } = React.useMemo(
    () => exampleLabels(defaultPresentation, dashboard.exampleLabels), [dashboard.exampleLabels]);
  const navigationSections = React.useMemo(() => exampleLabels(pageSections, dashboard.exampleLabels), [dashboard.exampleLabels]);
  const [flowView, setFlowView] = useState("chart");
  const [triangleDirection, setTriangleDirection] = useState("left");
  const [crunch, setCrunch] = useState(DEFAULT_CRUNCH);
  const [uncarded, setUncarded] = useState(false);
  const [uncardedGutter, setUncardedGutter] = useState(20);
  const densityHeights = React.useMemo(() => ({
    standard: Math.round(scaledDensityValue(chartHeights.comfortable.standard, chartHeights.maximum.standard, crunch)),
    continuation: Math.round(scaledDensityValue(chartHeights.comfortable.continuation, chartHeights.maximum.continuation, crunch)),
    flow: Math.round(scaledDensityValue(chartHeights.comfortable.flow, chartHeights.maximum.flow, crunch)),
    retentionLine: Math.round(scaledDensityValue(chartHeights.comfortable.retentionLine, chartHeights.maximum.retentionLine, crunch)),
    retentionTriangle: Math.round(scaledDensityValue(chartHeights.comfortable.retentionTriangle, chartHeights.maximum.retentionTriangle, crunch)),
  }), [crunch]);
  const densityStyle = React.useMemo(() => ({
    ...densityVariables(crunch),
    "--plugin-uncarded-gutter": `${uncardedGutter}px`,
  }), [crunch, uncardedGutter]);

  const installs = reviewedRows("installs", ["date"]);
  const installSurfaces = reviewedRows("install_surfaces", ["date", "surface"]);
  const signupCohortOrder = ["New this week", "Joined in last 90d", "Established"];
  const signupCohorts = [...reviewedRows("signup_cohorts", ["date", "cohort"])].sort((left, right) =>
    left.date.localeCompare(right.date)
      || signupCohortOrder.indexOf(left.cohort) - signupCohortOrder.indexOf(right.cohort));
  const roles = reviewedRows("roles", ["role"]);
  const newUsers = reviewedRows("new_users", ["date"]);
  const activation = reviewedRows("activation", ["date"]);
  const activationSurfaces = reviewedRows("activation_surfaces", ["date", "surface"]);
  const activationCohorts = reviewedRows("activation_cohorts", ["date", "cohort", "week"]);
  const timeToSkill = reviewedRows("time_to_skill", ["pluginLabel", "timeBucket"]);
  const activity = reviewedRows("activity", ["date"]);
  const activityPlans = [...reviewedRows("activity_plans", ["date", "plan"])].sort((left, right) =>
    left.date.localeCompare(right.date)
      || planThemeOrder.indexOf(left.plan) - planThemeOrder.indexOf(right.plan));
  const activitySurfaces = [...reviewedRows("activity_surfaces", ["date", "surface"])].sort((left, right) =>
    left.date.localeCompare(right.date)
      || surfaceThemeOrder.indexOf(left.surface) - surfaceThemeOrder.indexOf(right.surface));
  const activityRatios = reviewedRows("activity_ratios", ["date", "measure", "metric"]);
  const retention = reviewedRows("retention", ["date", "cohort", "week"]);
  const flowRows = reviewedRows("first_conversation_flow", ["conversationType", "contextStatus", "skill"]);

  const installSurfaceLegendOrder = exampleLabels([
    "Codex · install records",
    "ChatGPT · install records",
    "Codex · distinct users",
    "ChatGPT · distinct users",
  ], dashboard.exampleLabels);
  const installSurfaceTrend = installSurfaces.flatMap((row) => [
    { date: row.date, metric: `${row.surface} · install records`, value: row.installRecords },
    { date: row.date, metric: `${row.surface} · distinct users`, value: row.distinctUsers },
  ]).sort((left, right) => left.date.localeCompare(right.date)
    || installSurfaceLegendOrder.indexOf(left.metric) - installSurfaceLegendOrder.indexOf(right.metric));
  const activityPlanTotals = new Map();
  activityPlans.forEach((row) => activityPlanTotals.set(row.date, (activityPlanTotals.get(row.date) ?? 0) + row.wau));
  const activityPlanMix = activityPlans.map((row) => ({
    ...row,
    wauShare: row.wau / activityPlanTotals.get(row.date),
  })).sort((left, right) => left.date.localeCompare(right.date)
    || planThemeOrder.indexOf(left.plan) - planThemeOrder.indexOf(right.plan));
  const cohortColors = Object.fromEntries([...new Set([
    ...activationCohorts.map((row) => row.cohort),
    ...retention.map((row) => row.cohort),
  ])].map((cohort) => [cohort, cohortColor(cohort)]));
  const activationCohortChart = {
    ...chartSpecs.activationCohorts,
    colors: activationCohortColors(activationCohorts.map((row) => row.cohort)),
  };
  const weeklyRetentionChart = { ...chartSpecs.weeklyRetention, colors: cohortColors };
  const skillGroups = [...new Set(timeToSkill.map(row => row.pluginLabel))];
  const skillComposition = skillGroups.map(pluginLabel => ({ pluginLabel, ...Object.fromEntries(Object.keys(timeToSkillColors)
    .map(bucket => [bucket, timeToSkill.filter(row => row.pluginLabel === pluginLabel && row.timeBucket === bucket).reduce((sum, row) => sum + row.users, 0)])) }));
  // A single composition cannot represent several plugins; retain the grouped
  // plot in that scope, including after restoring a saved presentation override.
  const skillOverride = chartOverrides["time-to-first-skill"];
  const timeToSkillChart = (skillGroups.length !== 1 && skillOverride?.presentation
    ? { ...chartSpecs.timeToSkill, showLegend: true } : skillOverride) ?? (skillGroups.length === 1 ? barChartSpec({
    presentation: "segmented", category: "pluginLabel", annotations: "list",
    series: Object.entries(timeToSkillColors).map(([key, color]) => ({ key, label: key, color })),
    style: { thickness: 40, radius: 6 },
  }) : { ...chartSpecs.timeToSkill, showLegend: true });
  const timeToSkillDisplay = timeToSkillChart.presentation ? skillComposition : timeToSkill;
  const flowChart = chartOverrides["first-conversation-flow"] ?? chartSpecs.firstConversation;
  const retentionHeatmapRows = retention.filter((row) => row.week !== "0").map((row) => ({
    ...row,
    weekLabel: `Week ${row.week}`,
  }));
  const retentionWeeks = Array.from({ length: 8 }, (_, index) => `Week ${index + 1}`);
  const retentionCohorts = [...new Set(retentionHeatmapRows.map((row) => row.cohortShortLabel))];
  const triangleBaseChart = chartOverrides["retention-triangle"] ?? chartSpecs.retentionTriangle;
  const retentionTriangleChart = {
    ...triangleBaseChart,
    categoryOrder: triangleDirection === "left" ? retentionWeeks : [...retentionWeeks].reverse(),
    seriesOrder: triangleDirection === "left" ? retentionCohorts : [...retentionCohorts].reverse(),
    yAxisPosition: triangleDirection === "left" ? "left" : "right",
  };
  const turnsPerWau = activityRatios.filter((row) => row.measure === "Turns / WAU");
  const conversationsPerWau = activityRatios.filter((row) => row.measure === "Conversations / WAU");

  return <DensityContext.Provider value={densityHeights}>
  <article className="plugin-deep-dive-page" data-uncarded={uncarded || undefined} style={densityStyle}>
    <SectionNavigator sections={navigationSections} label="Dashboard sections" />
    <Filters sticky filters={dashboard.filters ?? []} queries={queries} values={filters}
      onChange={setFilter} showClear={false} ariaLabel={exampleLabels("Plugin deep dive filters", dashboard.exampleLabels)}
      trailingControls={<SettingsMenu value={crunch} onChange={setCrunch}
        uncarded={uncarded} onUncardedChange={setUncarded}
        gutter={uncardedGutter} onGutterChange={setUncardedGutter} />} />

    <section className="plugin-section" aria-labelledby="installs-heading">
      <SectionHeader id="installs-heading" title="Installs" />
      <ChartGrid id="plugin-installs" className="plugin-grid-two">
        <ChartCard id="installed-users" queryId="installs" title="Current Distinct Installed Users"
          description="Current distinct installed users across Codex and ChatGPT, net of uninstalls. A user installed on multiple surfaces counts once."
          spec={chartSpecs.installedUsers} rows={installs} sourceRows={installs} />
        <ChartCard id="installs-by-surface" queryId="install_surfaces"
          title="Current Installs vs Users by Install Surface"
          description="Solid lines are install records; lighter dashed lines are distinct users. Color identifies the surface, making the gap between records and people easy to compare without dropping either measure."
          spec={chartSpecs.installSurfaces} rows={installSurfaceTrend} sourceRows={installSurfaces}
          className="install-surface-card" />
        <ChartCard id="daily-installs" queryId="installs" title="Daily Installs, Uninstalls, and Uninstall Rate"
          description="Daily observed install and uninstall events. Current installed users are net of uninstalls and deduplicated separately."
          spec={chartSpecs.dailyInstalls} rows={installs} sourceRows={installs} />
        <ChartCard id="installs-by-cohort" queryId="signup_cohorts" title="Daily Installs by Codex Signup Cohort"
          description="Signup cohorts use the user's first observed Codex account date and are mutually exclusive."
          spec={chartSpecs.installsByCohort} rows={signupCohorts} sourceRows={signupCohorts} />
        <ChartCard id="installs-by-role" queryId="roles"
          title="Install Base and L7 Active Share by Onboarding Role"
          description="Purple is each role's share of all installers. Blue is the share active in the latest seven days within that role; the two percentages use different denominators."
          spec={chartSpecs.installsByRole} rows={roles} sourceRows={roles} />
        <ChartCard id="new-user-install-rate" queryId="new_users"
          title="% of New Codex Users Installing Plugin on D1"
          description="Share of newly observed Codex users who install Data Analytics on their first day."
          spec={chartSpecs.newUserInstallRate} rows={newUsers} sourceRows={newUsers} />
      </ChartGrid>
    </section>

    <section className="plugin-section" aria-labelledby="activation-heading">
      <SectionHeader id="activation-heading" title="Activation" />
      <ChartGrid id="plugin-activation" columns={3} className="plugin-grid-three">
        <ChartCard id="d7-activation" queryId="activation" title="D7 Activation — 7-Cohort-Day Weighted"
          description="D7 active = explicit plugin tag or any non-index/router skill invocation within the first 7 days after first install. Only fully mature cohorts are included."
          spec={chartSpecs.d7Activation} rows={activation} sourceRows={activation} />
        <ChartCard id="d7-activation-by-surface" queryId="activation_surfaces"
          title="D7 Activation by First Install Surface"
          description="Usage may occur on any surface. Surface is mutually exclusive first-install attribution."
          spec={chartSpecs.activationBySurface} rows={activationSurfaces} sourceRows={activationSurfaces} />
        <ChartCard id="same-day-activation" queryId="activation"
          title="% of Daily Install Cohort Active Same Day"
          description="Same-day activation is directional and does not replace the fully matured D7 activation measure."
          spec={chartSpecs.sameDayActivation} rows={activation} sourceRows={activation} />
      </ChartGrid>
      <ChartGrid id="plugin-activation-details" className="plugin-continuation-grid">
        <ChartCard id="activation-cohort-curve" queryId="activation_cohorts"
          title="Cumulative Activation by Weekly Install Cohort"
          description="Each line follows one weekly install cohort. Newer cohorts stop at their latest fully observed week."
          spec={activationCohortChart} rows={activationCohorts} sourceRows={activationCohorts} height={densityHeights.continuation} />
        <DataComponent variant="card" id="time-to-first-skill" queryId="time_to_skill" kind="chart"
          chart={timeToSkillChart} title="Time to first skill · first 7 days"
          description="Distribution includes only installs that reached a non-index skill within seven days."
          displayRows={timeToSkillDisplay} sourceRows={timeToSkill} className="plugin-chart-card time-to-skill-card">
          <Chart spec={timeToSkillChart} rows={timeToSkillDisplay} height={densityHeights.continuation - 64}
            {...chartProps("time-to-first-skill")} />
        </DataComponent>
      </ChartGrid>
    </section>

    <section className="plugin-section" aria-labelledby="flow-heading">
      <SectionHeader id="flow-heading" title="First Conversation skill flow" />
      <ChartGrid id="plugin-flow" columns={1}>
      <DataComponent variant="card" padding="spacious" id="first-conversation-flow"
        queryId="first_conversation_flow" kind={flowView === "chart" ? "chart" : "table"}
        chart={flowChart} title="First Conversation Skill Flow"
        description="Each user is counted once, based on their first plugin-related conversation, whether user context was available, and the first skill used."
        displayRows={flowRows} sourceRows={flowRows} className="flow-card">
        <SegmentedControl className="flow-view-toggle" ariaLabel="First conversation view"
          value={flowView} options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]} onChange={setFlowView} />
        {flowView === "chart"
          ? <>
            <div className="flow-skill-group-legend" aria-label="Skill groups">
              {flowSkillGroups.map(({ label, color }) => <span key={label}>
                <i style={{ background: color }} />{label}
              </span>)}
            </div>
            <div className="flow-chart-scroll" tabIndex={0} role="region" aria-label="First conversation flow chart">
              <div className="flow-chart-plot">
                <Chart spec={flowChart} rows={flowRows} height={densityHeights.flow} {...chartProps("first-conversation-flow")} />
              </div>
            </div>
          </>
          : <div className="flow-table"><Table rows={flowRows} columns={flowColumns} /></div>}
      </DataComponent>
      </ChartGrid>
    </section>

    <section className="plugin-section" aria-labelledby="activity-heading">
      <SectionHeader id="activity-heading" title="Activity" />
      <ChartGrid id="plugin-activity" columns={3} className="plugin-grid-three plugin-activity-grid">
        <ChartCard id="activity-dau" queryId="activity" title="DAU (5d Work Week Avg)"
          description="Active = explicit plugin tag or any recorded plugin skill invocation; connector-only usage excluded."
          spec={chartSpecs.dau} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-wau" queryId="activity" title="WAU"
          description="Active = explicit plugin tag or any recorded plugin skill invocation; connector-only usage excluded."
          spec={chartSpecs.wau} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-stickiness" queryId="activity" title="5-Day Workweek Avg DAU / WAU Stickiness"
          spec={chartSpecs.stickiness} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-wau-plan" queryId="activity_plans" title="WAU by Plan"
          spec={chartSpecs.wauByPlan} rows={activityPlans} sourceRows={activityPlans} />
        <ChartCard id="activity-wau-plan-mix" queryId="activity_plans" title="WAU Mix by Plan"
          spec={chartSpecs.wauMixByPlan} rows={activityPlanMix} sourceRows={activityPlans} />
        <ChartCard id="activity-wau-surface" queryId="activity_surfaces" title="WAU by Surface"
          description="Trailing-7-day active users by surface."
          spec={chartSpecs.wauBySurface} rows={activitySurfaces} sourceRows={activitySurfaces} />
        <ChartCard id="activity-daily-turns" queryId="activity" title="Daily Turns"
          spec={chartSpecs.dailyTurns} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-weekly-turns" queryId="activity" title="Weekly Turns"
          spec={chartSpecs.weeklyTurns} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-turns-per-wau" queryId="activity_ratios" title="Weekly Turns / WAU"
          spec={chartSpecs.turnsPerWau} rows={turnsPerWau} sourceRows={activityRatios} />
        <ChartCard id="activity-conversations" queryId="activity" title="Conversations"
          spec={chartSpecs.dailyConversations} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-weekly-conversations" queryId="activity" title="Weekly Conversations"
          spec={chartSpecs.weeklyConversations} rows={activity} sourceRows={activity} />
        <ChartCard id="activity-conversations-per-wau" queryId="activity_ratios" title="Weekly Conversations / WAU"
          spec={chartSpecs.conversationsPerWau} rows={conversationsPerWau} sourceRows={activityRatios} />
      </ChartGrid>
    </section>

    <section className="plugin-section" aria-labelledby="retention-heading">
      <SectionHeader id="retention-heading" title="Retention" />
      <ChartGrid id="plugin-retention" columns={1} className="plugin-retention-stack">
        <ChartCard id="weekly-retention" queryId="retention" title="Weekly Retention by Activation Cohort"
          description="Cross-surface selected-skill retention. Cohort = week of first mapped high-value action; retained = another mapped high-value action in the exact user-relative week. Week 0 is the 100% baseline; immature weeks are omitted."
          spec={weeklyRetentionChart} rows={retention} sourceRows={retention} height={densityHeights.retentionLine}
          className="retention-line-card" />
        <DataComponent variant="card" id="retention-triangle" queryId="retention" kind="chart"
          chart={retentionTriangleChart} title="Weekly Retention by Activation Cohort — Triangle"
          description="Cross-surface selected-skill retention. Rows are first high-value-action cohorts and columns are exact user-relative weeks; color shows the share with another mapped high-value action. Week 0 and immature weeks are omitted."
          displayRows={retentionHeatmapRows} sourceRows={retention}
          className={`retention-triangle-card retention-triangle-card--${triangleDirection}`}>
          <SegmentedControl className="triangle-direction-toggle" ariaLabel="Triangle alignment"
            value={triangleDirection} options={[
              { value: "left", label: "Left" },
              { value: "right", label: "Right" },
            ]} onChange={setTriangleDirection} />
          <Chart spec={retentionTriangleChart} rows={retentionHeatmapRows} height={densityHeights.retentionTriangle} {...chartProps("retention-triangle")} />
        </DataComponent>
      </ChartGrid>
    </section>
  </article>
  </DensityContext.Provider>;
}
