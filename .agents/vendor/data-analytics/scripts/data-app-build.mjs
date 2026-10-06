import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";

import { compileAuthoredModules } from "./authored-module-graph.mjs";
import {
  DEFAULT_PLUGIN_ROOT,
  assertPrebuiltProject,
  loadPrebuiltCompiler,
  readPrebuiltArtifact,
} from "./data-app-runtime.mjs";
import { API_VERSION, readRegularFile, sha256 } from "./prebuilt/manifest.mjs";
import { parseJsonBytes } from "../templates/data-app/base/src/streaming-json.js";
import {
  SEPARATE_DATA_KIND, SEPARATE_BUILD_MANIFEST, assertHydratedPublicationSource,
  fingerprintDataFile, resolveSeparateDataBundle,
} from "./data-app-separate.mjs";

const THREAD_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;
const HASH = /^[a-f\d]{64}$/u;
const SNAPSHOT_ELEMENT_ID = "data-app-reviewed-snapshot";
const faviconHref = `data:image/svg+xml;base64,${readFileSync(join(DEFAULT_PLUGIN_ROOT, "assets/datascience-small.svg")).toString("base64")}`;

export function localDataThreadId(environment = process.env) {
  return [environment.CODEX_SESSION_ID, environment.CODEX_THREAD_ID].find((value) => THREAD_ID.test(value ?? "")) ?? "";
}

function originalDataThreadId(html) {
  const markers = [];
  let cursor = 0, inHead = false;
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start === -1) break;
    if (html.startsWith("<!--", start)) {
      const end = html.indexOf("-->", start + 4);
      if (end === -1) return "";
      cursor = end + 3;
      continue;
    }
    // A quoted attribute may contain both '>' and markup-looking text.
    let end = start + 1, quote = "";
    for (; end < html.length; end++) {
      const character = html[end];
      if (quote) { if (character === quote) quote = ""; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === ">") break;
    }
    if (end === html.length) return "";
    const tag = html.slice(start, end + 1);
    cursor = end + 1;
    const match = /^<(\/?)([a-z][a-z0-9:-]*)(?=[\s/>])/iu.exec(tag);
    if (!match) continue;
    const [, closing, name] = match, normalized = name.toLowerCase();
    if (!closing && ["script", "style", "title", "textarea"].includes(normalized)) {
      // Skip large embedded payloads without a body-spanning backreference regex,
      // which can exhaust V8's stack on otherwise valid large dashboard rebuilds.
      const close = new RegExp(`</${normalized}\\s*>`, "giu");
      close.lastIndex = cursor;
      if (!close.exec(html)) return "";
      cursor = close.lastIndex;
      continue;
    }
    if (normalized === "head") {
      if (!closing) inHead = true;
      else if (inHead && /^<\/head\s*>$/iu.test(tag)) {
        const original = markers.length === 1 && /^<meta\s+name="data-app-local-thread"\s+content="([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})"\s*\/?>$/iu.exec(markers[0]);
        return original ? original[1] : "";
      }
    } else if (inHead && !closing && normalized === "meta"
      && /\bname\s*=\s*["']?data-app-local-thread(?=["'\s/>]|$)/iu.test(tag)) markers.push(tag);
  }
  return "";
}

export async function projectLocalDataThreadId(projectRoot, environment = process.env) {
  const directory = await statOrNull(join(projectRoot, "dist"));
  const entry = directory?.isDirectory() && !directory.isSymbolicLink()
    ? await statOrNull(join(projectRoot, "dist/index.html")) : null;
  if (entry?.isFile() && !entry.isSymbolicLink()) {
    const html = (await readRegularFile(projectRoot, "dist/index.html")).toString("utf8");
    const original = originalDataThreadId(html);
    // A rebuild belongs to the app's originating task, even when a different
    // task or a shell without Codex environment variables performs the build.
    if (original) return original;
    // Hosted packages remove local task tags. Recover the original offline
    // page only when both it and the current hosted output match the manifest.
    // A stale or replaced backup must never attach this app to another task.
    try {
      const manifestEntry = await statOrNull(join(projectRoot, ".data-app-assets/manifest.json"));
      if (manifestEntry?.isFile() && !manifestEntry.isSymbolicLink() && manifestEntry.size <= 65536) {
        const manifest = JSON.parse(await readRegularFile(projectRoot, ".data-app-assets/manifest.json"));
        if (manifest.version === 1 && manifest.thinBootstrap === true
          && manifest.source?.offlineHtmlPath === ".data-app-offline/index.html"
          && HASH.test(manifest.source.htmlSha256 ?? "")
          && manifest.assets?.html?.sha256 === sha256(Buffer.from(html))) {
          const offline = await readRegularFile(projectRoot, ".data-app-offline/index.html");
          if (sha256(offline) === manifest.source.htmlSha256) {
            const offlineOriginal = originalDataThreadId(offline.toString("utf8"));
            if (offlineOriginal) return offlineOriginal;
          }
        }
      }
    } catch { /* Unverified backups cannot supply app identity. */ }
    try {
      const bundle = resolveSeparateDataBundle({ projectDir: projectRoot });
      const preservedOriginal = originalDataThreadId(bundle.htmlBytes.toString("utf8"));
      if (preservedOriginal) return preservedOriginal;
    } catch { /* Only a complete, verified split bundle can supply identity. */ }
  }
  return localDataThreadId(environment);
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/gu,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character],
  );
}

