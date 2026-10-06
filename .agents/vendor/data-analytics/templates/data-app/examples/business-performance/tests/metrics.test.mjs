import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/generate.mjs";
import { accountRows, activation, buildPerformance, change, chartRows, cohortRows, cohortCells, cohortMembers, context, deepDiveModel, fieldLabels,
  performanceGlobalKey, localPerformanceChanges, createPerformanceEngine, buckets, supportedGrains, comparedProductRows, dateRangeLabel, rollingRetentionAt, shiftDate, humanDate, humanMonth, labeledChart, metricEvidence, retentionEvidence, cohortEvidence, migratedTitle, moneyRows, revenueBridge,
  periodRange, priorRange, queryId, revenueRowsForChart, rosterQueryId, summarize, trendRows } from "../content/dashboard/performance-data.js";
import { reviewedComponentClipboard, scopedMetricDefinitions } from "../../../base/src/source-provenance.js";
import { compareTableValues } from "../../../base/src/charting/table-data.js";
import { cohortDrillFocus, captureCohortOrigin, revealCohortCustomers, restoreCohortOrigin } from "../content/dashboard/retention-interaction.js";
const snapshot = fixture();
const filters = { ...Object.fromEntries(snapshot.filters.map(({ id, defaultValue }) => [id, defaultValue])), date:"2026-05-18..2026-08-16" }; // Explicit historical regression window, not the authored default.
const queries = snapshot.queries;
const rows = queries[queryId].rows;
const roster = queries[rosterQueryId].rows;
const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const defaultModel = buildPerformance(queries, filters);

test("explicit cohort drill-down preserves observation scope and resets a stale status filter", () => {
  const prior = { entryStart:"2025-11",entryEnd:"2026-03",asOf:"2026-08-16",cohort:"2025-11",age:"1",status:"Lost" };
  const cell = {cohort:"2026-02",age:3,mature:true,retentionRate:0};
  assert.deepEqual(cohortDrillFocus(prior,cell), {...prior,cohort:"2026-02",age:"3",status:"all"});
  assert.equal(prior.status,"Lost");
  assert.equal(cohortDrillFocus(prior,{...cell,mature:false}),null);
  assert.equal(cohortDrillFocus(prior,{...cell,retentionRate:null}),null);
});

test("cohort drill-down focuses its destination and Back restores both scroll axes and the original cell", () => {
  const calls=[], table={scrollLeft:225};
  const mark={closest:()=>table,focus:options=>calls.push(["cell-focus",options])};
  const detail={style:{},focus:options=>calls.push(["detail-focus",options]),scrollIntoView:options=>calls.push(["detail-scroll",options])};
  const view={scrollX:0,scrollY:340,scrollTo:options=>calls.push(["restore-scroll",options]),document:{
    getElementById:id=>id==="retention-2025-11-3" ? mark : null,
    querySelector:selector=>selector.includes("cohort-members") ? detail : {getBoundingClientRect:()=>({height:selector.includes("topbar") ? 88 : 57})},
  }};
  const origin=captureCohortOrigin({cohort:"2025-11",age:3},view);
  assert.deepEqual(origin,{cellId:"retention-2025-11-3",x:0,y:340,scrollLeft:225});
  revealCohortCustomers(view);
  assert.equal(detail.style.scrollMarginTop,"161px");
  assert.deepEqual(calls.slice(0,2),[["detail-focus",{preventScroll:true}],["detail-scroll",{block:"start",behavior:"instant"}]]);
  table.scrollLeft=0;
  restoreCohortOrigin(origin,view);
  assert.equal(table.scrollLeft,225);
  assert.deepEqual(calls.slice(2),[["restore-scroll",{left:0,top:340,behavior:"instant"}],["cell-focus",{preventScroll:true}]]);
});

test("fixture reproduces an independently covered multi-product contract-day panel", () => {
  assert.deepEqual(snapshot, fixture());
  assert.equal(new Set(rows.map(row => `${row.date}|${row.contractId}`)).size, rows.length);
  assert.equal(new Set(roster.map(row => row.accountId)).size, 180);
  assert.ok(roster.length > 180);
  const byId = new Map(roster.map(contract => [contract.contractId, contract]));
  for (const row of rows) {
    const contract = byId.get(row.contractId);
    assert.ok(row.date >= contract.startDate && row.date <= (contract.endDate ?? "2026-08-16"));
    assert.equal(row.revenueUsd, row.subscriptionUsd + row.usageUsd);
    assert.ok(row.costUsd >= 0 && row.completedRuns >= 0);
    assert.ok(row.activeUserIds.length <= row.seats);
    assert.equal(new Set(row.activeUserIds).size, row.activeUserIds.length);
  }
});

