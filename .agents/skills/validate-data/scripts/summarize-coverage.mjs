import fs from "node:fs";
import { pathToFileURL } from "node:url";

const kinds = new Set(["component", "claim", "question", "comparison", "control"]);
const states = new Set(["unverified", "passed", "failed"]);
const nonempty = value => typeof value === "string" && value.trim().length > 0;
const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

// Counts declared observations. This cannot establish their truth or inventory completeness.
export function summarizeCoverage(record) {
  requireValue(record?.version === 1, "Expected coverage version 1.");
  requireValue(nonempty(record.artifact?.identity) && nonempty(record.artifact?.revision)
    && nonempty(record.artifact?.view), "Record artifact identity, revision and reviewed view.");
  requireValue(Array.isArray(record.categories) && record.categories.length > 0
    && Array.isArray(record.units), "Categories and units are required.");
  const rows = new Map();
  for (const category of record.categories) {
    requireValue(nonempty(category?.id) && nonempty(category.label)
      && !rows.has(category.id) && typeof category.applicable === "boolean",
    "Categories need unique IDs, labels and explicit applicability.");
    requireValue(category.applicable || nonempty(category.reason), "N/A categories need a reason.");
    requireValue(category.inventoryComplete === undefined || typeof category.inventoryComplete === "boolean",
      "Category inventoryComplete must be a boolean when provided.");
    requireValue(category.inventoryComplete !== false || nonempty(category.reason),
      `Category ${category.id} needs a reason for its incomplete inventory.`);
    rows.set(category.id, { id: category.id, label: category.label,
      applicable: category.applicable, reason: category.reason ?? null,
      inventoryComplete: category.inventoryComplete ?? true,
      total: 0, checked: 0, passed: 0, knownDefectsRemaining: 0, unverified: 0,
      fixedAndVerified: 0, uncheckedUnits: [] });
  }
  const seenUnits = new Set();
  for (const unit of record.units) {
    requireValue(nonempty(unit?.id) && nonempty(unit.label) && !seenUnits.has(unit.id)
      && kinds.has(unit.kind) && nonempty(unit.revision), "Invalid or duplicate inventory unit.");
    seenUnits.add(unit.id);
    requireValue(unit.categories && typeof unit.categories === "object"
      && !Array.isArray(unit.categories) && Object.keys(unit.categories).length > 0,
    `Unit ${unit.id} needs applicable category checks.`);
    for (const [categoryId, assessment] of Object.entries(unit.categories)) {
      const row = rows.get(categoryId);
      requireValue(row?.applicable, `Unit ${unit.id} uses an unknown or N/A category.`);
      requireValue(Array.isArray(assessment?.checks) && Array.isArray(assessment.findings),
        `Unit ${unit.id}/${categoryId} needs checks and findings arrays.`);
      const seenChecks = new Set();
      const currentPasses = new Set();
      const demonstratedFailures = new Set();
      let completed = assessment.checks.length > 0;
      let failed = false;
      for (const check of assessment.checks) {
        requireValue(nonempty(check?.id) && !seenChecks.has(check.id) && states.has(check.state),
          `Invalid or duplicate check on ${unit.id}/${categoryId}.`);
        seenChecks.add(check.id);
        requireValue(Array.isArray(check.evidence) && check.evidence.every(nonempty),
          "Check evidence must be an array of nonempty references.");
        if (check.state !== "unverified") {
          requireValue(nonempty(check.revision) && check.evidence.length > 0,
            "A passed or failed check requires a revision and evidence.");
        }
        const current = check.revision === unit.revision;
        if (current && check.state === "passed") currentPasses.add(check.id);
        completed &&= current && check.state !== "unverified";
        // A demonstrated failure stays visible until a later verified repair resolves it.
        failed ||= check.state === "failed";
        if (check.state === "failed") demonstratedFailures.add(check.id);
      }
      const seenFindings = new Set();
      let open = false;
      let fixed = false;
      for (const finding of assessment.findings) {
        requireValue(nonempty(finding?.id) && !seenFindings.has(finding.id)
          && ["open", "fixed"].includes(finding.status), "Invalid or duplicate finding.");
        seenFindings.add(finding.id);
        if (finding.status === "fixed") {
          requireValue(Array.isArray(finding.checkIds) && finding.checkIds.length > 0
            && new Set(finding.checkIds).size === finding.checkIds.length
            && finding.checkIds.every(id => currentPasses.has(id)),
          `Fixed findings on ${unit.id}/${categoryId} need current passing checks for their affected result.`);
        } else {
          const linkedFailure = Array.isArray(finding.checkIds) && finding.checkIds.length > 0
            && new Set(finding.checkIds).size === finding.checkIds.length
            && finding.checkIds.every(id => demonstratedFailures.has(id));
          const directEvidence = nonempty(finding.revision) && Array.isArray(finding.evidence)
            && finding.evidence.length > 0 && finding.evidence.every(nonempty);
          requireValue(linkedFailure || directEvidence,
            `Open findings on ${unit.id}/${categoryId} need linked evidenced failed checks or their own revision and evidence.`);
        }
        open ||= finding.status === "open";
        fixed ||= finding.status === "fixed";
      }
      row.total += 1;
      row.checked += Number(completed);
      row.passed += Number(completed && !failed && !open);
      row.knownDefectsRemaining += Number(failed || open);
      row.fixedAndVerified += Number(fixed);
      if (!completed) {
        row.unverified += 1;
        row.uncheckedUnits.push({ id: unit.id, label: unit.label });
      }
    }
  }
  for (const row of rows.values()) {
    requireValue(!row.applicable || !row.inventoryComplete || row.total > 0,
      `Applicable category ${row.id} has no inventoried units; inventory it or mark N/A with a reason.`);
  }
  const categories = [...rows.values()].map(row => row.applicable ? {
    ...row, observedDefects: `${row.knownDefectsRemaining} / ${row.inventoryComplete ? row.total : "unknown"}`,
  } : {
    id: row.id, label: row.label, applicable: false, reason: row.reason, observedDefects: "N/A",
  });
  return { artifact: record.artifact,
    completeness: categories.some(row => row.applicable && (!row.inventoryComplete || row.unverified > 0)) ? "Partial" : "Complete",
    categories };
}

