export const queryId = "account_daily_performance";
export const rosterQueryId = "account_contracts";
export const dimensions = { product: "Product", region: "Region", segment: "Customer segment" };
const DAY = 86400000;
const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const countFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const numericFields = ["revenueUsd", "subscriptionUsd", "usageUsd", "costUsd", "completedRuns"];
const unknown = Object.fromEntries([...numericFields, "payingAccounts", "activeAccounts", "activeUsers", "grossMarginRate", "seatUtilizationRate"].map(field => [field, null]));
export const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const shiftDate = (value, days) => validDate(value) ? new Date(Date.parse(value) + days * DAY).toISOString().slice(0, 10) : null;
export const dayCount = (start, end) => Math.max(0, (Date.parse(end) - Date.parse(start)) / DAY + 1);
export const inRange = (row, range) => Boolean(range && row.date >= range.start && row.date <= range.end);
export const change = (value, previous) => Number.isFinite(value) && Number.isFinite(previous) && previous > 0 ? (value - previous) / previous : null;
export const dollars = value => Number.isFinite(value) ? moneyFormat.format(value) : "—";
export const number = value => Number.isFinite(value) ? countFormat.format(value) : "—";
export const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
export const signedPercent = value => Number.isFinite(value) ? `${value > 0 ? "+" : ""}${percent(value)}` : "—";
export const humanDate = value => validDate(value) ? dateFormat.format(new Date(value)) : "—";
export const humanMonth = value => /^\d{4}-\d{2}$/.test(value ?? "") ? monthFormat.format(new Date(`${value}-01T00:00:00Z`)) : "—";
export const fieldLabels = { revenueUsd: "Revenue (USD)", previousRevenueUsd: "Previous revenue (USD)",
  subscriptionUsd: "Subscriptions (USD)", usageUsd: "Usage revenue (USD)", costUsd: "Cost of revenue (USD)",
  grossProfitUsd: "Gross profit (USD)", deltaUsd: "Revenue change (USD)", bridgeUsd: "Revenue bridge (USD)",
  activeAccounts: "Active accounts", previousActiveAccounts: "Previous active accounts", payingAccounts: "Paying accounts",
  completedRuns: "Completed runs", previousCompletedRuns: "Previous completed runs", activeUsers: "Active users",
  grossMarginRate: "Gross margin (%)", seatUtilizationRate: "Seat utilization (%)", netRevenueRetention: "Net revenue retention (%)",
  grossRevenueRetention: "Gross revenue retention (%)", runsPerAccount: "Runs per active account",
  activationRate: "Activation (%)", paidAccountRetention: "Paid-account retention (%)", retentionRate: "Retention (%)", revenueShare: "Revenue share (%)" };
