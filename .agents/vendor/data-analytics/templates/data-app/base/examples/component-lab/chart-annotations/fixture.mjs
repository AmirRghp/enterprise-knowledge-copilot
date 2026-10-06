// Entirely synthetic, deterministic evidence shared by both example surfaces.
export const chartSpec = {
  type: "line", x: "date", y: "activeAccounts",
  fields: ["activeAccounts", "repeatAccounts"],
  showXAxisLabel: false, yLabel: "Accounts", startAtZero: true,
  annotations: [
    { id: "operating-target", kind: "benchmark", label: "Reviewed operating target", field: "targetAccounts", measure: "repeatAccounts" },
    { id: "release", kind: "event", label: "Synthetic release recorded", field: "releaseEvidence", at: "2026-08-03" },
    { id: "review-window", kind: "range", label: "Reviewed comparison window", at: "2026-08-02", end: "2026-08-05" },
    { id: "repeat-peak", kind: "point", label: "Observed repeat-use high", field: "repeatAccounts", at: "2026-08-06" },
  ],
};

const active = [82, 91, 105, 116, 119, 134, 127, 132];
const repeat = [44, 49, 58, 64, 73, 88, 81, 85];
const rows = active.map((activeAccounts, index) => ({
  date: `2026-08-${String(index + 1).padStart(2, "0")}`,
  activeAccounts, repeatAccounts: repeat[index], targetAccounts: 120,
  releaseEvidence: index === 2 ? "Fictional release recorded in the reviewed fixture" : "",
}));

export function annotationSnapshot(surface = "report") {
  if (!["report", "dashboard"].includes(surface)) throw new Error("Unknown annotation example surface.");
  return {
    id: `synthetic-shared-chart-annotations-${surface}`, surface,
    title: "Shared chart annotations", status: "fixture", generatedAt: "2026-08-09T12:00:00Z",
    report: { asOf: "2026-08-08" },
    filters: [{ id: "period", label: "Example period", field: "date", mode: "through",
      defaultValue: "all", reportVisible: true }],
    queries: { annotation_history: { rows, source: {
      label: "Synthetic reviewed annotation history",
      sql: "SELECT date, activeAccounts, repeatAccounts, targetAccounts, releaseEvidence FROM synthetic.annotation_history",
      tables: ["synthetic.annotation_history"],
      caveats: ["Fictional fixture; the recorded event does not establish causation."],
      metricDefinitions: [
        { label: "Active accounts", field: "activeAccounts", definition: "Synthetic daily active accounts." },
        { label: "Repeat accounts", field: "repeatAccounts", definition: "Synthetic accounts active again." },
        { label: "Target accounts", field: "targetAccounts", definition: "Constant reviewed operating target for this synthetic period." },
        { label: "Release evidence", field: "releaseEvidence", definition: "Reviewed record of the fictional release, not a causal estimate." },
      ],
    } } },
  };
}
