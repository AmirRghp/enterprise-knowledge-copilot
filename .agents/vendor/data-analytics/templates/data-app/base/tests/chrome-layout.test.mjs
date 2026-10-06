import { stickyFilterState } from "../src/chrome-layout.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

import { dataAppChromeLayout } from "../src/chrome-layout.js";

test("dashboard and report previews show progress only while app work is active", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const { DataAppRuntime } = await server.ssrLoadModule("/src/DataAppRuntime.jsx");
    const Content = () => React.createElement("article", null, "Reviewed inventory");
    for (const surface of ["dashboard", "report"]) {
      const snapshot = { id: `progress-${surface}`, surface, title: "Inventory review", status: "draft", queries: {}, filters: [] };
      for (const buildStatus of ["creating", "updating", "in-progress", "complete", "paused", undefined]) {
        const html = renderToStaticMarkup(React.createElement(DataAppRuntime, {
          reviewedSnapshot: { ...snapshot, buildStatus }, hosted: false,
          DashboardContent: Content, ReportContent: Content,
        }));
        assert.equal(/dashboard-authoring-status/u.test(html),
          ["creating", "updating", "in-progress", "paused"].includes(buildStatus), `${surface}/${buildStatus}: progress follows the app lifecycle, not evidence status`);
        const publish = html.match(/<button\b[^>]*aria-label="Publish"[^>]*>/u)?.[0];
        assert.ok(publish, "Draft previews retain their Publish button");
        assert.equal(publish.includes('disabled=""'), ["creating", "updating", "in-progress", "paused"].includes(buildStatus),
          `${surface}/${buildStatus}: publishing is disabled while app work is unfinished`);
        assert.match(html, /Reviewed inventory/u, "Partial content remains available while work continues");
      }
    }
  } finally { await server.close(); }
});

test("unidentified previews mount without constructing automation requests and omit unavailable suggestions", async () => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, watch: null, hmr: false }, appType: "custom" });
  try {
    const { DataAppTopbar, dataAppAskSuggestions } = await server.ssrLoadModule("/src/components/DataAppChrome.jsx");
    const requests = [];
    const getActionHref = action => {
        requests.push(action);
        if (["schedule-refresh", "alert-changes"].includes(action)) throw new Error("Data app automation requires its exact project path, HTML file, or published URL.");
        return "https://chatgpt.com/";
    };
    const html = renderToStaticMarkup(React.createElement(DataAppTopbar, {
      title: "Preview", mode: "view", generatedAt: "2026-08-24T12:00:00Z", getActionHref,
    }));
    assert.match(html, /Refresh data/);
    assert.ok(!requests.includes("schedule-refresh"));
    assert.ok(!requests.includes("alert-changes"));
    for (const surface of ["dashboard", "report"]) for (const state of [
      { canEdit: false, published: false, mode: "view" },
      { canEdit: false, published: true, mode: "view" },
      { canEdit: true, published: false, mode: "view" },
      { canEdit: true, published: true, mode: "view" },
      { canEdit: true, published: true, mode: "edit", saveStatus: "saving" },
      { canEdit: true, published: false, mode: "edit", saveStatus: "error" },
    ]) {
      requests.length = 0;
      const markup = renderToStaticMarkup(React.createElement(DataAppTopbar, {
        ...state, surface, title: "A long analytical artifact title", getActionHref,
        editHistory: { canUndo: true, canRedo: false, undo() {}, redo() {} },
      }));
      assert.equal((markup.match(/aria-label="Cancel"/gu) ?? []).length, state.mode === "edit" ? 1 : 0);
      assert.equal((markup.match(/data-mode-action="secondary"/gu) ?? []).length, 1,
        "A single secondary button handles the current mode");
      if (state.mode === "edit") assert.match(markup, /aria-label="Save"/u);
      assert.equal((markup.match(/aria-label="Ask ChatGPT"/gu) ?? []).length, state.mode === "edit" ? 0 : 2,
        `${surface}/${state.mode}: Ask is available in pointer and native touch menus outside editing`);
      const moreContents = markup.match(/<button\b[^>]*aria-label="More"[^>]*>([\s\S]*?)<\/button>/u)?.[1];
      if (state.mode === "view") {
        assert.equal((markup.match(/aria-label="Publish(?: changes)?"/gu) ?? []).length, state.published ? 0 : 2,
          `${surface}: Publish is available only before hosting, independently of inline editing permissions`);
        assert.ok(moreContents, `${surface}: More must remain available`);
        assert.match(moreContents, /data-dashboard-icon="more"/u);
        assert.match(moreContents, /width:18px;height:18px/u, "Figma uses an 18px instance, not the icon asset nominal size");
        if (state.canEdit) {
          const editContents = markup.match(/<button\b[^>]*class="[^"]*dashboard-header-edit-button[^"]*"[^>]*>([\s\S]*?)<\/button>/u)?.[1];
          assert.match(editContents, /width:18px;height:18px/u);
        }
        assert.equal(moreContents.replace(/<[^>]*>/gu, ""), "", "More remains an icon-only trigger");
        assert.equal(markup.includes('aria-label="Edit text and layout"'), state.canEdit);
        assert.ok(markup.indexOf('aria-label="More"') < markup.indexOf('aria-label="Ask ChatGPT"'));
      } else {
        assert.equal(moreContents, undefined, "View-only actions are absent while editing");
        assert.match(markup, /aria-label="Cancel"/u);
        assert.match(markup, /aria-label="Save"/u);
        assert.doesNotMatch(markup, /Publish changes|aria-label="Refresh data"/u);
      }
      assert.ok(!requests.includes("edit-in-chatgpt"), "original editing is no longer duplicated in overflow");
      if (state.mode === "edit") {
        assert.match(markup, /aria-label="Undo /u);
      }
    }
    for (const canEdit of [true, false]) {
      const list = dataAppAskSuggestions({ canEdit, surface: "dashboard", getActionHref: () => "https://chatgpt.com/" });
      assert.deepEqual(list.map(item => item.action), [
        "share-summary", "alert-changes", "create-report", ...(canEdit ? ["edit-in-chatgpt"] : []),
      ], "Suggestions keep their priority order and original editing remains owner-only");
      assert.ok(!list.some(item => item.action === "duplicate"), "Create a copy belongs in the overflow menu");
      assert.ok(!list.some(item => item.action === "refresh-document"), "Updating an existing document is no longer a default suggestion");
      assert.equal(list.find(item => item.action === "create-report").label, "Create a report");
      assert.equal(list.find(item => item.action === "create-report").subtext, "Turn these findings into a report");
      if (canEdit) {
        assert.equal(list.at(-1).label, "Change this dashboard");
        assert.equal(list.at(-1).subtext, "Tell ChatGPT what to change");
      }
      assert.ok(!list.some(item => item.action === "copy-link" || item.action === "restore-hidden"));
    }
    assert.equal(dataAppAskSuggestions({ canEdit: true, surface: "report", getActionHref: () => "https://chatgpt.com/" }).at(-1).label,
      "Change this report");
    const suggestions = dataAppAskSuggestions({ getActionHref });
    assert.deepEqual(suggestions.map(item => item.action), ["share-summary", "create-report"],
      "Unavailable suggestions are omitted without changing the remaining priority order");
    const alert = suggestions.find(item => item.action === "alert-changes");
    assert.equal(alert, undefined);
    assert.equal(suggestions.find(item => item.action === "share-summary").href, "https://chatgpt.com/");
    const identified = dataAppAskSuggestions({ getActionHref: () => "https://chatgpt.com/?q=identified" });
    assert.equal(identified.find(item => item.action === "alert-changes").href, "https://chatgpt.com/?q=identified");
  } finally { await server.close(); }
});

