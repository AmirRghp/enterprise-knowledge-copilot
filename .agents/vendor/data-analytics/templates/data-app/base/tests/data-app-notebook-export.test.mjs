import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dataAppActionHref, dataAppActionRequest } from "../src/data-app-actions.js";

function notebookContext(surface = "dashboard") {
  return {
    surface,
    title: "Product adoption and engagement",
    snapshot: {
      id: "reviewed-adoption",
      generatedAt: "2026-07-28T18:00:00Z",
      queries: {
        usage_summary: {
          rows: [{ activeUsers: "PRIVATE_REVIEWED_ROW" }],
          source: {
            sql: "SELECT PRIVATE_REVIEWED_QUERY FROM analytics.product_adoption",
          },
        },
      },
    },
    dataAppReference: {
      root: "/Users/example/Product adoption",
      htmlPath: "/Users/example/Product adoption/dist/index.html",
    },
    presentation: {
      filters: { week: "2026-07-27", segment: "Enterprise" },
      assumptions: { activationLift: 12 },
      chartOverrides: { adoption: { type: "line" } },
    },
  };
}

function convertOptionGroups(source) {
  const start = source.indexOf("const convertOptionGroups = [");
  const end = source.indexOf("\n];", start);
  assert.ok(start >= 0 && end > start, "Convert option groups must be declared together");
  const groups = [];
  let current = null;
  const declarations = source.slice(start, end).replace(
    /\{\s*action:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*iconSrc:\s*(\w+),?\s*\}/gu,
    (_, action, label, iconSrc) => `{ action: "${action}", label: "${label}", iconSrc: ${iconSrc} }`,
  );
  for (const line of declarations.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "[") {
      current = [];
      continue;
    }
    if (trimmed === "],") {
      groups.push(current);
      current = null;
      continue;
    }
    const row = line.match(/\{ action: "([^"]+)", label: "([^"]+)", iconSrc: (\w+) \}/u);
    if (!row) continue;
    const value = row.slice(1);
    if (trimmed.startsWith("[{")) groups.push([value]);
    else current.push(value);
  }
  return groups;
}

test("Export stays inline with a distinct bundled icon for every format", async () => {
  const [chrome, styles] = await Promise.all([
    readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  const iconNames = ["jupyter", "pdf", "word", "powerpoint", "google-docs", "google-slides"];
  const iconAssets = await Promise.all(
    iconNames.map((name) => readFile(new URL(`../src/components/icons/convert-icon-${name}.svg`, import.meta.url), "utf8")),
  );

  assert.doesNotMatch(chrome, /<MenuSub[^>]*label="Convert to\.\.\."/u);
  const expectedGroups = [
    [
      ["pdf", "PDF", "convertPdfIcon"],
      ["word", "Word document", "convertWordIcon"],
      ["powerpoint", "PowerPoint", "convertPowerpointIcon"],
    ],
    [
      ["google-docs", "Google Docs", "convertGoogleDocsIcon"],
      ["google-slides", "Google Slides", "convertGoogleSlidesIcon"],
    ],
    [
      ["jupyter-notebook", "Jupyter Notebook", "convertJupyterIcon"],
    ],
  ];
  assert.deepEqual(convertOptionGroups(chrome), expectedGroups, "Export must keep the requested row order");
  assert.match(chrome, /<MenuGroup label="Export">\s*<DataAppConvertItems/u, "Export must be an inline labeled group");
  assert.match(chrome, /convertOptionGroups\.flat\(\)\.map/u, "Every export format must render in one flat list");
  const convertItems = chrome.match(/function DataAppConvertItems\([\s\S]*?\n\}\n\nfunction DataAppPublishButton/u)?.[0] ?? "";
  assert.doesNotMatch(convertItems, /MenuSeparator/u, "The inline Export group must not add internal dividers");
  assert.equal(new Set(iconAssets).size, iconNames.length, "Every Convert target must keep its own bundled icon asset");
  for (const [index, name] of iconNames.entries()) {
    assert.match(iconAssets[index], /^<svg\b/u, `${name} must be a committed SVG asset`);
    assert.match(chrome, new RegExp(`convert-icon-${name}\\.svg`, "u"), `${name} must use its matching bundled icon`);
  }
  assert.match(
    iconAssets[0],
    /width="24" height="24" viewBox="0 0 50 50"/u,
    "Jupyter must keep the supplied artwork in the shared 24px asset frame",
  );
  assert.match(iconAssets[0], /fill="#F37626"/u, "Jupyter must use the standard Jupyter orange");
  assert.match(
    chrome,
    /<img[^>]*className="dashboard-convert-icon"/u,
    "Convert must render the official format icons rather than a shared monochrome mask",
  );
  assert.match(
    styles,
    /\.dashboard-convert-icon\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*0\s+0\s+16px/su,
    "Convert format icons must use the shared 16px dropdown frame",
  );
});

test("Jupyter Notebook export uses the existing Codex skill without exposing reviewed data", () => {
  const request = dataAppActionRequest("jupyter-notebook", notebookContext());

  assert.equal(request.title, "Export dashboard as Jupyter Notebook");
  assert.match(request.prompt, /Use \[@Data\]\(plugin:\/\/data-analytics@openai-curated-remote\)/u);
  assert.match(request.prompt, /\$data-analytics:jupyter-notebooks/u);
  assert.match(request.prompt, /\.ipynb/iu);
  assert.match(request.prompt, /verified/iu);
  assert.match(request.prompt, /reviewed/iu);
  assert.match(request.prompt, /metric definitions/iu);
  assert.match(request.prompt, /editable/iu);
  assert.match(request.prompt, /"week": "2026-07-27"/u);
  assert.match(request.prompt, /"segment": "Enterprise"/u);
  assert.match(request.prompt, /"activationLift": 12/u);
  assert.match(request.prompt, /"chartOverrides"/u);
  assert.match(request.prompt, /Dashboard project directory: \/Users\/example\/Product adoption/u);
  assert.doesNotMatch(request.prompt, /PRIVATE_REVIEWED_ROW/u);
  assert.doesNotMatch(request.prompt, /PRIVATE_REVIEWED_QUERY/u);
});

test("Jupyter Notebook export supports reports through the same Codex request flow", () => {
  const request = dataAppActionRequest("jupyter-notebook", notebookContext("report"));

  assert.equal(request.title, "Export report as Jupyter Notebook");
  assert.match(request.prompt, /\$data-analytics:jupyter-notebooks/u);
  assert.match(request.prompt, /Report project directory: \/Users\/example\/Product adoption/u);
});

test("Jupyter Notebook export returns to the originating Codex task", (t) => {
  t.mock.getter(globalThis, "navigator", () => ({ userAgent: "CodexBrowser/1.0" }));
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const location = new URL(`file:///Users/example/Product%20adoption/dist/index.html#codexThreadId=${threadId}`);
  const action = new URL(dataAppActionHref("jupyter-notebook", notebookContext(), location));

  assert.equal(`${action.protocol}//${action.host}${action.pathname}`, `codex://threads/${threadId}`);
  assert.match(action.searchParams.get("prompt") ?? "", /\$data-analytics:jupyter-notebooks/u);
  assert.doesNotMatch(action.searchParams.get("prompt") ?? "", new RegExp(threadId, "u"));
});
