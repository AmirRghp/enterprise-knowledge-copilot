import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { annotationSnapshot } from "./fixture.mjs";

const example = dirname(fileURLToPath(import.meta.url));
const template = resolve(example, "../../..");
const pluginRoot = resolve(template, "../../..");

export function buildAnnotationExample(surface = "report", { localPreview = false, outputRoot, buildProject } = {}) {
  const snapshot = annotationSnapshot(surface);
  if (localPreview && !existsSync(join(template, "node_modules"))) throw new Error("Install the canonical template dependencies first.");
  let project = outputRoot ? join(resolve(outputRoot), surface)
    : mkdtempSync(join(tmpdir(), `data-chart-annotations-${surface}-`));
  if (outputRoot) {
    if (existsSync(project)) throw new Error(`Refusing to overwrite an existing example: ${project}`);
    mkdirSync(project, { recursive: true });
  }
  project = realpathSync(project);
  cpSync(template, project, { recursive: true, filter: (path) => !["node_modules", "dist", "examples"].some((entry) =>
    path === join(template, entry) || path.startsWith(`${join(template, entry)}/`)) });
  if (localPreview && existsSync(join(template, "node_modules"))) symlinkSync(join(template, "node_modules"), join(project, "node_modules"), "dir");
  const shared = join(project, "src/content/shared/chart-annotations");
  mkdirSync(shared, { recursive: true });
  for (const file of ["SharedAnnotationExample.jsx", "fixture.mjs", "example.css"]) cpSync(join(example, file), join(shared, file));
  for (const kind of ["Report", "Dashboard"]) cpSync(join(example, `${kind}Content.jsx`),
    join(project, `src/content/${kind.toLowerCase()}/${kind}Content.jsx`));
  writeFileSync(join(project, "src/data.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
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
  } else run(process.execPath, [join(pluginRoot, "scripts/data-app.mjs"), "build", "--project-dir", project]);
  return { project, html: join(project, "dist/index.html"), surface, localPreview };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const options = { localPreview: args.includes("--local-preview") };
  const outputIndex = args.indexOf("--output-root");
  if (outputIndex >= 0) {
    if (!args[outputIndex + 1] || args[outputIndex + 1].startsWith("--")) throw new Error("--output-root requires a directory.");
    options.outputRoot = args[outputIndex + 1];
    args.splice(outputIndex, 2);
  }
  const surfaces = args.filter((arg) => arg !== "--local-preview");
  if (surfaces.some((surface) => !["report", "dashboard"].includes(surface)))
    throw new Error("Usage: node build.mjs [report] [dashboard] [--local-preview] [--output-root DIRECTORY]");
  for (const surface of surfaces.length ? surfaces : ["report", "dashboard"])
    console.log(JSON.stringify(buildAnnotationExample(surface, options), null, 2));
}
