#!/usr/bin/env node
import { readFile, realpath, stat } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_PLUGIN_ROOT, prepareInlineRuntime } from "./inline-chart-build.mjs";
import { MAX_INLINE_INPUT_BYTES } from "./inline-chart-input.mjs";
import { normalizeInlineSourcesInput } from "./inline-sources-input.mjs";
import { assembleInlineFragment, inlineOutputPath, loadInlineTheme, writeInlineOutput } from "./render-inline-chart.mjs";

export async function renderInlineSources({ input, output, pluginRoot = DATA_PLUGIN_ROOT, onProgress = () => {} }) {
  pluginRoot = await realpath(resolve(pluginRoot));
  const normalized = normalizeInlineSourcesInput(input);
  const requestedOutput = await inlineOutputPath(output, pluginRoot);
  const runtime = await prepareInlineRuntime({ pluginRoot, artifactName: "receipt", onProgress });
  const theme = await loadInlineTheme(normalized.theme, { pluginRoot });
  const template = await readFile(join(pluginRoot, "skills/visualize-data/assets/inline-sources-fragment.html"), "utf8");
  const { fragment, bytes, rootId } = assembleInlineFragment({ normalized, theme, runtimeCode: runtime.code, template });
  const path = await writeInlineOutput(requestedOutput, fragment, { pluginRoot, legacyCacheDir: runtime.legacyCacheDir });
  return {
    path, bytes, rootId, itemCount: normalized.items.length,
    rowCount: normalized.items.reduce((total, item) => total + item.queries.reduce((sum, query) => sum + (query.rows?.length ?? 0), 0), 0),
    prebuilt: true, runtimeKey: runtime.metadata.key, runtimeBytes: runtime.metadata.bytes,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (["--help", "--example", "--prepare"].includes(flag)) args[flag.slice(2)] = true;
    else if (["--input", "--output"].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith("--"))
      args[flag.slice(2)] = argv[++index];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (args.help) {
    process.stdout.write("Render one Sources receipt for an evidence-backed inline answer.\n"
      + "node render-inline-sources.mjs --input sources.json --output /absolute/path/answer-sources.html\n"
      + "node render-inline-sources.mjs --example | --prepare\n");
    return;
  }
  if (args.example) {
    process.stdout.write(await readFile(join(dirname(fileURLToPath(import.meta.url)), "../assets/inline-sources-example.json"), "utf8"));
    return;
  }
  if (args.prepare) {
    const runtime = await prepareInlineRuntime({ artifactName: "receipt" });
    process.stdout.write(`${JSON.stringify({ prebuilt: true, bytes: runtime.metadata.bytes })}\n`);
    return;
  }
  if (!args.input || !args.output) throw new Error("Provide --input and --output.");
  if ((await stat(args.input)).size > MAX_INLINE_INPUT_BYTES) throw new Error("Sources input exceeds 2 MB.");
  const result = await renderInlineSources({ input: JSON.parse(await readFile(args.input, "utf8")), output: args.output });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
