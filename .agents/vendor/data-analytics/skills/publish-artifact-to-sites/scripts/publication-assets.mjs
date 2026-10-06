import { createHash } from "node:crypto";
import { parseJsonBytes, stringifyJsonChunks } from "../../../templates/data-app/base/src/streaming-json.js";
import { createSemanticColorMetadataAccumulator } from "../../../templates/data-app/base/src/charting/chart-theme.js";
import { createDashboardFilterChoicesAccumulator } from "../../../templates/data-app/base/src/dashboard-url-state.js";
import { publicationSnapshotRows } from "./publication-snapshot-index.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
export const PUBLICATION_ASSET_DIRECTORY = ".data-app-assets";
export const OFFLINE_HTML_PATH = ".data-app-offline/index.html";
export const DEFERRED_BOOTSTRAP_VERSION = "deferred-content-v1";

// Scan tags without a repeated alternation over the entire inlined app bundle.
// Compiled dashboards can exceed the regular-expression engine's stack limit.
export function inspectDataAppDocument(html) {
  const rawTags = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);
  const values = (source, name) => {
    const matches = [];
    let position = 0;
    while (position < source.length) {
      while (/[\s=/>]/u.test(source[position] ?? "") && position < source.length) position += 1;
      const start = position;
      while (position < source.length && !/[\s=/>]/u.test(source[position])) position += 1;
      if (position === start) break;
      const selected = source.slice(start, position).toLowerCase() === name;
      while (position < source.length && /\s/u.test(source[position])) position += 1;
      let value = "";
      if (source[position] === "=") {
        position += 1;
        while (position < source.length && /\s/u.test(source[position])) position += 1;
        const quote = source[position];
        if (quote === '"' || quote === "'") {
          const start = ++position, end = source.indexOf(quote, start);
          position = end === -1 ? source.length : end;
          if (selected) value = source.slice(start, position);
          if (end !== -1) position += 1;
        } else {
          const start = position;
          while (position < source.length && !/[\s>]/u.test(source[position])) position += 1;
          if (selected) value = source.slice(start, position);
        }
      }
      if (selected) matches.push(value);
    }
    return matches;
  };
  const embedded = [], hashes = [], metadata = [], snapshotContinuations = [];
  let snapshotElement = null, headOpeningEnd = null;
  const headTags = new Set(["html", "head", "base", "basefont", "bgsound", "link", "meta"]);
  let inHead = false, headClosed = false, templates = 0, offset = 0, cursor = 0;
  const closeHead = () => { inHead = false; headClosed = true; };
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) break;
    if (html.startsWith("<!--", start)) {
      if (inHead && !templates && html.slice(offset, start).trim()) closeHead();
      const end = html.indexOf("-->", start + 4);
      cursor = offset = end === -1 ? html.length : end + 3;
      continue;
    }
    let position = start + 1;
    const closing = html[position] === "/";
    if (closing) position += 1;
    if (!/[a-z]/iu.test(html[position] ?? "")) { cursor = position + 1; continue; }
    const nameStart = position;
    while (/[a-z\d:-]/iu.test(html[position] ?? "")) position += 1;
    const name = html.slice(nameStart, position).toLowerCase(), attributeStart = position;
    let quote = null;
    for (; position < html.length; position += 1) {
      const character = html[position];
      if (quote) { if (character === quote) quote = null; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (position === html.length) break;
    const tagEnd = position + 1, source = html.slice(attributeStart, position);
    if (inHead && !templates && html.slice(offset, start).trim()) closeHead();
    cursor = offset = tagEnd;
    if (!closing && rawTags.has(name)) {
      const closingTag = new RegExp(`</${name}\\s*>`, "giu");
      closingTag.lastIndex = tagEnd;
      const end = closingTag.exec(html);
      const contentEnd = end?.index ?? html.length;
      cursor = offset = end ? end.index + end[0].length : html.length;
      if (inHead && !templates && !["script", "style", "title", "noscript", "noframes"].includes(name)) closeHead();
      if (!templates && name === "script") {
        const ids = values(source, "id");
        const continuations = values(source, "data-app-snapshot-chunk");
        if (continuations.length) {
          const types = values(source, "type");
          if (!snapshotElement || ids.length || continuations.length !== 1 || continuations[0] !== ""
            || types.length !== 1 || types[0].toLowerCase() !== "application/json" || !end) {
            throw new Error("The Data app snapshot continuation must be an unambiguous inert JSON script after its snapshot.");
          }
          snapshotContinuations.push({ start, end: cursor, contentStart: tagEnd, contentEnd });
        }
        if (ids.includes("data-app-reviewed-snapshot")) {
          if (ids.length !== 1) throw new Error("The embedded Data snapshot must have one unambiguous ID.");
          embedded.push(html.slice(tagEnd, contentEnd));
          snapshotElement = { contentStart: tagEnd, contentEnd };
        }
      }
      continue;
    }
    if (name === "template") { templates = Math.max(0, templates + (closing ? -1 : 1)); continue; }
    if (templates) continue;
    if (inHead && !headTags.has(name)) closeHead();
    if (name === "head") {
      if (closing) headClosed = true;
      inHead = !closing && !headClosed;
      if (inHead) headOpeningEnd = tagEnd;
    }
    if (name === "body") closeHead();
    if (name !== "meta" || closing || !inHead) continue;
    const names = values(source, "name").map((value) => value.toLowerCase());
    const contents = values(source, "content");
    metadata.push({ start, end: tagEnd, names, contents });
    const hash = names.length === 1 && contents.length === 1 ? contents[0].toLowerCase() : null;
    if (names.includes("data-app-snapshot-sha256")) hashes.push(hash);
  }
  if (embedded.length > 1) throw new Error("The Data app HTML must contain only one embedded snapshot.");
  return { embedded: embedded[0], hashes, snapshotElement, snapshotContinuations, metadata, headOpeningEnd };
}


