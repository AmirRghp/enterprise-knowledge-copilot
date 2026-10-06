import assert from "node:assert/strict";
import test from "node:test";

import { dataAppActionHref, submitDataAppAction } from "../src/data-app-actions.js";
import {
  chatGPTPromptUrl,
  codexDataAppActionUrl,
  codexDataAppAskUrl,
  codexDataAppNewTaskUrl,
  codexDataAppPromptUrl,
  currentDataAppReference,
  currentDataAppViewUrl,
  dataAppPromptTarget,
  isCodexBrowser,
  safeDataAppSourceHref,
} from "../src/runtime-environment.js";

test("hosted references and desktop browser context preserve only supported dashboard view state", () => {
  const location = new URL("https://viewer:secret@dashboard.chatgpt.site/_data/charts/revenue?token=private&unknown=ignored#selection");
  const view = new URLSearchParams({
    view: "1", tab: "detail", "f.category": "Pens", "f.region": '["East","West"]',
    a: JSON.stringify({ activationLift: 3 }),
    s: JSON.stringify({ "section-1": { category: "Pens" } }),
    c: JSON.stringify({ "chart-1": { inlineFilters: { category: "Pens" }, visibleSeries: ["Revenue"], zoomRange: { start: 1, end: 2 } } }),
    focus: JSON.stringify({ "chart-1": "selection" }),
    t: JSON.stringify({ overview: { filters: { region: ["East", "West"] }, focus: { account: "abc" } } }),
  });
  for (const [key, value] of view) location.searchParams.set(key, value);
  const expected = new URL("https://dashboard.chatgpt.site/");
  expected.search = view.toString();
  const reference = currentDataAppReference(location);
  assert.equal(reference.sourceUrl, expected.href);
  assert.equal(location.searchParams.get("token"), "private", "Reading the view does not mutate the live location");
  const desktop = codexDataAppPromptUrl("Explain the current view", reference, location, "CodexBrowser");
  assert.equal(desktop.searchParams.get("browserUrl"), expected.href);
  assert.equal(desktop.searchParams.get("prompt"), "Explain the current view");
  assert.doesNotMatch(desktop.href, /viewer|secret|private|unknown|ignored|_data/u);
  assert.equal(safeDataAppSourceHref(expected.href), expected.href);
  for (const unsafe of [
    "https://user:password@dashboard.chatgpt.site/?view=1&f.category=Pens",
    "https://dashboard.chatgpt.site/tokens/private?view=1",
    "https://dashboard.chatgpt.site/?view=1&token=secret",
    "https://dashboard.chatgpt.site/?view=1&unknown=ignored",
    "https://dashboard.chatgpt.site/?view=1#private",
    "https://dashboard.chatgpt.site/?view=1&view=1",
  ]) assert.equal(safeDataAppSourceHref(unsafe), null, unsafe);
});

test("view query state does not change local HTML identity or native task routing", (context) => {
  useLocalReferenceMetadata(context, [JSON.stringify({
    root: "/workspace/Current dashboard", htmlPath: "/workspace/Current dashboard/dist/index.html",
  })]);
  const location = new URL("http://127.0.0.1:5173/?view=1&tab=detail&f.category=Pens&token=secret#selection");
  const reference = currentDataAppReference(location);
  assert.deepEqual(reference, {
    root: "/workspace/Current dashboard", htmlPath: "/workspace/Current dashboard/dist/index.html",
  });
  const desktop = codexDataAppPromptUrl("Explain the current view", reference, location, "CodexBrowser");
  assert.equal(desktop.searchParams.get("path"), reference.root);
  assert.equal(desktop.searchParams.get("browserUrl"), "http://127.0.0.1:5173/?view=1&tab=detail&f.category=Pens");
  assert.deepEqual([...desktop.searchParams.keys()], ["prompt", "path", "browserUrl"]);
  const saved = currentDataAppReference(new URL("file:///workspace/Current%20dashboard/dist/index.html?view=1&f.category=Pens#selection"));
  assert.equal(saved.htmlPath, reference.htmlPath);
  assert.equal(saved.sourceUrl, "file:///workspace/Current%20dashboard/dist/index.html");
});

