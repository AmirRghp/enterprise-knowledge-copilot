const categories = ["Driver pay", "Fuel", "Vehicle maintenance", "Warehousing", "Insurance", "Software and systems"];
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);

// Normalize by scheduled volume so a partial day's completions do not imply inflation.
export function compareOperatingCosts(routeRows, week, region = "all") {
  const scoped = routeRows.filter(row => region === "all" || row.region === region);
  const baselineWeeks = [...new Set(scoped.filter(row => row.week < week).map(row => row.week))].sort().slice(-4);
  const current = scoped.filter(row => row.week === week);
  const baseline = scoped.filter(row => baselineWeeks.includes(row.week));
  const volume = sum(current, "scheduled"), priorVolume = sum(baseline, "scheduled");
  const rows = categories.map(category => {
    const amount = sum(current, category), prior = sum(baseline, category);
    const expected = priorVolume > 0 ? prior / priorVolume * volume : null;
    return { week, category, amount, expected, variance: expected == null ? null : amount - expected,
      rateChange: expected > 0 ? amount / expected - 1 : null };
  }).sort((a, b) => b.amount - a.amount);
  const highlight = rows.filter(row => Math.abs(row.rateChange ?? 0) > .03)
    .sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance))[0];
  return { rows, highlight, baselineWeeks, sourceRows: [...baseline, ...current] };
}
