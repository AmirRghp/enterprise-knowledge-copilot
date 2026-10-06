import { isDeepStrictEqual } from "node:util";

export const COMPILER_DEPENDENCIES = Object.freeze({
  "@rollup/browser": "3.30.0",
  acorn: "8.17.0",
  "css-tree": "3.1.0",
  "mdn-data": "2.12.2",
  "source-map-js": "1.2.1",
  sucrase: "3.35.1",
});

// Publisher-only optimization; neither the runtime nor customer builds load it.
const BUILD_DEPENDENCIES = Object.freeze({ terser: "5.37.0" });

export function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function releasePackage(sourcePackage, sourceLock) {
  if (sourceLock.lockfileVersion !== 3 || !sourceLock.packages?.[""]) {
    throw new Error("The canonical Data app must have an npm v3 lockfile.");
  }
  const dependencies = {};
  for (const name of Object.keys({ ...sourcePackage.dependencies, ...sourcePackage.devDependencies })) {
    const entry = sourceLock.packages[`node_modules/${name}`];
    if (!entry?.version || !entry.integrity) throw new Error(`Canonical Data app does not lock ${name}.`);
    dependencies[name] = entry.version;
  }
  return {
    name: "data-app-prebuilt-release",
    version: "1.0.0",
    private: true,
    description: "Standalone, release-only build dependencies; never installed on customer machines.",
    type: "module",
    engines: { node: sourceLock.packages["node_modules/vite"].engines.node },
    dependencies: sortedObject({ ...dependencies, ...COMPILER_DEPENDENCIES, ...BUILD_DEPENDENCIES }),
  };
}

export function withoutResolvedUrls(lock) {
  const result = structuredClone(lock);
  for (const entry of Object.values(result.packages ?? {})) delete entry.resolved;
  result.packages = sortedObject(result.packages ?? {});
  return result;
}

export function seedReleaseLock(sourceLock, packageJson, extraLock = null) {
  const result = withoutResolvedUrls(sourceLock);
  if (extraLock) {
    for (const [name, entry] of Object.entries(withoutResolvedUrls(extraLock).packages)) {
      if (name && !Object.hasOwn(result.packages, name)) result.packages[name] = entry;
    }
  }
  result.name = packageJson.name;
  result.version = packageJson.version;
  result.packages[""] = {
    name: packageJson.name,
    version: packageJson.version,
    dependencies: packageJson.dependencies,
    engines: packageJson.engines,
  };
  result.packages = sortedObject(result.packages);
  return result;
}

function packageName(packagePath, entry) {
  return entry.name ?? packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
}

export function resolveLockDependency(packages, from, name) {
  let current = from;
  for (;;) {
    const candidate = `${current ? `${current}/` : ""}node_modules/${name}`;
    if (Object.hasOwn(packages, candidate)) return candidate;
    if (!current) return null;
    const parent = current.lastIndexOf("/node_modules/");
    current = parent < 0 ? "" : current.slice(0, parent);
  }
}

export function validateDependencyClosure(lock) {
  const packages = lock.packages ?? {};
  const queue = [""];
  const visited = new Set();
  while (queue.length) {
    const from = queue.shift();
    if (visited.has(from)) continue;
    visited.add(from);
    const entry = packages[from];
    if (!entry) throw new Error(`Missing release dependency: ${from}`);
    const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
    for (const [name, metadata] of Object.entries(entry.peerDependenciesMeta ?? {})) {
      if (metadata.optional) optional.add(name);
    }
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    })) {
      const dependency = resolveLockDependency(packages, from, name);
      if (!dependency) {
        // npm's universal lock can retain an uninstalled platform-specific
        // optional subtree whose peer packages live beside its actual caller.
        // The publisher's selected native install is checked again at build time.
        if (optional.has(name) || entry.optional || entry.devOptional) continue;
        throw new Error(`Missing release dependency ${name} required by ${from || "the root package"}.`);
      }
      queue.push(dependency);
    }
  }
  for (const name of Object.keys(packages)) {
    if (!visited.has(name)) throw new Error(`Extraneous package in prebuilt release lock: ${name}`);
  }
  return visited;
}

/** Existing app packages must retain their canonical tarball identities. */
export function validateReleaseLock(sourcePackage, sourceLock, packageJson, lock) {
  const expected = releasePackage(sourcePackage, sourceLock);
  if (!isDeepStrictEqual(packageJson, expected)) {
    throw new Error("The prebuilt release package is stale; run scripts/prebuilt/refresh-lock.mjs.");
  }
  if (
    lock.lockfileVersion !== 3 ||
    lock.name !== expected.name ||
    lock.version !== expected.version ||
    !isDeepStrictEqual(lock.packages?.[""]?.dependencies, expected.dependencies)
  ) {
    throw new Error("The prebuilt release lockfile does not match its package.json.");
  }
  const originals = new Map();
  for (const [packagePath, entry] of Object.entries(sourceLock.packages)) {
    if (!packagePath) continue;
    const name = packageName(packagePath, entry);
    if (!originals.has(name)) originals.set(name, new Set());
    originals.get(name).add(`${entry.version}\0${entry.integrity}`);
  }
  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath) continue;
    if ("resolved" in entry) throw new Error(`Prebuilt release lock contains a registry URL: ${packagePath}`);
    if (!entry.version || !entry.integrity)
      throw new Error(`Prebuilt dependency lacks a tarball identity: ${packagePath}`);
    const name = packageName(packagePath, entry);
    if (originals.has(name) && !originals.get(name).has(`${entry.version}\0${entry.integrity}`)) {
      throw new Error(`Prebuilt dependency drifted from the canonical lock: ${name}@${entry.version}`);
    }
  }
  for (const [name, version] of Object.entries(COMPILER_DEPENDENCIES)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new Error(`The prebuilt compiler must lock ${name}@${version}.`);
    }
  }
  for (const [name, version] of Object.entries(expected.dependencies)) {
    if (lock.packages[`node_modules/${name}`]?.version !== version) {
      throw new Error(`Prebuilt release dependency is not pinned: ${name}@${version}.`);
    }
  }
  validateDependencyClosure(lock);
}
