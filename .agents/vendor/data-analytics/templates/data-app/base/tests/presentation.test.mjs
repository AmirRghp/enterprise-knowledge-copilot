import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { componentPermalinkId, componentPermalinkShortId } from "../src/chart-permalink.js";
import { semanticColor } from "../src/charting/chart-theme.js";
import { createDataAppWorker, validatePresentation as validateWorkerPresentation } from "../src/data-app-worker.js";
import { VERIFICATION_REMINDER_COOKIE, readVerificationReminderDismissed, rememberVerificationReminderDismissed } from "../src/verification-reminder.js";
import {
  mergePresentationChanges, normalizeAppearance, normalizePresentation, presentationStorageKey,
  presentationVersion, readLocalPresentation, readViewerAppearance, validatePresentation,
  writeLocalPresentation, writeViewerAppearance,
  editHistoryValue, recordPresentationEdit, presentationBeforeEdits,
} from "../src/presentation-state.js";

test("edit history restores deletion/layout changes, branches after undo and excludes reviewed state", () => {
  const original = editHistoryValue({ title: "Test", hiddenBlocks: [], queries: { secret: 1 }, filters: { plan: "A" } });
  const deleted = editHistoryValue({ title: "Test", hiddenBlocks: ["kpi"] });
  let history = { entries: [original], index: 0 };
  history = recordPresentationEdit(history, deleted);
  assert.deepEqual(JSON.parse(history.entries[0]), { title: "Test", hiddenBlocks: [] });
  assert.equal(recordPresentationEdit(history, deleted), history);
  const undone = { ...history, index: 0 };
  assert.equal(JSON.parse(undone.entries[undone.index]).hiddenBlocks.length, 0);
  const moved = editHistoryValue({ title: "Test", blockLayouts: { canvas: { order: ["b", "a"] } } });
  history = recordPresentationEdit(undone, moved);
  assert.deepEqual(history.entries, [original, moved], "New edits discard the redo branch");
  for (let i = 0; i < 120; i++) history = recordPresentationEdit(history, editHistoryValue({ title: `Edit ${i}` }));
  assert.equal(history.entries.length, 101);
  assert.deepEqual(recordPresentationEdit(history, original, false), { entries: [original], index: 0 });
});

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key), values };
}

let presentationHookHarnessIndex = 0;

