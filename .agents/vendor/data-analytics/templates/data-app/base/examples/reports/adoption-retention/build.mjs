import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const example = dirname(fileURLToPath(import.meta.url));
const template = resolve(example, "../../..");
const pluginRoot = resolve(template, "../../..");
const args = process.argv.slice(2);
const localPreview = args.includes("--local-preview");
const outputIndex = args.indexOf("--output-root");
let outputRoot;
if (outputIndex >= 0) {
  if (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--")) throw new Error("--output-root requires a directory.");
  outputRoot = resolve(args[outputIndex + 1]);
  args.splice(outputIndex, 2);
}
if (args.some((arg) => !["--technical", "--local-preview"].includes(arg))) {
  throw new Error("Usage: node build.mjs [--technical] [--local-preview] [--output-root DIRECTORY]");
}
if (localPreview && !existsSync(join(template, "node_modules"))) {
  throw new Error("Install the canonical template dependencies before building this example.");
}

// Always build a fresh temporary artifact. Never replace the shared starter's data.
let project = outputRoot ?? mkdtempSync(join(tmpdir(), "data-report-adoption-retention-"));
if (outputRoot) {
  if (existsSync(project)) throw new Error(`Refusing to overwrite an existing example: ${project}`);
  mkdirSync(project, { recursive: true });
}
project = realpathSync(project);
cpSync(template, project, {
  recursive: true,
  filter: (path) => !["node_modules", "dist", "examples"].some((entry) =>
    path === join(template, entry) || path.startsWith(`${join(template, entry)}/`)),
});
if (localPreview && existsSync(join(template, "node_modules"))) symlinkSync(join(template, "node_modules"), join(project, "node_modules"), "dir");
const reviewed = JSON.parse(readFileSync(join(example, "data.json"), "utf8"));
const snapshot = { ...reviewed, surface: "report", report: {
  ...reviewed.report, audience: args.includes("--technical") ? "technical" : "executive",
  showTables: args.includes("--technical"),
} };
writeFileSync(join(project, "src/data.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
cpSync(join(example, "ReportContent.jsx"), join(project, "src/content/report/ReportContent.jsx"));
cpSync(join(example, "annotation-stories.mjs"), join(project, "src/content/report/annotation-stories.mjs"));
const reportStyles = join(project, "src/content/report/report.css");
writeFileSync(reportStyles, `${readFileSync(reportStyles, "utf8")}\n${readFileSync(join(example, "report.css"), "utf8")}`);
function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}\nTemporary project: ${project}`);
}
if (localPreview) {
  run("npm", ["run", "verify:runtime"]);
  // A private loopback preview needs the exact local project for its existing actions.
  // Keep this transient build definition out of the protected Vite config and exports.
  run(process.execPath, ["--input-type=module", "-e", 'import { build } from "vite"; '
    + 'await build({ define: { __DATA_APP_PROJECT_ROOT__: JSON.stringify(process.cwd()) } });']);
} else {
  run(process.execPath, [join(pluginRoot, "scripts/data-app.mjs"), "build", "--project-dir", project]);
}
console.log(JSON.stringify({ project, html: join(project, "dist/index.html"),
  audience: snapshot.report.audience, localPreview }, null, 2));
