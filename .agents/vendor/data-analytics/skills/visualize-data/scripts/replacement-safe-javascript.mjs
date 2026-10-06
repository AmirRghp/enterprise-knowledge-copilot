import assert from "node:assert/strict";

const replacementSequences = /\$[$&'`]/gu;

function walk(value, visit) {
  if (value === null || typeof value !== "object") return;
  if (typeof value.type === "string") visit(value);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => walk(item, visit));
    else if (child !== null && typeof child === "object") walk(child, visit);
  }
}

function taggedQuasis(ast) {
  const result = [];
  walk(ast, (node) => {
    if (node.type === "TaggedTemplateExpression") result.push(...node.quasi.quasis);
  });
  return result;
}

function semanticAst(value) {
  if (value instanceof RegExp) return { regexp: value.source, flags: value.flags };
  if (Array.isArray(value)) return value.map(semanticAst);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["start", "end", "loc", "range", "raw"].includes(key))
      .map(([key, child]) => [key, semanticAst(child)]),
  );
}

function escapeTemplateDollars(raw) {
  let result = "";
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] !== "$") {
      result += raw[index];
      continue;
    }
    let slashes = 0;
    for (let previous = index - 1; previous >= 0 && raw[previous] === "\\"; previous--) slashes++;
    if (slashes % 2 === 1) result = result.slice(0, -1);
    result += "\\u0024";
  }
  return result;
}

/**
 * Older Codex clients insert HTML as a String.replace replacement string.
 * Encode affected JS tokens, preserving their parsed meaning. Unlike doubling
 * every dollar, this output works in both fixed clients and standalone HTML.
 * The parser is supplied by the locked Vite/Rolldown build toolchain.
 */
export function makeReplacementSafe(code, parse) {
  if (![...code.matchAll(replacementSequences)].length) return { code, encodedTokens: 0 };
  const original = parse(code);
  const protectedQuasis = new Set(taggedQuasis(original).map((node) => `${node.start}:${node.end}`));
  const leaves = [];
  walk(original, (node) => {
    if (
      ["Identifier", "PrivateIdentifier", "TemplateElement"].includes(node.type) ||
      (node.type === "Literal" && typeof node.value === "string")
    )
      leaves.push(node);
  });
  leaves.sort((left, right) => left.start - right.start || left.end - right.end);
  const affected = new Map();
  for (const match of code.matchAll(replacementSequences)) {
    const node = leaves.find((item) => item.start <= match.index && item.end > match.index);
    if (!node)
      throw new Error(
        `Unsupported replacement-sensitive JavaScript at offset ${match.index}. Update the inline compatibility encoder before shipping.`,
      );
    affected.set(`${node.start}:${node.end}`, node);
  }
  const edits = [...affected.values()]
    .map((node) => {
      const raw = code.slice(node.start, node.end);
      let replacement;
      if (node.type === "Identifier" || node.type === "PrivateIdentifier") {
        replacement = raw.replaceAll("$", "\\u0024");
      } else if (node.type === "TemplateElement") {
        assert.ok(
          !protectedQuasis.has(`${node.start}:${node.end}`),
          "Cannot change observable tagged-template raw values",
        );
        replacement = escapeTemplateDollars(raw);
      } else {
        replacement = JSON.stringify(node.value).replaceAll("$", "\\u0024");
      }
      return { start: node.start, end: node.end, replacement };
    })
    .sort((left, right) => right.start - left.start);
  let safe = code;
  for (const edit of edits) safe = safe.slice(0, edit.start) + edit.replacement + safe.slice(edit.end);
  assert.equal([...safe.matchAll(replacementSequences)].length, 0, "Replacement-sensitive JavaScript remains");
  const reparsed = parse(safe);
  assert.deepEqual(
    semanticAst(reparsed),
    semanticAst(original),
    "Inline compatibility encoding changed JavaScript semantics",
  );
  assert.deepEqual(
    taggedQuasis(reparsed).map((node) => node.value.raw),
    taggedQuasis(original).map((node) => node.value.raw),
  );
  return { code: safe, encodedTokens: edits.length };
}
