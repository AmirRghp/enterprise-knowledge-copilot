import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

import { dataAppActionHref, dataAppActionRequest, submitDataAppAction } from "../src/data-app-actions.js";
import {
  codexDataAppActionUrl,
  currentDataAppReference,
} from "../src/runtime-environment.js";

function useBrowserUserAgent(context, userAgent) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const navigator = { userAgent };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigator });
  context.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
  return navigator;
}

test("original editing requires owner access before constructing or opening a handoff", async (t) => {
  const previousWindow = globalThis.window;
  let sends = 0;
  const location = new URL("file:///Users/example/Original/dist/index.html");
  globalThis.window = { location, openai: { sendFollowUpMessage: async () => { sends += 1; } } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  for (const surface of ["dashboard", "report"]) {
    for (const canEdit of [false, undefined, "true"]) {
      const context = { surface, canEdit, dataAppReference: currentDataAppReference(location) };
      assert.equal(dataAppActionHref("edit-in-chatgpt", context, location), null);
      assert.throws(() => dataAppActionRequest("edit-in-chatgpt", context), /Only the current Data app owner/u);
      await assert.rejects(submitDataAppAction("edit-in-chatgpt", context), /Only the current Data app owner/u);
    }
  }
  assert.equal(sends, 0);
  assert.ok(dataAppActionHref("duplicate", { surface: "dashboard", canEdit: false }, location),
    "Viewers retain their independent copy/remix flow");
});

test("owner edit handoffs preserve the original artifact reference and remain unavailable without one", () => {
  for (const surface of ["dashboard", "report"]) {
    for (const location of [
      new URL("file:///Users/example/Original/dist/index.html"),
      new URL("https://reviewed.openai.chatgpt.site/"),
    ]) {
      const href = new URL(dataAppActionHref("edit-in-chatgpt", { surface, canEdit: true }, location));
      const prompt = href.searchParams.get("prompt") ?? href.searchParams.get("q");
      assert.ok(prompt.includes(location.protocol === "file:"
        ? "/Users/example/Original/dist/index.html" : location.href));
    }
    const context = { surface, canEdit: true, dataAppReference: {} };
    assert.equal(dataAppActionHref("edit-in-chatgpt", context, new URL("about:blank")), null);
    assert.throws(() => dataAppActionRequest("edit-in-chatgpt", context), /requires the original Data app/u);
  }
});

test("report creation links preserve source identity and are unavailable without a source", () => {
  for (const location of [
    new URL("file:///Users/example/Source/dist/index.html"),
    new URL("https://reviewed.openai.chatgpt.site/"),
  ]) {
    const href = new URL(dataAppActionHref("create-report", { surface: "dashboard", canEdit: false }, location));
    const prompt = href.searchParams.get("prompt") ?? href.searchParams.get("q");
    assert.match(prompt, /\$(?:data-analytics:)?build-report\b/u);
    assert.ok(prompt.includes(location.protocol === "file:" ? "/Users/example/Source/dist/index.html" : location.href));
    assert.doesNotMatch(prompt, /update only that document in place/u);
  }
  const context = { surface: "dashboard", dataAppReference: {} };
  assert.equal(dataAppActionHref("create-report", context, new URL("about:blank")), null);
  assert.throws(() => dataAppActionRequest("create-report", context), /Creating a report requires the source Data app/u);
});

test("action handoffs retain the current hosted view for desktop and web without unrelated URL context", () => {
  const location = new URL("https://user:password@reviewed.openai.chatgpt.site/_data/charts/revenue?view=1&tab=detail&f.category=Pens&f.region=%5B%22East%22%2C%22West%22%5D&token=secret&unknown=ignored#private");
  const dataAppReference = currentDataAppReference(location);
  const expected = "https://reviewed.openai.chatgpt.site/?view=1&tab=detail&f.category=Pens&f.region=%5B%22East%22%2C%22West%22%5D";
  assert.equal(dataAppReference.sourceUrl, expected);
  const context = {
    surface: "dashboard", title: "Current selection", canEdit: true, dataAppReference,
    snapshot: { id: "dashboard:view-test", queries: { sales: { rows: [] } } },
  };
  for (const action of ["sites", "share-summary", "edit-in-chatgpt", "create-report", "alert-changes", "schedule-refresh", "refresh", "duplicate", "jupyter-notebook", "pdf", "word", "powerpoint", "google-docs", "google-slides"]) {
    for (const destination of ["desktop", "web"]) {
      const href = new URL(dataAppActionHref(action, context, location, destination));
      const prompt = href.searchParams.get(destination === "desktop" ? "prompt" : "q");
      assert.ok(prompt.includes(expected), `${action} ${destination} retains the view URL`);
      assert.doesNotMatch(prompt, /password|token=secret|unknown=ignored|#private|_data\/charts/u);
      if (destination === "desktop") assert.equal(href.searchParams.get("browserUrl"), expected);
      else assert.equal(href.searchParams.get("disable_auto_send"), "1");
    }
  }
});

test("Data apps explicitly invoke their protected artifact-sharing skill", async (context) => {
  useBrowserUserAgent(context, "CodexBrowser");
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const promptActions = chrome.match(/const promptActionDetails = \{[\s\S]*?\n\};/u)?.[0] ?? "";
  const askSuggestions =
    chrome.match(/function dataAppAskSuggestions\([\s\S]*?\n\}\n\nexport function DataAppTopbar/u)?.[0] ?? "";
  const overflowMenu =
    chrome.match(/function DataAppOverflowMenu\([\s\S]*?\n\}\n\nconst promptActionDetails/u)?.[0] ?? "";
  const convertItems =
    chrome.match(/function DataAppConvertItems\([\s\S]*?\n\}\n\nfunction DataAppPublishButton/u)?.[0] ?? "";
  const convertOptions = chrome.match(/const convertOptionGroups = \[[\s\S]*?\n\];/u)?.[0] ?? "";
  const promptActionRows = [
    ...promptActions.matchAll(/"([^"]+)": \{\s*label: "([^"]+)",\s*subtext: "([^"]+)",\s*icon: "([^"]+)"/gu),
  ].map(([, action, label, subtext, icon]) => ({ action, label, subtext, icon }));

  assert.deepEqual(
    promptActionRows.map(({ action, label }) => ({ action, label })),
    [
      { action: "share-summary", label: "Share key insights" },
      { action: "alert-changes", label: "Create a change alert" },
      { action: "create-report", label: "Create a report" },
    ],
  );
  assert.deepEqual(
    promptActionRows.map(({ action, subtext }) => ({ action, subtext })),
    [
      { action: "share-summary", subtext: "Choose where to share a summary" },
      { action: "alert-changes", subtext: "Choose what triggers an alert" },
      { action: "create-report", subtext: "Turn these findings into a report" },
    ],
  );
  for (const { icon } of promptActionRows) assert.match(icon, /^[A-Za-z][A-Za-z0-9]*$/u);
  assert.doesNotMatch(
    chrome,
    /useDialKit|data-app-topbar-actions|data-app-ask-chatgpt-action|data-app-action-previews|actionVariant|dashboard-overflow|DataAppPromptAction|dashboard-action-preview|onCopyPrompt/u,
    "The dashboard Ask composer must replace DialKit, the old experiment, overflow, and hover previews",
  );
  // Header action order and editing states are rendered in chrome-layout.test.mjs.
  assert.doesNotMatch(
    askSuggestions,
    /<Dropdown\.(?:Group|Label)\b/u,
    "The Ask zero state must not keep the removed Automate and Customize headers",
  );
  assert.match(
    askSuggestions,
    /Object\.entries\(promptActionDetails\)[\s\S]*?Change this dashboard/u,
    "The Ask zero state keeps the owner change request and prompt actions",
  );
  assert.doesNotMatch(askSuggestions, /hasUtilityActions|<MenuSeparator \/>/u);
  assert.doesNotMatch(askSuggestions, /(?:Customize|Edit) theme|Convert to\.\.\./u);
  assert.match(
    overflowMenu,
    /icon="link"[\s\S]*?Copy link[\s\S]*?Create a copy[\s\S]*?Restore hidden[\s\S]*?hasActions && hasPreferences && <MenuSeparator \/>[\s\S]*?Switch theme[\s\S]*?<DataAppHandoffMenu[\s\S]*?<MenuGroup label="Export">[\s\S]*?<DataAppConvertItems/u,
    "The overflow must keep the newer icons while restoring utility order, one divider, and the inline Export group",
  );
  assert.match(
    overflowMenu,
    /dataAppActionLink\(getActionHref, "duplicate"\)[\s\S]*?Create a copy/u,
    "Create a copy belongs in the More menu",
  );
  assert.doesNotMatch(askSuggestions, /Remix|action: "duplicate"/u);
  assert.doesNotMatch(askSuggestions, /size=\{20\}/u, "Ask suggestion icons must use the standard icon frame");
  const convertRows = [
    ...convertOptions.matchAll(/\{\s*action:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*iconSrc:\s*(\w+),?\s*\}/gu),
  ].map(([, action, label, iconSrc]) => ({ action, label, iconSrc }));
  assert.deepEqual(convertRows, [
    { action: "pdf", label: "PDF", iconSrc: "convertPdfIcon" },
    { action: "word", label: "Word document", iconSrc: "convertWordIcon" },
    { action: "powerpoint", label: "PowerPoint", iconSrc: "convertPowerpointIcon" },
    { action: "google-docs", label: "Google Docs", iconSrc: "convertGoogleDocsIcon" },
    { action: "google-slides", label: "Google Slides", iconSrc: "convertGoogleSlidesIcon" },
    { action: "jupyter-notebook", label: "Jupyter Notebook", iconSrc: "convertJupyterIcon" },
  ]);
  assert.match(
    convertItems,
    /convertOptionGroups\.flat\(\)\.map\([\s\S]*?dataAppActionLink\(getActionHref, action\)/u,
    "All export rows must stay inline and use genuine action links",
  );
  assert.doesNotMatch(convertItems, /MenuSeparator/u, "The inline Export group must not add internal dividers");
  assert.match(
    askSuggestions,
    /Object\.entries\(promptActionDetails\)\.map\([\s\S]*?\.\.\.dataAppActionLink\(getActionHref, action\)/u,
    "Prompt suggestions must keep real navigation links instead of synthetic callback clicks",
  );
  assert.match(overflowMenu, /dataAppActionLink\(getActionHref, "duplicate"\)/u);
  assert.match(chrome, /dataAppActionLink\(getActionHref, "refresh"\)/u);
  assert.match(chrome, /dataAppActionLink\(getActionHref, "schedule-refresh", \{ schedule \}\)/u);

  for (const surface of ["dashboard", "report"]) {
    const request = dataAppActionRequest("share-summary", {
      surface,
      title: "Sensitive reviewed app",
      presentation: { filters: { account: "private" } },
    });
    assert.deepEqual(request, {
      title: "Share a summary",
      prompt: `Use [@Data](plugin://data-analytics@openai-curated-remote) and invoke $share-artifact-summary to share a summary of this ${surface}.`,
    });
    assert.doesNotMatch(
      request.prompt,
      /Slack|myself|Sensitive reviewed app|private|connectors|structured|bounded lookup/u,
    );
  }

  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const location = new URL(`file:///Users/example/Dashboard/dist/index.html#codexThreadId=${threadId}`);
  const href = new URL(dataAppActionHref("share-summary", { surface: "dashboard" }, location));
  assert.equal(`${href.protocol}//${href.host}${href.pathname}`, `codex://threads/${threadId}`);
  assert.equal(
    href.searchParams.get("prompt"),
    "Use [@Data](plugin://data-analytics@openai-curated-remote) and invoke $share-artifact-summary to share a summary of this dashboard.\n\n" +
      "dashboard project directory: /Users/example/Dashboard\n" +
      "dashboard HTML file: /Users/example/Dashboard/dist/index.html",
  );
  assert.doesNotMatch(href.searchParams.get("prompt"), new RegExp(threadId, "u"));
});

test("sharing identifies the exact published or local app without exposing private context", () => {
  const published = dataAppActionRequest("share-summary", {
    surface: "report",
    title: "Sensitive reviewed app",
    presentation: { filters: { account: "private" } },
    dataAppReference: {
      sourceUrl: "https://metrics.openai.chatgpt.site/growth?view=1&tab=detail&f.category=Pens&token=secret#private",
    },
  });
  assert.equal(
    published.prompt,
    "Use [@Data](plugin://data-analytics@openai-curated-remote) and invoke $share-artifact-summary to share a summary of this report.\n\n" +
      "Published report URL: https://metrics.openai.chatgpt.site/growth?view=1&tab=detail&f.category=Pens",
  );
  assert.doesNotMatch(published.prompt, /Sensitive reviewed app|token|secret|private/u);

  const local = dataAppActionRequest("share-summary", {
    surface: "dashboard",
    dataAppReference: {
      root: "/Users/example/Dashboard",
      htmlPath: "/Users/example/Dashboard/dist/index.html",
      sourceUrl: "http://terminal.local:4173/?token=secret",
    },
  });
  assert.equal(
    local.prompt,
    "Use [@Data](plugin://data-analytics@openai-curated-remote) and invoke $share-artifact-summary to share a summary of this dashboard.\n\n" +
      "dashboard project directory: /Users/example/Dashboard\n" +
      "dashboard HTML file: /Users/example/Dashboard/dist/index.html",
  );
  assert.doesNotMatch(local.prompt, /terminal\.local|token|secret/u);

  for (const dataAppReference of [
    { sourceUrl: "https://user:password@reports.example.com/private" },
    { sourceUrl: "not a URL" },
  ]) {
    assert.deepEqual(
      dataAppActionRequest("share-summary", {
        surface: "dashboard",
        dataAppReference,
      }),
      {
        title: "Share a summary",
        prompt: "Use [@Data](plugin://data-analytics@openai-curated-remote) and invoke $share-artifact-summary to share a summary of this dashboard.",
      },
    );
  }
});

test("Data app actions identify their exact local HTML and project for ChatGPT handoffs", () => {
  const reference = currentDataAppReference({
    href: "file:///Users/example/My%20Dashboard/dist/index.html?preview=1#chart",
  });
  assert.deepEqual(reference, {
    htmlPath: "/Users/example/My Dashboard/dist/index.html",
    root: "/Users/example/My Dashboard",
    sourceUrl: "file:///Users/example/My%20Dashboard/dist/index.html",
  });
  assert.deepEqual(
    currentDataAppReference({
      href: "https://dashboard.chatgpt.site/path?token=private#title",
    }),
    {
      sourceUrl: "https://dashboard.chatgpt.site/path",
    },
  );

  const request = dataAppActionRequest("sites", {
    title: "Rollout review",
    accessMode: "custom",
    dataAppReference: reference,
  });
  assert.match(request.prompt, /Dashboard project directory: \/Users\/example\/My Dashboard/);
  assert.match(request.prompt, /Dashboard HTML file: \/Users\/example\/My Dashboard\/dist\/index\.html/);
  assert.match(request.prompt, /\[@Sites\]\(plugin:\/\/sites@openai-curated-remote\) to publish this dashboard/u);
  assert.match(request.prompt, /access limited to me until I invite others/u);
  assert.doesNotMatch(request.prompt, /stop and ask/);

  const reportRequest = dataAppActionRequest("sites", {
    surface: "report",
    title: "Executive review",
    dataAppReference: reference,
  });
  assert.match(reportRequest.prompt, /Report project directory:/);
  assert.match(reportRequest.prompt, /Report HTML file: \/Users\/example\/My Dashboard\/dist\/index\.html/u);
  assert.match(reportRequest.prompt, /\[@Sites\]\(plugin:\/\/sites@openai-curated-remote\) to publish this report/u);
});

test("local Data app actions return to their existing task without leaking its identifier", () => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const location = new URL(`file:///Users/example/Dashboard/dist/index.html#codexThreadId=${threadId}`);
  const prompt = "Refresh the dashboard & preserve the reviewed source";
  const action = codexDataAppActionUrl(prompt, location, "CodexBrowser");

  assert.equal(
    action.toString(),
    `codex://threads/${threadId}?prompt=Refresh+the+dashboard+%26+preserve+the+reviewed+source`,
  );
  assert.equal(action.searchParams.get("prompt"), prompt);
  assert.equal(action.searchParams.has("originUrl"), false);
  assert.equal(action.searchParams.has("path"), false);
  assert.equal(action.searchParams.get("prompt").includes(threadId), false);
  assert.deepEqual(currentDataAppReference(location), {
    htmlPath: "/Users/example/Dashboard/dist/index.html",
    root: "/Users/example/Dashboard",
    sourceUrl: "file:///Users/example/Dashboard/dist/index.html",
  });
});

test("hosted Data app actions recognize current and rollout Codex browser identities", (context) => {
  const navigator = useBrowserUserAgent(context, "CodexBrowser");
  const location = new URL("https://dashboard.chatgpt.site/published?token=secret#private-section");

  for (const userAgent of ["CodexBrowser/1.0", "ChatGPTBrowser/1.0"]) {
    navigator.userAgent = userAgent;
    const action = new URL(dataAppActionHref("share-summary", { surface: "dashboard" }, location));

    assert.equal(`${action.protocol}//${action.host}${action.pathname}`, "codex://new");
    assert.equal(action.searchParams.get("browserUrl"), "https://dashboard.chatgpt.site/published");
    assert.doesNotMatch(action.toString(), /secret|private-section/u);
  }
});

test("explicit action destinations carry the same view link independently of browser identity", (t) => {
  const navigator = useBrowserUserAgent(t, "CodexBrowser");
  const location = new URL("https://dashboard.chatgpt.site/published?token=private#codexThreadId=550e8400-e29b-41d4-a716-446655440000");
  const context = {
    title: "Synthetic destination selection",
    snapshot: { queries: { reviewed: { rows: [{ value: "PRIVATE_REVIEWED_ROW" }] } } },
    presentation: { filters: { segment: "Private segment" }, assumptions: { forecast: "Private assumption" } },
  };
  const web = new URL(dataAppActionHref("jupyter-notebook", context, location, "web"));
  assert.equal(`${web.origin}${web.pathname}`, "https://chatgpt.com/");
  assert.deepEqual([...web.searchParams.keys()], ["q", "disable_auto_send"]);
  assert.equal(web.searchParams.get("disable_auto_send"), "1");
  assert.match(web.searchParams.get("q"), /\$data-analytics:jupyter-notebooks/u);
  assert.doesNotMatch(web.searchParams.get("q"), /Private segment|Private assumption/u);
  assert.doesNotMatch(web.searchParams.get("q"), /PRIVATE_/u);

  navigator.userAgent = "Mozilla/5.0 Chrome/140";
  const desktop = new URL(dataAppActionHref("jupyter-notebook", context, location, "desktop"));
  assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, "codex://new");
  assert.equal(desktop.searchParams.get("browserUrl"), "https://dashboard.chatgpt.site/published");
  assert.equal(desktop.searchParams.get("prompt"), web.searchParams.get("q"));
  assert.doesNotMatch(desktop.searchParams.get("prompt"), /PRIVATE_/u);
  for (const href of [web, desktop]) {
    assert.equal(href.searchParams.has("path"), false);
    assert.doesNotMatch(href.href, /token=private|codexThreadId|550e8400/u);
  }
});

test("local action families share originating-thread and new-task routing without using the host bridge", async (t) => {
  useBrowserUserAgent(t, "Mozilla/5.0 Chrome/140");
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const reference = { root: "/Users/example/Dashboard", htmlPath: "/Users/example/Dashboard/dist/index.html" };
  const opened = [];
  let origin;
  let sends = 0;
  let prints = 0;
  const context = {
    surface: "dashboard",
    canEdit: true,
    title: "Routing dashboard",
    snapshot: { id: "routing-dashboard", generatedAt: "2026-09-01T12:00:00Z",
      queries: { reviewed: { rows: [{ marker: "PRIVATE_REVIEWED_ROW" }], source: { sql: "PRIVATE_QUERY" } } } },
    dataAppReference: reference,
    accessMode: "custom",
    schedule: { frequency: "daily", time: "09:00" },
  };
  try {
    globalThis.window = {
      print() { prints += 1; },
      openai: {
        sendFollowUpMessage() { sends += 1; return {}; },
        sendMessage() { sends += 1; return {}; },
      },
    };
    globalThis.document = {
      querySelector: () => origin ? { getAttribute: () => origin } : null,
      querySelectorAll: () => [],
      createElement() {
        return {
          setAttribute() {},
          click() { opened.push({ href: this.href, target: this.target, rel: this.rel }); },
          remove() {},
        };
      },
      body: { appendChild() {} },
    };
    for (const location of [
      new URL("file:///Users/example/Dashboard/dist/index.html"),
      new URL("http://127.0.0.1:5365/"),
    ]) for (origin of [threadId, null]) {
      globalThis.window.location = location;
      for (const action of ["share-summary", "refresh", "duplicate", "create-report", "refresh-document", "alert-changes",
        "edit-in-chatgpt", "pdf", "word", "powerpoint", "google-docs", "google-slides", "jupyter-notebook", "sites", "schedule-refresh"]) {
        const expected = dataAppActionHref(action, context, location);
        const count = opened.length;
        assert.equal(await submitDataAppAction(action, context), true, action);
        assert.equal(opened.length, count + 1, `${action} opens exactly one handoff`);
        assert.deepEqual(opened.at(-1), { href: expected, target: "_self", rel: "noopener noreferrer" });
        const href = new URL(expected);
        assert.equal(`${href.protocol}//${href.host}${href.pathname}`, origin ? `codex://threads/${origin}` : "codex://new");
        const linkedView = location.protocol !== "file:";
        assert.deepEqual([...href.searchParams.keys()], [...(origin ? ["prompt"] : ["prompt", "path"]),
          ...(linkedView ? ["browserUrl"] : [])]);
        assert.equal(href.searchParams.get("path"), origin ? null : reference.root);
        const prompt = href.searchParams.get("prompt");
        assert.deepEqual(prompt.match(/\[@[^\]]+\]\(plugin:\/\/[^)]+\)/gu), action === "schedule-refresh" ? null : action === "sites"
          ? [...(linkedView ? ["[@Data](plugin://data-analytics@openai-curated-remote)"] : []), "[@Sites](plugin://sites@openai-curated-remote)"]
          : ["[@Data](plugin://data-analytics@openai-curated-remote)"], `${action} prefills its required plugins`);
        assert.doesNotMatch(prompt, /550e8400|codexThreadId|PRIVATE_|@(?:Documents|Presentations)\b/u);
      }
    }
    assert.equal(sends, 0, "Installed host APIs must not send into a different conversation");
    assert.equal(prints, 0, "Export handoffs must not open native browser printing");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("localhost automation links require browser context and cannot send an unreadable preview to web", async (t) => {
  const previousWindow = globalThis.window;
  let sends = 0;
  const location = new URL("http://127.0.0.1:8766/");
  globalThis.window = {
    location,
    openai: { sendFollowUpMessage() { sends += 1; return {}; } },
  };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });

  for (const surface of ["dashboard", "report"]) {
    const context = { surface, title: "Local preview", snapshot: { id: "local-preview" } };
    const actions = surface === "dashboard" ? ["alert-changes", "schedule-refresh"] : ["alert-changes"];
    for (const action of actions) {
      const link = new URL(dataAppActionHref(action, context, location));
      assert.equal(link.searchParams.get("browserUrl"), location.href);
      if (!["schedule-refresh", "refresh"].includes(action)) assert.match(link.searchParams.get("prompt"), /read its current Data app context/u);
      assert.throws(() => dataAppActionHref(action, context, location, "web"), /local preview/u);
    }
    assert.ok(dataAppActionHref("share-summary", context, location), "Unrelated links remain available");
  }
  assert.equal(sends, 0, "Preparing links cannot submit the automation through a host transport");
});

test("dashboard and report chrome render on localhost without project metadata", async () => {
  const server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false,
    optimizeDeps: { noDiscovery: true, entries: [] },
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: "custom",
  });
  try {
    const { DataAppTopbar, dataAppAskSuggestions } = await server.ssrLoadModule("/src/components/DataAppChrome.jsx");
    const location = new URL("http://127.0.0.1:8766/");
    for (const surface of ["dashboard", "report"]) {
      const context = { surface, title: "Local preview" };
      const html = renderToStaticMarkup(React.createElement(DataAppTopbar, {
        ...context,
        generatedAt: "2026-08-24T12:00:00Z",
        mode: "view",
        getActionHref: (action, options) => dataAppActionHref(action, { ...context, ...options }, location),
      }));
      assert.ok(html.includes("Local preview"), "The title renders instead of a blank app");
      assert.ok(html.includes('aria-label="Ask ChatGPT"'), "The Ask control remains available");
      const getActionHref = (action, options) => dataAppActionHref(action, { ...context, ...options }, location);
      const suggestions = dataAppAskSuggestions({ ...context, getActionHref });
      assert.ok(suggestions.some(({ action, href }) => action === "share-summary" && href));
      assert.ok(suggestions.some(({ action, href }) => action === "alert-changes" && href), "Local context can be read through the desktop browser pane");
    }
  } finally {
    await server.close();
  }
});

