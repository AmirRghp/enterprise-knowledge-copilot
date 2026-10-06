import { exampleLabels } from "../content/dashboard/example-labels.js";

// Shared fixture relationships; demo profiles change inputs, never rescale finished rates.
function createLifecycleFixture({ openingBase = 960, installScale = 1,
  activationLift = 0, retentionLift = 0, flowScale = 1, labels, id, title } = {}) {
const plugin = "data-analytics";
const start = new Date("2026-06-02T00:00:00Z");
const days = Array.from({ length: 81 }, (_, index) => {
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + index);
  return date.toISOString().slice(0, 10);
});

const round = (value, digits = 0) => Number(value.toFixed(digits));
const wave = (index, period, amplitude = 1) => Math.sin(index / period * Math.PI * 2) * amplitude;

// Largest-remainder allocation preserves exclusive aggregate counts after rounding.
const allocate = (total, weights) => {
  const denominator = weights.reduce((sum, value) => sum + value, 0);
  const quotas = weights.map(weight => total * weight / denominator);
  const counts = quotas.map(Math.floor);
  const order = quotas.map((value, index) => ({ index, fraction: value - counts[index] })).sort((a,b) => b.fraction - a.fraction);
  for (let i = 0, remainder = total - counts.reduce((sum, value) => sum + value, 0); i < remainder; i++) counts[order[i].index]++;
  return counts;
};
let installedBase = openingBase;
const installRows = days.map((date, index) => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const workday = weekday > 0 && weekday < 6 ? 1 : 0.72;
  const installs = Math.max(18, Math.round((48 + index * 1.38 + wave(index, 8, 9)) * workday * installScale));
  const uninstalls = Math.max(2, Math.round((5 + index * 0.12 + wave(index + 2, 11, 2)) * installScale));
  const openingInstalledUsers = installedBase;
  installedBase += installs - uninstalls;
  const installedUsers = installedBase;
  return {
    plugin,
    date,
    installs,
    uninstalls,
    negativeUninstalls: -uninstalls,
    installedUsers,
    openingInstalledUsers,
  };
});

let cumulativeInstalls = 0;
let cumulativeUninstalls = 0;
installRows.forEach((row) => {
  cumulativeInstalls += row.installs;
  cumulativeUninstalls += row.uninstalls;
  row.uninstallRate = round(cumulativeUninstalls / cumulativeInstalls, 4);
});

const surfaces = [
  { surface: "Codex", share: 0.68, duplicateRate: 1.08 },
  { surface: "ChatGPT", share: 0.32, duplicateRate: 1.13 },
];

const surfaceRows = installRows.flatMap((row, index) => {
  const overlap = Math.round(row.installedUsers * .06);
  const codex = Math.round(row.installedUsers * (.68 + wave(index, 21, .02)));
  return surfaces.map((surface, position) => {
    const distinctUsers = position ? row.installedUsers - codex + overlap : codex;
    return {plugin, date:row.date, surface:surface.surface, distinctUsers,
      installRecords: Math.round(distinctUsers * surface.duplicateRate), crossSurfaceOverlapUsers:overlap,
      globalInstalledUsers:row.installedUsers};
  });
});

const signupCohorts = [
  { cohort: "New this week", share: 0.18 },
  { cohort: "Joined in last 90d", share: 0.34 },
  { cohort: "Established", share: 0.48 },
];

const cohortInstallRows = installRows.flatMap((row, index) => {
  const counts = allocate(row.installs, signupCohorts.map((cohort, i) => cohort.share + wave(index+i*3,17,.018)));
  return signupCohorts.map((cohort, i) => ({plugin,date:row.date,cohort:cohort.cohort,installs:counts[i]}));
});

const roles = [
  { role: "Data analyst", installed: 1780, activeShare: 0.41 },
  { role: "Data scientist", installed: 1220, activeShare: 0.47 },
  { role: "Engineer", installed: 890, activeShare: 0.32 },
  { role: "Product", installed: 650, activeShare: 0.28 },
  { role: "Other", installed: 410, activeShare: 0.21 },
];

const newUserRows = days.map((date, index) => {
  const installedNewUsers = Math.round(cohortInstallRows.find(row => row.date === date && row.cohort === "New this week").installs * .6);
  const modeledRate = .034 + index*.00031 + wave(index,13,.0048);
  const eligibleNewUsers = Math.round(installedNewUsers / modeledRate);
  return {plugin,date,installedNewUsers,eligibleNewUsers,d1InstallRate:installedNewUsers/eligibleNewUsers};
});

