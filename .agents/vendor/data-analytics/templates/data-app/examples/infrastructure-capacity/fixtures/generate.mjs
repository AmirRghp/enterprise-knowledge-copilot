const regions = [
  { name: "US East", capacity: 9800, pressure: 1.08 },
  { name: "US West", capacity: 8400, pressure: 0.94 },
  { name: "Western Europe", capacity: 7600, pressure: 1.02 },
  { name: "Northern Europe", capacity: 5700, pressure: 0.88 },
  { name: "Japan", capacity: 4900, pressure: 1.12 },
  { name: "Singapore", capacity: 4500, pressure: 1.04 },
];

const environments = [
  { name: "Production", scale: 1 },
  { name: "Staging", scale: 0.12 },
];

const pools = [
  { name: "H100", share: 0.54, demand: 0.96, rolloutLift: 0.035 },
  { name: "H200", share: 0.28, demand: 1.12, rolloutLift: 0.115 },
  { name: "B200", share: 0.18, demand: 1.04, rolloutLift: 0.075 },
];

const causes = [
  { name: "Admission timeout", weight: 0.38 },
  { name: "Capacity unavailable", weight: 0.29 },
  { name: "Host health", weight: 0.19 },
  { name: "Dependency error", weight: 0.14 },
];

const start = new Date("2026-08-20T11:30:00Z");
const intervals = Array.from({ length: 54 }, (_, index) => {
  const date = new Date(start);
  date.setUTCMinutes(date.getUTCMinutes() + index * 30);
  return date;
});

const round = (value, digits = 0) => Number(value.toFixed(digits));

const capacityRows = intervals.flatMap((hour, intervalIndex) => regions.flatMap((region, regionIndex) =>
  environments.flatMap((environment) => pools.map((pool, poolIndex) => {
    const hourOfDay = hour.getUTCHours() + hour.getUTCMinutes() / 60;
    const dailyWave = 0.72 + 0.18 * Math.sin((hourOfDay - 7) / 24 * Math.PI * 2);
    const regionalWave = 0.035 * Math.sin(intervalIndex * 0.26 + regionIndex * 0.83);
    const poolWave = 0.025 * Math.cos(intervalIndex * 0.205 + poolIndex * 1.4);
    const isRolloutDay = hour.toISOString().slice(0, 10) === "2026-08-21";
    const rolloutWave = isRolloutDay ? Math.exp(-0.5 * ((hourOfDay - 13.25) / 1.8) ** 2) : 0;
    const capacityUnits = Math.round(region.capacity * pool.share * environment.scale);
    const plannedUtilization = Math.min(0.8, dailyWave * region.pressure * pool.demand);
    const actualUtilization = Math.min(0.97, Math.max(0.32,
      plannedUtilization + regionalWave + poolWave +
      (environment.name === "Production" ? rolloutWave * pool.rolloutLift : 0)));
    const plannedDemandUnits = Math.round(capacityUnits * plannedUtilization);
    const demandUnits = Math.round(capacityUnits * actualUtilization);
    const regionalIncidentLoss = environment.name === "Production" && isRolloutDay
      ? rolloutWave * (region.name === "Western Europe" ? 0.026 : region.name === "Japan" ? 0.012 : 0)
      : 0;
    const unavailableUnits = Math.max(2, Math.round(capacityUnits *
      (0.018 + regionalIncidentLoss + 0.012 * Math.max(0, Math.sin(intervalIndex * 0.165 + regionIndex)))));
    const reservedUnits = Math.round(capacityUnits * (environment.name === "Production" ? 0.08 : 0.04));
    return {
      timestamp: hour.toISOString(),
      date: hour.toISOString().slice(0, 10),
      hourLabel: `${String(hour.getUTCHours()).padStart(2, "0")}:${String(hour.getUTCMinutes()).padStart(2, "0")}`,
      region: region.name,
      environment: environment.name,
      pool: pool.name,
      capacityUnits,
      plannedDemandUnits,
      demandUnits,
      safeCapacityUnits: Math.round(capacityUnits * 0.85),
      unavailableUnits,
      reservedUnits,
    };
  }))));

