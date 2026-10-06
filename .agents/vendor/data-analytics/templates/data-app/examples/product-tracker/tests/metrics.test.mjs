import assert from "node:assert/strict";
import test from "node:test";
import { fixture, weeks } from "../fixtures/generate.mjs";
import { buildProductModel, feedbackFlow, feedbackStages, featureUsage } from "../content/dashboard/product-model.js";
import { sankeyGraph } from "../../../base/src/charting/chart-transforms.js";

test("workspace growth reconciles to independently counted current and previous sets", () => {
  const { queries } = fixture();
  for (const plan of ["all", "Starter", "Team", "Business"]) for (const week of weeks.slice(1)) {
    const model = buildProductModel(queries, { week, plan });
    const rows = queries.workspace_activity.rows.filter(row => row.week === week && (plan === "all" || row.plan === plan));
    const active = new Set(rows.filter(row => row.completedTasks > 0).map(row => row.workspaceId));
    assert.equal(model.current.activeWorkspaces, active.size);
    assert.equal(model.current.previousActive + model.current.newActive + model.current.reactivated - model.current.dormant, active.size);
    assert.equal(model.current.completedTasks, rows.reduce((sum, row) => sum + row.completedTasks, 0));
  }
});
test("activation and retention use independently checked maturity and denominators", () => {
  const { queries } = fixture(), model = buildProductModel(queries, { week: weeks.at(-1) });
  for (const cohort of model.cohorts) {
    const members = queries.workspace_roster.rows.filter(row => row.cohort === cohort.cohort);
    const createdAt = Date.parse(cohort.cohort), cutoff = Date.parse(model.asOf);
    assert.equal(cohort.eligible, createdAt + 7 * 86400000 <= cutoff ? members.length : 0);
    assert.equal(cohort.retainedEligible, createdAt + 34 * 86400000 <= cutoff ? members.length : 0);
    if (!cohort.retainedEligible) assert.equal(cohort.retentionRate, null);
    else {
      const week4 = new Date(createdAt + 28 * 86400000).toISOString().slice(0, 10);
      const ids = new Set(members.map(row => row.workspaceId));
      const retained = queries.workspace_activity.rows.filter(row => row.week === week4 && ids.has(row.workspaceId) && row.completedTasks > 0).length;
      assert.equal(cohort.retained, retained);
      assert.equal(cohort.retentionRate, retained / members.length);
    }
    if (cohort.eligible) assert.equal(cohort.activated, members.filter(row => row.activationDay != null && row.activationDay <= 7).length);
  }
  const funnel = model.funnel.map(row => row.count);
  assert.ok(funnel.every((value, i) => !i || value <= funnel[i - 1]));
  assert.equal(funnel.at(-2), model.activation.activated);
  assert.ok(model.retention.some(row => row.retentionRate === null));
});
test("onboarding stages reconcile to observed lifecycle facts, including the collaboration leak", () => {
  const { queries } = fixture();
  const fields = ["invitedDay", "projectDay", "taskDay", "activationDay", "teammateTaskDay"];
  for (const row of queries.workspace_roster.rows) {
    for (let i = 1; i < fields.length; i++) if (row[fields[i]] != null) {
      assert.notEqual(row[fields[i - 1]], null);
      assert.ok(row[fields[i]] >= row[fields[i - 1]], `${fields[i]} follows its prerequisite`);
    }
    for (const field of ["activationDay", "teammateTaskDay"]) if (row[field] != null) {
      const week = new Date(Date.parse(row.cohort) + Math.floor(row[field] / 7) * 7 * 86400000).toISOString().slice(0, 10);
      assert.ok(queries.workspace_activity.rows.find(item => item.workspaceId === row.workspaceId && item.week === week).completedTasks > 0);
    }
  }
  for (const week of weeks) for (const plan of ["all", "Starter", "Team", "Business"]) {
    const model = buildProductModel(queries, { week, plan });
    const cohort = queries.workspace_roster.rows.filter(row => (plan === "all" || row.plan === plan)
      && Date.parse(row.cohort) >= Date.parse(week) - 28 * 86400000
      && Date.parse(row.cohort) + 7 * 86400000 <= Date.parse(week) + 6 * 86400000);
    assert.deepEqual(model.funnel.map(row => row.count), [cohort.length,
      ...fields.map(field => cohort.filter(row => row[field] != null && row[field] <= 7).length)]);
  }
  const counts = buildProductModel(queries).funnel.map(row => row.count);
  const losses = counts.slice(1).map((value, i) => counts[i] - value);
  assert.equal(losses.indexOf(Math.max(...losses)), losses.length - 1);
});