for (const field of ["grossMarginRate", "seatUtilizationRate", "runsPerAccount", "subscriptionUsd", "usageUsd", "costUsd", "grossProfitUsd", "netRevenueRetention", "grossRevenueRetention", "activeUsers"]) {
  fieldLabels[`previous${field[0].toUpperCase()}${field.slice(1)}`] = `Previous ${fieldLabels[field][0].toLowerCase()}${fieldLabels[field].slice(1)}`;
}
export function dateRangeLabel(start, end) {
  if (!validDate(start) || !validDate(end)) return "Unavailable dates";
  const short = date => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(date));
  if (start === end) return humanDate(start);
  if (start.slice(0,4) !== end.slice(0,4)) return `${humanDate(start)}–${humanDate(end)}`;
  return start.slice(0,7) === end.slice(0,7) ? `${short(start)}–${Number(end.slice(-2))}, ${end.slice(0,4)}`
    : `${short(start)}–${short(end)}, ${end.slice(0,4)}`;
}
export function comparedProductRows(rows, compare) {
  return rows.flatMap(row => {
    const current = { ...row, plotDate: row.date, seriesLabel: row.product, comparison: "Current" };
    if (!compare) return [current];
    const prior = Object.fromEntries(Object.entries(row).map(([key, value]) => [key,
      key.startsWith("previous") ? null : typeof value === "number" || Object.hasOwn(row, `previous${key[0].toUpperCase()}${key.slice(1)}`)
        ? row[`previous${key[0].toUpperCase()}${key.slice(1)}`] ?? null : value]));
    return [current, { ...prior, product: row.product, seriesLabel: `${row.product} · previous`, comparison: "Previous",
      plotDate: row.date, date: row.comparisonStart, throughDate: row.comparisonEnd,
      periodStart: row.comparisonStart, periodEnd: row.comparisonEnd, comparisonStart: null, comparisonEnd: null,
      complete: row.previousComplete ?? false }];
  });
}
export function chartRows(rows) {
  return rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(fieldLabels)
    .filter(([key]) => Object.hasOwn(row, key)).map(([key, label]) => [label,
      row[key] != null && label.endsWith("(%)") ? row[key] * 100 : row[key]])) }));
}
export function labeledChart(spec) {
  const field = value => fieldLabels[value] ?? value;
  return { ...spec, y: field(spec.y), fields: spec.fields?.map(field),
    colors: spec.colors ? Object.fromEntries(Object.entries(spec.colors).map(([key, value]) => [field(key), value])) : undefined };
}
export function metricEvidence(queries, filters, range, previous) {
  // Preserve one reviewed contract-day grain; summaries and trends belong in displayRows.
  return context(queries, filters).rows.filter(row => inRange(row, range) || inRange(row, previous));
}
export function retentionEvidence(queries, filters, trend) {
  // Each plotted NRR (including its comparison) needs its own two 28-day windows.
  // Merge overlapping windows so a long daily trend still scans the facts only once.
  const windows = trend.flatMap(row => [[row.comparisonStart, row.periodEnd],
    [row.previousComparisonStart, row.previousPeriodEnd]])
    .filter(([start, end]) => validDate(start) && validDate(end) && start <= end)
    .sort(([a], [b]) => a.localeCompare(b));
  const merged = [];
  for (const [start, end] of windows) {
    const last = merged.at(-1);
    if (last && start <= shiftDate(last.end, 1)) last.end = last.end > end ? last.end : end;
    else merged.push({ start, end });
  }
  return context(queries, filters).rows.filter(row => merged.some(range => inRange(row, range)));
}
export function cohortEvidence(ctx, cohorts) {
  const firstPaid = new Map();
  for (const row of ctx.contracts) {
    const previous = firstPaid.get(row.accountId);
    if (!previous || row.startDate < previous) firstPaid.set(row.accountId, row.startDate);
  }
  const selected = new Set(cohorts);
  return ctx.contracts.filter(row => selected.has(firstPaid.get(row.accountId).slice(0, 7)));
}
export function moneyRows(rows) {
  return rows.map(row => ({ ...row, ...Object.fromEntries(Object.entries(row).flatMap(([key, value]) =>
    key.endsWith("Usd") ? [[key, value == null ? null : dollars(value)]] : key === "changeRate" ? [[key, value == null ? null : signedPercent(value)]] : [])) }));
}
export function migratedTitle(title, snapshot) {
  return snapshot.status === "fixture" && ["Weekly business review", "Business performance"].includes(title) ? snapshot.title : title;
}
export function revenueRowsForChart(rows, override) {
  const legacy = [override?.y, ...(override?.fields ?? [])].some(field => ["currentValue", "previousValue"].includes(field));
  return legacy ? rows.map(row => ({ ...row, currentValue: row.revenueUsd, previousValue: row.previousRevenueUsd })) : rows;
}
export function periodRange(value, coverage) {
  const parts = String(value ?? "all").split("..");
  const [start, end] = value === "all" ? [coverage.startDate, coverage.endDate]
    : parts.length === 2 ? parts : [coverage.startDate, value];
  return validDate(start) && validDate(end) && start <= end && parts.length <= 2 ? { start, end, days: dayCount(start, end) } : null;
}
export const priorRange = range => range ? { start: shiftDate(range.start, -range.days), end: shiftDate(range.start, -1), days: range.days } : null;
const activeAt = (contract, date) => contract.startDate <= date && (!contract.endDate || contract.endDate >= date);
const periodFields = (range, previous) => ({ periodStart: range?.start ?? null, periodEnd: range?.end ?? null,
  comparisonStart: previous?.start ?? null, comparisonEnd: previous?.end ?? null });

