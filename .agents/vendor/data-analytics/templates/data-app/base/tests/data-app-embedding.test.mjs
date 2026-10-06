import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [renderer, inspector, styles, publicApi, shell] = await Promise.all([
  read("../src/charting/ChartRenderer.jsx"),
  read("../src/components/SourceInspector.jsx"),
  read("../src/styles.css"),
  read("../src/data-app-public.jsx"),
  read("../src/DataAppShell.jsx"),
]);

test("chart geometry defaults to the document and accepts an embedding theme root", () => {
  assert.match(renderer, /<StandardChartRenderer \{\.\.\.props\}/u);
  assert.match(renderer, /function StandardChartRenderer\(\{[^}]*\bthemeRoot\b/u);
  // Exercise the actual dependency-free geometry block without loading JSX or a browser.
  const start = renderer.indexOf("  const themeElement =");
  const end = renderer.indexOf("\n  const markCorners =", start);
  assert.ok(start >= 0 && end > start);
  const geometry = `${renderer.slice(start, end)}\nresult = markRadius;`;
  const resolve = (context) => {
    const sandbox = { themeRoot: undefined, spec: {}, ...context };
    runInNewContext(geometry, sandbox);
    return sandbox.result;
  };
  const documentRoot = {};
  assert.equal(
    resolve({
      document: { documentElement: documentRoot },
      getComputedStyle(element) {
        assert.equal(element, documentRoot);
        return { getPropertyValue: (name) => (name === "--mark-radius" ? "8" : "") };
      },
    }),
    8,
  );

  const view = {
    getComputedStyle(element) {
      assert.equal(this, view);
      assert.equal(element, embeddingRoot);
      return { getPropertyValue: (name) => (name === "--mark-radius" ? "3.5" : "") };
    },
  };
  const embeddingRoot = { ownerDocument: { defaultView: view } };
  const forbiddenDocumentRead = () => assert.fail("Embedding geometry must not read global theme tokens");
  assert.equal(resolve({ themeRoot: embeddingRoot, getComputedStyle: forbiddenDocumentRead }), 3.5);
  assert.equal(resolve({ themeRoot: { host: embeddingRoot }, getComputedStyle: forbiddenDocumentRead }), 3.5);
  assert.equal(resolve({ spec: { markRadius: 7 } }), 7, "An explicit chart radius overrides the theme default");
  assert.equal(resolve({}), 0, "Server rendering still has zero-radius geometry");
  assert.doesNotMatch(renderer, /document\.documentElement\.style\.(?:setProperty|removeProperty)/u);
});

test("source copying is an opt-out capability and the canonical inspector is shared", () => {
  assert.match(inspector, /export function SourceInspector\(\{[^}]*allowCopy = true/u);
  assert.match(inspector, /if \(!allowCopy \|\| !sql\) return;/u);
  assert.match(inspector, /allowCopy && sql &&\s*\(?\s*<button[^>]*className="sql-copy-button"/u);
  assert.match(inspector, /writeText\(sql\)/u, "Copy still uses the exact reviewed SQL");
  assert.match(inspector, /export function SourceSidebar\(\{[^}]*allowCopy = true/u);
  assert.match(inspector, /<SourceInspector component=\{selectedComponent\} \{\.\.\.source\} allowCopy=\{allowCopy\}/u);
  assert.equal((inspector.match(/<SourceInspector\b/gu) ?? []).length, 1);
});

test("contained source drawers opt into local layout and focus without changing viewport defaults", () => {
  assert.match(inspector, /variant = "viewport"/u);
  assert.match(inspector, /variant === "contained" \? " source-sidebar-layer--contained" : ""/u);
  assert.match(inspector, /variant === "contained" \? headingRef\.current\?\.getRootNode\(\) : ownerDocument/u);
  assert.match(inspector, /previousFocus\?\.shadowRoot\?\.activeElement/u);
  assert.match(inspector, /previousFocus\?\.isConnected\) previousFocus\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(inspector, /variant === "contained" \? layerRef\.current : window/u);
  assert.match(inspector, /event\.key !== "Escape" \|\| event\.defaultPrevented/u);
  assert.match(inspector, /event\.stopPropagation\(\)/u);
  assert.match(inspector, /ready \? getSource\(selectedQueryId\) : null/u);
  assert.match(inspector, /setTimeout\(onClose, 140\)/u);
  const sidebarProps = shell.match(/<SourceSidebar\b([\s\S]*?)\/>/u)?.[1];
  assert.ok(sidebarProps, "The durable shell must retain the canonical source sidebar");
  assert.match(sidebarProps, /\bkey=\{component\.id\}/u);
  assert.match(sidebarProps, /\bcomponent=\{component\}/u);
  assert.doesNotMatch(sidebarProps, /\bvariant="contained"/u);

  const viewport = styles.match(/\.source-sidebar \{([^}]+)\}/u)?.[1];
  assert.match(viewport, /position: fixed/u);
  assert.match(viewport, /width: min\(520px, 100vw\)/u);
  assert.match(viewport, /height: 100dvh/u);
  const contained = styles.match(/\.source-sidebar-layer--contained \{([^}]+)\}/u)?.[1];
  assert.match(contained, /display: grid/u);
  assert.match(contained, /grid-area: 1 \/ 1/u);
  assert.match(contained, /container-type: inline-size/u);
  const panel = styles.match(/\.source-sidebar-layer--contained > \.source-sidebar \{([^}]+)\}/u)?.[1];
  assert.match(panel, /position: relative/u);
  assert.match(panel, /width: min\(520px, 100%\)/u);
  assert.match(panel, /height: auto/u);
  assert.doesNotMatch(panel, /100(?:d?v[wh])|position: fixed|overflow: auto/u);
  assert.match(styles, /\.source-sidebar-body \{[^}]*overflow: auto/u);
  assert.match(styles, /\.source-sidebar-layer--contained \.source-sidebar-body \{[^}]*overflow: visible/u);
  assert.match(
    styles,
    /@container \(max-width: 520px\) \{\s*\.source-sidebar-layer--contained > \.source-sidebar \{\s*width: 100%/u,
  );
});

test("embeddings import the canonical source inspector, semantic colors, and icon", () => {
  assert.match(publicApi, /\bsemanticColorResolver\b[^}]*\} from "\.\/charting\/chart-theme\.js"/u);
  assert.match(publicApi, /export \{ SourceInspector, SourceSidebar \} from "\.\/components\/SourceInspector\.jsx"/u);
  assert.match(publicApi, /export \{ Icon \} from "\.\/components\/Icon\.jsx"/u);
});