const dayOffset = (date,offset) => new Date(Date.parse(date)+offset*86400000).toISOString().slice(0,10);
// Aggregate cohort facts only; these do not imply available user-level records.
const activationFacts = Array.from({length:days.length+13},(_,i) => {
  const index=i-13,date=dayOffset(days[0],index);
  const installs=installRows.find(row => row.date === date)?.installs ?? Math.round((45+((i*7)%19))*installScale);
  return ["Codex","ChatGPT"].map((surface,surfaceIndex) => {
    const eligible=surfaceIndex ? installs-Math.round(installs*.68) : Math.round(installs*.68);
    const rate=surfaceIndex ? .188+index*.00025+wave(index+3,11,.01) : .265+index*.00034+wave(index,10,.012);
    const activatedWithin7=Math.round(eligible*Math.min(1,rate+activationLift));
    const activatedSameDay=Math.min(activatedWithin7,Math.round(eligible*(.124+index*.00022+wave(index+4,8,.012)+activationLift*.6)));
    return {date,surface,eligible,activatedWithin7,activatedSameDay};
  });
}).flat();
const sumField=(rows,field) => rows.reduce((sum,row) => sum+row[field],0);
const matureCohorts = date => activationFacts.filter(row => row.date >= dayOffset(date,-13) && row.date <= dayOffset(date,-7));
const activationRows = days.map(date => {
  const mature=matureCohorts(date),sameDay=activationFacts.filter(row => row.date === date);
  const eligibleInstalls=sumField(mature,"eligible"),activatedWithin7=sumField(mature,"activatedWithin7");
  const dailyInstalls=sumField(sameDay,"eligible"),activatedSameDay=sumField(sameDay,"activatedSameDay");
  return {plugin,date,cohortStart:dayOffset(date,-13),cohortEnd:dayOffset(date,-7),eligibleInstalls,activatedWithin7,
    d7ActivationRate:eligibleInstalls ? activatedWithin7/eligibleInstalls : null,dailyInstalls,activatedSameDay,
    sameDayActivationRate:dailyInstalls ? activatedSameDay/dailyInstalls : null};
});
const activationSurfaceRows = days.flatMap(date => ["Codex","ChatGPT"].map(surface => {
  const mature=matureCohorts(date).filter(row => row.surface === surface);
  const eligibleInstalls=sumField(mature,"eligible"),activatedWithin7=sumField(mature,"activatedWithin7");
  return {plugin,date,surface,eligibleInstalls,activatedWithin7,activationRate:eligibleInstalls ? activatedWithin7/eligibleInstalls : null};
}));

