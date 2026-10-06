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
if (args.some((arg) => arg !== "--local-preview")) throw new Error("Usage: node build.mjs [--local-preview]");
if (localPreview && !existsSync(join(template, "node_modules"))) throw new Error("Install the canonical template dependencies first.");
let project = mkdtempSync(join(tmpdir(), "data-report-activation-diagnostics-"));
project = realpathSync(project);
cpSync(template, project, { recursive: true, filter: (path) => !["node_modules", "dist", "examples"].some((entry) =>
  path === join(template, entry) || path.startsWith(`${join(template, entry)}/`)) });
if (localPreview && existsSync(join(template, "node_modules"))) symlinkSync(join(template, "node_modules"), join(project, "node_modules"), "dir");
const content = join(project, "src/content/report");
for (const path of ["ReportContent.jsx", "analysis.mjs", "reproduce.mjs"]) {
  cpSync(join(example, path), join(content, path), { recursive: true });
}
mkdirSync(join(content, "evidence"), { recursive: true });
cpSync(resolve(template, "../../../assets/demo-product-growth.csv"), join(content, "evidence/demo-product-growth.csv"));
const reportStyles = join(content, "report.css");
writeFileSync(reportStyles, `${readFileSync(reportStyles, "utf8")}\n${readFileSync(join(example, "report.css"), "utf8")}`);
function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { cwd: project, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}\nTemporary project: ${project}`);
}
run(process.execPath, ["src/content/report/reproduce.mjs"]);
if (localPreview) {
  run("npm", ["run", "verify:runtime"]);
  run(process.execPath, ["--input-type=module", "-e", 'import { build } from "vite"; '
    + 'await build({ define: { __DATA_APP_PROJECT_ROOT__: JSON.stringify(process.cwd()) } });']);
} else {
  run(process.execPath, [join(pluginRoot, "scripts/data-app.mjs"), "build", "--project-dir", project]);
}
console.log(JSON.stringify({ project, html: join(project, "dist/index.html"), localPreview }, null, 2));