test("deep-dive economics, concentration, paid retention, and revenue bridge reconcile", () => {
  const deep = deepDiveModel(queries, filters, defaultModel);
  const currentRows = rows.filter(row => row.date >= "2026-05-18");
  assert.equal(deep.current.grossProfitUsd, currentRows.reduce((sum,row)=>sum+row.revenueUsd-row.costUsd,0));
  const payingAt = date => new Set(roster.filter(row => row.startDate <= date && (!row.endDate || row.endDate >= date)).map(row=>row.accountId));
  const previous = payingAt("2026-05-17"), current = payingAt("2026-08-16");
  const retained = [...previous].filter(id=>current.has(id)).length;
  approx(deep.current.paidAccountRetention, retained / previous.size);
  assert.equal(deep.current.churnedAccounts, previous.size - retained);
  const products = new Map([...current].map(id=>[id,new Set(roster.filter(row=>row.accountId===id && row.startDate <= "2026-08-16" && !row.endDate).map(row=>row.product))]));
  approx(deep.current.multiProductShare, [...products.values()].filter(set=>set.size>1).length / current.size);
  const topFive = defaultModel.accounts.toSorted((a,b) => b.revenueUsd - a.revenueUsd).slice(0,5);
  approx(deep.current.topFiveShare, topFive.reduce((sum,row) => sum + row.revenueUsd, 0) / defaultModel.current.revenueUsd);
  assert.equal(deep.bridge[0].bridgeUsd + deep.bridge.slice(1,-1).reduce((sum,row) => sum + row.bridgeUsd,0), deep.bridge.at(-1).bridgeUsd);
  assert.ok(deep.bridge.slice(1,-1).every(row => row.bridgeUsd !== 0));
  assert.ok(deep.movements.some(row => row.deltaUsd === 0));
  assert.equal(deep.weekly.reduce((sum,row) => sum + row.grossProfitUsd,0), deep.current.grossProfitUsd);
  assert.ok(deep.bridge.every(row => row.periodStart === "2026-05-18" && row.comparisonEnd === "2026-05-17"));
  assert.deepEqual(revenueBridge({ ...defaultModel, deltaUsd: null }), []);
});

test("activation cohorts isolate unknown evidence and preserve earlier cohorts", () => {
  const firstPaid = Object.values(Object.groupBy(roster, row => row.accountId)).map(contracts => ({ accountId: contracts[0].accountId,
    start: contracts.map(row => row.startDate).sort()[0] })).find(row => row.start === "2026-07-02");
  const end = new Date(Date.parse(firstPaid.start) + 6 * 86400000).toISOString().slice(0, 10);
  const original = deepDiveModel(queries, filters, defaultModel).activationCohorts;
  for (const remove of [false, true]) {
    const missing = structuredClone(queries);
    const isUnknown = row => row.accountId === firstPaid.accountId && row.date >= firstPaid.start && row.date <= end;
    missing[queryId].rows = remove ? missing[queryId].rows.filter(row => !isUnknown(row))
      : missing[queryId].rows.map(row => isUnknown(row) ? { ...row, completedRuns: null } : row);
    const m = buildPerformance(missing, filters);
    const cohorts = deepDiveModel(missing, filters, m).activationCohorts;
    assert.deepEqual(cohorts.filter(row => row.cohortEnd < firstPaid.start), original.filter(row => row.cohortEnd < firstPaid.start));
    const affected = cohorts.find(row => row.cohortStart <= firstPaid.start && row.cohortEnd >= firstPaid.start);
    assert.equal(affected.activatedAccounts, null);
    assert.equal(affected.activationRate, null);
    assert.equal(affected.unknownAccounts, 1);
  }
});

test("human labels preserve money and explicit percent display units without mutating reviewed ratios", () => {
  assert.equal(humanMonth("2026-02"), "Feb 2026");
  assert.equal(humanDate("2026-08-16"), "Aug 16, 2026");
  const raw = [{ revenueUsd: 100, previousRevenueUsd: null, netRevenueRetention: 2.3, grossMarginRate: 0.8 }];
  const result = chartRows(raw);
  assert.equal(result[0]["Revenue (USD)"], 100);
  assert.equal(result[0]["Previous revenue (USD)"], null);
  approx(result[0]["Net revenue retention (%)"], 230);
  assert.equal(result[0]["Gross margin (%)"], 80);
  assert.equal(raw[0].netRevenueRetention, 2.3);
  const chart = labeledChart({ type: "line", y: "revenueUsd", fields: ["revenueUsd","previousRevenueUsd"] });
  assert.equal(chart.y, "Revenue (USD)");
  assert.deepEqual(chart.fields, ["Revenue (USD)","Previous revenue (USD)"]);
  for (const [field,label] of Object.entries(fieldLabels)) {
    const source = field === "retentionRate" ? queries[rosterQueryId].source : queries[queryId].source;
    assert.ok(scopedMetricDefinitions(source.metricDefinitions, "edited-example", { chartEdited: true, displayedFields: [label] }).length, field);
  }
});

