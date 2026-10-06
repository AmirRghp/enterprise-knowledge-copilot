import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { publicationGitClient } from "./publication-git-process.mjs";

export const PUBLICATION_SOURCE_MANIFEST = ".openai/data-app-publication-source.json";
const PACKAGE_MANIFEST = ".data-app-assets/manifest.json";
const HASH = /^[a-f\d]{64}$/u;
const REVISION = /^[a-f\d]{40}$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const CHUNK_BYTES = 256 * 1024;

function fail(message) { throw new Error(message); }
function validProject(value) { return typeof value === "string" && value.length <= 256 && PROJECT.test(value); }
function validPath(value) {
  if (typeof value !== "string" || !value || isAbsolute(value) || /[\\:\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some(part => !part || part === "." || part === "..")) {
    fail("The publication source contains an invalid relative path.");
  }
  return value;
}
function inside(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}
function origin(value) {
  let url;
  try { url = new URL(value); } catch { fail("The publication Site origin is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== "/" || (value !== url.origin && value !== `${url.origin}/`)) {
    fail("The publication Site must use its exact canonical HTTPS origin.");
  }
  return url.origin;
}
function fingerprint(value) {
  return value && HASH.test(value.sha256) && Number.isSafeInteger(value.bytes) && value.bytes > 0;
}
function matches(left, right) { return left.sha256 === right.sha256 && left.bytes === right.bytes; }
async function cancel(body) { try { await body?.cancel(); } catch { /* Keep response contents out of diagnostics. */ } }
async function directory(path) {
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) fail("A publication directory must not be a symlink.");
  return realpath(path);
}
async function regular(root, name) {
  const parts = validPath(name).split("/");
  let path = root;
  for (let index = 0; index < parts.length; index += 1) {
    path = join(path, parts[index]);
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory())) {
      fail("Publication inputs must be regular files with no symlink components.");
    }
  }
  return path;
}
async function digestFile(path, expected, output) {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const before = await input.stat();
    if (!before.isFile()) fail("A publication input is not a regular file.");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      const read = await input.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (expected && bytes > expected.bytes) fail("The publication asset failed byte and hash verification.");
      const chunk = buffer.subarray(0, read.bytesRead);
      hash.update(chunk);
      if (output) await output.writeFile(chunk);
    }
    const after = await input.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
      fail("A publication input changed while it was being read.");
    }
    const result = { sha256: hash.digest("hex"), bytes };
    if (expected && !matches(result, expected)) fail("The publication asset failed byte and hash verification.");
    return result;
  } finally { await input.close(); }
}
async function jsonFile(root, name, maximum = 65536) {
  const path = await regular(root, name);
  if ((await lstat(path)).size > maximum) fail("The publication manifest is too large.");
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch { fail("The publication manifest is not valid JSON."); }
  return value;
}
function assetDescriptor(value, kind) {
  if (!fingerprint(value) || value.key !== `data-app/${kind}/${value.sha256}`
    || typeof value.path !== "string" || value.path.includes("/")) {
    fail("The publication asset descriptor is invalid.");
  }
  validPath(value.path);
  return { key: value.key, sha256: value.sha256, bytes: value.bytes };
}
function counts(value) {
  if (!fingerprint(value) || !Number.isSafeInteger(value.queryCount) || value.queryCount < 0
    || !Number.isSafeInteger(value.rowCount) || value.rowCount < 0) {
    fail("The complete snapshot counts and response fingerprint are required.");
  }
  return { sha256: value.sha256, bytes: value.bytes, queryCount: value.queryCount, rowCount: value.rowCount };
}
function excluded(name) {
  const parts = name.split("/");
  return name === "src/data.json" || name === PUBLICATION_SOURCE_MANIFEST
    || /^src\/\.data-app-hydrate-[^/]+\.tmp$/u.test(name)
    || parts.some(part => [".git", "node_modules", ".DS_Store"].includes(part))
    || [".cache", ".vite"].includes(parts[0]) || parts[0].startsWith(".data-app-");
}
function git(root, args, input, gitDir, gitOptions) {
  const command = [...(gitDir ? [`--git-dir=${gitDir}`, `--work-tree=${root}`] : []), ...args];
  if (gitOptions.gitExecution === "sanitized") {
    return publicationGitClient({ projectDir: root, ...gitOptions })(command,
      { stage: "source", operation: args[0], input, statuses: args[0] === "check-ignore" ? [0, 1] : [0] },
    ).stdout;
  }
  // Keep the existing direct-call contract, including inherited Git config and
  // no new timeout. The Windows publication runner explicitly selects the client above.
  const result = spawnSync(gitOptions.gitExecutable ?? "git", command, {
    cwd: root, input, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !(args[0] === "check-ignore" && result.status === 1))) {
    fail("Git could not verify the publication source and ignore rules.");
  }
  return result.stdout;
}
function ignoredFiles(root, names, gitDir, gitOptions) {
  if (!names.length) return new Set();
  return new Set(git(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${names.join("\0")}\0`, gitDir, gitOptions).split("\0").filter(Boolean));
}
async function sourceFiles(root, gitOptions) {
  const files = [];
  async function visit(prefix) {
    for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      validPath(name);
      if (excluded(name)) continue;
      if (/^dist\/snapshot\.[a-f\d]{64}\.json$/u.test(name) || name === "dist/data-app-build.json") {
        fail("Complete build snapshot sidecars must be removed by final packaging before source projection.");
      }
      if (entry.isSymbolicLink()) fail("Publication source files must not contain symlinks.");
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.push(name);
      else fail("Publication source contains an unsupported filesystem entry.");
    }
  }
  await visit("");
  const ignored = ignoredFiles(root, files, undefined, gitOptions);
  const tracked = new Set(git(root, ["ls-files", "--cached", "-z"], undefined, undefined, gitOptions).split("\0"));
  return files.filter(name => name.startsWith("dist/") || name === "package.json" || name === ".openai/hosting.json"
    || name === ".gitignore" || name.endsWith("/.gitignore") || tracked.has(name) || !ignored.has(name));
}
function ignoredSource(previous, name) {
  // These last rules also override an earlier negation in an authored ignore file.
  return `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}`
    + "\n# Complete reviewed data is restored only by verified Data hydration.\n"
    + (name === "src/.gitignore" ? "/data.json\n/.data-app-hydrate-*.tmp\n"
      : "/src/data.json\n/src/.data-app-hydrate-*.tmp\n/dist/\n/node_modules/\n/.data-app-*/\n");
}

/** Create a fresh candidate checkout. Git history and Site lifecycle stay with the caller. */
export async function createPublicationSource({ authoringProjectDir, publicationProjectDir, projectId, sourceRevision, siteUrl, gitExecutable,
  gitExecution = "legacy", gitRunner, gitTimeoutMs }) {
  if (!["legacy", "sanitized"].includes(gitExecution)) fail("The publication Git execution mode is invalid.");
  const gitOptions = { gitExecutable, gitExecution, runner: gitRunner, timeoutMs: gitTimeoutMs };
  if (!validProject(projectId) || !REVISION.test(sourceRevision)) fail("A verified Site ID and complete authoring source revision are required.");
  // A first publication has a verified Site ID before Sites assigns its origin.
  const site = siteUrl == null ? null : origin(siteUrl);
  const sourceRoot = await directory(resolve(authoringProjectDir));
  const destinationInput = resolve(publicationProjectDir);
  const destinationParent = await directory(dirname(destinationInput));
  const destination = join(destinationParent, destinationInput.split(sep).at(-1));
  if (inside(sourceRoot, destination) || inside(destination, sourceRoot)) fail("Authoring and publication source directories must not overlap.");
  try { await lstat(destination); fail("The publication source destination already exists."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  const packaged = await jsonFile(sourceRoot, PACKAGE_MANIFEST);
  if (packaged.version !== 1 || packaged.projectId !== projectId || packaged.source?.layout !== "separate-data-v1"
    || !HASH.test(packaged.source.snapshotSha256) || !HASH.test(packaged.seedSnapshotSha256)
    || !HASH.test(packaged.source.htmlSha256)) fail("A verified separate-data package for the same Site is required.");
  const snapshot = assetDescriptor(packaged.assets?.snapshot, "snapshot");
  const html = assetDescriptor(packaged.assets?.html, "html");
  const snapshotResponse = counts(packaged.snapshotResponse);
  if (packaged.source.snapshotSha256 !== snapshot.sha256) fail("The raw source snapshot and immutable snapshot descriptor disagree.");
  const buildPath = validPath(packaged.source.buildManifestPath);
  if (!buildPath.startsWith(".data-app-offline/separate-v1/")) fail("The original split build manifest is not in its preserved package directory.");
  const build = await jsonFile(sourceRoot, buildPath);
  if (build.version !== 1 || build.kind !== "separate-data-v1" || build.sourceSnapshotSha256 !== snapshot.sha256
    || !fingerprint(build.snapshot) || !matches(build.snapshot, snapshot)
    || !fingerprint(build.html) || build.html.sha256 !== packaged.source.htmlSha256 || !HASH.test(build.runtimeSha256)) {
    fail("The preserved split build and publication package identities disagree.");
  }
  for (const kind of ["html", "snapshot"]) {
    const name = `${buildPath.slice(0, buildPath.lastIndexOf("/"))}/${validPath(build[kind].path)}`;
    await digestFile(await regular(sourceRoot, name), build[kind]);
  }
  await digestFile(await regular(sourceRoot, `.data-app-assets/${packaged.assets.snapshot.path}`), snapshot);
  await digestFile(await regular(sourceRoot, "src/data.json"), snapshot);
  await digestFile(await regular(sourceRoot, `.data-app-assets/${packaged.assets.html.path}`), html);
  await digestFile(await regular(sourceRoot, "dist/index.html"), html);
  for (const name of [".openai/hosting.json", "dist/.openai/hosting.json"]) {
    const hosting = await jsonFile(sourceRoot, name);
    if (hosting.project_id !== projectId || hosting.d1 !== "DB" || hosting.r2 !== "BUCKET") {
      fail("Publication source must preserve the selected Site and logical database/asset bindings.");
    }
  }
  await regular(sourceRoot, "dist/server/index.js");
  await regular(sourceRoot, "package.json");
  const names = await sourceFiles(sourceRoot, gitOptions);
  const packageIdentity = await digestFile(await regular(sourceRoot, PACKAGE_MANIFEST));
  const buildIdentity = await digestFile(await regular(sourceRoot, buildPath));
  let created = false;
  try {
    await mkdir(destination); created = true;
    const files = {};
    for (const name of names) {
      const inputPath = await regular(sourceRoot, name);
      const inputMode = (await lstat(inputPath)).mode & 0o777;
      const outputPath = join(destination, name);
      await mkdir(dirname(outputPath), { recursive: true });
      const output = await open(outputPath, "wx", inputMode);
      let identity;
      try { identity = await digestFile(inputPath, undefined, output); }
      finally { await output.close(); }
      await chmod(outputPath, inputMode);
      if (name === ".gitignore" || name === "src/.gitignore") {
        const content = ignoredSource(await readFile(outputPath, "utf8"), name);
        await writeFile(outputPath, content);
        files[name] = { ...(await digestFile(outputPath)), mode: inputMode, source: identity };
      } else files[name] = { ...identity, mode: inputMode };
      files[name].role = name.startsWith("dist/") ? "deployment-output" : "source";
    }
    for (const name of [".gitignore", "src/.gitignore"]) {
      if (files[name]) continue;
      await mkdir(dirname(join(destination, name)), { recursive: true });
      await writeFile(join(destination, name), ignoredSource("", name), { flag: "wx" });
      files[name] = { ...(await digestFile(join(destination, name))),
        mode: (await lstat(join(destination, name))).mode & 0o777, generated: true, role: "source" };
    }
    const gitDir = git(sourceRoot, ["rev-parse", "--absolute-git-dir"], undefined, undefined, gitOptions).trim();
    const required = [...Object.keys(files).filter(name => files[name].role === "source"), PUBLICATION_SOURCE_MANIFEST];
    if (ignoredFiles(destination, required, gitDir, gitOptions).size) {
      fail("An authored Git ignore rule hides required publication source. Correct the rule before publishing.");
    }
    const privateData = ["src/data.json", "src/.data-app-hydrate-check.tmp"];
    if (ignoredFiles(destination, privateData, gitDir, gitOptions).size !== privateData.length) {
      fail("The publication source must keep complete reviewed data out of Git.");
    }
    // Reject changed source inputs before marking the candidate complete.
    if (JSON.stringify(names) !== JSON.stringify(await sourceFiles(sourceRoot, gitOptions))) fail("The authoring source changed during projection.");
    for (const name of names) {
      const path = await regular(sourceRoot, name);
      await digestFile(path, files[name].source ?? files[name]);
      if (((await lstat(path)).mode & 0o777) !== files[name].mode) fail("The authoring source changed during projection.");
    }
    await digestFile(await regular(sourceRoot, PACKAGE_MANIFEST), packageIdentity);
    await digestFile(await regular(sourceRoot, buildPath), buildIdentity);
    await digestFile(await regular(sourceRoot, "src/data.json"), snapshot);
    const manifest = {
      version: 1, kind: "data-app-publication-source-v1", projectId, siteUrl: site, sourceRevision,
      ...(typeof packaged.artifactId === "string" && packaged.artifactId ? { artifactId: packaged.artifactId } : {}),
      sourceSnapshotSha256: snapshot.sha256, seedSnapshotSha256: packaged.seedSnapshotSha256,
      snapshot, snapshotResponse, html,
      originalBuild: { htmlSha256: build.html.sha256, runtimeSha256: build.runtimeSha256 },
      packageManifestSha256: packageIdentity.sha256, hydrationRequired: true, files,
    };
    await writeFile(join(destination, PUBLICATION_SOURCE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { publicationProjectDir: destination, manifestPath: join(destination, PUBLICATION_SOURCE_MANIFEST), manifest };
  } catch (error) {
    if (created) await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function readSourceManifest(root) {
  const manifest = await jsonFile(root, PUBLICATION_SOURCE_MANIFEST, 4 * 1024 * 1024);
  if (manifest.version !== 1 || manifest.kind !== "data-app-publication-source-v1" || !validProject(manifest.projectId)
    || !REVISION.test(manifest.sourceRevision) || !fingerprint(manifest.snapshot)
    || manifest.snapshot.key !== `data-app/snapshot/${manifest.snapshot.sha256}`
    || manifest.sourceSnapshotSha256 !== manifest.snapshot.sha256 || !HASH.test(manifest.seedSnapshotSha256)
    || !fingerprint(manifest.html) || manifest.html.key !== `data-app/html/${manifest.html.sha256}`
    || !HASH.test(manifest.originalBuild?.htmlSha256) || !HASH.test(manifest.originalBuild?.runtimeSha256)
    || !HASH.test(manifest.packageManifestSha256) || manifest.hydrationRequired !== true
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !Object.hasOwn(manifest.files, ".openai/hosting.json") || !Object.hasOwn(manifest.files, "package.json")) {
    fail("The publication source manifest is invalid.");
  }
  if (manifest.siteUrl !== null) origin(manifest.siteUrl);
  counts(manifest.snapshotResponse);
  for (const [name, descriptor] of Object.entries(manifest.files)) {
    validPath(name);
    if (excluded(name) || (!fingerprint(descriptor) && !(descriptor?.bytes === 0 && HASH.test(descriptor.sha256)))
      || descriptor.role !== (name.startsWith("dist/") ? "deployment-output" : "source")) {
      fail("The publication source file identity is invalid.");
    }
  }
  return manifest;
}

/** Restore exactly the pinned raw source bytes; never fetch mutable /api/snapshot. */
export async function hydratePublicationSource({ publicationProjectDir, snapshotFile, siteUrl, projectId, sitesAuthorization,
  request = globalThis.fetch, timeoutMs = 300000 }) {
  const root = await directory(resolve(publicationProjectDir));
  const manifest = await readSourceManifest(root);
  const trustedSite = siteUrl == null ? null : origin(siteUrl);
  if ((projectId !== undefined && projectId !== manifest.projectId)
    || (trustedSite !== null && manifest.siteUrl !== null && trustedSite !== manifest.siteUrl)) fail("Hydration requires the trusted matching Site identity.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 900000) fail("The hydration timeout is invalid.");
  for (const [name, descriptor] of Object.entries(manifest.files)) {
    let path;
    try { path = await regular(root, name); }
    catch (error) {
      // Archive outputs are recorded for package correspondence, but /dist/ is
      // intentionally absent from a normal clone of the source repository.
      if (error.code === "ENOENT" && descriptor.role === "deployment-output" && name.startsWith("dist/")) continue;
      throw error;
    }
    await digestFile(path, descriptor);
  }
  const hosting = await jsonFile(root, ".openai/hosting.json");
  if (hosting.project_id !== manifest.projectId || hosting.d1 !== "DB" || hosting.r2 !== "BUCKET") {
    fail("Hydration source does not preserve the selected Site and logical bindings.");
  }
  const src = await directory(join(root, "src"));
  if (src !== join(root, "src")) fail("The hydration destination escaped the publication source.");
  const srcIdentity = await lstat(src);
  const validateDestination = async () => {
    if (await directory(join(root, "src")) !== src) fail("The hydration destination changed.");
    const current = await lstat(src);
    if (current.dev !== srcIdentity.dev || current.ino !== srcIdentity.ino) fail("The hydration destination changed.");
  };
  const target = join(src, "data.json");
  try {
    await regular(root, "src/data.json");
    await digestFile(target, manifest.snapshot);
    return { projectId: manifest.projectId, ...manifest.snapshot, hydrated: true, alreadyHydrated: true };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let body, localPath;
  if (snapshotFile !== undefined) {
    const parent = await directory(dirname(resolve(snapshotFile)));
    localPath = await regular(parent, resolve(snapshotFile).split(sep).at(-1));
  } else {
    // Only the caller can resolve a first publication's origin from trusted
    // Sites metadata. Never infer a destination from repository configuration.
    if (projectId !== manifest.projectId || trustedSite === null) fail("Hydration requires the trusted matching Site identity.");
    if (typeof sitesAuthorization !== "string" || !sitesAuthorization || sitesAuthorization.length > 65536 || /[\r\n]/u.test(sitesAuthorization)) {
      fail("Hydration requires temporary Sites authorization.");
    }
    const url = new URL("/api/deployment-assets/snapshot", trustedSite);
    url.searchParams.set("sha256", manifest.snapshot.sha256);
    let response;
    try {
      response = await request(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "OAI-Sites-Authorization": `Bearer ${sitesAuthorization}` } });
    } catch { fail("The immutable snapshot request failed; authorization and response contents were omitted."); }
    if (!response.ok || response.redirected || !response.body) {
      await cancel(response.body);
      fail("The immutable snapshot request did not return a successful direct response.");
    }
    if (response.headers.get("content-length") !== null && response.headers.get("content-length") !== String(manifest.snapshot.bytes)) {
      await cancel(response.body);
      fail("The immutable snapshot response has the wrong byte count.");
    }
    body = response.body;
  }
  const temporary = join(src, `.data-app-hydrate-${randomUUID()}.tmp`);
  let output, bodyComplete = false;
  try {
    await validateDestination();
    output = await open(temporary, "wx", 0o600);
    let identity;
    if (localPath) identity = await digestFile(localPath, manifest.snapshot, output);
    else {
      const hash = createHash("sha256"); let bytes = 0;
      try {
        for await (const chunk of body) {
          bytes += chunk.byteLength;
          if (bytes > manifest.snapshot.bytes) fail("The immutable snapshot exceeds its declared byte count.");
          hash.update(chunk); await output.writeFile(chunk);
        }
      } catch { fail("The immutable snapshot stream did not complete integrity verification."); }
      bodyComplete = true;
      identity = { bytes, sha256: hash.digest("hex") };
      if (!matches(identity, manifest.snapshot)) fail("The immutable snapshot failed byte and hash verification.");
    }
    await output.sync(); await output.close(); output = undefined;
    await validateDestination();
    // A concurrent hydration or local edit wins; never replace unverified data.
    try {
      await regular(root, "src/data.json");
      await digestFile(target, manifest.snapshot);
      return { projectId: manifest.projectId, ...identity, hydrated: true, alreadyHydrated: true };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    // Hard-link installation is atomic and fails if another writer created the
    // destination after the check above. Removing our temporary name preserves
    // the installed bytes while avoiding a rename that could overwrite edits.
    try { await link(temporary, target); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await regular(root, "src/data.json");
      await digestFile(target, manifest.snapshot);
      return { projectId: manifest.projectId, ...identity, hydrated: true, alreadyHydrated: true };
    }
    return { projectId: manifest.projectId, ...identity, hydrated: true, alreadyHydrated: false };
  } finally {
    if (!bodyComplete) await cancel(body);
    await output?.close();
    await rm(temporary, { force: true });
  }
}
