import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fixture } from "./fixture.js";
export { fixture, products } from "./fixture.js";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { output: { type: "string" } } });
  if (!values.output || !isAbsolute(values.output)) throw new Error("Use --output /absolute/fixture.json; generated data is not stored in the plugin.");
  const data = fixture();
  const json = JSON.stringify(data, null, 2).replace(/\{\n\s+"(?:date|contractId)": [\s\S]*?\n\s+\}/g, row => JSON.stringify(JSON.parse(row)));
  writeFileSync(values.output, json + "\n");
}