test("shared handoffs preserve prompts and select the current browser's destination", () => {
  const prompt = "Why did Enterprise grow 12%?\n\nSelected context: Enterprise — 12% & rising";
  const location = new URL("https://viewer:secret@dashboard.chatgpt.site/_data/charts/abc-123?token=private#selection");
  const reference = currentDataAppReference(location);
  const desktop = codexDataAppPromptUrl(prompt, reference, location, "CodexBrowser");
  assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, "codex://new");
  assert.deepEqual([...desktop.searchParams.keys()], ["prompt", "browserUrl"]);
  assert.equal(desktop.searchParams.get("prompt"), prompt);
  assert.equal(desktop.searchParams.get("browserUrl"), "https://dashboard.chatgpt.site/");
  assert.equal(dataAppPromptTarget(desktop), "_self");
  assert.doesNotMatch(desktop.toString(), /viewer|secret|private|_data|selection/u);

  const browser = codexDataAppPromptUrl(prompt, reference, location, "Mozilla/5.0");
  assert.equal(`${browser.origin}${browser.pathname}`, "https://chatgpt.com/");
  assert.deepEqual([...browser.searchParams.keys()], ["q", "disable_auto_send"]);
  assert.equal(browser.searchParams.get("q"), prompt);
  assert.equal(browser.searchParams.get("disable_auto_send"), "1");
  assert.equal(dataAppPromptTarget(browser), "_blank");
  assert.match(browser.toString(), /q=Why\+did\+Enterprise\+grow\+12%25%3F/u);
});

test("shared handoffs omit unsafe browser context and reject empty prompts", () => {
  for (const href of [
    "javascript:alert(1)",
    "https://dashboard.chatgpt.site/tokens/private",
  ]) {
    const handoff = codexDataAppPromptUrl("Explain this chart", undefined, new URL(href), "CodexBrowser");
    assert.equal(`${handoff.protocol}//${handoff.host}${handoff.pathname}`, "codex://new");
    assert.deepEqual([...handoff.searchParams.keys()], ["prompt"]);
  }
  assert.throws(() => codexDataAppPromptUrl(" ", undefined, new URL("https://dashboard.chatgpt.site/")), /requires a prompt/u);
});

function useBrowserUserAgent(context, userAgent) {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent } });
  context.after(() => {
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });
}

function useLocalThreadMetadata(context, threadId) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelector: (selector) =>
      selector === 'meta[name="data-app-local-thread"]'
        ? {
            getAttribute: (attribute) => (attribute === "content" ? threadId : null),
          }
        : null,
  };
  context.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
}

function useLocalReferenceMetadata(context, entries) {
  const originalDocument = globalThis.document;
  let contents = entries;
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === 'meta[name="data-app-local-reference"]'
        ? contents.map((content) => ({
            getAttribute: (attribute) => (attribute === "content" ? content : null),
          }))
        : [],
  };
  context.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  return (next) => {
    contents = next;
  };
}

function useSitesProjectMetadata(context, entries) {
  const originalDocument = globalThis.document;
  globalThis.document = {
    querySelectorAll: (selector) =>
      selector === 'meta[name="data-app-sites-project"]'
        ? entries.map((content) => ({
            getAttribute: (attribute) => (attribute === "content" ? content : null),
          }))
        : [],
  };
  context.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
}

test("saved-file and native prompt links use the current tab while hosted web links use a new tab", () => {
  const hosted = new URL("https://growth.openai.chatgpt.site/");
  const local = new URL("file:///Users/example/dashboard/dist/index.html");

  assert.equal(dataAppPromptTarget(chatGPTPromptUrl("Publish", local, "CodexBrowser")), "_self");
  assert.equal(dataAppPromptTarget(chatGPTPromptUrl("Publish", local, "Mozilla/5.0")), "_self");
  assert.equal(dataAppPromptTarget(chatGPTPromptUrl("Publish", hosted, "CodexBrowser Chrome/140")), "_self");
  assert.equal(dataAppPromptTarget(chatGPTPromptUrl("Publish", hosted, "ChatGPTBrowser Chrome/140")), "_self");
  assert.equal(dataAppPromptTarget(chatGPTPromptUrl("Publish", hosted, "Mozilla/5.0 Chrome/140")), "_blank");
  assert.equal(dataAppPromptTarget(undefined), "_blank");
});

test("Codex browser detection accepts current and rollout user agents", () => {
  assert.equal(isCodexBrowser("CodexBrowser Chrome/140"), true);
  assert.equal(isCodexBrowser("ChatGPTBrowser Chrome/140"), true);
  assert.equal(isCodexBrowser("Mozilla/5.0 Chrome/140"), false);
  assert.equal(isCodexBrowser("CodexBrowserSpoof Chrome/140"), false);
  assert.equal(isCodexBrowser(""), false);
  assert.equal(isCodexBrowser(null), false);
});

