const weeks = Array.from({ length: 12 }, (_, index) => dateAfter("2026-06-01", index * 7));
const regions = ["Northeast", "Central", "West"];
const customers = [
  ["Northline Foods", "Harbor & Pine", "Meridian Works", "Cedar House", "Nova Packaging", "Sterling Industrial", "Foundry Office", "Oak & Main"],
  ["Atlas Medical", "Juniper Retail", "Summit Home", "Rivet Manufacturing", "Redwood Commerce", "Monarch Goods", "Prairie Collective", "Crestline Parts"],
  ["Copper State Labs", "Evergreen Supply", "Beacon Outfitters", "Fieldstone Market", "Lakeview Provisions", "Bluebird Kitchen", "Arcwell Systems", "Golden Hour Co."],
];
const categories = ["Driver pay", "Fuel", "Vehicle maintenance", "Warehousing", "Insurance", "Software and systems"];
const asOf = "2026-08-21";
function dateAfter(date, days) { return new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10); }
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
const round = (value, digits = 4) => Number(value.toFixed(digits));

// One canonical synthetic route-day ledger. The latest day stops at 4 PM;
// prior days have final delivery outcomes as well as their retained 4 PM snapshot.
const routeRows = weeks.flatMap((week, weekIndex) => Array.from({ length: 5 }, (_, dayIndex) => {
  const date = dateAfter(week, dayIndex);
  return regions.flatMap((region, regionIndex) => Array.from({ length: 6 + regionIndex }, (_, routeIndex) => {
    const disruption = region === "West" && weekIndex === 7 && dayIndex >= 1;
    const loadingDelay = region === "Northeast" && date === asOf && routeIndex < 2;
    const scheduled = 8 + (routeIndex * 3 + dayIndex + weekIndex) % 7;
    const completed = Math.floor(scheduled * (loadingDelay ? .58 : disruption ? .69 : .83 + routeIndex % 3 * .02));
    const atRisk = loadingDelay ? 3 : disruption ? 2 : routeIndex % 4 === 0 ? 1 : 0;
    const deliveries = date === asOf ? completed : scheduled - (disruption && routeIndex % 2 === 0 ? 1 : 0);
    const onTimeDeliveries = Math.max(0, deliveries - (disruption ? 2 : loadingDelay ? 1 : routeIndex % 5 === 0 ? 1 : 0));
    const driverHours = 6 + routeIndex % 3 + (disruption || loadingDelay ? 1 : 0);
    // Latest-week fuel pressure is carried by route-day facts, so every weekly
    // cost, profit and cash view reconciles to the same synthetic scenario.
    const fuelSurcharge = weekIndex === weeks.length - 1 ? [36, 28, 52][regionIndex] : 0;
    const costs = [driverHours * 39, 88 + routeIndex * 8 + (disruption ? 92 : 0) + fuelSurcharge, 54, 95, 36, 24];
    const operatingCost = costs.reduce((total, cost) => total + cost, 0);
    return { week, date, region, routeId: `${["NE", "CE", "WE"][regionIndex]}-${String(routeIndex + 1).padStart(2, "0")}`,
      depot: ["Newark", "Columbus", "Sacramento"][regionIndex], customer: customers[regionIndex][(routeIndex + dayIndex) % 8],
      scheduled, completed, atRisk, deliveries, onTimeDeliveries, driverHours, availableHours: 10,
      revenue: deliveries * (76 + regionIndex * 3 + routeIndex % 3 * 2), operatingCost,
      ...Object.fromEntries(categories.map((name, index) => [name, costs[index]])),
      issue: loadingDelay ? "Loading delay" : disruption ? "Road closure" : atRisk ? "Narrow delivery window" : "On schedule",
      nextAction: loadingDelay ? "Dispatch backup van from Newark" : disruption ? "Use approved alternate route" : atRisk ? "Confirm receiving window" : "Continue route",
      estimatedFinish: loadingDelay ? "6:40 PM" : disruption ? "6:25 PM" : "6:00 PM" };
  }));
}).flat());

function scoped(rows, region) { return region === "all" ? rows : rows.filter(row => row.region === region); }
const dailyRows = weeks.flatMap(week => Array.from({ length: 5 }, (_, index) => dateAfter(week, index)).flatMap(date =>
  [...regions, "all"].map(region => {
    const routes = scoped(routeRows.filter(row => row.date === date), region);
    return { week, date, region, scheduled: sum(routes, "scheduled"), completed: sum(routes, "completed"),
      atRisk: sum(routes, "atRisk"), routes: routes.length, estimatedFinish: routes.some(row => row.issue === "Loading delay") ? "6:40 PM"
        : routes.some(row => row.issue === "Road closure") ? "6:25 PM" : "6:00 PM" };
  })));
const progressHours = [["8 AM", .04, .04], ["9 AM", .10, .11], ["10 AM", .18, .20], ["11 AM", .28, .31],
  ["12 PM", .39, .43], ["1 PM", .52, .57], ["2 PM", .65, .70], ["3 PM", .74, .82], ["4 PM", .85, 1], ["5 PM", .95, null], ["6 PM", 1, null]];
