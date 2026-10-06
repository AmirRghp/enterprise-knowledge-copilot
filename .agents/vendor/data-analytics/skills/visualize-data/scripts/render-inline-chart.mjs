#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dataAppThemes } from "../../../templates/data-app/base/src/theme-presets.js";
import { chartTypes } from "../../../templates/data-app/base/src/charting/chart-theme.js";
import { reviewedSource } from "../../../templates/data-app/base/src/source-provenance.js";
import { inlineArtifactForChart } from "../../../templates/data-app/inline/chart-families.mjs";
import { loadPrebuiltCompiler } from "../../../scripts/data-app-runtime.mjs";
import { canonicalInlinePath, DATA_PLUGIN_ROOT, isInside, prepareInlineRuntime } from "./inline-chart-build.mjs";
import { validateInlineThemeCss } from "./inline-chart-theme.mjs";
import {
  assertReplacementSafe,
  inlineJson,
  MAX_INLINE_FRAGMENT_BYTES,
  MAX_INLINE_INPUT_BYTES,
  normalizeInlineChartInput,
} from "./inline-chart-input.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const asset = (name) => join(scriptDirectory, "../assets", name);
const htmlAttribute = (value) =>
  value.replace(
    /[&<>"'$]/gu,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
        $: "&#36;",
      })[character],
  );

