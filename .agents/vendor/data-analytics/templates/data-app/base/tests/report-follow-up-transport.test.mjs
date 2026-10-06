import assert from "node:assert/strict";
import test from "node:test";

import { dataAppActionHref, dataAppActionRequest, submitDataAppAction } from "../src/data-app-actions.js";
import { chatGPTPromptUrl, codexDataAppNewTaskUrl, currentDataAppReference, dataAppPromptTarget } from "../src/runtime-environment.js";

const originThread = "550e8400-e29b-41d4-a716-446655440000";
const local = new URL(`file:///private/tmp/report/dist/index.html#codexThreadId=${originThread}`);
const reference = { root: "/private/tmp/report", htmlPath: "/private/tmp/report/dist/index.html" };

function context(extra = {}) {
  return {
    snapshot: { surface: "report", id: "test-report", queries: {
      evidence: { rows: [{ private: "PRIVATE_ROW" }], source: { sql: "PRIVATE_SQL", url: "https://example.com/evidence" } },
    } },
    canEdit: true,
    dataAppReference: reference,
    followUp: { id: "question", narrativeId: "question:body", text: "What changed?", queryId: "evidence" },
    ...extra,
  };
}

function replaceGlobal(t, key, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, key, previous);
    else delete globalThis[key];
  });
}

function captureHandoffs(t, location, threadId) {
  const links = [];
  let sends = 0;
  replaceGlobal(t, "window", { location, openai: {
    sendFollowUpMessage() { sends += 1; return {}; }, sendMessage() { sends += 1; return {}; },
  } });
  replaceGlobal(t, "document", {
    querySelector: () => threadId ? { getAttribute: () => threadId } : null,
    querySelectorAll: () => [],
    createElement: () => ({
      setAttribute() {},
      click() { links.push({ href: this.href, target: this.target }); },
      remove() {},
    }),
    body: { appendChild() {} },
  });
  return { links, sends: () => sends };
}

test("local reader and editor report links share the originating task without exposing it in their prompts", (t) => {
  replaceGlobal(t, "navigator", { userAgent: "Mozilla/5.0 Chrome/140" });
  const transport = captureHandoffs(t, local, originThread);
  for (const location of [local, new URL("http://localhost:5173/")]) {
    for (const action of ["report-investigate", "report-investigate-update", "report-correct"]) {
      const href = new URL(dataAppActionHref(action, context(), location));
      assert.equal(`${href.protocol}//${href.host}${href.pathname}`, `codex://threads/${originThread}`);
      assert.deepEqual(href.searchParams.get("prompt").match(/\[@[^\]]+\]\(plugin:\/\/[^)]+\)/gu), [
        "[@Data](plugin://data-analytics@openai-curated-remote)",
      ]);
      assert.match(href.searchParams.get("prompt"), /What changed\?/u);
      assert.deepEqual([...href.searchParams.keys()], ["prompt", ...(location.protocol === "file:"
        ? [] : ["browserUrl"])]);
      assert.doesNotMatch(href.searchParams.get("prompt"), /550e8400|codexThreadId|PRIVATE_/u);
      assert.equal(dataAppPromptTarget(href), "_self");
    }
  }
  assert.equal(transport.sends(), 0);
});

test("prepare links and imperative handoffs preserve the same draft intent without host submission", async (t) => {
  replaceGlobal(t, "navigator", { userAgent: "Mozilla/5.0 Chrome/140" });
  const transport = captureHandoffs(t, local, originThread);
  const draft = context({ canEdit: false, followUp: { ...context().followUp, text: "Current edited recommendation",
    intent: "prepare", deliverable: "recovery flow" } });
  const href = new URL(dataAppActionHref("report-investigate", draft, local));
  assert.equal(`${href.protocol}//${href.host}${href.pathname}`, `codex://threads/${originThread}`);
  const prompt = href.searchParams.get("prompt");
  const payload = JSON.parse(prompt.slice(prompt.indexOf("\n\n{") + 2));
  assert.equal(payload.text, "Current edited recommendation");
  assert.deepEqual(payload.request, { intent: "prepare", deliverable: "recovery flow" });
  assert.doesNotMatch(prompt, /PRIVATE_/u);
  assert.equal(await submitDataAppAction("report-investigate", draft), true);
  assert.deepEqual(transport.links, [{ href: href.href, target: "_self" }]);
  assert.equal(transport.sends(), 0);
});

test("Windows preview investigations and draft links in Codex retain the exact local project", (t) => {
  replaceGlobal(t, "navigator", { userAgent: "CodexBrowser" });
  const preview = new URL("http://localhost:5173/?token=private");
  for (const root of ["C:\\work\\quarterly report", "d:/work/quarterly report"]) {
    const dataAppReference = currentDataAppReference(preview, root);
    for (const intent of ["investigate", "prepare"]) {
      const followUp = { ...context().followUp, intent, ...(intent === "prepare" ? { deliverable: "recovery flow" } : {}) };
      const href = new URL(dataAppActionHref("report-investigate", context({ canEdit: false, dataAppReference, followUp }), preview));
      assert.equal(`${href.protocol}//${href.host}${href.pathname}`, "codex://new");
      assert.equal(href.searchParams.get("path"), root);
      const prompt = href.searchParams.get("prompt");
      assert.equal(href.searchParams.get("browserUrl"), "http://localhost:5173/");
      assert.match(prompt, /read its current Data app context/u);
      assert.doesNotMatch(prompt, /"report"|token=private/u);
    }
  }
});