const queueRows = capacityRows.map((row, index) => {
  const utilization = row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits);
  const pressure = Math.max(0, utilization - 0.7);
  const observedAt = new Date(row.timestamp);
  const observedHour = observedAt.getUTCHours() + observedAt.getUTCMinutes() / 60;
  const japanPlacementWave = row.date === "2026-08-21" && row.environment === "Production" && row.region === "Japan"
    ? Math.exp(-0.5 * ((observedHour - 13.5) / 1.35) ** 2)
    : 0;
  const delayFactor = row.pool === "H200" ? 1.35 : row.pool === "B200" ? 1.05 : 0.75;
  const p95DelaySeconds = round((7 + pressure ** 2 * 510 + Math.max(0, Math.cos(index * 0.13)) * 5) *
    delayFactor + japanPlacementWave * 18, 1);
  // Deterministic synthetic placement frequencies; the 95th rank preserves the subgroup P95.
  const sampleScale = Math.max(1,Math.round(row.demandUnits/100));
  const delayHistogram = [.1,.2,.3,.4,.5,.6,.8,1,1.8].map((fraction,i) =>
    [round(p95DelaySeconds*fraction,2), [10,15,25,20,10,10,4,1,5][i]*sampleScale]);
  return {
    timestamp: row.timestamp,
    date: row.date,
    region: row.region,
    environment: row.environment,
    pool: row.pool,
    queueDepth: Math.round(18 + pressure * 760 + japanPlacementWave * 120 +
      Math.max(0, Math.sin(index * 0.17)) * 22),
    p95DelaySeconds,
    delayHistogram,
  };
});

const failureRows = capacityRows.flatMap((row, index) => {
  const utilization = row.demandUnits / Math.max(1, row.capacityUnits - row.unavailableUnits);
  const failureBase = Math.max(0.3, (utilization - 0.73) * 46 + row.unavailableUnits / 75);
  return causes.map((cause, causeIndex) => ({
    timestamp: row.timestamp,
    date: row.date,
    region: row.region,
    environment: row.environment,
    pool: row.pool,
    cause: cause.name,
    failures: Math.max(0, Math.round(failureBase * cause.weight +
      Math.max(0, Math.sin(index * 0.29 + causeIndex)) * 1.6)),
  }));
});

const telemetryKey = (row) => [row.timestamp, row.region, row.environment, row.pool].join("|");
const queueByKey = new Map(queueRows.map((row) => [telemetryKey(row), row]));
const failuresByKey = failureRows.reduce((totals, row) => {
  const key = telemetryKey(row);
  totals.set(key, (totals.get(key) ?? 0) + row.failures);
  return totals;
}, new Map());
const concentrationRows = capacityRows.map((row) => ({
  timestamp: row.timestamp,
  date: row.date,
  hourLabel: row.hourLabel,
  region: row.region,
  environment: row.environment,
  pool: row.pool,
  capacityUnits: row.capacityUnits,
  demandUnits: row.demandUnits,
  unavailableUnits: row.unavailableUnits,
  queueDepth: queueByKey.get(telemetryKey(row))?.queueDepth ?? 0,
  failures: failuresByKey.get(telemetryKey(row)) ?? 0,
}));

const incidentSeed = [
  ["INC-4821", "Japan", "Production", "H200", "Placement API", "Investigating", "High", 41],
  ["INC-4819", "US East", "Production", "H100", "Admission control", "Mitigating", "High", 68],
  ["INC-4816", "Singapore", "Production", "B200", "Host allocator", "Monitoring", "Medium", 96],
  ["INC-4812", "Western Europe", "Production", "H100", "Capacity planner", "Monitoring", "Medium", 133],
  ["INC-4808", "US West", "Staging", "H200", "Image service", "Investigating", "Low", 184],
  ["INC-4804", "Northern Europe", "Production", "H100", "Host health", "Resolved", "Low", 267],
  ["INC-4798", "Japan", "Staging", "B200", "Placement API", "Resolved", "Low", 318],
];

const incidentRows = incidentSeed.map(([incident, region, environment, pool, service, status, severity, ageMinutes]) => ({
  incident, region, environment, pool, service, status, severity, ageMinutes,
  date: "2026-08-21",
  openedAt: new Date(Date.parse("2026-08-21T14:00:00Z") - ageMinutes * 60000).toISOString(),
  nextAction: incident === "INC-4821" ? "Pause H200 rollout; compare placement delay before resuming"
    : status === "Resolved" ? "Verify post-incident checks" : status === "Monitoring" ? "Watch queue and health recovery"
      : "Inspect admissions and available capacity",
}));

