import {
  assertDisclosedSourceText,
  assertJson,
  MAX_INLINE_INPUT_BYTES,
  MAX_INLINE_ROWS,
  sourceForInput,
} from "./inline-chart-input.mjs";
import { receiptSourceEntries, reviewedSource, safeSourceHref } from "../../../templates/data-app/base/src/source-provenance.js";

export const MAX_RECEIPT_ITEMS = 20;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const privateField = /(?:^|_)(?:e_*mail|phone|ssn|password|passwd|secret|token|authorization|api_key|credit_card|card_number|account_number)(?:_|$)/iu;

function fail(message) {
  throw new Error(`Invalid inline sources: ${message}`);
}

function record(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}

function text(value, name, max = 2_000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`${name} must be nonempty text of at most ${max} characters.`);
  return value.trim();
}

function identifier(value, name) {
  const id = text(value, name, 100);
  if (!idPattern.test(id)) fail(`${name} must be a lowercase hyphenated identifier.`);
  return id;
}

function timestamp(value, name) {
  const result = text(value, name, 100);
  const match = /^(\d{4})-(\d\d)-(\d\d)T.*(?:Z|[+-]\d\d:\d\d)$/u.exec(result);
  const [year, month, day] = match?.slice(1).map(Number) ?? [];
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!match || !Number.isFinite(Date.parse(result)) || !(day >= 1 && day <= daysInMonth))
    fail(`${name} must be a recorded ISO timestamp with a valid calendar date and its timezone.`);
  return result;
}