export function context(queries, filters = {}) {
  const coverage = queries[queryId]?.source.coverage ?? {};
  const contracts = (queries[rosterQueryId]?.rows ?? []).filter(row => Object.keys(dimensions)
    .every(field => !filters[field] || filters[field] === "all" || row[field] === filters[field]));
  const contractIds = new Set(contracts.map(row => row.contractId));
  const rows = (queries[queryId]?.rows ?? []).filter(row => contractIds.has(row.contractId));
  return { contracts, rows, coverage };
}
// Caches belong to immutable reviewed contexts, not global filter strings or mutable snapshots.
const contextIndexes = new WeakMap();
const modelContexts = new WeakMap();
function indexContext(ctx) {
  if (contextIndexes.has(ctx)) return contextIndexes.get(ctx);
  const index = { byContract: new Map(), byAccount: new Map(), contractsByAccount: new Map(), scopes: new Map(), summaries: new Map(), revenues: new Map() };
  for (const row of ctx.rows) for (const [map, key] of [[index.byContract,row.contractId],[index.byAccount,row.accountId]]) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  for (const contract of ctx.contracts) {
    if (!index.contractsByAccount.has(contract.accountId)) index.contractsByAccount.set(contract.accountId, []);
    index.contractsByAccount.get(contract.accountId).push(contract);
  }
  contextIndexes.set(ctx, index);
  return index;
}
function subset(ctx, contracts) {
  const index = indexContext(ctx);
  const key = contracts.map(row => row.contractId).join("|");
  if (!index.scopes.has(key)) index.scopes.set(key, { ...ctx, contracts,
    rows: contracts.flatMap(row => index.byContract.get(row.contractId) ?? []) });
  return index.scopes.get(key);
}
export function summarize(ctx, range) {
  const cache = indexContext(ctx).summaries;
  const key = `${range?.start}|${range?.end}`;
  if (!cache.has(key)) cache.set(key, summarizePeriod(ctx, range));
  return cache.get(key);
}
function summarizePeriod(ctx, range) {
  if (!range || !ctx.contracts.length || range.start < ctx.coverage.startDate || range.end > ctx.coverage.endDate) return { ...unknown, complete: false };
  const selected = ctx.rows.filter(row => inRange(row, range));
  const roster = new Map(ctx.contracts.map(contract => [contract.contractId, contract]));
  const expected = ctx.contracts.reduce((n, contract) => n + dayCount(
    [range.start, contract.startDate].sort().at(-1), [range.end, contract.endDate ?? range.end].sort()[0]), 0);
  const keys = new Set(selected.map(row => `${row.contractId}|${row.date}`));
  const complete = selected.length === expected && keys.size === expected && selected.every(row => {
    const contract = roster.get(row.contractId);
    return contract && activeAt(contract, row.date) && row.accountId === contract.accountId
      && Object.keys(dimensions).every(field => row[field] === contract[field]);
  });
  if (!complete) return { ...unknown, complete: false };
  const sums = Object.fromEntries(numericFields.map(field => [field, selected.every(row => Number.isFinite(row[field]))
    ? selected.reduce((n, row) => n + row[field], 0) : null]));
  const users = new Set();
  const days = new Map();
  let userDataComplete = true;
  for (const row of selected) {
    const key = `${row.accountId}|${row.date}`;
    if (!days.has(key)) days.set(key, { seats: row.seats, users: new Set() });
    const accountDay = days.get(key);
    if (!Array.isArray(row.activeUserIds) || !Number.isFinite(row.seats) || row.seats < 0 || row.seats !== accountDay.seats) userDataComplete = false;
    for (const userId of row.activeUserIds ?? []) { users.add(`${row.accountId}:${userId}`); accountDay.users.add(userId); }
  }
  const licensedSeatDays = [...days.values()].reduce((sum, day) => sum + day.seats, 0);
  const activeSeatDays = [...days.values()].reduce((sum, day) => sum + day.users.size, 0);
  return { ...sums, complete: true,
    payingAccounts: new Set(ctx.contracts.filter(contract => activeAt(contract, range.end)).map(contract => contract.accountId)).size,
    activeAccounts: sums.completedRuns == null ? null : new Set(selected.filter(row => row.completedRuns > 0).map(row => row.accountId)).size,
    activeUsers: userDataComplete ? users.size : null,
    grossMarginRate: sums.revenueUsd > 0 && sums.costUsd != null ? (sums.revenueUsd - sums.costUsd) / sums.revenueUsd : null,
    seatUtilizationRate: userDataComplete && licensedSeatDays > 0 ? activeSeatDays / licensedSeatDays : null };
}
export function accountRows(ctx, range, compare = true) {
  const previous = compare ? priorRange(range) : null;
  const { byAccount: rowsByAccount, contractsByAccount } = indexContext(ctx);
  return [...new Set(ctx.contracts.map(row => row.accountId))].flatMap(accountId => {
    const contracts = contractsByAccount.get(accountId);
    const firstPaid = contracts.map(row => row.startDate).sort()[0];
    if (!range || firstPaid > range.end) return [];
    const accountCtx = { ...ctx, contracts, rows: rowsByAccount.get(accountId) ?? [] };
    const current = summarize(accountCtx, range);
    const prior = compare ? summarize(accountCtx, previous) : { ...unknown, complete: false };
    const deltaUsd = current.revenueUsd == null || prior.revenueUsd == null ? null : current.revenueUsd - prior.revenueUsd;
    let movement = "Unavailable";
    if (deltaUsd != null) {
      movement = prior.revenueUsd === 0 && current.revenueUsd > 0 ? (firstPaid >= range.start ? "New" : "Reactivated")
        : prior.revenueUsd > 0 && current.revenueUsd === 0 && current.payingAccounts === 0 ? "Churn"
          : deltaUsd > 0 ? "Expansion" : deltaUsd < 0 ? "Contraction" : "Unchanged";
    }
    const { account, region, segment } = contracts[0];
    const products = contracts.filter(contract => activeAt(contract, range.end)).map(row => row.product).join(", ");
    return [{ ...periodFields(range, previous), accountId, account, region, segment, products, firstPaid,
      context: `${segment} · ${region}`, ...current, previousRevenueUsd: prior.revenueUsd,
      previousPayingAccounts: prior.payingAccounts, previousCompletedRuns: prior.completedRuns, previousGrossMarginRate: prior.grossMarginRate, deltaUsd, changeRate: change(current.revenueUsd, prior.revenueUsd), movement }];
  }).sort((a, b) => (a.deltaUsd ?? 0) - (b.deltaUsd ?? 0) || (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0));
}
export function retention(accounts, available) {
  if (!available || accounts.some(row => !Number.isFinite(row.previousRevenueUsd))) {
    return { netRevenueRetention: null, grossRevenueRetention: null };
  }
  const baseline = accounts.filter(row => row.previousRevenueUsd > 0);
  const previous = baseline.reduce((sum, row) => sum + row.previousRevenueUsd, 0);
  return available && previous > 0 && baseline.every(row => row.revenueUsd != null)
    ? { netRevenueRetention: baseline.reduce((sum, row) => sum + row.revenueUsd, 0) / previous,
      grossRevenueRetention: baseline.reduce((sum, row) => sum + Math.min(row.revenueUsd, row.previousRevenueUsd), 0) / previous }
    : { netRevenueRetention: null, grossRevenueRetention: null };
}
export function buckets(range, grain) {
  const result = [];
  if (!range) return result;
  for (let start = range.start; start <= range.end;) {
    const weekday = (new Date(start).getUTCDay() + 6) % 7;
    const date = new Date(start);
    const monthStep = grain === "quarter" ? 3 : grain === "year" ? 12 : 1;
    const monthStart = grain === "quarter" ? Math.floor(date.getUTCMonth()/3)*3 : grain === "year" ? 0 : date.getUTCMonth();
    const calendarEnd = new Date(Date.UTC(date.getUTCFullYear(), monthStart + monthStep, 0)).toISOString().slice(0,10);
    const boundary = grain === "day" ? start : ["month","quarter","year"].includes(grain) ? calendarEnd : shiftDate(start, 6 - weekday);
    const end = [boundary, range.end].sort()[0];
    result.push({ start, end, days: dayCount(start, end) });
    start = shiftDate(end, 1);
  }
  return result;
}
export function trendRows(ctx, range, grain = "week", compare = true) {
  return buckets(range, grain).map(bucket => {
    const previous = { start: shiftDate(bucket.start, -range.days), end: shiftDate(bucket.end, -range.days), days: bucket.days };
    const current = summarize(ctx, bucket);
    const prior = compare ? summarize(ctx, previous) : unknown;
    return { date: bucket.start, throughDate: bucket.end, ...periodFields(bucket, compare ? previous : null), ...current,
      previousComplete: prior.complete ?? false, previousRevenueUsd: prior.revenueUsd, previousActiveAccounts: prior.activeAccounts, previousPayingAccounts: prior.payingAccounts,
      previousCompletedRuns: prior.completedRuns, previousGrossMarginRate: prior.grossMarginRate,
      previousSeatUtilizationRate: prior.seatUtilizationRate, previousActiveUsers: prior.activeUsers,
      previousSubscriptionUsd: prior.subscriptionUsd, previousUsageUsd: prior.usageUsd, previousCostUsd: prior.costUsd,
      previousGrossProfitUsd: prior.revenueUsd != null && prior.costUsd != null ? prior.revenueUsd - prior.costUsd : null,
      previousRunsPerAccount: prior.activeAccounts > 0 && prior.completedRuns != null ? prior.completedRuns / prior.activeAccounts : null,
      previousCostPerThousandRunsUsd: prior.completedRuns > 0 && prior.costUsd != null ? prior.costUsd / prior.completedRuns * 1000 : null };
  });
}
const monthEnd = month => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
const addMonths = (month, offset) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1)).toISOString().slice(0, 7);
export function cohortRows(ctx, asOf) {
  if (!validDate(asOf) || asOf > ctx.coverage.endDate) return [];
  const accounts = [...new Set(ctx.contracts.map(row => row.accountId))].map(accountId => {
    const contracts = ctx.contracts.filter(row => row.accountId === accountId);
    return { accountId, contracts, cohort: contracts.map(row => row.startDate).sort()[0].slice(0, 7) };
  });
  return [...new Set(accounts.map(row => row.cohort))].sort().filter(month => monthEnd(month) <= asOf).map(cohort => {
    const members = accounts.filter(row => row.cohort === cohort);
    return { cohort, accounts: members.length, asOf, M0: 1,
      ...Object.fromEntries(Array.from({ length: 8 }, (_, n) => {
        const age = n + 1; const endpoint = monthEnd(addMonths(cohort, age));
        return [`M${age}`, endpoint > asOf ? null : members.filter(row => row.contracts.some(contract => activeAt(contract, endpoint))).length / members.length];
      })) };
  });
}
export function activation(ctx, range, cohortEnd = range?.end) {
  const accounts = [...new Set(ctx.contracts.map(row => row.accountId))].map(accountId => {
    const start = ctx.contracts.filter(row => row.accountId === accountId).map(row => row.startDate).sort()[0];
    return { accountId, start };
  }).filter(row => range && row.start >= range.start && row.start <= cohortEnd && shiftDate(row.start, 6) <= range.end);
  const outcomes = accounts.map(account => {
    const window = ctx.rows.filter(row => row.accountId === account.accountId
      && row.date >= account.start && row.date <= shiftDate(account.start, 6));
    if (window.some(row => Number.isFinite(row.completedRuns) && row.completedRuns > 0)) return true;
    const coverage = summarize(subset(ctx, ctx.contracts.filter(row => row.accountId === account.accountId)),
      { start: account.start, end: shiftDate(account.start, 6), days: 7 });
    return !coverage.complete || window.some(row => !Number.isFinite(row.completedRuns)) ? null : false;
  });
  const unknownAccounts = outcomes.filter(value => value == null).length;
  const activated = unknownAccounts ? null : outcomes.filter(Boolean).length;
  return { eligibleAccounts: accounts.length, unknownAccounts, activatedAccounts: activated,
    activationRate: accounts.length && activated != null ? activated / accounts.length : null };
}
function accountDetail(ctx, range, accounts, accountId, grain, compare) {
  const period = periodFields(range, compare ? priorRange(range) : null);
  const activeCandidates = accounts.filter(row => row.revenueUsd > 0 || row.previousRevenueUsd > 0);
  const account = accounts.find(row => row.accountId === accountId)
    ?? activeCandidates.filter(row => row.payingAccounts > 0 && row.revenueUsd > 0)
      .toSorted((a, b) => b.revenueUsd - a.revenueUsd)[0] ?? null;
  const accountContext = account ? subset(ctx, ctx.contracts.filter(row => row.accountId === account.accountId)) : null;
  const accountProducts = accountContext ? [...new Set(accountContext.contracts.map(row => row.product))].map(product => ({
    ...period, accountId: account.accountId, product,
    ...summarize(subset(accountContext, accountContext.contracts.filter(row => row.product === product)), range),
  })) : [];
  return { account, accountProducts, accountTrend: accountContext ? trendRows(accountContext, range, grain, compare).map(row => ({ ...row, accountId: account.accountId, account: account.account })) : [] };
}

