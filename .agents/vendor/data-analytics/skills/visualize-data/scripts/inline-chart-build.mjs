import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";

import { readPrebuiltArtifact, readPrebuiltManifest } from "../../../scripts/data-app-runtime.mjs";
import { assertReplacementSafe, MAX_INLINE_FRAGMENT_BYTES } from "./inline-chart-input.mjs";
import { inlineFamilyArtifacts } from "../../../templates/data-app/inline/chart-families.mjs";

export const DATA_PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// Keep the legacy cache location reserved: older plugin versions may still
// share it, and reviewed chart payloads must never be written there.
export function defaultInlineCacheDir() {
  const parent =
    process.env.XDG_CACHE_HOME ||
    (platform() === "win32" ? process.env.LOCALAPPDATA : undefined) ||
    join(homedir(), ".cache");
  return join(parent, "codex", "data-inline-chart");
}

export function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Resolve aliases even when the final directory has not been created yet. */
export async function canonicalInlinePath(path, depth = 0) {
  if (depth > 40) throw new Error("Too many symlinks in inline-chart path.");
  let current = resolve(path);
  const missing = [];
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const entry = await lstat(current).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (entry?.isSymbolicLink()) {
        return canonicalInlinePath(
          join(resolve(dirname(current), await readlink(current)), ...missing.reverse()),
          depth + 1,
        );
      }
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** Verify that the shipped runtime still matches the protected plugin source. */
export async function inlineSourceState(pluginRoot = DATA_PLUGIN_ROOT, artifactName = "inline") {
  pluginRoot = await realpath(resolve(pluginRoot));
  const manifest = await readPrebuiltManifest(pluginRoot);
  return { pluginRoot, manifest, runtimeKey: manifest.artifacts[artifactName].sha256 };
}

export async function prepareInlineRuntime({
  pluginRoot = DATA_PLUGIN_ROOT,
  cacheDir = process.env.DATA_INLINE_CACHE_DIR || defaultInlineCacheDir(),
  offline = false,
  requireDependencies = false,
  onProgress = () => {},
  artifactName = "inline",
} = {}) {
  if (!["inline", "receipt", ...Object.values(inlineFamilyArtifacts)].includes(artifactName)) throw new Error("Unknown inline Data runtime.");
  // These options remain accepted by existing callers. The renderer is now a
  // release artifact: preparation never creates a cache or installs packages.
  void offline;
  void requireDependencies;
  pluginRoot = await realpath(resolve(pluginRoot));
  const legacyCacheDir = await canonicalInlinePath(cacheDir);
  if (isInside(pluginRoot, legacyCacheDir)) throw new Error("Use a cache outside the installed Data plugin.");

  const { manifest } = await inlineSourceState(pluginRoot, artifactName);
  const artifact = await readPrebuiltArtifact(artifactName, { pluginRoot, manifest });
  const { code, path, sha256, bytes } = artifact;
  // Release-time compilation already performs the AST-preserving rewrite.
  // Recheck the embedding contract without loading a customer-side compiler.
  new Script(code, { filename: path });
  assertReplacementSafe(code);
  if (/<\/script/iu.test(code)) throw new Error("The prebuilt inline runtime contains an unsafe script terminator.");
  if (bytes >= MAX_INLINE_FRAGMENT_BYTES)
    throw new Error("The shared inline runtime exceeds 1 MB. Reinstall a valid Data plugin release.");
  onProgress("Verified the prebuilt Data inline runtime; no dependency installation or build is needed.");

  return {
    code,
    path,
    metadata: {
      ...manifest.artifacts[artifactName].metadata,
      format: 2,
      key: sha256,
      sha256,
      bytes,
      source: "prebuilt",
    },
    prebuilt: true,
    cacheHit: false,
    cacheDir: null,
    legacyCacheDir,
  };
}
