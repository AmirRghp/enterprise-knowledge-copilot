import assert from "node:assert/strict";
import { readFile as readRawFile } from "node:fs/promises";
import test from "node:test";

import { dataAppActionRequest } from "../src/data-app-actions.js";

const stylesUrl = new URL("../src/styles.css", import.meta.url);
async function readFile(url, encoding) {
  const content = await readRawFile(url, encoding);
  if (url.href !== stylesUrl.href || encoding !== "utf8") return content;
  const foundation = await readRawFile(new URL("../src/styles-foundation.css", import.meta.url), "utf8");
  return content.replace(/^@import "\.\/styles-foundation\.css";\n/u, `${foundation}\n`);
}

function followUpContext(surface = "dashboard") {
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
      rows: [{ customer: "PRIVATE_PRESENTATION_ROW" }],
      sql: "SELECT PRIVATE_PRESENTATION_QUERY",
      credentials: { password: "PRIVATE_PASSWORD" },
      authorization: "Bearer PRIVATE_AUTHORIZATION_TOKEN_1234567890",
    },
  };
}

function assertInOrder(source, labels, message) {
  let previous = -1;
  for (const label of labels) {
    const index = source.indexOf(label, previous + 1);
    assert.ok(index > previous, `${message}: ${label}`);
    previous = index;
  }
}