test("handoff fallbacks keep only safe hosted or local context and prepare web composers", () => {
  const hosted = new URL(`https://viewer:secret@report.openai.chatgpt.site/_data/components/question?token=private#codexThreadId=${originThread}`);
  const desktop = codexDataAppNewTaskUrl("Investigate", reference, hosted, "ChatGPTBrowser Chrome/140");
  assert.equal(`${desktop.protocol}//${desktop.host}${desktop.pathname}`, "codex://new");
  assert.equal(desktop.searchParams.get("browserUrl"), "https://report.openai.chatgpt.site/");
  assert.deepEqual([...desktop.searchParams.keys()], ["prompt", "browserUrl"]);
  assert.doesNotMatch(desktop.toString(), /viewer|secret|private|codexThreadId|550e8400/u);
  for (const location of [hosted, new URL("http://localhost:5173/?token=private")]) {
    const web = codexDataAppNewTaskUrl("Investigate", reference, location, "Mozilla/5.0", "web");
    assert.equal(web.href, "https://chatgpt.com/?q=Investigate&disable_auto_send=1");
    assert.equal(dataAppPromptTarget(web), "_blank");
  }
  for (const root of ["relative/path", "C:work\\report", "\\work\\report", "//network/path", "\\\\server\\share",
    "\\\\?\\C:\\work\\report", "/\\server/share", "/tmp/report\nsecret", "C:\\work\\report\nsecret", "C:/work/report\u0000",
    "/tmp/report\u007f", `C:/${"x".repeat(2046)}`, "x".repeat(2050)]) {
    assert.equal(codexDataAppNewTaskUrl("Investigate", { root }, new URL("file:///private/tmp/report/dist/index.html"),
      "CodexBrowser").searchParams.has("path"), false);
  }
  const unsafe = codexDataAppNewTaskUrl("Investigate", reference,
    new URL("https://report.openai.chatgpt.site/tokens/private-value"), "ChatGPTBrowser");
  assert.equal(unsafe.searchParams.has("browserUrl"), false);
  assert.throws(() => codexDataAppNewTaskUrl(" ", reference, local), /requires a prompt/u);
});

test("report task links use the shared current and legacy Codex browser detection", () => {
  const hosted = new URL("https://report.openai.chatgpt.site/_data/components/question?token=private");
  for (const userAgent of ["CodexBrowser", "CodexBrowser/1.0", "CodexBrowser Chrome/140", "ChatGPTBrowser/1.0"]) {
    const task = codexDataAppNewTaskUrl("Investigate", reference, hosted, userAgent);
    assert.equal(`${task.protocol}//${task.host}${task.pathname}`, "codex://new");
    assert.equal(task.searchParams.get("browserUrl"), "https://report.openai.chatgpt.site/");
    assert.deepEqual([...task.searchParams.keys()], ["prompt", "browserUrl"]);
    assert.equal(dataAppPromptTarget(task), "_self");
  }
  for (const userAgent of ["Mozilla/5.0", "CodexBrowserFake", "ChatGPTBrowserFake", "", null, 42]) {
    const task = codexDataAppNewTaskUrl("Investigate", reference, hosted, userAgent);
    assert.equal(task.href, "https://chatgpt.com/?q=Investigate&disable_auto_send=1");
    assert.equal(dataAppPromptTarget(task), "_blank");
  }
});

test("reader and editor handoffs preserve permission checks and bypass installed host send APIs", async (t) => {
  replaceGlobal(t, "navigator", { userAgent: "CodexBrowser" });
  const transport = captureHandoffs(t, local, originThread);
  const editorOnly = { ...context().followUp, editorOnly: true };
  assert.throws(() => dataAppActionHref("report-investigate", context({ canEdit: false, followUp: editorOnly }), local), /Editing permission/u);
  await assert.rejects(submitDataAppAction("report-investigate", context({ canEdit: false, followUp: editorOnly })), /Editing permission/u);
  for (const action of ["report-investigate-update", "report-correct"]) {
    assert.throws(() => dataAppActionHref(action, context({ canEdit: false }), local), /Editing permission/u);
    await assert.rejects(submitDataAppAction(action, context({ canEdit: false })), /Editing permission/u);
  }
  assert.deepEqual(transport.links, [], "Permission failures must not open a handoff");
  for (const action of ["report-investigate", "report-investigate-update", "report-correct"]) {
    const href = dataAppActionHref(action, context(), local);
    assert.equal(await submitDataAppAction(action, context()), true);
    assert.deepEqual(transport.links.at(-1), { href, target: "_self" });
  }
  assert.equal(transport.links.length, 3);
  assert.equal(transport.sends(), 0);
  const ordinary = chatGPTPromptUrl("Existing action", local);
  assert.equal(`${ordinary.protocol}//${ordinary.host}${ordinary.pathname}`, `codex://threads/${originThread}`);
  const update = new URL(dataAppActionHref("report-investigate-update", context(), local));
  assert.equal(`${update.protocol}//${update.host}${update.pathname}`, `codex://threads/${originThread}`);
});

test("static report exports include reader-visible disclosure contents, not controls or private notes", () => {
  for (const action of ["word", "powerpoint", "google-docs", "google-slides"]) {
    const report = dataAppActionRequest(action, { ...context(), surface: "report" }).prompt;
    assert.match(report, /reader-visible collapsed evidence, methods, and the full follow-up text/u);
    assert.match(report, /Omit action controls, editor-only content, and hidden content/u);
    assert.match(report, /not transient disclosure open\/closed state/u);
    const dashboard = dataAppActionRequest(action, { ...context(), surface: "dashboard" }).prompt;
    assert.doesNotMatch(dashboard, /reader-visible collapsed evidence/u);
  }
  for (const action of ["jupyter-notebook", "sites"]) {
    assert.doesNotMatch(dataAppActionRequest(action, { ...context(), surface: "report" }).prompt, /reader-visible collapsed evidence/u);
  }
});