test("automation links retain exact identity for file, identified localhost, and hosted previews", () => {
  const localReference = {
    root: "/Users/example/Dashboard",
    htmlPath: "/Users/example/Dashboard/dist/index.html",
  };
  for (const [location, dataAppReference, expectedIdentity] of [
    [new URL("file:///Users/example/Dashboard/dist/index.html"), undefined, localReference.htmlPath],
    [new URL("http://localhost:5173/"), localReference, "http://localhost:5173/"],
    [new URL("https://dashboard.chatgpt.site/"), undefined, "https://dashboard.chatgpt.site/"],
  ]) {
    for (const action of ["alert-changes", "schedule-refresh"]) {
      const href = new URL(dataAppActionHref(action, { surface: "dashboard", dataAppReference }, location));
      const prompt = href.searchParams.get("prompt") ?? href.searchParams.get("q");
      assert.ok(prompt.includes(expectedIdentity), "Automation links must retain their exact target");
    }
  }
});

test("unavailable automation links do not mask invalid references or unsupported actions", () => {
  const location = new URL("http://localhost:5173/");
  assert.throws(() => dataAppActionHref("alert-changes", {
    surface: "dashboard", viewUrl: "not a URL",
  }, location), /valid, credential-free Data app view URL/u);
  assert.throws(() => dataAppActionHref("unknown", { surface: "dashboard" }, location), /Unsupported dashboard action/u);
});

