import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/generate.mjs";
import { filterReviewedRows } from "../../../base/src/use-data-app.js";
import { compareOperatingCosts } from "../content/dashboard/costs.js";

test("cost comparisons normalize volume, respect region, and highlight excess rather than largest spend", () => {
  const fact = (week, scheduled, driver, fuel, extra = {}) => ({ week, region: "West", scheduled,
    "Driver pay": driver, Fuel: fuel, "Vehicle maintenance": 0, Warehousing: 0, Insurance: 0, "Software and systems": 0, ...extra });
  const rows = [fact("2026-08-03", 10, 100, 20), fact("2026-08-10", 30, 300, 60),
    fact("2026-08-17", 20, 200, 60), fact("2026-08-17", 100, 9999, 9999, { region: "East" }), fact("2026-08-24", 10, 900, 900)];
  const result = compareOperatingCosts(rows, "2026-08-17", "West");
  assert.deepEqual(result.baselineWeeks, ["2026-08-03", "2026-08-10"]);
  assert.equal(result.rows[0].category, "Driver pay");
  assert.equal(result.rows[0].variance, 0);
  assert.deepEqual(result.highlight, { week: "2026-08-17", category: "Fuel", amount: 60, expected: 40, variance: 20, rateChange: .5 });
  assert.equal(result.sourceRows.length, 3);
  const earliest = compareOperatingCosts(rows, "2026-08-03", "West");
  assert.equal(earliest.highlight, undefined);
  assert.ok(earliest.rows.every(row => row.expected === null && row.rateChange === null));
  const stable = compareOperatingCosts(rows, "2026-08-10", "West");
  assert.equal(stable.highlight, undefined);
  const savings = compareOperatingCosts([fact("2026-08-03", 10, 100, 40), fact("2026-08-10", 20, 200, 60)], "2026-08-10", "West");
  assert.equal(savings.highlight.category, "Fuel");
  assert.equal(savings.highlight.expected, 80);
  assert.equal(savings.highlight.variance, -20);
  assert.equal(savings.highlight.rateChange, -.25);
});

test("fleet-operations fixture preserves its base measurement invariants", () => {
  const data = fixture();
  for (const row of data.queries.financials.rows) assert.equal(row.revenue - row.operatingCost, row.operatingProfit);
  const routes = data.queries.route_daily.rows;
  for (const region of ["all", "Northeast", "Central", "West"]) {
    const { highlight, rows } = compareOperatingCosts(routes, "2026-08-17", region);
    assert.equal(highlight.category, "Fuel");
    assert.ok(highlight.variance > 0, "The latest-week investigation is a cost overrun, not the largest spend or a saving");
    assert.ok(highlight.rateChange > .1 && highlight.rateChange < .5);
    assert.equal(rows[0].category, "Driver pay");
  }
});

test("Fleet dates scope weekly history and explicit daily facts without inventing observations", () => {
  const data = fixture(), week = "2026-07-13";
  const scope = {week:`${week}..${week}`,region:"West"};
  const weekly = filterReviewedRows(data.queries.operations.rows,data.filters,scope,"operations",["week","region"]);
  assert.equal(weekly.length,1);
  assert.equal(weekly[0].week,week);
  assert.equal(weekly[0].region,"West");
  const daily = filterReviewedRows(data.queries.daily_deliveries.rows,data.filters,scope,"daily_deliveries",["week","date"]);
  assert.equal(daily.length,5);
  for (const row of daily) {
    const progress = data.queries.daily_delivery_progress.rows.filter(point => point.date === row.date && point.region === row.region);
    assert.equal(progress.at(-1).planned,row.scheduled);
    assert.equal(progress.find(point => point.hour === "4 PM").completed,row.completed);
    assert.ok(progress.filter(point => point.hourIndex > 8).every(point => point.completed === null));
    assert.ok(row.completed+row.atRisk <= row.scheduled);
  }
  for (const total of data.queries.daily_deliveries.rows.filter(row => row.region === "all")) {
    const regions = data.queries.daily_deliveries.rows.filter(row => row.date === total.date && row.region !== "all");
    for(const field of ["scheduled","completed","atRisk","routes"]) assert.equal(total[field],regions.reduce((sum,row) => sum+row[field],0));
  }
});

import { filterInvoices, invoiceSummary } from "../content/dashboard/invoices.js";

