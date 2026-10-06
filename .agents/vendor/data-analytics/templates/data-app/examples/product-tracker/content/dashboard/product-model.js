const day = 86400000;
const stamp = date => Date.parse(`${date}T00:00:00Z`);
const plusDays = (date, n) => new Date(stamp(date) + n * day).toISOString().slice(0, 10);
const ratio = (a, b) => b ? a / b : null;
export const featureFields = { "Task boards": "completedTasks", "Team comments": "comments", "Project templates": "templates", Automations: "automations", Reporting: "reports" };
export const eligibleFor = (row, feature) => !["Automations", "Reporting"].includes(feature) || row.plan !== "Starter";
export const featureUsage = (row, feature) => !eligibleFor(row, feature) ? "Not included"
  : !Number.isFinite(row[featureFields[feature]]) ? "Not observed" : row[featureFields[feature]] > 0 ? "Used" : "Not used";
export const number = value => value == null ? "—" : new Intl.NumberFormat("en-US").format(value);
export const percent = value => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
export const humanDate = value => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
export const delta = (value, previous, rate = false) => value == null || previous == null || (!rate && !previous) ? undefined
  : `${value >= previous ? "+" : ""}${(rate ? (value - previous) * 100 : (value / previous - 1) * 100).toFixed(1)}${rate ? " pp" : "%"}`;
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
export const feedbackStages = ["feedbackSource", "theme", "feature", "roadmap"];
export function feedbackFlow(rows, selections = {}) {
  const sourceRows = rows.filter(row => feedbackStages.every(field => !selections[field]?.length || selections[field].includes(row[field])));
  const paths = new Map();
  for (const row of sourceRows) {
    const key = JSON.stringify(feedbackStages.map(field => row[field]));
    if (!paths.has(key)) paths.set(key, { ...Object.fromEntries(feedbackStages.map(field => [field, row[field]])), mentions: 0 });
    paths.get(key).mentions += row.mentions;
  }
  return { sourceRows, rows: [...paths.values()] };
}
export function buildProductModel(queries, filters = {}) {
  const matches = row => ["plan", "channel", "region", "cohort"].every(field => !filters[field] || filters[field] === "all" || row[field] === filters[field]);
  const allWeeks = [...new Set(queries.workspace_activity.rows.map(row => row.week))].sort();
  const selectedWeek = allWeeks.includes(filters.week) ? filters.week : allWeeks.at(-1);
  const weeks = allWeeks.filter(week => week <= selectedWeek), asOf = plusDays(selectedWeek, 6);
  const roster = queries.workspace_roster.rows.filter(row => row.cohort <= selectedWeek && matches(row)).map(row => ({ ...row,
    ...Object.fromEntries(["invitedDay", "projectDay", "taskDay", "activationDay", "teammateTaskDay"].map(field => [field,
      row[field] != null && plusDays(row.cohort, row[field]) <= asOf ? row[field] : null])) }));
  const activity = queries.workspace_activity.rows.filter(row => row.week <= selectedWeek && matches(row));
  const feedback = (queries.workspace_feedback?.rows ?? []).filter(row => row.week <= selectedWeek && row.week >= plusDays(selectedWeek, -21) && matches(row));
  const byWeek = new Map(weeks.map(week => [week, activity.filter(row => row.week === week)]));
  const activeByWeek = new Map(weeks.map(week => [week, new Set(byWeek.get(week).filter(row => row.completedTasks > 0).map(row => row.workspaceId))]));
  const cohortSummary = (members, cutoff) => {
    const mature = members.filter(row => plusDays(row.cohort, 7) <= cutoff);
    const activated = mature.filter(row => row.activationDay != null && row.activationDay <= 7);
    const retainedEligible = members.filter(row => plusDays(row.cohort, 34) <= cutoff);
    const retained = retainedEligible.filter(row => activeByWeek.get(plusDays(row.cohort, 28))?.has(row.workspaceId));
    return { created: members.length, eligible: mature.length, activated: activated.length,
      activationRate: ratio(activated.length, mature.length), retainedEligible: retainedEligible.length,
      retained: retained.length, retentionRate: ratio(retained.length, retainedEligible.length) };
  };
  const history = weeks.map((week, index) => {
    const rows = byWeek.get(week), current = activeByWeek.get(week), previous = activeByWeek.get(weeks[index - 1]) ?? new Set();
    const everBefore = new Set(weeks.slice(0, index).flatMap(date => [...activeByWeek.get(date)]));
    const retained = [...current].filter(id => previous.has(id)).length;
    const newActive = [...current].filter(id => !everBefore.has(id)).length;
    const reactivated = current.size - retained - newActive, dormant = previous.size - retained;
    const recent = roster.filter(row => row.cohort <= plusDays(week, -7) && row.cohort >= plusDays(week, -28));
    const eligibleAutomation = rows.filter(row => row.completedTasks > 0 && eligibleFor(row, "Automations"));
    return { week, activeWorkspaces: current.size, previousActive: previous.size, newActive, retained, reactivated, dormant,
      returningRate: index ? ratio(retained, previous.size) : null, completedTasks: sum(rows, "completedTasks"),
      tasksPerWorkspace: ratio(sum(rows, "completedTasks"), current.size),
      automationRate: ratio(eligibleAutomation.filter(row => row.automations > 0).length, eligibleAutomation.length),
      activationRate: cohortSummary(recent, plusDays(week, 6)).activationRate,
      rollout: week === "2026-07-20" ? "Guided setup launched" : null };
  });
  const current = history.at(-1), previous = history.at(-2), currentRows = byWeek.get(selectedWeek);
  const currentActive = currentRows.filter(row => row.completedTasks > 0);
  const featureHistory = Object.entries(featureFields).flatMap(([feature, field]) => weeks.map(week => {
    const eligible = byWeek.get(week).filter(row => row.completedTasks > 0 && eligibleFor(row, feature));
    const adopters = eligible.filter(row => row[field] > 0);
    return { week, feature, eligible: eligible.length, adopters: adopters.length, adoptionRate: ratio(adopters.length, eligible.length),
      events: sum(eligible, field), eventsPerAdopter: ratio(sum(eligible, field), adopters.length) };
  }));
  const featureSummary = Object.keys(featureFields).map(feature => {
    const rows = featureHistory.filter(row => row.feature === feature), now = rows.at(-1), before = rows.at(-2);
    return { ...now, change: now.adoptionRate == null || before?.adoptionRate == null ? null : now.adoptionRate - before.adoptionRate };
  });
  const recentCohorts = roster.filter(row => row.cohort >= plusDays(selectedWeek, -28) && plusDays(row.cohort, 7) <= asOf);
  const activation = cohortSummary(recentCohorts, asOf);
  const funnel = [{ stage: "Created workspace", count: recentCohorts.length },
    { stage: "Invited a teammate", count: recentCohorts.filter(row => row.invitedDay != null && row.invitedDay <= 7).length },
    { stage: "Created a project", count: recentCohorts.filter(row => row.projectDay != null && row.projectDay <= 7).length },
    { stage: "Created a task", count: recentCohorts.filter(row => row.taskDay != null && row.taskDay <= 7).length },
    { stage: "Completed a task", count: activation.activated },
    { stage: "Teammate completed a task", count: recentCohorts.filter(row => row.teammateTaskDay != null && row.teammateTaskDay <= 7).length }];
  const cohorts = weeks.map(cohort => ({ cohort, ...cohortSummary(roster.filter(row => row.cohort === cohort), asOf) })).filter(row => row.created);
  const retention = cohorts.flatMap(row => Array.from({ length: 9 }, (_, age) => {
    const week = plusDays(row.cohort, age * 7), observed = plusDays(week, 6) <= asOf;
    const count = observed ? roster.filter(item => item.cohort === row.cohort && activeByWeek.get(week)?.has(item.workspaceId)).length : null;
    return { cohort: row.cohort, week, age: `Week ${age}`, retained: count, created: row.created, retentionRate: observed ? ratio(count, row.created) : null };
  }));
  const channels = [...new Set(roster.map(row => row.channel))].map(channel => ({ channel, ...cohortSummary(roster.filter(row => row.channel === channel), asOf) }));
  const plans = [...new Set(roster.map(row => row.plan))].map(plan => {
    const rows = currentRows.filter(row => row.plan === plan), before = (byWeek.get(weeks.at(-2)) ?? []).filter(row => row.plan === plan);
    const active = rows.filter(row => row.completedTasks > 0).length;
    return { plan, active, change: active - before.filter(row => row.completedTasks > 0).length,
      tasksPerWorkspace: ratio(sum(rows, "completedTasks"), active), ...cohortSummary(roster.filter(row => row.plan === plan), asOf) };
  });
  const workspaces = roster.map(workspace => {
    const rows = activity.filter(row => row.workspaceId === workspace.workspaceId), now = rows.at(-1), before = rows.at(-2);
    const change = before?.completedTasks ? now.completedTasks / before.completedTasks - 1 : null;
    return { ...workspace, completedTasks: now.completedTasks, previousTasks: before?.completedTasks ?? null,
      change, trend: rows.slice(-8).map(row => row.completedTasks),
      status: now.completedTasks === 0 ? "Inactive" : workspace.cohort === selectedWeek ? "New" : change != null && change < -.25 ? "Slipping" : "Active",
      featuresUsed: Object.values(featureFields).filter(field => now[field] > 0).length };
  }).sort((a,b) => (a.status === "Slipping" ? 0 : 1) - (b.status === "Slipping" ? 0 : 1) || b.completedTasks - a.completedTasks);
  const bridge = current && [ { stage: "Previous", change: current.previousActive }, { stage: "New", change: current.newActive },
    { stage: "Returning", change: current.reactivated }, { stage: "Dormant", change: -current.dormant }, { stage: "Current", change: current.activeWorkspaces } ];
  return { selectedWeek, asOf, weeks, roster, activity, feedback, currentRows, currentActive, history, current, previous,
    featureHistory, featureSummary, activation, funnel, recentCohorts, cohorts, retention, channels, plans, workspaces, bridge };
}