const dailyProgressRows = dailyRows.flatMap(row => progressHours.map(([hour, plannedShare, completedShare], hourIndex) => ({
  week: row.week, date: row.date, region: row.region, hour, hourIndex,
  planned: Math.round(row.scheduled * plannedShare), completed: completedShare == null ? null : Math.round(row.completed * completedShare),
  atRisk: [3, 6, 8].includes(hourIndex) ? row.atRisk : null,
  riskPoint: [3, 6, 8].includes(hourIndex) ? Math.round(row.completed * completedShare) : null,
})));
const financialRows = [], operationsRows = [], costRows = [];
for (const week of weeks) for (const region of [...regions, "all"]) {
  const routes = scoped(routeRows.filter(row => row.week === week), region);
  const deliveries = sum(routes, "deliveries"), revenue = sum(routes, "revenue"), operatingCost = sum(routes, "operatingCost");
  financialRows.push({ week, region, revenue, operatingCost, operatingProfit: revenue - operatingCost });
  operationsRows.push({ week, region, deliveries, fleetUtilization: round(sum(routes, "driverHours") / sum(routes, "availableHours")),
    onTimeRate: round(sum(routes, "onTimeDeliveries") / deliveries), costPerDelivery: round(operatingCost / deliveries, 2) });
  for (const category of categories) costRows.push({ week, region, category, amount: sum(routes, category) });
}
const invoiceRows = weeks.flatMap((week, weekIndex) => regions.flatMap((region, regionIndex) => customers[regionIndex].map((customer, index) => {
  const routes = routeRows.filter(row => row.week === week && row.region === region && row.customer === customer);
  const issueDate = dateAfter(week, 4), dueDate = dateAfter(issueDate, 21);
  // Stable customer payment terms/delays, not a random status disconnected from dates.
  const paymentDate = dateAfter(issueDate, index % 4 === 0 ? 10 : index % 4 === 1 ? 38 : 20);
  const paidDate = paymentDate <= asOf ? paymentDate : null;
  return { invoiceId: `HL-${weekIndex + 1}-${regionIndex + 1}-${index + 1}`, asOf, week, region, customer, issueDate, dueDate, paidDate,
    status: paidDate ? "Paid" : dueDate < asOf ? "Overdue" : dueDate <= dateAfter(asOf, 7) ? "Due soon" : "Outstanding",
    contact: `${["jordan.lee", "sam.patel", "alex.morgan", "taylor.chen", "riley.brooks", "casey.rivera", "morgan.reed", "jamie.park"][index]}@${customer.toLowerCase().replace(/[^a-z0-9]/g, "")}.example`, amount: sum(routes, "revenue") };
})));
const openingBalance = 250000;
const cashRows = weeks.map(week => {
  const through = dateAfter(week, 4);
  const receipts = sum(invoiceRows.filter(row => row.paidDate && row.paidDate <= through), "amount");
  const expenses = sum(financialRows.filter(row => row.region === "all" && row.week <= week), "operatingCost");
  return { week, openingBalance, receipts, expenses, balance: openingBalance + receipts - expenses, reserveTarget: 250000 };
});

const source = (label, table, componentIds) => ({
  label,
  caveats: ["Deterministic synthetic fixture; no external query was executed. Route-day records drive daily snapshots, weekly totals, costs and invoices. Intraday curves are modeled against each daily snapshot, not independently observed scans. The latest day ends at 4 PM; current-week revenue is partial. Cash assumes $250,000 opening funds and operating costs paid as incurred."],
  sql: `SELECT * FROM ${table} WHERE reporting_week <= :reporting_week`,
  tables: [table],
  metricDefinitions: [{
    label,
    definition: `Operational records used by ${label.toLowerCase()}.`,
    componentIds,
    sourceLineage: [{ tables: [table] }],
  }],
});

export const snapshot = {
  id: "fleet-operations-example",
  title: "Harbor Logistics operations",
  generatedAt: "2026-08-21T18:24:00Z",
  status: "fixture",
  surface: "dashboard",
  filters: [
    {
      id: "week",
      label: "Reporting period",
      field: "week",
      mode: "through",
      defaultValue: `${weeks.at(-4)}..${weeks.at(-1)}`,
      queryIds: ["operations", "route_daily", "daily_deliveries", "daily_delivery_progress", "financials", "cost_categories", "cash_balance", "invoice_ledger"],
    },
    {
      id: "region",
      label: "Region",
      field: "region",
      defaultValue: "all",
      queryIds: ["operations", "route_daily", "daily_deliveries", "daily_delivery_progress", "financials", "cost_categories", "invoice_ledger"],
    },
  ],
  queries: {
    route_daily: { rows: routeRows, source: source("Route-day delivery and cost ledger", "operations.route_daily", ["route-exceptions"]) },
    operations: {
      rows: operationsRows,
      source: source("Weekly fleet performance", "operations.fleet_weekly", [
        "fleet-utilization", "on-time-rate", "completed-deliveries",
      ]),
    },
    daily_deliveries: {
      rows: dailyRows,
      source: source("Synthetic daily delivery snapshots at 4 PM", "operations.delivery_daily", ["fleet-utilization","on-time-rate","completed-deliveries","remaining-deliveries"]),
    },
    daily_delivery_progress: {
      rows: dailyProgressRows,
      source: source("Hourly delivery progress", "operations.delivery_progress_hourly", ["delivery-progress"]),
    },
    financials: {
      rows: financialRows,
      source: source("Revenue and operating costs", "finance.operating_performance", ["financial-trend"]),
    },
    cost_categories: {
      rows: costRows,
      source: source("Operating cost ledger", "finance.cost_category_weekly", ["cost-breakdown"]),
    },
    cash_balance: {
      rows: cashRows,
      source: source("Treasury cash position", "finance.cash_position_weekly", ["cash-position"]),
    },
    invoice_ledger: {
      rows: invoiceRows,
      source: source("Customer invoice ledger", "billing.invoice_ledger", ["invoice-workspace"]),
    },
  },
};

export function fixture() { return structuredClone(snapshot); }
