import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { digestProtectedFile, normalizeProtectedFile } from "../scripts/protected-file-digest.mjs";

const template = fileURLToPath(new URL("../", import.meta.url));

function copiedTemplate() {
  const copy = mkdtempSync(join(tmpdir(), "data-app-integrity-"));
  cpSync(template, copy, {
    recursive: true,
    filter: (path) => !path.includes("/node_modules") && !path.includes("/dist"),
  });
  symlinkSync(join(template, "node_modules"), join(copy, "node_modules"), "dir");
  return copy;
}

function runBuild(directory, environment = {}) {
  return spawnSync("npm", ["run", "build"], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", ...environment },
  });
}

function runIntegrity(directory, options = [], environment = {}) {
  return spawnSync(process.execPath, ["scripts/verify-protected-runtime.mjs", ...options], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

function updateIntegrityFixture(directory) {
  const result = runIntegrity(directory, ["--update", "--maintainer"], { DATA_APP_MAINTAINER: "1" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function runAuthorization(directory, scopes) {
  return spawnSync(
    process.execPath,
    [
      "scripts/authorize-protected-change.mjs",
      "--confirmed",
      ...scopes.flatMap((scope) => ["--scope", scope]),
      "--reason",
      "User confirmed the specifically scoped test change",
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, DATA_APP_USER_CONFIRMED: "1" },
    },
  );
}

function ownerSourceWithSeeds(source, { emailHash = "" } = {}) {
  return source.replace(
    /export const dataAppOwnerEmailSha256 = "[^"]*";/u,
    `export const dataAppOwnerEmailSha256 = "${emailHash}";`,
  );
}

function writePublicationMetadata(directory, { projectId = "appgprj_reviewed", ...owner } = {}) {
  const ownerPath = join(directory, "src/data-app-owner.js");
  const ownerSource = readFileSync(ownerPath, "utf8");
  writeFileSync(ownerPath, ownerSourceWithSeeds(ownerSource, owner));
  const hostingPath = join(directory, ".openai/hosting.json");
  const hosting = JSON.parse(readFileSync(hostingPath, "utf8"));
  writeFileSync(hostingPath, `${JSON.stringify({ ...hosting, project_id: projectId, d1: "DB" }, null, 2)}\n`);
}

test("protected file digests normalize only valid owner email hashes", () => {
  const path = "src/data-app-owner.js";
  const original = readFileSync(join(template, path));
  const expected = createHash("sha256").update(original).digest("hex");
  assert.equal(digestProtectedFile(path, original), expected, "Unseeded manifest v1 hashes stay compatible");
  for (const owner of [
    {},
    { emailHash: "c".repeat(64) },
    { emailHash: "D".repeat(64) },
  ]) {
    const seeded = Buffer.from(ownerSourceWithSeeds(original.toString("utf8"), owner));
    assert.deepEqual(normalizeProtectedFile(path, seeded), original);
    assert.equal(digestProtectedFile(path, seeded), expected);
    assert.equal(
      digestProtectedFile("src/another-owner.js", seeded),
      createHash("sha256").update(seeded).digest("hex"),
    );
  }
  const commentEdit = Buffer.concat([original, Buffer.from("// changed protected comment\n")]);
  assert.notEqual(digestProtectedFile(path, commentEdit), expected);
  for (const emailHash of ["abc", "a".repeat(63), "a".repeat(65), "g".repeat(64), "a\\nb"]) {
    assert.throws(
      () => digestProtectedFile(path, ownerSourceWithSeeds(original.toString("utf8"), { emailHash })),
      /owner seed must be empty or a SHA-256/u,
    );
  }
  for (const extra of [
    "\nconsole.log('extra executable code');\n",
    '\nexport const dataAppOwnerUserIdSha256 = "";\n',
    '\nexport const dataAppOwnerEmailSha256 = "";\n',
    "\n/* first comment */ console.log('not a comment'); /* second comment */\n",
  ]) {
    assert.throws(() => digestProtectedFile(path, `${original}${extra}`), /exactly its expected owner export/u);
  }
  for (const malformedModule of [
    '// export const dataAppOwnerEmailSha256 = "";\n',
    '/* export const dataAppOwnerEmailSha256 = ""; */\n',
    original.toString("utf8").replace('export const dataAppOwnerEmailSha256 = "";\n', ""),
  ]) {
    assert.throws(() => digestProtectedFile(path, malformedModule), /exactly its expected owner export/u);
  }
  assert.throws(() => digestProtectedFile(path, Buffer.concat([original, Buffer.from([0xff])])), /not valid UTF-8/u);
});

test("protected file digests preserve historical owner module bytes for migration", () => {
  const path = "src/data-app-owner.js";
  const hash = "a".repeat(64);
  const idSeed = `export const dataAppOwnerUserIdSha256 = "${hash}";\n`;
  const emptyId = 'export const dataAppOwnerUserIdSha256 = "";\n';
  const emailSeed = `export const dataAppOwnerEmailSha256 = "${hash}";\n`;
  const emptyEmail = 'export const dataAppOwnerEmailSha256 = "";\n';
  for (const declarations of [idSeed, idSeed + emptyEmail, emptyId + emailSeed]) {
    const seeded = `// Historical protected artifact\n${declarations}`;
    const normalized = Buffer.from(seeded.replace(hash, ""));
    assert.deepEqual(normalizeProtectedFile(path, seeded), normalized);
    assert.equal(digestProtectedFile(path, seeded), createHash("sha256").update(normalized).digest("hex"));
  }
  assert.throws(() => digestProtectedFile(path, idSeed + emailSeed), /owner seeds must be mutually exclusive/u);
  assert.throws(() => digestProtectedFile(path, emptyEmail + emptyId), /exactly its expected owner export/u);
});

test("protected file digests normalize only ordinary Sites publication metadata", () => {
  const path = ".openai/hosting.json";
  const original = readFileSync(join(template, path));
  const expected = createHash("sha256").update(original).digest("hex");
  assert.equal(digestProtectedFile(path, original), expected, "Unpublished manifest v1 hashes stay compatible");
  for (const hosting of [
    { d1: "DB", r2: null, project_id: "appgprj_reviewed" },
    { d1: "DB", project_id: "appgprj_reviewed", r2: null },
  ]) {
    const published = Buffer.from(`${JSON.stringify(hosting, null, 2)}\n`);
    assert.deepEqual(normalizeProtectedFile(path, published), original);
    assert.equal(digestProtectedFile(path, published), expected);
  }
  for (const projectId of [null, 1, "", "has spaces", "../another-project", "bad\u0000id", "café", "ſite", "Key"]) {
    assert.throws(
      () => digestProtectedFile(path, `${JSON.stringify({ d1: "DB", r2: null, project_id: projectId }, null, 2)}\n`),
      /invalid project_id/u,
    );
  }
  for (const contents of [
    `${JSON.stringify({ d1: "OTHER", r2: null, project_id: "appgprj_reviewed" }, null, 2)}\n`,
    `${JSON.stringify({ d1: "DB", r2: "FILES", project_id: "appgprj_reviewed" }, null, 2)}\n`,
    `${JSON.stringify({ d1: "DB", r2: null, extra: true, project_id: "appgprj_reviewed" }, null, 2)}\n`,
    `${JSON.stringify({ d1: "DB", project_id: "appgprj_reviewed" }, null, 2)}\n`,
    JSON.stringify({ d1: "DB", r2: null, project_id: "appgprj_reviewed" }),
    '{\n  "d1": "OTHER",\n  "d1": "DB",\n  "r2": null,\n  "project_id": "appgprj_reviewed"\n}\n',
    '{\r\n  "d1": "DB",\r\n  "r2": null,\r\n  "project_id": "appgprj_reviewed"\r\n}\r\n',
  ]) {
    const bytes = Buffer.from(contents);
    assert.deepEqual(normalizeProtectedFile(path, bytes), bytes, "Nonstandard hosting bytes must remain protected");
    assert.notEqual(digestProtectedFile(path, bytes), expected);
  }
  const reordered = `${JSON.stringify({ r2: null, project_id: "appgprj_reviewed", d1: "DB" }, null, 2)}\n`;
  assert.equal(
    normalizeProtectedFile(path, reordered).toString("utf8"),
    `${JSON.stringify({ r2: null, d1: "DB" }, null, 2)}\n`,
  );
  assert.notEqual(digestProtectedFile(path, reordered), expected, "Remaining key order must stay protected");
  for (const contents of ["{", "null", "[]"]) {
    assert.throws(() => digestProtectedFile(path, contents), /hosting metadata/u);
  }
});

test("publication metadata survives repeated publication, owner transfer, and maintainer manifest generation", () => {
  const copy = copiedTemplate();
  try {
    updateIntegrityFixture(copy);
    const manifestPath = join(copy, "protected-runtime.json");
    const originalManifest = readFileSync(manifestPath);
    const manifest = JSON.parse(originalManifest);
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files["scripts/protected-file-digest.mjs"], "The normalization helper must protect itself");
    for (const owner of [
      { emailHash: "c".repeat(64) },
      { emailHash: "c".repeat(64) },
      { emailHash: "d".repeat(64) },
      {},
    ]) {
      writePublicationMetadata(copy, owner);
      const result = runIntegrity(copy);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(
        readFileSync(manifestPath),
        originalManifest,
        "Publishing must not regenerate or unlock the manifest",
      );
    }
    writePublicationMetadata(copy, { emailHash: "c".repeat(64) });
    updateIntegrityFixture(copy);
    assert.deepEqual(
      readFileSync(manifestPath),
      originalManifest,
      "Maintainer generation must use the same normalized hashes",
    );
    writePublicationMetadata(copy, { emailHash: "d".repeat(64) });
    assert.equal(runIntegrity(copy).status, 0);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("publication metadata does not block narrowly authorized changes or authorize unrelated hosting edits", () => {
  const copy = copiedTemplate();
  try {
    updateIntegrityFixture(copy);
    const manifestPath = join(copy, "protected-runtime.json");
    const baseline = JSON.parse(readFileSync(manifestPath, "utf8"));
    writePublicationMetadata(copy, { emailHash: "a".repeat(64) });
    const chromePath = "src/components/DataAppChrome.jsx";
    writeFileSync(
      join(copy, chromePath),
      `${readFileSync(join(copy, chromePath), "utf8")}\n// explicitly confirmed change\n`,
    );
    const authorized = runAuthorization(copy, [chromePath]);
    assert.equal(authorized.status, 0, `${authorized.stdout}\n${authorized.stderr}`);
    const authorizedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const path of ["src/data-app-owner.js", ".openai/hosting.json"]) {
      assert.equal(authorizedManifest.files[path], baseline.files[path]);
    }
    writePublicationMetadata(copy, { emailHash: "b".repeat(64) });
    assert.equal(runIntegrity(copy).status, 0);

    const hostingPath = ".openai/hosting.json";
    const hosting = JSON.parse(readFileSync(join(copy, hostingPath), "utf8"));
    writeFileSync(join(copy, hostingPath), `${JSON.stringify({ ...hosting, r2: "FILES", extra: true }, null, 2)}\n`);
    const changed = runIntegrity(copy);
    assert.notEqual(changed.status, 0);
    assert.match(
      `${changed.stdout}\n${changed.stderr}`,
      /Protected Data app runtime file was modified: \.openai\/hosting\.json/u,
    );
    const unrelated = runAuthorization(copy, [chromePath]);
    assert.notEqual(unrelated.status, 0);
    assert.match(`${unrelated.stdout}\n${unrelated.stderr}`, /Unrelated protected runtime changes are not authorized/u);
    const confirmed = runAuthorization(copy, [hostingPath]);
    assert.equal(confirmed.status, 0, `${confirmed.stdout}\n${confirmed.stderr}`);
    assert.equal(runIntegrity(copy).status, 0, "Nonstandard bindings still use the explicit scoped authorization flow");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("publication metadata rejects malformed owners even with a matching authorization scope", () => {
  const copy = copiedTemplate();
  try {
    updateIntegrityFixture(copy);
    const manifestPath = join(copy, "protected-runtime.json");
    const originalManifest = readFileSync(manifestPath);
    writePublicationMetadata(copy, { emailHash: "not-a-sha256" });
    const rejected = runIntegrity(copy);
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /owner seed must be empty or a SHA-256/u);
    const authorization = runAuthorization(copy, ["src/data-app-owner.js"]);
    assert.notEqual(authorization.status, 0);
    assert.match(`${authorization.stdout}\n${authorization.stderr}`, /owner seed must be empty or a SHA-256/u);
    assert.deepEqual(readFileSync(manifestPath), originalManifest);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("protected shell, documentation, actions, entrypoint, and build wiring cannot be modified", () => {
  for (const protectedPath of [
    "src/DataAppShell.jsx",
    "src/App.jsx",
    "AGENTS.md",
    "docs/components/charts.md",
    "src/data-app-public.jsx",
    "src/components/DataComponent.jsx",
    "src/data-app-actions.js",
    "vite.config.js",
  ]) {
    const copy = copiedTemplate();
    try {
      const path = join(copy, protectedPath);
      writeFileSync(path, `${readFileSync(path, "utf8")}\n// unauthorized model edit\n`);
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, `${protectedPath} unexpectedly built after modification`);
      assert.match(`${result.stdout}\n${result.stderr}`, /Protected Data app runtime file was modified/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("removing protected infrastructure fails before Vite builds an artifact", () => {
  const copy = copiedTemplate();
  try {
    rmSync(join(copy, "src/DataAppContext.jsx"));
    const result = runBuild(copy);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Protected Data app runtime file is missing/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("missing manifests and attempts to remove either required build-verification hook fail closed", () => {
  for (const change of ["manifest", "prebuild", "build"]) {
    const copy = copiedTemplate();
    try {
      if (change === "manifest") {
        rmSync(join(copy, "protected-runtime.json"));
      } else {
        const packagePath = join(copy, "package.json");
        const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
        if (change === "prebuild") delete metadata.scripts.prebuild;
        else metadata.scripts.build = "vite build";
        writeFileSync(packagePath, `${JSON.stringify(metadata, null, 2)}\n`);
      }
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, `${change} unexpectedly bypassed runtime verification`);
      assert.match(`${result.stdout}\n${result.stderr}`, /protected Data app runtime|Protected Data app runtime/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("approved content remains editable and compiled HTML records only transient local task metadata", () => {
  const copy = copiedTemplate();
  try {
    for (const path of [
      "src/content/dashboard/DashboardContent.jsx",
      "src/content/report/ReportContent.jsx",
      "src/content/dashboard/dashboard.css",
      "src/content/report/report.css",
      "src/theme.css",
    ]) {
      writeFileSync(join(copy, path), `${readFileSync(join(copy, path), "utf8")}\n/* approved authored edit */\n`);
    }
    const dataPath = join(copy, "src/data.json");
    const snapshot = JSON.parse(readFileSync(dataPath, "utf8"));
    writeFileSync(dataPath, `${JSON.stringify({ ...snapshot, title: "Approved reviewed update" }, null, 2)}\n`);
    const threadId = "550e8400-e29b-41d4-a716-446655440000";
    const delegatedThreadId = "de305d54-75b4-431b-adb2-eb6b9e546014";
    const result = runBuild(copy, {
      CODEX_SESSION_ID: threadId,
      CODEX_THREAD_ID: delegatedThreadId,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = readFileSync(join(copy, "dist/index.html"), "utf8");
    assert.ok(
      html.includes(`<meta name="data-app-local-thread" content="${threadId}">`),
      "Delegated builds must preserve the user-visible root task without relying on a URL fragment",
    );
    assert.ok(!html.includes(delegatedThreadId), "Delegated child task IDs must never enter artifacts");
    for (const [, script] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gu)) {
      assert.ok(!script.includes(threadId), "Local task metadata must never enter bundled JavaScript");
    }

    const fallback = runBuild(copy, {
      CODEX_SESSION_ID: "not-a-uuid",
      CODEX_THREAD_ID: delegatedThreadId,
    });
    assert.equal(fallback.status, 0, `${fallback.stdout}\n${fallback.stderr}`);
    assert.ok(
      readFileSync(join(copy, "dist/index.html"), "utf8").includes(
        `<meta name="data-app-local-thread" content="${delegatedThreadId}">`,
      ),
      "Invalid root-task metadata must fall back to a valid current task",
    );

    const invalid = runBuild(copy, {
      CODEX_SESSION_ID: "not-a-uuid",
      CODEX_THREAD_ID: "../../settings",
    });
    assert.equal(invalid.status, 0, `${invalid.stdout}\n${invalid.stderr}`);
    assert.doesNotMatch(
      readFileSync(join(copy, "dist/index.html"), "utf8"),
      /<meta\s+name="data-app-local-thread"/u,
      "Invalid task identifiers must not appear in the generated artifact",
    );
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("nested authored sections, shared helpers, and custom content assets remain unrestricted", () => {
  const copy = copiedTemplate();
  try {
    for (const directory of [
      "src/content/report/sections",
      "src/content/dashboard/widgets",
      "src/content/shared/formatters",
      "src/content/assets/brand",
    ])
      mkdirSync(join(copy, directory), { recursive: true });
    writeFileSync(
      join(copy, "src/content/report/sections/ExecutiveSummary.jsx"),
      'export function ExecutiveSummary() { return "Reviewed summary"; }\n',
    );
    writeFileSync(
      join(copy, "src/content/dashboard/widgets/RevenueTrend.jsx"),
      'export function RevenueTrend() { return "Reviewed trend"; }\n',
    );
    writeFileSync(
      join(copy, "src/content/shared/formatters/revenue.js"),
      "export const formatRevenue = (value) => String(value);\n",
    );
    writeFileSync(
      join(copy, "src/content/assets/brand/company-logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"></svg>\n',
    );
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("authored styles cannot hide protected chrome or target the entire document", () => {
  for (const [path, attack] of [
    ["src/content/report/report.css", "\n.dashboard-topbar { display: none; }\n"],
    ["src/content/dashboard/dashboard.css", "\n[data-data-app-chrome=topbar] { opacity: 0; }\n"],
    ["src/content/report/report.css", "\nheader { display: none; }\n"],
    ["src/content/dashboard/dashboard.css", "\n.dashboard-root { visibility: hidden; }\n"],
    ["src/content/report/report.css", "\n#root { display: none; }\n"],
    ["src/content/report/report.css", "\n.dashboard-\\74 opbar { display: none; }\n"],
    ["src/content/dashboard/dashboard.css", "\nh\\65 ader { display: none; }\n"],
    ["src/content/report/report.css", "\nbody { pointer-events: none; }\n"],
    ["src/theme.css", "\n.theme-drawer { display: none; }\n"],
  ]) {
    const copy = copiedTemplate();
    try {
      const absolute = join(copy, path);
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${attack}`);
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, `${path} unexpectedly allowed protected chrome tampering`);
      assert.match(`${result.stdout}\n${result.stderr}`, /protected application chrome|global document/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("authored app surfaces cannot overlay or disable protected chrome", () => {
  for (const [path, attack] of [
    ["src/content/dashboard/dashboard.css", "\n.page { position: fixed; inset: 0; z-index: 9999; }\n"],
    ["src/content/report/report.css", "\n.report-page { position: absolute; top: 0; }\n"],
    ["src/content/dashboard/dashboard.css", "\n.page { position: sticky; }\n"],
    ["src/content/report/report.css", "\n.report-page { z-index: 9999; }\n"],
    ["src/content/dashboard/dashboard.css", "\n.page { inset-block-start: 0; }\n"],
    ["src/content/report/report.css", "\n.report-page { transform: translateY(-80px); }\n"],
    ["src/content/dashboard/dashboard.css", "\n.page { pointer-events: none; }\n"],
  ]) {
    const copy = copiedTemplate();
    try {
      const absolute = join(copy, path);
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}${attack}`);
      const result = spawnSync(process.execPath, ["scripts/verify-protected-runtime.mjs"], {
        cwd: copy,
        encoding: "utf8",
      });
      assert.notEqual(result.status, 0, `${path} unexpectedly allowed an app-surface overlay`);
      assert.match(`${result.stdout}\n${result.stderr}`, /cover or disable protected application chrome/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("safe relative positioning and scoped content overlays remain available", () => {
  const copy = copiedTemplate();
  try {
    const path = join(copy, "src/content/dashboard/dashboard.css");
    writeFileSync(
      path,
      `${readFileSync(
        path,
        "utf8",
      )}\n.page { position: relative; z-index: auto; pointer-events: auto; }\n.custom-tooltip { position: absolute; top: 0; z-index: 10; }\n`,
    );
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("approved theme tokens can brand protected chrome without confirmation", () => {
  const copy = copiedTemplate();
  try {
    const path = join(copy, "src/theme.css");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n:root { --data-app-chrome-background: #102133; --data-app-chrome-text: #fff; }\n`,
    );
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("authored content can style scoped report headers without affecting protected chrome", () => {
  const copy = copiedTemplate();
  try {
    const path = join(copy, "src/content/report/report.css");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n.report-content > header { color: #123456; }\n`);
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("accidental arbitrary content widths and gutters fail protected layout verification", () => {
  for (const [path, styles] of [
    ["src/content/dashboard/dashboard.css", ".page { max-width: 1480px; }"],
    ["src/content/report/report.css", ".report-page { max-width: 760px; }"],
    ["src/content/dashboard/dashboard.css", ".page { --data-app-content-width: 1800px; }"],
    ["src/content/report/report.css", ".report-page { --data-app-layout-gutter: 48px; }"],
    ["src/content/dashboard/dashboard.css", ".page { --data-app-layout-intent: authored-report; --data-app-content-width: 1800px; }"],
    ["src/content/report/report.css", ".page { --data-app-layout-intent: authored-report; --data-app-content-width: 1800px; }"],
    [
      "src/content/dashboard/dashboard.css",
      ".page { --data-app-content-width: var(--data-app-dashboard-wide-content-width); }",
    ],
  ]) {
    const copy = copiedTemplate();
    try {
      const absolute = join(copy, path);
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n${styles}\n`);
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, `${styles} unexpectedly bypassed the layout contract`);
      assert.match(`${result.stdout}\n${result.stderr}`, /layout|width|gutter/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("intentional wide, full-bleed, and user-requested widths require no protected-change confirmation", () => {
  for (const [path, styles] of [
    [
      "src/content/dashboard/dashboard.css",
      ".page { --data-app-layout-intent: wide; --data-app-content-width: var(--data-app-dashboard-wide-content-width); }",
    ],
    [
      "src/content/dashboard/dashboard.css",
      ".page { --data-app-layout-intent: full-bleed; max-width: none; padding-inline: 0; }",
    ],
    [
      "src/content/dashboard/dashboard.css",
      ".page { --data-app-layout-intent: user-requested; --data-app-content-width: 1800px; --data-app-layout-gutter: 48px; }",
    ],
    [
      "src/content/report/report.css",
      ".report-page { --data-app-layout-intent: user-requested; --data-app-content-width: 1200px; }",
    ],
    [
      "src/content/report/report.css",
      ".report-page { --data-app-layout-intent: authored-report; --data-app-content-width: 1120px; --data-app-layout-gutter: 28px; }",
    ],
  ]) {
    const copy = copiedTemplate();
    try {
      const absolute = join(copy, path);
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n${styles}\n`);
      const result = runBuild(copy);
      assert.equal(result.status, 0, `${styles}\n${result.stdout}\n${result.stderr}`);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("complete app-wide dark themes remain editable without protected-change confirmation", () => {
  const copy = copiedTemplate();
  try {
    const path = join(copy, "src/theme.css");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n:root {\n` +
        "  --background: #080b12; --surface: #101522; --surface-raised: #171d2b;\n" +
        "  --control: #151b28; --control-hover: #20283a; --text: #f4f7fb;\n" +
        "  --secondary: #93a0b7; --border: #242d3e; --accent: #8b9cff;\n" +
        "  --data-app-chrome-background: var(--background);\n" +
        "  --data-app-chrome-text: var(--text);\n}\n",
    );
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("app-wide theme tokens cannot be stranded inside authored report or dashboard content", () => {
  for (const [path, selector] of [
    ["src/content/dashboard/dashboard.css", ".page"],
    ["src/content/report/report.css", ".report-page"],
    ["src/content/dashboard/dashboard.css", '[data-data-app-content="dashboard"]'],
  ]) {
    const copy = copiedTemplate();
    try {
      const absolute = join(copy, path);
      writeFileSync(
        absolute,
        `${readFileSync(absolute, "utf8")}\n` + `${selector} { --background: #080b12; --text: #f4f7fb; }\n`,
      );
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, `${selector} unexpectedly isolated the app theme`);
      assert.match(`${result.stdout}\n${result.stderr}`, /theme tokens.*src\/theme\.css/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("authored components cannot bypass the public API or manipulate protected chrome", () => {
  for (const source of [
    'import { DataAppShell } from "../../DataAppShell.jsx";\n',
    'await import("../../DataAppShell.jsx");\n',
    'await import("../../components/DataAppChrome.jsx");\n',
    'require("../../DataAppContext.jsx");\n',
    'import "../../DataAppShell.jsx";\n',
    'document.querySelector(".dashboard-topbar").remove();\n',
    "document.body.replaceChildren();\n",
  ]) {
    const copy = copiedTemplate();
    try {
      writeFileSync(join(copy, "src/content/report/Unsafe.jsx"), source);
      const result = runBuild(copy);
      assert.notEqual(result.status, 0, "Unsafe authored code unexpectedly passed runtime verification");
      assert.match(`${result.stdout}\n${result.stderr}`, /protected behavior|protected application chrome/u);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test("authored content cannot create a second application main landmark", () => {
  const copy = copiedTemplate();
  try {
    writeFileSync(
      join(copy, "src/content/dashboard/NestedMain.jsx"),
      'export function NestedMain() { return <main className="custom-page">Nested</main>; }\n',
    );
    const result = runBuild(copy);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /nested main landmark/u);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("protected changes require explicit user authorization and exactly their authorized scope", () => {
  const copy = copiedTemplate();
  try {
    const protectedPath = "src/components/DataAppChrome.jsx";
    const path = join(copy, protectedPath);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// confirmed protected styling behavior\n`);
    const denied = spawnSync(
      "npm",
      [
        "run",
        "integrity:authorize",
        "--",
        "--confirmed",
        "--scope",
        protectedPath,
        "--reason",
        "Move refresh into the overflow menu",
      ],
      {
        cwd: copy,
        encoding: "utf8",
        env: { ...process.env, DATA_APP_USER_CONFIRMED: "0" },
      },
    );
    assert.notEqual(denied.status, 0);
    assert.match(`${denied.stdout}\n${denied.stderr}`, /explicit user request or approval/u);
    assert.notEqual(runBuild(copy).status, 0, "Denied protected change must not unlock future builds");

    const confirmed = spawnSync(
      "npm",
      [
        "run",
        "integrity:authorize",
        "--",
        "--confirmed",
        "--scope",
        protectedPath,
        "--reason",
        "User confirmed moving refresh into the overflow menu",
      ],
      {
        cwd: copy,
        encoding: "utf8",
        env: { ...process.env, DATA_APP_USER_CONFIRMED: "1" },
      },
    );
    assert.equal(confirmed.status, 0, `${confirmed.stdout}\n${confirmed.stderr}`);
    assert.match(confirmed.stdout, /User-confirmed protected change authorized only for/u);
    const result = runBuild(copy);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("confirmation cannot authorize unrelated protected modifications", () => {
  const copy = copiedTemplate();
  try {
    for (const path of ["src/components/DataAppChrome.jsx", "src/DataAppShell.jsx"]) {
      const absolute = join(copy, path);
      writeFileSync(absolute, `${readFileSync(absolute, "utf8")}\n// unrelated protected edit\n`);
    }
    const result = spawnSync(
      "npm",
      [
        "run",
        "integrity:authorize",
        "--",
        "--confirmed",
        "--scope",
        "src/components/DataAppChrome.jsx",
        "--reason",
        "User confirmed a chrome change",
      ],
      {
        cwd: copy,
        encoding: "utf8",
        env: { ...process.env, DATA_APP_USER_CONFIRMED: "1" },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unrelated protected runtime changes are not authorized/u);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("regenerating protected runtime hashes requires the explicit maintainer workflow", () => {
  const copy = copiedTemplate();
  try {
    const result = spawnSync("npm", ["run", "integrity:update"], {
      cwd: copy,
      encoding: "utf8",
      env: { ...process.env, DATA_APP_MAINTAINER: "0" },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /maintainer-only/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