test("the top bar opens the dashboard Ask composer and keeps one icon-only overflow menu", async () => {
  const [chrome, dashboardAsk, styles, packageJson, main, vite] = await Promise.all([
    readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/DashboardAsk.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../src/main.jsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(chrome, /function DataAppActionMenu\b/u);
  assert.equal(
    (chrome.match(/<DataAppOverflowMenu\b/gu) ?? []).length,
    1,
    "The shared top bar must render one overflow menu for every dashboard and report",
  );
  for (const source of [chrome, packageJson, main, vite]) {
    assert.doesNotMatch(
      source,
      /dialkit|useDialKit/iu,
      "The dashboard Ask composer must not keep DialKit runtime or build wiring",
    );
  }
  await assert.rejects(
    readFile(new URL("../dialkit.config.json", import.meta.url), "utf8"),
    { code: "ENOENT" },
    "Removing DialKit must also remove its project config",
  );
  assert.doesNotMatch(chrome, /dashboard-overflow/u);
  assert.match(
    chrome,
    /<HeaderActionButton\s+disabled=\{mode === "edit" \? saving : build.active\}[\s\S]*?ref=\{askButtonRef\}\s+label=\{mode === "edit" \? "Cancel" : "Ask ChatGPT"\}\s+icon=\{mode === "edit" \? null : "chatBubble"\}\s+compactLabel=\{mode === "edit" \? "Cancel" : "Ask"\}\s+className="dashboard-ask-button"\s+onClick=\{mode === "edit" \? onCancel : \(\) => openAskComposer\(\)\}\s*\/>/u,
    "The Ask button must open the shared composer directly while using the compact label below 900px",
  );
  const headerButton = chrome.match(/const HeaderActionButton[\s\S]*?^\}\);/mu)?.[0] ?? "";
  assert.match(
    headerButton,
    /<DashboardAskIcon name=\{icon\} size=\{18\}/u,
    "The Ask ChatGPT button uses the exact 18px Figma chat bubble instance",
  );
  assert.match(dashboardAsk, /headerMorph = anchorElement\.classList\.contains\("dashboard-ask-button"\)/u);
  assert.match(dashboardAsk, /selectionEnabled = enabled && !isCodexBrowser\(\)/u);
  assert.match(
    dashboardAsk,
    /triggerLabel = anchorElement\.innerText\.trim\(\) \|\| anchorElement\.getAttribute\("aria-label"\) \|\| "Ask ChatGPT"/u,
    "The closing morph must use the label visible at the current viewport",
  );
  assert.match(
    dashboardAsk,
    /triggerLabelInset: `\$\{\(labelBounds\?\.left \?\? bounds\.left \+ triggerBorderWidth \+ Number\.parseFloat\(triggerStyle\.paddingLeft\)\) - bounds\.left\}px`/u,
    "The closing morph accounts for the leading icon and falls back to padding for other triggers",
  );
  assert.match(
    dashboardAsk,
    /sharedPromptLabel = closing && headerMorph[\s\S]*?selection\.triggerLabel \?\? "Ask ChatGPT"/u,
    "The compact Ask label must replace the full label before the closing morph shrinks",
  );
  assert.match(dashboardAsk, /triggerRight:\s*bounds\.right/u);
  assert.match(dashboardAsk, /if \(!event\.currentTarget\.value\.trim\(\)\) return;/u);
  assert.match(styles, /@keyframes dashboard-ask-header-morph/u);
  assert.match(styles, /@keyframes dashboard-ask-header-unmorph/u);
  assert.match(styles, /@keyframes dashboard-ask-header-submit-in/u);
  assert.match(styles, /@keyframes dashboard-ask-header-submit-out/u);
  assert.match(styles, /@keyframes dashboard-ask-header-content-out/u);
  assert.match(styles, /@keyframes dashboard-ask-header-label-in/u);
  assert.match(
    styles,
    /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*?\.dashboard-ask-discard:hover/u,
    "Ask hover treatments must only run on devices with precise hover input",
  );
  assert.match(dashboardAsk, /onAnimationEnd=\{finishClosing\}/u);
  assert.match(dashboardAsk, /HEADER_UNMORPH_DURATION = HEADER_MORPH_DURATION \+ 50/u);
  assert.match(dashboardAsk, /setTimeout\(completeClose, HEADER_UNMORPH_DURATION \+ 100\)/u);
  assert.match(
    styles,
    /\[data-closing="true"\][^{]*\{[^}]*animation-name:\s*dashboard-ask-header-unmorph;[^}]*animation-duration:\s*var\(--dashboard-ask-header-unmorph-duration, 170ms\)/u,
    "The header Ask exit must run 50ms longer than its entrance",
  );
  assert.match(styles, /\.dashboard-ask-button\.dashboard-ask-trigger-morphing\s*\{[^}]*visibility:\s*hidden/u);
  assert.match(
    styles,
    /\[data-header-morph="true"\]:not\(\[data-composer-expanded="true"\]\)[^{]*\{[^}]*border-radius:\s*var\(--dashboard-ask-trigger-radius/u,
  );
  assert.match(
    styles,
    /\.dashboard-ask-panel\[data-phase="compose"\]\[data-source="header"\]\[data-header-morph="true"\]\s*\{[^}]*right:\s*0[^}]*left:\s*auto/u,
    "The input morph must preserve the Ask button's right edge so neighboring actions do not move",
  );
  assert.match(
    styles,
    /@keyframes dashboard-ask-header-morph[\s\S]*?to\s*\{[^}]*top:\s*-18px/u,
    "The header composer must keep the Ask button's top edge fixed while it grows",
  );
  assert.doesNotMatch(headerButton, /chevronDown/u);
  assert.match(
    styles,
    /:root:is\(\[data-app-theme="original"\], \[data-app-theme="codex-classic"\]\)[^{}]*\.dashboard-header-action-button[^{}]*\{\s*border-radius: var\(--radius-xl\);/u,
    "The Classic Ask ChatGPT trigger must use the shared 12px chrome radius",
  );
  assert.doesNotMatch(
    headerButton,
    /<Icon name="more"/u,
    "The Ask ChatGPT trigger must not reintroduce the removed three-dot menu",
  );
  assert.doesNotMatch(
    styles,
    /dashboard-header-action-more/u,
    "The removed three-dot trigger must not keep responsive styling",
  );
  const overflowButton = chrome.match(/const HeaderOverflowButton[\s\S]*?^\}\);/mu)?.[0] ?? "";
  assert.match(overflowButton, /aria-label="More"/u);
  assert.match(overflowButton, /<Icon name="more" size=\{18\} \/>/u);
  assert.doesNotMatch(overflowButton, /dashboard-header-action-label|chevronDown/u);
  assert.match(
    styles,
    /\.dashboard-header-overflow-button\s*\{[^}]*width:\s*32px[^}]*padding:\s*0/su,
    "The overflow trigger must keep a compact square hit target",
  );
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.dashboard-freshness-full[\s\S]*?\.dashboard-save-status:not\(\.has-error\):not\(\[data-status="saving"\]\)[\s\S]*?\.dashboard-refresh-trigger-chevron[\s\S]*?display: none;/u,
    "Below 900px, the full timestamp, saved state, and refresh caret must be hidden",
  );
  assert.doesNotMatch(styles, /dashboard-publish-sites-icon/u);
  assert.match(
    styles,
    /@media \(max-width: 900px\)[\s\S]*?\.dashboard-freshness-compact[\s\S]*?\.dashboard-header-action-label-compact[\s\S]*?display: inline;/u,
    "Below 900px, the month-day timestamp and Ask label must be shown",
  );
  assert.match(
    styles,
    /\.popover\.dashboard-header-action-menu\s*\{[^}]*max-height:\s*var\(--radix-dropdown-menu-content-available-height\)[^}]*overflow-y:\s*auto/su,
    "Tall action menus must scroll within the available viewport height",
  );
  assertInOrder(
    chrome,
    ["<DataAppOverflowMenu", "<HeaderActionButton", "<DataAppPublishButton"],
    "The overflow menu precedes Ask and Publish",
  );
});

