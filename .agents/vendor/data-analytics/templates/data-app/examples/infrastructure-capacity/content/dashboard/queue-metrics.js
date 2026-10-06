// Merge exact-value frequencies, never subgroup percentiles. Missing distributions stay unknown.
export function queueHistory(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.timestamp) ?? { timestamp:row.timestamp, queueDepth:0, delays:new Map(), complete:true };
    group.queueDepth += row.queueDepth;
    if (!Array.isArray(row.delayHistogram) || !row.delayHistogram.length) group.complete = false;
    else for (const [seconds,count] of row.delayHistogram) {
      if (!Number.isFinite(seconds) || seconds < 0 || !Number.isSafeInteger(count) || count < 0) group.complete = false;
      else group.delays.set(seconds,(group.delays.get(seconds) ?? 0)+count);
    }
    groups.set(row.timestamp,group);
  }
  return [...groups.values()].map(({timestamp,queueDepth,delays,complete}) => {
    const count = [...delays.values()].reduce((sum,value) => sum+value,0);
    let p95DelaySeconds = null, cumulative = 0;
    if (complete && count) for (const [seconds,frequency] of [...delays].sort((a,b) => a[0]-b[0])) {
      cumulative += frequency;
      if (cumulative >= Math.ceil(count*.95)) { p95DelaySeconds=seconds; break; }
    }
    return {timestamp,queueDepth,p95DelaySeconds};
  }).sort((a,b) => a.timestamp.localeCompare(b.timestamp));
}