function methodSourceText({ language, code }) {
  if (language !== "python") return code;
  // Scan exact string literals and comments for unsafe URLs, but do not treat
  // Python's unquoted floor-division operator as a protocol-relative URL.
  // This is only a validation view; the recorded code is never rewritten.
  return code.replace(/'''(?:\\[\s\S]|(?!''')[^\\])*'''|"""(?:\\[\s\S]|(?!""")[^\\])*"""|'(?:\\[\s\S]|[^'\\\r\n])*'|"(?:\\[\s\S]|[^"\\\r\n])*"|#[^\r\n]*|(?:\b[a-z][a-z\d+.-]*:)?\/\//giu,
    (token) => token === "//" ? " / " : token);
}

// Only inspect the projected receipt, never excluded tool-output extensions.
// This supplements field projection; it does not certify arbitrary text as safe.
function assertSafeEvidence(value) {
  if (typeof value === "string") {
    if (/\b(?:Bearer\s+[a-z\d._-]{12,}|sk-[a-z\d_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(value)
      || /\b(?:password|passwd|api[_-]?key|access[_-]?token|secret)\s*[=:]\s*["'][^"']+["']/iu.test(value)
      || /\b[a-z][a-z\d+.-]*:\/\/[^\s/]+:[^\s/]+@/iu.test(value))
      fail("projected evidence contains credentials; provide a reviewed, redacted source.");
  } else if (Array.isArray(value)) value.forEach(assertSafeEvidence);
  else if (value && typeof value === "object") Object.values(value).forEach(assertSafeEvidence);
}

function methodsForInput(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2) fail("methods must contain at most Python and calculation records.");
  const languages = new Set();
  return value.map((method) => {
    record(method, "method");
    if (!["python", "calculation"].includes(method.language) || languages.has(method.language))
      fail("each recorded method must have a unique python or calculation language.");
    languages.add(method.language);
    text(method.code, "method.code", 100_000);
    // Preserve exact recorded code, including whitespace; never execute it.
    return { language: method.language, code: method.code };
  });
}

function sourceRolesForInput(value, source) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 40) fail("sourceRoles must be an array of at most 40 source roles.");
  const identities = receiptSourceEntries(reviewedSource(source));
  const seen = new Set();
  return value.map((entry) => {
    record(entry, "sourceRole");
    const label = text(entry.label, "sourceRole.label", 500);
    const role = text(entry.role, "sourceRole.role", 1_000);
    const href = entry.href === undefined ? undefined : safeSourceHref(entry.href);
    if (entry.href !== undefined && !href) fail("sourceRole.href must be a safe source URL.");
    const matching = identities.filter((identity) => identity.kind === entry.kind && identity.label === label
      && (href === undefined || identity.href === href));
    if (matching.length !== 1) fail("each sourceRole must identify exactly one source in its own query.");
    const identity = matching[0];
    const key = JSON.stringify([identity.kind, identity.label, identity.href ?? null]);
    if (seen.has(key)) fail("sourceRoles must not repeat a source identity within a query.");
    seen.add(key);
    return { kind: identity.kind, label: identity.label, ...(identity.href ? { href: identity.href } : {}), role };
  });
}

function assumptionsForInput(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 20)
    fail("item.assumptions must be an array of at most 20 material assumptions.");
  return [...new Set(value.map((entry) => text(entry, "item.assumptions entry")))];
}

function previewForInput(query, rows) {
  if (query.preview === undefined) return undefined;
  const preview = record(query.preview, "preview");
  if (rows === undefined) fail("preview metadata requires recorded rows.");
  if (!["sample", "partial", "aggregate"].includes(preview.kind))
    fail("preview.kind must be sample, partial, or aggregate.");
  const note = text(preview.note, "preview.note");
  if (preview.totalRows !== undefined && (!Number.isSafeInteger(preview.totalRows) || preview.totalRows < rows.length))
    fail("preview.totalRows must be a recorded count no smaller than the preview.");
  return { kind: preview.kind, note, ...(preview.totalRows !== undefined ? { totalRows: preview.totalRows } : {}) };
}

function columnsForInput(query) {
  if (query.rows === undefined) {
    if (query.columns !== undefined) fail("columns require recorded rows.");
    return undefined;
  }
  if (!Array.isArray(query.columns) || !query.columns.length || query.columns.length > 80)
    fail("recorded rows require 1–80 explicitly approved preview columns.");
  const columns = query.columns.map((column) => {
    if (typeof column === "string") return { field: text(column, "preview column", 200) };
    record(column, "preview column");
    return { field: text(column.field, "preview column.field", 200),
      ...(column.label !== undefined ? { label: text(column.label, "preview column.label", 200) } : {}) };
  });
  if (new Set(columns.map(({ field }) => field)).size !== columns.length) fail("preview columns must be unique.");
  for (const { field } of columns) {
    const normalized = field.replace(/([a-z\d])([A-Z])/gu, "$1_$2").replace(/[^a-z\d]/giu, "_");
    if (privateField.test(normalized)) fail("preview columns must omit credentials and direct contact/payment identifiers.");
  }
  return columns;
}

function rowsForInput(query, columnDefinitions) {
  if (query.rows === undefined) return undefined;
  if (!Array.isArray(query.rows) || query.rows.length > MAX_INLINE_ROWS)
    fail(`rows must be an array of at most ${MAX_INLINE_ROWS} recorded rows.`);
  const columns = columnDefinitions.map(({ field }) => field);
  const rows = query.rows.map((row) => {
    record(row, "row");
    return Object.fromEntries(columns.filter((field) => Object.hasOwn(row, field)).map((field) => {
      const value = row[field];
      if (value !== null && !["string", "number", "boolean"].includes(typeof value))
        fail("preview cells must be scalar recorded values.");
      return [field, value];
    }));
  });
  if (rows.length && columns.some((field) => !rows.some((row) => Object.hasOwn(row, field))))
    fail("an approved preview column is missing from the recorded rows.");
  return rows;
}

/** A card owns its queries, so shared query IDs cannot leak another finding's scope. */
export function normalizeInlineSourcesInput(input) {
  record(input, "input");
  assertJson(input);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_INLINE_INPUT_BYTES) fail("input exceeds 2 MB.");
  if (input.schemaVersion !== 1) fail("schemaVersion must be 1.");
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > MAX_RECEIPT_ITEMS)
    fail(`items must contain 1–${MAX_RECEIPT_ITEMS} evidence-backed answer cards.`);
  const itemIds = new Set();
  let totalRows = 0;
  const items = input.items.map((item) => {
    record(item, "item");
    const id = identifier(item.id, "item.id");
    if (itemIds.has(id)) fail("item IDs must be unique.");
    itemIds.add(id);
    const title = text(item.title, "item.title", 500);
    const description = item.description === undefined ? undefined : text(item.description, "item.description");
    if (!Array.isArray(item.queries) || !item.queries.length || item.queries.length > 10)
      fail("each item requires 1–10 recorded queries or source snapshots.");
    const queryIds = new Set();
    const queries = item.queries.map((query) => {
      record(query, "query");
      const queryId = identifier(query.id, "query.id");
      if (queryIds.has(queryId)) fail("query IDs must be unique within each card.");
      queryIds.add(queryId);
      const columns = columnsForInput(query);
      const rows = rowsForInput(query, columns);
      totalRows += rows?.length ?? 0;
      if (totalRows > MAX_INLINE_ROWS) fail(`the complete receipt exceeds ${MAX_INLINE_ROWS} preview rows.`);
      const source = sourceForInput(query.source, { id, title, description }, {
        includeSql: true, includeSourceUrls: true, displayedFields: columns?.map(({ field }) => field) ?? [], scopeToFields: false,
      });
      if (source.executedAt) source.executedAt = timestamp(source.executedAt, "source.executedAt");
      // The receipt must display the exact recorded query, not a trimmed rewrite.
      const rawSql = query.source.sql ?? query.source.query?.sql;
      if (source.sql) source.sql = rawSql;
      const methods = methodsForInput(query.methods);
      const sourceRoles = sourceRolesForInput(query.sourceRoles, source);
      const preview = previewForInput(query, rows);
      return {
        id: queryId, source,
        ...(query.summary !== undefined ? { summary: text(query.summary, "query.summary") } : {}),
        ...(sourceRoles?.length ? { sourceRoles } : {}),
        ...(rows !== undefined ? { rows, columns } : {}),
        ...(methods.length ? { methods } : {}),
        ...(preview ? { preview } : {}),
        ...(query.reportingPeriod !== undefined ? { reportingPeriod: text(query.reportingPeriod, "reportingPeriod", 500) } : {}),
        ...(query.capturedAt !== undefined ? { capturedAt: timestamp(query.capturedAt, "capturedAt") } : {}),
      };
    });
    if (item.confidence !== undefined) fail("item.confidence is not supported in inline Sources receipts.");
    const assumptions = assumptionsForInput(item.assumptions);
    return { id, title, ...(description ? { description } : {}),
      ...(assumptions?.length ? { assumptions } : {}), queries };
  });
  const normalized = {
    schemaVersion: 1, kind: "sources", items,
    theme: identifier(input.theme ?? "codex-classic", "theme"),
  };
  assertDisclosedSourceText({ ...normalized, items: items.map((item) => ({ ...item,
    queries: item.queries.map((query) => ({ ...query,
      methods: query.methods?.map((method) => ({ ...method, code: methodSourceText(method) })),
    })),
  })) }, true);
  assertSafeEvidence(normalized);
  return normalized;
}
