import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import { publishReviewDestination } from "../src/publish-review.js";
import { dataAppActionHref, dataAppActionRequest } from "../src/data-app-actions.js";

test("review destination names come from the actual supported route", () => {
  assert.equal(publishReviewDestination("codex://threads/new?prompt=review"), "Codex");
  assert.equal(publishReviewDestination("https://chatgpt.com/?q=review"), "ChatGPT");
  for (const value of [null, "", "not-a-url", "javascript:alert(1)", "https://chatgpt.com.evil.test/", "https://other.example/"]) {
    assert.equal(publishReviewDestination(value), null);
  }
});

test("publication hands off the selected audience and exact artifact to Sites", () => {
  for (const surface of ["dashboard", "report"]) for (const accessMode of [undefined, "custom", "workspace_all"]) {
    const context = { surface, accessMode, canEdit: true,
      title: "Quarterly decisions",
      snapshot: { id: "quarterly-decisions", generatedAt: "2026-08-31T12:00:00Z" },
      viewUrl: "https://app.example.chatgpt.site/?view=1&tab=dashboard",
      dataAppReference: { sourceUrl: "https://app.example.chatgpt.site/?token=secret#private" } };
    const { title, prompt } = dataAppActionRequest("sites", context);
    assert.equal(title, `Publish ${surface} to Sites`);
    assert.match(prompt, /\[@Sites\]\(plugin:\/\/sites@openai-curated-remote\)/u);
    assert.match(prompt, new RegExp(`publish this ${surface}`, "u"));
    if (accessMode === "workspace_all") assert.match(prompt, /workspace members with the link/u);
    else if (accessMode === "custom") assert.match(prompt, /access limited to me until I invite others/u);
    else assert.match(prompt, /Keep the existing Site access settings/u);
    assert.match(prompt, /Quarterly decisions/u);
    assert.match(prompt, /\$publish-artifact-to-sites/u);
    assert.match(prompt, /read its current Data app context/u);
    assert.doesNotMatch(prompt, /Data app ID:|2026-08-31T12:00:00Z|Current presentation/u);
    assert.match(prompt, /https:\/\/app\.example\.chatgpt\.site\//u);
    assert.doesNotMatch(prompt, /token=secret|#private/u);
    assert.doesNotMatch(prompt, /read-only and does not authorize|confirmation before publishing|Unknown schedule state|permissions remain unresolved/u);
    const link = new URL(dataAppActionHref("sites", context, new URL("https://app.example.chatgpt.site/")));
    assert.equal(link.searchParams.get("q"), prompt);
    assert.equal(link.searchParams.has("originUrl"), false);
  }
});

test("review renders requested audience separately from unknown live settings and preserves surface capabilities", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const { PublishReviewContent } = await server.ssrLoadModule("/src/components/PublishReviewDialog.jsx");
    for (const published of [false, true]) for (const surface of ["dashboard", "report"]) {
      const markup = renderToStaticMarkup(React.createElement(PublishReviewContent, {
        published, surface, accessMode: "custom", onAccessChange() {}, onClose() {}, href: "codex://threads/new?prompt=review",
      }));
      assert.equal((markup.match(/type="radio"/gu) ?? []).length, published ? 0 : 2);
      assert.equal((markup.match(/checked=""/gu) ?? []).length, published ? 0 : 1);
      assert.equal(markup.includes("Keep current access"), published);
      const permissions = markup.match(/<div class="publish-review-permissions">([\s\S]*?)<\/div>/u)?.[1];
      assert.ok(permissions);
      assert.deepEqual([...permissions.matchAll(/<li>(.*?)<\/li>/gu)].map(([, text]) => text.replaceAll("&#x27;", "'")), [
        "Only data published in the dashboard is visible and accessible to viewers",
        "Source data isn't accessible beyond what is presented by the Editors of the dashboard",
        "Editors can set up an automation to update the dashboard and site. Viewers iterating on it require their own permissions to access source data",
      ]);
      assert.doesNotMatch(permissions, /<p(?:\s|>)/u);
      assert.doesNotMatch(markup, /<details|<summary|One check before publishing|What data is included/u);
      assert.doesNotMatch(markup, /No schedule|Refresh is off|Permissions verified/u);
      assert.match(markup, /href="codex:\/\/threads\/new\?prompt=review" target="_self"/u);
    }
    const unavailable = renderToStaticMarkup(React.createElement(PublishReviewContent, { onClose() {} }));
    assert.doesNotMatch(unavailable, /<a /u);
    assert.match(unavailable, /disabled=""/u);
  } finally { await server.close(); }
});