const weeklyCohorts = ["2026-06-08","2026-06-22","2026-07-06","2026-07-20","2026-08-03","2026-08-17"];
const cohortActivationRows = weeklyCohorts.flatMap(cohortStart => {
  const facts=activationFacts.filter(row => row.date >= cohortStart && row.date <= dayOffset(cohortStart,6));
  const eligibleInstalls=sumField(facts,"eligible");
  return Array.from({length:12},(_,week) => {
    const date=dayOffset(cohortStart,(week+1)*7-1);
    const activatedInstalls=sumField(facts.map(fact => {
      const age=(Date.parse(date)-Date.parse(fact.date))/86400000;
      const activated=age < 7 ? fact.activatedSameDay + (fact.activatedWithin7-fact.activatedSameDay)*Math.max(0,age)/7
        : fact.activatedWithin7 + (fact.eligible-fact.activatedWithin7)*.18*(1-Math.exp(-(age-7)/18));
      return {count:Math.round(activated)};
    }),"count");
    return {plugin,date,cohortStart,cohort:new Intl.DateTimeFormat("en-US",{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(cohortStart)),
      week:String(week),eligibleInstalls,activatedInstalls,activationRate:eligibleInstalls ? activatedInstalls/eligibleInstalls : null};
  }).filter(row => row.date <= days.at(-1));
});

const timingCohorts=activationFacts.filter(row => row.date >= days[0] && row.date <= dayOffset(days.at(-1),-7));
const timingUsers=sumField(timingCohorts,"activatedWithin7");
const timingBuckets=["Within 1 hour","1–6 hours","6–24 hours","Day 1","Days 2–3","Days 4–7"];
const timingCounts=allocate(timingUsers,[426,224,157,121,96,64]);
const timeToSkillRows=timingBuckets.map((timeBucket,i) => ({plugin,pluginLabel:"Data Analytics",timeBucket,users:timingCounts[i],
  cohortStart:days[0],cohortEnd:dayOffset(days.at(-1),-7),activatedUsers:timingUsers}));

const launchGrowth = (index, plateau, jump, finish) => {
  if (index < 7) return 0;
  if (index < 14) return plateau * (index - 7) / 7;
  if (index < 48) return plateau + wave(index, 18, plateau * 0.035);
  if (index < 56) return plateau + (jump - plateau) * (index - 48) / 8;
  return jump + (finish - jump) * (index - 56) / 24 + wave(index, 10, finish * 0.025);
};

const activityRows = [];
days.forEach((date,index) => {
  const base=installRows[index].installedUsers;
  const dau=Math.round(base*Math.max(.08,launchGrowth(index,8200,31500,50000)/50000*.35));
  const weekday=new Date(date+"T00:00:00Z").getUTCDay(),workday=weekday>0&&weekday<6 ? 1 : .58;
  const dailyConversations=Math.max(dau,Math.round(dau*(1.72+wave(index+2,18,.18))*workday));
  const dailyTurns=Math.max(dailyConversations,Math.round(dau*(3.15+wave(index,16,.35))*workday));
  const daily={plugin,date,dau,dailyTurns,dailyConversations};
  const window=[...activityRows.slice(-6),daily],complete=window.length===7;
  const desired=Math.round(base*Math.max(.2,launchGrowth(index,28500,104000,168000)/168000*.8));
  const wau=complete ? Math.min(base,sumField(window,"dau"),Math.max(...window.map(row=>row.dau),desired)) : null;
  activityRows.push({...daily,wau,stickiness:wau ? dau/wau : null,
    weeklyTurns:complete ? sumField(window,"dailyTurns") : null,
    weeklyConversations:complete ? sumField(window,"dailyConversations") : null});
});

const finalBase=installRows.at(-1).installedUsers,finalWau=activityRows.at(-1).wau;
const installedByRole=allocate(finalBase,roles.map(row=>row.installed));
const activeByRole=roles.map(()=>0);
let remainingActive=finalWau;
while (remainingActive) {
  const eligibleRoles=roles.map((row,i)=>installedByRole[i]>activeByRole[i] ? i : -1).filter(i=>i>=0);
  const shares=allocate(remainingActive,eligibleRoles.map(i=>installedByRole[i]*roles[i].activeShare));
  for(const [position,i] of eligibleRoles.entries()) {
    const count=Math.min(shares[position],installedByRole[i]-activeByRole[i]);
    activeByRole[i]+=count; remainingActive-=count;
  }
}
const roleRows=roles.map((row,i) => ({plugin,asOf:days.at(-1),role:row.role,installedUsers:installedByRole[i],
  l7ActiveUsers:activeByRole[i],l7ActiveShare:activeByRole[i]/installedByRole[i],installBaseShare:installedByRole[i]/finalBase}));

const plans = [
  ["Business", 0.045], ["Edu", 0.025], ["Enterprise", 0.028], ["Free", 0.055],
  ["Other", 0.018], ["Plus", 0.48], ["Pro", 0.32], ["Pro Lite", 0.029],
];

const activityPlanRows = activityRows.flatMap((row,index) => {
  const weights=plans.map(([plan,share],i) => Math.max(.006,share+(index>48 ? plan==="Plus" ? .1 : plan==="Pro" ? -.09 : 0 : 0)+wave(index+i*2,31,.006)));
  const counts=row.wau == null ? plans.map(()=>null) : allocate(row.wau,weights);
  return plans.map(([plan],i)=>({plugin,date:row.date,plan,wau:counts[i]}));
});

const activitySurfaces = [
  ["ChatGPT Chat", 0.46], ["ChatGPT Mobile — Work", 0.11], ["ChatGPT Other", 0.018],
  ["ChatGPT Web — Work", 0.265], ["Codex CLI", 0.032], ["Codex Desktop — Codex", 0.036],
  ["Codex Desktop — Work", 0.052], ["Codex Exec", 0.014], ["Codex IDE", 0.026],
];

const activitySurfaceRows = activityRows.flatMap((row,index) => {
  const weights=activitySurfaces.map(([,share],i)=>Math.max(.004,share+wave(index+i*3,27,.008)));
  const counts=row.wau == null ? activitySurfaces.map(()=>null) : allocate(row.wau,weights);
  // A small explicitly overlapping population uses a second surface. Never sum this series as global WAU.
  return activitySurfaces.map(([surface],i)=>({plugin,date:row.date,surface,
    wau:row.wau == null ? null : Math.min(row.wau,counts[i]+Math.round(row.wau*.008))}));
});

const activityRatioRows = days.flatMap((date, index) => {
  const activity=activityRows[index];
  const turnsAverage=activity.wau ? activity.weeklyTurns/activity.wau : null;
  const conversationsAverage=activity.wau ? activity.weeklyConversations/activity.wau : null;
  return [
    { plugin, date, measure: "Turns / WAU", metric: "Avg", value: turnsAverage },
    { plugin, date, measure: "Turns / WAU", metric: "P50", value: activity.wau == null ? null : index < 47 ? 2 : 2.2 },
    { plugin, date, measure: "Turns / WAU", metric: "P90", value: activity.wau == null ? null : 5 + Math.floor(index / 14) * 1.4 + (index > 54 ? 1.2 : 0) },
    { plugin, date, measure: "Conversations / WAU", metric: "Avg", value: conversationsAverage },
    { plugin, date, measure: "Conversations / WAU", metric: "P50", value: activity.wau == null ? null : index < 12 ? 2 : 1 },
    { plugin, date, measure: "Conversations / WAU", metric: "P90", value: activity.wau == null ? null : 4 + Math.floor(index / 18) + (index > 58 ? 1 : 0) },
  ];
});

const retentionCohorts = [
  "2026-06-01", "2026-06-08", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-06",
  "2026-07-13", "2026-07-20", "2026-07-27", "2026-08-03", "2026-08-10",
];

const retentionRows = retentionCohorts.flatMap((cohort, cohortIndex) => {
  const cohortLabel = new Intl.DateTimeFormat("en-US", {
    month: "short", day: "2-digit", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${cohort}T00:00:00Z`));
  const cohortShortLabel = new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(`${cohort}T00:00:00Z`));
  const observedWeeks = Math.min(8, Math.floor((Date.parse(days.at(-1))-Date.parse(cohort))/604800000)-1);
  return Array.from({ length: observedWeeks + 1 }, (_, week) => {
    const retention = week === 0 ? 1 : Math.max(0.16, Math.min(0.52 + retentionLift,
      0.38 + retentionLift - (week - 1) * 0.018 + wave(cohortIndex * 2 + week, 8, 0.075)
      + (week >= 5 ? 0.01 : 0) - ((cohortIndex * 3 + week) % 11 === 0 ? 0.13 : 0)));
    return {
      plugin,
      date: dayOffset(cohort,(week+1)*7-1),
      cohort,
      cohortLabel,
      cohortShortLabel,
      week: `${week}`,
      eligibleCustomers: 140+cohortIndex*19,
      retainedCustomers: Math.round((140+cohortIndex*19)*retention),
      retention: Math.round((140+cohortIndex*19)*retention)/(140+cohortIndex*19),
    };
  });
});

const flowBranches = [
  { conversationType: "Implicit skill call", contextStatus: "No user context", users: 920, shift: 0 },
  { conversationType: "Implicit skill call", contextStatus: "User context", users: 146, shift: 3 },
  { conversationType: "Explicit plugin call", contextStatus: "No user context", users: 132, shift: 5 },
  { conversationType: "Explicit plugin call", contextStatus: "User context", users: 94, shift: 7 },
  { conversationType: "Explicit skill call", contextStatus: "No user context", users: 61, shift: 9 },
  { conversationType: "Explicit skill call", contextStatus: "User context", users: 48, shift: 11 },
];

const flowSkills = [
  ["data-analytics:index", 18],
  ["data-analytics:product-business-analysis", 15],
  ["data-analytics:gather-business-context", 7],
  ["data-analytics:metric-diagnostics", 6],
  ["data-analytics:validate-data", 4.5],
  ["data-analytics:analyze-data-quality", 4],
  ["data-analytics:design-kpis", 3.5],
  ["data-analytics:market-sizing", 2.2],
  ["data-analytics:kpi-reporting", 3],
  ["data-analytics:visualize-data", 11],
  ["data-analytics:build-dashboard", 10],
  ["data-analytics:build-report", 8],
  ["data-analytics:create-data-context", 5],
  ["data-analytics:jupyter-notebooks", 2.5],
  ["data-analytics:publish-artifact-to-sites", 1.9],
  ["data-analytics:convert-to-slides", 1.6],
  ["data-analytics:convert-to-doc", 1.4],
  ["Other skill combination", 4.8],
  ["No skill", 2.8],
];

const flowRows = flowBranches.flatMap((branch, branchIndex) => {
  branch = { ...branch, users: Math.round(branch.users * flowScale) };
  const weightedSkills = flowSkills.map(([skill, baseWeight], skillIndex) => ({
    skill,
    weight: baseWeight * (0.82 + ((skillIndex + branch.shift) % 7) * 0.06)
      * (branch.contextStatus === "User context" && skill.includes("context") ? 1.55 : 1),
  }));
  const totalWeight = weightedSkills.reduce((total, entry) => total + entry.weight, 0);
  const quotas=weightedSkills.map(({skill,weight}) => ({skill,exact:branch.users*weight/totalWeight}));
  const allocated=quotas.map(row => Math.floor(row.exact));
  const remainder=branch.users-allocated.reduce((sum,count) => sum+count,0);
  const order=quotas.map((row,index) => ({index,fraction:row.exact-allocated[index]})).sort((a,b) => b.fraction-a.fraction);
  for(let i=0;i<remainder;i++) allocated[order[i].index]++;
  return quotas.map(({skill},index) => ({plugin,conversationType:branch.conversationType,
    contextStatus:branch.contextStatus,skill,users:allocated[index],branchUsers:branch.users}));
});

const flowUserTotal = flowRows.reduce((total, row) => total + row.users, 0);
flowRows.forEach((row) => { row.share = round(row.users / flowUserTotal, 4); });

const source = (label, table, componentIds, definition) => ({
  label: `${label} (mock data)`,
  caveats:["Synthetic aggregate fixture; no external query was executed and no user-level drilldown is available."],
  sql: `SELECT * FROM ${table} WHERE plugin = 'data-analytics'`,
  tables: [table],
  metricDefinitions: [{
    label,
    definition,
    componentIds,
    sourceLineage: [{ tables: [table] }],
  }],
});

const snapshot = {
  id: "plugin-deep-dive-example",
  title: "Plugin deep dive",
  generatedAt: "2026-08-22T18:00:00Z",
  status: "fixture",
  surface: "dashboard",
  filters: [{
    id: "plugin",
    label: "Plugin",
    field: "plugin",
    defaultValue: plugin,
    allLabel: "All plugins",
    choiceLabels: { [plugin]: "Data Analytics" },
    placeholder: "Search plugins",
    queryIds: [
      "installs", "install_surfaces", "signup_cohorts", "roles", "new_users",
      "activation", "activation_surfaces", "activation_cohorts", "time_to_skill",
      "activity", "activity_plans", "activity_surfaces", "activity_ratios", "retention", "first_conversation_flow",
    ],
  }, {
    id: "date",
    label: "Date range",
    field: "date",
    mode: "through",
    defaultValue: days.at(-1),
    queryIds: [
      "installs", "install_surfaces", "signup_cohorts", "new_users", "activation", "activation_surfaces", "activation_cohorts",
      "activity", "activity_plans", "activity_surfaces", "activity_ratios", "retention",
    ],
  }],
  queries: {
    installs: {
      rows: installRows,
      source: source("Plugin installs", "mock.plugin_installs_daily", [
        "installed-users", "daily-installs",
      ], `Synthetic first installs and final removals; opening base is ${openingBase}. Installed users reconcile daily as opening base plus first installs minus removals. Repeated surface install records are separate.`),
    },
    install_surfaces: {
      rows: surfaceRows,
      source: source("Installed users by surface", "mock.plugin_install_surfaces_daily", [
        "installs-by-surface",
      ], "Mock current install records and distinct installed users by product surface."),
    },
    signup_cohorts: {
      rows: cohortInstallRows,
      source: source("Installs by signup cohort", "mock.plugin_installs_by_signup_cohort", ["installs-by-cohort"],
        "Mock daily installs split by the user's Codex signup age."),
    },
    roles: {
      rows: roleRows,
      source: source("Install base by onboarding role", "mock.plugin_install_base_by_role", ["installs-by-role"],
        "Mock installed users and latest-seven-day activity by self-reported onboarding role."),
    },
    new_users: {
      rows: newUserRows,
      source: source("New-user D1 install rate", "mock.plugin_new_user_install_rate", ["new-user-install-rate"],
        "Mock share of new Codex users who install the plugin on their first day."),
    },
    activation: {
      rows: activationRows,
      source: source("Plugin activation", "mock.plugin_activation_daily", ["d7-activation", "same-day-activation"],
        "Ratio of activated to eligible installs across the seven fully matured cohort days ending seven days before each observation date; same-day rates use that day’s install cohort. Counts are explicit synthetic aggregates."),
    },
    activation_surfaces: {
      rows: activationSurfaceRows,
      source: source("Activation by first install surface", "mock.plugin_activation_by_surface", ["d7-activation-by-surface"],
        "Mock D7 activation attributed to each user's first install surface."),
    },
    activation_cohorts: {
      rows: cohortActivationRows,
      source: source("Cumulative activation by install cohort", "mock.plugin_activation_cohorts", ["activation-cohort-curve"],
        "Mock cumulative activation for weekly install cohorts."),
    },
    time_to_skill: {
      rows: timeToSkillRows,
      source: source("Time to first non-index skill", "mock.plugin_time_to_first_skill", ["time-to-first-skill"],
        "Mock distribution of the first non-index skill invocation within seven days of install."),
    },
    activity: {
      rows: activityRows,
      source: source("Plugin activity", "mock.plugin_activity_daily", [
        "activity-dau", "activity-wau", "activity-stickiness", "activity-daily-turns",
        "activity-weekly-turns", "activity-conversations", "activity-weekly-conversations",
      ], "Synthetic active users are within the installed base. DAU is no greater than WAU, and WAU lies between the maximum and sum of seven daily user counts. Weekly turns and conversations sum seven daily facts. Incomplete trailing weeks are null."),
    },
    activity_plans: {
      rows: activityPlanRows,
      source: source("Plugin activity by plan", "mock.plugin_activity_by_plan", [
        "activity-wau-plan", "activity-wau-plan-mix",
      ], "Mock trailing-week active plugin users split by account plan."),
    },
    activity_surfaces: {
      rows: activitySurfaceRows,
      source: source("Plugin activity by surface", "mock.plugin_activity_by_surface", [
        "activity-wau-surface",
      ], "Synthetic overlapping surface WAU; each surface is bounded by global WAU, but surfaces are not additive. First six dates lack complete trailing-week evidence and remain null."),
    },
    activity_ratios: {
      rows: activityRatioRows,
      source: source("Plugin activity per weekly user", "mock.plugin_activity_ratios", [
        "activity-turns-per-wau", "activity-conversations-per-wau",
      ], "Mock average, median, and 90th-percentile weekly activity per weekly active user."),
    },
    retention: {
      rows: retentionRows,
      source: source("Weekly retention by activation cohort", "mock.plugin_weekly_retention", [
        "weekly-retention", "retention-triangle",
      ], "Mock exact-week retention after each user's first mapped high-value plugin action."),
    },
    first_conversation_flow: {
      rows: flowRows,
      source: source("First conversation skill flow", "mock.plugin_first_conversation_flow", ["first-conversation-flow"],
        "Mock first plugin-related conversation paths from request type through context status to first skill."),
    },
  },
};

const result = exampleLabels(snapshot, labels);
if (labels) result.exampleLabels = labels;
if (id) result.id = id;
if (title) result.title = title;
return { snapshot: result, activationFacts: exampleLabels(activationFacts, labels) };
}


// One presentation, independently generated evidence for a fictional workflow product.
export const { snapshot, activationFacts } = createLifecycleFixture({
  id: "acme-workflow-adoption", title: "Acme Cloud automation usage",
  openingBase: 1560, installScale: 1.35, activationLift: .045,
  retentionLift: .04, flowScale: 1.4,
  labels: {
    "Plugin deep dive": "Automation usage",
    "Data Analytics": "Acme Automations", "data-analytics": "workflow-automation", "Plugin": "Product",
    "Codex": "Acme Studio", "ChatGPT": "Acme Chat", "mock.plugin_": "fixture.acme_",
  },
});
export function fixture() { return structuredClone(snapshot); }
