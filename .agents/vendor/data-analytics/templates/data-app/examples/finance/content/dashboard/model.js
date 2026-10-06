const MONTHS = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "3Y": 36, "5Y": 60 };
export const TIMEFRAMES = ["1M", "3M", "6M", "YTD", "1Y", "3Y", "5Y", "All"];
function rangeStart(latest, timeframe) {
  const end = new Date(latest + "T00:00:00Z");
  if (timeframe === "YTD") return latest.slice(0, 4) + "-01-01";
  const months = MONTHS[timeframe];
  if (!months) return null;
  const day = end.getUTCDate(); end.setUTCDate(1); end.setUTCMonth(end.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay) + 1);
  return end.toISOString().slice(0, 10);
}
export function timeframeRows(rows, timeframe) {
  if (!rows.length) return [];
  const start = rangeStart(rows.at(-1).date, timeframe);
  return start ? rows.filter(row => row.date >= start) : rows;
}
export function availableTimeframes(rows) {
  if (!rows.length) return [];
  return TIMEFRAMES.filter(timeframe => {
    const start = rangeStart(rows.at(-1).date, timeframe);
    if (!start) return true;
    const firstSession = new Date(start + "T00:00:00Z");
    while ([0, 6].includes(firstSession.getUTCDay())) firstSession.setUTCDate(firstSession.getUTCDate() + 1);
    return rows[0].date <= firstSession.toISOString().slice(0, 10);
  });
}
export function scenarioResults(price, shares, side, outlook) {
  if (!Number.isFinite(price) || price <= 0 || !outlook || !["Long", "Short"].includes(side)) return null;
  const quantity = Number(shares);
  if (shares === "" || !Number.isFinite(quantity) || quantity < 0 || !Number.isFinite(outlook.bearPercent) || !Number.isFinite(outlook.bullPercent) || outlook.bearPercent < -100 || outlook.bullPercent < outlook.bearPercent) return null;
  const direction = side === "Long" ? 1 : -1;
  const bearPrice = price * (1 + outlook.bearPercent / 100), bullPrice = price * (1 + outlook.bullPercent / 100);
  return { entry: price, quantity, side, horizon: outlook.horizon, bearPercent: outlook.bearPercent, bullPercent: outlook.bullPercent,
    bearPrice, bullPrice, bearResult: (bearPrice - price) * quantity * direction || 0, bullResult: (bullPrice - price) * quantity * direction || 0 };
}
export function bucketRows(rows, maximum = 184) {
  if (!Number.isInteger(maximum) || maximum < 1) throw new Error("Candle count must be a positive integer.");
  if (rows.length <= maximum) return rows;
  const bucketSize = Math.ceil(rows.length / maximum);
  const buckets = [];
  for (let index = 0; index < rows.length; index += bucketSize) {
    const group = rows.slice(index, index + bucketSize);
    buckets.push({
      ...group.at(-1),
      startDate: group[0].date,
      sessions: group.length,
      open: group[0].open,
      high: Math.max(...group.map((row) => row.high)),
      low: Math.min(...group.map((row) => row.low)),
      close: group.at(-1).close,
      volume: group.reduce((total, row) => total + row.volume, 0),
    });
  }
  return buckets;
}

// These are descriptions of the loaded simulation, never news or fundamentals.
export function priceStatistics(rows) {
  if (!rows.length) return null;
  const year = timeframeRows(rows, "1Y"), recent = rows.slice(-30), latest = rows.at(-1);
  let peak = year[0].close, drawdown = 0;
  for (const row of year) {
    peak = Math.max(peak, row.close);
    drawdown = Math.min(drawdown, row.close / peak - 1);
  }
  const change = timeframe => {
    const window = timeframeRows(rows, timeframe);
    return window.length > 1 ? latest.close / window[0].close - 1 : null;
  };
  const averageVolume = recent.reduce((total, row) => total + row.volume, 0) / recent.length;
  return { averageVolume, relativeVolume: averageVolume ? latest.volume / averageVolume : null,
    yearHigh: Math.max(...year.map(row => row.high)), yearLow: Math.min(...year.map(row => row.low)),
    monthChange: change("1M"), yearChange: change("1Y"), ytdChange: change("YTD"), drawdown };
}

export function watchNotes(rows) {
  const year = timeframeRows(rows, "1Y");
  if (year.length < 2) return [];
  const changes = year.slice(1).map((row, index) => ({ ...row, change: row.close / year[index].close - 1 }));
  const volume = year.reduce((best, row) => row.volume > best.volume ? row : best);
  const rise = changes.reduce((best, row) => row.change > best.change ? row : best);
  const fall = changes.reduce((best, row) => row.change < best.change ? row : best);
  const high = year.reduce((best, row) => row.high > best.high ? row : best);
  const note = (row, type, title, detail) => ({ date: row.date, price: row.high, type, title, detail });
  const percent = value => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
  return [
    note(volume, "Volume", "Busiest session", `${volume.volume.toLocaleString("en-US")} shares traded in the simulation.`),
    ...(rise.change > 0 ? [note(rise, "Rise", "Largest daily gain", `${percent(rise.change)} from the previous session’s close.`)] : []),
    ...(fall.change < 0 ? [note(fall, "Fall", "Largest daily decline", `${percent(fall.change)} from the previous session’s close.`)] : []),
    note(high, "High", "Past-year high", `$${high.high.toFixed(2)} intraday in the simulation.`),
  ].sort((a, b) => a.date.localeCompare(b.date));
}