test("protected chrome spans the viewport using ordinary dashboard gutters", () => {
  assert.deepEqual(dataAppChromeLayout({
    viewportWidth: 1440, paddingLeft: 40, paddingRight: 40,
  }), {
    "--data-app-safe-chrome-width": "100%",
    "--data-app-safe-chrome-margin": "0px",
    "--data-app-safe-chrome-inset-start": "40px",
    "--data-app-safe-chrome-inset-end": "40px",
  });
});

test("protected chrome keeps viewport gutters for full-bleed authored content", () => {
  const layout = dataAppChromeLayout({ viewportWidth: 1920 });
  assert.equal(layout["--data-app-safe-chrome-inset-start"], "32px");
  assert.equal(layout["--data-app-safe-chrome-inset-end"], "32px");
});

test("protected chrome remains full-width outside narrow editorial reports", () => {
  const layout = dataAppChromeLayout({
    viewportWidth: 1440, paddingLeft: 36, paddingRight: 36,
  });
  assert.equal(layout["--data-app-safe-chrome-inset-start"], "36px");
  assert.equal(layout["--data-app-safe-chrome-inset-end"], "36px");
});

test("protected chrome preserves usable actions on narrow and asymmetric layouts", () => {
  const narrow = dataAppChromeLayout({ viewportWidth: 320 });
  assert.equal(narrow["--data-app-safe-chrome-inset-start"], "16px");
  assert.equal(narrow["--data-app-safe-chrome-inset-end"], "16px");
  const asymmetric = dataAppChromeLayout({
    viewportWidth: 1440, paddingLeft: 24, paddingRight: 40,
  });
  assert.equal(asymmetric["--data-app-safe-chrome-inset-start"], "24px");
  assert.equal(asymmetric["--data-app-safe-chrome-inset-end"], "40px");
});


test("filter chrome sticks after scrolling without inheriting disappearing tabs", () => {
  const geometry = {top:88,bottom:138,headerBottom:88};
  assert.deepEqual(stickyFilterState({...geometry,scrollY:0}),{stuck:false});
  assert.deepEqual(stickyFilterState({...geometry,scrollY:20}),{stuck:true});
  assert.deepEqual(stickyFilterState({...geometry,scrollY:20,controlsHidden:true}),{stuck:true});
  assert.deepEqual(stickyFilterState({...geometry,scrollY:20,top:120}),{stuck:false});
  assert.deepEqual(stickyFilterState({...geometry,scrollY:20,bottom:80}),{stuck:false});
});