test("explicit destinations override browser detection without changing action identity", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  const originalWindow = globalThis.window;
  globalThis.window = { __codexBrowser: true };
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const prompt = "Publish & preserve this dashboard";
  const locations = [
    new URL("file:///workspace/dashboard/dist/index.html"),
    new URL("http://localhost:5173/"),
    new URL(`https://viewer:secret@dashboard.chatgpt.site/?token=private#codexThreadId=${threadId}`),
  ];
  for (const location of locations) {
    const web = codexDataAppActionUrl(prompt, location, "CodexBrowser", "web");
    assert.equal(`${web.origin}${web.pathname}`, "https://chatgpt.com/");
    assert.deepEqual([...web.searchParams.keys()], ["q", "disable_auto_send"]);
    assert.equal(web.searchParams.get("q"), prompt);
    assert.equal(dataAppPromptTarget(web), "_blank");
  }
  delete globalThis.window.__codexBrowser;
  for (const location of locations) {
    const desktop = codexDataAppActionUrl(prompt, location, "Mozilla/5.0", "desktop");
    const hosted = location.protocol === "https:";
    assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, hosted ? "codex://new" : `codex://threads/${threadId}`);
    assert.equal(desktop.searchParams.get("prompt"), prompt);
    assert.equal(dataAppPromptTarget(desktop), "_self");
    if (hosted) {
      assert.equal(desktop.searchParams.get("browserUrl"), "https://dashboard.chatgpt.site/");
      assert.doesNotMatch(desktop.href, /viewer|secret|private|codexThreadId|550e8400/u);
    } else {
      assert.deepEqual([...desktop.searchParams.keys()], location.protocol === "file:" ? ["prompt"] : ["prompt", "browserUrl"]);
    }
  }
});

test("explicit destinations preserve local threads and sanitized fallback context", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  const originalWindow = globalThis.window;
  globalThis.window = { __codexBrowser: true };
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const cases = [
    [new URL("file:///C:/work/My%20Report/dist/index.html"), null, null],
    [new URL(`https://viewer:secret@dashboard.chatgpt.site/_data/charts/abc?token=private#codexThreadId=${threadId}`), "browserUrl", "https://dashboard.chatgpt.site/"],
    [new URL("file://server/share/report/dist/index.html"), null, null],
  ];
  for (const [location] of cases) {
    const web = codexDataAppNewTaskUrl("Investigate", undefined, location, "CodexBrowser", "web");
    assert.equal(web.href, "https://chatgpt.com/?q=Investigate&disable_auto_send=1");
    assert.equal(dataAppPromptTarget(web), "_blank");
  }
  delete globalThis.window.__codexBrowser;
  for (const [location, key, value] of cases) {
    const desktop = codexDataAppNewTaskUrl("Investigate", undefined, location, "Mozilla/5.0", "desktop");
    const originalThread = location.protocol === "file:" && !location.hostname;
    assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, originalThread ? `codex://threads/${threadId}` : "codex://new");
    assert.deepEqual([...desktop.searchParams.keys()], key ? ["prompt", key] : ["prompt"]);
    if (key) assert.equal(desktop.searchParams.get(key), value);
    assert.doesNotMatch(desktop.search, /viewer|secret|private|codexThreadId|550e8400/u);
    assert.equal(dataAppPromptTarget(desktop), "_self");
  }
});

test("saved-file Ask returns to its originating task in every browser", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  const location = new URL("file:///Users/example/Commerce%20performance/dist/index.html");
  const prompt = "Answer this question about Commerce performance:\nQuestion: hi";
  for (const userAgent of ["Mozilla/5.0", "CodexBrowser/1.0"]) {
    const href = codexDataAppAskUrl(prompt, undefined, location, userAgent);
    assert.equal(`${href.protocol}//${href.host}${href.pathname}`, `codex://threads/${threadId}`);
    assert.deepEqual([...href.searchParams.keys()], ["prompt"]);
    assert.equal(href.searchParams.get("prompt"), prompt);
    assert.equal(dataAppPromptTarget(href), "_self");
  }
});

test("saved-file Ask without an originating task keeps its new-task project context", (context) => {
  useLocalThreadMetadata(context, null);
  const location = new URL("file:///Users/example/Commerce%20performance/dist/index.html");
  const href = codexDataAppAskUrl("Question: hi", undefined, location, "Mozilla/5.0");
  assert.equal(`${href.protocol}//${href.host}${href.pathname}`, "codex://new");
  assert.deepEqual([...href.searchParams.keys()], ["prompt", "path"]);
  assert.equal(href.searchParams.get("prompt"), "Question: hi");
  assert.equal(href.searchParams.get("path"), "/Users/example/Commerce performance");
  assert.equal(dataAppPromptTarget(href), "_self");
});