test("metric comparison source and copy retain scoped contract-days without adding summaries or history", () => {
  const scoped = { ...filters, region: "EMEA" };
  const { range, priorRange: previous, current, prior } = buildPerformance(queries, scoped);
  const evidence = metricEvidence(queries, scoped, range, previous);
  const actualRows = evidence.filter(row => row.date >= range.start);
  const priorRows = evidence.filter(row => row.date < range.start);
  assert.ok(actualRows.length && priorRows.length);
  assert.deepEqual(evidence, rows.filter(row => row.region === "EMEA" && row.date >= previous.start && row.date <= range.end));
  assert.equal(new Set(evidence.map(row => `${row.contractId}|${row.date}`)).size, evidence.length);
  assert.equal(actualRows.reduce((sum, row) => sum + row.revenueUsd, 0), current.revenueUsd);
  assert.equal(priorRows.reduce((sum, row) => sum + row.revenueUsd, 0), prior.revenueUsd);
  assert.deepEqual(metricEvidence(queries, scoped, range, null), actualRows);
  const copied = reviewedComponentClipboard({ queryId }, queries, () => evidence);
  assert.equal(copied.split("\n").length, evidence.length + 1);
  assert.ok(!copied.includes("Americas"));
});

test("rolling retention evidence preserves all plotted comparison windows without duplicate or out-of-scope facts", () => {
  const scoped = { ...filters, region: "EMEA", date: "2026-07-20..2026-08-16" };
  const model = buildPerformance(queries, scoped, { grain: "day" });
  const evidence = retentionEvidence(queries, scoped, model.retentionTrend);
  // Jul 20's prior endpoint is Jun 22; its two windows start Apr 28.
  assert.deepEqual(evidence, rows.filter(row => row.region === "EMEA" && row.date >= "2026-04-28" && row.date <= "2026-08-16"));
  for (const point of model.retentionTrend) for (const [start, end, baselineStart, baselineEnd, value] of [
    [point.periodStart, point.periodEnd, point.comparisonStart, point.comparisonEnd, point.netRevenueRetention],
    [point.previousPeriodStart, point.previousPeriodEnd, point.previousComparisonStart, point.previousComparisonEnd, point.previousNetRevenueRetention],
  ]) {
    const totals = (from, through) => evidence.filter(row => row.date >= from && row.date <= through)
      .reduce((map, row) => map.set(row.accountId, (map.get(row.accountId) ?? 0) + row.revenueUsd), new Map());
    const current = totals(start, end), prior = totals(baselineStart, baselineEnd);
    const baseline = [...prior].filter(([,amount]) => amount > 0);
    approx(value, baseline.reduce((sum,[id]) => sum + (current.get(id) ?? 0), 0) / baseline.reduce((sum,[,amount]) => sum + amount, 0));
  }
  assert.equal(new Set(evidence.map(row => `${row.contractId}|${row.date}`)).size, evidence.length);
  // Disjoint windows must not include the unrequested gap.
  const disjoint = retentionEvidence(queries, scoped, [{ comparisonStart: "2026-05-01", periodEnd: "2026-05-02",
    previousComparisonStart: "2026-03-01", previousPeriodEnd: "2026-03-02" }]);
  assert.deepEqual(disjoint, rows.filter(row => row.region === "EMEA" && ["2026-03-01","2026-03-02","2026-05-01","2026-05-02"].includes(row.date)));
  assert.deepEqual(retentionEvidence(queries, scoped, []), []);
});

test("cohort evidence uses original contracts and first account payment, not later product starts", () => {
  const contracts = [{ contractId: "a-first", accountId: "a", startDate: "2026-01-03" },
    { contractId: "a-next", accountId: "a", startDate: "2026-03-08" },
    { contractId: "b-first", accountId: "b", startDate: "2026-03-12" }];
  assert.deepEqual(cohortEvidence({contracts}, ["2026-01"]), contracts.slice(0,2));
  assert.deepEqual(cohortEvidence({contracts}, ["2026-03"]), contracts.slice(2));
  assert.deepEqual(cohortEvidence({contracts}, []), []);
});

test("scope totals reconcile while multi-product account counts are deduplicated", () => {
  const model = defaultModel;
  const current = rows.filter(row => row.date >= "2026-05-18" && row.date <= "2026-08-16");
  assert.equal(model.current.revenueUsd, rows.filter(row => row.date >= "2026-05-18").reduce((sum,row)=>sum+row.revenueUsd,0));
  assert.equal(model.prior.revenueUsd, rows.filter(row=>row.date<"2026-05-18").reduce((sum,row)=>sum+row.revenueUsd,0));
  assert.equal(model.current.revenueUsd, current.reduce((sum, row) => sum + row.revenueUsd, 0));
  assert.equal(model.current.activeAccounts, new Set(current.filter(row => row.completedRuns > 0).map(row => row.accountId)).size);
  assert.equal(model.current.payingAccounts, new Set(roster.filter(row=>row.startDate<="2026-08-16" && !row.endDate).map(row=>row.accountId)).size);
  assert.equal(model.current.activeAccounts, new Set(current.filter(row=>row.completedRuns>0).map(row=>row.accountId)).size);
  assert.equal(model.segments.reduce((sum, row) => sum + row.revenueUsd, 0), model.current.revenueUsd);
  assert.ok(model.segments.reduce((sum, row) => sum + row.activeAccounts, 0) > model.current.activeAccounts);
  assert.equal(model.accounts.reduce((sum, row) => sum + row.revenueUsd, 0), model.current.revenueUsd);
  approx(model.current.grossMarginRate, (model.current.revenueUsd - model.current.costUsd) / model.current.revenueUsd);
  const userIds = new Set(current.flatMap(row => row.activeUserIds.map(id => `${row.accountId}:${id}`)));
  assert.equal(model.current.activeUsers, userIds.size);
});

