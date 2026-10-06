import assert from "node:assert/strict";
import { readFile as readRawFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalDashboardPath,
  chartPermalink,
  componentPermalink,
  componentPermalinkId,
  componentPermalinkShortId,
  readChartPermalink,
  readComponentPermalink,
} from "../src/chart-permalink.js";
import {
  boxPlots,
  heatmap,
  normalizeZoomRange,
  orderTooltipEntries,
  pivot,
  sankeyGraph,
  stackedMarkBounds,
  waterfall,
  waterfallValueDomain,
} from "../src/charting/chart-transforms.js";
import {
  categoryLabel,
  deltaDirection,
  displayValue,
  label,
  periodComparison,
  ratioMetric,
  semanticCategoryDimension,
  semanticColor,
  semanticColorResolver,
} from "../src/charting/chart-theme.js";
import { dataAppActionRequest } from "../src/data-app-actions.js";
import { currentDataAppReference } from "../src/runtime-environment.js";
import {
  formatReviewedSql,
  isTemporalField,
  referencedDefinitionVariable,
  reviewedDateRange,
  reviewedDefinitionLineage,
  reviewedSource,
  safeSourceHref,
  scopedMetricDefinitions,
  sourceTrustLabels,
} from "../src/source-provenance.js";
import { dataAppThemePalette, dataAppThemes } from "../src/theme-presets.js";
import { filterReviewedRows, listReviewedQueries, previousPeriodRows } from "../src/use-data-app.js";

const templateRoot = new URL("../", import.meta.url);
const stylesUrl = new URL("../src/styles.css", import.meta.url);
async function readFile(url, encoding) {
  const content = await readRawFile(url, encoding);
  if (url.href !== stylesUrl.href || encoding !== "utf8") return content;
  const foundation = await readRawFile(new URL("../src/styles-foundation.css", import.meta.url), "utf8");
  return content.replace(/^@import "\.\/styles-foundation\.css";\n/u, `${foundation}\n`);
}
const templates = new URL("../../", import.meta.url);
const themes = ["codex-classic", "default", "dark-pixel", "scientific-blue", "sticker-pop"];

test("query discovery retains saved non-SQL requests and calculations without copying rows", () => {
  const source = {
    label: "Synthetic Finance request fixture",
    evidenceFlow: [{ title: "Price history", detail: JSON.stringify({
      tool: "get_price_history", arguments: {
        company: { ticker: "AAPL", mic: "XNAS" }, interval: "1day",
        start_date: "2026-08-01", end_date: "2026-08-31", limit: 100,
      },
      period: "Fixed inclusive August 2026; do not advance on refresh.",
    }) }],
    metricDefinitions: [{ label: "Return", formula: "close / firstClose - 1" }],
  };
  const methods = [{ language: "python", code: "rows.sort(key=lambda row: row['date'])\nfirst_close = rows[0]['close']\nfor row in rows:\n    row['return'] = row['close'] / first_close - 1" }];
  const queries = { prices: {
    source, methods, rows: [{ date: "2026-08-03", close: 100, return: 0 }],
  } };
  const [listed] = listReviewedQueries(queries);
  assert.equal(listed.queryId, "prices");
  assert.deepEqual(listed.source, source);
  assert.deepEqual(listed.methods, methods);
  assert.deepEqual(listed.columns, ["date", "close", "return"]);
  assert.equal(listed.rowCount, 1);
  assert.equal(Object.hasOwn(listed, "rows"), false);

  const [sql] = listReviewedQueries({ sql: { rows: [], source: {
    label: "SQL fixture", sql: "SELECT count(*) AS count FROM fixture", tables: ["fixture"],
  } } });
  assert.equal(sql.sql, "SELECT count(*) AS count FROM fixture");
  assert.deepEqual(sql.tables, ["fixture"]);
});
const tokens = [
  "--background",
  "--surface",
  "--text",
  "--secondary",
  "--border",
  "--accent",
  "--positive",
  "--negative",
  ...Array.from({ length: 8 }, (_, index) => `--chart-${index + 1}`),
];

test("reviewed values use concise readable numbers and dates without changing the source", () => {
  assert.match(displayValue(8_683_408), /^8[.,]7M$/u);
  assert.match(displayValue(122_729_427_606_863), /^122[.,]7T$/u);
  assert.match(displayValue(344_129_822.78), /^344[.,]1M$/u);
  assert.match(displayValue(1_903), /^1[,.]903$/u);
  assert.match(displayValue(0.6958342853405023), /^0[.,]70$/u);
  assert.match(displayValue("2026-07-31"), /Jul(?:y)?\s+31,?\s+2026/u);
  assert.equal(displayValue(null), "—");
});

test("metric comparisons are consistent, directional previous-period deltas", () => {
  assert.deepEqual(periodComparison(120, 100), {
    comparison: "+20% vs. previous reporting period",
    negative: false,
  });
  assert.deepEqual(periodComparison(0.675, 0.65, { percentagePoints: true }), {
    comparison: "+2.5 pp vs. previous reporting period",
    negative: false,
  });
  assert.deepEqual(periodComparison(120, 100, { lowerIsBetter: true }), {
    comparison: "+20% vs. previous reporting period",
    negative: true,
  });
  assert.deepEqual(periodComparison(120, 100, { previousPeriod: "2026-08-08" }), {
    comparison: "+20% vs. Aug 8",
    negative: false,
  });
  assert.deepEqual(periodComparison(120, undefined), {});
  assert.deepEqual(periodComparison(120, 100, { includePeriod: false }), { comparison: "+20%", negative: false });
  assert.deepEqual(periodComparison(.2, .25, { percentagePoints: true, includePeriod: false }), { comparison: "-5 pp", negative: true });
});

test("sample account rows reconcile with the reviewed segment totals", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../src/data.json", import.meta.url), "utf8"));
  const latestWeek = snapshot.queries.account_health.rows.at(-1).week;
  const accountRows = snapshot.queries.account_health.rows.filter(({ week }) => week === latestWeek);
  assert.ok(accountRows.some(({ activeUsers, previousUsers }) => activeUsers > previousUsers));
  assert.ok(accountRows.some(({ activeUsers, previousUsers }) => activeUsers < previousUsers));
  for (const { segment, activeUsers } of snapshot.queries.segment_usage.rows.filter(
    ({ week }) => week === latestWeek,
  )) {
    assert.equal(
      accountRows
        .filter((account) => account.segment === segment)
        .reduce((total, account) => total + account.activeUsers, 0),
      activeUsers,
      `Example account values must continue to reconcile with the reviewed ${segment} total`,
    );
  }
});

test("source inspection presents reporting context, reviewed metadata, and line-numbered SQL", async () => {
  const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");

  assert.match(inspector, /const freshness = Number\.isFinite\(Date\.parse\(source\.executedAt\)\) \? source\.executedAt : null;/u);
  assert.doesNotMatch(inspector, /generatedAt/u);
  assert.match(inspector, /<dt>Reporting period<\/dt>/u);
  assert.match(inspector, /<dd>\{formatSnapshot\(freshness\)\}<\/dd>/u);
  assert.doesNotMatch(
    inspector,
    /Query \/ dataset|Data freshness|>Source filters<|>Active filters</u,
    "The overview should follow the concise Figma sidebar hierarchy without extra metadata or filter chips",
  );
  assert.match(inspector, /!Array\.isArray\(queryIds\) \|\| queryIds\.includes\(component\.queryId\)/u);
  assert.match(inspector, /query\?\.rows\?\.some\(\(row\) => Object\.hasOwn\(row, field\)\)/u);
  assert.match(inspector, /href=\{tableLinks\[table\]\}/u);
  assert.match(
    inspector,
    /<Icon name="cross" size=\{20\} \/>/u,
    "The source sidebar should use the same actual OpenAI close glyph as the design",
  );
  assert.match(inspector, /className="sql-line-number"/u);
  assert.match(inspector, /safeSourceHref\(typeof entry === "string" \? entry : entry\.href\)/u);
});

test("source inspection scopes reviewed metric details and renders untrusted methodology as React text", async () => {
  const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");

  assert.match(
    inspector,
    /scopedMetricDefinitions\(definitions,\s*component\.id,\s*\{\s*displayedFields,\s*chartEdited:\s*chartEdited === true \|\| Boolean\(chartOverride\),?\s*\}\)/u,
    "Edited source inspection must reconcile reviewed displayed fields without losing its exact component identity",
  );
  assert.match(
    inspector,
    /chartEdited\s*=\s*false/u,
    "Inline edit scoping must be opt-in so existing durable source inspection retains its default behavior",
  );
  assert.match(
    inspector,
    /useOptionalDataAppShell\(\)\?\.chartOverrides\?\.\[component\.id\]/u,
    "The selected component must use its current protected chart override rather than stale authored series",
  );
  assert.match(
    inspector,
    /scopedProvidedEvidence\(providedEvidence, visibleDefinitions, activeFilters\)/u,
    "Evidence flow must not expose definitions excluded from the current component",
  );
  assert.match(
    inspector,
    /referencedDefinitionVariable\(record, visibleDefinitions\)/u,
    "Variable labels must appear only when another visible reviewed formula references them",
  );
  assert.match(
    inspector,
    /reviewedDefinitionLineage\(record,\s*\{\s*tables,\s*files\s*\}\)/u,
    "Rendered lineage must be limited to reviewed query tables and files",
  );
  assert.match(
    inspector,
    /\{chartLabel \?\? label\}/u,
    "Reviewed definition labels must be rendered through escaped JSX interpolation",
  );
  assert.match(
    inspector,
    /<td>\s*\{definition\}/u,
    "Reviewed methodology must be rendered as text rather than interpreted as markup",
  );
  assert.match(inspector, /\{formula\}/u, "Recorded formulas must remain literal text and must never be evaluated");
  assert.match(inspector, /\{lineage\.join\(" · "\)\}/u, "Reviewed lineage labels must remain escaped text");
  assert.doesNotMatch(
    inspector,
    /dangerouslySetInnerHTML|\binnerHTML\s*=/u,
    "Untrusted reviewed labels, methodology, formulas, and lineage must never become raw HTML",
  );
});

test("provided evidence flows retain reviewed steps without leaking another component's definitions", async () => {
  const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");

  assert.match(
    inspector,
    /function scopedProvidedEvidence\(evidenceFlow, definitions, activeFilters\)/u,
    "Explicit reviewed evidence needs component-aware definition normalization",
  );
  assert.match(
    inspector,
    /scopedProvidedEvidence\(providedEvidence, visibleDefinitions, activeFilters\)/u,
    "An explicit shared-query evidence flow must receive only the selected component's definitions",
  );
  assert.match(
    inspector,
    /Provided metric definitions/u,
    "Supplied evidence without a metric-definition step must gain the selected reviewed definitions",
  );
  assert.match(
    inspector,
    /data-evidence-origin="provided"/u,
    "Sanitizing supplied evidence must preserve its truthful reviewed origin",
  );
  assert.doesNotMatch(
    inspector,
    /explicitEvidence\s*\?\s*evidenceFlow\s*:/u,
    "Query-wide explicit evidence must never bypass component definition scoping",
  );
});

test("the Data app lockfile supports reproducible clean installs", async () => {
  const lockfile = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const [path, version] of [
    ["node_modules/@emnapi/core", "1.11.3"],
    ["node_modules/@emnapi/runtime", "1.11.3"],
    ["node_modules/@emnapi/core/node_modules/@emnapi/wasi-threads", "1.2.3"],
  ]) {
    assert.equal(lockfile.packages[path]?.version, version, `${path} is missing from the Data app lockfile`);
    assert.equal(
      lockfile.packages[path]?.resolved,
      undefined,
      `${path} must inherit npm's configured registry without a hard-coded package URL`,
    );
  }
  assert.doesNotMatch(
    JSON.stringify(lockfile),
    /socket-firewall-registry\.gateway\.[a-z0-9-]+\.internal\.api\.openai\.org/,
    "Data app lockfiles must never contain cluster-specific Socket Firewall registry URLs",
  );
});

test("inline editing permits authored copy while protecting reviewed data and interactive state", async () => {
  const editing = await readFile(new URL("../src/use-inline-editing.js", import.meta.url), "utf8");
  for (const tag of ["p", "li", "figcaption", "blockquote"]) {
    assert.match(editing, new RegExp(`"${tag}"`), `${tag} authored content must remain editable`);
  }
  for (const protectedValue of [
    "metric-value",
    "forecast-value",
    "scenario-value",
    "scenario-caption",
    "comparison",
    "source-value",
    "table-pagination",
    "scenario-lever",
    "forecast-details",
    "data-reviewed-value",
    "data-source-value",
    "data-modeled-value",
    "data-reviewed-rows",
    "data-source-rows",
    "data-component-kind='custom'",
    "chart-axis-label",
  ]) {
    assert.match(editing, new RegExp(protectedValue), `${protectedValue} must remain read-only`);
  }
  for (const protectedInterface of ["source-sidebar", "theme-drawer", "recharts-wrapper", "aria-live"]) {
    assert.match(editing, new RegExp(protectedInterface), `${protectedInterface} must remain operational`);
  }
  assert.match(editing, /\.report-facts dt/u, "Authored report metric labels should remain editable");
  assert.match(editing, /\.analysis-caption/u, "Authored chart descriptions should remain editable");
  assert.match(editing, /\.report-disclosure/u, "Authored source wording should remain editable");
  assert.match(
    editing,
    /export function editableTextTarget/u,
    "View-mode entry and edit-mode discovery must share the same eligibility policy",
  );
  assert.match(
    editing,
    /new WeakMap\(\)/u,
    "Fallback text identifiers should be assigned in one cached discovery pass",
  );
  assert.doesNotMatch(
    editing,
    /editableElements\(scope\)/u,
    "Assigning each narrative ID must not rescan its component or section",
  );
  assert.match(
    editing,
    /\[data-data-app-title\]/u,
    "Artifact titles need one dedicated persistence owner rather than duplicate narrative edits",
  );
  assert.match(
    editing,
    /candidateSet\.has\(parent\)/,
    "Nested editable targets must collapse to one meaningful text block",
  );
  assert.match(
    editing,
    /element\.replaceChildren\(\.\.\.restored\.childNodes\)/u,
    "Restored formatting must reuse the existing authored DOM rather than injecting saved HTML",
  );
});

test("the starter keeps restore controls contextual and source evidence inspectable", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /Use each component.s menu to edit or hide it/u);
  assert.doesNotMatch(app, /className="hero-copy"|className="clear-filters restore-hidden"/u);
  assert.match(app, /hiddenCount=\{hidden\.size\}\s+onRestoreHidden=/u);
  assert.match(chrome, /onClick=\{onRestoreHidden\}>Restore hidden \(\{hiddenCount\}\)/u);
  assert.match(inspector, /<h2>\{component\.title\}<\/h2>/u);
  assert.match(inspector, /className="source-label">Definitions</u);
  assert.match(inspector, /className="source-label">Sources</u);
  assert.doesNotMatch(inspector, /className="source-label">Tables</u);
});

test("closed theme drawers remove every control from the keyboard focus order", async () => {
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  assert.match(
    chrome,
    /aria-hidden=\{!open\}\s+inert=\{!open\}/,
    "Closed theme drawers must be inert rather than only accessibility-hidden",
  );
  assert.match(
    chrome,
    /aria-label="Close theme picker"\s+tabIndex=\{open \? 0 : -1\}/,
    "The drawer close button must not remain focusable while its parent drawer is closed",
  );
});