async function presentationPersistenceHarness(initialPresentation, { deferResponses = false } = {}) {
  const binding = `__dataAppPresentationHookHarness${process.pid}_${presentationHookHarnessIndex += 1}`;
  const hooks = [];
  const effects = [];
  const timers = new Map();
  const requests = [];
  const pendingResponses = [];
  const endpoints = [];
  const cookies = { value: "", reads: 0, writes: [], blocked: false, denied: false };
  const reminderEnvironment = {
    location: new URL("https://dashboard.example.chatgpt.site/"),
    document: {
      get cookie() {
        cookies.reads += 1;
        if (cookies.denied) throw new Error("Cookies unavailable");
        return cookies.value;
      },
      set cookie(value) {
        cookies.writes.push(value);
        if (cookies.denied) throw new Error("Cookies unavailable");
        if (!cookies.blocked) cookies.value = value.split(";")[0];
      },
    },
  };
  const snapshot = { id: `presentation-hook-${presentationHookHarnessIndex}` };
  const server = { presentation: structuredClone(initialPresentation), revision: 0 };
  let cursor = 0;
  let nextTimer = 0;
  let pendingEffects = [];
  let deferred = deferResponses;

  function response(status, value) {
    return { status, ok: status >= 200 && status < 300, json: async () => structuredClone(value) };
  }

  globalThis[binding] = {
    useState(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (next) => {
        hooks[index] = typeof next === "function" ? next(hooks[index]) : next;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!Object.hasOwn(hooks, index)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      if (!effects[index] || dependencies.some((dependency, position) =>
        !Object.is(dependency, effects[index].dependencies[position]))) {
        pendingEffects.push({ index, effect, dependencies });
      }
    },
    setTimeout(callback, delay) {
      assert.equal(delay, 300);
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async fetch(endpoint, options) {
      endpoints.push(endpoint);
      assert.equal(endpoint, "/api/presentation");
      const request = JSON.parse(options.body);
      requests.push(structuredClone(request));
      if (deferred) {
        return new Promise((resolve, reject) => pendingResponses.push({ request, resolve, reject }));
      }
      if (request.revision !== server.revision) {
        return response(409, { presentation: server.presentation, revision: server.revision });
      }
      const existingVerification = server.presentation.verification;
      server.presentation = structuredClone(request.presentation);
      if (request.verificationAction === "verify") {
        server.presentation.verification = existingVerification ?? {
          verifiedBy: "server-owner@example.com", verifiedAt: "2026-08-17T19:34:56.789Z",
        };
      } else if (request.verificationAction === "remove") {
        delete server.presentation.verification;
      }
      server.revision += 1;
      return response(200, { presentation: server.presentation, revision: server.revision });
    },
  };

  const source = (await readFile(new URL("../src/use-presentation.js", import.meta.url), "utf8"))
    .replace('import { useEffect, useLayoutEffect, useRef, useState } from "react";',
      `const { useEffect, useRef, useState, setTimeout, clearTimeout, fetch } = globalThis[${JSON.stringify(binding)}];`)
    .replace('import { editHistoryValue, recordPresentationEdit, mergePresentationChanges, normalizePresentation, validatePresentation, writeLocalPresentation } from "./presentation-state.js";',
      `import { editHistoryValue, recordPresentationEdit, mergePresentationChanges, normalizePresentation, validatePresentation, writeLocalPresentation } from "${
        new URL("../src/presentation-state.js", import.meta.url).href
      }";`)
    .replace('from "./verification-reminder.js";', `from "${new URL("../src/verification-reminder.js", import.meta.url).href}";`)
    .replace('from "./refresh-coachmark.js";', `from "${new URL("../src/refresh-coachmark.js", import.meta.url).href}";`);
  const directory = await mkdtemp(join(tmpdir(), "data-app-presentation-hook-"));
  const modulePath = join(directory, "use-presentation.mjs");
  let usePresentationPersistence, useVerificationReminder;
  try {
    await writeFile(modulePath, source);
    ({ usePresentationPersistence, useVerificationReminder } = await import(pathToFileURL(modulePath).href));
  } catch (error) {
    delete globalThis[binding];
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  return {
    requests,
    server,
    timers,
    pendingResponses,
    endpoints,
    cookies,
    renderReminder(environment = reminderEnvironment) {
      cursor = 0;
      pendingEffects = [];
      const value = useVerificationReminder(environment);
      assert.equal(pendingEffects.length, 0, "Reminder state must not schedule rendering side effects");
      return value;
    },
    render(presentation, options = {}) {
      cursor = 0;
      pendingEffects = [];
      usePresentationPersistence({ snapshot, hosted: true, presentation, initialPresentation, ...options });
      for (const { index, effect, dependencies } of pendingEffects) {
        effects[index]?.cleanup?.();
        effects[index] = { dependencies, cleanup: effect() };
      }
    },
    async flush() {
      const scheduled = [...timers.values()];
      timers.clear();
      await Promise.all(scheduled.map((callback) => callback()));
    },
    start() {
      const scheduled = [...timers.values()];
      timers.clear();
      assert.equal(scheduled.length, 1);
      return scheduled[0]();
    },
    respond(index, { status = 200, presentation, revision, error } = {}) {
      const pending = pendingResponses[index];
      assert.ok(pending, `Deferred response ${index} does not exist`);
      if (status >= 200 && status < 300 && revision >= server.revision) {
        server.presentation = structuredClone(presentation);
        server.revision = revision;
      }
      pending.resolve(response(status, status >= 200 && status < 300 || status === 409
        ? { presentation, revision } : { error: error ?? "A stale request failed." }));
    },
    resumeResponses() {
      deferred = false;
    },
    status() {
      return hooks[0];
    },
    dispose() {
      for (const effect of effects) effect?.cleanup?.();
      delete globalThis[binding];
    },
  };
}

test("reminder rendering never reads cookies, requests data, or schedules work", async () => {
  const harness = await presentationPersistenceHarness({});
  try {
    harness.cookies.denied = true;
    for (let render = 0; render < 100; render += 1) assert.equal(harness.renderReminder().dismissed, false);
    assert.equal(harness.cookies.reads, 0);
    assert.equal(harness.cookies.writes.length, 0);
    assert.equal(harness.endpoints.length, 0);
    assert.equal(harness.timers.size, 0);
  } finally { harness.dispose(); }
});

test("verification clicks observe workspace cookie changes without polling or shared writes", async () => {
  const harness = await presentationPersistenceHarness({ title: "Unchanged" });
  try {
    assert.equal(harness.renderReminder().check(), false);
    assert.equal(harness.cookies.reads, 1);
    assert.equal(harness.cookies.writes.length, 0);
    assert.equal(harness.renderReminder().remember(), true);
    assert.equal(harness.cookies.writes.length, 1);
    const readsAfterConfirm = harness.cookies.reads;
    for (let render = 0; render < 100; render += 1) assert.equal(harness.renderReminder().dismissed, true);
    assert.equal(harness.cookies.reads, readsAfterConfirm);
    harness.cookies.value = "";
    assert.equal(harness.renderReminder().check(), false, "Clearing the cookie re-enables confirmation on the next click");
    assert.equal(harness.renderReminder().dismissed, false);
    harness.cookies.value = `${VERIFICATION_REMINDER_COOKIE}=1`;
    assert.equal(harness.renderReminder().check(), true, "Already-open dashboards observe another dashboard's dismissal");
    assert.equal(harness.cookies.writes.length, 1, "Reading a dismissal never renews or rewrites the cookie");
    assert.equal(harness.endpoints.length, 0);
    assert.equal(harness.timers.size, 0);
    assert.deepEqual(harness.server, { presentation: { title: "Unchanged" }, revision: 0 });
  } finally { harness.dispose(); }
});

test("blocked cookie writes keep confirmation enabled and can recover without network requests", async () => {
  for (const failure of ["blocked", "denied"]) {
    const harness = await presentationPersistenceHarness({});
    try {
      harness.cookies[failure] = true;
      assert.equal(harness.renderReminder().remember(), false);
      assert.equal(harness.renderReminder().dismissed, false);
      assert.equal(harness.renderReminder().check(), false);
      harness.cookies[failure] = false;
      assert.equal(harness.renderReminder().remember(), true);
      assert.equal(harness.renderReminder().dismissed, true);
      assert.equal(harness.cookies.writes.length, 2);
      assert.equal(harness.endpoints.length, 0);
    } finally { harness.dispose(); }
  }
});

test("dashboard appearance validates author defaults and keeps viewer overrides local", () => {
  const snapshot = { id: "appearance-dashboard" };
  const storage = memoryStorage();
  assert.equal(normalizeAppearance("unknown"), "system");
  assert.deepEqual(validatePresentation({ appearance: "dark" }), { appearance: "dark" });
  assert.throws(() => validatePresentation({ appearance: "unknown" }), /Appearance must be/);
  assert.equal(writeViewerAppearance(snapshot, "light", storage), true);
  assert.equal(readViewerAppearance(snapshot, storage), "light");
  assert.equal(readViewerAppearance({ id: "other-dashboard" }, storage), "");
  assert.equal(writeViewerAppearance(snapshot, "", storage), true);
  assert.equal(readViewerAppearance(snapshot, storage), "");
});

test("semantic chart colors preserve dimension identity across reviewed queries and reordering", () => {
  assert.equal(semanticColor({ dimension: "plan", value: "Pro" }),
    semanticColor({ dimension: "plan", value: "Pro", index: 7 }));
  assert.notEqual(semanticColor({ dimension: "plan", value: "Pro" }),
    semanticColor({ dimension: "product", value: "Pro" }));
  assert.equal(semanticColor({ field: "revenue", explicitColor: "#123456" }), "#123456");
});

test("presentation rejects removed chart annotations rather than persisting nested reviewed data", () => {
  assert.throws(() => validatePresentation({ chartOverrides: {
    trend: { referenceLines: [{ axis: "y", value: 1, rows: [{ amount: 1 }] }] },
  } }), /annotations are not supported/);
});

test("presentation preserves bounded authored annotation references without accepting data payloads", () => {
  const spec = { type: "line", x: "date", y: "value", annotations: [
    { id: "target", kind: "benchmark", label: "Reviewed target", field: "target", measure: "value" },
  ] };
  assert.deepEqual(validatePresentation({ chartOverrides: { trend: spec } }).chartOverrides.trend, spec);
  for (const extra of [{ rows: [{ value: 2 }] }, { value: 42 }, { sql: "select 1" }, { source: { secret: true } }]) {
    assert.throws(() => validatePresentation({ chartOverrides: { trend: {
      ...spec, annotations: [{ ...spec.annotations[0], ...extra }],
    } } }), /unsupported fields/u);
  }
});

test("annotation visibility is an optional boolean and never bypasses annotation validation", () => {
  const spec = { type: "line", x: "date", y: "value", annotations: [
    { id: "target", kind: "benchmark", label: "Reviewed target", field: "target", measure: "value" },
  ] };
  const validate = (chart) => validatePresentation({ chartOverrides: { trend: chart } }).chartOverrides.trend;
  assert.equal(Object.hasOwn(validate(spec), "showAnnotations"), false);
  for (const showAnnotations of [false, true]) {
    assert.deepEqual(validate({ ...spec, showAnnotations }), { ...spec, showAnnotations });
  }
  for (const showAnnotations of [null, undefined, "false", "true", 0, 1, [], {}]) {
    assert.throws(() => validate({ ...spec, showAnnotations }), /boolean/i);
  }
  assert.throws(() => validate({ ...spec, showAnnotations: false,
    annotations: [{ ...spec.annotations[0], rows: [{ value: 42 }] }],
  }), /unsupported fields/u);
});

test("local annotation visibility round trips without changing reviewed data or authored annotations", () => {
  const snapshot = { id: "annotation-visibility", queries: { reviewed: { rows: [{ value: 42, target: 50 }] } } };
  const before = structuredClone(snapshot);
  const spec = { type: "line", x: "date", y: "value", annotations: [
    { id: "target", kind: "benchmark", label: "Reviewed target", field: "target", measure: "value" },
  ] };
  const storage = memoryStorage();
  for (const setting of [{}, { showAnnotations: false }, { showAnnotations: true }]) {
    const presentation = { chartOverrides: { trend: { ...spec, ...setting } } };
    assert.equal(writeLocalPresentation(snapshot, presentation, storage), true);
    assert.deepEqual(readLocalPresentation(snapshot, storage), presentation);
    assert.deepEqual(readLocalPresentation(snapshot, storage).chartOverrides.trend.annotations, spec.annotations);
  }
  assert.deepEqual(snapshot, before);
});

test("presentation text edits and component titles accept only bounded authored strings", () => {
  for (const key of ["componentTitles", "textEdits"]) {
    assert.deepEqual(validatePresentation({ [key]: { "component:label": "Reviewed label" } }), {
      [key]: { "component:label": "Reviewed label" },
    });
    for (const invalid of [{ value: { rows: [{ amount: 42 }] } }, { value: 42 },
      { value: "   " }, { value: "x".repeat(20_001) }, { " ": "Visible copy" },
      { ["x".repeat(201)]: "Visible copy" }]) {
      assert.throws(() => validatePresentation({ [key]: invalid }), /bounded text values/u);
    }
    assert.deepEqual(normalizePresentation({ [key]: {
      keep: "Visible copy", nested: { rows: [{ amount: 42 }] }, empty: " ",
    } }), { [key]: { keep: "Visible copy" } });
  }
});

test("cleared narrative text survives validation and local storage without allowing empty titles", () => {
  const presentation = { textEdits: { "finding:body": "" } };
  assert.deepEqual(validatePresentation(presentation), presentation);
  const snapshot = { id: "cleared-narrative" };
  const storage = memoryStorage();
  assert.equal(writeLocalPresentation(snapshot, presentation, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), presentation);
  assert.throws(() => validatePresentation({ componentTitles: { finding: "" } }), /nonempty titles/u);
  assert.deepEqual(normalizePresentation({ componentTitles: { finding: "" } }), { componentTitles: {} });
});

test("dashboard verification accepts only a bounded creator email and canonical UTC timestamp", () => {
  const verification = { verifiedBy: "creator@example.com", verifiedAt: "2026-08-17T19:34:56.789Z" };
  assert.deepEqual(validatePresentation({ verification }), { verification });
  assert.deepEqual(normalizePresentation({ verification: {
    verifiedBy: "  CREATOR@EXAMPLE.COM  ", verifiedAt: verification.verifiedAt,
  } }), { verification });

  for (const invalid of [
    null, "verified", true, [], {},
    { verifiedBy: verification.verifiedBy },
    { verifiedAt: verification.verifiedAt },
    { ...verification, rows: [{ amount: 42 }] },
    { ...verification, provenance: "fabricated" },
    { ...verification, verifiedBy: "" },
    { ...verification, verifiedBy: "   " },
    { ...verification, verifiedBy: "creator" },
    { ...verification, verifiedBy: "creator@example" },
    { ...verification, verifiedBy: `${"x".repeat(245)}@example.com` },
    { ...verification, verifiedBy: 42 },
    { ...verification, verifiedAt: "" },
    { ...verification, verifiedAt: "2026-08-17" },
    { ...verification, verifiedAt: "2026-08-17T19:34:56Z" },
    { ...verification, verifiedAt: "2026-08-17T19:34:56.789+00:00" },
    { ...verification, verifiedAt: "2026-02-30T19:34:56.789Z" },
    { ...verification, verifiedAt: 1_787_017_896_789 },
  ]) {
    assert.throws(() => validatePresentation({ verification: invalid }), /Verification must contain/u);
    assert.deepEqual(normalizePresentation({ verification: invalid }), {});
  }
});

test("verified dashboard metadata persists and merges as one protected presentation field", () => {
  const snapshot = { id: "verified-dashboard" };
  const verification = { verifiedBy: "creator@example.com", verifiedAt: "2026-08-17T19:34:56.789Z" };
  const original = { title: "Reviewed dashboard", verification };
  const storage = memoryStorage();

  assert.equal(writeLocalPresentation(snapshot, original, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), original);
  assert.deepEqual(mergePresentationChanges(original, { ...original, title: "Updated dashboard" }, original), {
    title: "Updated dashboard", verification,
  });
  assert.deepEqual(mergePresentationChanges(original, { title: original.title }, original), {
    title: original.title,
  });
  assert.deepEqual(mergePresentationChanges({ title: original.title }, original, {
    title: "Concurrent update",
  }), { title: "Concurrent update", verification });
});

test("debounced hosted saves retain rapid verification changes and unrelated creator edits", async () => {
  const verification = { verifiedBy: "creator@example.com", verifiedAt: "2026-08-17T19:34:56.789Z" };
  for (const { label, initial, toggled, edited } of [
    {
      label: "verify",
      initial: { title: "Reviewed dashboard" },
      toggled: { title: "Reviewed dashboard", verification },
      edited: { title: "Updated dashboard", verification },
    },
    {
      label: "unverify",
      initial: { title: "Reviewed dashboard", verification },
      toggled: { title: "Reviewed dashboard" },
      edited: { title: "Updated dashboard" },
    },
  ]) {
    const harness = await presentationPersistenceHarness(initial);
    try {
      harness.render(initial);
      harness.render(toggled);
      assert.equal(harness.timers.size, 1, `${label}: toggling should schedule one hosted save`);
      harness.render(edited);
      assert.equal(harness.timers.size, 1, `${label}: a rapid edit should replace the earlier debounce timer`);
      await harness.flush();

      assert.equal(harness.requests.length, 1, `${label}: both creator changes should use one hosted write`);
      assert.deepEqual(harness.requests[0], { presentation: edited, revision: 0 },
        `${label}: the later edit must not discard a verification toggle from its canceled timer`);
      assert.deepEqual(harness.server.presentation, edited);
    } finally {
      harness.dispose();
    }
  }
});

test("debounced verification writes preserve conflict merges and later acknowledged creator edits", async () => {
  const initial = { title: "Reviewed dashboard", theme: "original" };
  const verification = { verifiedBy: "creator@example.com", verifiedAt: "2026-08-17T19:34:56.789Z" };
  const toggled = { ...initial, verification };
  const edited = { ...toggled, title: "Updated dashboard" };
  const harness = await presentationPersistenceHarness(initial);
  try {
    harness.render(initial);
    harness.render(toggled);
    harness.render(edited);
    harness.server.presentation = { ...initial, theme: "scientific-blue" };
    harness.server.revision = 1;
    await harness.flush();

    assert.equal(harness.requests.length, 2, "A stale verification write must retry its server conflict once");
    assert.deepEqual(harness.requests.map(({ revision }) => revision), [0, 1]);
    assert.deepEqual(harness.server.presentation, {
      title: "Updated dashboard", theme: "scientific-blue", verification,
    }, "A debounced verification and title change must retain the concurrent server-side theme");

    const subsequent = { ...edited, componentTitles: { revenue: "Recognized revenue" } };
    harness.render(subsequent);
    await harness.flush();
    assert.deepEqual(harness.server.presentation, {
      title: "Updated dashboard", theme: "scientific-blue", verification,
      componentTitles: { revenue: "Recognized revenue" },
    }, "Later acknowledged edits must remain rebased on the earlier conflict merge");
  } finally {
    harness.dispose();
  }
});

test("verification intents expose only server-acknowledged badge metadata and preserve immediate creator edits", async () => {
  const initial = { title: "Reviewed dashboard" };
  const acknowledgements = [];
  const onAcknowledged = (presentation, action) => acknowledgements.push({
    presentation: structuredClone(presentation), action,
  });
  const harness = await presentationPersistenceHarness(initial);
  try {
    harness.render(initial, { onAcknowledged });
    harness.render(initial, { verificationAction: "verify", onAcknowledged });
    assert.equal(harness.timers.size, 1,
      "A server-side verification intent must schedule a save without fabricated local badge metadata");

    const edited = { title: "Updated dashboard" };
    harness.render(edited, { verificationAction: "verify", onAcknowledged });
    assert.equal(harness.timers.size, 1,
      "An immediate creator edit must preserve the pending verification action in the same debounced save");
    assert.equal(acknowledgements.length, 0,
      "The creator must not see verified metadata before the trusted Worker acknowledges its stamp");
    await harness.flush();

    assert.deepEqual(harness.requests[0], {
      presentation: edited, revision: 0, verificationAction: "verify",
    }, "Verification requests must carry only an explicit action, never a client-fabricated identity");
    assert.deepEqual(acknowledgements, [{
      action: "verify", presentation: { ...edited, verification: {
        verifiedBy: "server-owner@example.com", verifiedAt: "2026-08-17T19:34:56.789Z",
      } },
    }], "The displayed badge must use only the Worker-returned authoritative verification record");

    const acknowledged = acknowledgements[0].presentation;
    harness.render(acknowledged, { onAcknowledged });
    assert.equal(harness.timers.size, 0,
      "Applying the server-stamped verification acknowledgement must not schedule a redundant save");
    harness.render(acknowledged, { verificationAction: "remove", onAcknowledged });
    const removalEdit = { ...acknowledged, title: "Unverified dashboard" };
    harness.render(removalEdit, { verificationAction: "remove", onAcknowledged });
    assert.equal(acknowledgements.length, 1,
      "A persisted badge must remain displayed until server-side removal is acknowledged");
    await harness.flush();

    assert.deepEqual(harness.requests[1], {
      presentation: removalEdit, revision: 1, verificationAction: "remove",
    }, "Removal must remain explicit and preserve creator edits while the old badge is still acknowledged");
    assert.deepEqual(acknowledgements[1], {
      action: "remove", presentation: { title: "Unverified dashboard" },
    }, "Only the trusted Worker may acknowledge that shared dashboard verification was removed");
  } finally {
    harness.dispose();
  }
});

test("server verification acknowledgements do not save again when the shell reorders presentation fields", async () => {
  const initial = {
    title: "Reviewed dashboard", blockLayouts: { main: { order: ["chart"] } },
    tabs: [{ id: "overview", label: "Overview" }], filters: { region: "all" },
  };
  const acknowledgements = [];
  const onAcknowledged = (saved) => acknowledgements.push(structuredClone(saved));
  const harness = await presentationPersistenceHarness(initial);
  try {
    harness.render(initial, { onAcknowledged });
    harness.render(initial, { verificationAction: "verify", onAcknowledged });
    await harness.flush();
    assert.equal(harness.requests.length, 1);
    assert.equal(acknowledgements.length, 1);

    harness.render({
      title: initial.title,
      verification: acknowledgements[0].verification,
      blockLayouts: initial.blockLayouts,
      tabs: initial.tabs,
      filters: initial.filters,
    }, { onAcknowledged });
    assert.equal(harness.timers.size, 0, "Verification insertion order must not schedule a no-op save");
    await harness.flush();
    assert.equal(harness.requests.length, 1, "Only the explicit verification action should write");
    assert.equal(harness.server.revision, 1);
    assert.equal(acknowledgements.length, 1);
    assert.equal(harness.status(), "saved");
  } finally { harness.dispose(); }
});

test("overlapping stale autosave acknowledgements cannot roll back a newer conflict-preserving baseline", async () => {
  for (const staleResult of ["success", "failure"]) {
    const initial = { title: "Reviewed dashboard", theme: "original" };
    const older = { title: "Older title", theme: "original" };
    const newer = { title: "Newer title", theme: "local-brand" };
    const acknowledgements = [];
    const errors = [];
    const options = {
      onAcknowledged: (presentation) => acknowledgements.push(structuredClone(presentation)),
      onError: (error) => errors.push(error),
    };
    const harness = await presentationPersistenceHarness(initial, { deferResponses: true });
    try {
      harness.render(initial, options);
      harness.render(older, options);
      const olderSave = harness.start();
      harness.render(newer, options);
      const newerSave = harness.start();
      assert.equal(harness.pendingResponses.length, 2,
        `${staleResult}: both in-flight autosaves must overlap`);

      harness.respond(1, { presentation: newer, revision: 2 });
      await newerSave;
      assert.deepEqual(acknowledgements, [newer]);
      assert.equal(harness.status(), "saved");

      if (staleResult === "success") {
        harness.respond(0, { presentation: older, revision: 1 });
      } else {
        harness.respond(0, { status: 500, error: "A stale request failed." });
      }
      await olderSave;
      assert.deepEqual(acknowledgements, [newer],
        `A stale ${staleResult} must not replace a newer authoritative acknowledgement`);
      assert.deepEqual(errors, [], `A stale ${staleResult} must not surface an obsolete autosave error`);
      assert.equal(harness.status(), "saved",
        `A stale ${staleResult} must not roll back a successfully acknowledged save status`);

      harness.resumeResponses();
      harness.server.presentation = { ...newer, theme: "concurrent-remote-brand" };
      harness.server.revision = 3;
      const subsequent = { ...newer, title: "Latest title" };
      harness.render(subsequent, options);
      await harness.flush();

      assert.deepEqual(harness.requests.slice(-2).map(({ revision }) => revision), [2, 3],
        `A stale ${staleResult} must not roll back the next autosave's acknowledged revision`);
      assert.deepEqual(harness.server.presentation, {
        title: "Latest title", theme: "concurrent-remote-brand",
      }, `A stale ${staleResult} must not replay old local changes over a newer concurrent server edit`);
    } finally {
      harness.dispose();
    }
  }
});

test("older successful saves preserve the server baseline without acknowledging a newer failed draft", async () => {
  for (const olderCompletesFirst of [true, false]) {
    const initial = { title: "Original", theme: "original" };
    const older = { ...initial, theme: "first-theme" };
    const newer = { ...initial, theme: "second-theme" };
    const acknowledgements = [];
    const errors = [];
    const options = {
      onAcknowledged: (saved) => acknowledgements.push(structuredClone(saved)),
      onError: (error) => errors.push(error),
    };
    const harness = await presentationPersistenceHarness(initial, { deferResponses: true });
    try {
      harness.render(initial, options);
      harness.render(older, options);
      const olderSave = harness.start();
      harness.render(newer, options);
      const newerSave = harness.start();

      if (olderCompletesFirst) {
        harness.respond(0, { presentation: older, revision: 1 });
        await olderSave;
        assert.equal(harness.status(), "saving", "The newer request is still pending");
        assert.deepEqual(acknowledgements, [], "The older response cannot acknowledge the pending draft");
      }
      harness.respond(1, { status: 500, error: "The newer save failed." });
      await newerSave;
      if (!olderCompletesFirst) {
        harness.respond(0, { presentation: older, revision: 1 });
        await olderSave;
      }
      assert.equal(harness.status(), "error", "An older success must not clear the newer save error");
      assert.deepEqual(errors, ["The newer save failed."]);
      assert.deepEqual(acknowledgements, []);

      harness.resumeResponses();
      harness.server.presentation = { ...older, componentTitles: { remote: "Concurrent title" } };
      harness.server.revision = 2;
      const subsequent = { ...newer, title: "Latest title" };
      harness.render(subsequent, options);
      await harness.flush();
      assert.deepEqual(harness.requests.slice(-2).map(({ revision }) => revision), [1, 2],
        "The older success still supplies the latest known revision for the next save");
      assert.deepEqual(harness.server.presentation, {
        ...subsequent, componentTitles: { remote: "Concurrent title" },
      }, "A later save retains the failed draft and concurrent server changes");
      assert.deepEqual(acknowledgements, [harness.server.presentation]);
      assert.equal(harness.status(), "saved");
    } finally { harness.dispose(); }
  }
});

test("overlapping saves preserve reverted and retained local fields in either response order", async () => {
  const changes = ["restore-theme", "restore-theme-and-edit-title", "retain-theme-and-edit-title"];
  const completionOrders = ["older-before-restore-starts", "older-before-restore-response", "restore-first"];
  for (const { change, completionOrder } of changes.flatMap((change) =>
    completionOrders.map((completionOrder) => ({ change, completionOrder })))) {
    const initial = { title: "Original", theme: "original" };
    const older = { ...initial, theme: "scientific-blue" };
    const current = change === "restore-theme" ? initial
      : { ...(change === "restore-theme-and-edit-title" ? initial : older), title: "Edited title" };
    const acknowledgements = [];
    const errors = [];
    const options = {
      onAcknowledged: (saved) => acknowledgements.push(structuredClone(saved)),
      onError: (error) => errors.push(error),
    };
    const harness = await presentationPersistenceHarness(initial, { deferResponses: true });
    try {
      harness.render(initial, options);
      harness.render(older, options);
      const olderSave = harness.start();
      harness.render(current, options);
      assert.equal(harness.timers.size, 1,
        "Restored and retained fields must remain a pending save while a different draft is in flight");

      if (completionOrder === "older-before-restore-starts") {
        harness.respond(0, { presentation: older, revision: 1 });
        await olderSave;
        assert.deepEqual(acknowledgements, [], "The earlier theme cannot acknowledge the restored theme");
      }
      const restoredSave = harness.start();
      assert.deepEqual(harness.requests[1].presentation, current);
      if (completionOrder === "older-before-restore-response") {
        harness.respond(0, { presentation: older, revision: 1 });
        await olderSave;
        assert.deepEqual(acknowledgements, []);
        assert.equal(harness.status(), "saving");
        harness.server.presentation = { ...older, componentTitles: { remote: "Concurrent title" } };
        harness.server.revision = 2;
        harness.resumeResponses();
        harness.respond(1, { status: 409, presentation: harness.server.presentation, revision: 2 });
        await restoredSave;
        assert.deepEqual(harness.requests.map(({ revision }) => revision), [0, 0, 2]);
        assert.deepEqual(harness.server.presentation, {
          ...current, componentTitles: { remote: "Concurrent title" },
        }, "A conflict retry preserves every desired field and concurrent server edits");
      } else {
        const revision = completionOrder === "restore-first" ? 1 : 2;
        harness.respond(1, { presentation: current, revision });
        await restoredSave;
        if (completionOrder === "restore-first") {
          harness.respond(0, { status: 409, presentation: current, revision });
          await olderSave;
          assert.equal(harness.requests.length, 2, "The superseded theme must not retry after the restoration wins");
        }
        assert.deepEqual(harness.server.presentation, current);
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(acknowledgements, [harness.server.presentation]);
      assert.equal(harness.status(), "saved");
    } finally { harness.dispose(); }
  }
});

test("pending autosave reversions preserve the existing structural layout merge and remote additions", () => {
  const previous = { theme: "original", blockLayouts: { main: { order: ["a", "b", "c", "d"] } } };
  const pending = { theme: "scientific-blue", blockLayouts: { main: { order: ["a", "c", "b", "d"] } } };
  const latest = { ...pending, blockLayouts: {
    main: { order: ["a", "c", "b", "d", "remote"], spans: { remote: 6 } },
    remote: { order: ["summary"] },
  } };
  for (const current of [previous, {
    ...previous, blockLayouts: { main: { order: ["a", "b", "d", "c"] } },
  }]) {
    const existingMerge = mergePresentationChanges(previous, current, latest);
    const withPending = mergePresentationChanges(previous, current, latest, [pending]);
    assert.equal(withPending.theme, "original", "Ordinary autosave fields still replay the creator's reversion");
    assert.deepEqual(withPending.blockLayouts, existingMerge.blockLayouts,
      "Pending autosaves must not apply structural layout edits a second time");
    assert.ok(withPending.blockLayouts.main.order.includes("remote"));
    assert.equal(withPending.blockLayouts.main.spans.remote, 6);
    assert.deepEqual(withPending.blockLayouts.remote, { order: ["summary"] });
  }
});

test("dashboard descriptions remain optional while previously authored descriptions persist and reload", () => {
  const snapshot = { id: "optional-description-dashboard", title: "Product adoption" };
  const storage = memoryStorage();

  assert.deepEqual(normalizePresentation({ title: "Product adoption" }), { title: "Product adoption" });
  assert.equal(writeLocalPresentation(snapshot, { title: "Product adoption" }, storage), true);
  assert.equal(Object.hasOwn(readLocalPresentation(snapshot, storage), "description"), false);

  const authored = { title: "Product adoption", description: "Paid workspaces; excludes trials" };
  assert.equal(writeLocalPresentation(snapshot, authored, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), authored);
});

test("disabled chart zero baselines persist and reload without becoming enabled", () => {
  const snapshot = { id: "focused-waterfall-dashboard", title: "Product adoption" };
  const presentation = { chartOverrides: {
    "growth-drivers": { type: "waterfall", x: "driver", y: "change", startAtZero: false },
  } };
  const storage = memoryStorage();

  assert.equal(writeLocalPresentation(snapshot, presentation, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), presentation);
});

test("presentation stores only bounded presentation changes and isolates dashboard identities", () => {
  const snapshot = { id: "reviewed-dashboard", title: "Original dashboard title" };
  const presentation = {
    theme: "scientific-blue", title: "Edited title", description: "Edited description",
    hiddenBlocks: ["forecast", "forecast"], componentTitles: { revenue: "Recognized revenue" },
    textEdits: { "p:2": "An edited analysis." }, chartOverrides: { trend: { type: "bar" } },
    filters: { region: "West" }, assumptions: { conversion: 12 }, notes: "## Reviewed notes",
    tabs: [{ id: "overview", label: "Overview" }, { id: "details", label: "Details" }],
  };
  const storage = memoryStorage();
  assert.equal(writeLocalPresentation(snapshot, presentation, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), { ...presentation, hiddenBlocks: ["forecast"] });
  assert.deepEqual(readLocalPresentation({ ...snapshot, id: "another-dashboard" }, storage), {});
  const record = JSON.parse([...storage.values.values()][0]);
  assert.equal(record.version, presentationVersion);
  assert.equal(presentationStorageKey(snapshot, "/one") === presentationStorageKey(snapshot, "/two"), false);
  assert.throws(() => validatePresentation({ rows: [{ amount: 42 }] }), /Unsupported presentation fields/);
  assert.throws(() => validatePresentation({ chartOverrides: { trend: { type: "line", rows: [{ amount: 42 }] } } }),
    /reviewed data or provenance/);
  const malformed = { ...presentation, chartOverrides: { trend: {
    type: "line", x: "week", y: ["siteA", "siteB"],
  } } };
  assert.throws(() => validatePresentation(malformed), /Invalid chart "trend": chart\.y.*not an array/u);
  assert.equal(writeLocalPresentation(snapshot, malformed, storage), false);
  assert.deepEqual(readLocalPresentation(snapshot, storage), { ...presentation, hiddenBlocks: ["forecast"] },
    "A malformed chart edit cannot replace the previous saved presentation");
  const fields = Array.from({ length: 41 }, (_, index) => `reviewed-${"column-".repeat(30)}${index}`);
  const widePresentation = { chartOverrides: { trend: { type: "line", x: "week", y: fields[0], fields } } };
  assert.equal(writeLocalPresentation(snapshot, widePresentation, storage), true);
  assert.deepEqual(readLocalPresentation(snapshot, storage), widePresentation,
    "Inline payload budgets must not limit saved durable chart bindings");
  assert.throws(() => validatePresentation({ hiddenBlocks: [4] }), /Hidden blocks/);
  assert.throws(() => validatePresentation({ notes: "x".repeat(128_001) }), /size limit/);
  assert.throws(() => validatePresentation({ tabs: [{ id: "overview", label: "Overview" },
    { id: "overview", label: "Duplicate" }] }), /Tabs must be a bounded list/);
  assert.throws(() => validatePresentation({ tabs: [{ id: "overview", label: "" }] }),
    /Tabs must be a bounded list/);
  assert.deepEqual(normalizePresentation({ theme: "dark-pixel", queries: { secret: true } }), {
    theme: "dark-pixel",
  });
});

test("an explicit legacy title migrates the complete valid presentation without deleting its old record", () => {
  const legacy = { surface: "report", title: "Original report question?" };
  const snapshot = { surface: "report", id: "report-stable-123", title: "A clearer conclusion",
    legacyPresentationTitle: legacy.title };
  const presentation = {
    theme: "scientific-blue", appearance: "dark", title: "My edited title", description: "My description",
    hiddenBlocks: ["risk"], componentTitles: { revenue: "Recognized revenue" },
    textEdits: { "finding:body": "My complete edited recommendation." },
    chartOverrides: { trend: { type: "bar" } }, filters: { region: "West" },
    assumptions: { conversion: 12 }, notes: "## Notes",
    refreshSchedule: { frequency: "daily", time: "09:00" },
    tabs: [{ id: "overview", label: "Overview" }],
    blockLayouts: { story: { order: ["finding", "risk"] } },
  };
  const storage = memoryStorage();
  assert.equal(writeLocalPresentation(legacy, presentation, storage), true);
  assert.equal(writeViewerAppearance(legacy, "light", storage), true);
  const oldKey = presentationStorageKey(legacy);
  const stableKey = presentationStorageKey(snapshot);
  const originalRecord = storage.getItem(oldKey);

  assert.deepEqual(readLocalPresentation(snapshot, storage), presentation);
  assert.equal(storage.getItem(stableKey), originalRecord);
  assert.equal(storage.getItem(oldKey), originalRecord);
  assert.equal(readViewerAppearance(snapshot, storage), "light");
  assert.equal(storage.getItem(`${stableKey}:viewer-appearance`), "light");
  assert.equal(storage.getItem(`${oldKey}:viewer-appearance`), "light");
  assert.deepEqual(readLocalPresentation({ ...snapshot, title: "Renamed again" }, storage), presentation);
  assert.equal(presentationStorageKey({ ...snapshot, title: "Renamed again" }), stableKey);
});

test("stable presentation and appearance records win independently, including explicit resets and corrupt records", () => {
  const legacy = { title: "Old report" };
  const snapshot = { id: "stable-report", title: "New report", legacyPresentationTitle: legacy.title };
  const storage = memoryStorage();
  writeLocalPresentation(legacy, { title: "Legacy title", textEdits: { body: "Legacy text" } }, storage);
  writeViewerAppearance(legacy, "dark", storage);
  writeLocalPresentation(snapshot, { title: "Current title" }, storage);
  assert.deepEqual(readLocalPresentation(snapshot, storage), { title: "Current title" });
  assert.equal(readViewerAppearance(snapshot, storage), "dark");
  assert.equal(writeViewerAppearance(snapshot, "", storage), true);
  assert.equal(readViewerAppearance(snapshot, storage), "");
  assert.equal(storage.getItem(`${presentationStorageKey(snapshot)}:viewer-appearance`), "");
  assert.equal(storage.getItem(`${presentationStorageKey(legacy)}:viewer-appearance`), "dark");

  const key = presentationStorageKey(snapshot);
  storage.setItem(key, "{corrupt current record");
  assert.deepEqual(readLocalPresentation(snapshot, storage), {});
  assert.equal(storage.getItem(key), "{corrupt current record");
  storage.setItem(`${key}:viewer-appearance`, "invalid-current-value");
  assert.equal(readViewerAppearance(snapshot, storage), "");
  assert.equal(storage.getItem(`${key}:viewer-appearance`), "invalid-current-value");
  writeLocalPresentation(snapshot, {}, storage);
  assert.deepEqual(readLocalPresentation(snapshot, storage), {});
});

test("legacy lookup requires one bounded exact alias and a safe stable ID", () => {
  const legacy = { title: "Old report" };
  const stored = memoryStorage();
  writeLocalPresentation(legacy, { title: "Legacy title" }, stored);
  const invalid = [
    { title: "New report", legacyPresentationTitle: legacy.title },
    { id: "stable-report", title: "New report" },
    ...["", " ", "../report", "report/id", "report:id", "x".repeat(201), 4]
      .map((id) => ({ id, title: "New report", legacyPresentationTitle: legacy.title })),
    ...["", " ", "x".repeat(301), "Old\nreport", "Old\u007freport", [legacy.title], 4]
      .map((legacyPresentationTitle) => ({ id: "stable-report", title: "New report", legacyPresentationTitle })),
  ];
  for (const snapshot of invalid) {
    const reads = [];
    const storage = { getItem(key) { reads.push(key); return stored.getItem(key); },
      setItem() { assert.fail("Invalid identity must not migrate"); } };
    assert.deepEqual(readLocalPresentation(snapshot, storage), {});
    assert.deepEqual(reads, [presentationStorageKey(snapshot)]);
  }
  const exactTitle = "  Original title with spaces  ";
  const storage = memoryStorage();
  writeLocalPresentation({ title: exactTitle }, { title: "Keep the exact old key" }, storage);
  assert.deepEqual(readLocalPresentation({ id: "stable-exact", legacyPresentationTitle: exactTitle }, storage),
    { title: "Keep the exact old key" });
});

test("legacy migration stays at the same canonical artifact path and never enumerates storage", () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const legacy = { title: "Shared title" };
  const snapshot = { id: "specific-report", legacyPresentationTitle: legacy.title };
  const values = new Map([
    [presentationStorageKey(legacy, "/one/index.html"), JSON.stringify({
      version: presentationVersion, presentation: { title: "Report one" },
    })],
    [presentationStorageKey(legacy, "/two/index.html"), JSON.stringify({
      version: presentationVersion, presentation: { title: "Report two" },
    })],
  ]);
  const reads = [];
  const storage = { getItem(key) { reads.push(key); return values.get(key) ?? null; },
    setItem: (key, value) => values.set(key, value),
    key() { assert.fail("Must not enumerate browser storage"); },
    get length() { assert.fail("Must not enumerate browser storage"); } };
  try {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { pathname: "/one/index.html" } });
    assert.deepEqual(readLocalPresentation(snapshot, storage), { title: "Report one" });
    assert.ok(reads.every((key) => key.includes(":/one/index.html:")));
    assert.equal(values.has(presentationStorageKey(snapshot, "/two/index.html")), false);
  } finally {
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
    else delete globalThis.location;
  }
});

test("invalid legacy records are not copied and unavailable storage fails safely", () => {
  const legacy = { title: "Old report" };
  const snapshot = { id: "stable-report", legacyPresentationTitle: legacy.title };
  const oldKey = presentationStorageKey(legacy);
  const key = presentationStorageKey(snapshot);
  for (const value of ["not json", "null", JSON.stringify({ version: 2, presentation: {} }),
    JSON.stringify({ version: presentationVersion, presentation: { rows: [{ secret: true }] } }),
    JSON.stringify({ version: presentationVersion, presentation: { textEdits: { body: "x".repeat(20_001) } } }),
    " ".repeat(132_097)]) {
    const storage = memoryStorage();
    storage.setItem(oldKey, value);
    assert.deepEqual(readLocalPresentation(snapshot, storage), {});
    assert.equal(storage.getItem(key), null);
    assert.equal(storage.getItem(oldKey), value);
  }
  const legacyValue = JSON.stringify({ version: presentationVersion, presentation: { title: "Keep readable edits" } });
  const readonly = { getItem: (candidate) => candidate === oldKey ? legacyValue : null,
    setItem() { throw new Error("Quota or write denied"); } };
  assert.deepEqual(readLocalPresentation(snapshot, readonly), { title: "Keep readable edits" });
  const unavailable = { getItem() { throw new Error("Storage denied"); }, setItem() { throw new Error("Storage denied"); } };
  assert.deepEqual(readLocalPresentation(snapshot, unavailable), {});
  assert.equal(readViewerAppearance(snapshot, unavailable), "");
  assert.equal(writeLocalPresentation(snapshot, {}, unavailable), false);
  assert.equal(writeViewerAppearance(snapshot, "dark", unavailable), false);
});

test("a stable record arriving during legacy lookup is never overwritten", () => {
  const legacy = { title: "Old report" };
  const snapshot = { id: "stable-report", legacyPresentationTitle: legacy.title };
  const key = presentationStorageKey(snapshot);
  const oldKey = presentationStorageKey(legacy);
  const encode = (title) => JSON.stringify({ version: presentationVersion, presentation: { title } });
  let stableReads = 0;
  const storage = { getItem(candidate) {
    if (candidate === oldKey) return encode("Legacy");
    if (candidate === key) return ++stableReads === 1 ? null : encode("Current");
    return null;
  }, setItem() { assert.fail("Must not replace the current stable record"); } };
  assert.deepEqual(readLocalPresentation(snapshot, storage), { title: "Current" });
});

test("valid widget and chart permalinks share their dashboard presentation without merging unrelated paths", () => {
  const snapshot = { id: "reviewed-dashboard" };
  const dashboardKey = presentationStorageKey(snapshot, "/");
  const componentUuid = componentPermalinkId("https://dashboard.chatgpt.site", "active-users");
  const chartUuid = componentPermalinkId("https://dashboard.chatgpt.site", "usage-trend");
  const componentShortId = componentPermalinkShortId("https://dashboard.chatgpt.site", "active-users");
  const chartShortId = componentPermalinkShortId("https://dashboard.chatgpt.site", "usage-trend");

  assert.equal(presentationStorageKey(snapshot, `/_data/components/${componentShortId}`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, `/_data/charts/${chartShortId}`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, `/_data/charts/${chartShortId}/detail`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, `/_data/components/${componentUuid}`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, `/_data/charts/${chartUuid}`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, `/_data/charts/${chartUuid}/detail`), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/components/active-users"), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/components/usage-details"), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/components/Revenue%20growth"), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/charts/usage-trend"), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/charts/usage-trend/detail"), dashboardKey);
  assert.equal(presentationStorageKey(snapshot, "/_data/charts/Revenue%20growth"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/_data/components/parent%2Fchild"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/_data/components/active-users/detail"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/_data/components/active-users/"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/_data/charts/parent%2Fchild"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/_data/charts/usage-trend/"), dashboardKey);
  assert.notEqual(presentationStorageKey(snapshot, "/one"), presentationStorageKey(snapshot, "/two"));
  assert.notEqual(presentationStorageKey({ id: "another-dashboard" }, "/_data/components/active-users"),
    dashboardKey);
  assert.notEqual(presentationStorageKey({ id: "another-dashboard" }, "/_data/charts/usage-trend"), dashboardKey);
});

test("tab order merges as one shared presentation change", () => {
  const previous = { tabs: [{ id: "overview", label: "Overview" }, { id: "details", label: "Details" }] };
  const next = { tabs: [{ id: "details", label: "Details" }, { id: "overview", label: "Overview" }] };
  assert.deepEqual(mergePresentationChanges(previous, next, previous), next);
});

test("creator refresh schedules persist separately from reviewed data and reject invalid settings", () => {
  const snapshot = { id: "source-backed-dashboard" };
  for (const [schedule, expected] of [
    [
      { frequency: "custom", time: "09:17", days: ["SU", "WE", "MO"] },
      { frequency: "custom", time: "09:17", days: ["MO", "WE", "SU"] },
    ],
    [{ frequency: "hourly" }, { frequency: "hourly" }],
    [{ frequency: "hourly", time: "09:00", days: ["MO"] }, { frequency: "hourly" }],
  ]) {
    const storage = memoryStorage();
    const presentation = { refreshSchedule: schedule };
    assert.deepEqual(validatePresentation(presentation), { refreshSchedule: expected });
    assert.deepEqual(validateWorkerPresentation(presentation), { refreshSchedule: expected });
    assert.equal(writeLocalPresentation(snapshot, presentation, storage), true);
    assert.deepEqual(readLocalPresentation(snapshot, storage), { refreshSchedule: expected });
    assert.deepEqual(mergePresentationChanges({}, presentation, { title: "Reviewed title" }), {
      title: "Reviewed title", refreshSchedule: expected,
    });
  }
  assert.throws(() => validatePresentation({ refreshSchedule: { frequency: "daily", time: "29:00" } }),
    /Refresh schedule must include/);
  assert.throws(() => validatePresentation({ refreshSchedule: { frequency: "custom", time: "09:00", days: [] } }),
    /Refresh schedule must include/);
});

test("concurrent presentation edits merge changed fields without discarding another editor", () => {
  const previous = { theme: "original", componentTitles: { revenue: "Revenue" }, filters: { region: "all" } };
  const mine = { theme: "scientific-blue", componentTitles: { revenue: "Recognized revenue" }, filters: { region: "all" } };
  const theirs = { theme: "original", componentTitles: { revenue: "Revenue", costs: "Operating costs" },
    filters: { region: "West" }, hiddenBlocks: ["forecast"] };
  assert.deepEqual(mergePresentationChanges(previous, mine, theirs), {
    theme: "scientific-blue", hiddenBlocks: ["forecast"],
    componentTitles: { revenue: "Recognized revenue", costs: "Operating costs" }, filters: { region: "West" },
  });
});

test("unrelated hosted owner edits preserve an existing verified refresh schedule", () => {
  const schedule = { frequency: "weekdays", time: "09:00" };
  const original = { theme: "original", title: "Reviewed dashboard", refreshSchedule: schedule };
  const edited = { ...original, title: "Edited dashboard" };

  assert.deepEqual(mergePresentationChanges(original, edited, original), {
    theme: "original", title: "Edited dashboard", refreshSchedule: schedule,
  });
});

test("later owner edits remain rebased on an earlier cross-session conflict merge", async () => {
  const original = { theme: "original", title: "Reviewed dashboard", componentTitles: { revenue: "Revenue" } };
  const firstLocal = { ...original, title: "Edited dashboard" };
  const concurrentRemote = {
    ...original, theme: "dark-pixel", componentTitles: { revenue: "Revenue", costs: "Operating costs" },
  };
  const firstMerged = mergePresentationChanges(original, firstLocal, concurrentRemote);
  const secondLocal = { ...firstLocal, componentTitles: { revenue: "Recognized revenue" } };
  const secondMerged = mergePresentationChanges(firstLocal, secondLocal, firstMerged);
  assert.deepEqual(secondMerged, {
    theme: "dark-pixel", title: "Edited dashboard",
    componentTitles: { revenue: "Recognized revenue", costs: "Operating costs" },
  }, "A second local edit cannot silently overwrite fields preserved during the earlier conflict");

  const harness = await presentationPersistenceHarness(original);
  try {
    harness.render(original);
    harness.server.presentation = concurrentRemote;
    harness.server.revision = 1;
    harness.render(firstLocal);
    await harness.flush();
    assert.deepEqual(harness.server.presentation, firstMerged);
    harness.render(secondLocal);
    await harness.flush();
    assert.deepEqual(harness.requests.map(({ revision }) => revision), [0, 1, 2]);
    assert.deepEqual(harness.server.presentation, secondMerged,
      "Later owner saves preserve the local delta and fields retained during an earlier 409 merge");
  } finally { harness.dispose(); }
});

function fakeDatabase() {
  const state = { snapshot: null, queries: new Map(), rows: new Map(), presentation: null, maxBoundParameters: 0 };
  return {
    state,
    prepare(sql) {
      const statement = {
        values: [],
        bind(...values) {
          this.values = values;
          state.maxBoundParameters = Math.max(state.maxBoundParameters, values.length);
          return this;
        },
        async run() {
          if (sql.startsWith("SELECT metadata_json")) return { results: [await this.first()] };
          if (sql.startsWith("SELECT")) return this.all();
          if (this.values.length > 100) throw new Error("D1 statements accept at most 100 parameters.");
          if (sql.startsWith("DELETE FROM data_app_query_rows")) {
            if (this.values.length) {
              for (const [key, row] of state.rows) {
                if (row.query_id === this.values[0]) state.rows.delete(key);
              }
            } else {
              state.rows.clear();
            }
          }
          if (sql.startsWith("DELETE FROM data_app_queries")) state.queries.clear();
          if (sql.startsWith("INSERT INTO data_app_snapshots")) {
            const [, metadata_json, seed_sha256] = this.values;
            state.snapshot = { metadata_json, seed_sha256 };
          }
          if (sql.startsWith("INSERT INTO data_app_queries")) {
            const [id, position, query_json] = this.values;
            state.queries.set(id, { id, position, query_json });
          }
          if (sql.startsWith("INSERT INTO data_app_query_rows")) {
            for (let index = 0; index < this.values.length; index += 3) {
              const [query_id, position, row_json] = this.values.slice(index, index + 3);
              state.rows.set(`${query_id}:${position}`, { query_id, position, row_json });
            }
          }
          if (sql.startsWith("UPDATE data_app_snapshots")) {
            state.snapshot.metadata_json = JSON.stringify({
              ...JSON.parse(state.snapshot.metadata_json), generatedAt: this.values[0],
            });
          }
          if (sql.startsWith("INSERT INTO data_app_presentation_v1")) {
            if (!state.presentation) {
              const [, presentation, revision, updatedAt] = this.values;
              state.presentation = { presentation_json: presentation, revision, updated_at: updatedAt };
            }
          }
          if (sql.startsWith("UPDATE data_app_presentation_v1")) {
            const [presentation, updatedAt, , revision] = this.values;
            if (state.presentation.revision !== revision) return { meta: { changes: 0 } };
            state.presentation = { presentation_json: presentation, revision: revision + 1, updated_at: updatedAt };
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          if (sql.includes("SELECT presentation_json")) return state.presentation;
          if (sql.includes("SELECT seed_sha256")) {
            return state.snapshot && { seed_sha256: state.snapshot.seed_sha256 };
          }
          if (sql.includes("SELECT metadata_json")) {
            return state.snapshot && { metadata_json: state.snapshot.metadata_json };
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM data_app_queries")) {
            return { results: [...state.queries.values()].sort((a, b) => a.position - b.position) };
          }
          if (sql.includes("FROM data_app_query_rows")) {
            return { results: [...state.rows.values()].sort((a, b) =>
              a.query_id.localeCompare(b.query_id) || a.position - b.position) };
          }
          return { results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      const previous = {
        snapshot: state.snapshot && { ...state.snapshot },
        queries: new Map(state.queries),
        rows: new Map(state.rows),
        presentation: state.presentation && { ...state.presentation },
      };
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        return results;
      } catch (error) {
        Object.assign(state, previous);
        throw error;
      }
    },
  };
}

async function loadDashboardWorker(seed, initialPresentation = {}) {
  return createDataAppWorker({
    html: "<main>Dashboard</main>",
    seedSnapshot: seed,
    initialPresentation,
  });
}

test("the hosted Worker adds one trusted Sites project reference to dashboard HTML", async () => {
  const worker = createDataAppWorker({
    html: "<!doctype html><html><head><title>Dashboard</title></head><body></body></html>",
    projectId: "appgprj_123",
    seedSnapshot: { queries: {} },
  });
  const response = await worker.fetch(new Request("https://dashboard.chatgpt.site/_data/charts/active-users"), {});
  const html = await response.text();
  assert.equal(html.match(/data-app-sites-project/gu)?.length, 1);
  assert.match(html, /<head><meta name="data-app-sites-project" content="appgprj_123">/u);
  assert.throws(
    () => createDataAppWorker({
      html: '<head><meta name="data-app-sites-project" content="forged"></head>',
      projectId: "appgprj_123",
      seedSnapshot: { queries: {} },
    }),
    /must not define its Sites project identity/u,
  );
  assert.throws(
    () => createDataAppWorker({ html: "<head></head>", projectId: "../private", seedSnapshot: { queries: {} } }),
    /Sites project ID is invalid/u,
  );
});

test("the hosted Worker ignores Sites marker text in scripts and comments", async () => {
  const reviewedHtml = `<!doctype html><html><head>
    <!-- <meta name="data-app-sites-project" content="comment"> -->
    <script>const example = '</head><meta name="data-app-sites-project" content="script">';</script>
    <style>head::after { content: 'meta[name="data-app-sites-project"]'; }</style>
    <meta name="description" content='Example: name="data-app-sites-project"'>
    </head><body>
    <script>document.querySelectorAll('meta[name="data-app-sites-project"]');</script>
    </body></html>`;
  const worker = createDataAppWorker({
    html: reviewedHtml,
    projectId: "appgprj_123",
    seedSnapshot: { queries: {} },
  });
  const html = await (await worker.fetch(new Request("https://dashboard.chatgpt.site/"), {})).text();
  assert.equal(html, reviewedHtml.replace("<head>", '<head><meta name="data-app-sites-project" content="appgprj_123">'));
  assert.throws(
    () => createDataAppWorker({
      html: '<head><META content="forged > identity" NAME = data-app-sites-project></head>',
      projectId: "appgprj_123",
      seedSnapshot: { queries: {} },
    }),
    /must not define its Sites project identity/u,
  );
});

test("the reusable Worker validates and seeds presentation without replacing later D1 edits", async () => {
  assert.equal(validateWorkerPresentation, validatePresentation);
  assert.throws(() => createDataAppWorker({
    html: "<main>Dashboard</main>", seedSnapshot: { queries: {} },
    initialPresentation: { appearance: "invalid" },
  }), /Appearance must be/u);
  const database = fakeDatabase();
  const first = await loadDashboardWorker({ queries: {} }, { title: "Reviewed initial title",
    verification: { verifiedBy: "forged@example.com", verifiedAt: "2026-08-17T19:34:56.789Z" } });
  const request = new Request("https://dashboard.chatgpt.site/api/presentation");
  const initial = await (await first.fetch(request, { DB: database })).json();
  assert.equal(initial.presentation.title, "Reviewed initial title");
  assert.equal(Object.hasOwn(initial.presentation, "verification"), false);
  const redeployed = await loadDashboardWorker({ queries: {} }, { title: "New source default" });
  const preserved = await (await redeployed.fetch(request, { DB: database })).json();
  assert.deepEqual(preserved.presentation, initial.presentation);
  assert.equal(preserved.revision, 0);
});


test("hosted edit authorization rejects missing, malformed, and overlong trusted emails", async () => {
  const seed = { title: "Reviewed dashboard", queries: {} };
  const environment = {
    DB: { prepare() { assert.fail("Invalid caller identity must not touch dashboard storage."); } },
  };

  for (const email of [null, "", " \t ", "not-an-email", "owner@@example.com", "owner@example",
    "ow ner@example.com", "owner\0@example.com", "owner\x7f@example.com", "\towner@example.com",
    "owner@example.com\n", "owner\u0085@example.com", `${"x".repeat(245)}@example.com`]) {
    const emailHash = createHash("sha256").update(email?.trim().toLowerCase() ?? "").digest("hex");
    environment.DATA_APP_OWNER_EMAIL_SHA256 = emailHash;
    const worker = await loadDashboardWorker(seed);
    const request = (path, method = "GET") => ({
      url: `https://dashboard.chatgpt.site${path}`,
      method,
      headers: { get(name) {
        if (name === "oai-authenticated-user-email") return email;
        if (name === "oai-authenticated-user-id") return "SiteUser_CurrentOwner";
        return null;
      } },
    });
    assert.equal((await worker.fetch(request("/api/presentation", "PUT"), environment)).status, 403);
    assert.equal((await worker.fetch(request("/api/queries/reviewed", "PUT"), environment)).status, 403);
  }
});

test("missing or malformed owner environment hashes keep every write read-only despite packaged identity", async () => {
  const email = "owner@example.com";
  const emailHash = createHash("sha256").update(email).digest("hex");
  const environment = {
    DB: { prepare() { assert.fail("An invalid owner configuration must not touch dashboard storage."); } },
  };
  const headers = { "oai-authenticated-user-email": email };
  for (const ownerValue of [undefined, "", "invalid", emailHash.toUpperCase(), ` ${emailHash}`, `${emailHash}\n`, null, 42, [emailHash]]) {
    environment.DATA_APP_OWNER_EMAIL_SHA256 = ownerValue;
    const worker = createDataAppWorker({ html: "<main>Dashboard</main>", seedSnapshot: { queries: {} }, ownerEmailSha256: emailHash });
    for (const path of ["/api/presentation", "/api/queries/reviewed", "/api/queries"]) {
      assert.equal((await worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, {
        method: "PUT", headers, body: "{}",
      }), environment)).status, 403);
    }
  }
});

test("editor republishing cannot replace the managed owner or overwrite persisted presentation and rows", async () => {
  const owner = "owner-a@example.com", editor = "editor-b@example.com";
  const hash = email => createHash("sha256").update(email).digest("hex");
  const seed = { title: "Reviewed dashboard", queries: { reviewed: { rows: [{ amount: 42 }] } } };
  const environment = { DB: fakeDatabase(seed), DATA_APP_OWNER_EMAIL_SHA256: hash(owner) };
  const configuration = { html: "<main>Dashboard</main>", seedSnapshot: seed };
  const original = createDataAppWorker(configuration);
  const fetch = (worker, path, email, body) => worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, {
    method: body === undefined ? "GET" : "PUT",
    headers: { "oai-authenticated-user-email": email, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), environment);
  const savedPresentation = { title: "Owner's saved presentation" }, savedRows = [{ amount: 84 }];
  assert.equal((await fetch(original, "/api/presentation", owner, { revision: 0, presentation: savedPresentation })).status, 200);
  assert.equal((await fetch(original, "/api/queries/reviewed", owner, { rows: savedRows })).status, 200);

  const republished = createDataAppWorker({
    ...configuration,
    ownerEmailSha256: hash(editor),
    initialPresentation: { title: "Editor's packaged default" },
  });
  for (const [email, expectedCanEdit] of [[owner, true], [editor, false]]) {
    const response = await (await fetch(republished, "/api/presentation", email)).json();
    assert.equal(response.canEdit, expectedCanEdit);
    assert.equal(response.ownerEnvironmentConfigured, true);
    assert.deepEqual(response.presentation, savedPresentation);
    assert.equal(response.revision, 1);
    assert.equal(JSON.stringify(response).includes(hash(owner)), false, "Readiness must not expose the owner hash");
    assert.equal(JSON.stringify(response).includes(owner), false, "Readiness must not expose the owner email");
  }
  assert.equal((await fetch(republished, "/api/presentation", editor, { revision: 1, presentation: {} })).status, 403);
  assert.equal((await fetch(republished, "/api/queries/reviewed", editor, { rows: [] })).status, 403);
  assert.equal((await fetch(republished, "/api/queries", editor, {
    updates: [{ queryId: "reviewed", rows: [], executedAt: "2026-09-09T00:00:00Z" }],
  })).status, 403);
  assert.deepEqual((await (await fetch(republished, "/api/snapshot", editor)).json()).queries.reviewed.rows, savedRows);
  assert.equal((await fetch(republished, "/api/presentation", owner, { revision: 1, presentation: savedPresentation })).status, 200);
  assert.equal((await fetch(republished, "/api/queries/reviewed", owner, { rows: savedRows })).status, 200);

  for (const invalidValue of [undefined, "invalid"]) {
    environment.DATA_APP_OWNER_EMAIL_SHA256 = invalidValue;
    const response = await (await fetch(republished, "/api/presentation", editor)).json();
    assert.equal(response.ownerEnvironmentConfigured, false);
    assert.equal(response.canEdit, false);
    assert.deepEqual(response.presentation, savedPresentation);
  }
});

test("hosted widget, chart, and detail permalinks serve only safe GET and bodyless HEAD dashboard routes", async () => {
  const worker = await loadDashboardWorker({ title: "Reviewed dashboard", queries: {} });
  const componentUuid = componentPermalinkId("https://dashboard.chatgpt.site", "active-users");
  const chartUuid = componentPermalinkId("https://dashboard.chatgpt.site", "usage-trend");
  const componentShortId = componentPermalinkShortId("https://dashboard.chatgpt.site", "active-users");
  const chartShortId = componentPermalinkShortId("https://dashboard.chatgpt.site", "usage-trend");
  const environment = {
    DB: { prepare() { assert.fail("Component permalink HTML must not read or change dashboard data."); } },
  };
  const fetch = (path, options = {}) => worker.fetch(
    new Request(`https://dashboard.chatgpt.site${path}`, options), environment,
  );
  const root = await fetch("/");
  const expectedHtml = await root.text();

  for (const path of [
    `/_data/components/${componentShortId}`, `/_data/charts/${chartShortId}`, `/_data/charts/${chartShortId}/detail`,
    `/_data/components/${componentUuid}`, `/_data/charts/${chartUuid}`, `/_data/charts/${chartUuid}/detail`,
    "/_data/components/active-users", "/_data/components/notes", "/_data/components/usage-details",
    "/_data/components/detail", "/_data/components/Revenue%20%26%20growth",
    "/_data/components/%F0%9F%93%88", "/_data/components/%252F", "/_data/components/missing-widget",
    `/_data/components/${"x".repeat(200)}`, "/_data/components/active-users?token=private#draft",
    "/_data/charts/usage-trend", "/_data/charts/usage-trend/detail",
    "/_data/charts/Revenue%20%26%20growth", "/_data/charts/%F0%9F%93%88/detail",
    "/_data/charts/%252F", "/_data/charts/missing-chart", `/_data/charts/${"x".repeat(200)}`,
    "/_data/charts/usage-trend?token=private#draft",
  ]) {
    const response = await fetch(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(await response.text(), expectedHtml, path);
  }

  for (const path of [
    `/_data/components/${componentShortId}`, `/_data/charts/${chartShortId}`, `/_data/charts/${chartShortId}/detail`,
    `/_data/components/${componentUuid}`, `/_data/charts/${chartUuid}`, `/_data/charts/${chartUuid}/detail`,
    "/_data/components/active-users", "/_data/components/notes",
    "/_data/charts/usage-trend", "/_data/charts/usage-trend/detail",
  ]) {
    const response = await fetch(path, { method: "HEAD" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(await response.text(), "", path);
  }

  for (const path of [
    `/_data/components/${componentShortId}/detail`, `/_data/charts/${chartShortId}/detail/extra`,
    `/_data/components/${componentUuid}/detail`, `/_data/charts/${chartUuid}/detail/extra`,
    "/_data/components", "/_data/components/", "/_data/components//detail",
    "/_data/components/active-users/", "/_data/components/active-users/detail",
    "/_data/components/active-users/detail/", "/_data/components/active-users/extra",
    "/_data/components/.", "/_data/components/..", "/_data/components/%2e",
    "/_data/components/%2E%2e", "/_data/components/%2F", "/_data/components/%2f",
    "/_data/components/parent%2Fchild", "/_data/components/%5C", "/_data/components/parent%5cchild",
    "/_data/components/%00", "/_data/components/widget%00name", "/_data/components/%20",
    "/_data/components/%", "/_data/components/%E0%A4%A", `/_data/components/${"x".repeat(201)}`,
    "/nested/_data/components/active-users", "/_DATA/components/active-users",
    "/_data/component/active-users", "/_data/COMPONENTS/active-users",
    "/_data/charts", "/_data/charts/", "/_data/charts//detail", "/_data/charts/usage-trend/",
    "/_data/charts/usage-trend/details", "/_data/charts/usage-trend/detail/",
    "/_data/charts/usage-trend/detail/extra", "/_data/charts/.", "/_data/charts/..",
    "/_data/charts/%2e", "/_data/charts/%2E%2e", "/_data/charts/%2F", "/_data/charts/%2f",
    "/_data/charts/parent%2Fchild", "/_data/charts/%5C", "/_data/charts/parent%5cchild",
    "/_data/charts/%00", "/_data/charts/trend%00chart", "/_data/charts/%20",
    "/_data/charts/%", "/_data/charts/%E0%A4%A", `/_data/charts/${"x".repeat(201)}`,
    "/nested/_data/charts/usage-trend", "/_DATA/charts/usage-trend", "/_data/chart/usage-trend",
  ]) {
    assert.equal((await fetch(path)).status, 404, path);
  }

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.equal((await fetch(`/_data/components/${componentShortId}`, { method })).status, 404, method);
    assert.equal((await fetch(`/_data/charts/${chartShortId}`, { method })).status, 404, method);
    assert.equal((await fetch(`/_data/components/${componentUuid}`, { method })).status, 404, method);
    assert.equal((await fetch(`/_data/charts/${chartUuid}`, { method })).status, 404, method);
    assert.equal((await fetch("/_data/components/active-users", { method })).status, 404, method);
    assert.equal((await fetch("/_data/components/active-users/detail", { method })).status, 404, method);
    assert.equal((await fetch("/_data/charts/usage-trend", { method })).status, 404, method);
    assert.equal((await fetch("/_data/charts/usage-trend/detail", { method })).status, 404, method);
  }
});

test("hosted presentation allows only its environment-configured Site owner and keeps reviewed rows separate", async () => {
  const seed = { title: "Reviewed dashboard", queries: { reviewed: { rows: [{ amount: 42 }] } } };
  const ownerEmail = "new-address@example.com";
  const ownerHash = createHash("sha256").update(ownerEmail).digest("hex");
  const worker = await loadDashboardWorker(seed);
  const database = fakeDatabase(seed);
  const fetch = (path, options = {}) => worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, options), {
    DB: database, DATA_APP_OWNER_EMAIL_SHA256: ownerHash,
  });
  assert.deepEqual((await (await fetch("/api/snapshot")).json()).queries.reviewed.rows, [{ amount: 42 }]);
  const firstResponse = await fetch("/api/presentation");
  assert.equal(firstResponse.headers.get("cache-control"), "private, no-store");
  const first = await firstResponse.json();
  assert.deepEqual(first.presentation, {});
  assert.equal(first.revision, 0);
  assert.equal(first.canEdit, false);
  assert.equal(Object.hasOwn(first, "viewerEmail"), false);

  const viewerHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "publisher@example.com",
  };
  const viewerResponse = await fetch("/api/presentation", { headers: viewerHeaders });
  assert.equal(viewerResponse.headers.get("cache-control"), "private, no-store");
  const viewer = await viewerResponse.json();
  assert.equal(viewer.canEdit, false);
  assert.equal(Object.hasOwn(viewer, "viewerEmail"), false);

  const body = JSON.stringify({ presentation: { theme: "dark-pixel", title: "Edited title" }, revision: 0 });
  assert.equal((await fetch("/api/presentation", { method: "PUT", body })).status, 403);
  assert.equal((await fetch("/api/presentation", { method: "PUT", headers: viewerHeaders, body })).status, 403);
  assert.equal((await fetch("/api/queries/reviewed", {
    method: "PUT", headers: viewerHeaders, body: JSON.stringify({ rows: [] }),
  })).status, 403);
  for (const untrustedHeaders of [
    { "oai-authenticated-user-id": "SiteUser_CurrentOwner" },
    { "x-owner-email": ownerEmail, "cf-access-authenticated-user-email": ownerEmail },
  ]) {
    assert.equal((await (await fetch("/api/presentation", { headers: untrustedHeaders })).json()).canEdit, false);
    assert.equal((await fetch("/api/presentation", { method: "PUT", headers: untrustedHeaders, body })).status, 403);
  }
  const headers = {
    "content-type": "application/json",
    "oai-authenticated-user-email": `  ${ownerEmail.toUpperCase()}  `,
  };
  const ownerResponse = await fetch("/api/presentation", { headers });
  assert.equal(ownerResponse.headers.get("cache-control"), "private, no-store");
  const owner = await ownerResponse.json();
  assert.equal(owner.canEdit, true);
  assert.equal(Object.hasOwn(owner, "viewerEmail"), false,
    "Authenticated owner email must never be disclosed to dashboard-authored browser code");
  assert.equal(JSON.stringify(owner).includes(ownerEmail), false,
    "An unverified dashboard must not reveal its authenticated owner's identity");
  const saved = await fetch("/api/presentation", { method: "PUT", headers, body });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "private, no-store");
  assert.equal((await saved.json()).revision, 1);
  assert.equal((await fetch("/api/presentation", { method: "PUT", headers, body })).status, 409);
  assert.equal((await fetch("/api/presentation", {
    method: "PUT", headers, body: JSON.stringify({ presentation: { rows: [{ amount: 1 }] }, revision: 1 }),
  })).status, 400);
  assert.deepEqual((await (await fetch("/api/presentation")).json()).presentation, {
    theme: "dark-pixel", title: "Edited title",
  });
  assert.deepEqual((await (await fetch("/api/snapshot")).json()).queries.reviewed.rows, [{ amount: 42 }]);
});

test("hosted annotation visibility round trips without dropping authored evidence or changing reviewed rows", async () => {
  const seed = { title: "Annotation visibility", queries: { reviewed: { rows: [{ amount: 42, target: 50 }] } } };
  const ownerEmail = "annotation-owner@example.com";
  const worker = await loadDashboardWorker(seed);
  const database = fakeDatabase();
  const fetch = (path, options = {}) => worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, options), {
    DB: database, DATA_APP_OWNER_EMAIL_SHA256: createHash("sha256").update(ownerEmail).digest("hex"),
  });
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": ownerEmail };
  const spec = { type: "line", x: "date", y: "amount", annotations: [
    { id: "target", kind: "benchmark", label: "Reviewed target", field: "target", measure: "amount" },
  ] };
  let revision = 0;
  let lastPresentation;
  for (const setting of [{}, { showAnnotations: false }, { showAnnotations: true }]) {
    const presentation = { chartOverrides: { trend: { ...spec, ...setting } } };
    const saved = await fetch("/api/presentation", {
      method: "PUT", headers, body: JSON.stringify({ presentation, revision }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, ++revision);
    const readback = await (await fetch("/api/presentation")).json();
    assert.deepEqual(readback.presentation, presentation,
      "Readers receive the saved visibility and all authored annotation references");
    assert.equal(readback.revision, revision);
    assert.equal(readback.canEdit, false);
    lastPresentation = presentation;
  }
  for (const chart of [
    { ...spec, showAnnotations: "false" },
    { ...spec, showAnnotations: false, annotations: [{ ...spec.annotations[0], rows: [{ amount: 1 }] }] },
    { ...spec, y: ["amount", "target"] },
    { ...spec, fields: ["amount", ["target"]] },
    { ...spec, series: ["region"] },
  ]) {
    const response = await fetch("/api/presentation", {
      method: "PUT", headers,
      body: JSON.stringify({ presentation: { chartOverrides: { trend: chart } }, revision }),
    });
    assert.equal(response.status, 400);
  }
  const readback = await (await fetch("/api/presentation")).json();
  assert.deepEqual(readback.presentation, lastPresentation);
  assert.equal(readback.revision, revision, "Rejected settings do not create a new revision");
  assert.deepEqual((await (await fetch("/api/snapshot")).json()).queries.reviewed.rows, seed.queries.reviewed.rows);
});

test("authorization follows the current request environment without rebuilding", async () => {
  const seed = { title: "Transferred dashboard", queries: { reviewed: { rows: [{ amount: 42 }] } } };
  const originalOwnerEmail = "original-owner@example.com";
  const nextOwnerEmail = "next-owner@example.com";
  const ownerHash = (email) => createHash("sha256").update(email).digest("hex");
  const database = fakeDatabase(seed);
  const environment = { DB: database, DATA_APP_OWNER_EMAIL_SHA256: ownerHash(originalOwnerEmail) };
  const fetch = (worker, path, email, options = {}) => worker.fetch(
    new Request(`https://dashboard.chatgpt.site${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-email": email,
      },
    }), environment,
  );
  const originalWorker = await loadDashboardWorker(seed);
  const originalOwner = await (await fetch(originalWorker, "/api/presentation", originalOwnerEmail)).json();
  assert.equal(originalOwner.canEdit, true);
  assert.equal(Object.hasOwn(originalOwner, "viewerEmail"), false);
  assert.equal((await (await fetch(originalWorker, "/api/presentation", nextOwnerEmail)).json()).canEdit, false);

  const requestedVerification = {
    verifiedBy: "spoofed@example.com", verifiedAt: "2000-01-01T00:00:00.000Z",
  };
  const originalVerification = await (await fetch(originalWorker, "/api/presentation", originalOwnerEmail, {
    method: "PUT", body: JSON.stringify({
      presentation: { title: "Originally verified dashboard" }, revision: 0, verificationAction: "verify",
    }),
  })).json();
  assert.equal(originalVerification.presentation.verification.verifiedBy, originalOwnerEmail);

  environment.DATA_APP_OWNER_EMAIL_SHA256 = ownerHash(nextOwnerEmail);
  const transferredWorker = originalWorker;
  assert.equal((await (await fetch(transferredWorker, "/api/presentation", originalOwnerEmail)).json()).canEdit, false);
  assert.equal((await (await fetch(transferredWorker, "/api/presentation", nextOwnerEmail)).json()).canEdit, true);

  const body = JSON.stringify({ presentation: {
    title: "Transferred ownership", verification: requestedVerification,
  }, revision: 1 });
  assert.equal((await fetch(transferredWorker, "/api/presentation", originalOwnerEmail, {
    method: "PUT", body,
  })).status, 403);

  assert.equal((await fetch(transferredWorker, "/api/queries/reviewed", originalOwnerEmail, {
    method: "PUT", body: JSON.stringify({ rows: [] }),
  })).status, 403);
  const transferredPresentation = await fetch(transferredWorker, "/api/presentation", nextOwnerEmail, {
    method: "PUT", body,
  });
  assert.equal(transferredPresentation.status, 200);
  assert.deepEqual((await transferredPresentation.json()).presentation.verification,
    originalVerification.presentation.verification,
    "The new owner's ordinary edits must preserve the original trusted verification record");
  assert.equal((await fetch(transferredWorker, "/api/queries/reviewed", nextOwnerEmail, {
    method: "PUT", body: JSON.stringify({ rows: [{ amount: 84 }] }),
  })).status, 200);

  const removal = JSON.stringify({ presentation: {
    title: "Transferred ownership", verification: requestedVerification,
  }, revision: 2, verificationAction: "remove" });
  assert.equal((await fetch(transferredWorker, "/api/presentation", originalOwnerEmail, {
    method: "PUT", body: removal,
  })).status, 403,
  "A transferred-away owner cannot remove the existing verified dashboard badge");
  assert.equal((await fetch(transferredWorker, "/api/presentation", nextOwnerEmail, {
    method: "PUT", body: removal,
  })).status, 200, "Only the current owner may remove the transferred dashboard badge");

  const reverify = JSON.stringify({ presentation: {
    title: "Transferred ownership",
  }, revision: 3, verificationAction: "verify" });
  assert.equal((await fetch(transferredWorker, "/api/presentation", originalOwnerEmail, {
    method: "PUT", body: reverify,
  })).status, 403,
  "The previous owner cannot verify the transferred dashboard");
  const nextVerification = await fetch(transferredWorker, "/api/presentation", nextOwnerEmail, {
    method: "PUT", body: reverify,
  });
  assert.equal(nextVerification.status, 200);
  assert.equal((await nextVerification.json()).presentation.verification.verifiedBy, nextOwnerEmail,
    "A transferred dashboard's new badge must be stamped with the current owner's authenticated email");
});

test("an unconfigured owner stays read-only and preserves D1 until the owner environment is configured", async () => {
  const seed = { title: "Existing dashboard", queries: { reviewed: { rows: [{ amount: 42 }] } } };
  const oldOwnerEmail = "previous-owner@example.com";
  const nextOwnerEmail = "current-owner@example.com";
  const oldOwnerHash = createHash("sha256").update(oldOwnerEmail).digest("hex");
  const database = fakeDatabase(seed);
  const environment = { DB: database, DATA_APP_OWNER_EMAIL_SHA256: oldOwnerHash };
  const fetch = (worker, path, email, options = {}) => worker.fetch(
    new Request(`https://dashboard.chatgpt.site${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-email": email,
      },
    }), environment,
  );

  const originalWorker = await loadDashboardWorker(seed);
  await fetch(originalWorker, "/api/snapshot", oldOwnerEmail);
  const originalPresentation = await (await fetch(originalWorker, "/api/presentation", oldOwnerEmail, {
    method: "PUT",
    body: JSON.stringify({
      presentation: { title: "Saved presentation", filters: { week: "latest" } },
      revision: 0,
      verificationAction: "verify",
    }),
  })).json();
  assert.equal((await fetch(originalWorker, "/api/queries/reviewed", oldOwnerEmail, {
    method: "PUT", body: JSON.stringify({ rows: [{ amount: 84 }] }),
  })).status, 200);
  const savedState = structuredClone(database.state);

  delete environment.DATA_APP_OWNER_EMAIL_SHA256;
  const unconfiguredWorker = originalWorker;
  assert.deepEqual(database.state, savedState,
    "An unconfigured deployment must neither reset persisted data nor claim ownership");
  for (const email of [oldOwnerEmail, nextOwnerEmail]) {
    const presentation = await (await fetch(unconfiguredWorker, "/api/presentation", email)).json();
    assert.equal(presentation.canEdit, false);
    assert.deepEqual(presentation.presentation, originalPresentation.presentation);
    assert.equal(presentation.revision, originalPresentation.revision);
    assert.equal((await fetch(unconfiguredWorker, "/api/presentation", email, {
      method: "PUT", body: JSON.stringify({ presentation: {}, revision: presentation.revision }),
    })).status, 403);
  }

  // Only the managed environment can set the owner; visitors cannot claim the app.
  const nextOwnerHash = createHash("sha256").update(nextOwnerEmail).digest("hex");
  environment.DATA_APP_OWNER_EMAIL_SHA256 = nextOwnerHash;
  const repairedWorker = originalWorker;
  const repaired = await (await fetch(repairedWorker, "/api/presentation", nextOwnerEmail)).json();
  assert.equal(repaired.canEdit, true);
  assert.deepEqual(repaired.presentation, originalPresentation.presentation);
  assert.equal(repaired.revision, originalPresentation.revision);
  assert.deepEqual((await (await fetch(repairedWorker, "/api/snapshot", nextOwnerEmail)).json())
    .queries.reviewed.rows, [{ amount: 84 }]);
  assert.equal((await (await fetch(repairedWorker, "/api/presentation", oldOwnerEmail)).json()).canEdit, false);
  assert.equal((await fetch(repairedWorker, "/api/queries/reviewed", oldOwnerEmail, {
    method: "PUT", body: JSON.stringify({ rows: [] }),
  })).status, 403);
  assert.equal((await fetch(repairedWorker, "/api/presentation", nextOwnerEmail, {
    method: "PUT",
    body: JSON.stringify({
      presentation: repaired.presentation,
      revision: repaired.revision,
      verificationAction: "remove",
    }),
  })).status, 200);
});

