// Fictional collaboration product. One workspace roster and workspace-week ledger
// drive growth, onboarding, feature adoption and entity evidence.
const day = 86400000;
const date = (value) => new Date(value).toISOString().slice(0, 10);
const start = Date.parse("2026-05-04T00:00:00Z");
export const weeks = Array.from({ length: 16 }, (_, index) => date(start + index * 7 * day));
export const features = ["Task boards", "Team comments", "Project templates", "Automations", "Reporting"];
const channels = ["Organic", "Team invitation", "Partner", "Paid search"];
const names = ["Ash", "Birch", "Cedar", "Dune", "Elm", "Fern", "Grove", "Harbor", "Iris", "Juniper", "Kite", "Laurel", "Maple", "North", "Oak", "Pine", "Quill", "Reed", "Spruce", "Vale"];
const suffixes = ["Studio", "Works", "Collective", "Labs", "Design", "Group", "Digital", "Partners", "Workshop", "Creative", "Systems", "Company", "House", "Agency"];
export const roster = weeks.flatMap((cohort, c) => Array.from({ length: 10 + Math.floor(c / 2) }, (_, j) => {
  const nameIndex = c * 10 + Math.floor((c - 1) ** 2 / 4) + j;
  const n = c * 23 + j, channel = channels[(j + c) % 4];
  const plan = ["Starter", "Team", "Business"][(j * 2 + c) % 3];
  const score = (n * 37 + 19) % 100;
  const invitedDay = score < 91 ? 1 + n % 3 : null;
  const projectDay = invitedDay != null && score < 82 ? invitedDay + n % 2 : null;
  const threshold = 58 + (c >= 11 ? 17 : 0) + (channel === "Team invitation" ? 14 : channel === "Paid search" ? -17 : 0);
  const completionDay = projectDay != null && score < threshold ? projectDay + 1 + n % 3 : null;
  const activationDay = completionDay != null && c * 7 + completionDay <= 111 ? completionDay : null;
  const taskDay = projectDay != null && score < 79 ? projectDay : null;
  // Collaboration is the remaining onboarding bottleneck, even after first-task activation.
  const teammateTaskDay = activationDay != null && (n * 17 + 3) % 100 < 58
    && c * 7 + activationDay + 1 <= 111 ? activationDay + 1 : null;
  return { workspaceId: `workspace-${c}-${j}`, workspace: `${names[nameIndex % 20]} ${suffixes[Math.floor(nameIndex / 20)]}`,
    cohort, cohortIndex: c, plan, channel, region: ["Americas", "Europe", "Asia Pacific"][(j + 2 * c) % 3],
    members: 3 + (n * 7) % 45, invitedDay, projectDay, taskDay: activationDay != null ? projectDay : taskDay, activationDay, teammateTaskDay,
    onboarding: c >= 11 ? "Guided setup" : "Original setup" };
}));
export const activity = roster.flatMap((workspace, index) => weeks.slice(workspace.cohortIndex).map((week, offset) => {
  const w = workspace.cohortIndex + offset;
  const lifetime = 3 + index % 15;
  const milestoneWeek = [workspace.activationDay, workspace.teammateTaskDay].some(value => value != null && Math.floor(value / 7) === offset);
  const active = milestoneWeek || workspace.activationDay != null && (offset > 0 || workspace.activationDay <= 6)
    && (offset < lifetime || index % 7 === 0) && (offset === 0 || (index * 11 + w * 7) % 13 !== 0);
  const baseline = 12 + workspace.members * 2 + (index * 3) % 27;
  // Team plans keep onboarding gains but some established workspaces lose depth.
  const contraction = w >= 12 && workspace.plan === "Team" && workspace.cohortIndex < 8 ? (w === 15 ? .35 : .55) : 1;
  const completedTasks = active ? Math.round(baseline * contraction * (1 + .12 * Math.sin(w + index))) : 0;
  return { workspaceId: workspace.workspaceId, workspace: workspace.workspace, week, plan: workspace.plan,
    cohort: workspace.cohort, activationDay: workspace.activationDay != null && workspace.activationDay <= offset * 7 + 6 ? workspace.activationDay : null,
    channel: workspace.channel, region: workspace.region, completedTasks,
    comments: active && (index + w) % 5 !== 0 ? Math.round(completedTasks * .65) : 0,
    templates: active && (index + w) % 4 !== 0 ? 1 + index % 5 : 0,
    automations: active && workspace.plan !== "Starter" && (index * 3 + w) % 5 < (w >= 12 ? 1 : 2) ? 3 + index % 17 : 0,
    reports: active && workspace.plan !== "Starter" && (index + w) % 3 === 0 ? 1 + index % 6 : 0 };
}));
// Separate fictional feedback records, not feedback inferred from usage events.
// Each record carries one primary theme and one roadmap disposition at submission.
const requests = [
  ["Manual work", "Automations", "Prioritized"],
  ["Visibility", "Reporting", "Backlog"],
  ["Getting started", "Project templates", "Prioritized"],
  ["Collaboration", "Team comments", "Backlog"],
  ["Reliability", "Task boards", "Prioritized"],
  ["Customization", null, "Unplanned"],
];
export const feedback = activity.filter((row, index) => (index * 7 + weeks.indexOf(row.week)) % 11 === 0)
  .map((row, index) => {
    const [theme, feature, roadmap] = requests[(index * 5 + weeks.indexOf(row.week)) % requests.length];
    return { feedbackId: `feedback-${index}`, workspaceId: row.workspaceId, workspace: row.workspace,
      week: row.week, cohort: row.cohort, plan: row.plan, channel: row.channel, region: row.region,
      feedbackSource: ["In-product", "Support", "Interviews", "Community"][index % 4],
      theme, feature, roadmap, request: ({ "Manual work": "Run recurring tasks automatically", Visibility: "Schedule project progress reports", "Getting started": "Start new projects from a shared template", Collaboration: "Keep decisions alongside team comments", Reliability: "Recover accidentally archived task boards", Customization: "Support a custom approval workflow" })[theme], mentions: 1 };
  });
