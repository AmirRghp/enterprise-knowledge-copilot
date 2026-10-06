import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PUBLICATION_SOURCE_MANIFEST } from "./publication-source.mjs";
import { failPublicationGit as fail, publicationGitClient as gitClient, PublicationGitError } from "./publication-git-process.mjs";
export { PUBLICATION_GIT_ERROR_CODES, PUBLICATION_GIT_OPERATIONS, PUBLICATION_GIT_FAILURE_SUBTYPES, getPublicationGitProcessDiagnostics, publicationGitClient, publicationGitErrorMessage, PublicationGitError } from "./publication-git-process.mjs";

const SHA = /^[a-f\d]{40}$/u;
const HASH = /^[a-f\d]{64}$/u;
function validIdentity(identity) {
  return identity && [identity.name, identity.email].every(value =>
    typeof value === "string" && value.trim() && value.length <= 1024 && !/[\r\n\0<>]/u.test(value));
}

function readIdentity(git, stage) {
  const identity = Object.fromEntries(["name", "email"].map(key => [key,
    git(["config", "--get", `user.${key}`], { stage, fallback: "MISSING_GIT_IDENTITY" }).stdout.trim()]));
  if (!validIdentity(identity)) fail("MISSING_GIT_IDENTITY", stage);
  return identity;
}

/** Run before asking Sites for a short-lived credential. Does not mutate Git. */
export async function preflightPublicationGit({ projectDir, gitExecutable, runner, allowNewProject = false } = {}) {
  let root;
  try { root = await realpath(resolve(projectDir)); }
  catch { fail("INVALID_PROJECT_ROOT", "preflight"); }
  const git = gitClient({ projectDir: root, gitExecutable, runner });
  if (allowNewProject) {
    try { await lstat(join(root, ".git")); }
    catch (error) {
      if (error.code !== "ENOENT") fail("INVALID_PROJECT_ROOT", "preflight");
      git(["--version"], { stage: "preflight" });
      return { projectDir: root, identity: readIdentity(git, "preflight"), sourceRevision: null, needsInitialization: true };
    }
  }
  const top = git(["rev-parse", "--show-toplevel"], { stage: "preflight", fallback: "INVALID_PROJECT_ROOT" }).stdout.trim();
  try { if (await realpath(top) !== root) fail("INVALID_PROJECT_ROOT", "preflight"); }
  catch (error) { if (error instanceof PublicationGitError) throw error; fail("INVALID_PROJECT_ROOT", "preflight"); }
  const sourceRevision = git(["rev-parse", "--verify", "HEAD^{commit}"], { stage: "preflight", fallback: "MISSING_AUTHORING_HEAD" }).stdout.trim();
  if (!SHA.test(sourceRevision)) fail("MISSING_AUTHORING_HEAD", "preflight");
  const identity = readIdentity(git, "preflight");
  return { projectDir: root, sourceRevision, identity };
}