test("hosted dashboard verification is creator-only, server-stamped, stable, and removable", async () => {
  const ownerEmail = "publisher@example.com";
  const ownerHash = createHash("sha256").update(ownerEmail).digest("hex");
  const worker = await loadDashboardWorker({ title: "Reviewed dashboard", queries: {} });
  const database = fakeDatabase();
  const ownerHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "  PUBLISHER@EXAMPLE.COM  ",
  };
  const viewerHeaders = {
    "content-type": "application/json",
    "oai-authenticated-user-email": "viewer@example.com",
  };
  const fetch = (path, options = {}) => worker.fetch(new Request(`https://dashboard.chatgpt.site${path}`, options), {
    DB: database, DATA_APP_OWNER_EMAIL_SHA256: ownerHash,
  });
  const spoofed = { verifiedBy: "impostor@example.com", verifiedAt: "2000-01-01T00:00:00.000Z" };
  const body = JSON.stringify({
    presentation: { title: "Reviewed dashboard" }, revision: 0, verificationAction: "verify",
  });

  assert.equal((await fetch("/api/presentation", { method: "PUT", body })).status, 403);
  assert.equal((await fetch("/api/presentation", { method: "PUT", headers: viewerHeaders, body })).status, 403);
  const actualOwner = await (await fetch("/api/presentation", { headers: ownerHeaders })).json();
  assert.equal(actualOwner.canEdit, true);
  assert.equal(Object.hasOwn(actualOwner, "viewerEmail"), false,
    "Even the authenticated owner must not receive their private identity before opting into verification");
  assert.equal(JSON.stringify(actualOwner).includes(ownerEmail), false);
  for (const invalidAction of [null, true, false, 0, {}, [], "", "VERIFY", "delete"]) {
    assert.equal((await fetch("/api/presentation", {
      method: "PUT", headers: ownerHeaders, body: JSON.stringify({
        presentation: { title: "Reviewed dashboard" }, revision: 0, verificationAction: invalidAction,
      }),
    })).status, 400, `Malformed verification action must fail closed: ${JSON.stringify(invalidAction)}`);
  }
  assert.equal((await fetch("/api/presentation", {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ presentation: { title: "Reviewed dashboard", verification: spoofed }, revision: 0 }),
  })).status, 400, "An authored dashboard cannot fabricate a verified badge without an explicit server action");
  assert.equal((await fetch("/api/presentation", {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ presentation: {
      verification: { ...spoofed, rows: [{ secret: true }] },
    }, revision: 0, verificationAction: "verify" }),
  })).status, 400, "Malformed verification metadata must be rejected before creator stamping");

  const beforeVerification = Date.now();
  const verifiedResponse = await fetch("/api/presentation", { method: "PUT", headers: ownerHeaders, body });
  assert.equal(verifiedResponse.status, 200);
  const verified = await verifiedResponse.json();
  assert.equal(verified.revision, 1);
  assert.equal(verified.presentation.verification.verifiedBy, ownerEmail);
  assert.notEqual(verified.presentation.verification.verifiedAt, spoofed.verifiedAt);
  assert.ok(Date.parse(verified.presentation.verification.verifiedAt) >= beforeVerification);
  assert.equal(verified.presentation.verification.verifiedAt, verified.updatedAt,
    "The verification timestamp must be generated by the trusted Worker");

  const publicVerification = await (await fetch("/api/presentation")).json();
  assert.equal(publicVerification.canEdit, false);
  assert.equal(Object.hasOwn(publicVerification, "viewerEmail"), false);
  assert.deepEqual(publicVerification.presentation.verification, verified.presentation.verification,
    "Every authorized dashboard viewer must see the persisted verifier identity and timestamp");
  const viewer = await (await fetch("/api/presentation", { headers: viewerHeaders })).json();
  assert.equal(Object.hasOwn(viewer, "viewerEmail"), false);
  assert.deepEqual(viewer.presentation.verification, verified.presentation.verification);
  const reloadedWorker = await loadDashboardWorker({ title: "Reviewed dashboard", queries: {} });
  const reloaded = await reloadedWorker.fetch(new Request("https://dashboard.chatgpt.site/api/presentation"), {
    DB: database, DATA_APP_OWNER_EMAIL_SHA256: ownerHash,
  });
  assert.deepEqual((await reloaded.json()).presentation.verification, verified.presentation.verification,
    "Verification must persist across Worker reloads and deployments");

  const outdated = await fetch("/api/presentation", {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ presentation: { verification: spoofed }, revision: 0 }),
  });
  assert.equal(outdated.status, 409);
  assert.deepEqual((await outdated.json()).presentation.verification, verified.presentation.verification,
    "Conflicting writes must return the authoritative verification record without replacing it");

  const unchanged = await fetch("/api/presentation", {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({ presentation: { title: "Updated dashboard", verification: spoofed }, revision: 1 }),
  });
  assert.equal(unchanged.status, 200);
  const updated = await unchanged.json();
  assert.equal(updated.revision, 2);
  assert.equal(updated.presentation.title, "Updated dashboard");
  assert.deepEqual(updated.presentation.verification, verified.presentation.verification,
    "Unrelated edits and spoofed client metadata must preserve the original server verification exactly");

  const removal = JSON.stringify({ presentation: {
    title: "Updated dashboard", verification: spoofed,
  }, revision: 2, verificationAction: "remove" });
  assert.equal((await fetch("/api/presentation", {
    method: "PUT", headers: viewerHeaders, body: removal,
  })).status, 403, "A read-only viewer must never remove dashboard verification");
  const cleared = await fetch("/api/presentation", { method: "PUT", headers: ownerHeaders, body: removal });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).revision, 3);
  assert.equal(Object.hasOwn((await (await fetch("/api/presentation")).json()).presentation, "verification"), false,
    "Removing verification must clear the shared dashboard badge for every viewer");

  const reverified = await fetch("/api/presentation", {
    method: "PUT", headers: ownerHeaders,
    body: JSON.stringify({
      presentation: { title: "Updated dashboard" }, revision: 3, verificationAction: "verify",
    }),
  });
  assert.equal(reverified.status, 200);
  assert.equal((await reverified.json()).presentation.verification.verifiedBy, ownerEmail);
});

