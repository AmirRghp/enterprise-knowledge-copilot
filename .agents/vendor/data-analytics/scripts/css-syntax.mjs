const closingCharacters = new Map([
  ["Block", "}"],
  ["Function", ")"],
  ["Parentheses", ")"],
  ["Brackets", "]"],
  ["Url", ")"],
]);

function unescapedCharacterAt(source, index, character) {
  if (source[index] !== character) return false;
  let slashes = 0;
  for (let previous = index - 1; previous >= 0 && source[previous] === "\\"; previous--) slashes++;
  return slashes % 2 === 0;
}

/** Parse complete CSS without accepting css-tree's normal error/EOF recovery. */
export function parseStrictCss(css, compiler, { filename = "data-app.css", onInvalid } = {}) {
  const invalid = (reason) => {
    const cause = reason instanceof Error ? reason : new Error(reason);
    onInvalid?.(cause);
    throw new Error(`Invalid CSS syntax in ${filename}: ${cause.message}`, { cause });
  };
  let ast;
  try {
    ast = compiler.parseCss(css, {
      context: "stylesheet",
      filename,
      positions: true,
      parseCustomProperty: true,
      onParseError(error) {
        throw error;
      },
      onComment(_value, location) {
        // `/*/` is not a closed comment: its apparent delimiters overlap.
        if (
          location.end.offset - location.start.offset < 4 ||
          css.slice(location.end.offset - 2, location.end.offset) !== "*/"
        )
          throw new Error("Unterminated CSS comment.");
      },
    });
  } catch (error) {
    invalid(error);
  }
  if (ast.type !== "StyleSheet") invalid("Expected a stylesheet.");
  compiler.walkCss(ast, (node) => {
    if (node.type === "Raw") invalid("Unsupported or recovered CSS syntax.");
    // CSS Syntax permits an implicit closer at EOF. Publication must use the
    // author's complete input, not a repaired block/function/string/URL.
    const closing = closingCharacters.get(node.type);
    if (closing && !unescapedCharacterAt(css, node.loc.end.offset - 1, closing))
      invalid(`Unterminated CSS ${node.type.toLowerCase()}.`);
    if (node.type === "String") {
      const opening = css[node.loc.start.offset];
      if (
        !['"', "'"].includes(opening) ||
        node.loc.end.offset - node.loc.start.offset < 2 ||
        !unescapedCharacterAt(css, node.loc.end.offset - 1, opening)
      )
        invalid("Unterminated CSS string.");
    }
  });
  return ast;
}