test("header close restores the complete button without a border or icon pop", async () => {
  const source = await readFile(new URL("../src/components/DashboardAsk.jsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const exit = css.slice(css.indexOf("@keyframes dashboard-ask-header-unmorph"), css.indexOf(".dashboard-ask-return-icon"));
  assert.match(exit, /to \{[^}]*border-radius: var\(--dashboard-ask-trigger-radius,[^}]*border: 0 solid transparent;[^}]*box-shadow: inset 0 0 0 var\(--dashboard-ask-trigger-border-width/su,
    "The return outline must not animate border widths, which move absolute children by half a pixel near the end");
  assert.match(source, /closing && headerMorph && selection.triggerIconInset[\s\S]*?DashboardAskIcon name="chatBubble" size=\{18\}/u);
  assert.match(source, /triggerIconInset: iconBounds \? `\$\{iconBounds.left - bounds.left\}px` : null/u);
  assert.match(css, /\.dashboard-ask-return-icon \{[^}]*left: var\(--dashboard-ask-trigger-icon-inset,[^}]*animation: dashboard-ask-header-label-in/su);
  assert.match(css, /@keyframes dashboard-ask-header-return-anchor \{[^}]*from \{ transform: translate\(var\(--dashboard-ask-header-correction-x,[^}]*\}[^}]*to \{ transform: translate\(0, 0\);/su,
    "A viewport-clamped composer returns to the actual compact button instead of retaining its open offset");
  assert.match(source, /function finishClosing\(event\) \{[^}]*event.target !== event.currentTarget[^}]*flushSync\(completeClose\)/su,
    "Only the shell animation completes the close, with trigger restoration and portal removal in one commit");
});

test("the dashboard Ask composer keeps the approved suggestions and direct actions", async () => {
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const dashboardAsk = await readFile(new URL("../src/components/DashboardAsk.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const overflowStart = chrome.indexOf("function DataAppOverflowMenu");
  const detailsStart = chrome.indexOf("const promptActionDetails");
  const suggestionsStart = chrome.indexOf("function dataAppAskSuggestions");
  const suggestionsEnd = chrome.indexOf("export function DataAppTopbar", suggestionsStart);
  const overflow = chrome.slice(overflowStart, detailsStart);
  const details = chrome.slice(detailsStart, suggestionsStart);
  const suggestions = chrome.slice(suggestionsStart, suggestionsEnd);
  assert.ok(suggestions.includes('label: surface === "report" ? "Change this report" : "Change this dashboard"'),
    "The edit suggestion names the actual artifact, including reports");
  assert.ok(suggestions.includes('subtext: "Tell ChatGPT what to change"'),
    "The edit suggestion explains that this starts a request to ChatGPT");
  assert.match(dashboardAsk, /<div className="dashboard-ask-zero-state" role="group" aria-label="Suggested actions">\s*<h3 className="dashboard-ask-zero-state-heading">Suggestions<\/h3>\s*\{selection.suggestions.map/u,
    "The suggestion group starts with a visible, noninteractive heading");
  assert.match(styles, /\.dashboard-ask-zero-state-heading \{[^}]*margin: 0;[^}]*color: var\(--secondary\);[^}]*font-size: 12px;[^}]*font-weight: 500;/su,
    "Suggestions uses a quiet label treatment without adding another action row");

  assert.doesNotMatch(
    suggestions,
    /<Dropdown\.(?:Group|Label)\b/u,
    "The zero state must not keep the old section headers",
  );
  assert.doesNotMatch(
    styles,
    /dashboard-figma-menu-(?:group|label)/u,
    "Removed menu headers must not leave stale spacing styles behind",
  );
  assertInOrder(
    details,
    ["Share key insights", "Create a change alert", "Create a report"],
    "The prompt rows do not match the approved order",
  );
  assertInOrder(
    details,
    ["Choose where to share a summary", "Choose what triggers an alert", "Turn these findings into a report"],
    "The prompt rows do not match the approved explanations",
  );
  assertInOrder(
    suggestions,
    [
      "Object.entries(promptActionDetails)",
      "Change this dashboard",
    ],
    "The Ask zero state keeps the owner change request and prompt actions together",
  );
  assert.doesNotMatch(suggestions, /(?:Customize|Edit) theme|Convert to\.\.\.|hasUtilityActions|<MenuSeparator \/>/u);
  assertInOrder(
    overflow,
    [
      "Copy link",
      "Create a copy",
      "Restore hidden ({hiddenCount})",
      "{hasActions && hasPreferences && <MenuSeparator />}",
      "Switch theme",
      "<DataAppHandoffMenu",
      "{(hasActions || hasPreferences) && <MenuSeparator />}",
      '<MenuGroup label="Export">',
      "<DataAppConvertItems",
    ],
    "The overflow menu groups actions, preferences, and export without removing utilities",
  );
  assert.match(
    overflow,
    /dataAppActionLink\(getActionHref, "duplicate"\)[\s\S]*?Create a copy/u,
    "The More menu owns the separate-copy action",
  );
  assert.doesNotMatch(suggestions, /Remix|action: "duplicate"/u);
  for (const [action, label] of [
    ["share-summary", "Share key insights"],
    ["alert-changes", "Create a change alert"],
    ["create-report", "Create a report"],
  ]) {
    assert.match(
      details,
      new RegExp(
        `"${action}"\\s*:\\s*\\{[\\s\\S]{0,220}?label[:=]\\s*"${label}"[\\s\\S]{0,220}?subtext[:=]\\s*"[^"]+"[\\s\\S]{0,220}?icon[:=]\\s*"[^"]+"`,
        "u",
      ),
      `${label} must keep its reviewed action, label, explanation, and standard icon mapping`,
    );
  }
  assert.doesNotMatch(
    chrome,
    /DataAppPromptAction|dashboard-action-preview|previewSettings|onCopyPrompt|PromptActionTrailing|promptActionApps|prompt-app-/u,
    "The temporary hover preview, copy path, and app-avatar treatment must be removed",
  );
  assert.match(suggestions, /Object\.entries\(promptActionDetails\)\.map[\s\S]*?dataAppActionLink\(getActionHref, action\)/u);
  assert.match(styles, /\.dashboard-ask-zero-state > :is\(a, button\)\s*\{[^}]*min-height:\s*36px/u);
  assert.match(styles, /\.dashboard-ask-zero-state > :is\(a, button\)\.has-subtext\s*\{[^}]*min-height:\s*48px/u);
  assert.match(styles, /\.dashboard-ask-zero-state-copy\s*\{[^}]*gap:\s*2px/u);
  assert.match(
    styles,
    /\.dashboard-ask-panel\[data-phase="compose"\]\[data-source="header"\]\s*\{[^}]*background:\s*var\(--surface-raised\)[^}]*backdrop-filter:\s*none[^}]*animation:\s*none[^}]*transition:\s*none/u,
    "Opening Ask from the header must not reuse the selection composer's expansion animation",
  );
  assert.match(
    styles,
    /\.dashboard-ask-zero-state\s*\{[^}]*border-radius:\s*var\(--dashboard-ask-radius, 18px\)[^}]*background:\s*var\(--surface-raised\)[^}]*backdrop-filter:\s*none/u,
    "The detached suggestions must share the composer's opaque surface and radius",
  );
  assert.match(
    dashboardAsk,
    /HEADER_COMPOSER_WIDTH = 260[\s\S]*?HEADER_COMPOSER_HEIGHT = 36[\s\S]*?HEADER_COMPOSER_ACTIVE_HEIGHT = 68[\s\S]*?HEADER_ANCHOR_GAP = 7/u,
  );
  assert.doesNotMatch(
    dashboardAsk,
    /setComposerHeight\(active \? HEADER_COMPOSER_ACTIVE_HEIGHT : HEADER_COMPOSER_HEIGHT\)/u,
    "The header composer must use the shared textarea measurement instead of a fixed typed height",
  );
  assert.match(styles, /\.dashboard-ask-compose\[data-source="header"\]\s*\{[^}]*padding:\s*0 6px 0 12px/u);
  assert.match(
    styles,
    /\.dashboard-ask-compose\[data-source="header"\] textarea\s*\{[^}]*padding-top:\s*8px/u,
  );
  assert.match(
    styles,
    /\[data-composer-expanded="true"\][\s\S]*?\.dashboard-ask-compose\s*\{[^}]*padding-bottom:\s*6px[\s\S]*?textarea\s*\{[^}]*padding-top:\s*12px/u,
  );
  assert.doesNotMatch(
    styles,
    /Start in ChatGPT|\.dashboard-prompt-action-item \.menu-item-subtext/u,
    "Prompt rows must keep their descriptive subtext unchanged on hover",
  );
  assert.doesNotMatch(
    styles,
    /dashboard-prompt-action-(?:apps|app|arrow|trailing)/u,
    "The removed app-avatar treatment must not leave stale layout styles behind",
  );

});