// Project the public table without treating missing observations as successful checks.
export function projectScorecard(record) {
  const summary = summarizeCoverage(record);
  const descriptions = new Map(record.categories.map(category => [category.id, category.assessment]));
  return summary.categories.map(row => {
    const description = descriptions.get(row.id);
    requireValue(!row.applicable || nonempty(description),
      `Category ${row.id} needs an evidence-backed assessment for the public scorecard.`);
    const assessment = [];
    if (nonempty(description)) assessment.push(description.trim());
    if (!row.applicable) assessment.push(`Not applicable: ${row.reason}`);
    if (row.applicable && !row.inventoryComplete) {
      assessment.push(`Inventory incomplete: ${row.reason} Total applicable items is unknown.`);
    }
    if (row.unverified > 0) {
      const names = row.uncheckedUnits.slice(0, 3).map(unit => unit.label).join("; ");
      const remainder = row.unverified > 3 ? `; and ${row.unverified - 3} more (see review notes)` : "";
      assessment.push(`Partial review: ${row.unverified} scoped ${row.unverified === 1 ? "item has" : "items have"} incomplete or stale evidence (${names}${remainder}).`);
    }
    return { category: row.label, observedDefects: row.observedDefects,
      assessment: assessment.join(" ") };
  });
}

export function renderScorecard(record) {
  const cell = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  return ["| Category | Observed defects | Assessment |",
    "|---|---|---|",
    ...projectScorecard(record).map(row =>
      `| ${cell(row.category)} | ${row.observedDefects} | ${cell(row.assessment)} |`),
  ].join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const scorecard = args.includes("--scorecard");
    const files = args.filter(arg => arg !== "--scorecard");
    requireValue(files.length === 1 && args.length === (scorecard ? 2 : 1)
      && !files[0].startsWith("--"), "Usage: node summarize-coverage.mjs [--scorecard] <coverage.json>");
    const record = JSON.parse(fs.readFileSync(files[0], "utf8"));
    process.stdout.write(`${scorecard ? renderScorecard(record) : JSON.stringify(summarizeCoverage(record), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