test("paid features exclude Starter and zero eligible populations remain unavailable", () => {
  const { queries } = fixture();
  const model = buildProductModel(queries, {});
  const rows = queries.workspace_activity.rows.filter(row => row.week === weeks.at(-1) && row.completedTasks > 0 && row.plan !== "Starter");
  const automation = model.featureSummary.find(row => row.feature === "Automations");
  assert.equal(automation.eligible, rows.length);
  assert.equal(automation.adopters, rows.filter(row => row.automations > 0).length);
  assert.equal(buildProductModel(queries, { plan: "Starter" }).featureSummary.find(row => row.feature === "Automations").adoptionRate, null);
  const empty = buildProductModel(queries, { region: "Missing" });
  assert.equal(empty.current.activeWorkspaces, 0);
  assert.equal(empty.current.activationRate, null);
  assert.equal(empty.workspaces.length, 0);
  assert.equal(featureUsage({ plan: "Starter", automations: 0 }, "Automations"), "Not included");
  assert.equal(featureUsage({ plan: "Team", automations: 0 }, "Automations"), "Not used");
  assert.equal(featureUsage({ plan: "Team", automations: 2 }, "Automations"), "Used");
  assert.equal(featureUsage({ plan: "Starter", completedTasks: 3 }, "Task boards"), "Used");
  assert.equal(featureUsage({ plan: "Team", automations: null }, "Automations"), "Not observed");
});
test("earlier cutoffs cannot read later workspaces, activity, or mature cohorts", () => {
  const { queries } = fixture(), model = buildProductModel(queries, { week: weeks[7], channel: "Paid search" });
  assert.ok(model.activity.every(row => row.week <= weeks[7] && row.channel === "Paid search"));
  assert.ok(model.roster.every(row => row.cohort <= weeks[7] && row.channel === "Paid search"));
  assert.equal(model.cohorts.at(-1).activationRate, null);
  assert.ok(model.roster.every(row => row.activationDay == null || Date.parse(row.cohort) + row.activationDay * 86400000 <= Date.parse(model.asOf)));
  const selected = buildProductModel(queries, { week: weeks[7], cohort: weeks[2] });
  assert.ok(selected.roster.every(row => row.cohort === weeks[2]));
  assert.ok(selected.activity.every(row => row.cohort === weeks[2] && row.week <= weeks[7]));
  assert.equal(new Set(queries.workspace_roster.rows.map(row => row.workspaceId)).size, queries.workspace_roster.rows.length);
  assert.equal(new Set(queries.workspace_roster.rows.map(row => row.workspace)).size, queries.workspace_roster.rows.length);
});

test("feedback paths preserve source counts, scoped dates and conservation through skipped stages", () => {
  const { queries } = fixture();
  const ledger = queries.workspace_feedback.rows;
  assert.equal(new Set(ledger.map(row => row.feedbackId)).size, ledger.length);
  const roster = new Map(queries.workspace_roster.rows.map(row => [row.workspaceId, row]));
  for (const row of ledger) {
    assert.equal(row.mentions, 1);
    assert.ok(row.week >= roster.get(row.workspaceId).cohort);
    for (const field of ["plan", "channel", "region"]) assert.equal(row[field], roster.get(row.workspaceId)[field]);
  }
  for (const week of [weeks[0], weeks[7], weeks.at(-1)]) for (const plan of ["all", "Team"]) {
    const expected = ledger.filter(row => row.week <= week && Date.parse(week) - Date.parse(row.week) <= 21 * 86400000 && (plan === "all" || row.plan === plan));
    const model = buildProductModel(queries, { week, plan });
    assert.deepEqual(model.feedback, expected);
    for (const selected of [{}, { roadmap: ["Unplanned"] }, { feedbackSource: ["Support", "In-product"] }, { theme: ["Missing"] }]) {
      const { rows, sourceRows } = feedbackFlow(model.feedback, selected);
      const matched = expected.filter(row => Object.entries(selected).every(([field, values]) => values.includes(row[field])));
      assert.deepEqual(sourceRows, matched);
      assert.equal(rows.reduce((sum, row) => sum + row.mentions, 0), matched.length);
      const graph = sankeyGraph(rows, feedbackStages, "mentions");
      const flow = (stage, edge) => graph.links.filter(link => graph.nodes[link[edge]].stage === stage).reduce((sum, link) => sum + link.value, 0);
      assert.equal(flow(0, "source"), matched.length);
      assert.equal(flow(3, "target"), matched.length);
      graph.nodes.forEach((node, index) => {
        if (node.stage === 0 || node.stage === 3) return;
        const total = edge => graph.links.filter(link => link[edge] === index).reduce((sum, link) => sum + link.value, 0);
        assert.equal(total("source"), total("target"));
      });
      if (selected.roadmap) assert.ok(graph.nodes.every(node => node.stage !== 2), "Unplanned skips feature without fabricating a node");
    }
  }
});
