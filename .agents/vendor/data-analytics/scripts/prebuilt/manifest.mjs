import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { sortedObject, validateReleaseLock } from "./release-lock.mjs";
import { inlineFamilyArtifacts } from "../../templates/data-app/inline/chart-families.mjs";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST_FORMAT = 1;
export const API_VERSION = 1;
export const RUNTIME_MODULE_SPECIFIERS = Object.freeze([
  "@openai/data-app",
  "react",
  "react-dom",
  "react-dom/client",
  "react-markdown",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "recharts",
]);
export const INLINE_CANONICAL_MODULES = Object.freeze([
  "src/charting/ChartRenderer.jsx",
  "src/components/ChartEditor.jsx",
  "src/components/ChartExplorer.jsx",
]);
export const RECEIPT_CANONICAL_MODULES = Object.freeze([
  "src/components/SourceInspector.jsx",
  "src/components/SourcesReceipt.jsx",
]);
export const ARTIFACT_PATHS = Object.freeze({
  app: "app.js",
  styles: "styles.css",
  print: "print.css",
  inline: "inline.js",
  ...Object.fromEntries(Object.values(inlineFamilyArtifacts).map(name => [name, `${name}.js`])),
  receipt: "receipt.js",
  worker: "worker.mjs",
  compiler: "compiler.cjs",
  notices: "THIRD_PARTY_NOTICES.txt",
});

export const RELEASE_INPUTS = Object.freeze([
  "assets/datascience-small.svg",
  "scripts/prebuilt/build.mjs",
  "scripts/prebuilt/compiler-entry.mjs",
  "scripts/prebuilt/license-overrides.json",
  "scripts/prebuilt/manifest.mjs",
  "scripts/prebuilt/package.json",
  "scripts/prebuilt/package-lock.json",
  "scripts/prebuilt/refresh-lock.mjs",
  "scripts/prebuilt/release-lock.mjs",
  "skills/visualize-data/assets/inline-chart-fragment.html",
  "skills/visualize-data/assets/inline-sources-fragment.html",
  "skills/visualize-data/assets/inline-sources-example.json",
  "skills/visualize-data/scripts/inline-chart-input.mjs",
  "skills/visualize-data/scripts/inline-sources-input.mjs",
  "skills/visualize-data/scripts/render-inline-chart.mjs",
  "skills/visualize-data/scripts/render-inline-sources.mjs",
  "skills/visualize-data/scripts/replacement-safe-javascript.mjs",
  "templates/data-app/themes/codex-classic/theme.css",
]);

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function validateRelativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    /[:\u0000-\u001f\u007f]/u.test(value) ||
    isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid prebuilt source path: ${String(value)}`);
  return value;
}

export function isInside(parent, child) {
  const result = relative(resolve(parent), resolve(child));
  return result === "" || (result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result));
}

export async function readRegularFile(root, name) {
  validateRelativePath(name);
  let current = resolve(root);
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const entry = await lstat(current);
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      throw new Error(`Prebuilt input must be a regular, nonsymlinked file: ${name}`);
    }
  }
  return readFile(current);
}

async function filesUnder(root, prefix) {
  const result = [];
  async function visit(name) {
    const entries = (await readdir(join(root, name), { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const next = `${name}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`Prebuilt source cannot contain symlinks: ${next}`);
      if (entry.isDirectory()) await visit(next);
      else if (entry.isFile()) result.push(next);
      else throw new Error(`Unsupported prebuilt source file: ${next}`);
    }
  }
  await visit(prefix);
  return result;
}