test("hosted reviewed data stores each result separately and stays within D1 statement limits", async () => {
  const rows = Array.from({ length: 35 }, (_, index) => ({ index, evidence: "reviewed ".repeat(4_000) }));
  const seed = {
    title: "Large reviewed dashboard",
    generatedAt: "2026-08-11T12:00:00.000Z",
    queries: {
      reviewed: { source: { label: "Reviewed evidence" }, rows },
      summary: { source: { label: "Summary" }, rows: [{ total: rows.length }] },
    },
  };
  assert.ok(JSON.stringify(seed).length * 2 > 2_000_000,
    "The previous duplicated snapshot record would exceed D1's maximum row size");

  const worker = await loadDashboardWorker(seed);
  const database = fakeDatabase();
  const snapshot = await (await worker.fetch(new Request("https://dashboard.chatgpt.site/api/snapshot"), {
    DB: database,
  })).json();

  assert.deepEqual(snapshot, seed);
  assert.equal(database.state.rows.size, rows.length + 1);
  assert.equal(database.state.queries.size, 2);
  assert.equal(Object.hasOwn(JSON.parse(database.state.snapshot.metadata_json), "queries"), false);
  assert.match(database.state.snapshot.seed_sha256, /^[a-f\d]{64}$/u);
  assert.equal(database.state.maxBoundParameters, 90);
  assert.ok([...database.state.rows.values()].every(({ row_json }) => row_json.length < 2_000_000));
});

