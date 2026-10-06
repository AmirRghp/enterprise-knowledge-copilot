// Stable identities shared by the inventory and composed bar examples.
export const planToneColors = {
  Enterprise: "color-mix(in srgb, var(--chart-1) 82%, var(--surface))",
  Growth: "color-mix(in srgb, var(--chart-1) 52%, var(--surface))",
  Starter: "color-mix(in srgb, var(--chart-1) 24%, var(--surface))",
};
export const categoryToneColors = Object.fromEntries(["Enterprise", "Growth", "Starter", "Education", "Community"].map((name, index) =>
  [name, ["light-dark(#075fae, #4aa8ff)", "light-dark(#0a75cc, #66b5ff)", "light-dark(#2e91dd, #82c3ff)", "light-dark(#68b2e8, #9ed0ff)", "light-dark(#9ccff1, #badcff)"][index]]));

export const funnelExamples = [
  { id: "sales", title: "Sales funnel", colors: { count: "var(--chart-1)" }, rows: [
    ["Emails", 17000], ["Visits", 13000], ["Logins", 5900], ["Purchases", 4000], ["Payments", 2300],
  ] },
  { id: "market", title: "Market to sales", colors: { count: "var(--chart-2)" }, rows: [
    ["Total market", 142901], ["Prospects", 101020], ["Leads", 60314], ["Sales", 54280],
  ] },
  { id: "activation", title: "Product activation", rows: [
    ["Signed up", 12000], ["Created workspace", 8400], ["Invited team", 5160], ["Activated", 3000],
  ], colors: { count: "var(--chart-3)" } },
];

const source = {
  label: "Operating metrics snapshot",
  description: "Reviewed operating measures used across the chart grid.",
  caveats: ["Values are fixed for this review."],
};

const feedbackSource = {
  label: "Feedback intake and roadmap triage",
  description: "Reviewed feedback volume mapped from intake channel through roadmap disposition.",
  caveats: ["Counts are fixed example data and represent individual feedback items."],
};

const categories = [
  { segment: "Enterprise", value: 84, target: 76 },
  { segment: "Growth", value: 69, target: 72 },
  { segment: "Starter", value: 51, target: 48 },
  { segment: "Education", value: 37, target: 41 },
  { segment: "Community", value: 24, target: 29 },
];

const activeTeamTrend = [184, 193, 201, 198, 214, 226, 239, 251, 263, 278, 291, 307];
const completedTaskTrend = [410, 432, 447, 461, 486, 503, 529, 548, 571, 602, 624, 659];
const sliderOptions = [{
  volume: 64,
  conversionRate: 0.37,
  planningHorizon: "12 months",
  dateWindowStart: 3,
  dateWindowEnd: 9,
  confidenceMinimum: 25,
  confidenceMaximum: 80,
  lockedTarget: 72,
}];
const trend = Array.from({ length: 12 }, (_, index) => ({
  week: new Date(Date.UTC(2026, 5, 2 + index * 3)).toISOString().slice(0, 10),
  activeTeams: activeTeamTrend[index],
  completedTasks: completedTaskTrend[index],
  tasksPerTeam: completedTaskTrend[index] / activeTeamTrend[index],
}));

const composition = [
  ["North America", "Enterprise", 188], ["North America", "Growth", 142], ["North America", "Starter", 96],
  ["Europe", "Enterprise", 133], ["Europe", "Growth", 125], ["Europe", "Starter", 88],
  ["Asia Pacific", "Enterprise", 91], ["Asia Pacific", "Growth", 116], ["Asia Pacific", "Starter", 105],
  ["Latin America", "Enterprise", 42], ["Latin America", "Growth", 74], ["Latin America", "Starter", 82],
].map(([region, plan, accounts]) => ({ region, plan, accounts }));

const scatter = Array.from({ length: 18 }, (_, index) => ({
  team: `Team ${index + 1}`,
  weeklyUsers: 18 + index * 5 + (index % 3) * 4,
  tasksPerUser: 3.2 + (index % 6) * 0.7 + Math.floor(index / 6) * 0.35,
  seats: 24 + index * 7,
}));

const heatmap = ["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((day, dayIndex) =>
  ["Morning", "Midday", "Afternoon", "Evening"].map((period, periodIndex) => ({
    day,
    period,
    requests: 42 + dayIndex * 9 + periodIndex * 13 + ((dayIndex + periodIndex) % 3) * 7,
  })),
);