test("invoice status, search and totals reconcile without treating the ledger as recognized revenue", () => {
  const rows = [
    {customer:"A", status:"Paid", amount:100}, {customer:"B", status:"Due soon", amount:50},
    {customer:"C", status:"Outstanding", amount:30}, {customer:"D", status:"Overdue", amount:20},
  ];
  assert.deepEqual(invoiceSummary(rows), {paid:100,dueSoon:50,unpaid:50,billed:200});
  assert.deepEqual(filterInvoices(rows,"Unpaid").map(row=>row.customer), ["C","D"]);
  assert.deepEqual(filterInvoices(rows,"Unpaid"," c "), [rows[2]]);
  assert.deepEqual(filterInvoices(rows,"Paid","$100", amount=>`$${amount}`), [rows[0]]);
  assert.deepEqual(filterInvoices(rows,"All","no-match"), []);
  assert.equal(invoiceSummary([]).billed, 0);
  const invoices = fixture().queries.invoice_ledger.rows;
  assert.equal(new Set(invoices.map(row=>row.invoiceId)).size, invoices.length);
  for (const row of invoices) {
    assert.ok(row.issueDate <= row.asOf);
    assert.ok(row.dueDate >= row.issueDate);
    if(row.status === "Overdue") assert.ok(row.dueDate < row.asOf);
    if(row.status === "Due soon") assert.ok(row.dueDate >= row.asOf && row.dueDate <= "2026-08-28");
    if(row.status === "Outstanding") assert.ok(row.dueDate > "2026-08-28");
  }
  for(const region of ["Northeast","Central","West"]) {
    const scoped=invoices.filter(row=>row.region===region);
    assert.equal(invoiceSummary(scoped).billed,scoped.reduce((sum,row)=>sum+row.amount,0));
  }
});

test("route-day facts reconcile operations, costs, invoicing and cash without future outcomes", () => {
  const {queries,filters}=fixture(), routes=queries.route_daily.rows;
  const total=(rows,field)=>rows.reduce((sum,row)=>sum+row[field],0);
  for(const weekly of queries.operations.rows) {
    const scope=routes.filter(row=>row.week===weekly.week && (weekly.region==="all" || row.region===weekly.region));
    assert.equal(weekly.deliveries,total(scope,"deliveries"));
    assert.equal(weekly.costPerDelivery,Number((total(scope,"operatingCost")/total(scope,"deliveries")).toFixed(2)));
    assert.equal(weekly.onTimeRate,Number((total(scope,"onTimeDeliveries")/total(scope,"deliveries")).toFixed(4)));
    const financial=queries.financials.rows.find(row=>row.week===weekly.week && row.region===weekly.region);
    assert.equal(financial.revenue,total(scope,"revenue"));
    assert.equal(financial.operatingCost,total(scope,"operatingCost"));
    assert.equal(financial.operatingCost,total(queries.cost_categories.rows.filter(row=>row.week===weekly.week && row.region===weekly.region),"amount"));
  }
  for(const daily of queries.daily_deliveries.rows) {
    const scope=routes.filter(row=>row.date===daily.date && (daily.region==="all" || row.region===daily.region));
    for(const field of ["scheduled","completed","atRisk"]) assert.equal(daily[field],total(scope,field));
  }
  for(const invoice of queries.invoice_ledger.rows) {
    assert.equal(invoice.amount,total(routes.filter(row=>row.week===invoice.week && row.region===invoice.region && row.customer===invoice.customer),"revenue"));
    assert.ok(invoice.contact.endsWith(".example"));
    assert.equal(invoice.status==="Paid",Boolean(invoice.paidDate));
    if(invoice.paidDate) assert.ok(invoice.paidDate<=invoice.asOf);
  }
  for(const cash of queries.cash_balance.rows) assert.equal(cash.balance,cash.openingBalance+cash.receipts-cash.expenses);
  for(const route of routes) {
    assert.ok(route.completed+route.atRisk<=route.scheduled);
    assert.ok(route.onTimeDeliveries<=route.deliveries && route.deliveries<=route.scheduled);
    if(route.date==="2026-08-21") assert.equal(route.deliveries,route.completed);
  }
  const selected=filterReviewedRows(routes,filters,{week:"2026-07-13..2026-07-13",region:"West"},"route_daily",["week","date","routeId"]);
  assert.equal(new Set(selected.map(row=>row.date)).size,5);
  assert.ok(selected.every(row=>row.region==="West"));
});