function jsonDocument(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function embeddedScript(code) {
  // HTML has its own script tokenizer, even inside JS strings and tagged
  // templates. A data URL preserves unusual source bytes without eval or a
  // handwritten JavaScript rewrite. Classic scripts remain ordered and local.
  new Script(code, { filename: "data-app-embedded.js" });
  return /<(?:!--|\/?script)|[\0\r]/iu.test(code)
    ? `<script src="data:text/javascript;charset=utf-8;base64,${Buffer.from(code).toString("base64")}"></script>`
    : `<script>${code}</script>`;
}

export function embeddedStyle(css) {
  return /<\/style|[\0\r]/iu.test(css)
    ? `<link rel="stylesheet" href="data:text/css;charset=utf-8;base64,${Buffer.from(css).toString("base64")}">`
    : `<style>${css}</style>`;
}

export function assembleDataAppHtml({
  appCode,
  protectedStyles,
  printStyles,
  authored,
  snapshotBytes,
  runtimeSha256,
  localThreadId = "",
  separateData = false,
}) {
  if (!HASH.test(runtimeSha256 ?? "")) throw new Error("The Data app requires a verified runtime hash.");
  if (localThreadId && !THREAD_ID.test(localThreadId)) throw new Error("Invalid local Data app task identifier.");
  let snapshot;
  try {
    snapshot = parseJsonBytes(snapshotBytes, {
      fatal: true, ignoreBOM: false,
      // Split builds need only the bootstrap metadata. Validate the entire
      // query grammar without retaining another copy of its rows in Node.
      ...(separateData ? { discard: path => path.length === 1 && path[0] === "queries" } : {}),
    });
  } catch {
    throw new Error("The reviewed Data app snapshot must be valid UTF-8 JSON.");
  }
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot) ||
    !snapshot.queries ||
    typeof snapshot.queries !== "object" ||
    Array.isArray(snapshot.queries)
  ) {
    throw new Error("The Data app must contain a reviewed query snapshot.");
  }
  const snapshotSha256 = sha256(snapshotBytes);
  const snapshotPath = `snapshot.${snapshotSha256}.json`;
  const bootstrapSnapshot = separateData
    ? { id: snapshot.id, title: snapshot.title, surface: snapshot.surface, queries: {} } : snapshot;
  const bootstrap =
    `(() => {\n"use strict";\n` +
    `const runtime = globalThis.CodexDataAppRuntime;\n` +
    `if (runtime?.apiVersion !== ${API_VERSION}) throw new Error("Incompatible Data app runtime.");\n` +
    `const snapshotElement = document.getElementById(${JSON.stringify(
      SNAPSHOT_ELEMENT_ID,
    )});\n` +
    (separateData
      ? `const continuation = document.querySelectorAll('script[data-app-snapshot-chunk]');\n` +
        `const reviewedSnapshot = continuation.length ? (() => { const parser = runtime.createStreamingJsonParser(); parser.write(snapshotElement.textContent); for (const chunk of continuation) parser.write(chunk.textContent); return parser.finish(); })() : JSON.parse(snapshotElement.textContent);\n`
      : `const reviewedSnapshot = JSON.parse(snapshotElement.textContent);\n`) +
    (separateData
      ? `const mount = (snapshot, hosted = false) => runtime.mount({reviewedSnapshot: snapshot, hosted, createContent: (snapshot) => ${authored.factorySource}(runtime, snapshot)});\n` +
        `const localSource = document.querySelector('meta[name="data-app-local-snapshot"]')?.content;\n` +
        `const hosted = document.querySelector('meta[name="data-app-snapshot-storage"]')?.content === "external-v1" || globalThis.location?.hostname?.endsWith(".chatgpt.site");\n` +
        `if (hosted || !localSource) mount(reviewedSnapshot, Boolean(hosted));\n` +
        `else {\n` +
        `  const root = document.getElementById("root");\n` +
        `  if (root) root.textContent = "Loading data…";\n` +
        `  fetch(new URL(localSource, document.baseURI), {credentials: "same-origin"})\n` +
        `    .then(response => { if (!response.ok) throw new Error("Snapshot unavailable"); return runtime.parseJsonResponse(response); })\n` +
        `    .then(snapshot => {\n` +
        `      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot) || !snapshot.queries || typeof snapshot.queries !== "object" || Array.isArray(snapshot.queries)) throw new Error("Invalid snapshot");\n` +
        `      mount(snapshot);\n` +
        `    }).catch(() => { if (root) root.textContent = "The reviewed data could not be loaded. Serve this complete build over local HTTP, or export a standalone offline HTML file."; });\n` +
        `}\n`
      : `runtime.mount({reviewedSnapshot, createContent: (snapshot) => ${authored.factorySource}(runtime, snapshot)});\n`) +
    `})();`;
  // Match the source entry: conventional sheets precede print, while component
  // stylesheet imports follow it and may intentionally override print rules.
  const styles = [authored.themeCss, protectedStyles, authored.conventionalCss, printStyles, authored.importedCss].join(
    "\n",
  );
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n` +
    `<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta name="color-scheme" content="light dark">\n` +
    `<meta name="theme-color" content="#ffffff">\n` +
    `<meta name="data-app-snapshot-sha256" content="${snapshotSha256}">\n` +
    `<meta name="data-app-runtime-sha256" content="${runtimeSha256}">\n` +
    `<meta name="data-app-bootstrap" content="deferred-content-v1">\n` +
    (separateData ? `<meta name="data-app-build-layout" content="${SEPARATE_DATA_KIND}">\n<meta name="data-app-local-snapshot" content="${snapshotPath}">\n` : "") +
    (localThreadId ? `<meta name="data-app-local-thread" content="${localThreadId}">\n` : "") +
    `<title>${escapeHtml(snapshot.title || "Data app")}</title>\n` +
    `<link rel="icon" type="image/svg+xml" href="${faviconHref}">\n${embeddedStyle(styles)}\n</head>\n<body>\n` +
    `<div id="root"></div>\n` +
    `<script type="application/json" id="${SNAPSHOT_ELEMENT_ID}">${jsonDocument(bootstrapSnapshot)}</script>\n` +
    `${embeddedScript(appCode)}\n${embeddedScript(bootstrap)}\n</body>\n</html>\n`;
  return { html, snapshotSha256 };
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function publishHtml(projectRoot, html, onProgress, additionalFiles = {}) {
  const destination = join(projectRoot, "dist");
  const existing = await statOrNull(destination);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error("Data app dist must be a regular directory inside the project.");
  }
  const scratch = await mkdtemp(join(projectRoot, ".data-app-build-"));
  const candidate = join(scratch, "next");
  const previous = join(scratch, "previous");
  let movedPrevious = false;
  let published = false;
  let preservePrevious = false;
  try {
    await mkdir(candidate);
    await writeFile(join(candidate, "index.html"), html, { flag: "wx" });
    for (const [name, bytes] of Object.entries(additionalFiles)) await writeFile(join(candidate, name), bytes, { flag: "wx" });
    if (existing) {
      await rename(destination, previous);
      movedPrevious = true;
      preservePrevious = true;
    }
    try {
      await rename(candidate, destination);
      published = true;
      preservePrevious = false;
    } catch (error) {
      if (movedPrevious) {
        // Do not overwrite another build that won the destination in between.
        try {
          if (!(await statOrNull(destination))) {
            await rename(previous, destination);
            movedPrevious = false;
            preservePrevious = false;
          }
        } catch {
          // The only old copy stays detached if probing or restoring fails.
        }
      }
      if (preservePrevious) {
        throw new Error(`Could not publish the Data app. The previous output is preserved at ${previous}.`, {
          cause: error,
        });
      }
      throw error;
    }
  } finally {
    if (!preservePrevious) {
      try {
        await rm(scratch, { recursive: true, force: true });
      } catch (error) {
        if (!published) throw error;
        onProgress?.(`Built the Data app; the old output could not be removed from ${scratch}: ${error.message}`);
      }
    }
  }
  return join(destination, "index.html");
}

function preparedResult({ projectRoot, pluginRoot, manifest }) {
  return {
    projectRoot,
    prebuilt: true,
    apiVersion: API_VERSION,
    runtimeSha256: manifest.artifacts.app.sha256,
    compilerSha256: manifest.artifacts.compiler.sha256,
    documentation: {
      entryPoint: join(pluginRoot, "templates/data-app/base/docs/components/README.md"),
      source: "installed-plugin",
      apiVersion: manifest.apiVersion,
      runtimeSha256: manifest.artifacts.app.sha256,
    },
  };
}

export async function preparePrebuiltDataApp(options = {}) {
  const state = await assertPrebuiltProject(options);
  return preparedResult(state);
}

export async function buildPrebuiltDataApp({
  projectDir,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  environment = process.env,
  onProgress,
  separateData = false,
} = {}) {
  const projection = projectDir ? assertHydratedPublicationSource(projectDir) : undefined;
  const state = await assertPrebuiltProject({ projectDir, pluginRoot, onProgress });
  const { projectRoot, manifest } = state;
  const read = (name) => readPrebuiltArtifact(name, { pluginRoot: state.pluginRoot, manifest });
  const [compiler, app, styles, print, snapshotBytes] = await Promise.all([
    loadPrebuiltCompiler({ pluginRoot: state.pluginRoot, manifest }),
    read("app"),
    read("styles"),
    read("print"),
    readRegularFile(projectRoot, "src/data.json"),
  ]);
  const authored = await compileAuthoredModules({
    projectRoot,
    compiler,
    runtimeModuleExports: manifest.artifacts.app.metadata.moduleExports,
  });
  for (const warning of authored.warnings) onProgress?.(`${warning.code}: ${warning.message}`);
  const assembled = assembleDataAppHtml({
    appCode: app.code,
    protectedStyles: styles.code,
    printStyles: print.code,
    authored,
    snapshotBytes,
    runtimeSha256: app.sha256,
    localThreadId: await projectLocalDataThreadId(projectRoot, environment),
    separateData,
  });
  // Validate the path again before the streaming recheck; do not follow a
  // replacement symlink, and do not allocate a second snapshot-sized Buffer.
  const sourceEntry = await lstat(join(projectRoot, "src/data.json"));
  const sourceDirectory = await lstat(join(projectRoot, "src"));
  if (!sourceEntry.isFile() || sourceEntry.isSymbolicLink() || !sourceDirectory.isDirectory() || sourceDirectory.isSymbolicLink()
    || fingerprintDataFile(join(projectRoot, "src/data.json")).sha256 !== assembled.snapshotSha256) {
    throw new Error("The reviewed snapshot changed during the Data app build. Retry with a stable snapshot.");
  }
  const finalProjection = assertHydratedPublicationSource(projectRoot);
  if ((projection && (projection.sha256 !== assembled.snapshotSha256 || projection.bytes !== snapshotBytes.length))
    || (finalProjection && (finalProjection.sha256 !== assembled.snapshotSha256 || finalProjection.bytes !== snapshotBytes.length))
    || Boolean(projection) !== Boolean(finalProjection)) {
    throw new Error("The publication source identity changed during the Data app build. Restore its pinned snapshot before rebuilding.");
  }
  const buildManifest = separateData ? {
    version: 1,
    kind: SEPARATE_DATA_KIND,
    html: { path: "index.html", sha256: sha256(assembled.html), bytes: Buffer.byteLength(assembled.html) },
    snapshot: { path: `snapshot.${assembled.snapshotSha256}.json`, sha256: assembled.snapshotSha256, bytes: snapshotBytes.length },
    runtimeSha256: app.sha256,
    sourceSnapshotSha256: assembled.snapshotSha256,
  } : null;
  const htmlPath = await publishHtml(projectRoot, assembled.html, onProgress, buildManifest ? {
    [buildManifest.snapshot.path]: snapshotBytes,
    [SEPARATE_BUILD_MANIFEST]: `${JSON.stringify(buildManifest, null, 2)}\n`,
  } : {});
  return {
    ...preparedResult(state),
    htmlPath,
    htmlSha256: sha256(assembled.html),
    snapshotSha256: assembled.snapshotSha256,
    moduleCount: authored.moduleCount,
    assetCount: authored.assetCount,
    ...(buildManifest ? { buildKind: SEPARATE_DATA_KIND, buildManifestPath: join(projectRoot, "dist", SEPARATE_BUILD_MANIFEST),
      snapshotPath: join(projectRoot, "dist", buildManifest.snapshot.path) } : {}),
  };
}
