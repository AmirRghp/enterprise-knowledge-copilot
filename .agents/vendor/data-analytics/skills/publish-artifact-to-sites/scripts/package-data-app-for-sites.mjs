#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { parseJsonBytes } from "../../../templates/data-app/base/src/streaming-json.js";
import { readSeparateDataBundle } from "../../../scripts/data-app-separate.mjs";
import { assertNoPublicationSecrets } from "./publication-secrets.mjs";
import { createPublicationAssets, documentSnapshot, inspectDataAppDocument, OFFLINE_HTML_PATH, PUBLICATION_ASSET_DIRECTORY, publicationUploadAuthorization, snapshotResponseFingerprint, snapshotSeedFingerprint } from "./publication-assets.mjs";
import { createPublicationSnapshotIndex } from "./publication-snapshot-index.mjs";

// Package the existing page without repeating authoring checks or rebuilding it.
// Publication checks cover file scope, accidental secrets, and legacy data pairing.
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function parseJson(bytes, options) {
  try {
    return parseJsonBytes(typeof bytes === "string" ? Buffer.from(bytes) : bytes, options);
  } catch {
    // Parser errors can include excerpts containing the credential being rejected.
    throw new Error("Data publication inputs must contain valid JSON.");
  }
}
const readJson = (path) => parseJson(readFileSync(path));
function within(root, path) {
  const location = relative(root, path);
  return !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`);
}

function projectInput(projectRoot, path) {
  const input = realpathSync(resolve(projectRoot, path));
  if (!within(projectRoot, input) || !lstatSync(input).isFile()) {
    throw new Error(
      "Publication inputs must be regular files inside the selected project, including through symlinks.",
    );
  }
  return input;
}

export { documentSnapshot } from "./publication-assets.mjs";

function writePackage(outputs, projectRoot) {
  // File scope is independent of content validation: never follow a project
  // output symlink into unrelated files when writing the package.
  for (const [output] of outputs) {
    if (!within(projectRoot, output)) throw new Error("Package outputs must stay inside the project.");
    for (let path = output; path !== projectRoot; path = dirname(path)) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error("Package outputs must not follow symlinks.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  if (new Set(outputs.map(([path]) => path)).size !== outputs.length) {
    throw new Error("Package outputs must have distinct paths.");
  }
  // Stage new files and retain prior files on disk. Reading every prior output
  // as a rollback Buffer can multiply the complete dataset's memory footprint.
  const transaction = mkdtempSync(join(projectRoot, ".data-app-package-"));
  const changed = [];
  try {
    for (const [index, [, bytes]] of outputs.entries()) {
      if (bytes === null) continue;
      const staged = join(transaction, `new-${index}`);
      writeFileSync(staged, bytes);
    }
    for (const [index, [path, bytes]] of outputs.entries()) {
      mkdirSync(dirname(path), { recursive: true });
      const previous = join(transaction, `old-${index}`);
      const existed = existsSync(path);
      if (existed) {
        if (!lstatSync(path).isFile()) throw new Error("Package outputs must replace regular files.");
        renameSync(path, previous);
      }
      changed.push({ path, previous, existed });
      if (bytes !== null) renameSync(join(transaction, `new-${index}`), path);
    }
  } catch (error) {
    const failures = [error];
    for (const { path, previous, existed } of changed.reverse()) {
      try {
        rmSync(path, { force: true });
        if (existed) renameSync(previous, path);
      } catch (restoreError) {
        failures.push(restoreError);
      }
    }
    if (failures.length > 1)
      throw new AggregateError(failures, `Packaging failed; some output files could not be restored. Recovery files remain in ${transaction}.`);
    rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
  try { rmSync(transaction, { recursive: true, force: true }); }
  catch {
    throw Object.assign(new Error("Package outputs were installed, but temporary backup cleanup failed. Resolve the project-local .data-app-package directory before publishing."), { code: "PACKAGE_CLEANUP_REQUIRED" });
  }
}

export function packageDataAppForSites(values, runtimeRoot = pluginRoot) {
  if (values["query-loading"] !== undefined && (values["query-loading"] !== "on-demand" || values.source)) {
    throw new Error("--query-loading on-demand is supported only for existing separate-data builds.");
  }
  if (!values["project-dir"] || !values["project-id"]) throw new Error("--project-dir and --project-id are required.");
  if (Object.hasOwn(values, "capture-file")) throw new Error("Unsupported publication option: --capture-file.");
  if (Object.hasOwn(values, "owner-email")) {
    throw new Error("--owner-email is no longer supported. Initialize DATA_APP_OWNER_EMAIL_SHA256 once in Site environment settings before deployment; preserve it when republishing.");
  }
  const projectRoot = realpathSync(values["project-dir"]);
  const projectId = values["project-id"];
  const htmlPath = projectInput(projectRoot, values["html-file"] ?? "dist/index.html");
  let htmlBytes = readFileSync(htmlPath);
  let separateBundle;
  const assetManifestPath = join(projectRoot, PUBLICATION_ASSET_DIRECTORY, "manifest.json");
  const offlineHtmlPath = join(projectRoot, OFFLINE_HTML_PATH);
  // A prior publication replaces only the default compiled entry with its thin
  // hosted variant. Repackage that exact reviewed page from its verified offline
  // counterpart; never treat the metadata-only bootstrap as the full dataset.
  if (htmlPath === join(projectRoot, "dist/index.html") && existsSync(assetManifestPath)) {
    const previous = readJson(projectInput(projectRoot, assetManifestPath));
    if (previous.version === 1 && previous.thinBootstrap === true && previous.assets?.html?.sha256 === sha256(htmlBytes)) {
      if (previous.projectId !== projectId) {
        throw new Error("The thin Data app package does not match its offline source or Site identity.");
      }
      if (previous.source?.layout === "separate-data-v1") {
        if (previous.source.buildManifestPath !== ".data-app-offline/separate-v1/data-app-build.json") {
          throw new Error("The thin Data app package does not match its preserved separate build.");
        }
        separateBundle = readSeparateDataBundle({ projectDir: projectRoot, manifestPath: previous.source.buildManifestPath });
        if (separateBundle.manifest.html.sha256 !== previous.source.htmlSha256
          || separateBundle.manifest.snapshot.sha256 !== previous.source.snapshotSha256
          || previous.source.snapshotSha256 !== previous.assets.snapshot.sha256) {
          throw new Error("The preserved separate Data app changed after publication. Rebuild before packaging.");
        }
        htmlBytes = separateBundle.htmlBytes;
      } else {
        if (previous.source?.offlineHtmlPath !== OFFLINE_HTML_PATH) {
          throw new Error("The thin Data app package does not match its offline source or Site identity.");
        }
        const original = readFileSync(projectInput(projectRoot, offlineHtmlPath));
        if (sha256(original) !== previous.source.htmlSha256) {
          throw new Error("The original offline Data app changed after publication. Rebuild before packaging.");
        }
        htmlBytes = original;
      }
    }
  }
  const html = htmlBytes.toString("utf8");
  if (!separateBundle && (existsSync(join(dirname(htmlPath), "data-app-build.json"))
    || inspectDataAppDocument(html).metadata.some(meta => meta.names.some(name => ["data-app-build-layout", "data-app-local-snapshot"].includes(name))))) {
    separateBundle = readSeparateDataBundle({ projectDir: projectRoot, manifestPath: join(dirname(htmlPath), "data-app-build.json") });
    if (separateBundle.htmlPath !== htmlPath || separateBundle.manifest.html.sha256 !== sha256(htmlBytes)) {
      throw new Error("The separate Data app manifest does not match the selected compiled page.");
    }
  }
  if (separateBundle && htmlPath !== join(projectRoot, "dist/index.html")) {
    throw new Error("Separate-data publication requires the compiled dist/index.html entry; nested split builds are unsupported.");
  }
  const hostingPath = join(projectRoot, ".openai/hosting.json");
  const hosting = existsSync(hostingPath) ? readJson(projectInput(projectRoot, hostingPath)) : {};
  if (hosting.project_id && hosting.project_id !== projectId)
    throw new Error("Use the project's existing Site ID; this command does not transfer Sites.");
  const deploymentUploadAuthorization = publicationUploadAuthorization(values);

  // Prefer what the compiled page actually contains, even when src/data.json
  // was edited later. Legacy source builds do not contain this JSON element.
  const { embedded, hashes, snapshotChunks } = documentSnapshot(html);
  let reviewedSnapshotBytes;
  const parseOptions = { discard: path => path.length === 3 && path[0] === "queries" && path[2] === "rows" };
  if (separateBundle) {
    reviewedSnapshotBytes = readFileSync(projectInput(projectRoot, separateBundle.snapshotPath));
    if (sha256(reviewedSnapshotBytes) !== separateBundle.manifest.snapshot.sha256) {
      throw new Error("The separate Data snapshot changed during packaging.");
    }
    Object.assign(parseOptions, { fatal: true, ignoreBOM: false });
  } else if (embedded !== undefined) {
    reviewedSnapshotBytes = snapshotChunks ? Buffer.concat(snapshotChunks.map(chunk => Buffer.from(chunk))) : Buffer.from(embedded);
  } else {
    reviewedSnapshotBytes = readFileSync(projectInput(projectRoot, "src/data.json"));
    if (hashes.length !== 1 || hashes[0] !== sha256(reviewedSnapshotBytes)) {
      throw new Error(
        "Legacy HTML must contain exactly one matching snapshot fingerprint in its head. Rebuild the reviewed page before publishing.",
      );
    }
  }
  const seedSnapshot = parseJson(reviewedSnapshotBytes, parseOptions);
  if (!isUtf8(reviewedSnapshotBytes)) {
    // Legacy byte inputs used Buffer.toString's replacement decoding. Preserve
    // that contract before indexing normalized UTF-8, without a complete string.
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true }), chunks = [];
    for (let offset = 0; offset < reviewedSnapshotBytes.length; offset += 64 * 1024) {
      chunks.push(Buffer.from(decoder.decode(reviewedSnapshotBytes.subarray(offset, offset + 64 * 1024), { stream: true })));
    }
    chunks.push(Buffer.from(decoder.decode()));
    reviewedSnapshotBytes = Buffer.concat(chunks);
  }
  const indexedSource = createPublicationSnapshotIndex(reviewedSnapshotBytes);
  const indexedSnapshot = { bytes: reviewedSnapshotBytes, snapshotIndex: indexedSource.snapshotIndex };
  const artifactSurface = seedSnapshot.surface === undefined ? "dashboard" : seedSnapshot.surface;
  if (!["dashboard", "report"].includes(artifactSurface)) {
    throw new Error("The reviewed Data app surface must be dashboard or report.");
  }
  const generatedAt = seedSnapshot.generatedAt ?? null;
  const requestedPresentation = values["presentation-file"]
    ? readJson(projectInput(projectRoot, values["presentation-file"]))
    : {};
  // Compact handoffs omit these empty collections. Restore the complete seed
  // only for supplied objects; explicit values still belong to the validator.
  const initialPresentation = values["presentation-file"] && requestedPresentation !== null
    && typeof requestedPresentation === "object" && !Array.isArray(requestedPresentation)
    ? { hiddenBlocks: [], componentTitles: {}, textEdits: {}, chartOverrides: {}, ...requestedPresentation }
    : requestedPresentation;
  const scanStats = assertNoPublicationSecrets({ html, snapshotBytes: reviewedSnapshotBytes, seedSnapshot, initialPresentation });
  // This is handoff metadata, not persisted presentation. Do not compare it to
  // the snapshot or run the Data presentation validator during publication.
  delete initialPresentation.filterDefinitions;
  const runtime = readFileSync(join(runtimeRoot, "assets/data-app-runtime/worker.mjs"), "utf8");
  const assets = createPublicationAssets({ html, seedSnapshot, projectId, indexedSnapshot, queryLoading: values["query-loading"],
    ...(separateBundle ? { snapshotBytes: reviewedSnapshotBytes } : {}), separateData: Boolean(separateBundle) });
  const { snapshotIndex, snapshotResponse } = separateBundle ? indexedSource : createPublicationSnapshotIndex(assets.bytes.snapshot);
  // Stored query edits are keyed by parsed seed identity. Raw source whitespace
  // belongs to source recovery, and must not create a new database generation.
  const seedSnapshotSha256 = separateBundle ? snapshotSeedFingerprint(seedSnapshot, indexedSnapshot).sha256 : assets.deploymentAssets.snapshot.sha256;
  const buildManifestPath = separateBundle ? ".data-app-offline/separate-v1/data-app-build.json" : undefined;
  const assetFiles = { html: join(projectRoot, PUBLICATION_ASSET_DIRECTORY, "html.html"), snapshot: join(projectRoot, PUBLICATION_ASSET_DIRECTORY, "snapshot.json") };
  const assetManifest = {
    version: 1, projectId, artifactId: seedSnapshot.id,
    assets: Object.fromEntries(Object.entries(assets.deploymentAssets).map(([kind, descriptor]) => [kind, { ...descriptor, path: kind === "html" ? "html.html" : "snapshot.json" }])),
    thinBootstrap: assets.thinBootstrap,
    ...(assets.queryLoading ? { queryLoading: assets.queryLoading } : {}),
    snapshotResponse,
    // Populated v2 databases preserve their serializer and any owner edits.
    // Both exact readback encodings derive from this same reviewed source.
    legacySnapshotResponse: snapshotResponseFingerprint(seedSnapshot, indexedSnapshot),
    ...(separateBundle ? { seedSnapshotSha256 } : {}),
    source: separateBundle
      ? { layout: "separate-data-v1", htmlSha256: sha256(htmlBytes), snapshotSha256: separateBundle.manifest.snapshot.sha256, buildManifestPath }
      : { htmlSha256: sha256(htmlBytes), offlineHtmlPath: OFFLINE_HTML_PATH },
  };
  const configuration = { deploymentAssets: assets.deploymentAssets, snapshotIndex, projectId, initialPresentation,
    ...(separateBundle ? { seedSnapshotSha256 } : {}),
    ...(deploymentUploadAuthorization ? { deploymentUploadAuthorization } : {}) };
  const encoded = JSON.stringify(JSON.stringify(configuration))
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  const worker = `${runtime}\nexport default createDataAppWorker(JSON.parse(${encoded}));\n`;
  const manifest = { ...hosting, project_id: projectId, d1: "DB", r2: "BUCKET" };
  delete manifest.static;
  const hostingBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const distHostingBytes = `${JSON.stringify(
    { ...manifest, artifact_metadata: { surface: artifactSurface, producer: "data-analytics" } },
    null,
    2,
  )}\n`;
  const serverPath = join(projectRoot, "dist/server/index.js");
  writePackage(
    [
      [serverPath, worker],
      ...(separateBundle ? [
        [join(projectRoot, ".data-app-offline/separate-v1/index.html"), htmlBytes],
        [join(projectRoot, ".data-app-offline/separate-v1", separateBundle.manifest.snapshot.path), reviewedSnapshotBytes],
        [join(projectRoot, buildManifestPath), `${JSON.stringify(separateBundle.manifest, null, 2)}\n`],
      ] : [[offlineHtmlPath, htmlBytes]]),
      [assetFiles.html, assets.bytes.html],
      [assetFiles.snapshot, assets.bytes.snapshot],
      [assetManifestPath, `${JSON.stringify(assetManifest, null, 2)}\n`],
      ...(assets.thinBootstrap && htmlPath === join(projectRoot, "dist/index.html") ? [[htmlPath, assets.bytes.html]] : []),
      ...(separateBundle && separateBundle.manifestPath === join(projectRoot, "dist/data-app-build.json") ? [
        [separateBundle.manifestPath, null], [separateBundle.snapshotPath, null],
      ] : []),
      [hostingPath, hostingBytes],
      [join(projectRoot, "dist/.openai/hosting.json"), distHostingBytes],
    ],
    projectRoot,
  );
  return {
    projectRoot,
    projectId,
    htmlPath,
    serverPath,
    htmlSha256: sha256(htmlBytes),
    hostedHtmlSha256: assets.deploymentAssets.html.sha256,
    snapshotSha256: assets.deploymentAssets.snapshot.sha256,
    offlineHtmlPath: separateBundle ? null : offlineHtmlPath,
    ...(separateBundle ? { buildManifestPath: join(projectRoot, buildManifestPath), seedSnapshotSha256, layout: "separate-data-v1" } : {}),
    assetManifestPath,
    assetFiles,
    deploymentAssets: assets.deploymentAssets,
    thinBootstrap: assets.thinBootstrap,
    ...(assets.queryLoading ? { queryLoading: assets.queryLoading } : {}),
    workerBytes: Buffer.byteLength(worker),
    externalAssetBytes: assets.deploymentAssets.html.bytes + assets.deploymentAssets.snapshot.bytes,
    generatedAt,
    snapshotSource: separateBundle ? "separate-data-manifest" : embedded !== undefined ? "compiled-html" : "src/data.json",
    ownerAuthorization: "environment",
    ownerEnvironmentVariable: "DATA_APP_OWNER_EMAIL_SHA256",
    databaseBinding: "DB",
    assetBinding: "BUCKET",
    buildMode: "existing-page",
    scanStats,
  };
}

let entryPath;
if (process.argv[1] && process.argv[1] !== "-") {
  try { entryPath = realpathSync(process.argv[1]); }
  catch { /* Imports from stdin or an unavailable entry path do not run the CLI. */ }
}
if (entryPath === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "project-dir": { type: "string" },
      "project-id": { type: "string" },
      "html-file": { type: "string" },
      "presentation-file": { type: "string" },
      "deployment-token-sha256": { type: "string" },
      "deployment-token-expires-at": { type: "string" },
      "query-loading": { type: "string" },
      source: { type: "boolean", default: false },
      "migrate-packaging-manifest": { type: "boolean" },
    },
    strict: true,
  });
  if (values["migrate-packaging-manifest"] && !values.source) {
    throw new Error("Packaging manifest migration applies only to explicit --source publication.");
  }
  if (values.source) {
    if (values["query-loading"] !== undefined) {
      throw new Error("--query-loading is not supported by custom source Worker packaging.");
    }
    // Source/custom Workers retain their existing compilation and scoped
    // migration flow. The normal existing-page path never invokes it.
    const project = resolve(values["project-dir"] ?? ".");
    if (values["html-file"] && resolve(project, values["html-file"]) !== join(project, "dist/index.html")) {
      throw new Error("Source publication uses the custom Worker's existing dist/index.html input.");
    }
    const args = Object.entries(values).flatMap(([key, value]) =>
      key === "html-file" || value === false ? [] : value === true ? [`--${key}`] : [`--${key}=${value}`],
    );
    const result = spawnSync(
      process.execPath,
      [join(dirname(fileURLToPath(import.meta.url)), "package-data-app-for-sites-source.mjs"), ...args],
      { stdio: "inherit" },
    );
    if (result.error) throw new Error("Data source packaging failed.");
    process.exit(result.status ?? 1);
  }
  console.log(JSON.stringify(packageDataAppForSites(values)));
}