test("hosted Ask destination choices never recover a private originating task", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  const location = new URL(`https://viewer:secret@dashboard.chatgpt.site/report?token=private#codexThreadId=${threadId}`);
  const prompt = "Question: hi";
  const desktop = codexDataAppAskUrl(prompt, undefined, location, "Mozilla/5.0", "desktop");
  assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, "codex://new");
  assert.deepEqual([...desktop.searchParams.keys()], ["prompt", "browserUrl"]);
  assert.equal(desktop.searchParams.get("prompt"), prompt);
  assert.equal(desktop.searchParams.get("browserUrl"), "https://dashboard.chatgpt.site/report");
  assert.doesNotMatch(desktop.href, /viewer|secret|private|codexThreadId|550e8400/u);
  assert.equal(dataAppPromptTarget(desktop), "_self");
  const web = codexDataAppAskUrl(prompt, undefined, location, "CodexBrowser", "web");
  assert.equal(web.href, "https://chatgpt.com/?q=Question%3A+hi&disable_auto_send=1");
  assert.equal(dataAppPromptTarget(web), "_blank");
});

test("unsupported explicit ChatGPT destinations are rejected", () => {
  const location = new URL("https://dashboard.chatgpt.site/");
  for (const destination of [null, "", "browser", true]) {
    assert.throws(() => chatGPTPromptUrl("Publish", location, "CodexBrowser", destination), /Choose desktop or web/u);
    assert.throws(() => codexDataAppNewTaskUrl("Investigate", undefined, location, "CodexBrowser", destination), /Choose desktop or web/u);
  }
});

test("published apps always open a new task without sharing a prior task identifier", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  const location = new URL(`https://viewer:secret@growth.openai.chatgpt.site/?token=private#codexThreadId=${threadId}`);
  const desktop = chatGPTPromptUrl("Refresh the dashboard", location, "CodexBrowser Chrome/140");

  assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, "codex://new");
  assert.equal(desktop.searchParams.get("prompt"), "Refresh the dashboard");
  assert.equal(desktop.searchParams.get("browserUrl"), "https://growth.openai.chatgpt.site/");
  assert.doesNotMatch(desktop.toString(), /viewer|secret|private|codexThreadId|550e8400/u);

  const browser = chatGPTPromptUrl("Refresh the dashboard", location, "Mozilla/5.0 Chrome/140");
  assert.equal(browser.toString(), "https://chatgpt.com/?q=Refresh+the+dashboard&disable_auto_send=1");
});

test("saved HTML and development previews recover their task in every browser", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  for (const href of [
    "file:///Users/example/dashboard/dist/index.html",
    "http://terminal.local:4173/",
    "http://localhost:5173/",
    "http://127.0.0.1:5173/",
    "http://[::1]:5173/",
    "http://dashboard.localhost:5173/",
  ]) {
    const location = new URL(href);
    const action = chatGPTPromptUrl("Refresh the dashboard", location, "CodexBrowser");
    assert.equal(`${action.protocol}//${action.host}${action.pathname}`, `codex://threads/${threadId}`);
    assert.deepEqual([...action.searchParams.keys()], location.protocol === "file:" ? ["prompt"] : ["prompt", "browserUrl"]);
    const browser = chatGPTPromptUrl("Refresh the dashboard", location, "Mozilla/5.0");
    assert.equal(browser.href, action.href);
  }

  const explicitThreadId = "de305d54-75b4-431b-adb2-eb6b9e546014";
  const explicit = chatGPTPromptUrl(
    "Refresh the dashboard",
    new URL(`file:///Users/example/dashboard/dist/index.html#codexThreadId=${explicitThreadId}`),
    "Mozilla/5.0",
  );
  assert.equal(
    `${explicit.protocol}//${explicit.host}${explicit.pathname}`,
    `codex://threads/${threadId}`,
    "Protected local build metadata must take precedence over a stale or untrusted URL fragment",
  );

  const invalidFragment = chatGPTPromptUrl(
    "Refresh the dashboard",
    new URL("file:///Users/example/dashboard/dist/index.html#codexThreadId=not-a-uuid"),
    "Mozilla/5.0",
  );
  assert.equal(
    `${invalidFragment.protocol}//${invalidFragment.host}${invalidFragment.pathname}`,
    `codex://threads/${threadId}`,
  );
});