const sparseHeatmap = heatmap.filter(({ day, period }) => ![
  "Tue:Midday",
  "Wed:Evening",
  "Thu:Morning",
  "Fri:Afternoon",
].includes(`${day}:${period}`));

const longLabelHeatmap = [
  "Monday, August 17",
  "Tuesday, August 18",
  "Wednesday, August 19",
  "Thursday, August 20",
].flatMap((day, dayIndex) => [
  "Early morning (06:00–09:00)",
  "Core business hours (09:00–17:00)",
  "Evening support window (17:00–22:00)",
].map((period, periodIndex) => ({
  day,
  period,
  requests: 54 + dayIndex * 12 + periodIndex * 19,
})));

const distribution = Array.from({ length: 36 }, (_, index) => ({
  team: `Team ${index + 1}`,
  responseMinutes: 8 + ((index * 11) % 43) + (index % 5) * 2,
}));

const teamDeliveryWeekly = [
  { day: "Mon", completed: 18, target: 20 },
  { day: "Tue", completed: 24, target: 20 },
  { day: "Wed", completed: 21, target: 20 },
  { day: "Thu", completed: 27, target: 20 },
  { day: "Fri", completed: 16, target: 20 },
];

const teamRituals = ["Mon", "Tue", "Wed", "Thu", "Fri"].flatMap((day, dayIndex) =>
  ["Standup", "Planning", "Review", "Retro"].map((ritual, ritualIndex) => ({
    day,
    ritual,
    completed: [
      [1, 1, 1, 0, 1],
      [1, 0, 1, 1, 1],
      [1, 1, 0, 1, 1],
      [0, 1, 1, 1, 1],
    ][ritualIndex][dayIndex],
  })),
);

const teamFocusWindows = [
  { team: "Core product", beforeFocus: 1.5, focusHours: 4, afterFocus: 2.5 },
  { team: "Growth", beforeFocus: 2, focusHours: 3.5, afterFocus: 2.5 },
  { team: "Platform", beforeFocus: 1, focusHours: 4.5, afterFocus: 2.5 },
  { team: "Customer", beforeFocus: 2.5, focusHours: 3, afterFocus: 2.5 },
].map(row => ({ ...row, focusEnd: row.beforeFocus + row.focusHours, focusHoursLabel: `${row.focusHours} hours` }));

const teamCapacityMix = [
  ["Core product", "Product work", 55], ["Core product", "Reliability", 20],
  ["Core product", "Support", 10], ["Core product", "Planning", 15],
  ["Growth", "Product work", 60], ["Growth", "Reliability", 10],
  ["Growth", "Support", 15], ["Growth", "Planning", 15],
  ["Platform", "Product work", 35], ["Platform", "Reliability", 40],
  ["Platform", "Support", 10], ["Platform", "Planning", 15],
  ["Customer", "Product work", 30], ["Customer", "Reliability", 10],
  ["Customer", "Support", 45], ["Customer", "Planning", 15],
].map(([team, workType, share]) => ({ team, workType, share }));

const rightAxisValues = [
  { period: "Jan", reviewedValue: 982400, reviewedRate: 0.238 },
  { period: "Feb", reviewedValue: 1248800, reviewedRate: 0.251 },
  { period: "Mar", reviewedValue: 1684200, reviewedRate: 0.267 },
  { period: "Apr", reviewedValue: 2139600, reviewedRate: 0.284 },
  { period: "May", reviewedValue: 2875500, reviewedRate: 0.296 },
  { period: "Jun", reviewedValue: 3541800, reviewedRate: 0.312 },
];

const mixedSignStack = [
  { quarter: "Q1", expansion: 72, newBusiness: 46, contraction: -28, churn: -19 },
  { quarter: "Q2", expansion: 58, newBusiness: 39, contraction: -34, churn: -23 },
  { quarter: "Q3", expansion: 81, newBusiness: 52, contraction: -21, churn: -31 },
  { quarter: "Q4", expansion: 67, newBusiness: 61, contraction: -38, churn: -16 },
];

const trendComposition = trend.flatMap((row, index) => [
  { week: row.week, plan: "Enterprise", activeTeams: 92 + index * 7 },
  { week: row.week, plan: "Growth", activeTeams: 61 + index * 5 + index % 3 },
  { week: row.week, plan: "Starter", activeTeams: 38 + index * 3 + index % 2 },
]);