test("hosted query updates preserve other results until a newly reviewed seed replaces them", async () => {
  const ownerEmail = "publisher@example.com";
  const ownerHash = createHash("sha256").update(ownerEmail).digest("hex");
  const seed = {
    title: "Reviewed dashboard",
    generatedAt: "2026-08-11T12:00:00.000Z",
    queries: {
      reviewed: {
        source: { label: "Reviewed evidence", evidenceFlow: [{
          title: "Synthetic API source", detail: "Call fixture_totals for the last seven complete UTC days; sum amount.",
        }] },
        methods: [{ language: "calculation", code: "amount = sum(record.amount for record in response.records)" }],
        rows: [{ amount: 42 }],
      },
      unchanged: { source: { label: "Unchanged evidence" }, rows: [{ amount: 7 }] },
    },
  };
  const database = fakeDatabase();
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": ownerEmail };
  const fetch = (worker, path, options = {}) => worker.fetch(
    new Request(`https://dashboard.chatgpt.site${path}`, options), { DB: database, DATA_APP_OWNER_EMAIL_SHA256: ownerHash },
  );
  const worker = await loadDashboardWorker(seed);
  const reviewedRows = Array.from({ length: 32 }, (_, amount) => ({ amount }));
  const result = await (await fetch(worker, "/api/queries/reviewed", {
    method: "PUT", headers, body: JSON.stringify({ rows: reviewedRows }),
  })).json();

  assert.deepEqual(result.rows, reviewedRows);
  const saved = await (await fetch(worker, "/api/snapshot")).json();
  assert.deepEqual(saved.queries.reviewed.rows, reviewedRows);
  assert.deepEqual(saved.queries.unchanged.rows, seed.queries.unchanged.rows);
  assert.equal(saved.generatedAt, result.generatedAt);

  const reloaded = await loadDashboardWorker(seed);
  const reopened = await (await fetch(reloaded, "/api/snapshot")).json();
  assert.deepEqual(reopened.queries.reviewed, { ...seed.queries.reviewed, rows: reviewedRows },
    "A fresh reader must retain source requests and calculations after a row update");

  const nextSeed = {
    ...seed,
    queries: { reviewed: { source: { label: "New reviewed evidence" }, rows: [{ amount: 100 }] } },
  };
  const redeployed = await loadDashboardWorker(nextSeed);
  assert.deepEqual(await (await fetch(redeployed, "/api/snapshot")).json(), nextSeed);
});