test("new, existing growth, contraction and churn reconcile with cohort revenue retention", () => {
  const model = defaultModel;
  assert.equal(model.movements.reduce((sum, row) => sum + row.deltaUsd, 0), model.deltaUsd);
  const priorCohort = model.accounts.filter(row => row.previousRevenueUsd > 0);
  approx(model.current.netRevenueRetention, priorCohort.reduce((sum, row) => sum + row.revenueUsd, 0) / model.prior.revenueUsd);
  approx(model.current.grossRevenueRetention, priorCohort.reduce((sum, row) => sum + Math.min(row.revenueUsd, row.previousRevenueUsd), 0) / model.prior.revenueUsd);
  assert.ok(model.current.grossRevenueRetention <= 1);
  for (const row of model.accounts.filter(row => row.movement === "Churn")) {
    assert.equal(row.revenueUsd, 0); assert.ok(row.previousRevenueUsd > 0); assert.equal(row.payingAccounts, 0);
  }
  const recent = buildPerformance(queries, { ...filters, date: "2026-07-20..2026-08-16" });
  assert.ok(recent.accounts.some(row => row.movement === "Contraction"));
  assert.ok(recent.accounts.some(row => row.movement === "New"));
});

test("daily/weekly buckets preserve additive totals and use exact prior intervals", () => {
  const ctx = context(queries);
  const range = periodRange("2026-08-05..2026-08-14", ctx.coverage);
  const weekly = trendRows(ctx, range, "week");
  const daily = trendRows(ctx, range, "day");
  assert.equal(weekly.length, 2); assert.equal(daily.length, 10);
  assert.deepEqual(weekly.map(row => [row.periodStart, row.periodEnd, row.comparisonStart, row.comparisonEnd]), [
    ["2026-08-05", "2026-08-09", "2026-07-26", "2026-07-30"],
    ["2026-08-10", "2026-08-14", "2026-07-31", "2026-08-04"],
  ]);
  for (const buckets of [daily, weekly]) {
    assert.equal(buckets.reduce((sum, row) => sum + row.revenueUsd, 0), summarize(ctx, range).revenueUsd);
    assert.equal(buckets.reduce((sum, row) => sum + row.previousRevenueUsd, 0), summarize(ctx, priorRange(range)).revenueUsd);
  }
  assert.ok(daily.reduce((sum, row) => sum + row.activeAccounts, 0) > summarize(ctx, range).activeAccounts);
  assert.equal(periodRange("2026-02-30..2026-03-01", ctx.coverage), null);
});

test("missing an entire expected contract, one day, duplicate rows, and null measures do not become observed zero", () => {
  const firstCurrent = rows.find(row => row.date === "2026-07-20");
  const range = periodRange(filters.date, queries[queryId].source.coverage);
  for (const kept of [rows.filter(row => row !== firstCurrent), rows.filter(row => row.contractId !== firstCurrent.contractId), [...rows, firstCurrent]]) {
    const q = { ...queries, [queryId]: { ...queries[queryId], rows: kept } };
    assert.equal(summarize(context(q), range).complete, false);
    assert.equal(summarize(context(q), range).revenueUsd, null);
  }
  const nullRevenue = rows.map(row => row === firstCurrent ? { ...row, revenueUsd: null } : row);
  const nullSummary = summarize(context({ ...queries, [queryId]: { ...queries[queryId], rows: nullRevenue } }), range);
  assert.equal(nullSummary.revenueUsd, null);
  assert.equal(nullSummary.grossMarginRate, null);
  assert.equal(nullSummary.activeAccounts, defaultModel.current.activeAccounts);
  const zeros = rows.map(row => ({ ...row, revenueUsd: 0, subscriptionUsd: 0, usageUsd: 0, costUsd: 0, completedRuns: 0, activeUserIds: [] }));
  const zero = summarize(context({ ...queries, [queryId]: { ...queries[queryId], rows: zeros } }), range);
  assert.equal(zero.revenueUsd, 0); assert.equal(zero.activeAccounts, 0); assert.equal(zero.grossMarginRate, null);
  assert.equal(change(100, 0), null);
});