const source = (label, table, componentIds) => ({
  label,
  caveats: ["Aster Compute is fictional. Synthetic telemetry through August 21, 2026 at 14:00 UTC; incident states are recorded at that cutoff, not a historical incident event log."],
  sql: `SELECT * FROM ${table} WHERE observed_date <= :date`,
  tables: [table],
  metricDefinitions: [{
    label,
    definition: `Operational records used to monitor ${label.toLowerCase()}.`,
    componentIds,
    sourceLineage: [{ tables: [table] }],
  }],
});

const capacityComponents = [
  "fleet-operating-envelope", "demand-trend", "failover-margin", "available-trend",
  "utilization-trend", "unavailable-trend", "regional-pressure", "regional-pool-saturation",
  "failover-envelope-progress",
];

const capacitySourceMetadata = source(
  "Regional demand and capacity",
  "infrastructure.capacity_hourly",
  capacityComponents,
);
capacitySourceMetadata.metricDefinitions.push({
  label: "Regional pool load",
  definition: "Active GPU-equivalent demand summed for each timestamp, region, and accelerator pool.",
  formula: "SUM(demandUnits) BY timestamp, region, pool",
  componentIds: ["regional-pool-saturation"],
  sourceLineage: [{ tables: ["infrastructure.capacity_hourly"] }],
});

export const snapshot = {
  id: "infrastructure-capacity-example",
  title: "Aster Compute capacity",
  generatedAt: "2026-08-21T14:00:00Z",
  status: "fixture",
  surface: "dashboard",
  filters: [
    { id: "date", label: "Observed through", field: "date", mode: "through", defaultValue: "2026-08-21",
      queryIds: ["capacity", "queues", "failures", "incidents", "concentration"] },
    { id: "environment", label: "Environment", field: "environment", defaultValue: "Production",
      queryIds: ["capacity", "queues", "failures", "incidents", "concentration"] },
    { id: "region", label: "Region", field: "region", defaultValue: "all",
      queryIds: ["capacity", "queues", "failures", "incidents", "concentration"] },
    { id: "pool", label: "Accelerator pool", field: "pool", defaultValue: "all",
      queryIds: ["capacity", "queues", "failures", "incidents", "concentration"] },
  ],
  queries: {
    capacity: {
      rows: capacityRows,
      source: capacitySourceMetadata,
    },
    queues: {
      rows: queueRows,
      source: { ...source("Placement queue telemetry", "infrastructure.placement_queue_hourly",
        ["placement-delay-trend", "queue-depth-trend", "queue-recovery-progress"]),
        metricDefinitions: [{field:"p95DelaySeconds",label:"P95 placement delay",unit:"seconds",
          definition:"Nearest-rank 95th percentile of the combined synthetic placement frequencies. delayHistogram contains exact [seconds, count] pairs; subgroup percentiles are never averaged."}] },
    },
    failures: {
      rows: failureRows,
      source: source("Workload admission failures", "infrastructure.admission_failures_hourly",
        ["admission-failure-trend", "admission-recovery-progress"]),
    },
    incidents: {
      rows: incidentRows,
      source: source("Infrastructure incidents", "operations.infrastructure_incidents",
        ["incident-response-progress", "capacity-incidents"]),
    },
    concentration: {
      rows: concentrationRows,
      source: {
        label: "Regional capacity concentration",
        sql: `SELECT capacity, queue_depth, failures
          FROM infrastructure.capacity_hourly
          JOIN infrastructure.placement_queue_hourly USING (timestamp, region, environment, pool)
          JOIN infrastructure.admission_failures_hourly USING (timestamp, region, environment, pool)
          WHERE observed_date <= :date`,
        tables: [
          "infrastructure.capacity_hourly",
          "infrastructure.placement_queue_hourly",
          "infrastructure.admission_failures_hourly",
        ],
        metricDefinitions: [{
          label: "Regional concentration",
          definition: "Regional spread and top-region shares for utilization, queued work, and failed admissions.",
          componentIds: ["regional-concentration"],
          sourceLineage: [{ tables: [
            "infrastructure.capacity_hourly",
            "infrastructure.placement_queue_hourly",
            "infrastructure.admission_failures_hourly",
          ] }],
        }],
      },
    },
  },
};

export function fixture() { return structuredClone(snapshot); }