test("a dashboard without owner environment remains read-only for every authenticated viewer", async () => {
  const seed = { title: "Unseeded dashboard", queries: {} };
  const worker = await loadDashboardWorker(seed);
  const database = fakeDatabase(seed);
  const headers = {
    "content-type": "application/json",
    "oai-authenticated-user-id": "SiteUser_FirstViewer",
    "oai-authenticated-user-email": "first-viewer@example.com",
  };
  const response = await worker.fetch(new Request("https://dashboard.chatgpt.site/api/presentation", { headers }), {
    DB: database,
  });
  assert.equal((await response.json()).canEdit, false);
  const denied = await worker.fetch(new Request("https://dashboard.chatgpt.site/api/presentation", {
    method: "PUT", headers, body: JSON.stringify({ presentation: { title: "Taken over" }, revision: 0 }),
  }), { DB: database });
  assert.equal(denied.status, 403);
});

test("editing sessions defer layout/text/chart persistence and cancel without rolling back personal filters", async () => {
  const initial = { title: "Original", chartOverrides: {}, hiddenBlocks: [], theme: "original", filters: { plan: "all" } };
  const baseline = JSON.parse(editHistoryValue(initial));
  const changed = { ...initial, title: "Changed", hiddenBlocks: ["chart"],
    chartOverrides: { chart: { type: "bar", x: "date", y: "value" } },
    blockLayouts: { region: { order: ["b", "a"] } }, filters: { plan: "selected" } };
  const held = presentationBeforeEdits(changed, baseline);
  assert.equal(held.title, initial.title);
  assert.deepEqual(held.chartOverrides, {});
  assert.equal(held.blockLayouts, undefined);
  assert.deepEqual(held.filters, changed.filters);
  const harness = await presentationPersistenceHarness(initial);
  try {
    harness.render(initial);
    // Hosted personal filters are provided separately by the shell; only shared
    // presentation fields should be compared at this boundary.
    harness.render(presentationBeforeEdits({ ...changed, filters: initial.filters }, baseline));
    await harness.flush();
    assert.equal(harness.requests.length, 0, "typing and rearranging do not write to the Site");
    harness.render(initial);
    await harness.flush();
    assert.equal(harness.requests.length, 0, "Cancel does not send a rollback write");
    let committed = false;
    harness.render(changed, { onAcknowledged() { committed = true; } });
    await harness.flush();
    assert.equal(harness.requests.length, 1, "Save uses the existing revision-checked endpoint once");
    assert.equal(harness.server.presentation.title, "Changed");
    assert.equal(committed, true);
  } finally { harness.dispose(); }
});