const boxDistribution = ["Enterprise", "Growth", "Starter", "Education"].flatMap((segment, segmentIndex) =>
  Array.from({ length: 12 }, (_, index) => ({
    segment,
    observation: `${segment}-${index + 1}`,
    responseMinutes: 12 + segmentIndex * 6 + ((index * 7 + segmentIndex * 3) % 24),
  })),
);

const waterfallDrivers = [
  { driver: "Starting revenue", change: 420, totalType: "beginning", isTotal: true },
  { driver: "New accounts", change: 86 },
  { driver: "Expansion", change: 54 },
  { driver: "Contraction", change: -31 },
  { driver: "Churn", change: -22 },
  { driver: "Ending revenue", change: 507, totalType: "ending", isTotal: true },
];

const funnelStages = [
  { stage: "Visited", accounts: 12800 },
  { stage: "Signed up", accounts: 7600 },
  { stage: "Created workspace", accounts: 4920 },
  { stage: "Activated", accounts: 3180 },
  { stage: "Retained", accounts: 2410 },
];

const flows = [
  { source: "Organic", product: "Core", outcome: "Activated", accounts: 188 },
  { source: "Organic", product: "Core", outcome: "Evaluating", accounts: 74 },
  { source: "Partners", product: "Core", outcome: "Activated", accounts: 116 },
  { source: "Partners", product: "Enterprise", outcome: "Activated", accounts: 142 },
  { source: "Sales", product: "Enterprise", outcome: "Activated", accounts: 205 },
  { source: "Sales", product: "Enterprise", outcome: "Evaluating", accounts: 83 },
  { source: "Self-serve", product: "Starter", outcome: "Activated", accounts: 167 },
  { source: "Self-serve", product: "Starter", outcome: "Evaluating", accounts: 92 },
];

const feedbackRoadmap = [
  { feedbackSource: "Support", theme: "Stability", roadmap: "Prioritized", feature: "Sync fix", mentions: 148 },
  { feedbackSource: "Support", theme: "Navigation", roadmap: "Prioritized", feature: "New nav", mentions: 82 },
  { feedbackSource: "Support", theme: "Reporting", roadmap: "Backlog", feature: "Dashboards", mentions: 55 },
  { feedbackSource: "Support", theme: "Mobile", roadmap: "Backlog", feature: "Offline", mentions: 47 },
  { feedbackSource: "In-product", theme: "Navigation", roadmap: "Prioritized", feature: "New nav", mentions: 132 },
  { feedbackSource: "In-product", theme: "Teamwork", roadmap: "Prioritized", feature: "Mentions", mentions: 118 },
  { feedbackSource: "In-product", theme: "Reporting", roadmap: "Prioritized", feature: "Schedules", mentions: 89 },
  { feedbackSource: "In-product", theme: "Onboarding", roadmap: "Prioritized", feature: "Setup tour", mentions: 74 },
  { feedbackSource: "In-product", theme: "Reporting", roadmap: "Unplanned", feature: null, mentions: 31 },
  { feedbackSource: "Sales calls", theme: "Reporting", roadmap: "Prioritized", feature: "Schedules", mentions: 104 },
  { feedbackSource: "Sales calls", theme: "Connected", roadmap: "Prioritized", feature: "Slack sync", mentions: 96 },
  { feedbackSource: "Sales calls", theme: "Navigation", roadmap: "Backlog", feature: "Bulk edit", mentions: 62 },
  { feedbackSource: "Sales calls", theme: "Connected", roadmap: "Unplanned", feature: null, mentions: 28 },
  { feedbackSource: "Interviews", theme: "Onboarding", roadmap: "Prioritized", feature: "Setup tour", mentions: 91 },
  { feedbackSource: "Interviews", theme: "Teamwork", roadmap: "Prioritized", feature: "Mentions", mentions: 77 },
  { feedbackSource: "Interviews", theme: "Mobile", roadmap: "Backlog", feature: "Offline", mentions: 64 },
  { feedbackSource: "Interviews", theme: "Teamwork", roadmap: "Unplanned", feature: null, mentions: 26 },
  { feedbackSource: "Community", theme: "Connected", roadmap: "Backlog", feature: "Webhooks", mentions: 83 },
  { feedbackSource: "Community", theme: "Teamwork", roadmap: "Prioritized", feature: "Mentions", mentions: 72 },
  { feedbackSource: "Community", theme: "Navigation", roadmap: "Backlog", feature: "Bulk edit", mentions: 59 },
  { feedbackSource: "Community", theme: "Navigation", roadmap: "Unplanned", feature: null, mentions: 35 },
  { feedbackSource: "Reviews", theme: "Stability", roadmap: "Prioritized", feature: "Sync fix", mentions: 69 },
  { feedbackSource: "Reviews", theme: "Mobile", roadmap: "Backlog", feature: "Offline", mentions: 73 },
  { feedbackSource: "Reviews", theme: "Mobile", roadmap: "Unplanned", feature: null, mentions: 22 },
];