const definitions = [
  { field: "activeWorkspaces", label: "Weekly active workspaces", definition: "Distinct workspaces completing at least one task in the selected Monday–Sunday week. A workspace is not a person." },
  { field: "activationRate", label: "Activated within 7 days", definition: "Workspaces completing their first task within seven days of creation / all created workspaces with seven full days of follow-up. One activation per workspace." },
  { field: "retentionRate", label: "Week 4 retention", definition: "Created workspaces completing a task in their fourth subsequent calendar week / all workspaces created in that cohort. Only fully observed weeks qualify; not conditional on activation." },
  { field: "adoptionRate", label: "Feature adoption", definition: "Active workspaces using the feature / active workspaces eligible for that feature in the same week. Automations and Reporting require Team or Business." },
  { field: "returningRate", label: "Weekly continuation", definition: "Workspaces active in both this week and the preceding week / workspaces active in the preceding week. Distinct from signup-cohort retention." },
  { field: "completedTasks", label: "Completed tasks", definition: "Count of completed tasks, additive across workspace-week rows. The synthetic ledger has no individual-user activity or revenue evidence." },
];
const source = { label: "Lattice workspace lifecycle", tables: ["fixture.lattice_workspaces", "fixture.lattice_workspace_weeks"],
  caveats: ["Lattice is a fictional team-project product. All evidence is deterministic synthetic data.", "Guided setup launched July 20. Its timing does not establish a causal treatment effect; channel and cohort mix also change."],
  metricDefinitions: definitions, coverage: { startDate: weeks[0], endDate: "2026-08-23" } };
export function fixture() { return { id: "lattice-product-growth", title: "Lattice product growth", surface: "dashboard", status: "fixture", generatedAt: "2026-08-24T09:00:00Z",
  filters: [
    { id: "week", field: "week", label: "Week of", defaultValue: weeks.at(-1), queryIds: ["workspace_activity", "workspace_feedback"] },
    { id: "cohort", field: "cohort", type: "date", label: "Signup week", defaultValue: "all", queryIds: ["workspace_roster", "workspace_activity"] },
    ...["plan", "channel", "region"].map(field => ({ id: field, field, label: field[0].toUpperCase() + field.slice(1), defaultValue: "all", queryIds: ["workspace_activity", "workspace_roster", "workspace_feedback"] })),
  ], queries: {
    workspace_roster: { rows: structuredClone(roster), source },
    workspace_activity: { rows: structuredClone(activity), source },
    workspace_feedback: { rows: structuredClone(feedback), source: { label: "Lattice product feedback", tables: ["fixture.lattice_feedback"],
      coverage: source.coverage, caveats: ["Deterministic synthetic feedback, not inferred from usage or a representative survey. One record may come from a workspace that submitted other feedback.",
        "Each record has one primary theme; feature is intentionally absent for unplanned requests. Priority is the recorded disposition at submission, not a delivery promise."],
      metricDefinitions: [{ field: "mentions", label: "Feedback records", definition: "Count of feedback records submitted in the four complete weeks through the selected week. Not distinct workspaces; paths reconcile to this count." }] } },
  } }; }
export const snapshot = fixture();
