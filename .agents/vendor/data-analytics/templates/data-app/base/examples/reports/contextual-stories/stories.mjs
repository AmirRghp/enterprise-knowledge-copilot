import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contextualCases, currentContext, exactDate } from "./context.mjs";

export { contextualCases } from "./context.mjs";
const sha256 = (input) => createHash("sha256").update(input).digest("hex");
const evidenceFile = "src/content/report/evidence/evidence.json";
const files = [evidenceFile, "src/content/report/stories.mjs", "src/content/report/context.mjs"];

/** Exact file-based left join. Dates are keys, not fuzzy event associations. */
export function joinContextRows(observations, contextRecords) {
  return observations.toSorted((left, right) => left.date.localeCompare(right.date)).map((row) => {
    const matches = contextRecords.filter((record) => record.date === row.date);
    return { ...row, context: matches.length === 1 ? matches[0].text : "",
      contextId: matches.length === 1 ? matches[0].id : "" };
  });
}

export function createContextualStories(input, generatedAt = new Date().toISOString(), { id = randomUUID() } = {}) {
  const evidence = JSON.parse(input);
  assert.equal(evidence.fictional, true, "The example must disclose its fictional evidence");
  assert.deepEqual(evidence.cases.map((entry) => entry.id).toSorted(), contextualCases.map((entry) => entry.id).toSorted());
  const inputSha256 = sha256(input);
  const queries = {};
  const results = { inputSha256, cases: [] };
  for (const story of contextualCases) {
    const { observations, contextRecords } = evidence.cases.find((entry) => entry.id === story.id);
    assert.ok(observations.length >= 2 && observations.every((row) => exactDate(row.date)
      && Number.isFinite(row[story.valueField]) && row[story.valueField] >= 0));
    assert.equal(new Set(observations.map((row) => row.date)).size, observations.length, "Observation dates must be unique");
    assert.ok(contextRecords.every((record) => typeof record.id === "string" && record.id
      && exactDate(record.date) && typeof record.text === "string" && record.text.trim() && record.text.length <= 160
      && !/[\u0000-\u001f\u007f]/u.test(record.text)), "Context records need exact dates and bounded factual text");
    assert.equal(new Set(contextRecords.map((record) => record.id)).size, contextRecords.length, "Context record IDs must be unique");
    if (story.id === "adjustment") assert.ok(observations.every((row) => Number.isFinite(row.oneTimeAmount)
      && row.oneTimeAmount >= 0 && row.oneTimeAmount <= row[story.valueField]), "One-time amounts must reconcile to posted billings");
    if (story.id === "coverage") assert.ok(observations.every((row) => Number.isInteger(row.coveredLocations)
      && row.coveredLocations > 0), "Coverage needs a positive location count");
    const rows = joinContextRows(observations, contextRecords);
    const componentIds = [`context-${story.id}-answer`, `context-${story.id}-chart`];
    const queryText = `joinContextRows(evidence.cases.find(entry => entry.id === ${JSON.stringify(story.id)}).observations, `
      + `evidence.cases.find(entry => entry.id === ${JSON.stringify(story.id)}).contextRecords)`;
    const definition = (label, field, text) => ({ label, field, definition: text, componentIds,
      sourceLineage: [{ files }] });
    const recordText = contextRecords.map((record) => `${record.id} | ${record.date} | ${record.text}. ${record.detail ?? ""}`).join("\n");
    const metricDefinitions = [
      definition(story.title, story.valueField, `Recorded ${story.unit}. Values are fictional observations, not simulated intervention effects.`),
      definition("Observation date", "date", `Exact UTC ${story.period} date of the measurement.`),
      definition("Contextual record", "context", `Exact text joined from a fictional context record on its recorded date. Records: ${recordText || "None supplied."}`),
      definition("Context record ID", "contextId", "Stable identifier of the single matching context record. Empty when no unambiguous record matches."),
    ];
    if (story.id === "adjustment") metricDefinitions.push(definition("One-time billing amount (USD)", "oneTimeAmount",
      "Amount of the catch-up invoice included in that week's posted billings. Billings excluding the entry = postedBillingsUsd - oneTimeAmount. This is an accounting subtraction, not an estimate of business impact."));
    if (story.id === "coverage") metricDefinitions.push(definition("Monitored locations", "coveredLocations",
      "Number of locations whose detected incidents are included in that week's total. A change in this count changes the reporting population."));
    queries[story.queryId] = { label: story.title, reportingField: "date", rows, source: {
      label: `Fictional ${story.id} observations and context records`, files, metricDefinitions,
      query: { description: queryText, code: queryText },
      evidenceFlow: [
        { title: "Read fictional evidence", detail: `${evidenceFile}; SHA-256 ${inputSha256}. Observations and records were authored together for this example.` },
        { title: "Join exact dates", detail: `${queryText}. Preserve observation values. Join context text and record ID only for one exact date match. Missing or conflicting records leave the context empty. No SQL or external service is used.` },
        { title: "Context records", detail: recordText || "No contextual record supplied for this case." },
      ],
    } };
    const record = currentContext(story, rows);
    results.cases.push({ id: story.id, rowCount: rows.length, firstDate: rows[0].date, lastDate: rows.at(-1).date,
      contextRecordIds: contextRecords.map((entry) => entry.id), rowsSha256: sha256(JSON.stringify(rows)),
      ...(story.id === "adjustment" ? { withoutOneTime: rows.map((row) => ({ date: row.date, postedBillingsUsd: row.postedBillingsUsd - row.oneTimeAmount })) } : {}),
      annotationLabel: record?.context ?? null, annotationDate: record?.date ?? null });
  }
  const snapshot = { id, surface: "report", title: "Context that changes how you read the chart", generatedAt,
    status: "fixture", filters: [], queries,
    contextualStories: contextualCases.map((story) => ({ ...story,
      annotationLabel: results.cases.find((entry) => entry.id === story.id).annotationLabel })) };
  return { snapshot, results };
}

export function reproduceContextualStories(existing, input) {
  const { snapshot: reviewed, results } = createContextualStories(input, existing.generatedAt, { id: existing.id ?? randomUUID() });
  return { snapshot: { ...reviewed, ...existing, id: reviewed.id, queries: reviewed.queries, contextualStories: reviewed.contextualStories,
    ...(!existing.id && existing.title && !existing.legacyPresentationTitle ? { legacyPresentationTitle: existing.title } : {}) }, results };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const content = dirname(fileURLToPath(import.meta.url));
  const project = resolve(content, "../../..");
  if (content !== join(project, "src/content/report")) throw new Error("Run this reproducer in a generated report, or use contextual-stories/build.mjs.");
  const { snapshot, results } = reproduceContextualStories(JSON.parse(readFileSync(join(project, "src/data.json"), "utf8")),
    readFileSync(join(content, "evidence/evidence.json"), "utf8"));
  writeFileSync(join(project, "src/data.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(content, "evidence/story-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results));
}