test("closed cohorts preserve maturity gaps and cell populations reconcile exactly", () => {
  const ctx = context(queries);
  const result = cohortRows(ctx, "2026-08-16");
  assert.equal(result.length, 9);
  assert.deepEqual(result.map(row => row.accounts), [12,15,18,20,22,18,24,16,20]);
  assert.ok(result.every(row => row.M0 === 1));
  assert.equal(result.at(-1).cohort, "2026-07");
  assert.equal(result.at(-1).M1, null);
  const cells = cohortCells(ctx, { asOf: "2026-08-16" });
  assert.ok(new Set(cells.filter(row => row.mature).map(row => row.retentionRate)).size >= 6);
  for (const cell of cells) {
    const population = cohortMembers(ctx, cell.cohort, cell.age, cell.asOf);
    if (!cell.mature) { assert.equal(cell.retentionRate, null); assert.equal(population.length, 0); continue; }
    assert.equal(population.length, cell.eligibleAccounts);
    const expected = population.filter(member => roster.some(contract => contract.accountId === member.accountId
      && contract.startDate <= cell.cutoff && (!contract.endDate || contract.endDate >= cell.cutoff))).length;
    assert.equal(cell.retainedAccounts, expected);
    approx(cell.retentionRate, expected / cell.eligibleAccounts);
  }
  assert.deepEqual(cohortCells(ctx, { entryStart: "2026-03", entryEnd: "2026-04", asOf: "2026-08-16" }).map(row => row.cohort),
    [...Array(8).fill("2026-03"), ...Array(8).fill("2026-04")]);
  assert.deepEqual(cohortCells(ctx, { entryStart: "2026-06", entryEnd: "2026-01", asOf: "2026-08-16" }), []);
});

test("seven-day activation excludes immature cohorts and preserves unknown versus known-positive evidence", () => {
  const ctx = context(queries);
  const range = periodRange(filters.date, ctx.coverage);
  const accounts = Object.values(Object.groupBy(roster, row => row.accountId)).map(contracts => ({ accountId: contracts[0].accountId,
    start: contracts.map(row => row.startDate).sort()[0] })).filter(row => row.start >= range.start
      && Date.parse(row.start) + 6 * 86400000 <= Date.parse(range.end));
  const activated = accounts.filter(account => rows.some(row => row.accountId === account.accountId && row.date >= account.start
    && Date.parse(row.date) <= Date.parse(account.start) + 6 * 86400000 && row.completedRuns > 0));
  const result = activation(ctx, range);
  assert.equal(result.eligibleAccounts, accounts.length);
  assert.equal(result.activatedAccounts, activated.length);
  approx(result.activationRate, activated.length / accounts.length);
  const target = activated[0];
  const inWindow = row => row.accountId === target.accountId && row.date >= target.start && Date.parse(row.date) <= Date.parse(target.start) + 6 * 86400000;
  const missingRuns = rows.map(row => inWindow(row) ? { ...row, completedRuns: null } : row);
  const missingContext = context({ ...queries, [queryId]: { ...queries[queryId], rows: missingRuns } });
  assert.equal(activation(missingContext, range).activationRate, null);
  assert.equal(activation(missingContext, range).unknownAccounts, 1);
  missingRuns.find(inWindow).completedRuns = 1;
  assert.equal(activation(missingContext, range).activatedAccounts, result.activatedAccounts);
});

test("overview NRR is the exact trailing-28-day endpoint independent of comparison display", () => {
  for (const compare of [true, false]) {
    const model = buildPerformance(queries, filters, { compare });
    const now = new Map(); const before = new Map();
    for (const row of rows) {
      if (row.date >= "2026-07-20" && row.date <= "2026-08-16") now.set(row.accountId, (now.get(row.accountId) ?? 0) + row.revenueUsd);
      if (row.date >= "2026-06-22" && row.date <= "2026-07-19") before.set(row.accountId, (before.get(row.accountId) ?? 0) + row.revenueUsd);
    }
    const baseline = [...before].filter(([, value]) => value > 0);
    approx(model.rollingRetention.netRevenueRetention, baseline.reduce((sum, [id]) => sum + (now.get(id) ?? 0), 0) / baseline.reduce((sum, [, value]) => sum + value, 0));
    assert.equal(model.rollingRetention.date, "2026-08-16");
    assert.deepEqual(model.rollingRetention, model.retentionTrend.at(-1));
  }
  const missing = { ...queries, [queryId]: { ...queries[queryId], rows: rows.filter(row => row !== rows.at(-1)) } };
  assert.equal(buildPerformance(missing, filters).rollingRetention.netRevenueRetention, null);
  const lost = defaultModel.accounts.find(row => row.payingAccounts === 0);
  assert.equal(buildPerformance(queries, filters, { accountId: lost.accountId }).account.accountId, lost.accountId);
});

