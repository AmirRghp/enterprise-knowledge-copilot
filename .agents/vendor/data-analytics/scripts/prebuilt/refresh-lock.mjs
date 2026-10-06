import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { releasePackage, seedReleaseLock, validateReleaseLock, withoutResolvedUrls } from "./release-lock.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const base = resolve(here, "../../templates/data-app/base");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sourcePackage = JSON.parse(await readFile(join(base, "package.json"), "utf8"));
const sourceLock = JSON.parse(await readFile(join(base, "package-lock.json"), "utf8"));
const packageJson = releasePackage(sourcePackage, sourceLock);
const previous = await readFile(join(here, "package-lock.json"), "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
const temporary = await mkdtemp(join(tmpdir(), "data-prebuilt-lock-"));
try {
  await writeFile(join(temporary, "package.json"), json(packageJson));
  await writeFile(join(temporary, "package-lock.json"), json(seedReleaseLock(sourceLock, packageJson, previous)));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--include=dev",
      "--include=optional",
      "--install-strategy=hoisted",
      "--workspaces=false",
      ...(process.argv.includes("--offline") ? ["--offline"] : []),
    ],
    { cwd: temporary, stdio: "inherit", shell: process.platform === "win32" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Release-time npm lock refresh failed (${result.status}).`);
  const lock = withoutResolvedUrls(JSON.parse(await readFile(join(temporary, "package-lock.json"), "utf8")));
  validateReleaseLock(sourcePackage, sourceLock, packageJson, lock);
  await writeFile(join(here, "package.json"), json(packageJson));
  await writeFile(join(here, "package-lock.json"), json(lock));
  process.stdout.write("Updated the frozen Data prebuilt release lock.\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
