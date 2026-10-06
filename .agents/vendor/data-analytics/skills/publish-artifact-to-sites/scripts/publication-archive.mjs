import { createHash } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const BLOCK = 512;
const CHUNK = 256 * 1024;
const MAX_OCTAL_SIZE = 0o77777777777;
const FORBIDDEN = new Set([".git", "node_modules", ".data-app-assets", ".data-app-offline"]);

function fail(message) { throw new Error(message); }
function inside(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`));
}
function archiveName(value) {
  if (/[\\:\u0000-\u001f\u007f]/u.test(value) || value.split("/").some(part => !part || part === "." || part === ".." || FORBIDDEN.has(part.toLowerCase()))) {
    fail("Deployment output contains an unsafe path or a source/private asset directory.");
  }
  return value;
}
function unchanged(before, after) {
  return ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key]);
}
async function inspect(path, snapshots) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isFile() && !stat.isDirectory()) fail("Publication archive inputs must be regular files and directories, without symlinks.");
  snapshots.set(path, stat);
  return stat;
}
async function assertStable(path, expected) {
  if (!unchanged(expected, await lstat(path, { bigint: true }))) fail("A publication archive input changed during packaging; retry with a stable build.");
}

async function* fileBytes(entry) {
  const input = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!unchanged(entry.stat, await input.stat({ bigint: true }))) fail("A publication archive input changed before reading.");
    let remaining = Number(entry.stat.size);
    while (remaining > 0) {
      // Each yielded buffer belongs to the stream until its consumer finishes.
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, remaining));
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (!bytesRead) fail("A publication archive input was truncated during reading.");
      remaining -= bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
    if (!unchanged(entry.stat, await input.stat({ bigint: true }))) fail("A publication archive input changed while reading.");
    await assertStable(entry.path, entry.stat);
  } finally { await input.close(); }
}

// POSIX tar records use byte counts, including for UTF-8 PAX extended paths.
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(body) + String(length).length !== length) length = Buffer.byteLength(body) + String(length).length;
  return Buffer.from(`${length}${body}`);
}
function header(name, size, type) {
  const result = Buffer.alloc(BLOCK);
  result.write(name, 0, 100, "ascii");
  const octal = (value, offset, length) => result.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
  octal(type === "5" ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8);
  octal(size, 124, 12); octal(0, 136, 12);
  result.fill(32, 148, 156);
  result.write(type, 156, 1, "ascii");
  result.write("ustar\0", 257, 6, "ascii");
  result.write("00", 263, 2, "ascii");
  const checksum = result.reduce((sum, byte) => sum + byte, 0);
  result.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return result;
}
function padding(size) { return Buffer.alloc((BLOCK - size % BLOCK) % BLOCK); }
async function* tarBytes(entries) {
  let index = 0;
  for (const entry of entries) {
    const size = entry.directory ? 0 : Number(entry.stat.size);
    const name = entry.directory ? `${entry.name}/` : entry.name;
    const extended = [];
    if (Buffer.byteLength(name) > 100 || /[^\x20-\x7e]/u.test(name) || size > MAX_OCTAL_SIZE) extended.push(paxRecord("path", name));
    if (size > MAX_OCTAL_SIZE) extended.push(paxRecord("size", String(size)));
    if (extended.length) {
      const pax = Buffer.concat(extended);
      yield header(`PaxHeaders/${index}`, pax.length, "x");
      yield pax; yield padding(pax.length);
    }
    yield header(extended.length ? `PaxEntry/${index}` : name, size > MAX_OCTAL_SIZE ? 0 : size, entry.directory ? "5" : "0");
    if (!entry.directory) {
      yield* fileBytes(entry);
      yield padding(size);
    }
    index += 1;
  }
  yield Buffer.alloc(BLOCK * 2);
}

/** Package the Data custom Worker for Sites without Bash, tar, or source edits. */
export async function createPublicationArchive({ projectDir, projectId, archivePath }) {
  if (typeof projectId !== "string" || projectId.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(projectId)) fail("A valid Site project ID is required.");
  if (typeof projectDir !== "string" || !projectDir || typeof archivePath !== "string" || !archivePath) fail("Project and archive paths are required.");
  if (!(await lstat(resolve(projectDir))).isDirectory()) fail("The publication project must be a directory, not a symlink.");
  const root = await realpath(projectDir);
  const snapshots = new Map(), entries = new Map();
  const add = async (path, name) => {
    archiveName(name);
    const stat = await inspect(path, snapshots);
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail("A publication archive input exceeds the supported size.");
    if (entries.has(name) && entries.get(name).directory !== stat.isDirectory()) fail("Built and source deployment sidecars have conflicting file types.");
    entries.set(name, { name, path, stat, directory: stat.isDirectory() });
    if (stat.isDirectory()) {
      for (const child of (await readdir(path)).sort()) await add(join(path, child), `${name}/${child}`);
    }
  };
  const dist = join(root, "dist"), hostingDirectory = join(root, ".openai"), migrations = join(root, "drizzle");
  if (!(await inspect(dist, snapshots)).isDirectory() || !(await inspect(hostingDirectory, snapshots)).isDirectory()) fail("Missing Data deployment output or hosting metadata.");
  await add(dist, "dist");
  const worker = entries.get("dist/server/index.js");
  if (!worker || worker.directory || !worker.stat.size) fail("Missing Data Worker at dist/server/index.js; package the app first.");
  const hostingPath = join(hostingDirectory, "hosting.json");
  const hostingStat = await inspect(hostingPath, snapshots);
  if (!hostingStat.isFile() || hostingStat.size > 65536n) fail("Invalid hosting metadata.");
  const chunks = [];
  for await (const chunk of fileBytes({ path: hostingPath, stat: hostingStat })) chunks.push(chunk);
  let hosting;
  try { hosting = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail("Hosting metadata is not valid JSON."); }
  if (!hosting || hosting.project_id !== projectId || hosting.d1 !== "DB" || hosting.r2 !== "BUCKET" || hosting.static != null) {
    fail("Hosting metadata must preserve the selected Site, custom Worker, and logical DB/BUCKET bindings.");
  }
  if (entries.has("dist/.openai") && !entries.get("dist/.openai").directory
    || entries.get("dist/.openai/hosting.json")?.directory) fail("Built hosting metadata has an invalid file type.");
  // Match Sites staging: the source manifest is authoritative; source migrations
  // overlay any already-built migrations while preserving other dist sidecars.
  entries.set("dist/.openai", { name: "dist/.openai", directory: true });
  entries.set("dist/.openai/hosting.json", { name: "dist/.openai/hosting.json", path: hostingPath, stat: hostingStat, directory: false });
  let migrationsStat;
  try { migrationsStat = await lstat(migrations); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (migrationsStat) {
    if (!migrationsStat.isDirectory()) fail("Publication migrations must be a directory, not a symlink.");
    await add(migrations, "dist/.openai/drizzle");
  }

  const requestedOutput = resolve(archivePath);
  // Resolve the existing ancestor before creating output directories, so a
  // symlink alias cannot put an archive inside an input tree.
  let ancestor = dirname(requestedOutput), suffix = [];
  while (true) {
    try { ancestor = await realpath(ancestor); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(relative(parent, ancestor)); ancestor = parent;
    }
  }
  const destination = join(ancestor, ...suffix, relative(dirname(requestedOutput), requestedOutput));
  if ([dist, hostingDirectory, migrations].some(input => inside(input, destination)) || snapshots.has(destination)) {
    fail("The publication archive must be outside its input directories.");
  }
  try { await lstat(destination); fail("The publication archive already exists; use a new output path."); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".data-publication-archive-"));
  const staged = join(temporary, "archive.tar.gz");
  const hash = createHash("sha256");
  let bytes = 0;
  const digest = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); bytes += chunk.length; callback(null, chunk); } });
  try {
    const ordered = [...entries.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    await pipeline(Readable.from(tarBytes(ordered)), createGzip(), digest, createWriteStream(staged, { flags: "wx", mode: 0o600 }));
    for (const [path, stat] of snapshots) await assertStable(path, stat);
    if (!migrationsStat) {
      try { await lstat(migrations); fail("Publication migrations changed during packaging; retry with a stable build."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // link is an atomic, no-clobber publication on Windows and POSIX. An error
    // leaves any existing destination intact, and cleanup removes partial bytes.
    await link(staged, destination);
    return { archivePath: destination, sha256: hash.digest("hex"), bytes, files: ordered.filter(entry => !entry.directory).map(entry => entry.name) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