test("unknown prior revenue cannot silently remove an account from a retention baseline", () => {
  const missing = structuredClone(queries);
  missing[queryId].rows.find(row => row.accountId === "account-02" && row.date === "2026-04-01").revenueUsd = null;
  const model = buildPerformance(missing, filters);
  assert.equal(model.prior.complete, true);
  assert.equal(model.prior.revenueUsd, null);
  assert.equal(model.current.netRevenueRetention, null);
  assert.equal(model.current.grossRevenueRetention, null);
  const rolling = buildPerformance(missing, { ...filters, date: "2026-04-20..2026-05-17" });
  assert.ok(rolling.retentionTrend.some(row => row.netRevenueRetention === null));
});

test("account defaults are meaningful, explicit valid selections persist, and scope changes choose a valid fallback", () => {
  assert.ok(defaultModel.account);
  assert.ok(defaultModel.account.payingAccounts > 0 && defaultModel.account.revenueUsd > 0);
  const accountId = defaultModel.accounts.find(row => row.region === "EMEA").accountId;
  const selected = buildPerformance(queries, filters, { accountId });
  assert.equal(selected.account.accountId, accountId);
  assert.equal(selected.accountTrend.reduce((sum, row) => sum + row.revenueUsd, 0), selected.account.revenueUsd);
  assert.equal(selected.accountProducts.reduce((sum, row) => sum + row.revenueUsd, 0), selected.account.revenueUsd);
  const regional = buildPerformance(queries, { ...filters, region: "Americas" }, { accountId });
  assert.equal(regional.account.region, "Americas");
  assert.notEqual(regional.account.accountId, accountId);
  const none = buildPerformance(queries, filters, { compare: false });
  assert.equal(none.current.netRevenueRetention, defaultModel.current.netRevenueRetention);
  const offProducts = deepDiveModel(queries, filters, none).products;
  const onProducts = deepDiveModel(queries, filters, defaultModel).products;
  assert.deepEqual(offProducts.map(row => row.netRevenueRetention), onProducts.map(row => row.netRevenueRetention));
  assert.ok(none.account.revenueUsd === Math.max(...none.accounts.map(row => row.revenueUsd)));
  const empty = buildPerformance(queries, { ...filters, region: "Unavailable" });
  assert.equal(empty.account, null); assert.equal(empty.current.revenueUsd, null);
});

test("export rows retain period context, null formatting sorts correctly, and known fixture titles migrate without touching custom titles", () => {
  for (const row of [...defaultModel.segments, ...defaultModel.accounts, ...defaultModel.accountProducts, ...defaultModel.movements]) {
    assert.equal(row.periodStart, "2026-05-18"); assert.equal(row.periodEnd, "2026-08-16");
    assert.equal(row.comparisonStart, "2026-02-16"); assert.equal(row.comparisonEnd, "2026-05-17");
  }
  const values = moneyRows([null, -100, 0, 100].map(revenueUsd => ({ revenueUsd }))).map(row => row.revenueUsd);
  assert.deepEqual(values.toSorted((a, b) => compareTableValues(a, b, false)), ["-$100", "$0", "$100", null]);
  assert.equal(migratedTitle("Weekly business review", snapshot), "Northstar business performance");
  assert.equal(migratedTitle("Business performance", snapshot), "Northstar business performance");
  assert.equal(migratedTitle("My board view", snapshot), "My board view");
  assert.equal(migratedTitle("Weekly business review", { ...snapshot, status: "reviewed" }), "Weekly business review");
});

test("metric definitions resolve on edited charts and on the roster-backed cohort table", () => {
  for (const [id, fields] of [
    ["performance-trend", ["revenueUsd", "previousRevenueUsd"]], ["performance-growth", ["deltaUsd"]],
    ["performance-adoption", ["activeAccounts"]], ["performance-usage", ["completedRuns"]],
    ["performance-retention", ["netRevenueRetention", "grossRevenueRetention"]],
  ]) assert.ok(scopedMetricDefinitions(queries[queryId].source.metricDefinitions, id, { displayedFields: fields, chartEdited: true }).length, id);
  assert.ok(scopedMetricDefinitions(queries[rosterQueryId].source.metricDefinitions, "performance-cohorts").length);
  for (const id of ["performance-activation", "performance-utilization", "performance-intensity"]) {
    assert.ok(scopedMetricDefinitions(queries[queryId].source.metricDefinitions, id).some(row => row.componentIds?.includes(id)), id);
  }
  const legacy = { y: "currentValue", fields: ["currentValue", "previousValue"] };
  const legacyRows = revenueRowsForChart(defaultModel.trend, legacy);
  assert.equal(legacyRows[0].currentValue, defaultModel.trend[0].revenueUsd);
  assert.equal(legacyRows[0].previousValue, defaultModel.trend[0].previousRevenueUsd);
  for (const field of legacy.fields) assert.ok(scopedMetricDefinitions(queries[queryId].source.metricDefinitions,
    "performance-trend", { displayedFields: [field], chartEdited: true }).some(row => row.field === "revenueUsd"));
  assert.strictEqual(revenueRowsForChart(defaultModel.trend), defaultModel.trend);
});