function segmentSummaries(ctx, range, previous, dimension, compare = true) {
  const period = periodFields(range, previous);
  const field = Object.hasOwn(dimensions, dimension) ? dimension : "product";
  return [...new Set(ctx.contracts.map(row => row[field]))].map(category => {
    const group = subset(ctx, ctx.contracts.filter(row => row[field] === category));
    const actual = summarize(group, range);
    const prior = compare ? summarize(group, previous) : unknown;
    return { ...period, category, ...actual, previousRevenueUsd: prior.revenueUsd,
      deltaUsd: actual.revenueUsd == null || prior.revenueUsd == null ? null : actual.revenueUsd - prior.revenueUsd,
      changeRate: change(actual.revenueUsd, prior.revenueUsd) };
  }).sort((a, b) => (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0));
}

export function buildPerformance(queries, filters, { grain = "week", dimension = "product", accountId = "", compare = true } = {}) {
  const ctx = context(queries, filters);
  const range = periodRange(filters.date, ctx.coverage);
  const previous = compare ? priorRange(range) : null;
  const current = summarize(ctx, range);
  const prior = compare ? summarize(ctx, previous) : { ...unknown, complete: false };
  const accounts = accountRows(ctx, range, compare);
  const intrinsicPrevious = priorRange(range);
  const retained = retention(compare ? accounts : accountRows(ctx, range, true),
    current.complete && summarize(ctx, intrinsicPrevious).complete);
  const period = periodFields(range, previous);
  const deltaUsd = current.revenueUsd == null || prior.revenueUsd == null ? null : current.revenueUsd - prior.revenueUsd;
  const movements = ["New", "Reactivated", "Expansion", "Contraction", "Churn"]
    .map(movement => ({ ...period, movement, deltaUsd: deltaUsd == null ? null : accounts.filter(row => row.movement === movement).reduce((sum, row) => sum + row.deltaUsd, 0) }));
  const segments = segmentSummaries(ctx, range, previous, dimension, compare);
  const detail = accountDetail(ctx, range, accounts, accountId, grain, compare);
  const weekly = buckets(range, grain);
  const usage = weekly.flatMap(bucket => [...new Set(ctx.contracts.map(row => row.product))].map(product => ({
    date: bucket.start, throughDate: bucket.end, product,
    completedRuns: summarize(subset(ctx, ctx.contracts.filter(row => row.product === product)), bucket).completedRuns,
  })));
  const retainedTrend = weekly.map(bucket => {
    const current = rollingRetentionAt(ctx, bucket.end);
    const prior = compare ? rollingRetentionAt(ctx, shiftDate(bucket.end, -range.days)) : null;
    return { date: bucket.end, ...current, previousNetRevenueRetention: prior?.netRevenueRetention ?? null,
      previousGrossRevenueRetention: prior?.grossRevenueRetention ?? null,
      previousPeriodStart: prior?.periodStart ?? null, previousPeriodEnd: prior?.periodEnd ?? null,
      previousComparisonStart: prior?.comparisonStart ?? null, previousComparisonEnd: prior?.comparisonEnd ?? null };
  });
  const trend = trendRows(ctx, range, grain, compare);
  const result = { grain, range, priorRange: previous, current: { ...current, ...retained }, prior, deltaUsd, movements,
    activation: current.complete ? { ...period, ...activation(ctx, range) } : { ...period, eligibleAccounts: null, activatedAccounts: null, activationRate: null },
    segments, accounts, ...detail,
    rollingRetention: retainedTrend.at(-1) ?? { netRevenueRetention: null, grossRevenueRetention: null },
    cohorts: cohortRows(ctx, range?.end), retentionTrend: retainedTrend, usage,
    trend, adoption: trend };
  modelContexts.set(result, ctx);
  return result;
}

