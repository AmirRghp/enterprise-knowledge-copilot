import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { parseJsonBytes } from "../../../templates/data-app/base/src/streaming-json.js";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const invalid = () => new Error("The reviewed snapshot must contain valid UTF-8 JSON, object queries, and arrays of object rows.");
const isWhitespace = byte => byte === 32 || byte === 9 || byte === 10 || byte === 13;

// Iterate one row at a time from an already validated index. Retain byte spans
// only for the active row; an array with millions of rows needs no offset list.
export function* publicationSnapshotRows(bytes, range) {
  if (!range) return;
  let cursor = range[0] + 1;
  const end = range[1] - 1;
  while (cursor < end) {
    while (isWhitespace(bytes[cursor]) || bytes[cursor] === 44) cursor += 1;
    if (cursor >= end) break;
    const start = cursor;
    if (bytes[cursor] !== 123) throw invalid();
    let depth = 0, string = false, escaped = false;
    for (; cursor < end; cursor += 1) {
      const byte = bytes[cursor];
      if (string) {
        if (escaped) escaped = false;
        else if (byte === 92) escaped = true;
        else if (byte === 34) string = false;
      } else if (byte === 34) string = true;
      else if (byte === 123 || byte === 91) depth += 1;
      else if (byte === 125 || byte === 93) {
        depth -= 1;
        if (!depth) { cursor += 1; break; }
      }
    }
    if (depth || string) throw invalid();
    yield bytes.subarray(start, cursor);
  }
}

