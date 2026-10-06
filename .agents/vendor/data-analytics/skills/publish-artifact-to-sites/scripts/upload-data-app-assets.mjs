import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { finished, pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGzip } from "node:zlib";

const kinds = ["html", "snapshot"];
const sha256Pattern = /^[a-f\d]{64}$/u;

async function digestStream(stream, maximumBytes = Infinity) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new Error("The response exceeds its expected byte length.");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function validFingerprint(value) {
  return value && sha256Pattern.test(value.sha256)
    && Number.isSafeInteger(value.bytes) && value.bytes > 0;
}

function matches(actual, expected) {
  return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
}

// Site identity and credentials are supplied from the connected Sites tools.
// Only this exact origin receives them; redirects are always rejected.
export async function uploadDataAppAssets({ projectDir, projectId, siteUrl, deploymentToken,
  sitesAuthorization, timeoutMs = 900000 }, { request = fetch, gzipThresholdBytes = 256 * 1024 * 1024 } = {}) {
  const origin = new URL(siteUrl);
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Use the exact HTTPS Site origin returned by get_site.");
  }
  if (typeof deploymentToken !== "string" || deploymentToken.length < 32 || deploymentToken.length > 256
    || typeof sitesAuthorization !== "string" || !sitesAuthorization || /[\r\n]/u.test(sitesAuthorization)) {
    throw new Error("Transient deployment and Sites authorization tokens are required.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) {
    throw new Error("The request timeout must be between one second and fifteen minutes.");
  }
  if (!Number.isSafeInteger(gzipThresholdBytes) || gzipThresholdBytes < 1) {
    throw new Error("The gzip threshold must be a positive safe integer byte count.");
  }
  const root = await realpath(projectDir);
  const directory = await realpath(path.join(root, ".data-app-assets"));
  if (path.dirname(directory) !== root) throw new Error("Publication assets must remain inside the selected project.");
  const manifestPath = await realpath(path.join(directory, "manifest.json"));
  const manifestStat = await stat(manifestPath);
  if (path.dirname(manifestPath) !== directory || !manifestStat.isFile() || manifestStat.size > 65536) {
    throw new Error("The publication asset manifest is invalid.");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.version !== 1 || !projectId || manifest.projectId !== projectId
    || !validFingerprint(manifest.snapshotResponse)) {
    throw new Error("The publication manifest does not match the selected Site or lacks its readback fingerprint.");
  }
  const snapshotCandidates = [{ label: "snapshotResponse", fingerprint: manifest.snapshotResponse }];
  if (Object.hasOwn(manifest, "legacySnapshotResponse")) {
    const legacy = manifest.legacySnapshotResponse;
    if (!validFingerprint(legacy) || !["queryCount", "rowCount"].every(key =>
      Number.isSafeInteger(legacy[key]) && legacy[key] >= 0 && legacy[key] === manifest.snapshotResponse[key])) {
      throw new Error("The legacy readback fingerprint must describe the same complete reviewed snapshot.");
    }
    snapshotCandidates.push({ label: "legacySnapshotResponse", fingerprint: legacy });
  }
  const files = {};
  // Verify both local payloads before making any upload request.
  for (const kind of kinds) {
    const descriptor = manifest.assets?.[kind];
    if (!validFingerprint(descriptor) || descriptor.key !== `data-app/${kind}/${descriptor.sha256}`
      || typeof descriptor.path !== "string" || path.basename(descriptor.path) !== descriptor.path) {
      throw new Error(`The ${kind} asset descriptor is invalid.`);
    }
    const file = await realpath(path.join(directory, descriptor.path));
    const info = await stat(file);
    if (path.dirname(file) !== directory || !info.isFile() || info.size !== descriptor.bytes
      || !matches(await digestStream(createReadStream(file), descriptor.bytes), descriptor)) {
      throw new Error(`The ${kind} asset failed local integrity verification.`);
    }
    files[kind] = file;
  }
  const authorization = { "OAI-Sites-Authorization": `Bearer ${sitesAuthorization}` };
  const send = async (pathname, options) => {
    let response;
    try {
      response = await request(new URL(pathname, origin), { ...options,
        redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new Error(`The Site request failed at ${pathname}; credentials and response bodies were omitted.`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The Site returned HTTP ${response.status} at ${pathname}.`);
    }
    return response;
  };
  const uploads = [];
  for (const kind of kinds) {
    const descriptor = manifest.assets[kind];
    let temporaryDirectory, body;
    try {
      let uploadFile = files[kind];
      let transport = { encoding: "identity", bytes: descriptor.bytes };
      if (descriptor.bytes >= gzipThresholdBytes) {
        // A private file bounds memory and gives fetch the compressed length.
        // The descriptor and readback always identify the original raw asset.
        temporaryDirectory = await mkdtemp(path.join(tmpdir(), "data-app-upload-gzip-"));
        const compressedFile = path.join(temporaryDirectory, "asset.gz");
        await pipeline(createReadStream(files[kind]), createGzip({ level: 1 }),
          createWriteStream(compressedFile, { flags: "wx", mode: 0o600 }));
        const { size } = await stat(compressedFile);
        if (size < descriptor.bytes) {
          uploadFile = compressedFile;
          transport = { encoding: "gzip", bytes: size };
        }
      }
      body = createReadStream(uploadFile);
      const start = performance.now();
      const response = await send(`/api/deployment-assets/${kind}`, { method: "PUT", duplex: "half", body,
        headers: { ...authorization, "x-data-app-deployment-token": deploymentToken,
          "content-length": String(transport.bytes),
          ...(transport.encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
          "content-type": kind === "html" ? "text/html; charset=utf-8" : "application/json; charset=utf-8" } });
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 4096) throw new Error("The deployment acknowledgement is too large.");
        chunks.push(chunk);
      }
      let receipt;
      try { receipt = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new Error("The deployment acknowledgement is not valid JSON."); }
      if (receipt.kind !== kind || !matches(receipt, descriptor)) throw new Error(`The ${kind} upload acknowledgement failed integrity verification.`);
      uploads.push({ kind, ...receipt, transport, milliseconds: Math.round(performance.now() - start) });
    } finally {
      if (body) {
        body.destroy();
        await finished(body).catch(() => {});
      }
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
  const readback = {};
  for (const [kind, pathname, candidates] of [
    ["html", "/api/deployment-assets/html", [{ fingerprint: manifest.assets.html }]],
    ["snapshot", "/api/snapshot", snapshotCandidates],
  ]) {
    const start = performance.now();
    const response = await send(pathname, { headers: { ...authorization,
      ...(kind === "html" ? { "x-data-app-deployment-token": deploymentToken } : {}) } });
    if (!response.body) throw new Error(`The ${kind} readback body is missing.`);
    const actual = await digestStream(response.body, Math.max(...candidates.map(item => item.fingerprint.bytes)));
    const matched = candidates.filter(item => matches(actual, item.fingerprint));
    if (!matched.length) throw new Error(`The hosted ${kind} differs from the packaged artifact; publication is not ready.`);
    readback[kind] = { ...actual, milliseconds: Math.round(performance.now() - start),
      // Matching bytes identify an approved encoding, not the runtime's storage
      // path. If both encodings coincide, preserve that ambiguity in the receipt.
      ...(kind === "snapshot" ? { matchedEncoding: matched.map(item => item.label).join("+") } : {}) };
  }
  // Keep normal HTML delivery and Sites' injected infrastructure intact. Its
  // transport bytes can differ from the immutable asset verified above.
  const page = await send("/", { method: "HEAD", headers: authorization });
  if (!page.headers.get("content-type")?.startsWith("text/html")) {
    throw new Error("The hosted document did not return HTML.");
  }
  return { projectId, siteUrl: origin.origin, ready: true, thinBootstrap: manifest.thinBootstrap,
    queryCount: manifest.snapshotResponse.queryCount, rowCount: manifest.snapshotResponse.rowCount, uploads, readback };
}

async function main() {
  // Read one bounded JSON object from stdin. Never accept bearer values in CLI
  // flags or write them to the project, deployment manifest, or receipt.
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > 65536) throw new Error("The upload request is too large.");
    chunks.push(chunk);
  }
  let inputs;
  try { inputs = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("The upload request must be valid JSON."); }
  const receipt = await uploadDataAppAssets(inputs);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