export async function readSourceState(pluginRoot = PLUGIN_ROOT) {
  pluginRoot = resolve(pluginRoot);
  const base = "templates/data-app/base";
  const protectedBytes = await readRegularFile(pluginRoot, `${base}/protected-runtime.json`);
  const protectedManifest = JSON.parse(protectedBytes);
  if (protectedManifest.version !== 1 || !protectedManifest.files || Array.isArray(protectedManifest.files)) {
    throw new Error("Invalid canonical protected-runtime manifest.");
  }
  const names = new Set([
    `${base}/protected-runtime.json`,
    ...Object.keys(protectedManifest.files).map((name) => `${base}/${validateRelativePath(name)}`),
    ...(await filesUnder(pluginRoot, "templates/data-app/inline")),
    ...(await filesUnder(pluginRoot, "scripts/prebuilt/licenses")),
    ...RELEASE_INPUTS,
  ]);
  for (const required of [
    "docs/components/README.md",
    "src/prebuilt-runtime-entry.jsx",
    "src/data-app-worker.js",
    "src/styles.css",
    "src/print.css",
  ]) {
    if (!Object.hasOwn(protectedManifest.files, required)) {
      throw new Error(`Refresh the canonical protected runtime before rebuilding: ${required}`);
    }
  }
  const files = new Map();
  for (const name of [...names].sort()) files.set(name, await readRegularFile(pluginRoot, name));
  const buildInputs = sortedObject(Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])));
  for (const [name, hash] of Object.entries(protectedManifest.files)) {
    if (buildInputs[`${base}/${name}`] !== hash) {
      throw new Error(`Canonical protected runtime is stale: ${name}. Refresh it before rebuilding prebuilt assets.`);
    }
  }
  const sourcePackage = JSON.parse(files.get(`${base}/package.json`));
  const sourceLock = JSON.parse(files.get(`${base}/package-lock.json`));
  const packageJson = JSON.parse(files.get("scripts/prebuilt/package.json"));
  const lock = JSON.parse(files.get("scripts/prebuilt/package-lock.json"));
  validateReleaseLock(sourcePackage, sourceLock, packageJson, lock);
  return {
    pluginRoot,
    files,
    sourcePackage,
    sourceLock,
    packageJson,
    lock,
    buildInputs,
    source: {
      packageSha256: buildInputs[`${base}/package.json`],
      lockSha256: buildInputs[`${base}/package-lock.json`],
      protectedRuntimeSha256: sha256(protectedBytes),
      buildInputsSha256: sha256(JSON.stringify(buildInputs)),
    },
  };
}