export function documentSnapshot(html) {
  const { embedded, hashes, snapshotContinuations } = inspectDataAppDocument(html);
  return { embedded, hashes, ...(snapshotContinuations.length
    ? { snapshotChunks: [embedded, ...snapshotContinuations.map(({ contentStart, contentEnd }) => html.slice(contentStart, contentEnd))] }
    : {}) };
}

export function publicationUploadAuthorization(values, now = Date.now()) {
  const sha256 = values["deployment-token-sha256"], expiresAt = values["deployment-token-expires-at"];
  if (sha256 === undefined && expiresAt === undefined) return undefined;
  if (typeof sha256 !== "string" || !/^[a-f\d]{64}$/u.test(sha256)) {
    throw new Error("The deployment upload authorization must contain a lowercase SHA-256 digest; never pass a raw token.");
  }
  const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt || expiry <= now || expiry > now + 12 * 60 * 60 * 1000) {
    throw new Error("The deployment upload authorization expiry must be a canonical ISO timestamp within the next 12 hours.");
  }
  return { sha256, expiresAt };
}

function safeJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

// Hash the parsed seed in precisely JSON.stringify order without requiring a
// string containing the complete reviewed dataset. Whitespace-only source
// changes must retain the same stored query-edit generation.
export function snapshotSeedFingerprint(snapshot, indexedSnapshot) {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const chunk of indexedSnapshot ? indexedSnapshotChunks(snapshot, indexedSnapshot) : stringifyJsonChunks(snapshot)) {
    hash.update(chunk);
    bytes += Buffer.byteLength(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function snapshotBuffer(snapshot, indexedSnapshot) {
  const chunks = [];
  let pending = "";
  for (const chunk of indexedSnapshot ? indexedSnapshotChunks(snapshot, indexedSnapshot) : stringifyJsonChunks(snapshot)) {
    if (pending.length + chunk.length > 64 * 1024) { chunks.push(Buffer.from(pending, "utf8")); pending = ""; }
    pending += chunk;
  }
  if (pending) chunks.push(Buffer.from(pending, "utf8"));
  return Buffer.concat(chunks);
}

// The metadata parser retains object member order and last-key-wins semantics,
// but leaves query rows empty. Restore only one validated row while serializing.
// This reproduces canonical seed identity without retaining the full row graph.
export function* indexedSnapshotChunks(snapshot, { bytes, snapshotIndex }, { legacy = false, onRow = () => {} } = {}) {
  function* object(keys, value, entry) {
    yield "{";
    let first = true;
    for (const key of keys) {
      if (!first) yield ",";
      first = false;
      yield* stringifyJsonChunks(key);
      yield ":";
      yield* entry(key, value[key]);
    }
    yield "}";
  }
  function* rows(queryId) {
    yield "[";
    let first = true;
    for (const row of publicationSnapshotRows(bytes, snapshotIndex.queries[queryId].rows)) {
      if (!first) yield ",";
      first = false;
      yield* stringifyJsonChunks(parseJsonBytes(row, { fatal: true }));
      onRow();
    }
    yield "]";
  }
  function* query(queryId, definition) {
    const keys = Object.keys(definition);
    yield* object(legacy ? [...keys.filter(key => key !== "rows"), "rows"] : keys, definition,
      (key, value) => key === "rows" ? rows(queryId) : stringifyJsonChunks(value));
  }
  const keys = Object.keys(snapshot);
  yield* object(legacy ? [...keys.filter(key => key !== "queries"), "queries"] : keys, snapshot,
    (key, value) => key === "queries" ? object(Object.keys(value), value, query) : stringifyJsonChunks(value));
}

// API JSON encodes non-finite numbers as null. Match that eager representation
// before deriving String-valued filter choices, including nested array cells.
function normalizeJsonNumbers(row) {
  const pending = [row];
  while (pending.length) {
    const value = pending.pop();
    for (const [key, cell] of Object.entries(value)) {
      if (typeof cell === "number" && !Number.isFinite(cell)) value[key] = null;
      else if (cell !== null && typeof cell === "object") pending.push(cell);
    }
  }
  return row;
}

function queryLoadingBootstrap(seedSnapshot, { bytes, snapshotIndex }, snapshotSha256) {
  if (snapshotIndex.sha256 !== snapshotSha256 || snapshotIndex.bytes !== bytes.length
    || Object.keys(seedSnapshot.queries).length !== Object.keys(snapshotIndex.queries).length
    || Object.keys(seedSnapshot.queries).some(id => !Object.hasOwn(snapshotIndex.queries, id))) {
    throw new Error("On-demand query loading requires the complete index of its verified snapshot.");
  }
  if (Object.hasOwn(seedSnapshot, "_dataAppQueryLoading")) {
    throw new Error("The reviewed snapshot already contains reserved query-loading metadata.");
  }
  const colors = createSemanticColorMetadataAccumulator();
  const filterChoices = createDashboardFilterChoicesAccumulator(seedSnapshot.filters ?? []);
  const queries = [], queryMetadata = [];
  for (const [queryId, query] of Object.entries(seedSnapshot.queries)) {
    const definition = { ...query };
    delete definition.rows;
    const columns = new Set();
    let rowCount = 0;
    function* rows() {
      for (const rowBytes of publicationSnapshotRows(bytes, snapshotIndex.queries[queryId]?.rows)) {
        const row = normalizeJsonNumbers(parseJsonBytes(rowBytes, { fatal: true }));
        rowCount += 1;
        for (const key of Object.keys(row)) columns.add(key);
        filterChoices.addRow(queryId, row);
        yield row;
      }
    }
    colors.addQuery(rows(), query.payloadColumns);
    queries.push([queryId, definition]);
    queryMetadata.push([queryId, { rowCount, columns: [...columns] }]);
  }
  return { ...seedSnapshot, queries: Object.fromEntries(queries), _dataAppQueryLoading: {
    version: 1, snapshotSha256, queries: Object.fromEntries(queryMetadata),
    colors: colors.finish(), filterChoices: filterChoices.finish(),
  } };
}

export function createPublicationAssets({ html, seedSnapshot, projectId, snapshotBytes, indexedSnapshot, separateData = false, queryLoading }) {
  if (queryLoading !== undefined && queryLoading !== "on-demand") {
    throw new Error("Unsupported query loading option; use --query-loading on-demand.");
  }
  if (snapshotBytes !== undefined && !separateData) {
    throw new Error("Raw snapshot bytes require a verified separate-data build.");
  }
  if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(projectId)) {
    throw new Error("The Sites project ID must contain only letters, digits, underscores, or hyphens.");
  }
  if (!seedSnapshot || typeof seedSnapshot !== "object" || Array.isArray(seedSnapshot)) {
    throw new Error("The reviewed Data app snapshot must be a JSON object.");
  }
  const inspection = inspectDataAppDocument(html);
  const named = name => inspection.metadata.filter(meta => meta.names.includes(name));
  const layout = named("data-app-build-layout");
  if (named("data-app-local-snapshot").length && !separateData) {
    throw new Error("A separate Data app requires its verified complete build manifest and snapshot.");
  }
  if (layout.length && (!separateData || layout.length !== 1 || layout[0].names.length !== 1
    || layout[0].contents.length !== 1 || layout[0].contents[0] !== "separate-data-v1")) {
    throw new Error("A separate Data app requires its verified complete build manifest and snapshot.");
  }
  if (separateData && (!layout.length || !Buffer.isBuffer(snapshotBytes))) {
    throw new Error("A separate Data app requires its verified complete build manifest and snapshot.");
  }
  if (named("data-app-snapshot-storage").length) {
    throw new Error("The hosted Data app requires its verified full offline original. Restore the publication manifest or rebuild before packaging.");
  }
  const bootstrap = named("data-app-bootstrap");
  if (bootstrap.length > 1 || bootstrap.some(meta => meta.names.length !== 1 || meta.contents.length !== 1)) {
    throw new Error("The Data app bootstrap metadata must be unambiguous.");
  }
  const thinBootstrap = bootstrap[0]?.contents[0] === DEFERRED_BOOTSTRAP_VERSION;
  if (thinBootstrap && !inspection.snapshotElement) {
    throw new Error("A deferred Data app bootstrap must contain its reviewed snapshot element.");
  }
  if (queryLoading && (!separateData || !thinBootstrap || !indexedSnapshot
    || indexedSnapshot.bytes !== snapshotBytes)) {
    throw new Error("On-demand query loading requires a verified separate-data build with a deferred bootstrap and matching snapshot index.");
  }
  const siteMarkers = named("data-app-sites-project");
  if (siteMarkers.length > 1 || siteMarkers.some(meta => meta.names.length !== 1 || meta.contents.length !== 1 || meta.contents[0] !== projectId)) {
    throw new Error("The compiled Data app Site identity conflicts with the selected project.");
  }
  const edits = inspection.metadata.filter(meta => meta.names.some(name => ["data-app-local-thread", "data-app-local-reference", "data-app-build-layout", "data-app-local-snapshot"].includes(name)))
    .map(meta => ({ start: meta.start, end: meta.end, text: "" }));
  if (thinBootstrap) {
    const { contentStart, contentEnd } = inspection.snapshotElement;
    edits.push({ start: contentStart, end: contentEnd, text: safeJson(queryLoading
      ? queryLoadingBootstrap(seedSnapshot, indexedSnapshot, digest(snapshotBytes))
      : { id: seedSnapshot.id, title: seedSnapshot.title, surface: seedSnapshot.surface ?? "dashboard", queries: {} }) });
    edits.push({ start: inspection.headOpeningEnd, end: inspection.headOpeningEnd, text: '<meta name="data-app-snapshot-storage" content="external-v1">' });
    for (const { start, end } of inspection.snapshotContinuations) edits.push({ start, end, text: "" });
  }
  if (!siteMarkers.length && inspection.headOpeningEnd !== null) {
    edits.push({ start: inspection.headOpeningEnd, end: inspection.headOpeningEnd, text: `<meta name="data-app-sites-project" content="${projectId}">` });
  }
  const parts = [];
  let offset = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (edit.start < offset) throw new Error("The Data app contains overlapping publication metadata.");
    parts.push(html.slice(offset, edit.start), edit.text);
    offset = edit.end;
  }
  parts.push(html.slice(offset));
  const bytes = { html: Buffer.from(parts.join(""), "utf8"), snapshot: snapshotBytes ?? snapshotBuffer(seedSnapshot, indexedSnapshot) };
  const deploymentAssets = Object.fromEntries(Object.entries(bytes).map(([kind, content]) => {
    const sha256 = digest(content);
    return [kind, { key: `data-app/${kind}/${sha256}`, sha256, bytes: content.byteLength }];
  }));
  return { bytes, deploymentAssets, thinBootstrap, ...(queryLoading ? { queryLoading } : {}) };
}

