#!/usr/bin/env node
import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, readFile, realpath, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { packageDataAppForSites } from "./package-data-app-for-sites.mjs";
import { createPublicationSource } from "./publication-source.mjs";
import { createPublicationArchive } from "./publication-archive.mjs";
import { initializePublicationGit, preflightPublicationGit, PublicationGitError, PUBLICATION_GIT_OPERATIONS,
  PUBLICATION_GIT_FAILURE_SUBTYPES, getPublicationGitProcessDiagnostics, publicationGitErrorMessage,
  publishPublicationSource, verifyPublicationCandidate } from "./publication-git.mjs";
import { uploadDataAppAssets } from "./upload-data-app-assets.mjs";

const MAX_REQUEST_BYTES = 65536;
class PublicationSessionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new PublicationSessionError(code, message); };
export const asciiJson = value => JSON.stringify(value).replace(/[\u007f-\uffff]/g,
  character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);

async function readSmallJson(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) fail("INVALID_INPUT", "Invalid publication metadata.");
  return JSON.parse(await readFile(file, "utf8"));
}

const contains = (parent, child) => {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
};
const invalidDestination = () => fail("INVALID_DESTINATION", "Use writable output directories outside the authoring project, with separate fresh checkout and archive paths.");

async function assertFreshDestination(target) {
  try { await lstat(target); }
  catch (error) { if (error.code === "ENOENT") return; invalidDestination(); }
  fail("DESTINATION_EXISTS", "Use fresh publication checkout and archive destinations.");
}

async function planDestination(value, root) {
  // Resolve the nearest existing ancestor before creating anything, including
  // aliases that could otherwise hide a destination inside the authoring tree.
  let ancestor = dirname(resolve(value));
  const suffix = [basename(resolve(value))];
  let canonical;
  for (;;) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) invalidDestination();
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
      continue;
    }
    try {
      canonical = await realpath(ancestor);
      if (!(await lstat(canonical)).isDirectory()) invalidDestination();
      await access(canonical, constants.W_OK);
    } catch { invalidDestination(); }
    break;
  }
  const target = join(canonical, ...suffix);
  if (contains(root, target)) invalidDestination();
  await assertFreshDestination(target);
  return { ancestor: canonical, parents: suffix.slice(0, -1), target };
}

async function assertStableDirectory(directory) {
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || relative(directory, await realpath(directory))) invalidDestination();
  } catch { invalidDestination(); }
}

