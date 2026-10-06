import { createHash } from "node:crypto";
import { closeSync, createReadStream, createWriteStream, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { inspectDataAppDocument } from "../skills/publish-artifact-to-sites/scripts/publication-assets.mjs";

export const SEPARATE_DATA_KIND = "separate-data-v1";
export const SEPARATE_BUILD_MANIFEST = "data-app-build.json";
export const PRESERVED_SEPARATE_DIRECTORY = ".data-app-offline/separate-v1";
const HASH = /^[a-f\d]{64}$/u;
const CHUNK_BYTES = 64 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fail() { throw new Error("The separate Data app bundle is missing, invalid, or changed. Rebuild it before continuing."); }
function parseJson(bytes) { try { return JSON.parse(bytes); } catch { fail(); } }
function decodeHtml(bytes) { try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail(); } }
function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function containedPath(root, name, { allowMissing = false } = {}) {
  if (typeof name !== "string" || !name || isAbsolute(name) || /[\\:\u0000-\u001f\u007f]/u.test(name)
    || name.split("/").some(part => !part || part === "." || part === "..")) fail();
  let path = root;
  const parts = name.split("/");
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    let entry;
    try { entry = lstatSync(path); }
    catch (error) { if (allowMissing && error.code === "ENOENT") continue; throw error; }
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) fail();
  }
  return path;
}

// Hash large files without retaining another file-sized Buffer. The source and
// bundle readers still own their ordinary input graph; this bounds this pass.
export function fingerprintDataFile(path) {
  const hash = createHash("sha256"), chunk = Buffer.allocUnsafe(CHUNK_BYTES);
  const file = openSync(path, "r");
  let bytes = 0;
  try {
    for (;;) {
      const length = readSync(file, chunk, 0, chunk.length, null);
      if (!length) break;
      bytes += length;
      hash.update(chunk.subarray(0, length));
    }
  } finally { closeSync(file); }
  return { sha256: hash.digest("hex"), bytes };
}

function keys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...expected].sort().join(",");
}

export function validateSeparateDataManifest(manifest) {
  if (!keys(manifest, ["version", "kind", "html", "snapshot", "runtimeSha256", "sourceSnapshotSha256"])
    || manifest.version !== 1 || manifest.kind !== SEPARATE_DATA_KIND
    || !HASH.test(manifest.runtimeSha256 ?? "") || !HASH.test(manifest.sourceSnapshotSha256 ?? "")) fail();
  for (const descriptor of [manifest.html, manifest.snapshot]) {
    if (!keys(descriptor, ["path", "sha256", "bytes"]) || !HASH.test(descriptor.sha256 ?? "")
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0) fail();
  }
  if (manifest.html.path !== "index.html" || manifest.snapshot.sha256 !== manifest.sourceSnapshotSha256
    || manifest.snapshot.path !== `snapshot.${manifest.snapshot.sha256}.json`) fail();
  return manifest;
}

// Share the publisher's HTML tokenizer: raw CSS/JS and inert template content
// cannot impersonate live bootstrap markers or the reviewed snapshot element.
function inspectSeparateHtml(html) {
  const inspection = inspectDataAppDocument(html), metadata = new Map();
  for (const marker of inspection.metadata) {
    if (!marker.names.some(name => name.startsWith("data-app-"))) continue;
    if (marker.names.length !== 1 || marker.contents.length !== 1 || metadata.has(marker.names[0])) fail();
    metadata.set(marker.names[0], { ...marker, value: marker.contents[0] });
  }
  if (!inspection.snapshotElement || !inspection.headOpeningEnd) fail();
  return { metadata, snapshotElement: inspection.snapshotElement };
}

