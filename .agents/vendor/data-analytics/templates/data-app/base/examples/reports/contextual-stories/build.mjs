import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContextualStories } from "./stories.mjs";

const example = dirname(fileURLToPath(import.meta.url));
const template = resolve(example, "../../..");
const pluginRoot = resolve(template, "../../..");

export function buildContextualStories({ outputRoot, localPreview = false, buildProject } = {}) {
  if (localPreview && !existsSync(join(template, "node_modules"))) throw new Error("Install the canonical template dependencies first.");
  let project = outputRoot ? resolve(outputRoot) : mkdtempSync(join(tmpdir(), "data-report-contextual-stories-"));
  if (outputRoot) {
    if (existsSync(project)) throw new Error(`Refusing to overwrite an existing project: ${project}`);
    mkdirSync(project, { recursive: true });
  }
  project = realpathSync(project);
  cpSync(template, project, { recursive: true, filter: (path) => !["node_modules", "dist", "examples"].some((entry) =>
    path === join(template, entry) || path.startsWith(`${join(template, entry)}/`)) });
  if (localPreview && existsSync(join(template, "node_modules"))) symlinkSync(join(template, "node_modules"), join(project, "node_modules"), "dir");
  const content = join(project, "src/content/report");
  for (const file of ["ReportContent.jsx", "context.mjs", "stories.mjs"]) cpSync(join(example, file), join(content, file));
  const evidence = join(content, "evidence");
  mkdirSync(evidence, { recursive: true });
  cpSync(join(example, "evidence.json"), join(evidence, "evidence.json"));
  const styles = join(content, "report.css");
  writeFileSync(styles, `${readFileSync(styles, "utf8")}\n${readFileSync(join(example, "report.css"), "utf8")}`);
  const { snapshot, results } = createContextualStories(readFileSync(join(evidence, "evidence.json"), "utf8"));
  writeFileSync(join(project, "src/data.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  writeFileSync(join(evidence, "story-results.json"), `${JSON.stringify(results, null, 2)}\n`);
  function run(command, args) {
    const result = spawnSync(command, args, { cwd: project, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}\nExample project: ${project}`);
  }
  if (localPreview) {
    run("npm", ["run", "verify:runtime"]);
    run(process.execPath, ["--input-type=module", "-e", 'import { build } from "vite"; '
      + 'await build({ define: { __DATA_APP_PROJECT_ROOT__: JSON.stringify(process.cwd()) } });']);
  } else if (buildProject) {
    const result = buildProject(project, { pluginRoot });
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}\nExample project: ${project}`);
  } else {
    run(process.execPath, [join(pluginRoot, "scripts/data-app.mjs"), "build", "--project-dir", project]);
  }
  return { project, html: join(project, "dist/index.html"), localPreview };
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { localPreview: args.includes("--local-preview") };
  const outputIndex = args.indexOf("--output-root");
  if (outputIndex >= 0) {
    if (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--")) throw new Error("--output-root requires a directory.");
    options.outputRoot = args[outputIndex + 1];
    args.splice(outputIndex, 2);
  }
  if (args.some((arg) => arg !== "--local-preview"))
    throw new Error("Usage: node build.mjs [--output-root DIRECTORY] [--local-preview]");
  console.log(JSON.stringify(buildContextualStories(options), null, 2));
}