test("prior product series expose only prior measures while keeping their true source dates", () => {
  const deep = deepDiveModel(queries, filters, defaultModel);
  const compared = comparedProductRows(deep.productTrend, true);
  assert.equal(compared.length, deep.productTrend.length * 2);
  for (let i = 0; i < deep.productTrend.length; i++) {
    const raw = deep.productTrend[i], current = compared[i*2], previous = compared[i*2+1];
    assert.equal(current.revenueUsd, raw.revenueUsd);
    assert.equal(previous.product, current.product);
    assert.equal(previous.plotDate, current.plotDate);
    assert.equal(previous.date, raw.comparisonStart);
    assert.equal(previous.periodEnd, raw.comparisonEnd);
    assert.equal(previous.comparisonStart, null);
    for (const field of ["revenueUsd", "completedRuns", "grossMarginRate", "activeAccounts", "seatUtilizationRate", "grossProfitUsd", "runsPerAccount", "costPerThousandRunsUsd"]) {
      const priorField = `previous${field[0].toUpperCase()}${field.slice(1)}`;
      assert.equal(previous[field], raw[priorField]);
      assert.equal(previous[priorField], null);
    }
  }
  assert.equal(comparedProductRows(deep.productTrend, false).length, deep.productTrend.length);
  assert.equal(dateRangeLabel("2026-06-29", "2026-07-05"), "Jun 29–Jul 5, 2026");
  assert.equal(dateRangeLabel("2026-07-01", "2026-07-05"), "Jul 1–5, 2026");
});

test("NRR comparison uses its own prior endpoint and complete 28-day baseline", () => {
  const ctx = context(queries, filters);
  const priorEnd = shiftDate(defaultModel.range.end, -defaultModel.range.days);
  const previous = rollingRetentionAt(ctx, priorEnd);
  assert.equal(previous.periodStart, "2026-04-20");
  assert.equal(previous.periodEnd, "2026-05-17");
  assert.equal(previous.comparisonStart, "2026-03-23");
  approx(defaultModel.rollingRetention.previousNetRevenueRetention, previous.netRevenueRetention);
  const independentNrr = (start,end,priorStart,priorEnd) => {
    const totals=(from,through)=>rows.filter(row=>row.date>=from && row.date<=through).reduce((map,row)=>map.set(row.accountId,(map.get(row.accountId)??0)+row.revenueUsd),new Map());
    const current=totals(start,end), baseline=totals(priorStart,priorEnd);
    return [...baseline].filter(([,value])=>value>0).reduce((sum,[id])=>sum+(current.get(id)??0),0)/[...baseline.values()].reduce((sum,value)=>sum+value,0);
  };
  approx(defaultModel.rollingRetention.netRevenueRetention,independentNrr("2026-07-20","2026-08-16","2026-06-22","2026-07-19"));
  approx(previous.netRevenueRetention,independentNrr("2026-04-20","2026-05-17","2026-03-23","2026-04-19"));
  const missing = { ...ctx, rows: ctx.rows.filter(row => row.date !== "2026-03-23") };
  assert.equal(rollingRetentionAt(missing, priorEnd).netRevenueRetention, null);
  assert.ok(scopedMetricDefinitions(queries[queryId].source.metricDefinitions, "overview-nrr", {
    chartEdited: true, displayedFields: ["Previous gross revenue retention (%)"]
  }).some(metric => metric.field === "previousGrossRevenueRetention"));
});


test("calendar grains partition actual dates and preserve totals and endpoint retention", () => {
  const range = { start:"2026-05-18",end:"2026-08-16",days:91 };
  assert.deepEqual(buckets(range,"month").map(row => [row.start,row.end]), [
    ["2026-05-18","2026-05-31"],["2026-06-01","2026-06-30"],["2026-07-01","2026-07-31"],["2026-08-01","2026-08-16"]]);
  assert.deepEqual(supportedGrains(range),["day","week","month"]);
  for (const grain of ["day","week","month","quarter","year"]) {
    const model = buildPerformance(queries,filters,{grain});
    const deep = deepDiveModel(queries,filters,model);
    assert.equal(model.trend.reduce((sum,row) => sum + row.revenueUsd,0),defaultModel.current.revenueUsd);
    approx(model.rollingRetention.netRevenueRetention, defaultModel.rollingRetention.netRevenueRetention);
    assert.equal(model.accountTrend.length,model.trend.length);
    assert.equal(deep.productTrend.length,model.trend.length * 3);
    assert.equal(buckets(range,grain).reduce((sum,row) => sum + row.days,0),91);
  }
  assert.deepEqual(buckets({start:"2024-12-28",end:"2025-01-03",days:7},"year").map(row => row.end),["2024-12-31","2025-01-03"]);
});