export function readSeparateDataBundle({ projectDir, manifestPath = `dist/${SEPARATE_BUILD_MANIFEST}` }) {
  const projectRoot = realpathSync(projectDir);
  const projection = assertHydratedPublicationSource(projectRoot);
  if (isAbsolute(manifestPath)) manifestPath = relative(projectRoot, resolve(manifestPath)).split(sep).join("/");
  const absoluteManifest = containedPath(projectRoot, manifestPath);
  if (lstatSync(absoluteManifest).size > 65536) fail();
  const manifest = validateSeparateDataManifest(parseJson(readFileSync(absoluteManifest, "utf8")));
  if (projection && (manifest.snapshot.sha256 !== projection.sha256 || manifest.snapshot.bytes !== projection.bytes)) fail();
  const directory = dirname(manifestPath);
  const htmlPath = containedPath(projectRoot, `${directory}/${manifest.html.path}`);
  const snapshotPath = containedPath(projectRoot, `${directory}/${manifest.snapshot.path}`);
  const htmlBytes = readFileSync(htmlPath);
  if (htmlBytes.length !== manifest.html.bytes || digest(htmlBytes) !== manifest.html.sha256) fail();
  const snapshotFingerprint = fingerprintDataFile(snapshotPath);
  if (snapshotFingerprint.sha256 !== manifest.snapshot.sha256 || snapshotFingerprint.bytes !== manifest.snapshot.bytes) fail();
  const html = decodeHtml(htmlBytes);
  const inspection = inspectSeparateHtml(html);
  for (const [name, expected] of Object.entries({
    "data-app-build-layout": SEPARATE_DATA_KIND,
    "data-app-local-snapshot": manifest.snapshot.path,
    "data-app-snapshot-sha256": manifest.snapshot.sha256,
    "data-app-runtime-sha256": manifest.runtimeSha256,
    "data-app-bootstrap": "deferred-content-v1",
  })) if (inspection.metadata.get(name)?.value !== expected) fail();
  if (inspection.metadata.has("data-app-snapshot-storage")) fail();
  const embedded = parseJson(html.slice(inspection.snapshotElement.contentStart, inspection.snapshotElement.contentEnd));
  if (!embedded || typeof embedded !== "object" || Array.isArray(embedded) || !keys(embedded.queries, [])
    || Object.keys(embedded).some(key => !["id", "title", "surface", "queries"].includes(key))) fail();
  return { manifest, manifestPath: absoluteManifest, htmlPath, htmlBytes, snapshotPath };
}

export function assertHydratedPublicationSource(projectDir) {
  const marker = ".openai/data-app-publication-source.json";
  if (!pathExists(join(projectDir, marker))) return;
  try {
    const root = realpathSync(projectDir), path = containedPath(root, marker);
    if (lstatSync(path).size > 4 * 1024 * 1024) fail();
    const manifest = parseJson(readFileSync(path, "utf8"));
    if (manifest.version !== 1 || manifest.kind !== "data-app-publication-source-v1"
      || !HASH.test(manifest.sourceSnapshotSha256 ?? "") || manifest.snapshot?.sha256 !== manifest.sourceSnapshotSha256
      || !Number.isSafeInteger(manifest.snapshot.bytes) || manifest.snapshot.bytes <= 0) fail();
    const actual = fingerprintDataFile(containedPath(root, "src/data.json"));
    if (actual.sha256 !== manifest.snapshot.sha256 || actual.bytes !== manifest.snapshot.bytes) fail();
    return actual;
  } catch {
    throw new Error("This Data publication source requires its exact verified snapshot hydration before building or exporting offline. Use the authoring project for data changes.");
  }
}

export function resolveSeparateDataBundle({ projectDir }) {
  assertHydratedPublicationSource(projectDir);
  const projectRoot = realpathSync(projectDir);
  if (pathExists(join(projectRoot, "dist", SEPARATE_BUILD_MANIFEST))) return readSeparateDataBundle({ projectDir });
  const path = containedPath(projectRoot, ".data-app-assets/manifest.json");
  if (lstatSync(path).size > 65536) fail();
  const publication = parseJson(readFileSync(path, "utf8"));
  if (publication.version !== 1 || publication.source?.layout !== SEPARATE_DATA_KIND
    || publication.source.buildManifestPath !== `${PRESERVED_SEPARATE_DIRECTORY}/${SEPARATE_BUILD_MANIFEST}`) fail();
  const hostedHtml = containedPath(projectRoot, "dist/index.html");
  const current = fingerprintDataFile(hostedHtml);
  if (current.sha256 !== publication.assets?.html?.sha256 || current.bytes !== publication.assets?.html?.bytes) fail();
  const bundle = readSeparateDataBundle({ projectDir, manifestPath: publication.source.buildManifestPath });
  if (bundle.manifest.html.sha256 !== publication.source.htmlSha256
    || bundle.manifest.snapshot.sha256 !== publication.source.snapshotSha256
    || bundle.manifest.snapshot.sha256 !== publication.assets?.snapshot?.sha256
    || bundle.manifest.snapshot.bytes !== publication.assets?.snapshot?.bytes) fail();
  return bundle;
}

