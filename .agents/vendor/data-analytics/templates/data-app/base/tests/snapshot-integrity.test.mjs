import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const configurationPath = fileURLToPath(new URL("../vite.config.js", import.meta.url));

async function loadConfiguration(projectRoot = dirname(configurationPath)) {
  const source = readFileSync(configurationPath, "utf8")
    .replace('import { defineConfig } from "vite";',
      "const defineConfig = (configuration) => configuration;")
    .replace('import { viteSingleFile } from "vite-plugin-singlefile";',
      'const viteSingleFile = () => ({ name: "vite:singlefile" });')
    .replaceAll("import.meta.url", JSON.stringify(pathToFileURL(join(projectRoot, "vite.config.js")).href));
  return (await import(`data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`)).default;
}

test("client builds bind the exact reviewed snapshot bytes to one SHA-256 HTML marker", async () => {
  const configure = await loadConfiguration();
  const client = configure({ isSsrBuild: false });
  assert.deepEqual(client.plugins.map(({ name }) => name), [
    "vite:singlefile",
    "data-app-snapshot-integrity",
    "data-app-local-task",
  ]);

  const snapshot = readFileSync(new URL("../src/data.json", import.meta.url));
  const snapshotHash = createHash("sha256").update(snapshot).digest("hex");
  assert.deepEqual(await client.plugins[1].transformIndexHtml(), [{
    tag: "meta",
    attrs: {
      name: "data-app-snapshot-sha256",
      content: snapshotHash,
    },
    injectTo: "head",
  }]);

  assert.deepEqual(configure({ isSsrBuild: true }).plugins, [],
    "Sites Worker packaging must not run browser-only HTML integrity transforms");
});

test("snapshot integrity changes when cleaned source no longer matches a stale credential-bearing build", async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "data-app-snapshot-integrity-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  mkdirSync(join(projectRoot, "src"));
  const snapshotPath = join(projectRoot, "src/data.json");
  const staleSnapshot = JSON.stringify({
    queries: { reviewed: { source: { links: ["https://warehouse.example/data?sig=secret"] } } },
  });
  const cleanedSnapshot = JSON.stringify({
    queries: { reviewed: { source: { links: ["https://warehouse.example/data"] } } },
  });
  writeFileSync(snapshotPath, staleSnapshot);

  const configure = await loadConfiguration(projectRoot);
  const plugin = configure({ isSsrBuild: false }).plugins
    .find(({ name }) => name === "data-app-snapshot-integrity");
  const staleHash = (await plugin.transformIndexHtml())[0].attrs.content;
  assert.equal(staleHash, createHash("sha256").update(staleSnapshot).digest("hex"));

  writeFileSync(snapshotPath, cleanedSnapshot);
  const cleanedHash = (await plugin.transformIndexHtml())[0].attrs.content;
  assert.equal(cleanedHash, createHash("sha256").update(cleanedSnapshot).digest("hex"));
  assert.notEqual(cleanedHash, staleHash,
    "A previously built HTML artifact cannot satisfy the cleaned snapshot's integrity marker");
});

test("gallery builds hash the snapshot loaded by that entry rather than the main sample", async () => {
  const configure=await loadConfiguration();
  const plugin=configure({isSsrBuild:false}).plugins.find(plugin => plugin.name === "data-app-snapshot-integrity");
  for (const name of ["component-lab","infrastructure-capacity","acme-workflow","fleet-operations","finance","main-report"]) {
    const entry=new URL(`../examples/${name}/data.js`,import.meta.url);
    const {snapshot}=await import(entry.href);
    const hash=createHash("sha256").update(JSON.stringify(snapshot,null,2)+"\n").digest("hex");
    const tags=await plugin.transformIndexHtml("",{filename:fileURLToPath(new URL("./index.html",entry))});
    assert.equal(tags[0].attrs.content,hash,name);
    const htmlPath = fileURLToPath(new URL("./index.html", entry));
    const development = await plugin.transformIndexHtml("", { filename: htmlPath, server: { ssrLoadModule: async () => ({ snapshot }) } });
    assert.deepEqual(JSON.parse(development.find(tag => tag.attrs.name === "data-app-local-reference").attrs.content), {
      root: dirname(configurationPath) + "/", htmlPath,
    }, "Development handoffs must identify this example, not the main dist/index.html");
    assert.ok(!tags.some(tag => tag.attrs.name === "data-app-local-reference"), "Builds must not embed development paths");
  }
});