test("modal selects preserve stable dashboard geometry and block outside click-through", async () => {
  const ui = await readFile(new URL("../src/components/ui.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(
    ui,
    /export function Select\([\s\S]*?modal = true,/,
    "Shared selects must remain modal so outside pointer actions cannot reach underlying controls",
  );
  assert.match(
    ui,
    /<Dropdown\.Root modal=\{modal\} open=\{open\} onOpenChange=\{setOpen\}>/,
    "Selects must pass their modal interaction behavior through to the dropdown primitive",
  );
  assert.match(
    css,
    /body\[data-scroll-locked\]:has\(\.select-content\[data-state="open"\]\):not\(:has\(\[data-shared-dialog\]\)\)\s*\{[^}]*overflow-y:\s*visible\s*!important/s,
    "Modal select scroll locking must not detach the sticky dashboard header from the viewport",
  );
  assert.match(
    css,
    /body\[data-scroll-locked\]:has\(\.select-content\[data-state="open"\]\):not\(:has\(\[data-shared-dialog\]\)\)\s*\{[^}]*margin-right:\s*0\s*!important/s,
    "Modal selects must not add redundant scrollbar-gap margin while dashboard scrolling stays visible",
  );
  assert.match(
    css,
    /body\[data-scroll-locked\]:has\(\.select-content\[data-state="open"\]\):not\(:has\(\[data-shared-dialog\]\)\)\s*\{[^}]*padding-right:\s*0\s*!important/s,
    "Modal selects must not shift fixed dashboard chrome by adding redundant scrollbar-gap padding",
  );
  assert.match(
    css,
    /\.select-content\s*\{[^}]*box-sizing:\s*border-box;[^}]*width:\s*max\(188px,\s*var\(--radix-dropdown-menu-trigger-width\)\)/s,
    "Dropdown menus must match wide originating controls while retaining a readable minimum width",
  );
});

test("regional map shares neutral fills and fades geography without fading markers", async () => {
  const css = await readFile(new URL("../src/content/dashboard/dashboard.css", import.meta.url), "utf8");
  assert.match(css, /\.regional-map-land\s*\{\s*fill:\s*var\(--chart-neutral-fill\)/u);
  assert.match(css, /\.regional-map-plot\s*\{[^}]*width:\s*min\(100%, 560px\);[^}]*aspect-ratio:\s*28\s*\/\s*11/su);
  assert.match(css, /\.regional-map-surface\s*\{[^}]*mask-image:[^}]*mask-composite:\s*intersect/su);
  assert.doesNotMatch(css, /\.regional-marker\s*\{[^}]*mask-image:/su);
});

