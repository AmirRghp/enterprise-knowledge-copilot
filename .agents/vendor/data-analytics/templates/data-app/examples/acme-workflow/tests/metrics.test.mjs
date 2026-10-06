import assert from "node:assert/strict";
import profileTest from "node:test";
import { filterReviewedRows } from "../../../base/src/use-data-app.js";

import { fixture as acmeFixture, activationFacts as acmeFacts } from "../fixtures/generate.mjs";

for (const { name, fixture, activationFacts, openingBase } of [
  { name: "Acme Cloud", fixture: acmeFixture, activationFacts: acmeFacts, openingBase: 1560 },
]) {
const test = (title, run) => profileTest(name + ": " + title, run);
test("fixture preserves its base measurement invariants", () => {
  const data = fixture();
  for (const row of data.queries.first_conversation_flow.rows) assert.ok(Number.isSafeInteger(row.users) && row.users >= 0);
  for (const row of data.queries.retention.rows) assert.ok(row.retention == null || row.retention >= 0 && row.retention <= 1);
});

test("activation ratios combine mature cohort counts and reconcile first-install surfaces", () => {
  const data=fixture(),sum=(rows,field) => rows.reduce((n,row) => n+row[field],0);
  for(const row of data.queries.activation.rows) {
    const mature=activationFacts.filter(fact => fact.date >= row.cohortStart && fact.date <= row.cohortEnd);
    assert.equal((Date.parse(row.date)-Date.parse(row.cohortEnd))/86400000,7);
    assert.equal(row.eligibleInstalls,sum(mature,"eligible"));
    assert.equal(row.activatedWithin7,sum(mature,"activatedWithin7"));
    assert.equal(row.d7ActivationRate,row.activatedWithin7/row.eligibleInstalls);
    assert.equal(row.sameDayActivationRate,row.activatedSameDay/row.dailyInstalls);
    const surfaces=data.queries.activation_surfaces.rows.filter(surface => surface.date === row.date);
    assert.equal(sum(surfaces,"eligibleInstalls"),row.eligibleInstalls);
    assert.equal(sum(surfaces,"activatedWithin7"),row.activatedWithin7);
  }
});

test("cohort maturity uses observation dates and flow branches conserve their defined counts", () => {
  const data=fixture();
  for(const key of ["activation_cohorts","retention"]) {
    for(const row of data.queries[key].rows) assert.ok(row.date <= "2026-08-21");
    const earlier=filterReviewedRows(data.queries[key].rows,data.filters,{date:"2026-07-01"},key,["date","cohort","week"]);
    assert.ok(earlier.length && earlier.every(row => row.date <= "2026-07-01"));
  }
  const branches=new Map();
  for(const row of data.queries.first_conversation_flow.rows) {
    const key=row.conversationType+"|"+row.contextStatus;
    const group=branches.get(key) ?? {count:0,total:row.branchUsers};
    group.count+=row.users; branches.set(key,group);
  }
  for(const branch of branches.values()) assert.equal(branch.count,branch.total);
  for(const row of data.queries.activity.rows) assert.equal(row.stickiness,row.wau ? row.dau/row.wau : null);
});

test("installed base, activity and exclusive plan cohorts reconcile across panels", () => {
  const data=fixture(),sum=(rows,field)=>rows.reduce((total,row)=>total+row[field],0);
  let opening=openingBase;
  for(const [index,row] of data.queries.installs.rows.entries()) {
    assert.equal(row.openingInstalledUsers,opening);
    assert.equal(row.installedUsers,opening+row.installs-row.uninstalls);
    opening=row.installedUsers;
    const cohorts=data.queries.signup_cohorts.rows.filter(item=>item.date===row.date);
    assert.equal(sum(cohorts,"installs"),row.installs);
    const surfaces=data.queries.install_surfaces.rows.filter(item=>item.date===row.date);
    assert.equal(sum(surfaces,"distinctUsers")-surfaces[0].crossSurfaceOverlapUsers,row.installedUsers);
    assert.ok(surfaces.every(item=>item.distinctUsers<=row.installedUsers && item.installRecords>=item.distinctUsers));
    const activity=data.queries.activity.rows[index];
    assert.ok(activity.dau<=row.installedUsers);
    assert.ok(activity.dailyTurns>=activity.dailyConversations && activity.dailyConversations>=activity.dau);
    const plans=data.queries.activity_plans.rows.filter(item=>item.date===row.date);
    if(index<6) {
      assert.equal(activity.wau,null); assert.equal(activity.weeklyTurns,null);
      assert.equal(activity.weeklyConversations,null); assert.equal(activity.stickiness,null);
      assert.ok(plans.every(item=>item.wau===null));
    } else {
      const window=data.queries.activity.rows.slice(index-6,index+1);
      assert.ok(activity.wau>=Math.max(...window.map(item=>item.dau)));
      assert.ok(activity.wau<=Math.min(row.installedUsers,sum(window,"dau")));
      assert.equal(activity.weeklyTurns,sum(window,"dailyTurns"));
      assert.equal(activity.weeklyConversations,sum(window,"dailyConversations"));
      assert.equal(sum(plans,"wau"),activity.wau);
      const activitySurfaces=data.queries.activity_surfaces.rows.filter(item=>item.date===row.date);
      assert.ok(activitySurfaces.every(item=>item.wau<=activity.wau));
      assert.ok(sum(activitySurfaces,"wau")>=activity.wau);
    }
  }
  const roles=data.queries.roles.rows;
  assert.equal(sum(roles,"installedUsers"),opening);
  assert.equal(sum(roles,"l7ActiveUsers"),data.queries.activity.rows.at(-1).wau);
  assert.ok(roles.every(row=>row.l7ActiveUsers<=row.installedUsers));
  for(const row of data.queries.new_users.rows) {
    assert.equal(row.d1InstallRate,row.installedNewUsers/row.eligibleNewUsers);
    assert.ok(row.installedNewUsers<=data.queries.signup_cohorts.rows.find(item=>item.date===row.date && item.cohort==="New this week").installs);
  }
});

test("cohort and timing denominators use the eligible install facts, not independent illustration totals", () => {
  const data=fixture(),sum=(rows,field)=>rows.reduce((total,row)=>total+row[field],0);
  const previous=new Map();
  for(const row of data.queries.activation_cohorts.rows) {
    const end=new Date(Date.parse(row.cohortStart)+6*86400000).toISOString().slice(0,10);
    const eligible=activationFacts.filter(fact=>fact.date>=row.cohortStart && fact.date<=end);
    assert.equal(row.eligibleInstalls,sum(eligible,"eligible"));
    assert.equal(row.activationRate,row.activatedInstalls/row.eligibleInstalls);
    assert.ok(row.activatedInstalls<=row.eligibleInstalls && row.activatedInstalls >= (previous.get(row.cohortStart)??0));
    previous.set(row.cohortStart,row.activatedInstalls);
  }
  const timing=data.queries.time_to_skill.rows;
  const mature=activationFacts.filter(row=>row.date>=timing[0].cohortStart && row.date<=timing[0].cohortEnd);
  assert.equal(sum(timing,"users"),sum(mature,"activatedWithin7"));
  assert.ok(timing.every(row=>row.activatedUsers===sum(timing,"users")));
  assert.equal(new Set(timing.map(row=>row.timeBucket)).size,timing.length);
});

}

profileTest("Acme vocabulary and fixture copies preserve reviewed evidence", () => {
  const demo = acmeFixture();
  const { exampleLabels: labels, ...evidence } = demo;
  assert.equal(demo.id, "acme-workflow-adoption");
  assert.doesNotMatch(JSON.stringify(evidence), /Codex|ChatGPT|data-analytics|mock\.plugin_/);
  assert.match(JSON.stringify(evidence), /Acme Studio/);
  demo.queries.installs.rows[0].installs = -1;
  assert.ok(acmeFixture().queries.installs.rows[0].installs > 0);
});
