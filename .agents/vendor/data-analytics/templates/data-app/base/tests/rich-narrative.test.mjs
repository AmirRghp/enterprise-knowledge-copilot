import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shared Lexical narratives expose a protected safe selection-formatting toolbar", async () => {
  const [editor, toolbar, dashboard, report, styles, reportStyles, publicApi, manifest] = await Promise.all([
    readFile(new URL("../src/components/RichMarkdown.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/RichTextFormatToolbar.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/dashboard/DashboardContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/content/report/ReportContent.jsx", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/content/report/report.css", import.meta.url), "utf8"),
    readFile(new URL("../src/data-app-public.jsx", import.meta.url), "utf8"),
    readFile(new URL("../protected-runtime.json", import.meta.url), "utf8"),
  ]);

  assert.match(editor, /<RichTextFormatToolbar\s*\/>/u);
  assert.match(editor, /BOLD_ITALIC_STAR[\s\S]*ITALIC_STAR/u);
  assert.match(publicApi, /export \{ RichNarrative \}/u);
  assert.match(dashboard, /<RichNarrative id="forecast-outlook:description"/u);
  for (const id of [
    "report:description", "report-summary:body",
    "report-trend:interpretation", "report-methods:body", "report:disclosure",
  ]) {
    assert.match(report, new RegExp(`<RichNarrative id="${id}"`, "u"),
      `Report prose ${id} must mount the shared rich-text toolbar`);
  }

  for (const command of [
    "FORMAT_TEXT_COMMAND",
    "INSERT_ORDERED_LIST_COMMAND",
    "INSERT_UNORDERED_LIST_COMMAND",
    "INSERT_CHECK_LIST_COMMAND",
    "TOGGLE_LINK_COMMAND",
  ]) {
    assert.match(toolbar, new RegExp(command, "u"));
  }

  assert.match(toolbar, /\["http:", "https:"\]\.includes\(url\.protocol\)/u);
  assert.doesNotMatch(toolbar, /value:\s*"h1"|prosemirror|tiptap/iu);
  assert.match(styles, /\.data-app-format-toolbar\s*\{[^}]*height:\s*36px/su);
  assert.match(styles, /--data-app-format-shadow:\s*0 8px 12px 0 rgb\(0 0 0 \/ 16%\)/u);
  assert.match(styles, /\.data-app-format-heading-1\s*\{[^}]*font-size:\s*var\(--text-md-size\)[^}]*font-weight:\s*600/su);
  assert.doesNotMatch(toolbar, /label:\s*"Heading [23]"/u);
  assert.match(reportStyles, /\.report-hero h1\s*\{[^}]*font-size:\s*44px[^}]*line-height:\s*1\.1;[^}]*font-weight:\s*600/su);
  assert.match(reportStyles, /@media \(max-width:\s*640px\)[\s\S]*?\.report-hero h1\s*\{[^}]*font-size:\s*32px[^}]*line-height:\s*1\.12;[^}]*font-weight:\s*600/su);
  assert.match(reportStyles, /\.report-page \.rich-narrative :is\(strong, b, \.markdown-bold\)\s*\{\s*font-weight:\s*600/su);
  assert.match(reportStyles, /\.report-page :is\(\.rich-narrative-content, \.report-rich-editable\) h2,[\s\S]*?font-size:\s*20px;[\s\S]*?line-height:\s*28px/su);
  assert.match(reportStyles, /li \+ li\s*\{\s*margin-top:\s*8px/su);
  assert.match(editor, /authoredMarkdown\.replace\(\/\\\\r\\\\n\|\\\\n\/g, "\\n"\)/u);
  assert.match(reportStyles, /--data-app-report-body-text:\s*color-mix\(in srgb, var\(--text\) 50%, var\(--secondary\)\)/u);
  assert.match(reportStyles, /\.report-page :is\(\.rich-narrative-content, \.report-rich-editable\)\s*\{\s*color:\s*var\(--data-app-report-body-text\)/u);
  assert.match(reportStyles, /\.report-hero h1\s*\{\s*margin:\s*0;/u);
  assert.match(reportStyles, /\.report-page :is\(\.rich-narrative-content, \.report-rich-editable\) :is\(h1, h2, h3, h4, h5, h6\)\s*\{\s*color:\s*var\(--text\)/u);
  assert.match(toolbar, /Type or paste a link/u);
  assert.match(editor, /CHECK_LIST/u);
  assert.match(editor, /<CheckListPlugin\s*\/>/u);
  assert.deepEqual(
    [...toolbar.matchAll(/value:\s*"(?:paragraph|h2|number|bullet|check)",\s*label:\s*"([^"]+)"/gu)]
      .map((match) => match[1]),
    ["Heading", "Text", "Numbered list", "Bulleted list", "Checklist"],
    "Text styles must expose one heading while preserving a single report H1 landmark",
  );

  const files = JSON.parse(manifest).files;
  for (const path of [
    "src/components/RichTextFormatToolbar.jsx",
    "src/components/icons/dashboard-icon-bold.svg",
    "src/components/icons/dashboard-icon-italic.svg",
  ]) {
    assert.ok(files[path], `${path} must remain protected infrastructure`);
  }
});