test("file and HTTP preview publication return to the original thread with or without the IAB marker", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useBrowserUserAgent(context, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36");
  useLocalThreadMetadata(context, threadId);
  const originalWindow = globalThis.window;
  const browserWindow = {};
  globalThis.window = browserWindow;
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  });
  const app = {
    surface: "dashboard",
    dataAppReference: { root: "/workspace/dashboard", htmlPath: "/workspace/dashboard/dist/index.html" },
  };

  for (const href of ["file:///workspace/dashboard/dist/index.html", "http://localhost:5173/"]) {
    const location = new URL(href);
    browserWindow.__codexBrowser = true;
    const desktop = new URL(dataAppActionHref("sites", app, location));
    assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, `codex://threads/${threadId}`);
    assert.equal(dataAppPromptTarget(desktop), "_self");

    delete browserWindow.__codexBrowser;
    const external = new URL(dataAppActionHref("sites", app, location));
    assert.equal(external.href, desktop.href);
    assert.equal(dataAppPromptTarget(external), "_self");
  }
});

test("local handoffs reject missing or invalid task identifiers", (context) => {
  useLocalThreadMetadata(context, "../../settings");
  for (const fragment of ["", "draft", "codexThreadId=../../settings", "codexThreadId=not-a-uuid"]) {
    const action = chatGPTPromptUrl(
      "Refresh the dashboard",
      new URL(`file:///Users/example/dashboard/dist/index.html#${fragment}`),
      "Mozilla/5.0",
    );
    assert.equal(`${action.protocol}//${action.host}${action.pathname}`, "codex://new");
    assert.equal(action.searchParams.get("prompt"), "Refresh the dashboard");
  }

  const legacyThreadId = "550e8400-e29b-41d4-a716-446655440000";
  const legacy = chatGPTPromptUrl(
    "Refresh the dashboard",
    new URL(`file:///Users/example/dashboard/dist/index.html#codexThreadId=${legacyThreadId}`),
    "Mozilla/5.0",
  );
  assert.equal(
    `${legacy.protocol}//${legacy.host}${legacy.pathname}`,
    `codex://threads/${legacyThreadId}`,
    "Valid fragments remain a legacy fallback only when trusted build metadata is absent",
  );
});

test("development previews retain their project identity without leaking internal URLs", () => {
  for (const href of [
    "http://terminal.local:4173/?token=private#draft",
    "http://localhost:5173/",
    "http://127.0.0.1:5173/",
    "http://[::1]:5173/",
    "http://dashboard.localhost:5173/",
  ]) {
    assert.deepEqual(currentDataAppReference(new URL(href), "/workspace/revenue-dashboard"), {
      root: "/workspace/revenue-dashboard",
      htmlPath: "/workspace/revenue-dashboard/dist/index.html",
    });
    assert.deepEqual(currentDataAppReference(new URL(href)), {});
  }
});