function periodRevenue(ctx, range) {
  const cache = indexContext(ctx).revenues;
  const key = `${range.start}|${range.end}`;
  if (cache.has(key)) return cache.get(key);
  const revenue = new Map();
  let complete = Boolean(ctx.contracts.length && range.start >= ctx.coverage.startDate && range.end <= ctx.coverage.endDate);
  const roster = new Map(ctx.contracts.map(row => [row.contractId,row]));
  const keys = new Set();
  for (const row of ctx.rows) {
    if (!inRange(row,range)) continue;
    const contract = roster.get(row.contractId), id = `${row.contractId}|${row.date}`;
    if (keys.has(id) || !contract || !activeAt(contract,row.date) || row.accountId !== contract.accountId
      || !Object.keys(dimensions).every(field => row[field] === contract[field])) complete = false;
    keys.add(id);
    const previous = revenue.get(row.accountId) ?? 0;
    revenue.set(row.accountId, Number.isFinite(row.revenueUsd) && Number.isFinite(previous) ? previous + row.revenueUsd : NaN);
  }
  const expected = ctx.contracts.reduce((n, contract) => n + dayCount(
    [range.start,contract.startDate].sort().at(-1), [range.end,contract.endDate ?? range.end].sort()[0]),0);
  const result = { revenue, complete: complete && keys.size === expected };
  cache.set(key,result); return result;
}
export function rollingRetentionAt(ctx, endpoint) {
  const window = { start: shiftDate(endpoint, -27), end: endpoint, days: 28 };
  const previous = priorRange(window);
  const current = periodRevenue(ctx,window), prior = periodRevenue(ctx,previous);
  const baseline = [...prior.revenue].filter(([,value]) => value > 0);
  const denominator = baseline.reduce((sum,[,value]) => sum + value,0);
  const available = current.complete && prior.complete && denominator > 0
    && [...prior.revenue.values()].every(Number.isFinite)
    && baseline.every(([id]) => Number.isFinite(current.revenue.get(id) ?? 0));
  return { ...periodFields(window, previous),
    netRevenueRetention: available ? baseline.reduce((sum,[id]) => sum + (current.revenue.get(id) ?? 0),0) / denominator : null,
    grossRevenueRetention: available ? baseline.reduce((sum,[id,value]) => sum + Math.min(current.revenue.get(id) ?? 0,value),0) / denominator : null };
}

