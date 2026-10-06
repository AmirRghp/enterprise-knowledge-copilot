import { fieldLabels } from "../content/dashboard/performance-data.js";

const DAY = 86400000;
const dateAt = day => new Date(Date.UTC(2026, 1, 16) + day * DAY).toISOString().slice(0, 10);
export const products = ["Workspace", "Automations", "API"];

export function fixture() {
  const contracts = [];
  const rows = [];
  const companyNames = ["Aster", "Birch", "Cedar", "Drift", "Elm", "Field", "Grove", "Harbor", "Iris", "Juniper", "Kite", "Linden", "Maple", "North", "Oak", "Pine", "Quartz", "Reed", "Spruce", "Tern", "Vale"];
  const cohortSizes = [12, 15, 18, 20, 22, 18, 24, 16, 20, 15];
  const cohortEnds = cohortSizes.map((_, index) => cohortSizes.slice(0, index + 1).reduce((a, b) => a + b, 0));
  for (let accountIndex = 0; accountIndex < 180; accountIndex++) {
    const accountId = `account-${String(accountIndex + 1).padStart(2, "0")}`;
    const account = `${companyNames[accountIndex % 21]} ${["Works", "Studio", "Labs", "Group", "Systems", "Cloud", "Partners", "Network", "Collective"][Math.floor(accountIndex / 21)]}`;
    const cohortIndex = cohortEnds.findIndex(end => accountIndex < end);
    const cohortOffset = accountIndex - (cohortEnds[cohortIndex - 1] ?? 0);
    const firstDay = Math.round((Date.UTC(2025, 10 + cohortIndex, 2 + cohortOffset) - Date.UTC(2026, 1, 16)) / DAY);
    // Older cohorts lose more customers, at different lifecycle stages; recent cohorts improve.
    const risk = (accountIndex * 7 + cohortIndex * 3) % 18;
    const churnAge = risk < Math.max(2, 8 - cohortIndex) ? [45, 80, 120, 170][risk % 4] : 1000;
    const lastDay = Math.min(181, firstDay + churnAge);
    const region = ["Americas", "EMEA", "APAC"][Math.floor(accountIndex / 5) % 3];
    const segment = accountIndex % 5 === 0 ? "Enterprise" : "Mid-market";
    const baseSeats = segment === "Enterprise" ? 45 + accountIndex % 12 * 4 : 12 + accountIndex % 8 * 2;
    const subscribed = [accountIndex % 3, ...(accountIndex % 2 === 0 ? [(accountIndex + 1) % 3] : []), ...(accountIndex % 4 === 0 ? [(accountIndex + 2) % 3] : [])];
    for (const [position, productIndex] of subscribed.entries()) {
      const startDay = firstDay + position * 21;
      if (startDay > lastDay || startDay > 181) continue;
      const product = products[productIndex];
      const contractId = `${accountId}:${product}`;
      contracts.push({ contractId, accountId, account, product, region, segment,
        startDate: dateAt(startDay), endDate: lastDay < 181 ? dateAt(lastDay) : null });
      const activationDay = startDay + (accountIndex % 7 === 0 ? 10 : 1 + accountIndex % 5);
      for (let day = Math.max(0, startDay); day <= lastDay; day++) {
        const expanding = day >= firstDay + 56 && accountIndex % 3 === 0;
        const contracting = day >= 154 && accountIndex % 7 === 0;
        const seats = Math.max(1, Math.round(baseSeats * (expanding ? 1.4 : 1) * (contracting ? 0.65 : 1)));
        const weekend = new Date(dateAt(day)).getUTCDay() % 6 === 0;
        const engagement = (0.26 + (accountIndex % 5) * 0.08) * (weekend ? 0.45 : 1) * (contracting ? 0.7 : 1);
        const activeCount = day < activationDay ? 0 : Math.min(seats, Math.round(seats * engagement));
        const activeUserIds = Array.from({ length: activeCount }, (_, n) => (n + day * 3) % seats);
        const completedRuns = Math.round(activeCount * [9, 34, 72][productIndex] * (1 + Math.floor((day - startDay) / 28) * 0.06));
        const subscriptionUsd = Math.round(seats * [1.6, 0.8, 0.4][productIndex]);
        const usageUsd = Math.round(completedRuns * [0.035, 0.022, 0.012][productIndex]);
        const revenueUsd = subscriptionUsd + usageUsd;
        // API serving costs rise independently of customer growth late in the panel.
        const costUsd = Math.round(subscriptionUsd * 0.15 + completedRuns * [0.008, 0.007, 0.004][productIndex] * (product === "API" && day >= 154 ? 1.9 : 1));
        rows.push({ date: dateAt(day), contractId, accountId, account, product, region, segment,
          seats, activeUserIds, completedRuns, subscriptionUsd, usageUsd, revenueUsd, costUsd });
      }
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.contractId.localeCompare(b.contractId));
  const metrics = [
    ["revenueUsd", "Revenue", "previousRevenueUsd", "SUM(subscriptionUsd + usageUsd) in recognized USD across inclusive selected UTC dates. Product contributions are additive. Previous means the immediately preceding equal-length period.", ["performance-revenueUsd", "performance-trend", "performance-growth", "performance-segment-table", "performance-accounts", "performance-account-history", "performance-account-products"]],
    ["payingAccounts", "Paying accounts", "previousPayingAccounts", "Distinct account IDs with at least one paid contract active at the period endpoint. Not the sum of product account counts.", ["performance-payingAccounts", "performance-adoption", "performance-segment-table", "performance-accounts"]],
    ["activeAccounts", "Active accounts", "previousActiveAccounts", "Distinct account IDs with a completed run anywhere in the selected period or individual trend bucket. Multi-product accounts count once. Never sum daily active-account counts.", ["performance-activeAccounts", "performance-adoption", "performance-segment-table", "performance-accounts"]],
    ["completedRuns", "Completed runs", "previousCompletedRuns", "Successful workflow executions across Workspace, Automations and API. Every run belongs to exactly one product. Sum across dates and products.", ["performance-completedRuns", "performance-usage", "performance-segment-table", "performance-accounts", "performance-account-products"]],
    ["grossMarginRate", "Gross margin", null, "(SUM(revenueUsd) - SUM(costUsd)) / positive SUM(revenueUsd). Costs represent modeled cost of revenue including infrastructure and delivery support, not total company expenses; this is not operating profit. Never average account margins.", ["performance-grossMarginRate", "performance-segment-table", "performance-accounts", "performance-account-products"]],
    ["netRevenueRetention", "Net revenue retention", "grossRevenueRetention", "Current revenue from accounts with positive prior-period revenue divided by their prior revenue. Excludes new-to-scope accounts; includes expansion and contraction. Gross revenue retention caps each account's current revenue at its prior value. Undefined when the prior denominator is zero or coverage is incomplete.", ["performance-retention"]],
    ["deltaUsd", "Revenue movement", null, "Account current revenue minus prior revenue. New, Reactivated, Expansion, Contraction, Churn and Unchanged contributions sum to the total change. These are period-revenue movements, not MRR changes or causal explanations. Churn is lost revenue for prior-revenue accounts with no current revenue and no remaining selected-scope contract; partial-period losses are Contraction.", ["performance-growth", "performance-segment-table", "performance-accounts"]],
    ["changeRate", "Revenue growth rate", null, "Revenue movement divided by positive prior revenue. Missing, zero or negative prior revenue makes percentage growth unavailable.", ["performance-segment-table", "performance-accounts"]],
    ["seatUtilizationRate", "Seat utilization", null, "Sum of distinct active users per account-day divided by sum of licensed seats per account-day. User IDs are namespaced by account and deduplicated across products. The same entitlement is not counted again for each product.", ["performance-utilization", "performance-segment-table", "performance-accounts"]],
    ["activationRate", "Seven-day activation", null, "Share of new-to-scope paying accounts whose first completed run occurred within seven inclusive days of first paid service. Excludes cohorts without seven complete observed days as of the selected endpoint.", ["performance-activation"]],
    ["M0", "Customer cohort retention", "M1", "Cohorts are first paid calendar month in the selected product/region/segment scope. M0 is the initial cohort. M1-M8 measure the fraction still paying at each subsequent calendar month-end. Only closed cohort months are included; not-yet-mature follow-up cells are null, not zero. Cohort-entry range and observation cutoff are section-local, independent of activity dates.", ["performance-cohorts"]],
  ].map(([field, label, chartLabel, definition, componentIds]) => ({ field, label, ...(chartLabel ? { chartLabel } : {}), definition, componentIds,
    sourceLineage: [{ files: ["generate.mjs"] }] }));
  Object.assign(metrics.find(metric => metric.field === "revenueUsd"), { variable: "currentValue", identifier: "previousValue" });
  metrics.push({ field: "runsPerAccount", label: "Runs per active account", componentIds: ["performance-intensity"],
    definition: "Completed runs divided by distinct active accounts over the full selected period. Unavailable when active accounts are zero or either input is missing.",
    sourceLineage: [{ files: ["generate.mjs"] }] });
  for (const [field, definition] of [
    ["subscriptionUsd", "Recognized seat-subscription revenue in USD; additive across contract-days."],
    ["usageUsd", "Recognized completed-run usage revenue in USD; additive across contract-days."],
    ["costUsd", "Modeled cost of revenue in USD, including infrastructure and delivery support. Excludes sales, research and administrative expenses. The synthetic API unit serving cost increases 90% on July 20, 2026; other product unit costs are unchanged."],
    ["activeUsers", "Distinct user IDs with activity within the selected interval, namespaced by account and deduplicated across products and dates."],
  ]) metrics.push({ field, label: field, definition, sourceLineage: [{ files: ["generate.mjs"] }] });
  for (const [field, label, definition, componentIds] of [
    ["grossProfitUsd", "Gross profit", "Recognized revenue minus modeled cost of revenue, in USD. Not operating profit.", ["revenue-grossProfitUsd", "revenue-weekly"]],
    ["bridgeUsd", "Revenue bridge", "Previous and current rows are absolute period revenue. Intermediate rows are signed account revenue movements. Only observed nonzero movements are plotted; the adjacent movement table retains observed zeros. All values are USD.", ["revenue-bridge"]],
    ["paidAccountRetention", "Paid-account retention", "Accounts paying at both current and previous endpoints divided by accounts paying at the previous endpoint. Roster-backed, not usage retention. New accounts are excluded; a zero baseline is unavailable.", ["retention-paidAccountRetention", "retention-products"]],
    ["churnedAccounts", "Churned accounts", "Accounts paying at the previous endpoint but not the current endpoint, from the independent contract roster. This endpoint count differs from period revenue classified as Churn.", ["retention-churnedAccounts", "retention-products"]],
    ["topFiveShare", "Top five revenue share", "Sum of the five largest account period revenues divided by total positive selected-scope period revenue. Unknown revenue leaves the share unavailable.", ["customers-topFiveShare"]],
    ["multiProductShare", "Multi-product account share", "Accounts paying for more than one distinct selected-scope product at the endpoint divided by all paying accounts in that scope. A single-product scope necessarily has zero multi-product share.", ["customers-multiProductShare"]],
    ["revenueShare", "Account revenue share", "Account period revenue divided by positive total selected-scope period revenue. The top-ten concentration view does not renormalize shares to the top ten.", ["customers-concentration", "performance-accounts"]],
    ["retentionRate", "Paid cohort retention curve", "Retained accounts divided by eligible first-paid-month members at the given month-end age. The observation cutoff determines maturity; unobserved cells are null. Entry range limits cohort membership, not the activity period.", ["performance-cohorts", "cohort-members"]],
  ]) metrics.push({ field, label, definition, componentIds, sourceLineage: [{ files: ["generate.mjs"] }] });
  metrics.push({ field: "netRevenueRetention", label: "Trailing 28-day net revenue retention", componentIds: ["performance-netRevenueRetention", "overview-nrr"],
    definition: "Revenue from positive-baseline accounts in the trailing 28 days divided by their revenue in the preceding 28 days at the selected endpoint. Headline and trend endpoint use the same window, independent of the comparison display toggle. Missing endpoint coverage is unavailable.",
    sourceLineage: [{ files: ["generate.mjs"] }] });
  const extraOwners = {
    revenueUsd: ["revenue-revenueUsd", "account-revenueUsd", "overview-products", "overview-movers", "revenue-weekly", "customers-segments", "retention-losses"],
    subscriptionUsd: ["revenue-subscriptionUsd", "revenue-mix", "revenue-weekly", "performance-account-products"],
    usageUsd: ["revenue-usageUsd", "revenue-mix", "revenue-weekly", "performance-account-products"],
    costUsd: ["revenue-weekly"],
    payingAccounts: ["customers-payingAccounts", "customers-segments"],
    activeAccounts: ["adoption-activeAccounts", "customers-activeAccounts", "adoption-active", "adoption-products", "customers-segments"],
    activeUsers: ["adoption-products"],
    completedRuns: ["adoption-completedRuns", "account-completedRuns", "account-usage", "adoption-products"],
    grossMarginRate: ["account-grossMarginRate", "revenue-margin", "overview-margin", "segment-margin", "overview-products", "revenue-weekly"],
    netRevenueRetention: ["retention-netRevenueRetention", "retention-grossRevenueRetention", "retention-products"],
    deltaUsd: ["overview-products", "overview-movers", "revenue-movements", "retention-losses"],
    changeRate: ["overview-products", "retention-losses"],
    seatUtilizationRate: ["adoption-seatUtilizationRate", "adoption-utilization", "overview-products"],
    runsPerAccount: ["adoption-intensity", "adoption-products"],
    activationRate: ["adoption-cohorts"],
  };
  for (const metric of metrics) {
    if (extraOwners[metric.field] && !metric.componentIds?.includes("overview-nrr")) metric.componentIds = [...new Set([...(metric.componentIds ?? []), ...extraOwners[metric.field]])];
    if (fieldLabels[metric.field]) metric.result = { field: fieldLabels[metric.field], label: fieldLabels[metric.field],
      definition: fieldLabels[metric.field].endsWith("(%)") ? "Chart display is the raw ratio multiplied by 100, in percent units. Raw ratios remain in copied source rows." : metric.definition };
  }
  const retentionMetric = metrics.find(metric => metric.field === "netRevenueRetention" && metric.componentIds?.includes("overview-nrr"));
  metrics.push({ ...retentionMetric, field: "grossRevenueRetention", label: "Gross revenue retention",
    definition: "Trailing 28-day revenue from baseline accounts, capped per account at its preceding 28-day revenue, divided by that baseline revenue. Unavailable if baseline revenue is zero or either window is incomplete.",
    result: { field: fieldLabels.grossRevenueRetention, label: fieldLabels.grossRevenueRetention, definition: "Display percentage points equal the raw ratio times 100." } });
  for (const metric of [...metrics]) {
    if (!metric.field || metric.field.startsWith("previous")) continue;
    const field = `previous${metric.field[0].toUpperCase()}${metric.field.slice(1)}`;
    if (!fieldLabels[field]) continue;
    metrics.push({ field, label: fieldLabels[field], componentIds: metric.componentIds,
      definition: `Comparison value: ${metric.definition} For trends, evaluate at the aligned prior interval.${/RevenueRetention$/.test(metric.field) ? " Fixed-window retention is evaluated at the prior period endpoint using its own preceding 28-day baseline." : ""} Missing coverage stays unavailable.`,
      result: { field: fieldLabels[field], label: fieldLabels[field], definition: fieldLabels[field].endsWith("(%)") ? "Display percentage points equal the raw ratio times 100." : "Same units as the current metric." },
      sourceLineage: metric.sourceLineage });
  }
  return { id: "example:business-performance:r15", surface: "dashboard", title: "Northstar business performance",
    generatedAt: "2026-08-17T09:00:00Z", status: "fixture",
    filters: [
      { id: "date", label: "Date range", field: "date", mode: "through", defaultValue: "2026-07-20..2026-08-16", queryIds: ["account_daily_performance"] },
      ...["product", "region", "segment"].map(field => ({ id: field, field, label: field[0].toUpperCase() + field.slice(1), defaultValue: "all" })),
    ],
    queries: {
      account_daily_performance: { rows, source: { label: "Northstar fictional contract-day performance", files: ["generate.mjs"],
        coverage: { startDate: "2026-02-16", endDate: "2026-08-16" }, metricDefinitions: metrics.filter(metric => !["M0", "retentionRate"].includes(metric.field)),
        caveats: ["Entirely synthetic. Northstar is a fictional B2B workflow platform charging subscription seats plus completed-run usage; not OpenAI or customer data.",
          "An independent contract roster defines expected daily coverage, including zero-use days. No records are required outside a contract's paid-service dates. Missing expected rows remain unknown.",
          "Accounts may use several products. Revenue and runs are additive across products; active accounts, paying accounts and user identities are not."] } },
      account_contracts: { rows: contracts, source: { label: "Northstar fictional paid-service roster", files: ["generate.mjs"],
        metricDefinitions: metrics.filter(metric => ["M0", "retentionRate"].includes(metric.field)),
        caveats: ["Synthetic independent roster. Start/end dates define paid service. A null end date means service continues through the observed coverage endpoint."] } },
    } };
}
