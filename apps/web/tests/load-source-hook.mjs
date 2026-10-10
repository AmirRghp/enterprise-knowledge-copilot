/**
 * Load the real hook module, and the real contract module, without a bundler.
 *
 * Both are plain TypeScript with `@/lib` imports. The transpiled output is concatenated in
 * dependency order and handed the collaborators as parameters, so the code under test is
 * the shipped code - not a re-implementation, and not a stub that would make these tests
 * pass regardless of what the hook does.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let typescript;
const typescriptOnce = async () =>
  typescript ?? (typescript = (await import("typescript")).default);

/** The contract module: identifiers, the two addresses, and the response reader. */
export async function loadContract() {
  const ts = await typescriptOnce();
  const source = readFileSync(resolve(here, "../src/lib/document-contract.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const body = outputText.replace(/^export /gm, "");
  return new Function(
    "URLSearchParams",
    `${body}\nreturn {
    sourceApiPath, sourcePath, sourceHandleFrom, sourceContractFrom, documentContractFrom,
    DOCUMENT_ID_PATTERN, SECTION_ID_PATTERN, REVISION_PATTERN,
  };`,
  )(URLSearchParams);
}

/**
 * The source hook, given the contract's real functions.
 *
 * `deadlineMs` rewrites the hook's own 15-second bound so a test can let it actually fire.
 * The alternative - waiting fifteen seconds per case - was not an option for a check that
 * has to run on every change, and asserting on the timer by reading the source would
 * assert on a string rather than on the behaviour. What is being replaced is a duration;
 * everything else in the module is the shipped code.
 */
export async function loadSourceHook(React, contract, deadlineMs) {
  const ts = await typescriptOnce();
  let source = readFileSync(resolve(here, "../src/lib/use-source-section.ts"), "utf8");
  if (deadlineMs !== undefined) {
    if (!source.includes("15_000")) {
      throw new Error("the deadline literal moved; the substitution below would be silent");
    }
    source = source.replace("15_000", String(deadlineMs));
  }
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  const body = outputText
    .split("\n")
    .filter((line) => !line.startsWith("import ") && !line.startsWith("export type"))
    .map((line) => line.replace(/^export /, ""))
    .join("\n");
  // `React.useState` and `React.useEffect` are destructured at the top of the module by
  // the TypeScript output, so they are supplied as names. The real hooks, not stand-ins:
  // the point of these tests is the hook's own state handling.
  return new Function(
    "React",
    "useState",
    "useEffect",
    "sourceApiPath",
    "sourceContractFrom",
    "sourceHandleFrom",
    `${body}\nreturn { useSourceSection, handleFromLocation };`,
  )(
    React,
    React.useState,
    React.useEffect,
    contract.sourceApiPath,
    contract.sourceContractFrom,
    contract.sourceHandleFrom,
  );
}
