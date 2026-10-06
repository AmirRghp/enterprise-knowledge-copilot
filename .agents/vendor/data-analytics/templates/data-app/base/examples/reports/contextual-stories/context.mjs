export const contextualCases = [
  { id: "operations", queryId: "operations_history", recordId: "OPS-017",
    valueField: "completedRequests", chartType: "line",
    question: "What changed in the intake operation?", title: "Daily completed intake requests",
    yLabel: "Completed requests", unit: "requests per UTC day", period: "day",
    originalContext: "Second intake desk opened" },
  { id: "adjustment", queryId: "adjustment_history", recordId: "BILL-104",
    valueField: "postedBillingsUsd", chartType: "bar",
    question: "Is the billing peak recurring?", title: "Weekly posted billings",
    yLabel: "Posted billings (USD)", unit: "USD per week", period: "week beginning",
    originalContext: "One-time catch-up invoice for June work posted" },
  { id: "coverage", queryId: "coverage_history", recordId: "MON-008",
    valueField: "detectedIncidents", chartType: "line",
    question: "Does the higher incident count mean performance worsened?", title: "Weekly detected incidents",
    yLabel: "Detected incidents", unit: "incidents per week", period: "week beginning",
    originalContext: "Monitoring expanded from 8 to 12 locations" },
];

export const exactDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function currentContext(story, rows) {
  const candidates = rows.filter((row) => row.contextId === story.recordId);
  if (candidates.length !== 1) return null;
  const [row] = candidates;
  if (!(exactDate(row.date) && Number.isFinite(row[story.valueField]) && row[story.valueField] >= 0
    && typeof row.context === "string" && row.context.trim() && row.context.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(row.context)
    && rows.filter((other) => other.date === row.date).length === 1)) return null;
  // Do not repeat an original contextual claim when structured evidence now
  // contradicts it. A revised record's wording is handled on its own terms.
  if (row.context.trim() === story.originalContext) {
    if (story.id === "adjustment" && !(Number.isFinite(row.oneTimeAmount)
      && row.oneTimeAmount > 0 && row.oneTimeAmount <= row[story.valueField])) return null;
    if (story.id === "coverage" && !rows.every((entry) =>
      entry.coveredLocations === (entry.date < row.date ? 8 : 12))) return null;
  }
  return row;
}

// A small ownership fingerprint, not an authenticity or security check. The
// stable source record survives corrections; the annotation ID names a revision.
function contextAnnotationId(story, annotation) {
  let hash = 2166136261;
  for (const character of JSON.stringify([story.recordId, annotation.kind, annotation.field, annotation.at, annotation.label]))
    hash = Math.imul(hash ^ character.codePointAt(0), 16777619);
  return `context-${story.id}-${story.recordId}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function contextualAnnotations(story, rows) {
  const record = currentContext(story, rows);
  if (!record) return [];
  const annotation = { kind: story.id === "adjustment" ? "point" : "event",
    field: story.id === "adjustment" ? story.valueField : "context", at: record.date, label: record.context.trim() };
  return [{ id: contextAnnotationId(story, annotation), ...annotation }];
}

export function reconcileContextAnnotations(story, authored, saved, rows) {
  const spec = saved ?? authored;
  const current = contextualAnnotations(story, rows);
  if (!Object.hasOwn(spec, "annotations")) return { ...spec, annotations: current };
  let replaced = false;
  const annotations = (spec.annotations ?? []).flatMap((annotation) => {
    // Recognize the earlier generated billing event, too. Migrate only its exact
    // ownership fingerprint; preserve custom text, anchors, and explicit deletion.
    const owned = ((annotation.kind === "event" && annotation.field === "context")
      || (story.id === "adjustment" && annotation.kind === "point" && annotation.field === story.valueField))
      && annotation.id === contextAnnotationId(story, annotation);
    if (!owned) return [annotation];
    if (replaced) return [];
    replaced = true;
    return current;
  });
  return { ...spec, annotations };
}

export function contextualAnswer(story, rows) {
  const context = currentContext(story, rows);
  if (!context) return "The current observations have no consistent contextual record. Read the measurements on their own until that record is restored.";
  if (context.context.trim() !== story.originalContext)
    return "The contextual record has changed. Use the updated note to reassess the current measurements before reusing the earlier interpretation.";
  const before = rows.filter((row) => row.date < context.date);
  const after = rows.filter((row) => row.date >= context.date);
  const value = (row) => row[story.valueField];
  const valid = rows.length > 1 && rows.every((row) => exactDate(row.date) && Number.isFinite(value(row)) && value(row) >= 0)
    && new Set(rows.map((row) => row.date)).size === rows.length;
  if (story.id === "operations") {
    const mean = (items) => items.reduce((sum, row) => sum + value(row), 0) / items.length;
    return valid && before.length >= 2 && after.length >= 2 && mean(after) > mean(before)
      ? "Compare routing and completions for the two desks before extending the staffing model. Daily totals locate the pickup. A desk-level comparison would show how work was distributed."
      : "Use the recorded staffing change to frame an operational review. The current observations do not establish the earlier pickup in completions.";
  }
  if (story.id === "adjustment") {
    const others = rows.filter((row) => row !== context).map(value);
    const adjusted = value(context) - context.oneTimeAmount;
    return valid && Number.isFinite(context.oneTimeAmount) && context.oneTimeAmount > 0
      && value(context) > Math.max(...others) && adjusted >= Math.min(...others) && adjusted <= Math.max(...others)
      ? "Separate the catch-up entry before revising the recurring billing outlook. Removing it puts that week's total back within the range of the other weeks."
      : "Separate the documented one-time entry from recurring billings. Recheck the current amount before drawing the earlier conclusion about the peak.";
  }
  return valid && before.length > 0 && after.length > 0
    && before.every((row) => row.coveredLocations === 8) && after.every((row) => row.coveredLocations === 12)
    ? "Keep the reporting population consistent before calling this a deterioration. Compare a fixed set of locations or a per-location measure, because the count spans two coverage levels."
    : "Check the current reporting population before comparing incident totals across the coverage change.";
}