export async function loadInlineTheme(id, { pluginRoot, themeCssPath }) {
  const preset = dataAppThemes.find((theme) => theme.id === id);
  if (!themeCssPath && (!preset || id === "original")) throw new Error(`Unknown bundled Data theme: ${id}`);
  const path = themeCssPath ? resolve(themeCssPath) : join(pluginRoot, "templates/data-app/themes", id, "theme.css");
  const css = await readFile(path, "utf8");
  if (Buffer.byteLength(css) > 100_000 || /@import\b|@font-face\b|\burl\s*\(|\bexpression\s*\(/iu.test(css)) {
    throw new Error("Inline themes must be local token stylesheets without external resources (maximum 100 KB).");
  }
  const declaredScheme = css.match(/--fixed-theme-scheme\s*:\s*(light|dark)\s*[;}]/iu)?.[1]?.toLowerCase();
  const fixedScheme = declaredScheme || (!themeCssPath && preset?.darkOnly ? "dark" : undefined);
  return { id: themeCssPath ? "original" : id, css, ...(fixedScheme ? { fixedScheme } : {}) };
}

/** The renderer and release capacity gate must measure the same complete fragment. */
export function assembleInlineFragment({ normalized, theme, runtimeCode, template, title = normalized.component?.title ?? "Sources" }) {
  // The normalized inspector and chart share the same reviewed rows. Serialize
  // that array once; the mount restores the inspector reference without copying it.
  const query = normalized.query && normalized.query.rows === normalized.rows
    ? Object.fromEntries(Object.entries(normalized.query).filter(([key]) => key !== "rows"))
    : normalized.query;
  const serialized = inlineJson({ ...normalized, query, theme });
  const rootId = `data-inline-${createHash("sha256").update(serialized).digest("hex").slice(0, 16)}`;
  const replacements = {
    ROOT_ID: rootId,
    TITLE: htmlAttribute(title),
    PAYLOAD: serialized,
    RUNTIME: runtimeCode,
  };
  const fragment = template.replace(/__INLINE_(ROOT_ID|TITLE|PAYLOAD|RUNTIME)__/gu, (_, key) => replacements[key]);
  assertReplacementSafe(fragment);
  const bytes = Buffer.byteLength(fragment);
  if (bytes > MAX_INLINE_FRAGMENT_BYTES) {
    throw new Error(
      `Inline chart is ${bytes} bytes (limit ${MAX_INLINE_FRAGMENT_BYTES}). Aggregate rows, remove unneeded preview columns or source detail, and retry.`,
    );
  }
  return { fragment, bytes, rootId };
}

export async function inlineOutputPath(output, pluginRoot) {
  if (typeof output !== "string" || !isAbsolute(output) || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.html$/u.test(basename(output)))
    throw new Error("Choose an explicit output path with a lowercase-hyphenated .html filename.");
  const path = join(await canonicalInlinePath(dirname(output)), basename(output));
  if (isInside(pluginRoot, path)) throw new Error("Write inline output outside the installed Data plugin.");
  return path;
}

export async function writeInlineOutput(requestedOutput, fragment, { pluginRoot, legacyCacheDir }) {
  if (isInside(legacyCacheDir, requestedOutput))
    throw new Error("Reviewed data must not be written into the shared renderer cache.");
  await mkdir(dirname(requestedOutput), { recursive: true });
  const outputPath = join(await realpath(dirname(requestedOutput)), basename(requestedOutput));
  if (isInside(pluginRoot, outputPath) || isInside(legacyCacheDir, outputPath))
    throw new Error("Output resolves inside a read-only source or shared cache.");
  try {
    if ((await lstat(outputPath)).isSymbolicLink()) throw new Error("Refusing to overwrite a symlinked inline output.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${outputPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, fragment, { mode: 0o600 });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return outputPath;
}

export async function renderInlineChart({
  input,
  output,
  includeSql = false,
  includeSourceUrls = false,
  themeCssPath,
  pluginRoot = DATA_PLUGIN_ROOT,
  cacheDir,
  offline = false,
  onProgress = () => {},
}) {
  pluginRoot = await realpath(resolve(pluginRoot));
  const normalized = normalizeInlineChartInput(input, { includeSql, includeSourceUrls });
  const requestedOutput = await inlineOutputPath(output, pluginRoot);
  const theme = await loadInlineTheme(normalized.theme, { pluginRoot, themeCssPath });
  const runtime = await prepareInlineRuntime({
    artifactName: inlineArtifactForChart(normalized.component.chart.type),
    pluginRoot,
    cacheDir,
    offline,
    onProgress,
  });
  if (themeCssPath) {
    const compiler = await loadPrebuiltCompiler({ pluginRoot });
    theme.css = validateInlineThemeCss(theme.css, compiler);
    const declared = theme.css.match(/--fixed-theme-scheme\s*:\s*(light|dark)\s*[;}]/iu)?.[1]?.toLowerCase();
    if (declared) theme.fixedScheme = declared;
  }
  if (isInside(runtime.legacyCacheDir, requestedOutput))
    throw new Error("Reviewed chart data must not be written into the shared renderer cache.");
  const template = await readFile(join(pluginRoot, "skills/visualize-data/assets/inline-chart-fragment.html"), "utf8");
  const { fragment, bytes, rootId } = assembleInlineFragment({ normalized, theme, runtimeCode: runtime.code, template });
  const outputPath = await writeInlineOutput(requestedOutput, fragment, { pluginRoot, legacyCacheDir: runtime.legacyCacheDir });
  return {
    path: outputPath,
    bytes,
    rowCount: normalized.rows.length,
    cacheHit: runtime.cacheHit,
    prebuilt: runtime.prebuilt,
    runtimeKey: runtime.metadata.key,
    runtimeBytes: runtime.metadata.bytes,
    rootId,
    sourceLabel: normalized.query.source.label,
    includedSql: Boolean(normalized.query.source.sql),
    includedSourceUrls: includeSourceUrls,
  };
}

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (
      [
        "--prepare",
        "--offline",
        "--include-sql",
        "--omit-sql",
        "--include-source-urls",
        "--help",
        "--example",
        "--list-chart-types",
      ].includes(argument)
    ) {
      result[argument.slice(2)] = true;
    } else if (["--input", "--output", "--cache-dir", "--theme-css"].includes(argument)) {
      if (!argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(`Missing value for ${argument}`);
      result[argument.slice(2)] = argv[++index];
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = options(argv);
  if (args["include-sql"] && args["omit-sql"])
    throw new Error("Use either --include-sql or --omit-sql, not both.");
  if (args.help) {
    process.stdout.write(
      "Render a reviewed chart with the shared Data React/Recharts components.\n\n" +
        "node render-inline-chart.mjs --input chart.json --output /absolute/path/chart.html\n" +
        "  [--cache-dir PATH] [--offline] [--theme-css PATH] [--include-sql | --omit-sql] [--include-source-urls]\n" +
        "Supplied SQL requires --include-sql after sensitivity review, or --omit-sql to exclude it.\n" +
        "node render-inline-chart.mjs --prepare [--cache-dir PATH] [--offline]\n" +
        "node render-inline-chart.mjs --example\n" +
        "node render-inline-chart.mjs --list-chart-types\n",
    );
    return;
  }
  if (args.example) {
    process.stdout.write(await readFile(asset("inline-chart-example.json"), "utf8"));
    return;
  }
  if (args["list-chart-types"]) {
    process.stdout.write(`${JSON.stringify(chartTypes)}\n`);
    return;
  }
  const buildOptions = {
    cacheDir: args["cache-dir"],
    offline: Boolean(args.offline),
    onProgress: (message) => {
      if (message) process.stderr.write(`${message}\n`);
    },
  };
  if (args.prepare) {
    if (args.input || args.output) throw new Error("--prepare does not accept chart input or output.");
    const result = await prepareInlineRuntime(buildOptions);
    process.stdout.write(
      `${JSON.stringify({
        prebuilt: result.prebuilt,
        cacheDir: result.cacheDir,
        cacheHit: result.cacheHit,
        ...result.metadata,
      })}\n`,
    );
    return;
  }
  if (!args.input || !args.output)
    throw new Error("Use --input chart.json and --output /absolute/path/chart.html. See --help or --example.");
  const source = await readFile(resolve(args.input));
  if (source.byteLength > MAX_INLINE_INPUT_BYTES)
    throw new Error("Inline chart input exceeds 2 MB; aggregate or project it first.");
  const input = JSON.parse(source.toString("utf8"));
  if (reviewedSource(input?.source).sql != null && !args["include-sql"] && !args["omit-sql"])
    throw new Error("Supplied SQL requires an explicit choice: review the full statement for credentials and direct contact/payment identifiers, then use --include-sql; otherwise use --omit-sql.");
  const result = await renderInlineChart({
    ...buildOptions,
    input,
    output: args.output,
    includeSql: Boolean(args["include-sql"]),
    includeSourceUrls: Boolean(args["include-source-urls"]),
    themeCssPath: args["theme-css"],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Installed plugins and macOS temporary directories may be reached through
// symlinks. Node canonicalizes import.meta.url, but not process.argv[1].
const invokedPath =
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]);
    } catch {
      return undefined;
    }
  })();
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