test("failed explicit saves keep the baseline and can retry the same edits", async () => {
  const initial = { title: "Original" };
  const changed = { title: "Changed" };
  const harness = await presentationPersistenceHarness(initial, { deferResponses: true });
  let acknowledged = false;
  try {
    harness.render(initial);
    harness.render(changed, { onAcknowledged() { acknowledged = true; } });
    const pending = harness.start();
    harness.respond(0, { status: 500 });
    await pending;
    assert.equal(acknowledged, false);
    assert.equal(harness.status(), "error");
    harness.render(presentationBeforeEdits(changed, initial));
    await harness.flush();
    assert.equal(harness.requests.length, 1);
    harness.resumeResponses();
    harness.render(changed, { onAcknowledged() { acknowledged = true; } });
    await harness.flush();
    assert.equal(acknowledged, true);
    assert.equal(harness.server.presentation.title, "Changed");
  } finally { harness.dispose(); }
});

test("invalid authored saves keep the draft editable without discarding or acknowledging text", async () => {
  const initial = { title: "Original", textEdits: { body: "Previously saved" }, componentTitles: {} };
  const cases = [
    { textEdits: { body: "x".repeat(20_001) } },
    { componentTitles: { chart: "x".repeat(20_001) } },
    { textEdits: Object.fromEntries(Array.from({ length: 7 }, (_, index) => [String(index), "x".repeat(19_000)])) },
    { textEdits: Object.fromEntries(Array.from({ length: 501 }, (_, index) => [String(index), "A short edit"])) },
  ];
  for (const hosted of [true, false]) {
    for (const invalid of cases) {
      const harness = await presentationPersistenceHarness(initial);
      const draft = { ...initial, ...invalid };
      const draftBeforeSaving = structuredClone(draft);
      const errors = [];
      const acknowledgements = [];
      let editing = true;
      let saving = false;
      const options = {
        hosted,
        onAcknowledged: (saved) => { acknowledgements.push(saved); editing = false; },
        onError: (error) => { errors.push(error); saving = false; },
      };
      try {
        harness.render(initial, options);
        harness.render(presentationBeforeEdits(draft, initial), options);
        await harness.flush();
        assert.equal(errors.length, 0, "Typing keeps provisional edits out of persistence");
        saving = true;
        assert.doesNotThrow(() => harness.render(draft, options), "Invalid drafts must not throw from a render or effect");
        await harness.flush();

        assert.equal(harness.status(), "error");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /bounded|size limit/u);
        assert.equal(saving, false, "The existing error callback unlocks the draft for correction");
        assert.equal(editing, true, "Validation failures must not end the edit session");
        assert.deepEqual(draft, draftBeforeSaving, "The complete invalid text remains in the draft");
        assert.deepEqual(acknowledgements, []);
        assert.deepEqual(harness.requests, []);
        assert.deepEqual(harness.server.presentation, initial);

        harness.render(presentationBeforeEdits(draft, initial), options);
        const corrected = { ...initial, textEdits: { body: "Corrected text" } };
        harness.render(corrected, options);
        await harness.flush();
        assert.equal(harness.status(), "saved");
        assert.deepEqual(acknowledgements, [corrected]);
        assert.equal(editing, false);
        assert.equal(harness.requests.length, hosted ? 1 : 0);
      } finally { harness.dispose(); }
    }
  }
});