export function economics(summary) {
  return { ...summary,
    grossProfitUsd: summary.revenueUsd != null && summary.costUsd != null ? summary.revenueUsd - summary.costUsd : null,
    runsPerAccount: summary.activeAccounts > 0 && summary.completedRuns != null ? summary.completedRuns / summary.activeAccounts : null,
    costPerThousandRunsUsd: summary.completedRuns > 0 && summary.costUsd != null ? summary.costUsd / summary.completedRuns * 1000 : null };
}
export function paidRetention(ctx, range) {
  if (!range || !ctx.contracts.length || priorRange(range).start < ctx.coverage.startDate || range.end > ctx.coverage.endDate)
    return { paidAccountRetention: null, churnedAccounts: null, priorPaidAccounts: null };
  const prior = new Set(ctx.contracts.filter(contract => activeAt(contract, priorRange(range).end)).map(row => row.accountId));
  const current = new Set(ctx.contracts.filter(contract => activeAt(contract, range.end)).map(row => row.accountId));
  const retained = [...prior].filter(id => current.has(id)).length;
  return { paidAccountRetention: prior.size ? retained / prior.size : null, churnedAccounts: prior.size - retained, priorPaidAccounts: prior.size,
    retentionBaselineDate: priorRange(range).end, retentionAsOfDate: range.end };
}
export function revenueBridge(model) {
  if (model.deltaUsd == null) return [];
  const period = periodFields(model.range, model.priorRange);
  return [{ ...period, movement: "Previous", bridgeUsd: model.prior.revenueUsd, totalType: "beginning" },
    ...model.movements.filter(row => row.deltaUsd !== 0).map(row => ({ ...row, bridgeUsd: row.deltaUsd })),
    { ...period, movement: "Current", bridgeUsd: model.current.revenueUsd, totalType: "ending" }];
}
function segmentEconomics(ctx, range, previous, field) {
  const period = periodFields(range, previous);
  return [...new Set(ctx.contracts.map(row => row[field]))].map(category => {
    const scoped = subset(ctx, ctx.contracts.filter(row => row[field] === category));
    const current = summarize(scoped, range);
    const prior = previous ? summarize(scoped, previous) : unknown;
    const accounts = accountRows(scoped, range, true);
    return { ...period, category, dimension: field, ...economics(current), previousGrossMarginRate: prior.grossMarginRate,
      deltaUsd: current.revenueUsd != null && prior.revenueUsd != null ? current.revenueUsd - prior.revenueUsd : null,
      changeRate: change(current.revenueUsd, prior.revenueUsd),
      ...retention(accounts, current.complete && summarize(scoped, priorRange(range)).complete), ...paidRetention(scoped, range),
      nrrPeriodStart: range?.start, nrrPeriodEnd: range?.end, nrrBaselineStart: priorRange(range)?.start, nrrBaselineEnd: priorRange(range)?.end };
  }).sort((a,b) => (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0));
}