test("themes implement the shared token contract", async () => {
  for (const theme of themes) {
    const css = await readFile(new URL(`themes/${theme}/theme.css`, templates), "utf8");
    tokens.forEach((token) => assert.match(css, new RegExp(`${token}:`), `${theme} is missing ${token}`));
    assert.match(css, /--movement-positive:/);
    assert.match(css, /--movement-negative:/);
    assert.match(css, /--movement-total:/);
    assert.match(css, /--chart-neutral-fill:/);
    if (theme === "default") {
      assert.match(css, /--ranked-list-fill:\s*color-mix\(in srgb, var\(--text\) 18%, var\(--surface\)\)/,
        "The editorial Neutral theme should use warm legible leaderboard fills instead of an unrelated blue tint");
      assert.match(css, /--ranked-list-fill-hover:\s*color-mix\(in srgb, var\(--text\) 24%, var\(--surface\)\)/);
    } else {
      assert.match(css, /--ranked-list-fill:\s*color-mix\(in srgb, var\(--chart-1\) 16%, var\(--surface\)\)/);
      assert.match(css, /--ranked-list-fill-hover:\s*color-mix\(in srgb, var\(--chart-1\) 24%, var\(--surface\)\)/);
    }
  }
  const classic = await readFile(new URL("themes/codex-classic/theme.css", templates), "utf8");
  assert.match(classic, /--font-sans:\s*var\(--vscode-font-family, var\(--font-sans-default\)\)/);
  assert.match(classic, /--font-sans-default:[^;]*\bsystem-ui,[^;]*\bsans-serif,/);
  assert.doesNotMatch(
    classic,
    /["'](?:system-ui|sans-serif)["']/,
    "Generic font fallbacks must not be quoted as literal family names",
  );
  assert.doesNotMatch(classic, /OpenAI Sans/);
  const classicPreset = dataAppThemes.find(({ id }) => id === "codex-classic");
  assert.equal(classicPreset.tokens.at(-1), classicPreset.darkTokens.at(-1));
  assert.match(
    classicPreset.tokens.at(-1),
    /\bsystem-ui,[^;]*\bsans-serif,/,
    "The selectable Classic preset must use the same system-font family as its theme file",
  );
  assert.equal(await readFile(new URL("../src/theme.css", import.meta.url), "utf8"), classic);
});

test("shared Data app styles keep readable typography and overlay component actions", async () => {
  for (const stylesheet of ["foundation.css", "styles.css", "components/source-inspector.css", "theme-picker.css", "content/dashboard/dashboard.css"]) {
    const css = await readFile(new URL(`../src/${stylesheet}`, import.meta.url), "utf8");
    assert.doesNotMatch(css, /font-size:\s*(?:9|10|11)px\b/, `${stylesheet} contains sub-12px text`);
  }
  const css = (await Promise.all(["foundation.css", "styles.css", "components/source-inspector.css", "theme-picker.css"].map((file) =>
    readFile(new URL(`../src/${file}`, import.meta.url), "utf8")))).join("\n");
  const layout = await readFile(new URL("../src/content/dashboard/dashboard.css", import.meta.url), "utf8");
  assert.match(css, /--data-app-dashboard-content-width:\s*1440px/u);
  assert.match(css, /--data-app-dashboard-wide-content-width:\s*var\(--data-app-dashboard-content-width\)/u);
  assert.match(css, /--data-app-report-evidence-width:\s*748px/u);
  assert.match(css, /--data-app-report-prose-width:\s*748px/u);
  assert.match(
    css,
    /main\[data-data-app-content="report"\]\s*\{[^}]*var\(--data-app-content-width,\s*var\(--data-app-report-evidence-width\)\)[^}]*var\(--data-app-layout-gutter,\s*var\(--data-app-report-gutter\)\)/s,
    "Protected report layout must add gutters outside its actual usable evidence width",
  );
  assert.doesNotMatch(
    css,
    /main\[data-data-app-content="report"\]\s+\[data-component-id\]\s*\{[^}]*border-width:\s*0\s*!important[^}]*border-style:\s*none\s*!important/s,
    "Report containers are authored defaults, not a protected blanket override",
  );
  assert.match(css, /--spacing:\s*0?\.25rem/);
  assert.match(css, /--radius-md:\s*8px/);
  assert.match(css, /--radius-2xl:\s*16px/);
  assert.match(css, /--shadow-xl:\s*0 8px 16px -4px rgb\(0 0 0 \/ 12%\)/);
  assert.match(css, /--text-sm-size:\s*14px/);
  assert.match(css, /--text-sm-line:\s*20px/);
  assert.match(css, /--text-md-line:\s*24px/);
  assert.match(css, /--text-lg-line:\s*28px/);
  assert.match(css, /--text-xl-size:\s*20px/);
  assert.match(css, /--text-xl-line:\s*28px/);
  assert.doesNotMatch(
    css,
    /--text-(?:2xl|3xl|4xl|5xl)-size:/,
    "The shared ChatGPT-matched scale must stop at the 20px section title",
  );
  assert.match(css, /--text-large-title-tracking:\s*normal/);
  assert.match(
    css,
    /\.menu-trigger\s*\{[^}]*position:\s*relative[^}]*grid-column:\s*2[^}]*grid-row:\s*1[^}]*justify-self:\s*end/s,
    "Component actions must reserve a right-aligned column in the header row",
  );
  assert.match(css, /--shadow-hairline:/);
  assert.match(
    css,
    /\.info-tooltip\s*\{[^}]*border:\s*0[^}]*box-shadow:\s*var\(--shadow-hairline\),\s*var\(--shadow\)/s,
    "Floating tooltips must use the shared hairline shadow instead of a full border",
  );
  assert.match(
    css,
    /\.menu-item\[data-highlighted\][\s\S]*?\{\s*background:\s*var\(--interaction-hover\)/,
    "Menu hover must use the shared subtle interaction surface",
  );
  assert.match(
    css,
    /:root\[data-color-scheme="dark"\]\s+:is\(\.menu-item:hover,[^}]*background:\s*var\(--interaction-active\)/s,
    "Dark menus must retain a visible hover state when their raised surface matches the muted token",
  );
  assert.match(
    css,
    /\.menu-item\[data-state="open"\][\s\S]*?\{\s*background:\s*var\(--interaction-active\)/,
    "Open menu items must use the shared active interaction surface",
  );
  assert.match(
    css,
    /\.menu-item:focus-visible\s*\{[^}]*outline:\s*none/s,
    "Menu items must use their highlighted background instead of an additional blue focus outline",
  );
  assert.match(
    css,
    /\.metric-item \.component-title\s*\{[^}]*overflow:\s*visible/s,
    "Metric title tooltips must escape the title",
  );
  assert.match(
    css,
    /\.component-header\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/s,
    "Headers must always reserve an action column, including compact metric cards",
  );
  assert.match(
    css,
    /\.info-tooltip\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s,
    "Information tooltips must wrap independently of single-line component titles",
  );
  assert.match(
    css,
    /\.info-tooltip\s*\{[^}]*--info-tooltip-max-width/s,
    "Information tooltips must accept a component-aware width constraint",
  );
  assert.match(
    css,
    /\.info-tooltip\[data-tooltip-portal="true"\]\s*\{[^}]*position:\s*fixed[^}]*z-index:\s*var\(--layer-tooltip-portal\)/s,
    "Information tooltips must escape overflow-clipped cards through the shared document-level overlay",
  );
  assert.match(
    css,
    /\.recharts-wrapper\s*\{[^}]*user-select:\s*none/s,
    "Dragging across chart labels must not select plot text",
  );
  assert.match(
    css,
    /\.recharts-surface:focus,\s*\.recharts-surface \[tabindex\]:focus\s*\{[^}]*outline:\s*none/s,
    "Chart surfaces and internal SVG layers must not display browser-default blue focus rectangles",
  );
  assert.match(css, /\.chart-footer\s*>\s*:is\(\.chart-axis-label,\s*\.chart-scale-legend\)\s*\{[^}]*--chart-plot-left/s);
  assert.match(
    css,
    /\.chart-explorer\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(260px,\s*320px\)/s,
    "Chart editing controls should occupy a right-hand sidebar beside the chart preview",
  );
  assert.match(
    css,
    /\.chart-editor-dialog\s*\{[^}]*height:\s*100dvh[^}]*border-radius:\s*0/su,
    "Chart editing should use the full viewport instead of a cramped modal",
  );
  assert.match(
    css,
    /\.chart-editor-dialog \.dialog-header\s*\{[^}]*min-height:\s*52px/su,
    "The fullscreen chart editor must match the regular dashboard top-bar height",
  );
  assert.match(
    css,
    /\.explorer-controls\s*\{[^}]*padding:\s*20px[^}]*background:\s*var\(--background\)/su,
    "Chart controls should use a compact inset and the same surface as the rest of the editor",
  );
  assert.match(
    css,
    /\.explorer-controls :is\(input, \.filter-trigger\)\s*\{[^}]*height:\s*36px/su,
    "Editor dropdowns and text fields must share the same 36px control height",
  );
  assert.match(
    css,
    /\.explorer-section \+ \.explorer-section\s*\{[^}]*margin-inline:\s*-20px/su,
    "Editor section dividers should extend across the full sidebar width",
  );
  assert.match(
    css,
    /\.chart-legend\s*\{[^}]*flex-wrap:\s*wrap/s,
    "Default chart legends should wrap naturally beneath their charts",
  );
  assert.match(css, /\.menu-check\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(css, /\.theme-drawer\.is-open\s*\{/);
  assert.match(
    css,
    /\.theme-card-list\s*\{[^}]*width:\s*100%[^}]*overflow-x:\s*auto/s,
    "Theme previews must scroll across the full viewport instead of being clipped to the content column",
  );
  assert.match(
    css,
    /\.chart-tooltip\s*\{[^}]*border-radius:\s*min\(/s,
    "Chart tooltips must cap their radius independently of pill-shaped filter controls",
  );
  assert.match(css, /\.source-trace-step\s*\{/);
  assert.match(
    css,
    /\[data-inline-editable="true"\]\s*\{[^}]*max-width:\s*100%[^}]*align-self:\s*start[^}]*justify-self:\s*start/s,
    "Inline text editors should fit their content instead of stretching across grid cells",
  );
  assert.match(
    css,
    /\[data-data-app-title\]\[contenteditable="true"\]\s*\{[^}]*width:\s*fit-content[^}]*max-width:\s*100%/s,
    "Editable artifact headings should hug their text rather than stretching their focus outline across the page",
  );
  assert.match(
    css,
    /\.dashboard-topbar-title\[contenteditable="true"\]\s*\)\s*\{\s*border-radius:\s*6px/s,
    "Editable text should retain soft corners even when a custom theme makes its components square",
  );
  for (const state of ["hover:not(:focus)", "focus"]) {
    const escapedState = state.replace(/[()]/gu, "\\$&");
    assert.match(
      css,
      new RegExp(
        `:is\\([\\s\\S]*?\\[data-inline-editable="true"\\][\\s\\S]*?\\[data-data-app-title\\]\\[contenteditable="true"\\][\\s\\S]*?\\.component-title-text\\[contenteditable="true"\\][\\s\\S]*?\\.dashboard-topbar-title\\[contenteditable="true"\\][\\s\\S]*?\\):${escapedState}\\s*\\{`,
        "u",
      ),
      `Narrative, artifact headings, component headings, and top-bar titles should share their ${state} interaction`,
    );
  }
  assert.match(css, /\.search-field\s*\{[^}]*border-radius:\s*var\(--control-radius\)/s);
  assert.match(
    css,
    /\.search\s*\{[^}]*font-size:\s*14px/s,
    "Evidence-table search text should use the requested 14px size",
  );
  assert.match(css, /\.table-pagination\s*\{[^}]*padding-left:\s*0/s);
  assert.match(css, /\.table-page-button\s*\{[^}]*width:\s*32px[^}]*height:\s*32px[^}]*border-radius:\s*var\(--radius-xl\)/s);
  assert.match(css, /\.actions button:not\(\.table-page-button\),\s*\.copy-button\s*\{/);
  assert.match(css, /\.search:focus,\s*\.search:focus-visible\s*\{[^}]*outline:\s*0/s);
  assert.match(css, /\.filter-trigger\s*\{[^}]*font-size:\s*14px/s);
  assert.match(
    css,
    /\.filter-trigger\s*\{[^}]*color:\s*var\(--text\)/s,
    "Shared filter values must not inherit unreadable foreground colors from a custom hero",
  );
  assert.match(css, /\.table th,\s*\.table td\s*\{[^}]*font-size:\s*14px/s);
  assert.match(css, /\.table :is\(th, td\):first-child\s*\{[^}]*padding-inline-start:\s*0/s,
    "The first header and body cell must align flush with the leading table edge");
  assert.match(css, /\.table :is\(th, td\):last-child\s*\{[^}]*padding-inline-end:\s*0/s,
    "The final header and body cell must align flush with the trailing table edge");
  assert.match(
    css,
    /:root\[data-color-scheme="dark"\]\s+\.topbar-mode-indicator\s*\{[^}]*background:\s*var\(--data-app-safe-chrome-indicator,[\s\S]*?color-mix\(/s,
    "Dark Data app mode controls must retain a readable protected indicator with a theme-aware fallback",
  );
  assert.match(
    css,
    /\.topbar-mode-indicator\s*\{[^}]*border-radius:\s*var\(--topbar-mode-inner-radius\)/s,
    "Authored theme radii must not distort the protected segmented-control indicator",
  );
  assert.match(
    css,
    /\.topbar-mode-switcher button\s*\{[^}]*border-radius:\s*var\(--topbar-mode-inner-radius\)/s,
    "Authored theme radii must not distort protected view/edit buttons",
  );
  assert.match(
    css,
    /\.topbar-mode-switcher\s*\{[^}]*--topbar-mode-inner-radius:\s*max\(0px,\s*calc\(var\(--radius-md\)/s,
    "Protected segmented controls must use the shared design-system radius rather than arbitrary authored control radii",
  );
  assert.match(
    css,
    /\.dashboard-header-action-button\s*\{[^}]*color:\s*var\(--data-app-safe-chrome-foreground/s,
    "The named action menu must remain legible against every branded top bar",
  );
  assert.doesNotMatch(css, /\.dashboard-overflow\b/u, "The single named action menu replaces the old overflow control");
  assert.match(
    css,
    /\.dashboard-chrome-inner\s*\{[^}]*--data-app-safe-chrome-inset-start[^}]*--data-app-safe-chrome-inset-end/s,
    "Protected full-width application chrome must preserve responsive viewport gutters",
  );
  assert.match(
    css,
    /\.theme-appearance-trigger\s*\{[^}]*background:\s*transparent/s,
    "Appearance should use a compact ghost dropdown inside the theme drawer",
  );
  assert.match(
    css,
    /\.theme-appearance-trigger:focus-visible\s*\{[^}]*outline:\s*none/s,
    "Appearance controls should use their subtle highlighted state instead of an automatic focus ring",
  );
});

test("theme switching offers the five independent bundled theme directions", () => {
  assert.deepEqual(
    dataAppThemes.map(({ id }) => id),
    ["original", "codex-classic", "default", "dark-pixel", "scientific-blue", "sticker-pop"],
  );
  for (const theme of dataAppThemes.filter(({ id }) => id !== "original")) {
    assert.equal(theme.tokens.length, 27, `${theme.id} does not cover every Data app token`);
  }
  const classicTheme = dataAppThemes.find(({ id }) => id === "codex-classic");
  assert.equal(classicTheme.label, "Classic");
  assert.equal(classicTheme.tokens[21], "16px");
  assert.equal(classicTheme.tokens[22], "12px");
  assert.equal(classicTheme.darkTokens[21], "16px");
  assert.equal(classicTheme.darkTokens[22], "12px");
  assert.match(classicTheme.tokens[26], /^-apple-system-body,/);
  assert.doesNotMatch(classicTheme.tokens[26], /OpenAI Sans/);
  assert.match(dataAppThemes.find(({ id }) => id === "default").tokens[26], /Georgia/);
});

test("every Data app theme follows system appearance or remains intentionally dark-only", async () => {
  function rgb(hex) {
    const expanded = hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join("")}` : hex;
    return [1, 3, 5].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16));
  }
  function luminance(hex) {
    return rgb(hex)
      .map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      })
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
  }
  function contrast(left, right) {
    const values = [luminance(left), luminance(right)].sort((first, second) => second - first);
    return (values[0] + 0.05) / (values[1] + 0.05);
  }

  for (const theme of dataAppThemes.filter(({ id }) => id !== "original")) {
    const light = dataAppThemePalette(theme, "light");
    const dark = dataAppThemePalette(theme, "dark");
    assert.equal(light.length, 27, `${theme.id} has incomplete light tokens`);
    assert.equal(dark.length, 27, `${theme.id} has incomplete dark tokens`);
    assert.ok(contrast(light[0], light[6]) >= 4.5, `${theme.id} light text lacks readable contrast`);
    assert.ok(contrast(dark[0], dark[6]) >= 4.5, `${theme.id} dark text lacks readable contrast`);
    if (theme.darkOnly) assert.deepEqual(dark, light, `${theme.id} should remain dark in both appearances`);
    else assert.notEqual(dark[0], light[0], `${theme.id} should change its background with system appearance`);
  }

  for (const name of ["codex-classic", "default", "scientific-blue", "sticker-pop"]) {
    const css = await readFile(new URL(`themes/${name}/theme.css`, templates), "utf8");
    assert.match(css, /color-scheme:\s*light dark/, `${name} must support both browser appearances`);
    assert.match(
      css,
      /--background:\s*(?:var\([^;]*,\s*)?light-dark\(/,
      `${name} must define both background variants`,
    );
  }
  const runtime = await readFile(new URL("../src/theme-runtime.js", import.meta.url), "utf8");
  assert.match(runtime, /matchMedia\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(runtime, /applyDataAppTheme\(selected, scheme\)/);
  assert.match(
    runtime,
    /setProperty\("--lightningcss-light"/u,
    "Explicit appearance overrides must also update production-transpiled light/dark CSS colors",
  );
  assert.match(runtime, /setProperty\("--lightningcss-dark"/u);
});

test("the classic theme preserves authored layout and uses restrained chart corners", async () => {
  const css = await readFile(new URL("themes/codex-classic/theme.css", templates), "utf8");
  const classic = dataAppThemes.find(({ id }) => id === "codex-classic");
  assert.match(css, /--chart-1:\s*light-dark\(#0285ff,/);
  assert.match(css, /--chart-2:\s*light-dark\(#924ff7,/);
  assert.match(css, /--chart-3:\s*light-dark\(#04b84c,/);
  assert.match(css, /--mark-radius:\s*8\s*;/);
  assert.doesNotMatch(
    css,
    /grid-template-columns:/,
    "A visual theme must not replace an independently authored page composition",
  );
  assert.equal(classic.tokens[14], "#924ff7");
  assert.equal(classic.tokens[0], "#fff");
  assert.equal(classic.darkTokens[0], "#181818");
  assert.equal(classic.darkTokens[1], "#212121");
  assert.match(css, /--color-token-main-surface-primary/);
  assert.match(css, /--color-token-foreground/);
  assert.match(css, /--color-token-description-foreground/);
  assert.match(css, /--color-token-border/);
  assert.equal(classic.tokens[23], "8");
  assert.equal(dataAppThemes.find(({ id }) => id === "default").tokens[23], "8");
});

test("component copy actions and chart editing remain directly accessible", async () => {
  const component = await readFile(new URL("../src/components/DataComponent.jsx", import.meta.url), "utf8");
  const explorer = await readFile(new URL("../src/components/ChartExplorer.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(
    component,
    /<MenuSub\b[^>]*label="Copy(?: as image| data)?"/,
    "Copy actions must remain directly accessible rather than being buried in a submenu",
  );
  assert.doesNotMatch(
    component,
    /<MenuSub\b[^>]*label="Width"/,
    "Component actions should stay focused on content while the accessible divider owns block sizing",
  );
  assert.match(component, />Copy as image<\/MenuItem>/);
  assert.match(component, />Copy data<\/MenuItem>/);
  assert.doesNotMatch(component, />Summary<\/MenuItem>/);
  assert.doesNotMatch(
    explorer,
    /Underlying data|<DataTable\b/u,
    "Chart editing should stay focused on the controls and chart preview",
  );
  assert.match(
    explorer,
    /formatChoice=\{optionLabel\}/u,
    "Chart types and reviewed fields should use human-readable English labels",
  );
  assert.match(explorer, /"X axis"/u, "Chart configuration should describe the actual horizontal-axis data field");
  assert.match(explorer, /"Y axis"/u, "Chart configuration should describe the actual vertical-axis data field");
  assert.doesNotMatch(explorer, /placeholder="Automatic"/u, "Empty optional axis titles should remain visibly empty");
  assert.doesNotMatch(
    explorer,
    />Apply<|className="explorer-actions"/u,
    "Chart edits should apply immediately without a separate Apply action",
  );
  for (const control of ["Show values", "Show legend", "Sort order", "Start axis at zero"]) {
    assert.match(
      explorer,
      new RegExp(`aria-label="${control}"|label="${control}"`),
      `Chart editing should expose the optional ${control.toLowerCase()} control`,
    );
  }
  assert.match(
    explorer,
    /<Switch\b[^>]*label=\{label\}[^>]*fullWidth/u,
    "Boolean chart controls should use accessible toggle switches rather than checkboxes",
  );
  const switchSource = await readFile(new URL("../src/components/Switch.jsx", import.meta.url), "utf8");
  assert.match(switchSource, /role="switch" aria-label=\{label\} aria-checked=\{checked\}/u);
  assert.match(
    explorer,
    /aria-label="Chart series colors"/u,
    "Chart appearance settings should expose a compact accessible theme-aware series color picker",
  );
  assert.match(
    explorer,
    /resolvedColorName\(token, target\)/u,
    "Chart editor color labels must describe the resolved active-theme swatch instead of its default token position",
  );
  assert.match(
    explorer,
    /aria-description=\{themeColorLabels\[token\]\}/u,
    "Chart palette swatches must describe their resolved hue alongside the exact color identity",
  );
  assert.match(
    explorer,
    /Custom hex color for/u,
    "Chart appearance settings should allow accessible custom series colors",
  );
  assert.match(
    explorer,
    /semanticColorCharts\.has\(spec\.type\)/u,
    "Charts with semantic or neutral colors should not show misleading primary-color controls",
  );
  assert.match(
    explorer,
    /changeChartEditorSpec\(draft \?\? localSpec,\s*field,\s*value,\s*\{\s*columns\s*\}\)/u,
    "The explorer must supply reviewed columns to the shared spec update rules so valid wide fields survive split changes",
  );
  assert.doesNotMatch(
    explorer,
    />Live preview</u,
    "The fullscreen chart preview should not repeat an unnecessary descriptive label",
  );
  assert.doesNotMatch(explorer, /type="checkbox"/u);
});

test("published chart permalinks use safe, encoded origin-rooted URLs without leaking viewer context", () => {
  const chartId = "Revenue [North] 50% — 東京";
  const source = new URL("https://viewer:private@dashboard.chatgpt.site/published?token=secret#codexThreadId=private");
  const encodedId = encodeURIComponent(chartId);
  const chartUrl = `https://dashboard.chatgpt.site/_data/charts/${encodedId}`;

  assert.equal(chartPermalink(source, chartId), chartUrl);
  assert.equal(
    chartPermalink(new URL(`${chartUrl}?another=secret#private`), chartId, {
      detail: true,
    }),
    `${chartUrl}/detail`,
  );
  assert.deepEqual(readChartPermalink(new URL(chartUrl)), {
    id: chartId,
    detail: false,
  });
  assert.deepEqual(readChartPermalink(new URL(`${chartUrl}/detail?token=secret#private`)), {
    id: chartId,
    detail: true,
  });
  assert.deepEqual(readComponentPermalink(new URL(chartUrl)), {
    id: chartId,
    detail: false,
    kind: "chart",
  });
  assert.deepEqual(readComponentPermalink(new URL(`${chartUrl}/detail`)), {
    id: chartId,
    detail: true,
    kind: "chart",
  });
  assert.equal(canonicalDashboardPath(`/_data/charts/${encodedId}`), "/");
  assert.equal(canonicalDashboardPath(`/_data/charts/${encodedId}/detail`), "/");
  assert.equal(canonicalDashboardPath("/published"), "/published");
  assert.deepEqual(currentDataAppReference(new URL(`${chartUrl}/detail?token=secret#private`)), {
    sourceUrl: "https://dashboard.chatgpt.site/",
  });
  assert.doesNotMatch(chartUrl, /private|secret|codexThreadId/u);
});

test("published component aliases are stable opaque UUIDv5 values scoped to their canonical Site", () => {
  const source = new URL(
    "https://viewer:secret@dashboard.chatgpt.site:443/published?token=private#codexThreadId=private",
  );
  const cleanSource = new URL("https://dashboard.chatgpt.site/_data/charts/old/detail?another=private#hidden");
  const secondSource = new URL("https://another-dashboard.chatgpt.site/");
  const authoredIds = [
    "active-users",
    "growth",
    "conversion",
    "forecast-gap",
    "usage-trend",
    "growth-drivers",
    "adoption-scenario",
    "segment-breakdown",
    "forecast-outlook",
    "priority-accounts",
    "usage-details",
  ];
  const aliases = authoredIds.map((id) => componentPermalinkId(source, id));

  assert.equal(
    new Set(aliases).size,
    authoredIds.length,
    "Every authored component must retain a distinct opaque share identity",
  );
  for (const [index, alias] of aliases.entries()) {
    assert.match(
      alias,
      /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
      `${authoredIds[index]} must use a lowercase RFC 4122 version-5 UUID`,
    );
    assert.equal(
      componentPermalinkId(cleanSource, authoredIds[index]),
      alias,
      "Path, private query, task fragment, credentials, and default port must not change Site identity",
    );
    assert.notEqual(
      componentPermalinkId(secondSource, authoredIds[index]),
      alias,
      "The same authored component must not reuse its UUID across different published Sites",
    );
    assert.equal(componentPermalink(source, alias), `https://dashboard.chatgpt.site/_data/components/${alias}`);
    assert.doesNotMatch(componentPermalink(source, alias), /secret|private|codexThreadId/u);
  }

  const chartAlias = componentPermalinkId(source, "usage-trend");
  assert.equal(chartPermalink(source, chartAlias), `https://dashboard.chatgpt.site/_data/charts/${chartAlias}`);
  assert.deepEqual(readComponentPermalink({ pathname: `/_data/charts/${chartAlias}/detail` }), {
    id: chartAlias,
    detail: true,
    kind: "chart",
  });
  assert.deepEqual(
    readComponentPermalink({ pathname: "/_data/charts/usage-trend/detail" }),
    {
      id: "usage-trend",
      detail: true,
      kind: "chart",
    },
    "Previously shared readable chart URLs must continue to resolve",
  );
});

test("newly shared component aliases are eight-character Site-scoped UUIDv5 prefixes", () => {
  const source = new URL(
    "https://viewer:secret@dashboard.chatgpt.site:443/published?token=private#codexThreadId=private",
  );
  const cleanSource = new URL("https://dashboard.chatgpt.site/_data/charts/old/detail?another=private#hidden");
  const secondSource = new URL("https://another-dashboard.chatgpt.site/");
  const authoredIds = [
    "active-users",
    "growth",
    "conversion",
    "forecast-gap",
    "usage-trend",
    "growth-drivers",
    "adoption-scenario",
    "segment-breakdown",
    "forecast-outlook",
    "priority-accounts",
    "usage-details",
  ];
  const aliases = authoredIds.map((id) => componentPermalinkShortId(source, id));

  assert.equal(
    new Set(aliases).size,
    authoredIds.length,
    "Each starter component must have its own short, stable share identity",
  );
  for (const [index, alias] of aliases.entries()) {
    const authoredId = authoredIds[index];
    const legacyUuid = componentPermalinkId(source, authoredId);
    const expected = Buffer.from(legacyUuid.replaceAll("-", "").slice(0, 12), "hex").toString("base64url");

    assert.match(alias, /^[A-Za-z\d_-]{8}$/u, `${authoredId} must share exactly eight URL-safe characters`);
    assert.equal(
      authoredIds.includes(alias),
      false,
      "No short share alias may collide with another authored starter component ID",
    );
    assert.equal(
      alias,
      expected,
      "Short component aliases must encode the first 48 bits of the established UUIDv5 identity",
    );
    assert.equal(
      componentPermalinkShortId(cleanSource, authoredId),
      alias,
      "Paths, private parameters, task fragments, credentials, and default ports must not change short aliases",
    );
    assert.notEqual(
      componentPermalinkShortId(secondSource, authoredId),
      alias,
      "The same authored component must not reuse its short alias on another published Site",
    );
    assert.equal(componentPermalink(source, alias), `https://dashboard.chatgpt.site/_data/components/${alias}`);
    assert.deepEqual(
      readComponentPermalink({ pathname: `/_data/components/${legacyUuid}` }),
      {
        id: legacyUuid,
        detail: false,
        kind: "component",
      },
      "Existing full-UUID widget links must remain backward-compatible",
    );
  }

  const chartAlias = componentPermalinkShortId(source, "usage-trend");
  assert.equal(chartPermalink(source, chartAlias), `https://dashboard.chatgpt.site/_data/charts/${chartAlias}`);
  assert.deepEqual(readComponentPermalink({ pathname: `/_data/charts/${chartAlias}/detail` }), {
    id: chartAlias,
    detail: true,
    kind: "chart",
  });
});

test("every published widget receives a safe, encoded component permalink without exposing viewer context", () => {
  const componentId = "Activation [North] 50% — 東京";
  const source = new URL("https://viewer:private@dashboard.chatgpt.site/published?token=secret#codexThreadId=private");
  const encodedId = encodeURIComponent(componentId);
  const componentUrl = `https://dashboard.chatgpt.site/_data/components/${encodedId}`;

  assert.equal(componentPermalink(source, componentId), componentUrl);
  assert.equal(componentPermalink(new URL(`${componentUrl}?another=secret#private`), componentId), componentUrl);
  assert.deepEqual(readComponentPermalink(new URL(`${componentUrl}?token=secret#private`)), {
    id: componentId,
    detail: false,
    kind: "component",
  });
  assert.equal(
    readChartPermalink(new URL(componentUrl)),
    null,
    "Generic component links must not be misclassified as legacy chart routes",
  );
  assert.equal(canonicalDashboardPath(`/_data/components/${encodedId}`), "/");
  assert.deepEqual(currentDataAppReference(new URL(`${componentUrl}?token=secret#private`)), {
    sourceUrl: "https://dashboard.chatgpt.site/",
  });
  assert.doesNotMatch(componentUrl, /private|secret|codexThreadId/u);

  for (const id of [
    "active-users",
    "growth",
    "conversion",
    "forecast-gap",
    "usage-trend",
    "growth-drivers",
    "adoption-scenario",
    "segment-breakdown",
    "forecast-outlook",
    "priority-accounts",
    "usage-details",
  ]) {
    assert.equal(
      componentPermalink(source, id),
      `https://dashboard.chatgpt.site/_data/components/${id}`,
      `${id} must have a stable generic dashboard component permalink`,
    );
  }
});

test("component and chart permalink helpers reject unsafe, malformed, oversized, and unpublished targets", () => {
  for (const id of ["", "  ", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(201)]) {
    assert.throws(() => chartPermalink("https://dashboard.chatgpt.site/", id), /safe chart component ID/u);
    assert.throws(() => componentPermalink("https://dashboard.chatgpt.site/", id), /safe dashboard component ID/u);
  }
  for (const family of ["charts", "components"]) {
    for (const pathname of [
      `/_data/${family}/`,
      `/_data/${family}/%`,
      `/_data/${family}/%2F`,
      `/_data/${family}/%5C`,
      `/_data/${family}/%00`,
      `/_data/${family}/%2E`,
      `/_data/${family}/%2E%2E`,
      `/_data/${family}/%20`,
      `/_data/${family}/widget/detail/more`,
      `/_data/${family}/${"x".repeat(201)}`,
      ...(family === "components" ? ["/_data/components/widget/detail"] : []),
    ]) {
      assert.equal(readComponentPermalink({ pathname }), null, `${pathname} must not become a widget target`);
      assert.equal(readChartPermalink({ pathname }), null, `${pathname} must not become a chart target`);
      assert.equal(
        canonicalDashboardPath(pathname),
        pathname,
        `${pathname} must not collapse an invalid route into the dashboard root`,
      );
    }
  }
  for (const source of ["file:///Users/example/dashboard.html", "javascript:alert(1)", "not a URL"]) {
    assert.throws(() => chartPermalink(source, "usage-trend"), /valid hosted Data app URL/u);
    assert.throws(() => componentPermalink(source, "active-users"), /valid hosted Data app URL/u);
  }
});

test("every published dashboard menu offers exactly one Copy link action with its correct permalink", async () => {
  const [component, app, dashboard] = await Promise.all([
    readFile(new URL("../src/components/DataComponent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(component, /published\s*=\s*false/u);
  assert.match(
    component,
    /published\s*&&\s*onCopy\s*&&\s*validComponentId\(component\.id\)[\s\S]*?component\.chart\s*\?\s*"link"\s*:\s*"component-link"[\s\S]*?>Copy link<\/MenuItem>/u,
    "Only published components with centrally validated IDs may offer a chart or widget permalink",
  );
  assert.equal(
    (component.match(/>Copy link<\/MenuItem>/gu) ?? []).length,
    1,
    "Every component menu must expose exactly one direct Copy link action",
  );
  assert.doesNotMatch(
    component,
    />Copy (?:chart|widget|chart detail) link<\/MenuItem>/u,
    "Component share actions must not include chart, widget, or legacy detail terminology",
  );
  assert.match(app, /published:\s*hosted/u);
  assert.match(app, /!hosted\s*\|\|\s*\(chartLink\s*&&\s*!component\.chart\)/u);
  assert.match(
    app,
    /const componentId\s*=\s*componentPermalinkShortId\(globalThis\.location,\s*component\.id\)/u,
    "Share actions must first convert authored IDs into compact eight-character opaque aliases",
  );
  assert.match(app, /chartPermalink\(globalThis\.location,\s*componentId/u);
  assert.match(app, /componentPermalink\(globalThis\.location,\s*componentId\)/u);
  assert.match(app, /detail:\s*format\s*===\s*"detail-link"/u);
  assert.match(app, /format\s*===\s*"component-link"/u);
  assert.match(
    app,
    /setActionStatus\(`\$\{component\.title\} link copied\.`\)/u,
    "Share confirmations must use the same concise language for every component",
  );

  for (const id of [
    "active-users",
    "growth",
    "conversion",
    "forecast-gap",
    "usage-trend",
    "growth-drivers",
    "adoption-scenario",
    "segment-breakdown",
    "forecast-outlook",
    "priority-accounts",
    "usage-details",
  ]) {
    assert.match(
      dashboard,
      new RegExp(`(?:id:\\s*"${id}"|id="${id}")`, "u"),
      `${id} must remain an authored component with a stable permalink target`,
    );
  }
});

test("authored dashboard views register with protected global tabs and retain shared filter state", async () => {
  const [context, publicApi, shell] = await Promise.all([
    readFile(new URL("../src/DataAppContext.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/data-app-public.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(
    publicApi,
    /useDataAppShell as useDataApp, useDashboardTabs/u,
    "Dashboard authors need a supported public hook instead of recreating page tabs",
  );
  assert.match(
    context,
    /registerDashboardTabs\?\.\(JSON\.parse\(serializedDefinitions\)\)/u,
    "Authored definitions should register through the existing protected shell",
  );
  assert.match(
    context,
    /return \{ activeTabId \}/u,
    "Authored content must know which global dashboard view is active",
  );
  assert.match(
    shell,
    /activeTabId,\s*registerDashboardTabs/u,
    "Global tab state and registration must flow through the public Data app context",
  );
  assert.match(
    shell,
    /reconcileDashboardTabs\(current, authored\)/u,
    "Saved tab order must be reconciled against declared page definitions",
  );
  assert.match(shell, /tabs=\{snapshot\.surface === "report" \|\| !tabRegistrationReady \? \[\] : tabs\}/u);
  assert.doesNotMatch(shell, /onAddTab=|onDeleteTab=|onRenameTab=|tabHasContent=/u);
  assert.match(
    shell,
    /<main[\s\S]*?data-dashboard-page=\{activeTabId\}[\s\S]*?>\s*\{children\}/u,
    "Switching runtime-rendered tabs must preserve mounted dashboard content and its shared filters",
  );
  assert.doesNotMatch(shell, /authoredTabIds|dashboard-empty-page/u);
  assert.doesNotMatch(
    shell,
    /setFilter\([^)]*activeTabId/u,
    "Changing dashboard views must not clear or replace global filter state",
  );
});

test("page filters stick beneath stable navigation and the open theme drawer", async () => {
  const [dashboard, dashboardStyles, controls, chrome, styles] = await Promise.all([
    readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/dashboard.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/Controls.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /<Filters sticky/u);
  assert.match(styles, /\.filters\.filter-bar\s*\{[^}]*position:\s*sticky/u);
  assert.match(styles, /\.filters\.filter-bar\s*\{[^}]*flex-wrap:\s*nowrap/u);
  assert.match(
    styles,
    /\.filters\.filter-bar\s*\{[^}]*border-bottom:\s*var\(--hairline, 1px\) solid transparent/u,
    "The resting filter bar must not show a divider",
  );
  assert.match(
    styles,
    /\.filters\.filter-bar\[data-stuck\]\s*\{[^}]*border-bottom-color:\s*var\(--border\)/u,
    "The filter bar must show its bottom hairline only after it sticks",
  );
  assert.doesNotMatch(
    styles,
    /--filter-bar-divider-inset/u,
    "The sticky divider must extend across the full bar rather than stop at the content width",
  );
  assert.doesNotMatch(
    dashboardStyles,
    /data-app-theme="codex-classic"[^{}]*:is\([^)]*\.filter-bar/u,
    "Dashboard theme styles must not remove the shared filter bar hairline",
  );
  assert.match(styles, /@property --dashboard-tabs-visible-height/u);
  assert.match(styles, /--dashboard-topbar-base-height:\s*52px[^}]*--dashboard-tabs-expanded-height:\s*36px/u);
  assert.match(chrome, /data-tabs-motion-ready/u);
  assert.match(styles, /grid-template-rows:\s*var\(--dashboard-tabs-visible-height\)/u);
  assert.match(
    styles,
    /top:\s*calc\(var\(--dashboard-topbar-base-height,[^)]+\) \+ var\(--dashboard-tabs-visible-height,[^)]+\) \+ var\(--filter-bar-theme-height,[^)]+\)\)/u,
  );
  assert.match(controls, /filterBar\.toggleAttribute\(/u);
});

test("hosted widget and chart links focus visible components once and respect accessibility and reduced motion", async () => {
  const [component, app, css] = await Promise.all([
    readFile(new URL("../src/components/DataComponent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    component,
    /ref=\{\(element\) => \{ elementRef\.current = element; onRegisterComponent\?\.\(component, element\); \}\}/u,
    "Every actual rendered component must register as a permalink target",
  );
  assert.match(
    component,
    /tabIndex=\{-1\}/u,
    "Metrics, charts, custom blocks, text, and tables must all support programmatic focus",
  );
  assert.match(
    app,
    /componentTargets\.current\.get\(linkedComponent\.id\)/u,
    "Widget IDs must use exact registry lookup instead of interpolated DOM selectors",
  );
  assert.match(
    app,
    /handledComponentPermalink\.current\s*===\s*routeKey/u,
    "A consumed component link must not trap viewers on a dashboard tab or reopen closed detail dialogs",
  );
  assert.match(
    app,
    /tabs\.find\(\(\{ id \}\)\s*=>\s*id\s*===\s*"dashboard"/u,
    "Authored dashboard tabs should remain the preferred fallback during bounded permalink discovery",
  );
  assert.match(app, /hidden\.has\(linkedComponent\.id\)/u);
  assert.match(
    app,
    /linkedComponent\.kind\s*===\s*"chart"\s*&&\s*!target\.component\.chart/u,
    "Legacy chart routes must still reject metrics, tables, text, and custom blocks",
  );
  assert.match(app, /The linked chart is unavailable\./u);
  assert.match(app, /The linked component is unavailable\./u);
  assert.match(app, /element\.scrollIntoView\(\{\s*block:\s*"center"/su);
  assert.match(app, /prefers-reduced-motion:\s*reduce/u);
  assert.match(app, /element\.focus\(\{\s*preventScroll:\s*true\s*\}\)/u);
  assert.match(app, /addEventListener\("popstate"/u);
  assert.match(
    app,
    /setRequest\(\(current\)\s*=>\s*current\?\.permalink/u,
    "History navigation must only dismiss dialogs originally opened by chart permalinks",
  );
  assert.match(
    app,
    /!next\?\.detail\s*\|\|\s*!matches\(current\.component\.id,\s*next\.id\)/u,
    "Route-owned dialogs must recognize both readable legacy IDs and opaque UUID aliases",
  );
  assert.match(
    css,
    /\.dashboard-component\[data-permalink-target="true"\]\s*\{[^}]*outline:\s*2px solid var\(--accent\)/su,
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.dashboard-component\[data-permalink-target="true"\]\s*\{\s*animation:\s*none\s*!important/su,
  );
});

test("short, UUID, and readable share aliases resolve safe mounted components without ownership maps", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");

  assert.match(
    app,
    /authoredId\s*===\s*permalinkId\s*\|\|\s*\(validComponentId\(authoredId\)[\s\S]*?componentPermalinkId\(globalThis\.location,\s*authoredId\)\s*===\s*permalinkId/u,
    "Unsafe authored IDs must never be hashed, while existing readable and full-UUID IDs remain valid",
  );
  assert.match(
    app,
    /componentPermalinkId\(globalThis\.location,\s*authoredId\)\s*===\s*permalinkId\s*\|\|\s*componentPermalinkShortId\(globalThis\.location,\s*authoredId\)\s*===\s*permalinkId/u,
    "Short links must coexist with previously shared full UUID and readable component URLs",
  );
  assert.match(
    app,
    /componentTargets\.current\.get\(linkedComponent\.id\)\s*\?\?\s*\[\.\.\.componentTargets\.current\.values\(\)\]\s*\.slice\(0,\s*500\)[\s\S]*?componentMatchesPermalink\(component\.id,\s*linkedComponent\.id\)/u,
    "Readable IDs must retain exact lookup precedence before bounded current-tab UUID resolution",
  );
  assert.match(
    app,
    /hidden\.has\(linkedComponent\.id\)\s*\|\|\s*\[\.\.\.hidden\]\.slice\(0,\s*500\)\.some\(\(id\)\s*=>\s*componentMatchesPermalink\(id,\s*linkedComponent\.id\)\)/u,
    "Hidden opaque aliases must be recognized before probing or disclosing another dashboard page",
  );
});

test("permalinks discover authored component tabs through bounded transient page probing", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");

  assert.match(
    app,
    /const componentTabProbe\s*=\s*useRef\(null\)/u,
    "Page discovery must use route-scoped transient state rather than persisted component ownership",
  );
  assert.match(
    app,
    /routeKey,\s*attemptedTabIds:\s*new Set\(\),\s*originalTabId:\s*activeTabId,\s*pendingTabId:\s*null/su,
  );
  assert.match(
    app,
    /probe\.pendingTabId\s*&&\s*probe\.pendingTabId\s*!==\s*activeTabId/u,
    "React StrictMode must not skip a candidate tab before its component refs have mounted",
  );
  assert.match(app, /tabs\.slice\(0,\s*50\)/u, "Untrusted presentation state must never cause an unbounded tab search");
  assert.match(app, /probe\.attemptedTabIds\.add\(activeTabId\)/u);
  assert.match(app, /probe\.pendingTabId\s*=\s*nextTab\.id;\s*setActiveTabId\(nextTab\.id\)/su);
  assert.match(
    app,
    /handledComponentPermalink\.current\s*=\s*routeKey;[\s\S]*?setActiveTabId\(probe\.originalTabId\)/u,
    "An exhausted permalink must restore its starting tab without restarting discovery",
  );
  assert.match(
    app,
    /componentTabProbe\.current\s*=\s*null/u,
    "Resolved links and history navigation must discard temporary discovery state",
  );
});

test("hidden permalink targets remain retryable after explicit restore without repeated unavailable toasts", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");
  const hiddenCheck = app.search(/const hiddenTarget\s*=\s*hidden\.has\(linkedComponent\.id\)/u);
  const tabProbe = app.search(/const existingTabIds\s*=\s*new Set\(/u);

  assert.ok(
    hiddenCheck >= 0 && hiddenCheck < tabProbe,
    "Hidden components must fail confidentially before probing any other dashboard page",
  );
  assert.match(
    app,
    /if\s*\(hiddenTarget\)\s*\{\s*componentTabProbe\.current\s*=\s*null;\s*showUnavailable\(\);\s*return;/su,
    "Hidden short, full-UUID, and readable links must remain unhandled so restoration retries focus or details",
  );
  assert.match(
    app,
    /unavailableComponentPermalink\.current\s*!==\s*routeKey/u,
    "Each pending hidden route must display its unavailable notification at most once",
  );
  assert.match(
    app,
    /setActionStatus\(\(current\)\s*=>\s*\(\s*current\s*===\s*unavailableMessage\s*\?\s*""\s*:\s*current\s*\)\)/u,
    "Successfully restored targets must dismiss their stale unavailable notification",
  );
});

test("closing linked chart details replaces only their URL path and preserves task-local browser state", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");

  assert.match(
    app,
    /function closeChartDialog\(dialog\)\s*\{\s*if\s*\(dialog\?\.permalink\)/su,
    "Manually opened chart explorers must close without rewriting unrelated browser URLs",
  );
  assert.match(app, /currentRoute\?\.kind\s*===\s*"chart"\s*&&\s*currentRoute\.detail/u);
  assert.match(
    app,
    /const url\s*=\s*new URL\(window\.location\.href\)/u,
    "The current URL must be cloned so browser-local query parameters and task fragments survive close",
  );
  assert.match(
    app,
    /url\.pathname\s*=\s*new URL\(chartPermalink\(window\.location,\s*currentRoute\.id\)\)\.pathname/u,
    "Closing linked details must remove only the suffix while preserving the exact short, UUID, or legacy token",
  );
  assert.match(
    app,
    /componentMatchesPermalink\(dialog\.component\.id,\s*currentRoute\.id\)/u,
    "Route ownership must recognize both opaque share aliases and readable legacy component IDs",
  );
  assert.match(
    app,
    /window\.history\.replaceState\(window\.history\.state,\s*"",\s*url\)/u,
    "Closing linked details must replace the current history entry while preserving its state",
  );
  assert.match(
    app,
    /setLinkedComponent\(readComponentPermalink\(url\)\)/u,
    "Replacing the browser URL must also synchronize in-app permalink state",
  );
  assert.match(app, /onClose=\{closeChartDialog\}/u);
  assert.match(
    app,
    /function closeChartDialog\(dialog\)[\s\S]*?chartEditorRef\.current\?\.close\(\)/u,
    "Closing a route-owned chart detail must canonicalize its URL before dismissing the dialog",
  );
});

test("chart detail permalinks preserve owner editing without giving read-only viewers mutation controls", async () => {
  const [explorer, editor, app] = await Promise.all([
    readFile(new URL("../src/components/ChartExplorer.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChartEditor.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
  ]);

  assert.match(explorer, /canEdit\s*=\s*true/u);
  assert.match(
    explorer,
    /\{canEdit\s*&&\s*(?:\(\s*)?<div\s+className="explorer-controls"/u,
    "Read-only chart detail views must not render owner-only chart mutation controls",
  );
  assert.match(
    app,
    /linkedComponent\.kind\s*===\s*"chart"\s*&&\s*linkedComponent\.detail\s*&&\s*component\.chart[\s\S]*?chartEditorRef\.current\?\.open\(\s*\{\s*type:\s*"explore",\s*component,\s*permalink:\s*true/u,
    "Only authentic chart detail routes may open the chart explorer",
  );
  assert.match(
    editor,
    /onChange=\{\s*canEdit\s*\?/u,
    "Read-only viewers must never receive a callback capable of changing shared chart overrides",
  );
  assert.match(
    app,
    /function saveChartDialog\(spec, dialog\)[\s\S]*?setChartOverrides\(/u,
    "Chart overrides must be persisted only after an authorized user explicitly saves",
  );
  assert.match(
    app,
    /import\s*\{\s*ChartEditor\s*\}\s*from\s*["']\.\/components\/ChartEditor\.jsx["']/u,
    "Durable charts must use the same canonical editor as inline charts",
  );
  assert.match(app, /<ChartEditor\b/u);
  const durableEditorProps = app.match(/<ChartEditor\b([\s\S]*?)\/>/u)?.[1];
  assert.ok(durableEditorProps, "The durable host must configure the shared editor");
  assert.match(durableEditorProps, /DialogComponent=\{Dialog\}/u);
  assert.match(durableEditorProps, /SelectComponent=\{Dropdown\}/u);
  assert.match(
    app,
    /import\s*\{[^}]*\bDialog\b[^}]*\}\s*from\s*["']\.\/components\/ui\.jsx["']/u,
    "Durable chart editing must retain its existing modal dialog primitive",
  );
  assert.match(
    app,
    /import\s*\{[^}]*\bDropdown\b[^}]*\}\s*from\s*["']\.\/components\/Controls\.jsx["']/u,
    "Durable chart editing must retain its existing reviewed-field dropdown primitive",
  );
  assert.doesNotMatch(app, /\b(?:createChartEditorState|changeChartEditorState|stepChartEditorHistory)\b/u);
  assert.match(
    editor,
    /from\s*["']\.\.\/charting\/chart-editor-state\.js["']/u,
    "The shared editor must keep draft/history state separate from either host",
  );
  assert.match(editor, /aria-label="Undo chart change"/u);
  assert.match(editor, /aria-label="Redo chart change"/u);
  assert.match(
    editor,
    /<Icon name="undo" size=\{18\}/u,
    "Chart history controls must use the actual shared Codex undo icon",
  );
  assert.match(
    editor,
    /showClose=\{!canEdit\}/u,
    "Editable chart workspaces should not show both Cancel and a redundant close button",
  );
  assert.match(editor, /className="button ghost chart-editor-cancel"/u);
  assert.match(editor, /className="button primary chart-editor-save"/u);
});

test("chart editor mounts its real header once before resolving chart data", async () => {
  const [app, editor, css] = await Promise.all([
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChartEditor.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const ChartEditorHost = forwardRef/u);
  assert.match(app, /flushSync\(\(\) => setRequest\(next\)\)/u);
  assert.match(editor, /contentReady\s*\?\s*getRows\(\)\s*:\s*\[\]/u);
  for (const source of [app, editor]) {
    assert.doesNotMatch(source, /chart-editor-loading-shell|document\.createElement/u);
  }
  assert.match(css, /\.chart-editor-dialog \.dialog-header\s*\{\s*animation: none/u);
});

test("the top bar distinguishes unpublished dashboards, owner autosave, and code changes", async () => {
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const component = await readFile(new URL("../src/components/DataComponent.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(chrome, /published\s*=\s*false/);
  assert.match(chrome, /canEdit\s*=\s*true/);
  assert.match(
    chrome,
    /onDoubleClick=\{\s*canEdit && !editingBlocked && !saving && saveStatus !== "saving"\s*\?/,
    "Authorized users should be able to double-click the dashboard title to start editing",
  );
  const publishReview = await readFile(new URL("../src/components/PublishReviewDialog.jsx", import.meta.url), "utf8");
  assert.match(chrome, /aria-label=\{editing \? "Save" : published \? "Publish changes" : "Publish"\}/u);
  assert.match(chrome, /onClick=\{editing \? onSave : openReview\}/u);
  // Audience reset and duplicate handoffs are exercised by the real preview
  // browser test; do not constrain openReview to a single source-code line.
  assert.match(publishReview, /<Dialog open=\{open\}/u);
  assert.match(publishReview, /type="radio"/u);
  assert.match(publishReview, /<a className="[^"]*\bdashboard-publish-confirm\b[^"]*" href=\{href\} target=\{dataAppPromptTarget\(href\)\}/u);
  assert.doesNotMatch(publishReview.match(/<a className="[^"]*\bdashboard-publish-confirm\b[^"]*"[^>]*>/u)?.[0] ?? "", /onAction|submitDataAppAction/u,
    "Publication keeps its native hyperlink instead of invoking a host action");
  assert.doesNotMatch(chrome, /dashboard-publish-sites-icon|<Icon name="sites"/u);
  assert.doesNotMatch(
    chrome,
    /onAction\?\.\("sites"/,
    "Publication must activate its handoff link directly from the user's click",
  );
  assert.match(chrome, /published &&[\s\S]*?onAction\?\.\("copy-link"\)/u);
  assert.match(chrome, /Saving…/);
  assert.match(chrome, /Couldn’t save/);
  // Owner/viewer editing controls are checked through rendered chrome states.
  assert.match(component, /canEdit\s*&&\s*component\.chart/);
  assert.match(css, /\.dashboard-publish-button\s*\{/);
  const publishCss = await readFile(new URL("../src/components/publish-review.css", import.meta.url), "utf8");
  assert.match(publishCss, /\.publish-review-option:has\(input:checked\)/u);
  assert.match(publishCss, /\.publish-review-footer > \.button:focus-visible\s*\{[^}]*outline: 2px solid/u);
  assert.match(css, /\.dashboard-save-status\s*\{/);
});

test("Data app actions use temporary accessible toasts without shifting the layout", async () => {
  const app = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");
  const toast = await readFile(new URL("../src/components/DataAppToast.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(app, /<DataAppToast message=\{actionStatus\}/);
  assert.doesNotMatch(
    app,
    /Request sent to the host\./,
    "Accepted local and deep-link actions must not claim that work was sent to a host",
  );
  assert.match(
    app,
    /This host cannot complete that \$\{surfaceNoun\} action\./,
    "Rejected host actions must retain actionable failure feedback",
  );
  assert.doesNotMatch(app, /className="dashboard-action-status"/);
  assert.match(toast, /duration\s*=\s*3500/);
  assert.match(toast, /setTimeout\(onDismiss,\s*duration\)/);
  assert.match(toast, /aria-live="polite"/);
  assert.match(toast, /const displayMessage = typeof message === "string"/u);
  assert.match(
    toast,
    /<span>\{displayMessage\}<\/span>/u,
    "Every toast must remove its terminal period at the shared rendering boundary",
  );
  assert.match(toast, /aria-label="Dismiss notification"/);
  assert.match(css, /\.dashboard-toast\s*\{[^}]*position:\s*fixed/s);
});

test("the default Classic starter starts with controls and avoids duplicate hero text", async () => {
  const app = await readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8");
  const layout = await readFile(new URL("../src/content/dashboard/dashboard.css", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const snapshot = JSON.parse(await readFile(new URL("../src/data.json", import.meta.url), "utf8"));
  assert.doesNotMatch(
    app,
    /className="hero"|data-data-app-title|\{appTitle\}<\/h1>/u,
    "The top bar already owns the dashboard title, so dashboard content must not repeat it as hero text",
  );
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const controls = await readFile(new URL("../src/components/Controls.jsx", import.meta.url), "utf8");
  const frame = await readFile(new URL("../src/charting/ChartFrame.jsx", import.meta.url), "utf8");
  assert.ok(
    (app.match(/\n\s+id: "(?:active-users|growth|conversion|forecast-gap)"/gu) ?? []).length > 0,
    "The starter should demonstrate optional metric cards without prescribing their count",
  );
  assert.doesNotMatch(app, /id: "accounts-at-risk"|className="metric-sparkline"/u);
  assert.doesNotMatch(
    chrome,
    />Fixture data<|>Sample data<|dashboard-fixture-label/u,
    "The protected top bar should not render a sample-data badge",
  );
  assert.match(chrome, /className="theme-appearance-trigger"\s+aria-label="Appearance"/u);
  assert.doesNotMatch(chrome, /px radius|Square corners|<b>Filter<\/b>/u);
  assert.doesNotMatch(chrome, /<MenuGroup label="Appearance">/u);
  assert.match(controls, /<Dropdown label=\{label\} value=\{value\} choices=\{\["all", \.\.\.choices\]\}/u);
  assert.match(frame, /className="chart-frame" style=\{\{ minHeight: height \}\}/u);
  assert.doesNotMatch(app, /className="eyebrow"/);
  assert.doesNotMatch(layout, /\.eyebrow\b/u, "The starter must not include unused default eyebrow styling");
  assert.doesNotMatch(styles, /\.eyebrow\b/u, "Shared theme selectors must not preserve a default eyebrow");
  assert.doesNotMatch(
    app,
    /Weekly active accounts, adoption drivers, product segments, forecast performance/u,
    "The starter must not invent or persist a generic dashboard description",
  );
  assert.match(
    shell,
    /savedPresentation\.description !== undefined \? \{ description: savedPresentation\.description \} : \{\}/u,
    "Previously authored dashboard descriptions must remain supported without creating a default description",
  );
  assert.doesNotMatch(
    app,
    />\s*(?:Executive summary|Key insights|What this means|Recommended next steps)\s*</iu,
    "The dashboard starter must not render autogenerated insight, narrative, or recommendation sections",
  );
  assert.equal(
    snapshot.title,
    "Product adoption and engagement",
    "The starter title should remain neutral and measurement-led",
  );
  assert.match(app, /title="Active accounts over time"/u);
  assert.match(app, /title="Active accounts by feature"/u);
  assert.doesNotMatch(
    app,
    /title="[^"]*(?:\d+%|is surging|is accelerating|requires immediate action)/iu,
    "Starter headings must not encode snapshot-specific values or conclusions",
  );
  assert.doesNotMatch(
    app,
    /story-section/u,
    "Internal dashboard section names should not suggest a narrative structure",
  );
  assert.doesNotMatch(app, /className="scenario-disclaimer"/);
  assert.match(app, /Projected values are modeled estimates, not reviewed observations/);
  assert.match(app, /variant="canvas" spacing="standard"/u);
  assert.match(styles, /\.metric-item \.component-title[^}]*white-space:\s*normal/s);
  assert.match(styles, /\.metric-item \.component-header\s*\{[^}]*margin-bottom:\s*0/s);
  assert.match(styles, /\.comparison\s*\{[^}]*width:\s*fit-content[^}]*justify-self:\s*start/s);
  assert.match(
    styles,
    /\.comparison\s*\{[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s,
    "Dynamic KPI comparisons must wrap inside their shared component",
  );
  assert.match(
    styles,
    /\.metric-sparkline\s*\{[^}]*max-width:\s*40%[^}]*flex:\s*0 1 104px/s,
    "Compact KPI trends must use a bounded, shrinkable flex slot",
  );
  assert.match(
    styles,
    /\[data-component-variant="card"\]:not\(\[data-component-kind="metric"\]\) \.component-title[^}]*font-size:\s*var\(--text-md-size\)/s,
    "Card titles must share their presentation without example stylesheet dependencies",
  );
  assert.match(
    app,
    /title="Target attainment"/u,
    "The reviewed forecast should explain progress toward the operating target",
  );
  assert.match(
    app,
    /className="forecast-progress"/u,
    "Target attainment should include an understandable custom progress visualization",
  );
  assert.match(
    layout,
    /\.scenario-layout\s*\{[^}]*grid-template-columns:\s*minmax\(220px,\s*290px\)\s*minmax\(0,\s*1fr\)/s,
    "Scenario controls and the taller projection chart should share a responsive two-column layout",
  );
  assert.match(
    layout,
    /\.scenario-levers\s*\{[^}]*padding:\s*0[^}]*\}/s,
    "Compact scenario assumptions should not add decorative section dividers",
  );
  assert.match(
    layout,
    /\.scenario-label,\s*\.scenario-caption\s*\{[^}]*font-size:\s*14px/s,
    "Scenario labels and comparisons should remain readable at 14px",
  );
  assert.match(layout, /\.priority-list strong\s*\{[^}]*font-weight:\s*500/s);
  assert.match(
    layout,
    /\.supporting-chart\s*\{[^}]*align-self:\s*stretch/s,
    "Supporting charts should fill their available grid space without a fixed height or extra padding",
  );
  assert.match(
    styles,
    /\.dashboard-component:only-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
    "A lone dashboard component should span every grid column, including in model-authored layouts",
  );
  assert.match(
    layout,
    /:is\(\.diagnostic-layout,\s*\.analysis-layout\):has\(>\s*\.dashboard-component:only-child\)\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    "Remaining chart and analysis components should expand when their neighbor is hidden",
  );
  assert.match(
    layout,
    /:is\(\.metric-strip,\s*\.diagnostic-layout,\s*\.analysis-layout\):not\(:has\(>\s*\.dashboard-component\)\)\s*\{[^}]*display:\s*none/s,
    "Groups with no remaining visible components should not leave empty layout space",
  );
  assert.doesNotMatch(
    app,
    /<DataComponent id="notes"|className="decision-note"/u,
    "The starter should not include unnecessary commentary blocks",
  );
  assert.doesNotMatch(
    app,
    /<Dropdown label="Scenario"/u,
    "Scenario assumptions should not be duplicated by a separate preset dropdown",
  );
  assert.match(
    app,
    /onChange=\{updateValue\}/u,
    "Scenario assumptions should update the modeled forecast on every input change",
  );
  assert.doesNotMatch(
    layout,
    /\.scenario-presets\s*\{/u,
    "Scenario selection should not retain the old segmented-control styling",
  );
  assert.match(app, /<Slider className="scenario-lever" label=\{label\} labelPlacement="inline"/u,
    "Scenario controls reuse the shared accessible slider instead of a duplicate range implementation");
  assert.match(app, /min=\{min\} max=\{max\} step=\{1\} value=\{liveValue\} onChange=\{updateValue\}/u,
    "The shared slider preserves bounds, live value and immediate scenario updates");
  assert.doesNotMatch(
    app,
    /onBlur=\{commit\}/u,
    "Pointer release must not be committed a second time when the slider subsequently blurs",
  );
  assert.doesNotMatch(
    app,
    /ChartControlSlider|MetricCards|Leaderboard|FinancePage|InternalUseCasesPage/u,
    "Base style changes should not introduce the later example components",
  );
});

test("Classic typography keeps app-specific display sizes outside the shared scale", async () => {
  const files = await Promise.all(
    ["styles.css", "content/dashboard/dashboard.css", "theme-picker.css"].map((file) =>
      readFile(new URL(`../src/${file}`, import.meta.url), "utf8"),
    ),
  );
  const sizes = [
    ...new Set(files.flatMap((css) => [...css.matchAll(/font-size:\s*(\d+)px/g)].map(([, size]) => Number(size)))),
  ].sort((left, right) => left - right);
  const weights = [
    ...new Set(files.flatMap((css) => [...css.matchAll(/font-weight:\s*(\d+)/g)].map(([, weight]) => Number(weight)))),
  ].sort((left, right) => left - right);
  assert.deepEqual(sizes, [12, 13, 14, 16, 20, 24, 32, 40]);
  assert.match(
    files[1],
    /:is\(\.forecast-value, \.scenario-value\)\s*\{[^}]*font-size:\s*32px[^}]*letter-spacing:\s*var\(--text-large-title-tracking\)[^}]*line-height:\s*36px/s,
    "Every 32px display value must share an exact 36px line box",
  );
  assert.match(
    files[0],
    /\.metric-value\s*\{[^}]*font-size:\s*32px[^}]*line-height:\s*36px/s,
    "KPI values should use the shared 32px display size with a readable 36px line box",
  );
  assert.match(
    files[1],
    /\.hero h1\s*\{[^}]*font-size:\s*40px[^}]*letter-spacing:\s*var\(--text-large-title-tracking\)/s,
  );
  assert.deepEqual(weights, [400, 500, 600]);
  assert.match(files[0], /\.chart-tooltip-heading\s*\{[^}]*font-size:\s*inherit;[^}]*line-height:\s*inherit;/s,
    "Adding a headline value must not enlarge the shared tooltip title");
});

test("selected theme presets update authored text while preserving preview typography", async () => {
  const styles = (await Promise.all(["styles.css", "components/source-inspector.css", "theme-picker.css"].map((file) =>
    readFile(new URL(`../src/${file}`, import.meta.url), "utf8")))).join("\n");
  assert.match(styles, /:root\[data-app-theme\]:not\(\[data-app-theme="original"\]\)/);
  assert.match(styles, /:is\(main, \.dashboard-topbar, \.source-sidebar, \[role="dialog"\]\)/);
  assert.match(
    styles,
    /:not\(pre \*, code \*\)/,
    "Theme typography must not replace the monospace font inside code surfaces",
  );
  assert.match(
    styles,
    /\.sql\s*\{[^}]*font-family:\s*ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace/s,
  );
  assert.match(
    styles,
    /\.sql :is\(code, span\)\s*\{\s*font-family:\s*inherit/,
    "SQL syntax spans must inherit the complete code font stack",
  );
  assert.match(styles, /\.theme-preview :is\(span, strong, b, i\)\s*\{\s*font-family:\s*var\(--preview-font\);\s*\}/);
});

test("waterfall tooltips suppress transparent baselines and retain semantic marker colors", async () => {
  const tooltip = await readFile(new URL("../src/charting/ChartTooltip.jsx", import.meta.url), "utf8");
  assert.match(tooltip, /item\.dataKey === "baseline"\) return false/);
  assert.match(
    tooltip,
    /seenFields\.has\(field\)/,
    "Composite area and line marks must not duplicate the same reviewed field in chart tooltips",
  );
  assert.match(tooltip, /name: "Net change"/);
  assert.match(tooltip, /change < 0 \? "var\(--negative\)" : "var\(--positive\)"/);
  assert.match(
    tooltip,
    /isTotal \? item\.payload\?\.runningTotal/u,
    "Reviewed beginning and ending totals must display their actual values",
  );
  assert.match(
    tooltip,
    /color: resolveColor\(item\) \?\? item\.color/u,
    "Categorical tooltip markers should resolve the same semantic color as their reviewed bar",
  );
});

test("chart transforms preserve reviewed dimensions", () => {
  const rows = [
    { period: "Jan", segment: "A", value: 10 },
    { period: "Jan", segment: "B", value: 20 },
    { period: "Feb", segment: "A", value: 15 },
  ];
  assert.deepEqual(pivot(rows, "period", "segment", "value"), [
    { period: "Jan", A: 10, B: 20 },
    { period: "Feb", A: 15 },
  ]);
  assert.deepEqual(
    waterfall(
      [
        { driver: "Before", change: 10 },
        { driver: "Activation", change: 4 },
        { driver: "Churn", change: -1 },
        { driver: "After", change: 13 },
      ],
      "change",
    ).map(({ baseline, change, isTotal, magnitude, runningTotal, waterfallRole }) => ({
      baseline,
      change,
      isTotal,
      magnitude,
      runningTotal,
      waterfallRole,
    })),
    [
      {
        baseline: 0,
        change: null,
        isTotal: true,
        magnitude: 10,
        runningTotal: 10,
        waterfallRole: "before",
      },
      {
        baseline: 10,
        change: 4,
        isTotal: false,
        magnitude: 4,
        runningTotal: 14,
        waterfallRole: "change",
      },
      {
        baseline: 13,
        change: -1,
        isTotal: false,
        magnitude: 1,
        runningTotal: 13,
        waterfallRole: "change",
      },
      {
        baseline: 0,
        change: null,
        isTotal: true,
        magnitude: 13,
        runningTotal: 13,
        waterfallRole: "after",
      },
    ],
  );
  assert.deepEqual(heatmap(rows, "period", "segment", "value").yValues, ["A", "B"]);
  const complete = heatmap(rows, "period", "segment", "value");
  assert.equal(complete.rows.length, 4, "Every reviewed row and column intersection should remain hoverable");
  assert.deepEqual(
    complete.rows.find((row) => row.period === "Feb" && row.segment === "B"),
    {
      period: "Feb",
      segment: "B",
      value: 0,
      __missing: true,
      xIndex: 1,
      yIndex: 1,
      intensity: 0,
    },
  );
  assert.deepEqual(
    heatmap(
      [
        { feature: "Search", surface: "Web", adoptionRate: 0.6 },
        { feature: "Search", surface: "Desktop", adoptionRate: 0.3 },
      ],
      "feature",
      "surface",
      "adoptionRate",
    ).rows.map(({ intensity }) => intensity),
    [1, 0.5],
  );
  const compressed = heatmap(
    [
      { period: "Jan", segment: "A", value: 0.96 },
      { period: "Jan", segment: "B", value: 0.97 },
    ],
    "period",
    "segment",
    "value",
  );
  assert.deepEqual(
    compressed.rows.map(({ intensity }) => intensity),
    [0, 1],
    "Narrow high-value heatmaps should reveal the observed variation instead of saturating every cell",
  );
  assert.equal(compressed.minimum, 0.96);
  assert.deepEqual(
    heatmap(
      [
        { period: "Jan", segment: "A", value: 0.96 },
        { period: "Jan", segment: "B", value: 0.97 },
      ],
      "period",
      "segment",
      "value",
      { startAtZero: true },
    ).rows.map(({ intensity }) => Number(intensity.toFixed(3))),
    [0.99, 1],
  );
  assert.equal(
    boxPlots(
      [{ segment: "A", minimum: 1, lowerQuartile: 2, median: 3, upperQuartile: 4, maximum: 5 }],
      "segment",
      "median",
    )[0].spread,
    2,
  );
});

test("sankey graphs aggregate complete reviewed paths without inventing nodes", () => {
  const graph = sankeyGraph(
    [
      { product: "Studio", decision: "Approved", outcome: "Completed", count: 4 },
      { product: "Studio", decision: "Approved", outcome: "Completed", count: 6 },
      { product: "API", decision: "Denied", outcome: "Stopped", count: 2 },
      { product: "API", decision: "Denied", outcome: "Stopped", count: 0 },
    ],
    ["product", "decision", "outcome"],
    "count",
  );
  assert.equal(graph.nodes.length, 6);
  assert.deepEqual(
    graph.links.map(({ value }) => value),
    [10, 10, 2, 2],
  );
});

test("sankey graphs can skip an empty feature and still reach the final priority stage", () => {
  const graph = sankeyGraph(
    [{ source: "Support", theme: "Reporting", feature: null, roadmap: "Unplanned", count: 7 }],
    ["source", "theme", "feature", "roadmap"],
    "count",
  );
  assert.deepEqual(graph.nodes.map(({ name }) => name), ["Support", "Reporting", "Unplanned"]);
  assert.deepEqual(graph.nodes.map(({ stage }) => stage), [0, 1, 3]);
  assert.deepEqual(graph.links.map(({ value }) => value), [7, 7]);
  assert.ok(!graph.nodes.some(({ stage }) => stage === 2), "No feature node should be invented for Unplanned");
});

test("mixed-sign stacked marks preserve separate positive and negative rounded bounds", () => {
  const row = { gains: 100, refunds: -30, credits: 25, adjustments: -10 };
  const fields = ["gains", "refunds", "credits", "adjustments"];

  assert.deepEqual(
    stackedMarkBounds(row, fields, "gains", {
      x: 10,
      y: 50,
      width: 20,
      height: 100,
    }),
    { x: 10, y: 25, width: 20, height: 125 },
  );
  assert.deepEqual(
    stackedMarkBounds(row, fields, "credits", {
      x: 10,
      y: 25,
      width: 20,
      height: 25,
    }),
    { x: 10, y: 25, width: 20, height: 125 },
  );
  assert.deepEqual(
    stackedMarkBounds(row, fields, "refunds", {
      x: 10,
      y: 180,
      width: 20,
      height: -30,
    }),
    { x: 10, y: 150, width: 20, height: 40 },
  );
  assert.deepEqual(
    stackedMarkBounds(row, fields, "adjustments", {
      x: 10,
      y: 190,
      width: 20,
      height: -10,
    }),
    { x: 10, y: 150, width: 20, height: 40 },
  );

  assert.deepEqual(
    stackedMarkBounds(row, fields, "gains", {
      x: 50,
      y: 10,
      width: 100,
      height: 20,
      horizontal: true,
    }),
    { x: 50, y: 10, width: 125, height: 20 },
  );
  assert.deepEqual(
    stackedMarkBounds(row, fields, "refunds", {
      x: 50,
      y: 10,
      width: -30,
      height: 20,
      horizontal: true,
    }),
    { x: 10, y: 10, width: 40, height: 20 },
  );
  assert.deepEqual(
    stackedMarkBounds(row, fields, "adjustments", {
      x: 20,
      y: 10,
      width: -10,
      height: 20,
      horizontal: true,
    }),
    { x: 10, y: 10, width: 40, height: 20 },
  );
  assert.equal(
    stackedMarkBounds({ empty: 0 }, ["empty"], "empty", {
      x: 0,
      y: 0,
      width: 10,
      height: 0,
    }),
    null,
  );
});

test("semantic chart colors follow the reviewed concept instead of local ordering", () => {
  assert.equal(semanticColor({ field: "activeUsers", index: 0 }), semanticColor({ field: "activeUsers", index: 7 }));
  assert.equal(
    semanticColor({
      field: "accounts",
      dimension: "plan",
      value: "Enterprise",
      index: 0,
    }),
    semanticColor({
      field: "accounts",
      dimension: "plan",
      value: "Enterprise",
      index: 5,
    }),
  );
  assert.notEqual(
    semanticColor({
      field: "accounts",
      dimension: "plan",
      value: "Enterprise",
    }),
    semanticColor({
      field: "accounts",
      dimension: "product",
      value: "Enterprise",
    }),
  );
  assert.equal(semanticColor({ field: "accounts", explicitColor: "#123456" }), "#123456");
});

test("reviewed plan colors remain distinct and stable across reordered charts", () => {
  const plans = ["Plus", "Free", "Business", "Enterprise", "Pro Lite", "Pro", "Go", "API BYOK"];
  const relatedPlans = ["Edu", "Education", "Healthcare", "Pro100", "Pro200", "Science", "Unknown", "All Plans"];
  const resolve = semanticColorResolver({
    accounts: { rows: [...plans, ...relatedPlans].map((plan) => ({ plan })) },
  });
  const assignments = plans.map((value) => resolve({ dimension: "plan", value }));
  assert.equal(new Set(assignments).size, plans.length);
  assert.equal(new Set([...plans, ...relatedPlans].map((value) => resolve({ dimension: "plan", value }))).size, 16);
  assert.ok(
    assignments.every((color) => /^oklch\(from var\(--chart-\d+\)/u.test(color)),
    "Reviewed category colors must derive from the active dashboard theme instead of hardcoded hex values",
  );
  assert.equal(resolve({ dimension: "plan", value: "Enterprise", index: 7 }), assignments[3]);
  assert.equal(
    resolve({
      dimension: "plan",
      value: "Enterprise",
      explicitColor: "#123456",
    }),
    "#123456",
  );
  assert.notEqual(
    resolve({ field: "new_7d" }),
    resolve({ field: "reactivated_7d" }),
    "Distinct measures in a shared chart should not collapse into nearly identical theme colors",
  );
});

test("larger reviewed dimensions and related failure states retain distinct theme-derived colors", () => {
  const labels = Array.from({ length: 24 }, (_, index) => `Feature ${String(index).padStart(2, "0")}`);
  const resolve = semanticColorResolver({
    features: { rows: labels.map((featureLabel) => ({ featureLabel })) },
    dimensions: { rows: ["Pro", "Team", "Web", "Desktop"].map((dimensionLabel) => ({ dimensionLabel })) },
  });
  assert.equal(new Set(labels.map((value) => resolve({ dimension: "featureLabel", value }))).size, labels.length);
  assert.notEqual(resolve({ dimension: "dimensionLabel", value: "Pro" }),
    resolve({ dimension: "dimensionLabel", value: "Team" }));
  const derivedColumns = ["Plugins", "Web search", "Artifacts", "Guardian reviews", "Image generation"];
  assert.equal(new Set(derivedColumns.map((field) => resolve({ field }))).size, derivedColumns.length,
    "Wide-form feature columns must not reuse a color just because their semantic hashes collide");
  const statuses = ["denied", "failed_closed", "timed_out"];
  assert.equal(new Set(statuses.map((value) => resolve({ dimension: "terminal_status", value }))).size,
    statuses.length);
  assert.equal(resolve({ dimension: "terminal_status", value: "denied" }), "var(--negative)");
  assert.equal(semanticCategoryDimension("dimensionLabel"), true);
});

test("generic category dimensions and pivoted series keep distinct, matching concept colors", () => {
  const resolve = semanticColorResolver({
    plans: {
      rows: ["Enterprise", "Plus", "Pro", "Business", "Pro Lite", "API BYOK"].map((category, index) => ({
        category,
        arr: index + 1,
        target: index,
      })),
    },
    history: {
      rows: [
        {
          Enterprise: 1,
          Plus: 2,
          Pro: 3,
          Business: 4,
          "Pro Lite": 5,
          "API BYOK": 6,
        },
      ],
    },
    billing: {
      rows: ["Subscription", "Credits", "API"].map((category, index) => ({
        category,
        arr: index,
      })),
    },
  });
  const plans = ["Enterprise", "Plus", "Pro", "Business", "Pro Lite", "API BYOK"];
  assert.equal(new Set(plans.map((value) => resolve({ dimension: "category", value }))).size, plans.length);
  for (const value of plans) assert.equal(resolve({ field: value }), resolve({ dimension: "category", value }));
  assert.notEqual(resolve({ field: "arr" }), resolve({ field: "target" }));
  assert.equal(
    new Set(["Subscription", "Credits", "API"].map((value) => resolve({ dimension: "category", value }))).size,
    3,
  );
});

test("derived semantic dimensions and lifecycle measures stay distinct across charts", () => {
  const resolve = semanticColorResolver({
    source: {
      rows: [
        { dimension: "codex", dau: 10 },
        { dimension: "work", dau: 20 },
      ],
    },
  });
  assert.notEqual(
    resolve({ field: "wau", dimension: "experience", value: "Codex" }),
    resolve({ field: "wau", dimension: "experience", value: "Work" }),
  );
  assert.equal(
    resolve({ field: "wau", dimension: "experience", value: "Codex" }),
    resolve({ field: "dau", dimension: "experience", value: "Codex" }),
  );
  assert.notEqual(resolve({ field: "newUsers" }), resolve({ field: "resurrectedUsers" }));
  assert.equal(resolve({ field: "resurrectedUsers" }), resolve({ field: "reactivatedUsers" }));
  assert.equal(resolve({ field: "churnedUsers" }), "var(--negative)");
  assert.notEqual(resolve({ field: "newUsers" }), resolve({ field: "churnedUsers" }));
  const cadenceColors = ["dau", "wau", "mau"].map((field) => resolve({ field }));
  assert.equal(new Set(cadenceColors).size, cadenceColors.length);
  assert.equal(resolve({ field: "dau" }), resolve({ field: "dailyActiveUsers" }));
  assert.equal(resolve({ field: "wau" }), resolve({ field: "weeklyActiveUsers" }));
  assert.equal(resolve({ dimension: "status", value: "Approved" }), "var(--positive)");
  assert.equal(resolve({ dimension: "status", value: "Denied" }), "var(--negative)");
  assert.equal(resolve({ dimension: "status", value: "Draft" }), "var(--secondary)");
  assert.notEqual(resolve({ dimension: "status", value: "Open" }), resolve({ dimension: "status", value: "Closed" }));
  for (const dimension of ["status", "country", "action", "surface", "experience", "plan"]) {
    assert.equal(semanticCategoryDimension(dimension), true);
  }
});

test("ratio metrics distinguish percentage-scale values from counts", () => {
  assert.equal(ratioMetric("adoptionRate", [0, 0.35, 0.6]), true);
  assert.equal(ratioMetric("share", [0.1, 1]), true);
  assert.equal(ratioMetric("retention", [1.2]), false);
  assert.equal(ratioMetric("activeUsers", [0, 1]), false);
});

test("only meaningful signed table deltas receive directional color", () => {
  assert.equal(deltaDirection("arrPlanVariance", "-$260.66M"), "negative");
  assert.equal(deltaDirection("growth", "+12.5%"), "positive");
  assert.equal(deltaDirection("netGrowth7d", 42), "positive");
  assert.equal(deltaDirection("change", -4), "negative");
  assert.equal(deltaDirection("variance", 0), "");
  assert.equal(deltaDirection("revenue", -4), "");
  assert.equal(deltaDirection("growth", "No reviewed target"), "");
});

test("category-colored bars recognize plan/product/segment dimensions without changing generic rankings", () => {
  for (const field of [
    "plan",
    "planType",
    "product_name",
    "customerSegment",
    "segments",
    "feature",
    "productExperience",
    "category",
    "billingBucket",
  ]) {
    assert.equal(semanticCategoryDimension(field), true, `${field} should retain semantic category colors`);
  }
  for (const field of ["region", "account", "rank", "forecast"]) {
    assert.equal(semanticCategoryDimension(field), false, `${field} should keep ordinary one-measure bar colors`);
  }
});

test("waterfalls preserve reviewed beginning and ending totals without double counting", () => {
  const bridge = waterfall(
    [
      { stage: "Beginning", accounts: 100 },
      { stage: "Expansion", accounts: 30 },
      { stage: "Churn", accounts: -10 },
      { stage: "Ending", accounts: 120 },
    ],
    "accounts",
    { categoryField: "stage", includeEnding: true },
  );
  assert.deepEqual(
    bridge.map(({ stage, balance, isTotal }) => ({ stage, balance, isTotal })),
    [
      { stage: "Beginning", balance: 100, isTotal: true },
      { stage: "Expansion", balance: 130, isTotal: false },
      { stage: "Churn", balance: 120, isTotal: false },
      { stage: "Ending", balance: 120, isTotal: true },
    ],
  );
});

test("waterfalls recognize reconciling period-labeled endpoint totals", () => {
  const bridge = waterfall(
    [
      { period: "FY25", amount: 100 },
      { period: "Expansion", amount: 35 },
      { period: "Contraction", amount: -10 },
      { period: "FY26", amount: 125 },
    ],
    "amount",
    { categoryField: "period", includeEnding: true },
  );
  assert.deepEqual(
    bridge.map(({ period, balance, isTotal }) => ({
      period,
      balance,
      isTotal,
    })),
    [
      { period: "FY25", balance: 100, isTotal: true },
      { period: "Expansion", balance: 135, isTotal: false },
      { period: "Contraction", balance: 125, isTotal: false },
      { period: "FY26", balance: 125, isTotal: true },
    ],
  );
  const movements = waterfall(
    [
      { period: "Activation", amount: 25 },
      { period: "Expansion", amount: 10 },
      { period: "Churn", amount: -4 },
    ],
    "amount",
    { categoryField: "period", includeEnding: true },
  );
  assert.ok(
    movements.every(({ isTotal }) => !isTotal),
    "Unreconciled movements must not be mislabeled as beginning or ending totals",
  );
});

test("waterfall endpoint totals retain numeric reviewed balances", () => {
  const totals = waterfall(
    [
      { driver: "Before", change: 10 },
      { driver: "Activation", change: 4 },
      { driver: "After", change: 14 },
    ],
    "change",
  ).filter(({ isTotal }) => isTotal);
  assert.deepEqual(
    totals.map(({ runningTotal }) => runningTotal),
    [10, 14],
  );
});

test("waterfalls derive ending totals only when an actual reviewed beginning exists", () => {
  const withBeginning = waterfall(
    [
      { stage: "Opening balance", amount: 80 },
      { stage: "Gain", amount: 25 },
      { stage: "Loss", amount: -10 },
    ],
    "amount",
    { categoryField: "stage", includeEnding: true },
  );
  assert.deepEqual(withBeginning.at(-1), {
    stage: "Ending",
    amount: 95,
    baseline: 0,
    magnitude: 95,
    range: [0, 95],
    change: null,
    balance: 95,
    runningTotal: 95,
    isTotal: true,
    totalType: "ending",
    waterfallRole: "after",
  });
  assert.equal(
    waterfall(
      [
        { stage: "Gain", amount: 25 },
        { stage: "Loss", amount: -10 },
      ],
      "amount",
      { categoryField: "stage", includeEnding: true },
    ).length,
    2,
    "A movements-only source must never gain an invented opening or closing value",
  );
});

test("waterfall range marks accurately preserve negative totals and movements crossing zero", () => {
  const crossing = waterfall(
    [
      { stage: "Beginning", amount: 10 },
      { stage: "Loss", amount: -15 },
      { stage: "Recovery", amount: 8 },
    ],
    "amount",
    { categoryField: "stage", includeEnding: true },
  );
  assert.deepEqual(
    crossing.map(({ range }) => range),
    [
      [0, 10],
      [10, -5],
      [-5, 3],
      [0, 3],
    ],
  );
  const negativeTotal = waterfall(
    [
      { stage: "Beginning", amount: -10 },
      { stage: "Loss", amount: -4 },
      { stage: "Recovery", amount: 20 },
    ],
    "amount",
    { categoryField: "stage", includeEnding: true },
  );
  assert.deepEqual(
    negativeTotal.map(({ range }) => range),
    [
      [0, -10],
      [-10, -14],
      [-14, 6],
      [0, 6],
    ],
  );
});

test("focused waterfall axes ignore decorative total-bar zero anchors", () => {
  const bridge = waterfall(
    [
      { driver: "Before", change: 12_000 },
      { driver: "Activation", change: 455 },
      { driver: "Expansion", change: 220 },
      { driver: "Churn", change: -165 },
      { driver: "After", change: 12_510 },
    ],
    "change",
    { categoryField: "driver", includeEnding: true },
  );

  const [minimum, maximum] = waterfallValueDomain(bridge);
  assert.ok(minimum > 11_000 && minimum < 12_000);
  assert.ok(maximum > 12_675 && maximum < 13_000);
  assert.ok(
    maximum - minimum < 1_000,
    "A focused axis should use reviewed balances rather than the total bars' zero anchors",
  );
  assert.deepEqual(bridge[0].range, [0, 12_000], "Focusing the axis must not rewrite the reviewed waterfall mark data");
  assert.deepEqual(bridge.at(-1).range, [0, 12_510]);
});

test("focused waterfall axes retain genuine zero crossings and negative balances", () => {
  const crossing = waterfall(
    [
      { stage: "Beginning", amount: 10 },
      { stage: "Loss", amount: -15 },
      { stage: "Recovery", amount: 8 },
    ],
    "amount",
    { categoryField: "stage", includeEnding: true },
  );
  const [crossingMinimum, crossingMaximum] = waterfallValueDomain(crossing);
  assert.ok(
    crossingMinimum < 0 && crossingMaximum > 0,
    "Movement ranges that genuinely cross zero must keep zero within the axis domain",
  );

  const negative = waterfall(
    [
      { stage: "Beginning", amount: -100 },
      { stage: "Loss", amount: -20 },
      { stage: "Ending", amount: -120 },
    ],
    "amount",
    { categoryField: "stage", includeEnding: true },
  );
  const [negativeMinimum, negativeMaximum] = waterfallValueDomain(negative);
  assert.ok(
    negativeMinimum < -120 && negativeMaximum < 0,
    "An entirely negative waterfall should focus on its negative reviewed balances",
  );
  assert.equal(waterfallValueDomain([]), undefined);
});

test("chart zoom ranges normalize reversed drags and ignore empty or single-point selections", () => {
  const rows = [{ day: "2026-08-01" }, { day: "2026-08-02" }, { day: "2026-08-03" }];
  assert.deepEqual(normalizeZoomRange(rows, "day", "2026-08-03", "2026-08-01"), {
    start: "2026-08-01",
    end: "2026-08-03",
  });
  assert.equal(normalizeZoomRange(rows, "day", "2026-08-01", "2026-08-01"), null);
  assert.equal(normalizeZoomRange(rows, "day", "2026-07-01", "2026-07-03"), null);
});

test("chart tooltips follow visual top-to-bottom order and reverse visible stacks", () => {
  const entries = [{ value: 10 }, { value: 35 }, { value: 80 }];
  assert.deepEqual(
    orderTooltipEntries(entries, { vertical: true }).map(({ value }) => value),
    [80, 35, 10],
  );
  assert.deepEqual(
    orderTooltipEntries(entries, { stacked: true }).map(({ value }) => value),
    [80, 35, 10],
  );
  assert.deepEqual(
    orderTooltipEntries(entries).map(({ value }) => value),
    [10, 35, 80],
  );
});

test("chart labels humanize field names without losing metric abbreviations", () => {
  assert.equal(label("activeUsers"), "Active Users");
  assert.equal(label("arr_plan"), "ARR plan");
  assert.equal(label("daily_wau"), "Daily WAU");
  assert.equal(label("mau"), "MAU");
  assert.equal(label("p95LatencyMs"), "P95 Latency Ms");
  assert.equal(categoryLabel("country", "US"), "United States");
  assert.equal(categoryLabel("countryCode", "US"), "United States");
  assert.equal(categoryLabel("request_country", "JP"), "Japan");
  assert.equal(categoryLabel("plan", "self_serve_business_usage_based"), "Self-serve business usage-based");
  assert.equal(categoryLabel("platform", "iOS app"), "iOS app");
  assert.equal(categoryLabel("platform", "iOS"), "iOS");
  assert.equal(categoryLabel("product", "ChatGPT"), "ChatGPT");
  assert.equal(categoryLabel("merchant", "eBay"), "eBay");
  assert.equal(categoryLabel("segment", "enterprise"), "Enterprise");
  assert.equal(categoryLabel("cohort", "2026-08-17"), "Aug 17");
  assert.equal(categoryLabel("cohort", "2026-08-17T00:00:00Z"), "Aug 17");
  assert.equal(categoryLabel("cohort", "—"), "—");
});

test("query-scoped filters preserve unrelated rows and aggregate-row behavior", () => {
  const rows = [
    { week: "2026-07-06", segment: "all", value: 12 },
    { week: "2026-07-06", segment: "A", value: 7 },
    { week: "2026-07-13", segment: "A", value: 9 },
  ];
  const definitions = [{ id: "segment", field: "segment", queryIds: ["segment_query"] }];

  assert.deepEqual(filterReviewedRows(rows, definitions, { segment: "A" }, "summary_query"), rows);
  assert.deepEqual(filterReviewedRows(rows, definitions, { segment: "A" }, "segment_query"), rows.slice(1));
  assert.deepEqual(filterReviewedRows(rows, definitions, { segment: "all" }, "segment_query"), [rows[0]]);
  assert.deepEqual(
    filterReviewedRows(rows, definitions, { segment: "all" }, "segment_query", ["segment"]),
    rows.slice(1),
  );
});

test("cumulative date filtering is opt-in and keeps exact filtering by default", () => {
  const rows = [
    { week: "2026-07-06", value: 3 },
    { week: "2026-07-13", value: 5 },
  ];
  const filters = { period: "2026-07-13" };

  assert.deepEqual(filterReviewedRows(rows, [{ id: "period", field: "week" }], filters, "trend", ["week"]), [rows[1]]);
  assert.deepEqual(
    filterReviewedRows(rows, [{ id: "period", field: "week", mode: "through" }], filters, "trend", ["week"]),
    rows,
  );
  assert.deepEqual(filterReviewedRows(rows, [{ id: "period", field: "week", operator: "lte" }], filters, "trend"), [
    rows[1],
  ]);
});

test("date ranges include only reviewed periods and anchor summaries to the latest reviewed day", () => {
  const rows = [
    { week: "2026-07-06", segment: "A", value: 10 },
    { week: "2026-07-13", segment: "A", value: 15 },
    { week: "2026-07-20", segment: "A", value: 20 },
    { week: "2026-07-27", segment: "A", value: 25 },
  ];
  const definitions = [{ id: "period", field: "week", mode: "through" }];
  const filters = { period: "2026-07-08..2026-07-22" };

  assert.deepEqual(filterReviewedRows(rows, definitions, filters, "summary", ["week"]), [rows[1], rows[2]]);
  assert.deepEqual(filterReviewedRows(rows, definitions, filters, "summary"), [rows[2]]);
  assert.deepEqual(previousPeriodRows(rows, definitions, filters, "summary", "week", "2026-07-20"), [rows[1]]);
});

test("prior-period comparisons ignore the selected period while preserving other filters", () => {
  const rows = [
    { week: "2026-07-06", segment: "A", value: 10 },
    { week: "2026-07-06", segment: "B", value: 20 },
    { week: "2026-07-13", segment: "A", value: 15 },
    { week: "2026-07-13", segment: "B", value: 25 },
  ];
  const definitions = [
    { id: "period", field: "week" },
    { id: "segment", field: "segment" },
  ];

  assert.deepEqual(
    previousPeriodRows(rows, definitions, { period: "2026-07-13", segment: "A" }, "summary", "week", "2026-07-13"),
    [rows[0]],
  );
});

test("box plots exclude sparse non-numeric groups without emitting invalid quantiles", () => {
  assert.deepEqual(boxPlots([], "segment", "value"), []);
  assert.deepEqual(
    boxPlots(
      [
        { segment: "missing", value: null },
        { segment: "missing", value: "not-a-number" },
        { segment: "reviewed", value: 2 },
        { segment: "reviewed", value: 4 },
      ],
      "segment",
      "value",
    ),
    [
      {
        segment: "reviewed",
        minimum: 2,
        lowerQuartile: 2.5,
        median: 3,
        upperQuartile: 3.5,
        maximum: 4,
        spread: 1,
      },
    ],
  );
});

test("source provenance retains nested reviewed evidence and rejects unsafe links", () => {
  const source = reviewedSource({
    url: "javascript:alert(1)",
    links: ["https://example.com/reviewed"],
    assumptions: ["Coverage excludes unverified rows."],
    query: {
      sql: "SELECT value FROM reviewed_table",
      tables_used: ["reviewed_table"],
      filters: ["status = 'reviewed'"],
      executed_at: "2026-07-27T12:00:00Z",
      metric_definitions: [{ label: "Value", definition: "Reviewed measurement." }],
      evidence_flow: ["Reviewed warehouse query", "Bounded dashboard snapshot"],
    },
  });

  assert.equal(source.sql, "SELECT value FROM reviewed_table");
  assert.deepEqual(source.tables, ["reviewed_table"]);
  assert.deepEqual(source.links, ["https://example.com/reviewed"]);
  assert.equal(source.definitions.length, 1);
  assert.equal(source.evidenceFlow.length, 2);
  assert.equal(safeSourceHref("file:///tmp/private"), null);
  assert.deepEqual(reviewedSource({}).evidenceFlow, []);
});

test("source provenance keeps labeled reviewed links and rejects unsafe object URLs", () => {
  const source = reviewedSource({
    links: [
      { label: "Open reviewed query", href: "https://example.com/query" },
      { label: "Unsafe query", href: "javascript:alert(1)" },
    ],
    query: { links: [{ label: "Warehouse source", url: "https://example.com/warehouse" }] },
  });
  assert.deepEqual(source.links, [
    { label: "Open reviewed query", href: "https://example.com/query" },
    { label: "Warehouse source", href: "https://example.com/warehouse" },
  ]);
});

test("reviewed source links reject signed URLs and embedded credentials", () => {
  const unsafeLinks = [
    "https://warehouse.example/reviewed?X-Amz-Signature=private",
    "https://warehouse.example/reviewed?X-Goog-Signature=private",
    "https://warehouse.example/reviewed?sv=1&sig=private",
    "https://warehouse.example/reviewed#access_token=private",
    "https://warehouse.example/data%3Ftoken=private",
    "https://warehouse.example/data%3ftoken%3dprivate",
    "https://warehouse.example/data%3FtOkEn%3Dprivate",
    "https://warehouse.example/data%23access_token=private",
    "https://warehouse.example/data%253Ftoken%253Dprivate",
    "https://warehouse.example/data%2523access_token%253Dprivate",
    "https://publisher:private@warehouse.example/reviewed",
    "https://warehouse.example/access_token/private",
    "https://warehouse.example/%61ccess_token/private",
    "https://warehouse.example/%2561ccess_token/private",
    "https://warehouse.example/%252561ccess_token/private",
    "https://warehouse.example/%2561ccess%255Ftoken/private",
    "https://warehouse.example/%2574oken/private",
    "https://warehouse.example/%252574oken/private",
    "https://warehouse.example/%25252525252525252561ccess_token/private",
    "https://warehouse.example/signature/private",
    "https://warehouse.example/reviewed;jsessionid=private",
    "https://warehouse.example/reviewed;PHPSESSID=private",
    "https://warehouse.example/reviewed%3Bjsessionid%3Dprivate",
    "https://warehouse.example/reviewed%253Bjsessionid%253Dprivate",
    "https://warehouse.example/reviewed%253BPHPSESSID%253Dprivate",
    "https://warehouse.example/reviewed%25253Bjsessionid%25253Dprivate",
    "https://warehouse.example/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "https://warehouse.example/%65yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "https://warehouse.example/eyJhbGciOiJIUzI1NiJ9%2EeyJzdWIiOiIxMjMifQ%2Esignature",
    "https://warehouse.example/%2565yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "https://warehouse.example/eyJhbGciOiJIUzI1NiJ9%252EeyJzdWIiOiIxMjMifQ%252Esignature",
    "https://warehouse.example/%252565yJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature",
    "https://warehouse.example/%E0%A4%A",
    "/warehouse/reviewed?sig=private",
    "../warehouse/reviewed#access_token=private",
  ];

  for (const href of unsafeLinks) {
    assert.equal(safeSourceHref(href), null, `Unsafe reviewed source URL was accepted: ${href}`);
  }
  assert.equal(
    safeSourceHref("https://warehouse.example/reviewed/dashboard"),
    "https://warehouse.example/reviewed/dashboard",
  );

  const source = reviewedSource({
    links: ["https://warehouse.example/reviewed/dashboard", ...unsafeLinks],
    tables: [
      { name: "analytics.reviewed", href: "https://catalog.example/reviewed" },
      ...unsafeLinks.map((href, index) => ({ name: `analytics.unsafe_${index}`, href })),
    ],
  });
  assert.deepEqual(source.links, ["https://warehouse.example/reviewed/dashboard"]);
  assert.deepEqual(source.tableLinks, {
    "analytics.reviewed": "https://catalog.example/reviewed",
  });
});

test("warehouse table chips link only when reviewed provenance supplies a safe URL", () => {
  const source = reviewedSource({
    tables: [
      "analytics.reviewed.daily",
      {
        name: "analytics.reviewed.cataloged",
        href: "https://catalog.example.com/tables/cataloged",
      },
    ],
    tableLinks: [
      { name: "analytics.reviewed.daily", href: "https://catalog.example.com/tables/daily" },
      {
        name: "analytics.reviewed.unsafe",
        href: "javascript:alert(1)",
      },
    ],
  });
  assert.deepEqual(source.tables, [
    "analytics.reviewed.daily",
    "analytics.reviewed.cataloged",
    "analytics.reviewed.unsafe",
  ]);
  assert.deepEqual(source.tableLinks, {
    "analytics.reviewed.daily": "https://catalog.example.com/tables/daily",
    "analytics.reviewed.cataloged": "https://catalog.example.com/tables/cataloged",
  });
});

test("reviewed source trust preserves explicit provider-neutral table and dashboard evidence", () => {
  const source = reviewedSource({
    tables: [
      {
        name: "analytics.reviewed.daily",
        href: "https://catalog.example.com/tables/daily",
        trust: {
          provider: " Warehouse ",
          uniqueUsers: 207,
          queryCount: 8967,
          windowDays: 30,
          verified: true,
          popularityScore: 0.98,
          ownerEmail: "private@example.com",
        },
      },
    ],
    links: [
      {
        kind: "dashboard",
        label: "Weekly revenue overview",
        href: "https://bi.example.com/revenue",
        trust: { provider: "Omni", view_count: 123, favorite_count: 17 },
      },
    ],
  });

  assert.deepEqual(source.tables, ["analytics.reviewed.daily"]);
  assert.deepEqual(source.tableLinks, {
    "analytics.reviewed.daily": "https://catalog.example.com/tables/daily",
  });
  assert.deepEqual(source.tableTrust, {
    "analytics.reviewed.daily": {
      provider: "Warehouse",
      uniqueUsers: 207,
      queryCount: 8967,
      windowDays: 30,
      verified: true,
    },
  });
  assert.deepEqual(source.links, [
    {
      href: "https://bi.example.com/revenue",
      label: "Weekly revenue overview",
      trust: { provider: "Omni", viewCount: 123, favoriteCount: 17 },
      kind: "dashboard",
    },
  ]);
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.reviewed.daily"]), [
    "Warehouse",
    "207 users",
    "8,967 queries in last 30 days",
    "Verified",
  ]);
  assert.deepEqual(sourceTrustLabels(source.links[0].trust), ["Omni", "123 views", "17 favorites"]);
});

test("source trust uses actual execution counts and asset-local metadata", () => {
  const source = reviewedSource({
    trust: { provider: "Must not transfer", queryCount: 999 },
    tables: [{ name: "analytics.reviewed.daily", trust: { provider: "Warehouse", queryCount: 3 } }],
    links: [
      {
        kind: "dashboard",
        label: "Reviewed asset",
        href: "https://example.com/report",
        trust: {
          provider: "Omni",
          viewCount: 842,
          windowDays: 28,
          verified: true,
          editedAt: "2026-08-10T12:00:00.000Z",
        },
      },
    ],
  });

  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.reviewed.daily"]), ["Warehouse", "3 queries"]);
  assert.deepEqual(sourceTrustLabels(source.links[0].trust), [
    "Omni",
    "842 views in last 28 days",
    "Verified",
    "Edited Aug 10",
  ]);
  assert.equal(
    source.links[0].kind,
    "dashboard",
    "Explicit reviewed asset types must survive labels and URLs without dashboard keywords",
  );
  assert.equal(
    Object.hasOwn(source, "trust"),
    false,
    "Query-level metadata must not be attributed to an unrelated source asset",
  );
  const invalidDate = reviewedSource({
    tables: [
      {
        name: "analytics.invalid",
        trust: {
          provider: "Warehouse",
          editedAt: "not a date",
        },
      },
    ],
  });
  assert.deepEqual(
    invalidDate.tableTrust["analytics.invalid"],
    { provider: "Warehouse" },
    "Invalid edit timestamps must not appear as reviewed dashboard metadata",
  );
});

test("source trust rejects invented, malformed, and ambiguous adoption metadata", () => {
  const source = reviewedSource({
    tables: [
      {
        name: "analytics.valid.daily",
        trust: {
          uniqueUsers: 1,
          queryCount: 1,
          windowDays: 1,
          verified: "true",
        },
      },
      {
        name: "analytics.reviewed.daily",
        trust: {
          uniqueUsers: -1,
          uniqueViewers: 1.5,
          queryCount: "8967",
          viewCount: Infinity,
          favoriteCount: Number.MAX_SAFE_INTEGER + 1,
          windowDays: 0,
          usage_count: 984,
          popularity_score: 0.98,
          verified: "yes",
        },
      },
    ],
  });

  assert.deepEqual(source.tableTrust, {
    "analytics.valid.daily": { uniqueUsers: 1, queryCount: 1, windowDays: 1 },
  });
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.valid.daily"]), ["1 user", "1 query in last 1 day"]);
  assert.deepEqual(sourceTrustLabels(null), []);
});

test("duplicate reviewed source entries merge safe links and explicitly supplied trust", () => {
  const source = reviewedSource({
    tables: [{ name: "analytics.reviewed.daily", trust: { unique_viewers: 12, window_days: 7 } }],
    tableLinks: [{ name: "analytics.reviewed.daily", href: "https://catalog.example.com/daily" }],
    href: "https://bi.example.com/dashboard",
    links: [
      {
        href: "https://bi.example.com/dashboard",
        kind: "dashboard",
        label: "Reviewed dashboard",
        trust: { uniqueViewers: 24, viewCount: 72, windowDays: 30, verified: true },
      },
    ],
  });

  assert.deepEqual(source.tableTrust, {
    "analytics.reviewed.daily": { uniqueViewers: 12, windowDays: 7 },
  });
  assert.deepEqual(source.tableLinks, { "analytics.reviewed.daily": "https://catalog.example.com/daily" });
  assert.deepEqual(sourceTrustLabels(source.links[0].trust), ["24 viewers", "72 views in last 30 days", "Verified"]);
  assert.equal(source.links[0].trust.verified, true);
  assert.equal(source.links[0].kind, "dashboard");
});

test("source provenance upgrades a repeated raw URL to its descriptive reviewed label", () => {
  assert.deepEqual(
    reviewedSource({
      href: "https://example.com/query",
      links: [{ label: "Open reviewed warehouse query", href: "https://example.com/query" }],
    }).links,
    [{ label: "Open reviewed warehouse query", href: "https://example.com/query" }],
  );
});

test("SQL formatting preserves quoted literals, identifiers, and comments exactly", () => {
  const sql =
    "SELECT note, `FROM, column` FROM reviewed WHERE note = 'rock AND roll' " +
    "AND category = 'one, two' AND author = 'O''Reilly' /* FROM, OR */ -- WHERE AND, comment\n" +
    "AND status = 'reviewed'";
  const formatted = formatReviewedSql(sql);
  for (const token of [
    "'rock AND roll'",
    "'one, two'",
    "'O''Reilly'",
    "`FROM, column`",
    "/* FROM, OR */",
    "-- WHERE AND, comment\n",
  ]) {
    assert.ok(formatted.includes(token), `Formatting changed the reviewed SQL token ${token}`);
  }
  assert.match(formatted, /^SELECT\n  note,\n  /);
  assert.match(formatted, /\nFROM\n  reviewed\nWHERE\n  /);
  assert.equal(formatReviewedSql(""), "No reviewed SQL provided.");
});

test("date filters match complete field tokens rather than unrelated substrings", () => {
  for (const field of ["week", "reporting_week", "eventDate", "created_timestamp"]) {
    assert.equal(isTemporalField(field), true, `${field} should be treated as a reporting dimension`);
  }
  for (const field of ["lifetime_value", "candidate_status", "daylight_savings", "updated_flag"]) {
    assert.equal(isTemporalField(field), false, `${field} is not a date dimension`);
  }
  assert.equal(
    isTemporalField("recorded_at", "datetime"),
    true,
    "Explicit date metadata should identify nonstandard reporting fields",
  );
});

test("reviewed periods use the designated reporting field and omit ambiguous date columns", () => {
  const rows = [
    { reporting_week: "2026-07-27", signup_date: "2021-01-04", contract_date: "2030-10-09" },
    { reporting_week: "2026-08-03", signup_date: "2020-02-11", contract_date: "2031-01-02" },
  ];
  const component = { queryId: "usage" };
  for (const options of [
    { component, query: { reportingField: "reporting_week" } },
    { component: { ...component, chart: { x: "reporting_week" } } },
    { component, filters: [{ field: "reporting_week", queryIds: ["usage"] }] },
  ]) {
    const period = reviewedDateRange(rows, options);
    assert.match(period, /2026/);
    assert.doesNotMatch(
      period,
      /2020|2021|2030|2031/,
      "Unrelated signup and contract dates cannot become the reviewed reporting period",
    );
  }
  assert.equal(
    reviewedDateRange(rows, { component }),
    "",
    "Ambiguous reporting dimensions must not create invented provenance",
  );
  assert.match(reviewedDateRange([{ week: "2026-07-27" }]), /2026/);
});

test("host actions preserve presentation state without embedding reviewed rows", () => {
  const context = {
    title: "Decision dashboard",
    snapshot: { generatedAt: "2026-07-27T12:00:00Z", queries: { reviewed: { rows: [{ secretMarker: 42 }] } } },
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
  assert.doesNotMatch(pdf.prompt, /secretMarker/u);
  assert.match(dataAppActionRequest("google-docs", context).prompt, /Import the verified DOCX as a native Google Doc/);
  assert.match(
    dataAppActionRequest("google-slides", context).prompt,
    /Import the verified PPTX as native Google Slides/,
  );
  assert.match(dataAppActionRequest("word", context).prompt, /rather than importing it into Google Drive/);
  assert.throws(() => dataAppActionRequest("unknown", context), /Unsupported dashboard action/);
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


test("report and dashboard content inherit protected chrome and source-backed component actions", async () => {
  const [shell, editor, dashboard, report, reportStyles, manifest] = await Promise.all([
    readFile(new URL("../src/DataAppShell.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ChartEditor.jsx", import.meta.url), "utf8"),
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
  assert.match(shell, /<ChartEditor\b/u);
  assert.match(editor, /<ChartExplorer\b/u);
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
  assert.doesNotMatch(dashboard, /<h1 data-data-app-title/u, "The shared top bar owns the dashboard title");
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

test("source drawer defers data work and shares measured tab selection motion", async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
  const [shell, source, ui, tabs, css] = await Promise.all([
    read("../src/DataAppShell.jsx"),
    read("../src/components/SourceInspector.jsx"),
    read("../src/components/ui.jsx"),
    read("../src/components/DashboardTabs.jsx"),
    Promise.all([read("../src/styles.css"), read("../src/components/source-inspector.css")]).then(parts => parts.join("\n")),
  ]);
  assert.match(shell, /SourceSidebarHost = forwardRef/u);
  assert.match(shell, /open\(next\)\s*\{\s*flushSync/u);
  assert.match(source, /ready \? getSource\(selectedQueryId\) : null/u);
  assert.match(source, /setTimeout\(onClose, 140\)/u);
  assert.match(source, /writeText\(sql\)/u, "Copy preserves the reviewed query");
  assert.doesNotMatch(source, /wrapSql|Wrap SQL lines|textWrap/u);
  assert.match(css, /\.sql-line-content \{ overflow-wrap: anywhere; white-space: pre-wrap; \}/u);
  assert.doesNotMatch(source, /setFormatSql|>Wrap<|>Formatted</u);
  assert.match(ui, /getBoundingClientRect\(\)/u);
  assert.match(ui, /indicator\.animate\(/u);
  assert.match(tabs, /<TabIndicator/u);
  assert.match(css, /source-sidebar-layer\.is-closing/u);
  assert.match(shell, /Chart image for “\$\{component\.title\}” copied/u);
});
