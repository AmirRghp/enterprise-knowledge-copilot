import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeProductGrowth, createReportSnapshot } from "./analysis.mjs";

const content = dirname(fileURLToPath(import.meta.url));
const project = resolve(content, "../../..");
if (content !== join(project, "src/content/report")) {
  throw new Error("Run this reproducer from the generated artifact, or use the example's build.mjs.");
}
const results = analyzeProductGrowth(readFileSync(join(content, "evidence/demo-product-growth.csv"), "utf8"));
mkdirSync(join(content, "evidence"), { recursive: true });
writeFileSync(join(content, "evidence/results.json"), `${JSON.stringify(results, null, 2)}\n`);
writeFileSync(join(project, "src/data.json"), `${JSON.stringify(createReportSnapshot(results), null, 2)}\n`);
console.log(JSON.stringify({ changePp: results.changePp, withinPp: results.withinPp, mixPp: results.mixPp }));
