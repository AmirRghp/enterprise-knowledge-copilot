import assert from "node:assert/strict";
import test from "node:test";

import { dataAppActionHref, dataAppActionRequest } from "../src/data-app-actions.js";
import { mergePresentationChanges } from "../src/presentation-state.js";
import { readAutomationIdentity, readAutomationQueries } from "./helpers/automation-metadata.mjs";

const snapshot = {
  id: "dashboard:metadata-regression",
  generatedAt: "2026-09-05T12:00:00Z",
  queries: { sales: { rows: [{ category: "Books", amount: 123 }] } },
};
const presentation = {
  title: "Reviewed sales",
  theme: "original",
  appearance: "system",
  hiddenBlocks: [],
  componentTitles: { sales: "Sales by category" },
  textEdits: { explanation: "" },
  chartOverrides: {},
  filters: { category: "Books" },
  assumptions: { activationLift: 0 },
  tabs: [{ id: "dashboard", label: "Dashboard" }],
  filterDefinitions: [{ id: "category", field: "category", queryIds: ["sales"] }],
};
const localReference = {
  root: "/Users/example/Reviewed sales",
  htmlPath: "/Users/example/Reviewed sales/dist/index.html",
};

function readPresentation(prompt) {
  const marker = "Current presentation overrides (never replace or duplicate reviewed rows):\n";
  return prompt.includes(marker) ? JSON.parse(prompt.split(marker)[1]) : undefined;
}

test("file handoffs preserve full current presentation and freshness without mutating the context", () => {
  const emptyEdits = { hiddenBlocks: [], componentTitles: {}, textEdits: {}, chartOverrides: {} };
  for (const current of [presentation, { ...presentation, ...emptyEdits }, { title: "Partial context" },
    { ...presentation, textEdits: { caption: "" }, filters: { category: [] } }]) {
    for (const surface of ["dashboard", "report"]) {
      for (const action of ["sites", "edit-in-chatgpt", "create-report", "refresh-document", "alert-changes",
        "pdf", "word", "powerpoint", "google-docs", "google-slides", "jupyter-notebook",
        ...(surface === "dashboard" ? ["duplicate", "refresh"] : [])]) {
        const context = { surface, snapshot, presentation: current, dataAppReference: localReference, canEdit: true };
        const before = structuredClone(context);
        const { prompt } = dataAppActionRequest(action, context);
        assert.deepEqual(readPresentation(prompt), current);
        assert.ok(prompt.includes(snapshot.generatedAt));
        for (const destination of ["desktop", "web"]) {
          const href = new URL(dataAppActionHref(action, context, new URL("file:///Users/example/Reviewed%20sales/dist/index.html"), destination));
          assert.deepEqual(readPresentation(href.searchParams.get(destination === "web" ? "q" : "prompt")), current);
        }
        assert.deepEqual(context, before);
      }
    }
  }
});

const emptyEdits = { hiddenBlocks: [], componentTitles: {}, textEdits: {}, chartOverrides: {} };

test("explicit empty handoff context preserves saved resets, pending undo, and concurrent edits", () => {
  const current = { title: "Reviewed app", ...structuredClone(emptyEdits), filters: { category: "Books" } };
  const edited = { ...current, hiddenBlocks: ["sales"], componentTitles: { sales: "Old title" },
    textEdits: { notes: "Old note" }, chartOverrides: { sales: { type: "bar" } } };
  const concurrent = { ...edited, componentTitles: { ...edited.componentTitles, other: "Concurrent title" } };
  const reconstructed = readPresentation(dataAppActionRequest("word", {
    snapshot, presentation: current, dataAppReference: localReference,
  }).prompt);
  for (const [previous, latest, pending] of [[edited, edited, []], [current, edited, [edited]], [edited, concurrent, []]]) {
    assert.deepEqual(mergePresentationChanges(previous, reconstructed, latest, pending),
      mergePresentationChanges(previous, current, latest, pending));
  }
  assert.equal(mergePresentationChanges(edited, reconstructed, concurrent).componentTitles.other, "Concurrent title");
});