test("selection Ask covers whole chart sections and stays anchored while scrolling", async () => {
  const frame = await readFile(new URL("../src/charting/ChartFrame.jsx", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/charting/ChartRenderer.jsx", import.meta.url), "utf8");
  const dashboardAsk = await readFile(new URL("../src/components/DashboardAsk.jsx", import.meta.url), "utf8");

  assert.match(frame, /onClick=\{onChartClick\}/u);
  assert.match(renderer, /selectChartSection\(/u);
  assert.match(dashboardAsk, /function chartSectionSource\(target\)/u);
  assert.match(
    dashboardAsk,
    /const top = source === "header" && !headerMorph[\s\S]*?: baseTop;/u,
    "Selection composers must move with their chart instead of being clamped to the viewport",
  );
});

test("create-report starts a separate private report from authorized reviewed evidence", () => {
  for (const surface of ["dashboard", "report"]) {
    for (const canEdit of [true, false]) {
      const request = dataAppActionRequest("create-report", { ...followUpContext(surface), canEdit });
      assert.equal(request.title, "Create a report");
      assert.ok(request.prompt.includes(`from the reviewed findings in this exact ${surface}`));
      for (const requirement of [
        /invoke \$build-report/u,
        /new, separate report/u,
        /verify my access/u,
        /current filters, metric definitions, time windows, and source provenance/u,
        /coherent narrative/u,
        /missing values, and any synthetic-data labels/u,
        /new report project with a fresh stable artifact ID/u,
        /private and editable/u,
        /Never modify or overwrite the original Data app or an existing document/u,
        /Do not query new data, refresh the source, publish, send, or change access unless I explicitly ask/u,
        /instead of inventing findings or substituting other data/u,
        /verified report preview/u,
      ]) assert.match(request.prompt, requirement);
      assert.match(request.prompt, /"segment": "Enterprise"/u);
      assert.doesNotMatch(request.prompt,
        /PRIVATE_REVIEWED_ROW|PRIVATE_REVIEWED_QUERY|PRIVATE_PRESENTATION_ROW|PRIVATE_PRESENTATION_QUERY|PRIVATE_PASSWORD|PRIVATE_AUTHORIZATION_TOKEN/u);
    }
  }
});

test("refresh-document keeps private evidence out of its confirmation-first handoff", () => {
  const request = dataAppActionRequest("refresh-document", followUpContext());

  assert.equal(request.title, "Refresh a doc with the latest");
  assert.match(request.prompt, /choose the exact (?:existing )?document/iu);
  assert.match(request.prompt, /read (?:it|the document) first/iu);
  assert.match(request.prompt, /summar(?:ize|ise) the (?:planned|proposed) edits/iu);
  assert.match(request.prompt, /wait for (?:my|the user's) confirmation/iu);
  assert.match(request.prompt, /update only that document in place/iu);
  for (const boundary of ["unrelated content", "comments", "ownership", "sharing"]) {
    assert.match(request.prompt, new RegExp(boundary, "iu"));
  }
  assert.match(request.prompt, /read (?:it|the updated document) back/iu);
  assert.match(request.prompt, /return (?:its|the) link/iu);
  assert.match(
    request.prompt,
    /"segment": "Enterprise"/u,
    "The handoff should retain safe current presentation context",
  );
  assert.doesNotMatch(
    request.prompt,
    /PRIVATE_REVIEWED_ROW|PRIVATE_REVIEWED_QUERY|PRIVATE_PRESENTATION_ROW|PRIVATE_PRESENTATION_QUERY|PRIVATE_PASSWORD|PRIVATE_AUTHORIZATION_TOKEN/u,
  );
});

test("alert-changes keeps private evidence out of its confirmation-first automation handoff", () => {
  const request = dataAppActionRequest("alert-changes", followUpContext());

  assert.equal(request.title, "Alert me when things change");
  for (const requirement of [
    /condition|threshold/iu,
    /baseline|window/iu,
    /cadence|local time/iu,
    /notification method/iu,
    /(?:full|complete proposed) rule/iu,
    /wait for (?:my|the user's) confirmation/iu,
    /automation_update/u,
    /(?:exact (?:Data app )?identity|Data app's exact identity)/iu,
    /latest authorized values/iu,
    /do not run|do not send/iu,
  ])
    assert.match(request.prompt, requirement);
  assert.match(
    request.prompt,
    /"usage_summary"/u,
    "The alert setup should identify reviewed queries without embedding their data",
  );
  assert.match(
    request.prompt,
    /"segment": "Enterprise"/u,
    "The handoff should retain safe current presentation context",
  );
  assert.doesNotMatch(
    request.prompt,
    /PRIVATE_REVIEWED_ROW|PRIVATE_REVIEWED_QUERY|PRIVATE_PRESENTATION_ROW|PRIVATE_PRESENTATION_QUERY|PRIVATE_PASSWORD|PRIVATE_AUTHORIZATION_TOKEN/u,
  );
});
