export const reportQuestion = "Why are more orders arriving late, and what should we fix first?";
export const pickupRecordText = "The East weekday collection moved from 18:00 to 16:30 local time on July 20. The afternoon packing wave still starts at 16:45.";

export const chartSpecs = {
  trend: {
    type: "line", x: "week", y: "lateRate", fields: ["lateRate"],
    yLabel: "Share of orders delivered late", showXAxisLabel: false, showLegend: false,
    startAtZero: true, colors: { lateRate: "var(--chart-1)" },
    annotations: [{ id: "delivery-pickup-change", kind: "event", at: "2026-07-20",
      field: "context", label: "East pickup moved to 16:30" }],
  },
  bridge: {
    type: "bar", x: "stage", y: "extraLateOrders", fields: ["extraLateOrders"],
    yLabel: "Additional late orders", showXAxisLabel: false, showLegend: false,
    startAtZero: true, showValues: true,
    colors: { "Order volume": "var(--report-comparison-fill)",
      "Missed dispatch": "var(--chart-1)", "After handoff": "var(--chart-2)" },
  },
  timing: {
    type: "horizontalBar", x: "groupLabel", y: "currentRate", fields: ["baselineRate", "currentRate"],
    xLabel: "Share of orders delivered late", showXAxisLabel: true, showYAxisLabel: false,
    showLegend: true, startAtZero: true,
    legend: { labels: { baselineRate: "Baseline", currentRate: "Recent" } },
    colors: { baselineRate: "var(--report-comparison-fill)", currentRate: "var(--chart-1)" },
  },
};

export function supportsPickupContext(records) {
  const matches = records.filter((record) => record.id === "OPS-17");
  return matches.length === 1 && matches[0].date === "2026-07-20"
    && typeof matches[0].text === "string" && matches[0].text.startsWith(pickupRecordText);
}

// Reconcile only this example's generated note. Preserve independently edited
// annotations and explicit removal; the shared renderer validates the anchor.
export function authoredChart(kind, rows, records, override) {
  const spec = chartSpecs[kind];
  const note = spec.annotations?.[0];
  if (!note) return override ?? spec;
  const supported = supportsPickupContext(records)
    && rows.filter((row) => row.week === note.at && row.context === note.label).length === 1;
  const chart = override ?? spec;
  if (supported || !chart.annotations) return chart;
  return { ...chart, annotations: chart.annotations.filter((entry) =>
    !Object.entries(note).every(([key, value]) => entry[key] === value)) };
}

export const actions = [
  {
    id: "delivery-packing-test", queries: ["weekly", "timing", "research"],
    title: "Test whether packing can meet the earlier collection", label: "Draft the dispatch pilot",
    deliverable: "East dispatch pilot brief with eligible orders, comparison plan, success measures, and stop rules",
    text: "- **Pilot an earlier packing wave.** Test whether East can meet the original delivery promise without another pickup. Compare similar weekdays and order complexity, and measure on-time delivery, packing cost, and missed collections.",
  },
  {
    id: "delivery-pickup-comparison", queries: ["bridge", "economics", "research"],
    title: "Price the pickup against the orders it can help", label: "Build a pickup cost comparison",
    deliverable: "East weekday pickup comparison with eligible-order volumes, break-even scenarios, assumptions, and missing costs",
    text: "- **Price a later pickup before booking it.** Identify East weekday orders that could use the 18:00 collection and still meet their original promise. Compare expected customer and operating benefits with the daily fee and 500-parcel cap.",
  },
];

export function summarize(rows) {
  const sum = (group, field) => group.reduce((total, row) => total + row[field], 0);
  const before = rows.filter((row) => row.week < "2026-07-20");
  const current = rows.filter((row) => row.week >= "2026-07-20");
  return { beforeOrders: sum(before, "orders"), orders: sum(current, "orders"),
    beforeLate: sum(before, "lateOrders"), late: sum(current, "lateOrders") };
}

export const number = (value) => value.toLocaleString("en-US", { maximumFractionDigits: 0 });
export const percent = (value) => `${(value * 100).toFixed(1).replace(/\.0$/u, "")}%`;