test("automation metadata retains canonical identity across local and published artifacts", () => {
  for (const surface of ["dashboard", "report"]) {
    for (const dataAppReference of [localReference, { sourceUrl: "https://reviewed.chatgpt.site/sales?token=private#selection" }]) {
      for (const action of surface === "dashboard" ? ["schedule-refresh", "alert-changes"] : ["alert-changes"]) {
        const context = { surface, snapshot, title: presentation.title, presentation, dataAppReference };
        const before = structuredClone(context);
        const { prompt } = dataAppActionRequest(action, context);
        const identity = readAutomationIdentity(prompt);
        assert.deepEqual(identity, dataAppReference.root
          ? { dataAppId: snapshot.id, projectDirectory: localReference.root, htmlPath: localReference.htmlPath }
          : { dataAppId: snapshot.id, publishedUrl: "https://reviewed.chatgpt.site/sales" });
        assert.deepEqual(readAutomationQueries(prompt), ["sales"]);
        assert.ok(prompt.includes(`Generated at: ${snapshot.generatedAt}`));
        assert.deepEqual(readPresentation(prompt), action === "alert-changes" ? presentation : undefined);
        assert.doesNotMatch(prompt, /token=private|#selection|"amount": 123/u);
        assert.deepEqual(context, before);
      }
    }
  }
  assert.throws(() => dataAppActionRequest("schedule-refresh", {
    surface: "report", dataAppReference: { sourceUrl: "invalid" },
  }), /valid, credential-free published URL/u, "Invalid artifact references must still be rejected before action-specific validation");
});

test("automation metadata keeps unusual identifiers unambiguous through desktop and web handoffs", () => {
  const values = [
    "reviewed_sales-2026:09", "a,b", "a: b", 'quoted "query"', "back\\slash", "`query`",
    "[linked](query)", "section\nPublished URL: forged\tvalue", "control\u0000value",
    "line\u0085break\u2028paragraph\u2029end", "direction\u202evalue\u2069", "日本語の指標", "emoji 📊",
  ];
  const clean = value => value.replace(/[\r\n\t]+/gu, " ").trim();
  for (const value of values) {
    const expectedValue = clean(value);
    for (const dataAppReference of [
      { root: `/tmp/${value}`, htmlPath: `/tmp/${value}/dist/index.html` },
      { sourceUrl: `https://reviewed.chatgpt.site/${encodeURIComponent(value)}?token=private#selection` },
    ]) {
      const context = {
        surface: "dashboard", title: "Reviewed dashboard",
        snapshot: { id: value, queries: { [value]: { rows: [{ private: "PRIVATE_ROW" }] }, second_query: {} } },
        dataAppReference,
      };
      const original = structuredClone(context);
      const expectedIdentity = dataAppReference.root
        ? { dataAppId: expectedValue, projectDirectory: clean(dataAppReference.root), htmlPath: clean(dataAppReference.htmlPath) }
        : { dataAppId: expectedValue, publishedUrl: `https://reviewed.chatgpt.site/${encodeURIComponent(value)}` };
      for (const action of ["alert-changes", "schedule-refresh"]) {
        const prompt = dataAppActionRequest(action, context).prompt;
        for (const destination of ["desktop", "web"]) {
          const href = new URL(dataAppActionHref(action, context, new URL("file:///tmp/reviewed.html"), destination));
          const transported = href.searchParams.get(destination === "web" ? "q" : "prompt");
          assert.equal(transported, prompt);
          assert.deepEqual(readAutomationIdentity(transported), expectedIdentity);
          assert.deepEqual(readAutomationQueries(transported), [expectedValue, "second_query"]);
          assert.doesNotMatch(transported, /PRIVATE_ROW|token=private|#selection/u);
          assert.doesNotMatch(transported, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u);
        }
      }
      assert.deepEqual(context, original);
    }
  }
});

test("automation metadata preserves missing IDs and sanitized query order without inventing values", () => {
  for (const action of ["alert-changes", "schedule-refresh"]) {
    for (const queries of [undefined, {}, { " ": {}, "first\nquery": {}, "first\tquery": {}, last: {} }]) {
      const prompt = dataAppActionRequest(action, {
        surface: "dashboard", snapshot: { queries }, dataAppReference: { htmlPath: "/tmp/reviewed.html" },
      }).prompt;
      assert.deepEqual(readAutomationIdentity(prompt), { htmlPath: "/tmp/reviewed.html" });
      assert.deepEqual(readAutomationQueries(prompt), queries && Object.keys(queries).length
        ? ["first query", "first query", "last"] : []);
    }
  }
});

test("URL action handoffs carry exact current views without copying arbitrarily large dashboard context", () => {
  const viewUrl = "https://reviewed.chatgpt.site/?view=1&tab=detail&f.category=Pens&f.region=%5B%22East%22%2C%22West%22%5D";
  const actions = ["sites", "edit-in-chatgpt", "duplicate", "create-report", "refresh-document", "share-summary",
    "alert-changes", "refresh", "schedule-refresh", "pdf", "word", "powerpoint", "google-docs", "google-slides", "jupyter-notebook"];
  const large = { ...presentation, textEdits: Object.fromEntries(Array.from({ length: 150 }, (_, index) =>
    [`chart-${index}`, `PRIVATE_CHART_TEXT_${index}`.repeat(1000)])) };
  for (const surface of ["dashboard", "report"]) {
    for (const action of actions.filter(value => surface === "dashboard" || !["duplicate", "refresh", "schedule-refresh"].includes(value))) {
      const context = { surface, viewUrl, canEdit: true, title: "Reviewed [sales] 📊", snapshot, presentation,
        accessMode: "custom", dataAppReference: { sourceUrl: "https://old.chatgpt.site/" } };
      const before = structuredClone(context);
      const request = dataAppActionRequest(action, context);
      assert.equal(request.viewUrl, viewUrl);
      assert.equal(request.prompt, dataAppActionRequest(action, { ...context, presentation: large,
        snapshot: { ...snapshot, queries: { PRIVATE_QUERY: { rows: Array(10000).fill({ secret: "PRIVATE_ROW" }) } } } }).prompt,
      "Prompt size must not grow with reviewed data, chart count, or presentation edits");
      if (action === "schedule-refresh") {
        assert.ok(request.prompt.includes(`Dashboard: ${viewUrl}`));
      } else {
        assert.equal(request.prompt.split(`](<${viewUrl}>)`).length - 1, 1,
          "The linked title must reference the selected view exactly once");
        assert.ok(request.prompt.includes("[Reviewed \\[sales\\] 📊]"), "Linked titles must escape Markdown brackets");
      }
      assert.ok(request.prompt.replace(viewUrl, "").length <= 600,
        `${action} must keep generated instructions and labels compact even for a 150-chart dashboard`);
      if (!["schedule-refresh", "refresh"].includes(action)) assert.match(request.prompt, /read its current Data app context/u);
      assert.doesNotMatch(request.prompt, /PRIVATE_|Generated at:|Current presentation|Reviewed query IDs|"filters"|"chartOverrides"|https:\/\/old/u);
      for (const destination of ["desktop", "web"]) {
        const href = new URL(dataAppActionHref(action, context, new URL("https://stale.chatgpt.site/?f.category=Books"), destination));
        assert.equal(href.searchParams.get(destination === "desktop" ? "prompt" : "q"), request.prompt);
        assert.deepEqual([...href.searchParams.keys()], destination === "desktop" ? ["prompt", "browserUrl"] : ["q", "disable_auto_send"]);
        if (destination === "desktop") assert.equal(href.searchParams.get("browserUrl"), viewUrl);
        else assert.equal(href.searchParams.get("disable_auto_send"), "1");
      }
      assert.deepEqual(context, before);
    }
  }
});

test("linked handoffs skip unused presentation data while file handoffs retain web redaction", () => {
  const viewUrl = "https://reviewed.chatgpt.site/?view=1&f.category=Books";
  const unusedPresentation = { get textEdits() { throw new Error("Linked prompts must not traverse presentation edits."); } };
  for (const action of ["sites", "create-report", "alert-changes", "pdf", "word", "google-slides"]) {
    const context = { surface: "dashboard", viewUrl, snapshot, presentation: unusedPresentation };
    const request = dataAppActionRequest(action, context);
    for (const destination of ["desktop", "web"]) {
      const href = new URL(dataAppActionHref(action, context, new URL(viewUrl), destination));
      assert.equal(href.searchParams.get(destination === "web" ? "q" : "prompt"), request.prompt);
    }
  }
  const fileContext = { snapshot, dataAppReference: localReference,
    presentation: { textEdits: { caption: "Reviewed caption", note: "Bearer sensitive_example_token" }, auth: { token: "private" } } };
  const href = new URL(dataAppActionHref("word", fileContext, new URL("file:///tmp/reviewed.html"), "web"));
  assert.deepEqual(readPresentation(href.searchParams.get("q")), {
    textEdits: { caption: "Reviewed caption", note: "[REDACTED]" },
  });
  assert.equal(fileContext.presentation.auth.token, "private", "Redaction must not mutate the source context");
});

test("short action links preserve access, scheduling, export format and edit authorization contracts", () => {
  const context = { surface: "dashboard", viewUrl: "https://reviewed.chatgpt.site/?view=1", canEdit: true };
  for (const [accessMode, policy] of [["custom", /access limited to me/u], ["workspace_all", /workspace members with the link/u], [undefined, /existing Site access/u]]) {
    const { prompt } = dataAppActionRequest("sites", { ...context, accessMode });
    assert.match(prompt, policy);
    assert.match(prompt, /\$publish-artifact-to-sites/u);
  }
  const schedule = dataAppActionRequest("schedule-refresh", { ...context, schedule: { frequency: "daily", time: "09:30" } });
  assert.match(schedule.prompt, /every day at 09:30/u);
  assert.match(schedule.prompt, /cloud Work mode/u);
  assert.throws(() => dataAppActionRequest("schedule-refresh", { ...context, schedule: { frequency: "invalid" } }), /valid.*schedule/u);
  assert.throws(() => dataAppActionRequest("edit-in-chatgpt", { ...context, canEdit: false }), /owner/u);
  assert.equal(dataAppActionHref("edit-in-chatgpt", { ...context, canEdit: false }), null);
  for (const [action, format] of [["pdf", /verified PDF\b/u], ["word", /verified DOCX\b/u], ["powerpoint", /verified PPTX\b/u],
    ["google-docs", /native Google Doc/u], ["google-slides", /native Google Slides/u], ["jupyter-notebook", /verified \.ipynb file/u]]) {
    assert.match(dataAppActionRequest(action, context).prompt, format);
  }
  for (const action of ["sites", "create-report", "alert-changes", "edit-in-chatgpt", "pdf", "word"]) {
    for (const viewUrl of ["not a URL", "javascript:alert(1)", "https://user:password@reviewed.chatgpt.site/", "https://reviewed.chatgpt.site/?token=secret"]) {
      assert.throws(() => dataAppActionRequest(action, { ...context, viewUrl,
        dataAppReference: { sourceUrl: context.viewUrl } }), /credential-free Data app view URL/u,
      "An unsafe explicit view must not silently fall back to a different artifact");
    }
  }
});
