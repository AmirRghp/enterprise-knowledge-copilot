import { spawnSync } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Script } from "node:vm";

import {
  API_VERSION,
  ARTIFACT_PATHS,
  MANIFEST_FORMAT,
  isInside,
  readRegularFile,
  sha256,
  verifyAssets,
} from "./prebuilt/manifest.mjs";

export const DEFAULT_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASSET_DIRECTORY = "assets/data-app-runtime";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f\d]{64}$/u;
const trustedManifests = new WeakMap();
const loadedCompilers = new Map();

function invalid(message, cause) {
  return new Error(`Invalid prebuilt Data runtime: ${message}`, cause ? { cause } : undefined);
}

function freezeTree(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

async function realDirectory(value, label) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`missing ${label}.`);
  const path = await realpath(value);
  if (!(await lstat(path)).isDirectory()) throw invalid(`${label} is not a directory.`);
  return path;
}

async function containedDirectory(root, name) {
  let current = root;
  for (const part of name.split("/")) {
    current = join(current, part);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw invalid(`expected a regular, nonsymlinked directory: ${name}.`);
    }
  }
  return current;
}

export function assertSupportedDataNode(version = process.versions.node) {
  const [major, minor] = String(version).split(".").map(Number);
  if (!((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22)) {
    throw new Error(
      `Data requires Node 20.19+ or 22.12+. Use the absolute Codex Node executable from load_workspace_dependencies (found ${version}).`,
    );
  }
}

export function dataNodeEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(?:NODE_OPTIONS|NODE_PATH)$/iu.test(key)));
}

async function checkManifestBounds(pluginRoot) {
  const directory = await containedDirectory(pluginRoot, ASSET_DIRECTORY);
  const info = await lstat(join(directory, "manifest.json"));
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_MANIFEST_BYTES) {
    throw invalid("manifest must be a bounded regular file.");
  }
  const manifest = JSON.parse(await readRegularFile(pluginRoot, `${ASSET_DIRECTORY}/manifest.json`));
  if (manifest.format !== MANIFEST_FORMAT || manifest.apiVersion !== API_VERSION) {
    throw invalid("unsupported manifest or browser API version.");
  }
  if (!isDeepStrictEqual(Object.keys(manifest.artifacts ?? {}).sort(), Object.keys(ARTIFACT_PATHS).sort())) {
    throw invalid("manifest does not contain the exact release artifacts.");
  }
  let total = 0;
  for (const [name, filename] of Object.entries(ARTIFACT_PATHS)) {
    const entry = manifest.artifacts[name];
    if (
      entry?.path !== filename ||
      !HASH.test(entry.sha256 ?? "") ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      entry.bytes > MAX_ARTIFACT_BYTES ||
      ((name.startsWith("inline") || name === "receipt") && entry.bytes >= 1_000_000)
    ) {
      throw invalid(`invalid ${name} artifact metadata.`);
    }
    total += entry.bytes;
    const file = await lstat(join(directory, filename));
    if (!file.isFile() || file.isSymbolicLink() || file.size !== entry.bytes) {
      throw invalid(`wrong size or file type for ${name}.`);
    }
  }
  if (total > MAX_TOTAL_ARTIFACT_BYTES) throw invalid("release artifacts exceed the supported size.");
}

export async function readPrebuiltManifest(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  assertSupportedDataNode();
  try {
    const root = await realDirectory(pluginRoot, "plugin directory");
    await checkManifestBounds(root);
    const manifest = freezeTree(await verifyAssets({ pluginRoot: root }));
    trustedManifests.set(manifest, root);
    return manifest;
  } catch (error) {
    if (error?.message?.startsWith("Invalid prebuilt Data runtime:")) throw error;
    throw invalid(error?.message ?? String(error), error);
  }
}

export async function readPrebuiltArtifact(
  name,
  { pluginRoot = DEFAULT_PLUGIN_ROOT, manifest: suppliedManifest } = {},
) {
  if (!Object.hasOwn(ARTIFACT_PATHS, name)) throw invalid(`unknown artifact ${String(name)}.`);
  const root = await realDirectory(pluginRoot, "plugin directory");
  const manifest =
    trustedManifests.get(suppliedManifest) === root ? suppliedManifest : await readPrebuiltManifest(root);
  const entry = manifest.artifacts[name];
  const path = join(root, ASSET_DIRECTORY, entry.path);
  const bytes = await readRegularFile(root, `${ASSET_DIRECTORY}/${entry.path}`);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw invalid(`${name} artifact does not match its release hash.`);
  }
  let code;
  try {
    code = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalid(`${name} artifact is not valid UTF-8.`, error);
  }
  return {
    path,
    code,
    sha256: entry.sha256,
    bytes: entry.bytes,
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  };
}