test("local publication links in Codex retain the selected access policy", (context) => {
  useBrowserUserAgent(context, "CodexBrowser");
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const location = new URL(`file:///Users/example/My%20Dashboard/dist/index.html#codexThreadId=${threadId}`);
  const href = new URL(
    dataAppActionHref(
      "sites",
      {
        surface: "dashboard",
        title: "Rollout review",
        accessMode: "workspace_all",
      },
      location,
    ),
  );

  assert.equal(`${href.protocol}//${href.host}${href.pathname}`, `codex://threads/${threadId}`);
  assert.match(href.searchParams.get("prompt"), /\[@Sites\]\(plugin:\/\/sites@openai-curated-remote\) to publish this dashboard/u);
  assert.match(href.searchParams.get("prompt"), /workspace members with the link/u);
  assert.match(href.searchParams.get("prompt"), /Dashboard project directory: \/Users\/example\/My Dashboard/);
  assert.equal(href.searchParams.has("originUrl"), false);
  assert.equal(href.searchParams.has("path"), false);
  assert.equal(href.searchParams.get("prompt").includes(threadId), false);
});

test("Data app actions select the appropriate deep link without exposing task context", () => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";

  for (const href of [
    "file:///Users/example/Dashboard/dist/index.html",
    "file:///Users/example/Dashboard/dist/index.html#codexThreadId=../../settings",
  ]) {
    const action = codexDataAppActionUrl("Export as PDF", new URL(href), "CodexBrowser");
    assert.equal(`${action.protocol}//${action.host}${action.pathname}`, "codex://new");
    assert.equal(action.searchParams.get("prompt"), "Export as PDF");
    assert.equal(action.searchParams.has("originUrl"), false);
    assert.equal(action.searchParams.get("path"), "/Users/example/Dashboard");
    assert.equal(action.searchParams.has("browserUrl"), false);
    const browser = codexDataAppActionUrl("Export as PDF", new URL(href), "Mozilla/5.0");
    assert.equal(browser.href, action.href,
      "Saved files without a usable task identifier must still open a new Codex task in an ordinary browser");
  }

  const hosted = codexDataAppActionUrl(
    "Refresh dashboard",
    new URL(`https://user:password@dashboard.chatgpt.site/path?token=secret#codexThreadId=${threadId}`),
    "Mozilla/5.0",
  );
  assert.equal(`${hosted.origin}${hosted.pathname}`, "https://chatgpt.com/");
  assert.equal(hosted.searchParams.get("q"), "Refresh dashboard");
  assert.equal(hosted.searchParams.get("disable_auto_send"), "1");
  assert.equal(hosted.searchParams.has("originUrl"), false);
  assert.equal(hosted.searchParams.has("path"), false);
  assert.doesNotMatch(hosted.toString(), /secret|user|password|codexThreadId/);
});