test("prebuilt development previews use their exact server-supplied local HTML identity", (context) => {
  useBrowserUserAgent(context, "CodexBrowser");
  const reference = {
    root: "/workspace/My Dashboard",
    htmlPath: "/workspace/My Dashboard/build/review.html",
  };
  useLocalReferenceMetadata(context, [JSON.stringify(reference)]);
  for (const href of [
    "http://terminal.local:4173/?token=private#draft",
    "https://localhost:5173/",
    "http://127.0.0.1:5173/",
    "http://[::1]:5173/",
    "http://dashboard.localhost:5173/",
  ]) {
    assert.deepEqual(currentDataAppReference(new URL(href)), reference);
    assert.deepEqual(currentDataAppReference(new URL(href), "/workspace/old-source-build"), reference);
  }

  const action = new URL(
    dataAppActionHref(
      "sites",
      {
        surface: "dashboard",
        title: "Revenue overview",
      },
      new URL("http://localhost:5173/?token=private#draft"),
    ),
  );
  assert.equal(action.searchParams.get("path"), reference.root);
  assert.equal(action.searchParams.get("browserUrl"), "http://localhost:5173/");
  assert.ok(action.searchParams.get("prompt").includes("http://localhost:5173/"));
  assert.doesNotMatch(action.searchParams.get("prompt"), /token=private|#draft|Current presentation overrides/u);
});

test("local-preview metadata supports normalized POSIX, drive-letter, and UNC paths", (context) => {
  const setMetadata = useLocalReferenceMetadata(context, []);
  const location = new URL("http://localhost:4173/");
  for (const [reference, expected] of [
    [
      { root: "/workspace/app/", htmlPath: "/workspace/app/dist/index.html" },
      { root: "/workspace/app", htmlPath: "/workspace/app/dist/index.html" },
    ],
    [
      { root: "/", htmlPath: "/dashboard.htm" },
      { root: "/", htmlPath: "/dashboard.htm" },
    ],
    [
      { root: "C:\\Users\\Example\\Dashboard", htmlPath: "c:\\users\\example\\dashboard\\dist\\index.HTML" },
      { root: "C:/Users/Example/Dashboard", htmlPath: "c:/users/example/dashboard/dist/index.HTML" },
    ],
    [
      { root: "C:\\", htmlPath: "C:\\Dashboard\\dist\\index.html" },
      { root: "C:/", htmlPath: "C:/Dashboard/dist/index.html" },
    ],
    [
      { root: "\\\\server\\share\\Dashboard\\", htmlPath: "\\\\SERVER\\share\\Dashboard\\dist\\index.html" },
      { root: "//server/share/Dashboard", htmlPath: "//SERVER/share/Dashboard/dist/index.html" },
    ],
  ]) {
    setMetadata([JSON.stringify(reference)]);
    assert.deepEqual(currentDataAppReference(location), expected);
  }
});

test("local-preview metadata rejects ambiguous, malformed, or escaping paths", (context) => {
  const setMetadata = useLocalReferenceMetadata(context, []);
  const location = new URL("http://localhost:4173/");
  const fallback = { root: "/workspace/fallback", htmlPath: "/workspace/fallback/dist/index.html" };
  const valid = { root: "/workspace/app", htmlPath: "/workspace/app/dist/index.html" };
  const invalid = [
    null,
    [],
    {},
    { ...valid, sourceUrl: "https://example.com/" },
    { ...valid, root: "workspace/app" },
    { ...valid, htmlPath: "dist/index.html" },
    { ...valid, htmlPath: "/workspace/app-other/index.html" },
    { ...valid, htmlPath: "/workspace/app/../outside.html" },
    { ...valid, htmlPath: "/workspace/app/nested\\..\\..\\outside.html" },
    { ...valid, htmlPath: "/workspace/app/./dist/index.html" },
    { ...valid, htmlPath: "/workspace/app//dist/index.html" },
    { ...valid, root: "/workspace/./app" },
    { ...valid, root: "/workspace/app\t" },
    { ...valid, htmlPath: "/workspace/app/dist/index\u0000.html" },
    { ...valid, htmlPath: "/workspace/app/dist/index\u0085.html" },
    { ...valid, htmlPath: "/workspace/app/dist/index\u2028.html" },
    { ...valid, htmlPath: "https://localhost/index.html" },
    { ...valid, htmlPath: "/workspace/app/dist/index.js" },
    { ...valid, htmlPath: "/workspace/app/dist/index.html/" },
    { root: "/workspace/app.html", htmlPath: "/workspace/app.html" },
    { root: "C:Dashboard", htmlPath: "C:Dashboard/index.html" },
    { root: "C:\\Dashboard", htmlPath: "D:\\Dashboard\\index.html" },
    { root: "C:\\Dashboard", htmlPath: "C:\\Dashboard\\.. \\outside.html" },
    { root: "C:\\Dashboard", htmlPath: "C:\\Dashboard\\index.html:stream" },
    { root: "\\\\?\\C:\\Dashboard", htmlPath: "\\\\?\\C:\\Dashboard\\index.html" },
    { root: "\\\\server\\share\\Dashboard", htmlPath: "\\\\server\\other\\Dashboard\\index.html" },
  ];
  for (const value of invalid) {
    setMetadata([JSON.stringify(value)]);
    assert.deepEqual(currentDataAppReference(location), {}, JSON.stringify(value));
    assert.deepEqual(currentDataAppReference(location, fallback.root), fallback, JSON.stringify(value));
  }
  for (const entries of [[], ["{"], [JSON.stringify(valid), JSON.stringify(valid)], ["null", JSON.stringify(valid)]]) {
    setMetadata(entries);
    assert.deepEqual(currentDataAppReference(location), {});
    assert.deepEqual(currentDataAppReference(location, fallback.root), fallback);
  }
});

test("hosted and saved-file views never read local-preview metadata", (context) => {
  const reference = { root: "/workspace/private", htmlPath: "/workspace/private/dist/index.html" };
  useLocalReferenceMetadata(context, [JSON.stringify(reference)]);
  for (const href of [
    "https://growth.openai.chatgpt.site/?token=private#draft",
    "https://localhost.example.com/?token=private#draft",
    "https://example.local/?token=private#draft",
  ]) {
    const expected = new URL(href);
    expected.search = "";
    expected.hash = "";
    assert.deepEqual(currentDataAppReference(new URL(href)), { sourceUrl: expected.toString() });
  }
  assert.deepEqual(currentDataAppReference(new URL("file:///workspace/actual/dist/index.html")), {
    root: "/workspace/actual",
    htmlPath: "/workspace/actual/dist/index.html",
    sourceUrl: "file:///workspace/actual/dist/index.html",
  });
  assert.deepEqual(currentDataAppReference(new URL("ftp://localhost/index.html")), {});
});

test("hosted Sites recover their packaged project identity without trusting URLs or foreign pages", (context) => {
  useSitesProjectMetadata(context, ["appgprj_123"]);
  for (const hostname of ["growth.openai.chatgpt.site", "growth.openai.chatgpt-team.site"]) {
    assert.deepEqual(
      currentDataAppReference(new URL(`https://${hostname}/_data/charts/abc?token=private#mark`)),
      { sourceUrl: `https://${hostname}/`, projectId: "appgprj_123" },
    );
  }
  for (const href of [
    "https://example.com/dashboard",
    "https://growth.chatgpt-team.site.example.com/dashboard",
    "https://growth.notchatgpt-team.site/dashboard",
    "http://growth.openai.chatgpt-team.site/dashboard",
  ]) {
    assert.deepEqual(currentDataAppReference(new URL(href)), { sourceUrl: href });
  }
});

test("hosted Sites reject missing, duplicate, or malformed packaged project identities", (context) => {
  const originalDocument = globalThis.document;
  let entries = [];
  globalThis.document = {
    querySelectorAll: () => entries.map((content) => ({ getAttribute: () => content })),
  };
  context.after(() => {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });
  const location = new URL("https://growth.openai.chatgpt.site/");
  for (entries of [[], ["appgprj_123", "appgprj_123"], ["../private"], ["site id"], [""]]) {
    assert.deepEqual(currentDataAppReference(location), { sourceUrl: location.href });
  }
});

test("local file URLs retain decoded POSIX and Windows paths in native task links", () => {
  for (const [href, root] of [
    ["file:///C:/work/report/dist/index.html", "C:/work/report"],
    ["file://localhost/d:/work/Quarterly%20report%20%E2%82%AC/dist/index.html?preview=1#draft", "d:/work/Quarterly report €"],
    ["file:///Users/example/Quarterly%20report%20%E2%82%AC/dist/index.html", "/Users/example/Quarterly report €"],
    ["file://localhost/Users/example/report/dist/index.html", "/Users/example/report"],
    ["file:///C:/work/100%25%20report/dist/index.html", "C:/work/100% report"],
  ]) {
    const location = new URL(href);
    const source = new URL(href);
    source.search = "";
    source.hash = "";
    assert.deepEqual(currentDataAppReference(location), {
      root, htmlPath: `${root}/dist/index.html`, sourceUrl: source.href,
    });
    for (const userAgent of ["CodexBrowser", "Mozilla/5.0"]) {
      const task = codexDataAppNewTaskUrl("Investigate", undefined, location, userAgent);
      assert.equal(`${task.protocol}//${task.host}${task.pathname}`, "codex://new");
      assert.equal(task.searchParams.get("path"), root);
      assert.deepEqual([...task.searchParams.keys()], ["prompt", "path"]);
    }
  }
});

test("filesystem-root reports retain absolute working directories in native task links", () => {
  for (const [href, root, htmlPath] of [
    ["file:///C:/dist/index.html", "C:/", "C:/dist/index.html"],
    ["file:///d:/index.html", "d:/", "d:/index.html"],
    ["file:///dist/index.html", "/", "/dist/index.html"],
    ["file:///index.html", "/", "/index.html"],
  ]) {
    const location = new URL(href);
    assert.deepEqual(currentDataAppReference(location), { root, htmlPath, sourceUrl: href });
    for (const userAgent of ["CodexBrowser", "Mozilla/5.0"]) {
      const task = codexDataAppNewTaskUrl("Investigate", undefined, location, userAgent);
      assert.equal(`${task.protocol}//${task.host}${task.pathname}`, "codex://new");
      assert.equal(task.searchParams.get("path"), root);
    }
  }
});

test("network and unsafe file URLs cannot become local report identities or task paths", (context) => {
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  useLocalThreadMetadata(context, threadId);
  for (const href of [
    "file://server/share/report/dist/index.html",
    "file://127.0.0.1/share/report/dist/index.html",
    "file://report.localhost/share/report/dist/index.html",
    "file:////server/share/report/dist/index.html",
    "file:///%2Fserver/share/report/dist/index.html",
    "file:///C:/work%2Freport/dist/index.html",
    "file:///C:/work%5Creport/dist/index.html",
    "file:///C:/work/report%00/dist/index.html",
    "file:///C:/work/report%7F/dist/index.html",
    "file:///C:/work/report%FF/dist/index.html",
  ]) {
    const location = new URL(`${href}#codexThreadId=${threadId}`);
    assert.deepEqual(currentDataAppReference(location, "C:/other/report"), {}, href);
    const task = codexDataAppNewTaskUrl("Investigate", { root: "C:/other/report" }, location, "CodexBrowser");
    assert.deepEqual([...task.searchParams.keys()], ["prompt"], href);
    const ordinary = chatGPTPromptUrl("Investigate", location, "CodexBrowser");
    assert.equal(`${ordinary.protocol}//${ordinary.host}${ordinary.pathname}`, "codex://new", href);
    assert.equal(chatGPTPromptUrl("Investigate", location, "Mozilla/5.0").href, ordinary.href, href);
    assert.equal(codexDataAppNewTaskUrl("Investigate", undefined, location, "Mozilla/5.0").href,
      "codex://new?prompt=Investigate", href);
  }
});

test("development-preview publication handoffs retain the exact project without leaking internal URLs", (context) => {
  useBrowserUserAgent(context, "CodexBrowser");
  const threadId = "550e8400-e29b-41d4-a716-446655440000";
  const location = new URL(`http://terminal.local:4173/?token=private#codexThreadId=${threadId}`);
  const dataAppReference = currentDataAppReference(location, "/workspace/revenue-dashboard");
  const action = new URL(
    dataAppActionHref(
      "sites",
      {
        surface: "dashboard",
        title: "Revenue overview",
        dataAppReference,
      },
      location,
    ),
  );
  const prompt = action.searchParams.get("prompt");

  assert.equal(`${action.protocol}//${action.host}${action.pathname}`, `codex://threads/${threadId}`);
  assert.equal(action.searchParams.get("browserUrl"), "http://terminal.local:4173/");
  assert.ok(prompt.includes("http://terminal.local:4173/"));
  assert.doesNotMatch(prompt, /token=private|codexThreadId|550e8400|Current presentation overrides/u);
});

test("published actions bypass host follow-ups and start a private new conversation", async (context) => {
  useBrowserUserAgent(context, "Mozilla/5.0");
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const links = [];
  let hostMessages = 0;
  globalThis.window = {
    location: new URL("https://growth.openai.chatgpt.site/"),
    openai: {
      sendFollowUpMessage: () => {
        hostMessages += 1;
      },
    },
  };
  globalThis.document = {
    createElement: () => ({
      style: {},
      setAttribute() {},
      click() {
        links.push(this.href);
      },
      remove() {},
    }),
    body: { appendChild() {} },
  };
  context.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  });

  assert.equal(
    await submitDataAppAction("refresh", {
      surface: "dashboard",
      title: "Revenue overview",
      presentation: {
        filters: { customer: "Confidential Enterprise" },
        assumptions: { renewal: "Restricted forecast" },
        rows: [{ account: "Private customer" }],
      },
    }),
    true,
  );

  assert.equal(hostMessages, 0);
  assert.equal(links.length, 1);
  const action = new URL(links[0]);
  assert.equal(`${action.origin}${action.pathname}`, "https://chatgpt.com/");
  assert.ok(action.searchParams.get("q").includes("https://growth.openai.chatgpt.site/"));
  assert.doesNotMatch(action.searchParams.get("q"), /Private customer|Confidential Enterprise|Restricted forecast/u);
  assert.equal(action.searchParams.get("disable_auto_send"), "1");
  assert.equal(action.searchParams.has("contextVersion"), false);
});