export async function loadPrebuiltCompiler({ pluginRoot = DEFAULT_PLUGIN_ROOT, manifest } = {}) {
  const artifact = await readPrebuiltArtifact("compiler", { pluginRoot, manifest });
  if (loadedCompilers.has(artifact.sha256)) return loadedCompilers.get(artifact.sha256);
  // Evaluate the exact verified publisher bytes, rather than asking Node's module
  // resolver/cache to reopen a mutable path or search an ambient node_modules.
  const module = { exports: {} };
  const requireNothing = (specifier) => {
    throw invalid(`the standalone compiler attempted to import ${String(specifier)}.`);
  };
  const factory = new Script(`(function(module,exports,require){\n${artifact.code}\n})`, {
    filename: artifact.path,
  }).runInThisContext();
  factory(module, module.exports, requireNothing);
  const compiler = module.exports;
  if (
    compiler?.apiVersion !== API_VERSION ||
    ["transform", "rollup", "parseJavaScript", "parseCss", "walkCss", "generateCss", "decodeCssIdentifier"].some(
      (name) => typeof compiler[name] !== "function",
    )
  ) {
    throw invalid("standalone authoring compiler has an incompatible API.");
  }
  Object.freeze(compiler);
  loadedCompilers.set(artifact.sha256, compiler);
  return compiler;
}

async function verifyAuthoredInventory(projectRoot) {
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Data app source must not contain symlinks: ${name}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), name);
      else if (!entry.isFile()) throw new Error(`Unsupported Data app source file: ${name}`);
    }
  }
  const content = await containedDirectory(projectRoot, "src/content");
  for (const name of ["src/theme.css", "src/data.json"]) {
    const entry = await lstat(join(projectRoot, name));
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw invalid(`expected a regular, nonsymlinked authored file: ${name}.`);
    }
  }
  await visit(content, "src/content");
}

export function runDataNode(args, { cwd, environment = process.env, onProgress } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env: dataNodeEnvironment(environment),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `Data command failed (${result.signal ?? result.status}).`).trim(),
    );
  }
  if (result.stdout.trim()) onProgress?.(result.stdout.trim());
  if (result.stderr.trim()) onProgress?.(result.stderr.trim());
  return result.stdout.trim();
}

export async function assertPrebuiltProject({
  projectDir,
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  manifest: suppliedManifest,
  onProgress,
} = {}) {
  const root = await realDirectory(pluginRoot, "plugin directory");
  const projectRoot = await realDirectory(projectDir, "Data app project");
  const manifest =
    trustedManifests.get(suppliedManifest) === root ? suppliedManifest : await readPrebuiltManifest(root);
  const canonicalBytes = await readRegularFile(root, "templates/data-app/base/protected-runtime.json");
  if (sha256(canonicalBytes) !== manifest.source.protectedRuntimeSha256) {
    throw invalid("the canonical protected runtime changed after release verification.");
  }
  const verifier = "templates/data-app/base/scripts/verify-protected-runtime.mjs";
  for (const name of [verifier, "templates/data-app/base/scripts/protected-file-digest.mjs"]) {
    if (sha256(await readRegularFile(root, name)) !== manifest.buildInputs[name]) {
      throw invalid(`the installed authored verifier changed after release verification: ${name}.`);
    }
  }
  // Copied infrastructure is not part of a prebuilt app. Read only authored
  // inputs, and never execute a verifier supplied by the generated project.
  await verifyAuthoredInventory(projectRoot);
  runDataNode([join(root, verifier), "--authored-only", projectRoot], { cwd: projectRoot, onProgress });
  return { projectRoot, pluginRoot: root, manifest };
}

export async function localSourceVite(projectDir) {
  const projectRoot = await realDirectory(projectDir, "Data app project");
  let vitePath;
  try {
    vitePath = await realpath(join(projectRoot, "node_modules/vite/bin/vite.js"));
  } catch {
    throw new Error(
      "Explicit --source requires an already-installed local Vite toolchain. The default prebuilt build needs no npm install.",
    );
  }
  if (!isInside(projectRoot, vitePath) || !(await lstat(vitePath)).isFile()) {
    throw new Error("The explicit source-build Vite must be contained in the Data app project.");
  }
  return { projectRoot, vitePath };
}