test("file handoffs preserve complete fallback requests across desktop and web", () => {
  const location = new URL("file:///Users/example/Current/dist/index.html");
  const context = { surface: "dashboard", canEdit: true, title: "Reviewed 📊 sales", accessMode: "custom",
    snapshot: { id: "dashboard:roundtrip", generatedAt: "2026-09-06T00:00:00Z", queries: { sales: { rows: [{ revenue: 123 }] } } },
    presentation: { title: "Edited 📊 sales", hiddenBlocks: [], componentTitles: {}, textEdits: { caption: "" },
      chartOverrides: {}, filters: { region: ["日本", "US & UK"] }, assumptions: { activationLift: 0 } } };
  for (const action of ["share-summary", "refresh", "duplicate", "create-report", "refresh-document", "alert-changes",
    "edit-in-chatgpt", "pdf", "word", "powerpoint", "google-docs", "google-slides", "jupyter-notebook", "sites", "schedule-refresh"]) {
    const expected = dataAppActionRequest(action, { ...context, dataAppReference: currentDataAppReference(location) }).prompt;
    for (const destination of ["desktop", "web"]) {
      const url = new URL(dataAppActionHref(action, context, location, destination));
      const full = url.searchParams.get(destination === "desktop" ? "prompt" : "q");
      assert.equal(full, expected, `${action}/${destination} retains the original request`);
      assert.deepEqual([...url.searchParams.keys()], destination === "desktop"
        ? ["prompt", "path"] : ["q", "disable_auto_send"]);
      assert.equal(Buffer.from(full, "utf8").toString("utf8"), expected);
      if (!["share-summary", "schedule-refresh"].includes(action)) assert.match(full, /日本/u);
      if (destination === "web") assert.equal(url.searchParams.get("disable_auto_send"), "1");
    }
  }
});

test("file handoffs do not truncate large presentation, cleared values or Unicode titles", () => {
  const location = new URL("file:///Users/example/Large/dist/index.html");
  const presentation = { textEdits: Object.fromEntries(Array.from({ length: 150 }, (_, index) =>
    [`chart-${index}`, index === 0 ? "" : `Chart ${index} — 日本 📊 & + % # `.repeat(100)])),
    hiddenBlocks: [], componentTitles: {}, chartOverrides: {}, filters: { categories: [] }, assumptions: { lift: 0 } };
  const title = "📊".repeat(150);
  const context = { surface: "dashboard", canEdit: true, title, presentation };
  for (const destination of ["desktop", "web"]) {
    const url = new URL(dataAppActionHref("edit-in-chatgpt", context, location, destination));
    const full = url.searchParams.get(destination === "desktop" ? "prompt" : "q");
    assert.equal(full, dataAppActionRequest("edit-in-chatgpt", { ...context, dataAppReference: currentDataAppReference(location) }).prompt);
    assert.match(full, /"chart-149"/u);
    assert.match(full, /"chart-0": ""/u);
    assert.ok(full.includes(title));
    assert.equal(Buffer.from(full, "utf8").toString("utf8"), full);
  }
});