test("local caching rejects oversized drafts without throwing or replacing the prior saved value", () => {
  const snapshot = { id: "bounded-local-draft" };
  const storage = memoryStorage();
  const initial = { textEdits: { body: "Previously saved" } };
  writeLocalPresentation(snapshot, initial, storage);
  assert.equal(writeLocalPresentation(snapshot, { textEdits: { body: "x".repeat(20_001) } }, storage), false);
  assert.equal(writeLocalPresentation(snapshot, { textEdits: Object.fromEntries(
    Array.from({ length: 7 }, (_, index) => [String(index), "x".repeat(19_000)]),
  ) }, storage), false);
  assert.deepEqual(readLocalPresentation(snapshot, storage), initial);

  storage.setItem(presentationStorageKey(snapshot), JSON.stringify({
    version: presentationVersion,
    presentation: { textEdits: { body: "Previously saved", legacy: "x".repeat(20_001) } },
  }));
  assert.deepEqual(readLocalPresentation(snapshot, storage), initial,
    "Persisted older data still uses permissive normalization when read");
});

test("an older in-flight save cannot acknowledge a newer draft rejected by validation", async () => {
  const initial = { textEdits: { body: "Initial text" } };
  const older = { textEdits: { body: "Earlier valid draft" } };
  const invalid = { textEdits: { body: "x".repeat(20_001) } };
  const errors = [];
  const acknowledgements = [];
  const options = {
    onError: (error) => errors.push(error),
    onAcknowledged: (saved) => acknowledgements.push(saved),
  };
  const harness = await presentationPersistenceHarness(initial, { deferResponses: true });
  try {
    harness.render(initial, options);
    harness.render(older, options);
    const olderSave = harness.start();
    harness.render(invalid, options);
    assert.equal(harness.status(), "error");
    assert.equal(harness.timers.size, 0);
    harness.respond(0, { presentation: older, revision: 1 });
    await olderSave;
    assert.equal(harness.status(), "error");
    assert.equal(errors.length, 1);
    assert.deepEqual(acknowledgements, []);
    assert.equal(harness.requests.length, 1, "Only the earlier valid draft was sent to the server");
    assert.equal(invalid.textEdits.body.length, 20_001);
  } finally { harness.dispose(); }
});

test("conflict merges reject combined size and entry limits before a retry can discard text", async () => {
  for (const { localCount, remoteCount, text } of [
    { localCount: 4, remoteCount: 3, text: "x".repeat(19_000) },
    { localCount: 400, remoteCount: 200, text: "A short edit" },
  ]) {
    const initial = { textEdits: {} };
    const local = { textEdits: Object.fromEntries(Array.from({ length: localCount }, (_, index) => [`local-${index}`, text])) };
    const remote = { textEdits: Object.fromEntries(Array.from({ length: remoteCount }, (_, index) => [`remote-${index}`, text])) };
    const harness = await presentationPersistenceHarness(initial);
    const errors = [];
    const acknowledgements = [];
    const options = {
      onError: (error) => errors.push(error),
      onAcknowledged: (saved) => acknowledgements.push(saved),
    };
    try {
      harness.render(initial, options);
      harness.server.presentation = remote;
      harness.server.revision = 1;
      harness.render(local, options);
      await harness.flush();
      assert.equal(harness.status(), "error");
      assert.equal(errors.length, 1);
      assert.match(errors[0], /bounded|size limit/u);
      assert.equal(harness.requests.length, 1, "The stale first request must not be retried with a lossy merged payload");
      assert.deepEqual(acknowledgements, []);
      assert.deepEqual(harness.server.presentation, remote, "The concurrent saved text remains intact");
    } finally { harness.dispose(); }
  }
});


test("verification education preference survives reload on non-workspace origins", () => {
  const storage = memoryStorage();
  const location = { protocol: "http:", hostname: "127.0.0.1" };
  assert.equal(readVerificationReminderDismissed({ storage, location }), false);
  assert.equal(rememberVerificationReminderDismissed({ storage, location }), true);
  assert.equal(readVerificationReminderDismissed({ storage, location }), true);
  assert.equal(readVerificationReminderDismissed({ storage: memoryStorage(), location }), false);
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.equal(rememberVerificationReminderDismissed({ storage: blocked, location }), false);
  assert.equal(readVerificationReminderDismissed({ storage: blocked, location }), false);
});
