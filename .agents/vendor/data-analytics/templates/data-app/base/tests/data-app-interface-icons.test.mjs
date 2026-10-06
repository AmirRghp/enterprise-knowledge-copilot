import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

test("Data app interface icons use bundled OpenAI assets at standard dropdown sizes", async () => {
  const icon = await readFile(new URL("../src/components/Icon.jsx", import.meta.url), "utf8");
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const ui = await readFile(new URL("../src/components/ui.jsx", import.meta.url), "utf8");
  const menuIconNames = [
    ...new Set([...chrome.matchAll(/<(?:MenuItem|MenuSub)\b[^>]*\bicon="([^"]+)"/gu)].map(([, name]) => name)),
  ];
  for (const name of new Set([
    "download", "edit", "eye", "more", "sun", "moon", "monitor", "chatgpt", "chatBubble", "theme", ...menuIconNames,
  ])) {
    const svg = await readFile(new URL(`../src/components/icons/dashboard-icon-${name}.svg`, import.meta.url), "utf8");
    assert.match(svg, /^<svg\b/u, `${name} must use a committed official OpenAI icon asset`);
  }
  for (const name of ["jupyter", "pdf", "word", "powerpoint", "google-docs", "google-slides"]) {
    const svg = await readFile(new URL(`../src/components/icons/convert-icon-${name}.svg`, import.meta.url), "utf8");
    assert.match(svg, /^<svg\b/u, `${name} conversion must use its committed format icon`);
  }
  assert.match(
    icon,
    /import\.meta\.glob\("\.\/icons\/dashboard-icon-\*\.svg"/u,
    "OpenAI, third-party, and custom icon assets added during generation must be discovered automatically",
  );
  assert.match(icon, /query:\s*"\?url"/u, "Dynamically discovered icons must be bundled into portable dashboards");
  assert.match(icon, /throw new Error\(`Unknown dashboard icon:/u);
  const componentDirectory = new URL("../src/components/", import.meta.url);
  for (const name of await readdir(componentDirectory)) {
    if (!name.endsWith(".jsx")) continue;
    // This is a resizable card background, not an interface icon.
    if (name === "SmoothCardSurface.jsx") continue;
    const component = await readFile(new URL(name, componentDirectory), "utf8");
    assert.doesNotMatch(
      component,
      /<(?:svg|path)\b/u,
      `${name} must use the shared official OpenAI icon registry instead of handwritten interface SVG`,
    );
  }
  for (const name of ["edit", "more"]) {
    assert.match(
      chrome,
      new RegExp(`<Icon name="${name}" size=\\{18\\}`, "u"),
      `The top-bar ${name} icon must use the shared 18px square frame`,
    );
  }
  assert.match(ui, /export function MenuItem[\s\S]*?icon && <Icon name=\{icon\} \/>/u);
  assert.match(ui, /export function MenuSub[\s\S]*?icon && <Icon name=\{icon\} \/>/u);
  assert.match(
    chrome,
    /<HeaderActionButton[\s\S]*?label=\{mode === "edit" \? "Cancel" : "Ask ChatGPT"\}[\s\S]*?className="dashboard-ask-button"[\s\S]*?onClick=\{mode === "edit" \? onCancel : \(\) => openAskComposer\(\)\}/u,
  );
  const headerButton = chrome.match(/const HeaderActionButton[\s\S]*?^\}\);/mu)?.[0] ?? "";
  assert.doesNotMatch(headerButton, /<Icon name="(?:chatgpt|workflows)"/u);
  assert.doesNotMatch(headerButton, /chevronDown/u);
  assert.doesNotMatch(headerButton, /<Icon name="more"/u);
  assert.match(
    styles,
    /\.dashboard-convert-icon\s*\{[^}]*width:\s*16px[^}]*height:\s*16px[^}]*flex:\s*0\s+0\s+16px/su,
  );
  assert.doesNotMatch(styles, /dashboard-header-action-more/u);
  const overflowButton = chrome.match(/const HeaderOverflowButton[\s\S]*?^\}\);/mu)?.[0] ?? "";
  assert.match(overflowButton, /aria-label="More"/u);
  assert.match(overflowButton, /<Icon name="more" size=\{18\} \/>/u);
  assert.doesNotMatch(overflowButton, /dashboard-header-action-label|chevronDown/u);
  assert.match(styles, /\.dashboard-header-overflow-button\s*\{[^}]*width:\s*32px[^}]*padding:\s*0/su);
  assert.doesNotMatch(styles, /\.chevron\s*\{[^}]*margin-left:/su);
  assert.match(
    styles,
    /\.dashboard-icon\s*\{[^}]*background:\s*currentColor[^}]*mask:\s*var\(--dashboard-icon-mask\)/su,
  );
});

test("direct Ask SVG assets exclude active or external content", async () => {
  for (const name of ["edit", "summaryBubble", "textDocument", "alertBell", "chatBubble"]) {
    const asset = await readFile(new URL(`../src/components/icons/dashboard-icon-${name}.svg`, import.meta.url), "utf8");
    assert.doesNotMatch(asset, /<script|<foreignObject|<image|\bon\w+\s*=|href=/iu);
  }
});