/** Validate publisher-derived own export names without evaluating browser code. */
export function validateRuntimeModuleExports(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Reflect.ownKeys(value) : null;
  if (
    !keys ||
    keys.some((key) => typeof key !== "string") ||
    !isDeepStrictEqual(keys.sort(), RUNTIME_MODULE_SPECIFIERS)
  )
    throw new Error("Invalid prebuilt runtime module export map.");
  const entries = [];
  for (const specifier of RUNTIME_MODULE_SPECIFIERS) {
    const names = value[specifier];
    if (!Array.isArray(names) || names.length < 1 || names.length > 1024) {
      throw new Error(`Invalid prebuilt runtime exports for ${specifier}.`);
    }
    let previous;
    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (
        !Object.hasOwn(names, index) ||
        typeof name !== "string" ||
        !name ||
        name.length > 256 ||
        /[\u0000-\u001f\u007f]/u.test(name) ||
        (previous !== undefined && previous >= name)
      )
        throw new Error(`Invalid or unsorted prebuilt runtime export name for ${specifier}.`);
      previous = name;
    }
    if (!names.includes("default") || !names.includes("__esModule")) {
      throw new Error(`Prebuilt runtime exports lack interop names for ${specifier}.`);
    }
    entries.push([specifier, Object.freeze([...names])]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function validateAppMetadata(metadata) {
  if (
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !isDeepStrictEqual(Reflect.ownKeys(metadata), ["moduleExports"])
  ) {
    throw new Error("Invalid release-time app runtime metadata.");
  }
  return { moduleExports: validateRuntimeModuleExports(metadata.moduleExports) };
}

function validateInlineMetadata(metadata, canonicalModules = INLINE_CANONICAL_MODULES) {
  if (
    !metadata ||
    !isDeepStrictEqual(Object.keys(metadata).sort(), [
      "canonicalModules",
      "dynamicImports",
      "encodedTokens",
      "externalImports",
    ]) ||
    !isDeepStrictEqual(metadata.canonicalModules, canonicalModules) ||
    !isDeepStrictEqual(metadata.externalImports, []) ||
    !isDeepStrictEqual(metadata.dynamicImports, []) ||
    !Number.isSafeInteger(metadata.encodedTokens) ||
    metadata.encodedTokens < 0
  )
    throw new Error("Invalid release-time inline runtime diagnostics.");
  return structuredClone(metadata);
}

export function makeManifest(state, artifacts, { appMetadata, inlineMetadata, inlineFamilyMetadata = {}, receiptMetadata } = {}) {
  if (!isDeepStrictEqual(Object.keys(artifacts).sort(), Object.keys(ARTIFACT_PATHS).sort())) {
    throw new Error("Prebuilt runtime must contain precisely the required artifacts.");
  }
  const verifiedAppMetadata = validateAppMetadata(appMetadata);
  return {
    format: MANIFEST_FORMAT,
    apiVersion: API_VERSION,
    source: state.source,
    buildInputs: state.buildInputs,
    artifacts: Object.fromEntries(
      Object.entries(ARTIFACT_PATHS).map(([name, path]) => {
        const bytes = Buffer.isBuffer(artifacts[name]) ? artifacts[name] : Buffer.from(artifacts[name]);
        return [
          name,
          {
            path,
            sha256: sha256(bytes),
            bytes: bytes.length,
            ...(name === "app" ? { metadata: verifiedAppMetadata } : {}),
            ...(name === "inline" && inlineMetadata !== undefined
              ? { metadata: validateInlineMetadata(inlineMetadata) }
              : {}),
            ...(inlineFamilyMetadata[name] !== undefined
              ? { metadata: validateInlineMetadata(inlineFamilyMetadata[name]) } : {}),
            ...(name === "receipt" && receiptMetadata !== undefined
              ? { metadata: validateInlineMetadata(receiptMetadata, RECEIPT_CANONICAL_MODULES) }
              : {}),
          },
        ];
      }),
    ),
  };
}

export async function verifyAssets({
  pluginRoot = PLUGIN_ROOT,
  assetDir = join(pluginRoot, "assets/data-app-runtime"),
} = {}) {
  const state = await readSourceState(pluginRoot);
  const manifest = JSON.parse(await readRegularFile(assetDir, "manifest.json"));
  if (manifest.format !== MANIFEST_FORMAT || manifest.apiVersion !== API_VERSION) {
    throw new Error("Unsupported prebuilt Data runtime manifest.");
  }
  if (
    !isDeepStrictEqual(manifest.source, state.source) ||
    !isDeepStrictEqual(manifest.buildInputs, state.buildInputs)
  ) {
    throw new Error("Prebuilt Data runtime assets are stale; rebuild scripts/prebuilt/build.mjs.");
  }
  const artifacts = {};
  for (const [name, filename] of Object.entries(ARTIFACT_PATHS)) {
    const entry = manifest.artifacts?.[name];
    if (entry?.path !== filename) throw new Error(`Invalid prebuilt artifact path: ${name}`);
    artifacts[name] = await readRegularFile(assetDir, filename);
  }
  if (
    !isDeepStrictEqual(
      manifest,
      makeManifest(state, artifacts, {
        appMetadata: manifest.artifacts.app.metadata,
        inlineMetadata: manifest.artifacts.inline.metadata,
        inlineFamilyMetadata: Object.fromEntries(Object.values(inlineFamilyArtifacts)
          .map(name => [name, manifest.artifacts[name].metadata])),
        receiptMetadata: manifest.artifacts.receipt.metadata,
      }),
    )
  ) {
    throw new Error("Prebuilt Data runtime artifact integrity does not match its manifest.");
  }
  return manifest;
}
