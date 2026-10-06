import { parse as acornParse } from "acorn";
import cssGenerate from "css-tree/generator";
import cssParse from "css-tree/parser";
import { ident } from "css-tree/utils";
import cssWalk from "css-tree/walker";
import { transform as sucraseTransform } from "sucrase";

export { rollup } from "@rollup/browser";

/** Versioned, dependency-free interface consumed by the local Data assembler. */
export const apiVersion = 1;

export function transform(code, { filePath = "authored.jsx", commonjs = true, typescript } = {}) {
  const hasTypes = typescript ?? /\.[cm]?tsx?$/u.test(filePath);
  return sucraseTransform(code, {
    transforms: ["jsx", ...(hasTypes ? ["typescript"] : []), ...(commonjs ? ["imports"] : [])],
    jsxRuntime: "automatic",
    production: true,
    disableESTransforms: true,
    filePath,
  }).code;
}

export function parseJavaScript(code, options = {}) {
  return acornParse(code, { ecmaVersion: "latest", sourceType: "module", ...options });
}

export function parseCss(code, options = {}) {
  return cssParse(code, { parseCustomProperty: true, ...options });
}

export const walkCss = cssWalk;
export const generateCss = cssGenerate;
export const decodeCssIdentifier = ident.decode;