async function checkPreparation(request) {
  for (const key of ["projectDir", "publicationProjectDir", "archivePath", "projectId"]) {
    if (typeof request[key] !== "string" || !request[key]) fail("INVALID_INPUT", `Supply ${key}.`);
  }
  // Discover destination and layout failures before changing the packaged page.
  const root = await realpath(request.projectDir);
  const destinations = [];
  for (const value of [request.publicationProjectDir, request.archivePath]) destinations.push(await planDestination(value, root));
  if (contains(destinations[0].target, destinations[1].target) || contains(destinations[1].target, destinations[0].target)) invalidDestination();
  let split = false;
  for (const file of ["dist/data-app-build.json", ".data-app-assets/manifest.json"]) {
    try {
      const metadata = await readSmallJson(join(root, file));
      split ||= metadata.kind === "separate-data-v1" || metadata.source?.layout === "separate-data-v1";
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (!split) fail("UNSUPPORTED_LAYOUT", "Use the existing legacy/source publication path for this artifact; do not rebuild it to use this runner.");
  const created = [];
  try {
    for (const destination of destinations) {
      let parent = destination.ancestor;
      await assertStableDirectory(parent);
      for (const part of destination.parents) {
        await assertStableDirectory(parent);
        parent = join(parent, part);
        try { await mkdir(parent); created.push(parent); }
        catch (error) { if (error.code !== "EEXIST") invalidDestination(); }
        await assertStableDirectory(parent);
      }
    }
    for (const destination of destinations) {
      await assertStableDirectory(dirname(destination.target));
      await assertFreshDestination(destination.target);
    }
  } catch (error) {
    // Remove only empty directories made by this attempt; never remove a file
    // or any directory another process has populated in the meantime.
    for (const directory of created.reverse()) await rmdir(directory).catch(() => {});
    throw error;
  }
  return { projectDir: root, publicationProjectDir: destinations[0].target, archivePath: destinations[1].target };
}

/** Local stages only. The owning task calls the native Sites lifecycle tools. */
export function createPublicationSession(overrides = {}) {
  const dependencies = { preflightPublicationGit, initializePublicationGit, packageDataAppForSites,
    createPublicationSource, createPublicationArchive, publishPublicationSource, verifyPublicationCandidate, uploadDataAppAssets,
    checkPreparation, ...overrides };
  let context;
  let stage = "idle";
  let closed = false;
  let queue = Promise.resolve();
  const receipt = () => ({ stage, ...(context ? {
    projectId: context.projectId, sourceRevision: context.sourceRevision,
    publicationProjectDir: context.publicationProjectDir,
    ...(context.gitReceipt ? { source: context.gitReceipt } : {}),
    ...(context.archive ? { archive: { archivePath: context.archive.archivePath, sha256: context.archive.sha256,
      bytes: context.archive.bytes, fileCount: context.archive.files.length }, saveArguments: {
      project_id: context.projectId, commit_sha: context.gitReceipt.commitSha, archive: context.archive.archivePath,
    } } : {}),
    ...(context.readback ? { readiness: context.readback } : {}),
  } : {}) });

  async function run(request, timing) {
    const enterStage = name => { timing.failedStage = name; timing.started = performance.now(); };
    if (!request || Array.isArray(request) || typeof request !== "object") fail("INVALID_INPUT", "Send one JSON command object.");
    if (request.op === "close") { context = undefined; closed = true; stage = "closed"; return receipt(); }
    if (closed) fail("SESSION_CLOSED", "Start a new publication session.");
    if (request.op === "status") return receipt();
    if (request.op === "preflight") {
      enterStage("preflight");
      const result = await dependencies.preflightPublicationGit(request);
      return { stage: "preflight", projectDir: result.projectDir, sourceRevision: result.sourceRevision,
        needsInitialization: result.needsInitialization === true, identityConfigured: true };
    }
    if (request.op === "prepare") {
      enterStage("preparation");
      if (context) fail("ALREADY_PREPARED", "Reuse this session's prepared artifact, or close it before preparing another.");
      const destinations = await dependencies.checkPreparation(request);
      request = { ...request, ...destinations };
      const gitOptions = { projectDir: request.projectDir, gitExecutable: request.gitExecutable };
      const preflight = request.initialize === true
        ? await dependencies.initializePublicationGit(gitOptions)
        : await dependencies.preflightPublicationGit(gitOptions);
      const deploymentToken = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      stage = "preparing";
      const options = {
        "project-dir": preflight.projectDir, "project-id": request.projectId,
        "html-file": request.htmlFile ?? "dist/index.html",
        "deployment-token-sha256": createHash("sha256").update(deploymentToken).digest("hex"),
        "deployment-token-expires-at": expiresAt,
        ...(request.presentationFile ? { "presentation-file": request.presentationFile } : {}),
      };
      await dependencies.packageDataAppForSites(options);
      const source = await dependencies.createPublicationSource({ authoringProjectDir: preflight.projectDir,
        publicationProjectDir: request.publicationProjectDir, projectId: request.projectId,
        sourceRevision: preflight.sourceRevision, siteUrl: request.siteUrl, gitExecutable: request.gitExecutable, gitExecution: "sanitized" });
      context = { projectDir: preflight.projectDir, projectId: request.projectId,
        sourceRevision: preflight.sourceRevision, identity: preflight.identity, gitExecutable: request.gitExecutable,
        publicationProjectDir: source.publicationProjectDir, archivePath: resolve(request.archivePath),
        siteUrl: request.siteUrl, deploymentToken, expiresAt };
      stage = "prepared";
      return receipt();
    }
    if (!context) fail("NOT_PREPARED", "Prepare the reviewed artifact first.");
    if (request.op === "push") {
      enterStage("push");
      if (context.archive) return receipt();
      if (Date.parse(context.expiresAt) <= Date.now()) fail("DEPLOYMENT_TOKEN_EXPIRED", "Prepare a fresh package and reconcile existing Sites versions before deploying it.");
      try {
        context.gitReceipt = await dependencies.publishPublicationSource({
          publicationProjectDir: context.publicationProjectDir, credential: request.credential,
          identity: context.identity, gitExecutable: context.gitExecutable, receipt: context.gitReceipt,
        });
      } catch (error) {
        if (error instanceof PublicationGitError && error.receipt) context.gitReceipt = error.receipt;
        throw error;
      }
      stage = "pushed";
      enterStage("archive");
      const verify = async () => {
        const verified = await dependencies.verifyPublicationCandidate({ publicationProjectDir: context.publicationProjectDir });
        if (verified.manifestSha256 !== context.gitReceipt.manifestSha256) {
          fail("SOURCE_CHANGED", "The archived artifact must match the exact pushed source manifest.");
        }
      };
      await verify();
      const archive = await dependencies.createPublicationArchive({ projectDir: context.publicationProjectDir,
        projectId: context.projectId, archivePath: context.archivePath });
      await verify();
      context.archive = archive;
      stage = "archived";
      return receipt();
    }
    if (request.op === "upload") {
      enterStage("upload");
      if (context.readback) return receipt();
      if (!context.archive) fail("NOT_PUSHED", "Push and archive the prepared source first.");
      const deployment = request.deployment;
      if (deployment?.project_id !== context.projectId || deployment.status !== "succeeded"
        || typeof deployment.id !== "string" || !deployment.id || typeof deployment.version_id !== "string" || !deployment.version_id) {
        fail("DEPLOYMENT_NOT_READY", "Pass the successful native Sites deployment for this project; resume pending deployments through Sites.");
      }
      let site;
      try { site = new URL(request.siteUrl); }
      catch { fail("INVALID_SITE", "Use the canonical Site origin returned by get_site."); }
      if (site.protocol !== "https:" || site.username || site.password || site.pathname !== "/" || site.search || site.hash
        || (context.siteUrl && new URL(context.siteUrl).origin !== site.origin)
        || typeof deployment.url !== "string" || new URL(deployment.url).origin !== site.origin) {
        fail("INVALID_SITE", "The Site origin and successful deployment must match this prepared project.");
      }
      if (Date.parse(context.expiresAt) <= Date.now()) fail("DEPLOYMENT_TOKEN_EXPIRED", "Prepare a fresh package and reconcile existing Sites versions before deploying it.");
      context.readback = await dependencies.uploadDataAppAssets({ projectDir: context.projectDir,
        projectId: context.projectId, siteUrl: site.origin, deploymentToken: context.deploymentToken,
        sitesAuthorization: request.sitesAuthorization });
      context.deploymentToken = undefined;
      context.identity = undefined;
      stage = "ready";
      return receipt();
    }
    fail("UNKNOWN_COMMAND", "Use preflight, prepare, push, upload, status, or close.");
  }
  async function dispatch(request) {
    const started = performance.now();
    const timing = { failedStage: "command", started };
    try { return { ok: true, ...await run(request, timing), milliseconds: Math.round(performance.now() - started) }; }
    catch (error) {
      // Only the Git wrapper's private diagnostics can supply a redacted stderr
      // excerpt. Never trust arbitrary exception fields or echo request bodies.
      const gitError = error instanceof PublicationGitError ? new PublicationGitError(error.code) : null;
      const known = error instanceof PublicationSessionError ? error : gitError;
      const diagnostics = {};
      if (gitError) {
        if (["preflight", "initialize", "credential", "source", "fetch", "push", "package"].includes(error.stage)) diagnostics.gitStage = error.stage;
        if (PUBLICATION_GIT_OPERATIONS.includes(error.operation)) diagnostics.operation = error.operation;
        if (PUBLICATION_GIT_FAILURE_SUBTYPES.includes(error.subtype)) diagnostics.subtype = error.subtype;
        if (Number.isSafeInteger(error.operationMilliseconds) && error.operationMilliseconds >= 0) diagnostics.operationMilliseconds = error.operationMilliseconds;
        Object.assign(diagnostics, getPublicationGitProcessDiagnostics(error));
        gitError.message = publicationGitErrorMessage(gitError.code, diagnostics.subtype);
      }
      const finished = performance.now();
      return { ok: false, ...receipt(), code: known?.code ?? "PUBLICATION_FAILED",
        message: known?.message ?? "The local publication stage failed. Preserve its receipt and inspect the selected artifact before retrying.",
        failedStage: timing.failedStage, milliseconds: Math.round(finished - started),
        stageMilliseconds: Math.round(finished - timing.started), ...diagnostics };
    }
  }
  return { dispatch(request) { const result = queue.then(() => dispatch(request)); queue = result.then(() => {}); return result; } };
}

/** Bounded UTF-8 JSON lines, including CRLF/CR consoles; no request is echoed. */
export async function servePublicationSession(input, output, session = createPublicationSession()) {
  const write = value => output.write(`${asciiJson(value)}\n`);
  let buffer = Buffer.alloc(0);
  let discarding = false;
  const processLine = async line => {
    if (!line.length) return false;
    let request;
    try { if (!isUtf8(line)) throw new Error(); request = JSON.parse(line.toString("utf8")); }
    catch { write({ ok: false, code: "INVALID_JSON", message: "Send a UTF-8 JSON command; input was not logged." }); return false; }
    const result = await session.dispatch(request);
    write(result);
    return result.stage === "closed";
  };
  write({ ok: true, stage: "listening", protocol: "data-publication-v1", echo: false });
  try {
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      let start = 0;
      for (let index = 0; index <= bytes.length; index++) {
        if (index !== bytes.length && bytes[index] !== 10 && bytes[index] !== 13) continue;
        if (!discarding) {
          if (buffer.length + index - start > MAX_REQUEST_BYTES) {
            buffer = Buffer.alloc(0); discarding = true;
            write({ ok: false, code: "REQUEST_TOO_LARGE", message: "Publication commands are limited to 64 KiB." });
          } else buffer = Buffer.concat([buffer, bytes.subarray(start, index)]);
        }
        if (index < bytes.length) {
          if (!discarding && await processLine(buffer)) return;
          buffer = Buffer.alloc(0); discarding = false;
        }
        start = index + 1;
      }
    }
    if (!discarding && buffer.length) await processLine(buffer);
  } finally { await session.dispatch({ op: "close" }); }
}

// Node resolves the module's real path, including symlinked parent directories.
// Canonicalize the entry path too, while allowing imports from stdin or a REPL.
const entryUrl = process.argv[1]
  ? await realpath(resolve(process.argv[1])).then(path => pathToFileURL(path).href, () => null)
  : null;
if (import.meta.url === entryUrl) {
  let raw = false;
  try {
    // Some execution hosts require a PTY for persistent stdin. Disable echo
    // before the listening receipt; never send secrets before that handshake.
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); raw = true; }
    await servePublicationSession(process.stdin, process.stdout);
  } catch {
    process.stderr.write(`${asciiJson({ ok: false, code: "STDIO_UNAVAILABLE", message: "Use an in-memory session or a stdin stream that can disable terminal echo." })}\n`);
    process.exitCode = 1;
  } finally {
    if (raw) process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