function supportsSnapshotChunks(html) {
  // Inspect only the final canonical bootstrap, not strings in authored code
  // or exports in the runtime bundle. Older compiled pages keep their original
  // single-element export without requiring a client upgrade.
  const start = html.lastIndexOf("<script"), end = html.indexOf("</script>", start);
  if (start < 0 || end < 0) return false;
  const script = html.slice(start, end + 9);
  const encoded = /^<script src="data:text\/javascript;charset=utf-8;base64,([A-Za-z\d+/=]+)"><\/script>$/u.exec(script);
  const source = encoded ? Buffer.from(encoded[1], "base64").toString("utf8") : script;
  return source.includes("const continuation = document.querySelectorAll('script[data-app-snapshot-chunk]');\nconst reviewedSnapshot = continuation.length ? (() => { const parser = runtime.createStreamingJsonParser();");
}

export async function exportOfflineDataApp({ projectDir, outputPath = ".data-app-offline/exports/data-app-offline.html" }) {
  const projectRoot = realpathSync(projectDir);
  const bundle = resolveSeparateDataBundle({ projectDir });
  const outputRelative = relative(projectRoot, resolve(projectRoot, outputPath)).split(sep).join("/");
  if (!outputRelative.endsWith(".html") || !outputRelative.startsWith(".data-app-offline/exports/")) {
    throw new Error("Choose an offline .html output inside the project’s .data-app-offline/exports/ directory.");
  }
  const destination = containedPath(projectRoot, outputRelative, { allowMissing: true });
  const html = decodeHtml(bundle.htmlBytes);
  const snapshotChunks = supportsSnapshotChunks(html);
  const { metadata, snapshotElement } = inspectSeparateHtml(html);
  let prefix = html.slice(0, snapshotElement.contentStart);
  for (const marker of [metadata.get("data-app-build-layout"), metadata.get("data-app-local-snapshot")].sort((a, b) => b.start - a.start)) {
    prefix = prefix.slice(0, marker.start) + prefix.slice(marker.end);
  }
  const suffix = html.slice(snapshotElement.contentEnd);
  await mkdir(dirname(destination), { recursive: true });
  const scratch = await mkdtemp(join(dirname(destination), ".data-app-export-"));
  const candidate = join(scratch, "index.html");
  const outputHash = createHash("sha256");
  let outputBytes = 0;
  async function* chunks() {
    yield prefix;
    const hash = createHash("sha256"), decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    const escape = text => text.replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
    let first = true;
    for await (const chunk of createReadStream(bundle.snapshotPath, { highWaterMark: CHUNK_BYTES })) {
      bytes += chunk.length; hash.update(chunk);
      if (bytes > bundle.manifest.snapshot.bytes) fail();
      // Separate inert elements keep the browser from creating one enormous
      // DOM string before the shared incremental parser can consume it.
      if (!first && snapshotChunks) yield '</script><script type="application/json" data-app-snapshot-chunk>';
      first = false;
      yield escape(decoder.decode(chunk, { stream: true }));
    }
    yield escape(decoder.decode());
    if (bytes !== bundle.manifest.snapshot.bytes || hash.digest("hex") !== bundle.manifest.snapshot.sha256) fail();
    yield suffix;
  }
  async function* measure(source) {
    for await (const chunk of source) {
      const bytes = Buffer.from(chunk);
      outputBytes += bytes.length; outputHash.update(bytes); yield bytes;
    }
  }
  try {
    await pipeline(chunks(), measure, createWriteStream(candidate, { flags: "wx" }));
    // Publication replacement happens only after the entire verified input was
    // streamed successfully. A failed read leaves the previous export intact.
    await rename(candidate, destination);
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { projectRoot, htmlPath: destination, htmlSha256: outputHash.digest("hex"), htmlBytes: outputBytes,
    snapshotSha256: bundle.manifest.snapshot.sha256, runtimeSha256: bundle.manifest.runtimeSha256, offline: true };
}
