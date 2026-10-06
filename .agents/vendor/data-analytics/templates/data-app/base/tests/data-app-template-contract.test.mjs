import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { dataAppActionHref, dataAppActionRequest } from "../src/data-app-actions.js";

import { resolveSectionRows } from "../src/use-data-app.js";

const templateRoot = new URL("../", import.meta.url);

test("host actions preserve presentation state without embedding reviewed rows", () => {
  const context = {
    title: "Decision dashboard",
    snapshot: {
      generatedAt: "2026-07-27T12:00:00Z",
      queries: { reviewed: { rows: [{ secretMarker: 42 }] } },
    },
    presentation: {
      theme: "scientific-blue",
      title: "Edited decision dashboard",
      description: "Edited dashboard description",
      filters: { segment: "A" },
      assumptions: { activationLift: 12 },
      chartOverrides: { trend: { type: "line" } },
      hiddenBlocks: ["note"],
      componentTitles: { trend: "Edited trend" },
      textEdits: { "p:2": "Edited analysis" },
    },
  };
  const refresh = dataAppActionRequest("refresh", context);
  const publish = dataAppActionRequest("sites", context);
  const duplicate = dataAppActionRequest("duplicate", context);

  assert.match(refresh.prompt, /"segment": "A"/);
  assert.match(refresh.prompt, /"activationLift": 12/);
  assert.match(refresh.prompt, /"hiddenBlocks": \[/);
  assert.match(refresh.prompt, /"theme": "scientific-blue"/);
  assert.match(refresh.prompt, /"title": "Edited decision dashboard"/);
  assert.match(refresh.prompt, /"description": "Edited dashboard description"/);
  assert.doesNotMatch(refresh.prompt, /secretMarker/);
  assert.equal(duplicate.title, "Duplicate dashboard");
  assert.match(duplicate.prompt, /\$build-dashboard/);
  assert.match(duplicate.prompt, /new, separate dashboard/i);
  assert.match(duplicate.prompt, /view-only dashboard/i);
  assert.match(duplicate.prompt, /Never modify or overwrite the original dashboard/i);
  assert.match(duplicate.prompt, /"theme": "scientific-blue"/);
  assert.doesNotMatch(duplicate.prompt, /secretMarker/);
  assert.throws(
    () => dataAppActionRequest("duplicate", { ...context, surface: "report" }),
    /Duplication is available only for dashboards/,
  );
  assert.match(publish.prompt, /\[@Sites\]\(plugin:\/\/sites@openai-curated-remote\)/u);
  assert.match(publish.prompt, /Keep the existing Site access settings/u);
  assert.match(publish.prompt, /"theme": "scientific-blue"/u);
  assert.match(publish.prompt, /"title": "Edited decision dashboard"/u);
  assert.match(publish.prompt, /"segment": "A"/u);
  assert.match(publish.prompt, /"hiddenBlocks": \[/u);
  assert.doesNotMatch(publish.prompt, /secretMarker/u);
  const pdf = dataAppActionRequest("pdf", context);
  assert.equal(pdf.title, "Export dashboard as PDF");
  assert.match(pdf.prompt, /\$data-analytics:report-to-pdf\b/u);
  assert.match(pdf.prompt, /"segment": "A"/u);
  assert.match(pdf.prompt, /"theme": "scientific-blue"/u);
  assert.doesNotMatch(pdf.prompt, /secretMarker/u);
  for (const action of ["word", "google-docs"]) {
    assert.match(
      dataAppActionRequest(action, context).prompt,
      /Use \[@Data\]\(plugin:\/\/data-analytics@openai-curated-remote\) and invoke \$data-analytics:convert-to-doc\b/u,
    );
  }
  for (const action of ["powerpoint", "google-slides"]) {
    assert.match(
      dataAppActionRequest(action, context).prompt,
      /Use \[@Data\]\(plugin:\/\/data-analytics@openai-curated-remote\) and invoke \$data-analytics:convert-to-slides\b/u,
    );
  }
  assert.match(dataAppActionRequest("google-docs", context).prompt, /Import the verified DOCX as a native Google Doc/);
  assert.match(
    dataAppActionRequest("google-slides", context).prompt,
    /Import the verified PPTX as native Google Slides/,
  );
  assert.match(dataAppActionRequest("word", context).prompt, /rather than importing it into Google Drive/);
  assert.throws(() => dataAppActionRequest("unknown", context), /Unsupported dashboard action/);
});

test("PDF export hands the exact dashboard or report view to the agent", () => {
  for (const surface of ["dashboard", "report"]) {
    const viewUrl = "https://metrics.example.chatgpt.site/?view=1&tab=retention&f.segment=Studio";
    const context = {
      surface,
      title: "Decision report",
      viewUrl,
      snapshot: { queries: { reviewed: { rows: [{ secretMarker: 42 }] } } },
    };
    const request = dataAppActionRequest("pdf", context);
    assert.equal(request.title, `Export ${surface} as PDF`);
    assert.equal(request.viewUrl, viewUrl);
    assert.match(request.prompt, /\$data-analytics:report-to-pdf\b/u);
    assert.ok(request.prompt.includes(viewUrl));
    assert.doesNotMatch(request.prompt, /secretMarker/u);
    for (const destination of ["desktop", "web"]) {
      const href = new URL(dataAppActionHref("pdf", context, new URL(viewUrl), destination));
      assert.equal(href.protocol, destination === "web" ? "https:" : "codex:");
      assert.equal(href.searchParams.get(destination === "web" ? "q" : "prompt"), request.prompt);
    }
  }
});

test("published host actions include personal exploration without writing it to shared presentation", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");
  assert.match(
    app,
    /\.\.\.\(!hosted \? \{ filters, assumptions \} : \{\}\)/,
    "Published exploration must remain outside shared persisted presentation",
  );
  assert.match(
    app,
    /presentation:\s*\{\s*\.\.\.presentation,\s*filters,\s*assumptions,/s,
    "Refresh and export requests still need the viewer's current device-local exploration",
  );
});

test("the starter keeps its shared runtime and hosted data contract", async () => {
  const [indexHtml, main, app, runtime, dataComponent, worker, workerFactory, hosting, packageJson] = await Promise.all(
    [
      readFile(new URL("index.html", templateRoot), "utf8"),
      readFile(new URL("src/main.jsx", templateRoot), "utf8"),
      readFile(new URL("src/App.jsx", templateRoot), "utf8"),
      readFile(new URL("src/DataAppRuntime.jsx", templateRoot), "utf8"),
      readFile(new URL("src/components/DataComponent.jsx", templateRoot), "utf8"),
      readFile(new URL("src/worker.js", templateRoot), "utf8"),
      readFile(new URL("src/data-app-worker.js", templateRoot), "utf8"),
      readFile(new URL(".openai/hosting.json", templateRoot), "utf8"),
      readFile(new URL("package.json", templateRoot), "utf8"),
    ],
  );
  const packageMetadata = JSON.parse(packageJson);

  assert.match(indexHtml, /src="\/src\/main\.jsx"/u);
  assert.match(main, /export function DataAppRuntime/u);
  assert.match(main, /createRoot\(root\)\.render\(/u);
  assert.match(main, /createRoot\(root\)\.render\([\s\S]*?<DataAppRuntime\s*\/>/u);
  assert.match(main, /from ["']\.\/App\.jsx["']/u);
  assert.doesNotMatch(app, /createRoot\(/u);
  assert.match(main, /return <App hosted=\{hosted\} \/>/u);
  assert.match(app, /from ["']\.\/DataAppRuntime\.jsx["']/u);
  assert.match(app, /<DataAppRuntime[\s\S]*?reviewedSnapshot=\{reviewedSnapshot\}/u);
  assert.match(app, /DashboardContent=\{DashboardContent\}/u);
  assert.match(app, /ReportContent=\{ReportContent\}/u);
  assert.match(runtime, /export function DataAppRuntime\(/u);
  assert.match(runtime, /snapshot\.surface === "report" \? content\.ReportContent : content\.DashboardContent/u);
  assert.match(runtime, /<DataAppShell\s+snapshot=\{snapshot\}/u);
  assert.doesNotMatch(runtime, /from ["']\.\/(?:data\.json|content\/)/u);
  assert.match(dataComponent, /requires a non-empty stable id/u);
  assert.match(dataComponent, /data-component-id=\{componentId\}/u);
  assert.match(hosting, /"d1"\s*:\s*"DB"/u);
  assert.match(worker, /from ["']\.\/data-app-worker\.js["']/u);
  assert.match(worker, /export default createDataAppWorker\(\{/u);
  assert.match(worker, /html: dataAppHtml/u);
  assert.match(workerFactory, /export function createDataAppWorker\(/u);
  assert.match(workerFactory, /pathname === "\/api\/snapshot"/u);
  assert.match(workerFactory, /storedSnapshot\(database, seedSnapshot, await legacySeedFingerprint\)/u);
  assert.match(workerFactory, /snapshotResponse\(environment\.DB, \(\) => reviewedSeed\(environment\), seedFingerprint\)/u);
  assert.doesNotMatch(workerFactory, /from ["'][^"']*(?:data\.json|index\.html\?raw|data-app-owner\.js)["']/u);
  assert.equal(packageMetadata.scripts.build, "node scripts/verify-protected-runtime.mjs && vite build");
  assert.match(dataComponent, /useOptionalDataAppShell/u);
  assert.match(dataComponent, /requires a stable reviewed query id/u);
  assert.doesNotMatch(dataComponent, /requiredReportSummary|componentId === "report-executive-summary"/u,
    "Report headings and visibility belong to authored content");
});

test("report and dashboard content inherit protected chrome and source-backed component actions", async () => {
  const [shell, editor, publicApi, dashboard, report, reportStyles, manifest] = await Promise.all([
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChartEditor.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/data-app-public.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/report/ReportContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/report/report.css", import.meta.url), "utf8"),
    readFile(new URL("../protected-runtime.json", import.meta.url), "utf8"),
  ]);
  const protectedRuntime = JSON.parse(manifest);
  assert.match(shell, /<DataAppContext\.Provider value=\{shellContext\}/u);
  assert.match(shell, /<DataAppTopbar/u);
  assert.match(shell, /<DataAppThemeDrawer/u);
  assert.match(shell, /<SourceSidebar/u);
  assert.match(
    publicApi,
    /export\s*\{[^}]*\bChartEditor\b[^}]*\}\s*from\s*["']\.\/components\/ChartEditor\.jsx["']/u,
    "Reports, dashboards, and inline charts must share the supported canonical editor",
  );
  assert.match(shell, /import\s*\{\s*ChartEditor\s*\}\s*from\s*["']\.\/components\/ChartEditor\.jsx["']/u);
  const editorProps = shell.match(/<ChartEditor\b([\s\S]*?)\/>/u)?.[1];
  assert.ok(editorProps, "The durable shell must mount the canonical chart editor");
  assert.match(editorProps, /DialogComponent=\{Dialog\}/u);
  assert.match(editorProps, /SelectComponent=\{Dropdown\}/u);
  assert.match(shell, /import\s*\{[^}]*\bDialog\b[^}]*\}\s*from\s*["']\.\/components\/ui\.jsx["']/u);
  assert.match(shell, /import\s*\{[^}]*\bDropdown\b[^}]*\}\s*from\s*["']\.\/components\/Controls\.jsx["']/u);
  assert.match(editor, /<ChartExplorer\b/u);
  assert.doesNotMatch(shell, /\b(?:createChartEditorState|changeChartEditorState|stepChartEditorHistory)\b/u);
  assert.match(dashboard, /useDataApp\(\)/u);
  assert.match(report, /useDataApp\(\)/u);
  assert.doesNotMatch(dashboard, /\.\.\.actions/u);
  assert.doesNotMatch(report, /\.\.\.actions|RichMarkdown|>Save<|>Cancel</u);
  assert.match(report, /<ReportSection id="report-summary"/u);
  assert.match(report, /<MetricCard id="report-metric-active"/u);
  assert.match(
    report,
    /<RichNarrative id="report-summary:body"/u,
    "Independently editable report blocks require stable semantic identities",
  );
  assert.match(report, /<h1 data-data-app-title/u, "Report headings must persist only as the shared artifact title");
  assert.doesNotMatch(
    dashboard,
    /<h1 data-data-app-title/u,
    "Dashboard content must not duplicate the title already shown and persisted by the top bar",
  );
  assert.match(
    reportStyles,
    /\.report-page\s*\{[^}]*--data-app-content-width:\s*var\(--data-app-report-evidence-width\)[^}]*--data-app-report-prose-width:\s*var\(--data-app-content-width\)[^}]*max-width:\s*calc\(var\(--data-app-content-width\)\s*\+\s*2\s*\*\s*var\(--data-app-layout-gutter\)\)/su,
  );
  assert.match(reportStyles, /\.report-page \.dashboard-component:not\(\[data-component-kind="metric"\]\):not\(\[data-component-variant="card"\]\)\s*\{[^}]*border:\s*0/su,
    "The starter's editorial treatment preserves shared metric-card styling");
  for (const path of [
    "AGENTS.md",
    "src/App.jsx",
    "src/DataAppRuntime.jsx",
    "src/DataAppShell.jsx",
    "src/DataAppContext.jsx",
    "src/data-app-public.jsx",
    "src/components/ChartEditor.jsx",
    "src/components/ChartExplorer.jsx",
    "src/components/contained-ui.jsx",
    "src/charting/chart-editor-state.js",
    "src/components/DataComponent.jsx",
    "src/data-app-actions.js",
    "src/data-app-worker.js",
    "src/worker.js",
    "src/chrome-contrast.js",
    "src/chrome-layout.js",
  ]) {
    assert.ok(protectedRuntime.files[path], `${path} must be protected`);
  }
  for (const path of ["src/content/", "src/theme.css", "src/data.json"]) {
    assert.ok(protectedRuntime.editablePaths.includes(path), `${path} must remain model-authored`);
    assert.equal(protectedRuntime.files[path], undefined);
  }
});

test("authored report and dashboard code uses the protected public component API", async () => {
  const [publicApi, editableText] = await Promise.all([
    readFile(new URL("../src/data-app-public.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/EditableText.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(publicApi, /DataTable as Table/u);
  assert.match(publicApi, /useDataAppShell as useDataApp/u);
  assert.match(publicApi, /EditableText/u);
  assert.match(editableText, /data-editable-narrative/u);
});

test("rich Markdown editor caps pill-shaped control radii", async () => {
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const editorRule = styles.match(/\.markdown-editable\s*\{(?<body>[^}]*)\}/u)?.groups.body;
  assert.ok(editorRule, "The rich Markdown editor must keep its protected styling");
  assert.match(
    editorRule,
    /border-radius:\s*min\(var\(--control-radius\),\s*var\(--radius-md\)\)/u,
    "Multiline text editors must not inherit pill-shaped control radii",
  );
});

test("section filters intersect page scope before aggregate collapse without sharing local IDs or mutating rows", () => {
  const rows = [
    { segment: "all", value: 12 },
    { segment: "A", value: 7 },
    { segment: "B", value: 5 },
  ].map(Object.freeze);
  Object.freeze(rows);
  const page = [{ id: "segment", field: "segment", defaultValue: "all" }];
  const local = [{ id: "segment", field: "segment", queryIds: ["scoped"], defaultValue: "all" }];
  const resolve = (pageValue, localValue, query = "scoped", breakdown = []) => resolveSectionRows(
    rows, page, { segment: pageValue }, local, { segment: localValue }, query, breakdown,
  );
  assert.deepEqual(resolve("all", "A"), [rows[1]], "Local scope must not filter already-collapsed page aggregate rows");
  assert.deepEqual(resolve("A", "all"), [rows[1]], "All in a section must not broaden the page scope");
  assert.deepEqual(resolve("A", "B"), [], "Conflicting scopes must be empty, not silently overridden");
  assert.deepEqual(resolve("all", "A", "unrelated"), [rows[0]]);
  assert.deepEqual(resolve("all", "all"), [rows[0]]);
  assert.deepEqual(resolve("all", "all", "scoped", ["segment"]), rows.slice(1));
  assert.deepEqual(resolveSectionRows(rows, page, {}, local, {}, "scoped"), [rows[0]]);
  assert.equal(rows.length, 3);
});

test("section date ranges select only available scoped endpoints and preserve all-date history", () => {
  const rows = [
    { week: "2026-07-06", segment: "A", value: 10 },
    { week: "2026-07-13", segment: "A", value: 15 },
    { week: "2026-07-20", segment: "B", value: 20 },
  ];
  const page = [{ id: "segment", field: "segment", defaultValue: "A" }];
  const local = [{ id: "period", field: "week", mode: "through", defaultValue: "all" }];
  const resolve = (value, breakdown = []) => resolveSectionRows(rows, page, {}, local,
    { period: value }, "summary", breakdown);
  assert.deepEqual(resolve("2026-07-06..2026-07-20"), [rows[1]]);
  assert.deepEqual(resolve("2026-07-06..2026-07-20", ["week"]), rows.slice(0, 2));
  assert.deepEqual(resolve("all"), rows.slice(0, 2));
  assert.deepEqual(resolve("2026-08-01..2026-08-20"), []);
});


test("the starter keeps its shared runtime and hosted data contract", async () => {
  const [indexHtml, main, app, runtime, dataComponent, worker, workerFactory, hosting, packageJson] = await Promise.all(
    [
      readFile(new URL("index.html", templateRoot), "utf8"),
      readFile(new URL("src/main.jsx", templateRoot), "utf8"),
      readFile(new URL("src/App.jsx", templateRoot), "utf8"),
      readFile(new URL("src/DataAppRuntime.jsx", templateRoot), "utf8"),
      readFile(new URL("src/components/DataComponent.jsx", templateRoot), "utf8"),
      readFile(new URL("src/worker.js", templateRoot), "utf8"),
      readFile(new URL("src/data-app-worker.js", templateRoot), "utf8"),
      readFile(new URL(".openai/hosting.json", templateRoot), "utf8"),
      readFile(new URL("package.json", templateRoot), "utf8"),
    ],
  );
  const packageMetadata = JSON.parse(packageJson);

  assert.match(indexHtml, /src="\/src\/main\.jsx"/u);
  assert.match(main, /export function DataAppRuntime/u);
  assert.match(main, /createRoot\(root\)\.render\(/u);
  assert.match(main, /createRoot\(root\)\.render\([\s\S]*?<DataAppRuntime\s*\/>/u);
  assert.match(main, /from ["']\.\/App\.jsx["']/u);
  assert.doesNotMatch(app, /createRoot\(/u);
  assert.match(main, /return <App hosted=\{hosted\} \/>/u);
  assert.match(app, /from ["']\.\/DataAppRuntime\.jsx["']/u);
  assert.match(app, /<DataAppRuntime[\s\S]*?reviewedSnapshot=\{reviewedSnapshot\}/u);
  assert.match(app, /DashboardContent=\{DashboardContent\}/u);
  assert.match(app, /ReportContent=\{ReportContent\}/u);
  assert.match(runtime, /export function DataAppRuntime\(/u);
  assert.match(runtime, /snapshot\.surface === "report" \? content\.ReportContent : content\.DashboardContent/u);
  assert.match(runtime, /<DataAppShell\s+snapshot=\{snapshot\}/u);
  assert.doesNotMatch(runtime, /from ["']\.\/(?:data\.json|content\/)/u);
  assert.match(dataComponent, /requires a non-empty stable id/u);
  assert.match(dataComponent, /data-component-id=\{componentId\}/u);
  assert.match(hosting, /"d1"\s*:\s*"DB"/u);
  assert.match(worker, /from ["']\.\/data-app-worker\.js["']/u);
  assert.match(worker, /export default createDataAppWorker\(\{/u);
  assert.match(worker, /html: dataAppHtml/u);
  assert.match(workerFactory, /export function createDataAppWorker\(/u);
  assert.match(workerFactory, /pathname === "\/api\/snapshot"/u);
  assert.match(workerFactory, /storedSnapshot\(database, seedSnapshot, await legacySeedFingerprint\)/u);
  assert.match(workerFactory, /snapshotResponse\(environment\.DB, \(\) => reviewedSeed\(environment\), seedFingerprint\)/u);
  assert.doesNotMatch(workerFactory, /from ["'][^"']*(?:data\.json|index\.html\?raw|data-app-owner\.js)["']/u);
  assert.equal(packageMetadata.scripts.build, "node scripts/verify-protected-runtime.mjs && vite build");
  assert.match(dataComponent, /useOptionalDataAppShell/u);
  assert.match(dataComponent, /requires a stable reviewed query id/u);
  assert.doesNotMatch(dataComponent, /requiredReportSummary|componentId === "report-executive-summary"/u,
    "Report headings and visibility belong to authored content");
});