export function externalizeSourceWorker(workerSource, deploymentAssets, deploymentUploadAuthorization) {
  let source = workerSource;
  const replaceOnce = (pattern, replacement) => {
    const matches = [...source.matchAll(pattern)];
    if (matches.length !== 1) throw new Error("Source publication requires the canonical HTML/snapshot factory bindings; custom Worker code must preserve that contract.");
    source = source.slice(0, matches[0].index) + replacement + source.slice(matches[0].index + matches[0][0].length);
  };
  replaceOnce(/^import\s+dataAppHtml\s+from\s+["']\.\.\/dist\/index\.html\?raw["'];?\s*$/gmu, "");
  replaceOnce(/^import\s+seedSnapshot\s+from\s+["']\.\/data\.json["'];?\s*$/gmu, "");
  const expression = value => `JSON.parse(${JSON.stringify(JSON.stringify(value))})`;
  replaceOnce(/\bhtml\s*:\s*dataAppHtml\s*,/gu, `deploymentAssets: ${expression(deploymentAssets)},${deploymentUploadAuthorization ? `\n  deploymentUploadAuthorization: ${expression(deploymentUploadAuthorization)},` : ""}`);
  replaceOnce(/\bseedSnapshot\s*,/gu, "");
  if (/\b(?:dataAppHtml|seedSnapshot)\b/u.test(source)) {
    throw new Error("The custom source Worker uses HTML or snapshot bindings outside the supported factory. No source was changed.");
  }
  return source;
}

export function snapshotResponseFingerprint(snapshot, indexedSnapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !snapshot.queries || typeof snapshot.queries !== "object" || Array.isArray(snapshot.queries)) {
    throw new Error("The reviewed snapshot must contain a queries object.");
  }
  const hash = createHash("sha256");
  let bytes = 0, rowCount = 0, queryCount = 0;
  const append = text => { hash.update(text); bytes += Buffer.byteLength(text); };
  if (indexedSnapshot) {
    for (const chunk of indexedSnapshotChunks(snapshot, indexedSnapshot, { legacy: true, onRow: () => { rowCount += 1; } })) append(chunk);
    return { sha256: hash.digest("hex"), bytes, rowCount, queryCount: Object.keys(snapshot.queries).length };
  }
  const appendJson = value => { for (const chunk of stringifyJsonChunks(value)) append(chunk); };
  const prefix = object => {
    // Defer only the final chunk so the closing brace can become a comma.
    let pending = "", length = 0;
    for (const chunk of stringifyJsonChunks(object)) {
      if (pending) append(pending);
      pending = chunk;
      length += chunk.length;
    }
    append(pending.slice(0, -1));
    if (length > 2) append(",");
  };
  const { queries, ...metadata } = snapshot;
  prefix(metadata);
  append('"queries":{');
  for (const [queryId, query] of Object.entries(queries)) {
    if (!query || typeof query !== "object" || Array.isArray(query)) throw new Error("Each reviewed query must be an object.");
    const { rows = [], ...definition } = query;
    if (!Array.isArray(rows)) throw new Error("Reviewed query rows must be an array.");
    if (queryCount) append(",");
    appendJson(queryId);
    append(":");
    prefix(definition);
    append('"rows":[');
    rows.forEach((row, index) => { if (index) append(","); appendJson(row); rowCount += 1; });
    append("]}");
    queryCount += 1;
  }
  append("}}");
  return { sha256: hash.digest("hex"), bytes, queryCount, rowCount };
}