export function deepDiveModel(queries, filters, model, dimension = "product") {
  const ctx = modelContexts.get(model) ?? context(queries, filters);
  const { range, priorRange: previous } = model;
  const group = field => segmentEconomics(ctx, range, previous, field);
  const products = group("product");
  const productTrend = products.flatMap(({ category: product }) => trendRows(
    subset(ctx, ctx.contracts.filter(row => row.product === product)), range, model.grain ?? "week", Boolean(previous))
    .map(row => ({ ...economics(row), product })));
  const paying = new Set(ctx.contracts.filter(row => range && activeAt(row, range.end)).map(row => row.accountId));
  const multiProductAccounts = [...paying].filter(id => new Set(ctx.contracts.filter(row => row.accountId === id && activeAt(row, range.end)).map(row => row.product)).size > 1).length;
  const sortedAccounts = model.accounts.toSorted((a,b) => (b.revenueUsd ?? 0) - (a.revenueUsd ?? 0));
  const concentration = sortedAccounts.slice(0,10).map((row,index) => ({ ...row, rank: index + 1,
    revenueShare: model.current.revenueUsd > 0 && row.revenueUsd != null ? row.revenueUsd / model.current.revenueUsd : null }));
  const topFiveShare = model.current.revenueUsd > 0 ? sortedAccounts.slice(0,5).reduce((sum,row) => sum + row.revenueUsd, 0) / model.current.revenueUsd : null;
  const activationCohorts = buckets(range,model.grain ?? "week").map(bucket => ({ cohortStart: bucket.start, cohortEnd: bucket.end,
    asOf: range.end, ...activation(ctx, { ...range, start: bucket.start }, bucket.end) }))
    .filter(row => row.eligibleAccounts > 0);
  return { current: { ...economics(model.current), ...paidRetention(ctx,range), multiProductAccounts,
      multiProductShare: paying.size ? multiProductAccounts / paying.size : null, topFiveShare },
    prior: economics(model.prior), products, segments: dimension === "product" ? products : group(dimension),
    productTrend, weekly: model.adoption.map(economics), concentration, activationCohorts,
    movements: model.movements.map(row => ({ ...row, accounts: model.deltaUsd == null ? null : model.accounts.filter(account => account.movement === row.movement).length })),
    bridge: revenueBridge(model) };
}

