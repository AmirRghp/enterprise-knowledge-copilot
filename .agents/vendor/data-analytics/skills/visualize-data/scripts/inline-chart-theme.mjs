import { parseStrictCss } from "../../../scripts/css-syntax.mjs";

const resourceFunctions = new Set(["url", "image", "image-set", "-webkit-image-set", "src", "paint", "expression"]);

function reject() {
  throw new Error(
    "Custom inline themes must contain only :root token declarations without external resources. Use a bundled theme or a local custom-property stylesheet.",
  );
}

function children(node) {
  return node?.children?.toArray() ?? [];
}

function validatedAst(css, compiler) {
  const { walkCss, decodeCssIdentifier } = compiler;
  const ast = parseStrictCss(css, compiler, {
    filename: "inline-chart-theme.css",
    onInvalid: reject,
  });
  let declarations = 0;
  for (const rule of children(ast)) {
    if (rule.type !== "Rule" || rule.prelude?.type !== "SelectorList" || rule.block?.type !== "Block") reject();
    const selectors = children(rule.prelude);
    if (!selectors.length) reject();
    for (const selector of selectors) {
      const parts = children(selector);
      if (
        selector.type !== "Selector" ||
        parts.length !== 1 ||
        parts[0].type !== "PseudoClassSelector" ||
        decodeCssIdentifier(parts[0].name).toLowerCase() !== "root" ||
        parts[0].children !== null
      )
        reject();
    }
    for (const declaration of children(rule.block)) {
      if (declaration.type !== "Declaration") reject();
      const property = decodeCssIdentifier(declaration.property);
      if (!property.startsWith("--") || property.length === 2 || declaration.value?.type !== "Value") reject();
      declarations++;
    }
  }
  if (!declarations) reject();

  walkCss(ast, (node) => {
    if (
      node.type === "Atrule" ||
      node.type === "NestingSelector" ||
      node.type === "Url" ||
      (node.type === "Function" && resourceFunctions.has(decodeCssIdentifier(node.name).toLowerCase()))
    )
      reject();
  });
  return ast;
}

/** Validate the parsed CSS rather than trusting spelling or a resource regex. */
export function validateInlineThemeCss(css, compiler) {
  const output = compiler.generateCss(validatedAst(css, compiler));
  // Removing a comment next to a hex escape can change token boundaries. The
  // actual generated stylesheet must pass the same resource/structure checks.
  validatedAst(output, compiler);
  return output;
}