test("the snapshot engine reuses comparison data and isolates scopes, snapshots and bounded caches", () => {
  const engine = createPerformanceEngine(queries,2);
  const initial = engine.read(filters);
  assert.equal(engine.read({...filters},{compare:false}),initial);
  const regional = engine.read({...filters,region:"EMEA"});
  assert.notEqual(regional.model.current.revenueUsd,initial.model.current.revenueUsd);
  assert.equal(engine.read(filters),initial);
  engine.read(filters,{grain:"month"});
  assert.equal(engine.read(filters),initial);
  assert.notEqual(engine.read({...filters,region:"EMEA"}),regional, "Least-recently-used scope was evicted");
  const different = structuredClone(queries);
  different[queryId].rows[0].revenueUsd += 10;
  const refreshed = createPerformanceEngine(different).read(filters);
  assert.notEqual(refreshed,initial);
  assert.equal(refreshed.model.prior.revenueUsd,initial.model.prior.revenueUsd + 10);
  assert.equal(initial.model.current.revenueUsd,rows.filter(row => row.date >= "2026-05-18").reduce((sum,row)=>sum+row.revenueUsd,0));
});

test("account and breakdown changes reuse global calculations and match independent scoped results", () => {
  const engine = createPerformanceEngine(queries);
  const base = engine.read(filters);
  for (const options of [{dimension:"region"},{accountId:"account-05"},{dimension:"segment",accountId:"account-08"}]) {
    const actual = engine.read(filters,options);
    assert.equal(actual.model.current,base.model.current);
    assert.equal(actual.model.trend,base.model.trend);
    assert.equal(actual.model.retentionTrend,base.model.retentionTrend);
    assert.equal(actual.deep.products,base.deep.products);
    assert.equal(actual.deep.activationCohorts,base.deep.activationCohorts);
    const independent = buildPerformance(queries,filters,options);
    assert.deepEqual(actual.model,independent);
    assert.deepEqual(actual.deep,deepDiveModel(queries,filters,independent,options.dimension));
  }
});


test("unknown current revenue outside the baseline cohort does not invalidate NRR", () => {
  const missing = structuredClone(queries);
  missing[queryId].rows.find(row => row.accountId === "account-170" && row.date === "2026-08-10").revenueUsd = null;
  const actual = rollingRetentionAt(context(missing,filters),"2026-08-16");
  approx(actual.netRevenueRetention,defaultModel.rollingRetention.netRevenueRetention);
  approx(actual.grossRevenueRetention,defaultModel.rollingRetention.grossRevenueRetention);
});

test("the off-thread model protocol preserves request identity and reviewed values", { timeout:15000 }, async () => {
  const { Worker } = await import("node:worker_threads");
  const { once } = await import("node:events");
  const url = new URL("../content/dashboard/performance-worker.js",import.meta.url).href;
  const worker = new Worker(`const {parentPort} = require("node:worker_threads");
    globalThis.self = { postMessage:data => parentPort.postMessage(data) };
    import(${JSON.stringify(url)}).then(() => { parentPort.on("message",data => self.onmessage({data})); parentPort.postMessage({ready:true}); });`, {eval:true});
  try {
    await once(worker,"message");
    worker.postMessage({type:"init",queries});
    const response = once(worker,"message");
    worker.postMessage({type:"read",key:"scope-a",filters,options:{grain:"month"}});
    const [message] = await response;
    assert.equal(message.key,"scope-a");
    assert.equal(message.result.model.current.revenueUsd,rows.filter(row => row.date >= "2026-05-18").reduce((sum,row)=>sum+row.revenueUsd,0));
    assert.equal(message.result.model.trend.length,4);
    approx(message.result.model.rollingRetention.netRevenueRetention,defaultModel.rollingRetention.netRevenueRetention);
  } finally { await worker.terminate(); }
});


test("the authored default uses recent covered days and local controls keep the global request scope", () => {
  const defaults = Object.fromEntries(snapshot.filters.map(filter => [filter.id,filter.defaultValue]));
  assert.equal(defaults.date,"2026-07-20..2026-08-16");
  assert.equal(buildPerformance(queries,defaults).current.revenueUsd,rows.filter(row => row.date >= "2026-07-20").reduce((sum,row)=>sum+row.revenueUsd,0));
  const current = {grain:"day",dimension:"product",accountId:"account-01"};
  const local = {...current,dimension:"region",accountId:"account-02"};
  assert.equal(performanceGlobalKey(defaults,current),performanceGlobalKey(defaults,local));
  assert.deepEqual(localPerformanceChanges(current,local),["dimension","accountId"]);
  assert.notEqual(performanceGlobalKey(defaults,current),performanceGlobalKey({...defaults,region:"EMEA"},current));
  assert.notEqual(performanceGlobalKey(defaults,current),performanceGlobalKey(defaults,{...current,grain:"week"}));
});