// Population and cells share this roster definition; activity dates never redefine entry cohorts.
export function cohortMembers(ctx, cohort, age, asOf) {
  const cutoff = monthEnd(addMonths(cohort, age));
  if (!validDate(asOf) || cutoff > asOf || asOf > ctx.coverage.endDate) return [];
  const accounts = new Map();
  for (const contract of ctx.contracts) {
    if (!accounts.has(contract.accountId)) accounts.set(contract.accountId, []);
    accounts.get(contract.accountId).push(contract);
  }
  return [...accounts.entries()].flatMap(([accountId, contracts]) => {
    const firstPaid = contracts.map(row => row.startDate).sort()[0];
    if (firstPaid.slice(0, 7) !== cohort) return [];
    const retained = contracts.some(contract => activeAt(contract, cutoff));
    return [{ accountId, account: contracts[0].account, cohort, age, firstPaid, cutoff, asOf,
      retained, status: retained ? "Retained" : "Lost" }];
  });
}
export function cohortCells(ctx, { entryStart, entryEnd, asOf, maxAge = 8 }) {
  return cohortRows(ctx, asOf).filter(row => (!entryStart || row.cohort >= entryStart) && (!entryEnd || row.cohort <= entryEnd))
    .flatMap(row => Array.from({ length: maxAge }, (_, index) => {
      const age = index + 1;
      const cutoff = monthEnd(addMonths(row.cohort, age));
      const mature = cutoff <= asOf;
      const members = mature ? cohortMembers(ctx, row.cohort, age, asOf) : [];
      const retainedAccounts = mature ? members.filter(member => member.retained).length : null;
      return { cohort: row.cohort, cohortLabel: humanMonth(row.cohort), cohortSizeLabel: `${row.accounts} customers`, age,
        ageLabel: `Month ${age}`, cutoff, asOf, eligibleAccounts: row.accounts, retainedAccounts,
        retentionRate: mature ? retainedAccounts / row.accounts : null, mature };
    }));
}


export function supportedGrains(range) {
  const days = range?.days ?? 0;
  return ["day", ...(days >= 7 ? ["week"] : []), ...(days >= 45 ? ["month"] : []),
    ...(days >= 180 ? ["quarter"] : []), ...(days >= 730 ? ["year"] : [])];
}

// One engine per reviewed snapshot. Comparison is presentation-only; bounded cache
// entries can be reused across tabs with identical scopes without leaking filters.
export function createPerformanceEngine(queries, capacity = 12) {
  const cache = new Map(), globalCache = new Map();
  const remember = (store, key, value) => {
    store.delete(key); store.set(key,value);
    if (store.size > capacity) store.delete(store.keys().next().value);
    return value;
  };
  return { read(filters, options = {}) {
    const scoped = Object.fromEntries(["date", ...Object.keys(dimensions)].map(field => [field,filters[field] ?? "all"]));
    const params = { grain: options.grain ?? "week", dimension: Object.hasOwn(dimensions, options.dimension) ? options.dimension : "product", accountId: options.accountId ?? "" };
    const key = JSON.stringify([scoped,params]), globalKey = performanceGlobalKey(scoped,params);
    if (cache.has(key)) {
      if (globalCache.has(globalKey)) remember(globalCache,globalKey,globalCache.get(globalKey));
      return remember(cache,key,cache.get(key));
    }
    let base = globalCache.get(globalKey);
    if (!base) {
      const model = buildPerformance(queries,scoped,{ grain:params.grain,compare:true });
      base = { model, deep: deepDiveModel(queries,scoped,model) };
    }
    remember(globalCache,globalKey,base);
    if (!params.accountId && params.dimension === "product") return remember(cache,key,base);
    const ctx = modelContexts.get(base.model);
    const model = { ...base.model,
      ...(params.accountId ? accountDetail(ctx,base.model.range,base.model.accounts,params.accountId,params.grain,true) : {}),
      ...(params.dimension !== "product" ? { segments: segmentSummaries(ctx,base.model.range,base.model.priorRange,params.dimension) } : {}) };
    modelContexts.set(model,ctx);
    const deep = params.dimension === "product" ? base.deep : { ...base.deep,
      segments: segmentEconomics(ctx,model.range,model.priorRange,params.dimension) };
    return remember(cache,key,{model,deep});
  } };
}


export function performanceGlobalKey(filters, options = {}) {
  return JSON.stringify([Object.fromEntries(["date",...Object.keys(dimensions)].map(field => [field,filters[field] ?? "all"])),options.grain ?? "week"]);
}
export function localPerformanceChanges(previous = {}, next = {}) {
  return ["dimension","accountId"].filter(field => (previous[field] ?? (field === "dimension" ? "product" : "")) !== (next[field] ?? (field === "dimension" ? "product" : "")));
}