const chartFamilies = [
  { type: "horizontalBar", label: "Horizontal bar", family: "Comparison" },
  { type: "stackedBar", label: "Stacked bar", family: "Composition" },
  { type: "stackedBar100", label: "100% stacked bar", family: "Composition" },
  { type: "horizontalStackedBar", label: "Horizontal stacked bar", family: "Composition" },
  { type: "horizontalStackedBar100", label: "100% horizontal stack", family: "Composition" },
  { type: "histogram", label: "Histogram", family: "Distribution" },
];

const chartCatalog = chartFamilies.map((chart) => ({
    chartId: chart.type.replace(/([a-z])([A-Z])/gu, "$1-$2").toLowerCase(),
    family: chart.family,
    chartType: chart.label,
  })).concat([
  { chartId: "leaderboard", family: "Comparison", chartType: "Leaderboard" },
  { chartId: "ranked-list", family: "Comparison", chartType: "Ranked list" },
  { chartId: "funnel", family: "Flow", chartType: "Funnel" },
  { chartId: "team-delivery-benchmark", family: "Team health", chartType: "Bar with benchmark" },
  { chartId: "team-rituals-heatmap", family: "Team health", chartType: "Check-in heatmap" },
  { chartId: "team-focus-windows", family: "Team health", chartType: "Range bar" },
  { chartId: "team-capacity-mix", family: "Team health", chartType: "Segmented composition" },
]);

const queries = {
  ...Object.fromEntries(funnelExamples.map(({id,rows}) => [`funnel_${id}`, {rows: rows.map(([stage,count]) => ({stage,count})), source: {label:"Synthetic funnel specimen",caveats:["Synthetic example data; not business evidence."]}}])),
  range_positions: { rows: [
    { label: "Within range", low: 80, high: 120, current: 104 },
    { label: "At lower bound", low: 80, high: 120, current: 80 },
    { label: "Above range", low: 80, high: 120, current: 135 },
    { label: "Equal bounds", low: 100, high: 100, current: 100 },
    { label: "Not observed", low: 80, high: 120, current: null },
  ], source },
  experimental_bar_examples: { rows: [], source },
  slider_options: { rows: sliderOptions, source },
  category_performance: { rows: categories, source },
  weekly_activity: { rows: trend, source },
  account_composition: { rows: composition, source },
  team_relationship: { rows: scatter, source },
  request_intensity: { rows: heatmap, source },
  request_intensity_sparse: { rows: sparseHeatmap, source },
  request_intensity_long_labels: { rows: longLabelHeatmap, source },
  response_distribution: { rows: distribution, source },
  team_delivery_weekly: { rows: teamDeliveryWeekly, source },
  team_rituals: { rows: teamRituals, source },
  team_focus_windows: { rows: teamFocusWindows, source },
  team_capacity_mix: { rows: teamCapacityMix, source },
  right_axis_values: { rows: rightAxisValues, source },
  mixed_sign_stack: { rows: mixedSignStack, source },
  weekly_composition: { rows: trendComposition, source },
  segment_distribution: { rows: boxDistribution, source },
  revenue_bridge: { rows: waterfallDrivers, source },
  activation_funnel: { rows: funnelStages, source },
  account_flows: { rows: flows, source },
  feedback_roadmap: { rows: feedbackRoadmap, source: feedbackSource },
  chart_catalog: { rows: chartCatalog, source },
};

export const snapshot = {
  id: "component-lab",
  title: "Component Lab",
  status: "fixture",
  surface: "dashboard",
  filters: [
    { id: "family", label: "Chart family", field: "family", defaultValue: "all", queryIds: ["chart_catalog"] },
    { id: "chartType", label: "Chart type", field: "chartType", searchable: true,
      defaultValue: "all", allLabel: "All chart types", showLabel: false,
      queryIds: ["chart_catalog"] },
  ],
  queries,
};