/** Explicit local bootstrap for a new generated project; never commit an existing repository. */
export async function initializePublicationGit({ projectDir, gitExecutable, runner } = {}) {
  let root;
  try {
    root = await realpath(resolve(projectDir));
    for (const name of ["package.json", ".openai/hosting.json"]) {
      if (!(await lstat(join(root, name))).isFile()) fail("INVALID_PROJECT_ROOT", "initialize");
    }
    try { await lstat(join(root, ".git")); fail("EXISTING_GIT_REPOSITORY", "initialize"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  } catch (error) {
    if (error instanceof PublicationGitError) throw error;
    fail("INVALID_PROJECT_ROOT", "initialize");
  }
  const git = gitClient({ projectDir: root, gitExecutable, runner });
  const identity = readIdentity(git, "initialize");
  git(["init", "--quiet"], { stage: "initialize" });
  git(["add", "--all", "--", "."], { stage: "initialize" });
  git(["commit", "--quiet", "--file=-"], { stage: "initialize", identity, input: "Preserve reviewed Data authoring source\n" });
  // Identity may have come from the parent repository; keep it per-process.
  const sourceRevision = git(["rev-parse", "--verify", "HEAD^{commit}"], { stage: "initialize" }).stdout.trim();
  if (!SHA.test(sourceRevision)) fail("MISSING_AUTHORING_HEAD", "initialize");
  return { projectDir: root, sourceRevision, identity };
}

function credentialConfig(credential) {
  let url;
  try { url = new URL(credential?.remote_url); } catch { fail("INVALID_CREDENTIAL", "credential"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash
    || url.href !== credential.remote_url || /[\s\0]/u.test(credential.remote_url)
    || typeof credential.branch !== "string" || !credential.branch || credential.branch.startsWith("-")
    || /[\r\n\0]/u.test(credential.branch) || credential.auth_mode !== "http_extra_header"
    || typeof credential.token !== "string" || !credential.token || credential.token.length > 65536
    || /[\r\n\0]/u.test(credential.token) || !Number.isFinite(Date.parse(credential.token_expires_at))) {
    fail("INVALID_CREDENTIAL", "credential");
  }
  if (Date.parse(credential.token_expires_at) <= Date.now()) fail("EXPIRED_CREDENTIAL", "credential");
  return [
    ["credential.helper", ""], ["http.extraHeader", ""],
    [`credential.${url.href}.helper`, ""], [`http.${url.href}.extraHeader`, ""],
    [`http.${url.href}.extraHeader`, `Authorization: Bearer ${credential.token}`],
    ["http.followRedirects", "false"], ["http.sslVerify", "true"],
    [`http.${url.href}.followRedirects`, "false"], [`http.${url.href}.sslVerify`, "true"],
    ["protocol.allow", "never"], ["protocol.https.allow", "always"],
  ];
}

function verifyRemoteDestination(git, remoteUrl) {
  const result = git(["config", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"], {
    stage: "credential", statuses: [0, 1],
  });
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const separator = entry.indexOf("\n");
    const key = entry.slice(0, separator), prefix = entry.slice(separator + 1);
    const destination = /^url\.(.*)\.(?:insteadof|pushinsteadof)$/u.exec(key)?.[1];
    if (separator < 0 || destination === undefined) fail("UNSAFE_GIT_CONFIGURATION", "credential");
    if (remoteUrl.startsWith(prefix) && destination + remoteUrl.slice(prefix.length) !== remoteUrl) {
      fail("UNSAFE_GIT_CONFIGURATION", "credential");
    }
  }
}

function sourcePath(name) {
  return typeof name === "string" && !/[\\\0-\x1f\x7f:]/u.test(name)
    && name.split("/").every(part => part && ![".", "..", ".git", "node_modules"].includes(part.toLowerCase()))
    && name !== "src/data.json";
}

async function verifyCandidate(root) {
  const bytes = await readFile(join(root, PUBLICATION_SOURCE_MANIFEST));
  if (bytes.length > 4 * 1024 * 1024) fail("SOURCE_CHANGED", "source");
  const manifest = JSON.parse(bytes);
  if (manifest.version !== 1 || manifest.kind !== "data-app-publication-source-v1" || !SHA.test(manifest.sourceRevision)
    || !manifest.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || !Object.hasOwn(manifest.files, "package.json") || !Object.hasOwn(manifest.files, ".openai/hosting.json")
    || Object.hasOwn(manifest.files, PUBLICATION_SOURCE_MANIFEST)) fail("SOURCE_CHANGED", "source");
  const expected = new Set([PUBLICATION_SOURCE_MANIFEST, ...Object.keys(manifest.files)]);
  async function visit(prefix = "") {
    for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (name === ".git" && entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) fail("SOURCE_CHANGED", "source");
      if (entry.isDirectory()) { await visit(name); continue; }
      if (!entry.isFile() || !expected.has(name)) fail("SOURCE_CHANGED", "source");
      expected.delete(name);
      if (name === PUBLICATION_SOURCE_MANIFEST) continue;
      const item = manifest.files[name];
      if (!sourcePath(name) || !HASH.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0
        || !Number.isSafeInteger(item.mode) || item.mode < 0 || item.mode > 0o777
        || item.role !== (name.startsWith("dist/") ? "deployment-output" : "source")) fail("SOURCE_CHANGED", "source");
      const hash = createHash("sha256"); let count = 0;
      for await (const chunk of createReadStream(join(root, name))) { hash.update(chunk); count += chunk.length; }
      if (count !== item.bytes || hash.digest("hex") !== item.sha256) fail("SOURCE_CHANGED", "source");
    }
  }
  await visit();
  if (expected.size) fail("SOURCE_CHANGED", "source");
  return { manifest, manifestSha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function verifyPublicationCandidate({ publicationProjectDir } = {}) {
  try { return await verifyCandidate(await realpath(resolve(publicationProjectDir))); }
  catch { fail("SOURCE_CHANGED", "source"); }
}

/** Push only a verified separate publication candidate; never alter authoring history.
 * The native Sites caller supplies the credential and owns renewal. Keep receipts,
 * but do not persist function arguments or child environment values.
 */
export async function publishPublicationSource({ publicationProjectDir, credential, identity, gitExecutable, receipt, runner } = {}) {
  let current;
  try {
    const config = credentialConfig(credential);
    if (!validIdentity(identity)) fail("MISSING_GIT_IDENTITY", "source");
    const root = await realpath(resolve(publicationProjectDir));
    const git = gitClient({ projectDir: root, gitExecutable, runner });
    const run = (args, options = {}) => git(args, { stage: "source", ...options }).stdout.trim();
    run(["check-ref-format", `refs/heads/${credential.branch}`], { stage: "credential", fallback: "INVALID_CREDENTIAL" });
    const { manifest, manifestSha256 } = await verifyCandidate(root);
    current = { version: 1, state: "initialized", publicationProjectDir: root, remoteUrl: credential.remote_url,
      branch: credential.branch, manifestSha256 };
    let exists = false;
    try { exists = (await lstat(join(root, ".git"))).isDirectory(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (receipt) {
      if (!exists || !["initialized", "committed", "pushed"].includes(receipt.state)
        || Object.keys(current).some(key => key !== "state" && receipt[key] !== current[key])) fail("INVALID_RECEIPT", "source");
      current = { ...current, ...Object.fromEntries(["state", "commitSha", "treeSha", "parentSha"].filter(key => key in receipt).map(key => [key, receipt[key]])) };
      if (await realpath(run(["rev-parse", "--show-toplevel"])) !== root) fail("INVALID_RECEIPT", "source");
      const head = git(["rev-parse", "--verify", "HEAD"], { stage: "source", statuses: [0, 128] });
      if (current.commitSha ? !SHA.test(current.commitSha) || head.stdout.trim() !== current.commitSha : head.status === 0) fail("INVALID_RECEIPT", "source");
    } else {
      if (exists) fail("INVALID_RECEIPT", "source");
      run(["init", "--quiet"]);
      run(["symbolic-ref", "HEAD", `refs/heads/${credential.branch}`]);
    }
    verifyRemoteDestination(git, credential.remote_url);
    // Batch object/index plumbing preserves bytes and modes even with Windows
    // autocrlf or authored attributes; no checkout, filters or shell quoting.
    const names = [...Object.keys(manifest.files).filter(name => manifest.files[name].role === "source"), PUBLICATION_SOURCE_MANIFEST].sort();
    const hashes = run(["hash-object", "-w", "--no-filters", "--stdin-paths"], { input: names.map(name => JSON.stringify(name)).join("\n") + "\n" }).split("\n");
    if (hashes.length !== names.length || hashes.some(hash => !SHA.test(hash))) fail("GIT_FAILED", "source");
    run(["read-tree", "--empty"]);
    run(["update-index", "-z", "--index-info"], { input: names.map((name, i) => `${manifest.files[name]?.mode & 0o111 ? "100755" : "100644"} ${hashes[i]}\t${name}\0`).join("") });
    const treeSha = run(["write-tree"]);
    if ((await verifyCandidate(root)).manifestSha256 !== manifestSha256) fail("SOURCE_CHANGED", "source");
    if (current.commitSha) {
      if (current.treeSha !== treeSha || run(["rev-parse", `${current.commitSha}^{tree}`]) !== treeSha) fail("SOURCE_CHANGED", "source");
    } else {
      const remote = git(["ls-remote", "--exit-code", "--refs", credential.remote_url, `refs/heads/${credential.branch}`], {
        stage: "fetch", fallback: "NETWORK_FAILED", config, statuses: [0, 2],
      });
      let parentSha = null;
      if (remote.status === 0) {
        const match = /^([a-f\d]{40})\t([^\r\n]+)\r?\n?$/u.exec(remote.stdout);
        if (!match || match[2] !== `refs/heads/${credential.branch}`) fail("GIT_FAILED", "fetch");
        parentSha = match[1];
        run(["fetch", "--no-tags", credential.remote_url, `refs/heads/${credential.branch}`], { stage: "fetch", fallback: "NETWORK_FAILED", config });
        if (run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]) !== parentSha) fail("PUSH_REJECTED", "fetch");
      }
      const commitSha = run(["commit-tree", treeSha, ...(parentSha ? ["-p", parentSha] : [])], {
        input: "Publish reviewed Data artifact\n", identity,
      });
      if (!SHA.test(commitSha)) fail("GIT_FAILED", "source");
      run(["update-ref", "HEAD", commitSha]);
      current = { ...current, state: "committed", treeSha, parentSha, commitSha };
    }
    // A failed or uncertain push retains this exact commit for a credential retry.
    if (Date.parse(credential.token_expires_at) <= Date.now()) fail("EXPIRED_CREDENTIAL", "push");
    run(["push", "--porcelain", credential.remote_url, `${current.commitSha}:refs/heads/${credential.branch}`], {
      stage: "push", fallback: "NETWORK_FAILED", config,
    });
    if (run(["rev-parse", "--verify", "HEAD"]) !== current.commitSha) fail("SOURCE_CHANGED", "source");
    return { ...current, state: "pushed" };
  } catch (error) {
    if (error instanceof PublicationGitError) {
      if (current) error.receipt = current;
      throw error;
    }
    fail("SOURCE_CHANGED", "source", current);
  }
}