test("linked handoffs use the supplied same-click view and reject inaccessible or unsafe context", () => {
  const location = new URL("http://127.0.0.1:5173/?view=1&f.category=All");
  const selected = "http://127.0.0.1:5173/?view=1&f.category=Pens";
  const desktop = codexDataAppPromptUrl("Publish", {}, location, "CodexBrowser", "desktop", selected);
  assert.equal(desktop.searchParams.get("browserUrl"), selected);
  assert.throws(() => codexDataAppPromptUrl("Publish", {}, location, "Mozilla", "web", selected), /local preview/u);
  for (const destination of ["desktop", "web"]) {
    for (const viewUrl of [null, "", "javascript:alert(1)", "https://example.com/?token=private", "file:///private/a.html"])
      assert.throws(() => codexDataAppPromptUrl("Publish", {}, location, "CodexBrowser", destination, viewUrl), /view link is unavailable/u);
  }
  assert.equal(codexDataAppPromptUrl("Publish", {}, location, "CodexBrowser", "desktop", undefined)
    .searchParams.get("browserUrl"), location.href);
  assert.equal(codexDataAppPromptUrl("Publish", {}, location, "Mozilla", "web", undefined).href,
    "https://chatgpt.com/?q=Publish&disable_auto_send=1");
  assert.equal(currentDataAppViewUrl(new URL("file:///a.html")), null);
  assert.equal(currentDataAppViewUrl(new URL("https://u:p@example.com/?view=1&f.region=East&token=secret#private")), "https://example.com/?view=1&f.region=East");
});