// Record byte spans, not a second copy of the snapshot's rows. Only root,
// queries, and query objects retain member information; all other nesting is
// visited with an explicit stack. Maps preserve JSON's last-key-wins behavior.
export function createPublicationSnapshotIndex(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!isUtf8(bytes)) throw invalid();
  let cursor = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0, root;
  const stack = [], replacements = [];
  const whitespace = () => {
    while (isWhitespace(bytes[cursor])) cursor += 1;
  };
  function stringEnd() {
    if (bytes[cursor++] !== 34) throw invalid();
    while (cursor < bytes.length) {
      const character = bytes[cursor++];
      if (character === 34) return cursor;
      if (character < 32) throw invalid();
      if (character === 92) {
        const escaped = bytes[cursor++];
        if (escaped === 117) {
          for (let i = 0; i < 4; i += 1) {
            const hex = bytes[cursor++];
            if (!(hex >= 48 && hex <= 57 || hex >= 65 && hex <= 70 || hex >= 97 && hex <= 102)) throw invalid();
          }
        } else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(escaped)) throw invalid();
      }
    }
    throw invalid();
  }
  function complete(value) {
    const parent = stack.at(-1);
    if (!parent) { root = value; return; }
    parent.count += 1;
    parent.state = 4;
    if (parent.scope === "root" && (parent.key === "queries" || parent.key === "generatedAt")) parent.members.set(parent.key, value);
    if (parent.scope === "queries") parent.members.set(parent.key, value);
    if (parent.scope === "query" && parent.key === "rows") parent.rows = value;
    if (parent.scope === "query" && parent.key === "source") parent.source = value;
    if (parent.scope === "source" && parent.key === "executedAt") parent.executedAt = value;
    if (parent.scope === "rows" && value.type !== "object") parent.objectRows = false;
  }
  function close() {
    const frame = stack.pop();
    const value = { type: frame.type, start: frame.start, end: ++cursor };
    if (frame.scope === "root" || frame.scope === "queries") value.members = frame.members;
    if (frame.scope === "query") { value.rows = frame.rows; value.source = frame.source; value.empty = frame.count === 0; }
    if (frame.scope === "source") { value.executedAt = frame.executedAt; value.empty = frame.count === 0; }
    if (frame.scope === "rows") { value.rowCount = frame.count; value.objectRows = frame.objectRows; }
    complete(value);
  }
  while (true) {
    whitespace();
    const frame = stack.at(-1);
    if (!frame && root) break;
    if (frame) {
      const closing = frame.type === "object" ? 125 : 93;
      if (frame.state === 4) {
        if (bytes[cursor] === closing) { close(); continue; }
        if (bytes[cursor++] !== 44) throw invalid();
        frame.state = 1;
        continue;
      }
      if (frame.state === 0 && bytes[cursor] === closing) { close(); continue; }
      if (frame.type === "object" && frame.state !== 3) {
        const start = cursor, end = stringEnd();
        frame.key = frame.scope ? parseJsonBytes(bytes.subarray(start, end), { fatal: true }) : null;
        whitespace();
        if (bytes[cursor++] !== 58) throw invalid();
        frame.state = 3;
        continue;
      }
    }
    const start = cursor, character = bytes[cursor];
    if (character === 123 || character === 91) {
      const type = character === 123 ? "object" : "array";
      let scope = null;
      if (!frame && type === "object") scope = "root";
      else if (frame?.scope === "root" && frame.key === "queries" && type === "object") scope = "queries";
      else if (frame?.scope === "queries" && type === "object") scope = "query";
      else if (frame?.scope === "query" && frame.key === "rows" && type === "array") scope = "rows";
      else if (frame?.scope === "query" && frame.key === "source" && type === "object") scope = "source";
      stack.push({ type, scope, start, state: 0, count: 0, objectRows: true,
        ...(scope === "root" || scope === "queries" ? { members: new Map() } : {}) });
      cursor += 1;
      continue;
    }
    let type;
    if (character === 34) { stringEnd(); type = "string"; }
    else if (character === 116 || character === 102 || character === 110) {
      const word = character === 116 ? "true" : character === 102 ? "false" : "null";
      if (bytes.toString("ascii", cursor, cursor + word.length) !== word) throw invalid();
      cursor += word.length;
      type = word === "null" ? "null" : "boolean";
    } else {
      while (cursor < bytes.length && !isWhitespace(bytes[cursor]) && bytes[cursor] !== 44 && bytes[cursor] !== 93 && bytes[cursor] !== 125) cursor += 1;
      let value;
      // Native conversion is inexpensive for bounded scalar tokens. A single
      // decimal spelling may itself span windows, so never decode an unbounded
      // token even though the index retains only its normalized numeric value.
      if (cursor - start <= 64 * 1024) {
        const token = bytes.toString("ascii", start, cursor);
        if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(token)) throw invalid();
        value = Number(token);
      } else {
        try { value = parseJsonBytes(bytes.subarray(start, cursor), { fatal: true }); }
        catch { throw invalid(); }
        if (typeof value !== "number") throw invalid();
      }
      // Match the former JSON.parse -> JSON.stringify API normalization, while
      // keeping the immutable source asset byte-for-byte unchanged.
      if (!Number.isFinite(value) || Object.is(value, -0)) replacements.push({ start, end: cursor, text: Number.isFinite(value) ? "0" : "null" });
      type = "number";
    }
    complete({ type, start, end: cursor });
  }
  if (cursor !== bytes.length || root.type !== "object") throw invalid();
  const queries = root.members.get("queries");
  if (queries?.type !== "object") throw invalid();
  let rowCount = 0;
  const entries = [];
  for (const [queryId, query] of queries.members) {
    if (query.type !== "object" || query.rows && (query.rows.type !== "array" || !query.rows.objectRows)) throw invalid();
    rowCount += query.rows?.rowCount ?? 0;
    entries.push([queryId, { rows: query.rows ? [query.rows.start, query.rows.end] : null,
      end: query.end - 1, empty: query.empty,
      source: query.source ? { range: [query.source.start, query.source.end],
        object: query.source.type === "object", empty: query.source.empty ?? false,
        executedAt: query.source.executedAt ? [query.source.executedAt.start, query.source.executedAt.end] : null } : null }]);
  }
  const generatedAt = root.members.get("generatedAt");
  const snapshotIndex = { version: 1, sha256: digest(bytes), bytes: bytes.length,
    generatedAt: generatedAt ? [generatedAt.start, generatedAt.end] : null,
    end: root.end - 1, queries: Object.fromEntries(entries),
    ...(replacements.length ? { replacements } : {}) };
  const edits = [...replacements];
  for (const query of Object.values(snapshotIndex.queries)) {
    if (!query.rows) edits.push({ start: query.end, end: query.end, text: `${query.empty ? "" : ","}"rows":[]` });
  }
  if (!edits.length) return { snapshotIndex, snapshotResponse: { sha256: snapshotIndex.sha256, bytes: bytes.length,
    queryCount: entries.length, rowCount, encoding: "indexed-raw-v1" } };
  edits.sort((a, b) => a.start - b.start);
  const hash = createHash("sha256");
  let position = 0, responseBytes = 0;
  const append = value => { hash.update(value); responseBytes += Buffer.byteLength(value); };
  for (const edit of edits) {
    append(bytes.subarray(position, edit.start));
    append(edit.text);
    position = edit.end;
  }
  append(bytes.subarray(position));
  return { snapshotIndex, snapshotResponse: { sha256: hash.digest("hex"), bytes: responseBytes,
    queryCount: entries.length, rowCount, encoding: "indexed-raw-v1" } };
}
