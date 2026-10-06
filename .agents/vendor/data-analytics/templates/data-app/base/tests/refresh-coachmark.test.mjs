import assert from "node:assert/strict";
import test from "node:test";

import { claimRefreshCoachmark, REFRESH_COACHMARK_COOKIE, refreshCoachmarkDomain, rememberRefreshCoachmark } from "../src/refresh-coachmark.js";
import { readVerificationReminderDismissed, rememberVerificationReminderDismissed, VERIFICATION_REMINDER_COOKIE } from "../src/verification-reminder.js";

const site = name => new URL(`https://${name}.example.chatgpt.site/`);
function browserJar({ blocked = false } = {}) {
  const entries = new Map(), writes = [];
  return {
    writes,
    document(location) {
      return {
        get cookie() {
          return [...entries].filter(([domain]) => location.hostname === domain || location.hostname.endsWith(`.${domain}`))
            .flatMap(([, cookies]) => [...cookies.values()]).join("; ");
        },
        set cookie(value) {
          writes.push(value);
          if (blocked) return;
          const domain = /; Domain=([^;]+)/u.exec(value)?.[1];
          if (domain && (location.hostname === domain || location.hostname.endsWith(`.${domain}`))) {
            const pair = value.split(";")[0], name = pair.split("=")[0];
            if (!entries.has(domain)) entries.set(domain, new Map());
            entries.get(domain).set(name, pair);
          }
        },
      };
    },
  };
}
const immediate = () => Promise.resolve();
const nonce = () => "test-claim-token";

test("refresh education uses the workspace domain, never a website or public-suffix fallback", () => {
  assert.equal(refreshCoachmarkDomain(site("first")), "example.chatgpt.site");
  assert.equal(refreshCoachmarkDomain(site("second")), "example.chatgpt.site");
  assert.equal(refreshCoachmarkDomain(new URL("https://dashboard.openai.chatgpt.site")), "openai.chatgpt.site");
  for (const href of ["http://first.example.chatgpt.site", "https://dashboard.chatgpt.site", "https://chatgpt.site",
    "https://example.com", "https://localhost", "https://a.b.c.chatgpt.site", "https://a.b.chatgpt.site.evil.test"]) {
    assert.equal(refreshCoachmarkDomain(new URL(href)), null, href);
  }
});

test("one cookie suppresses the coachmark across different dashboard origins in the same workspace", async () => {
  const jar = browserJar();
  const first = site("first"), second = site("second");
  assert.notEqual(first.origin, second.origin);
  assert.equal(await claimRefreshCoachmark({ location: first, document: jar.document(first), nonce, settle: immediate }), true);
  assert.equal(await claimRefreshCoachmark({ location: second, document: jar.document(second), nonce, settle: immediate }), false);
  assert.equal(await claimRefreshCoachmark({ location: first, document: jar.document(first), nonce, settle: immediate }), false);
  assert.ok(jar.writes.every(value => value.includes("Domain=example.chatgpt.site; Path=/; Max-Age=34560000; Secure; SameSite=Lax")));
  assert.ok(jar.writes.every(value => value.startsWith(`${REFRESH_COACHMARK_COOKIE}=`)));
  assert.doesNotMatch(jar.writes.join("\n"), /first\.|second\.|email|user_id|account/u);
});

test("workspace and browser boundaries remain explicit", async () => {
  const jar = browserJar(), otherBrowser = browserJar();
  const first = site("first"), otherWorkspace = new URL("https://first.other.chatgpt.site/");
  for (const [browser, location] of [[jar, first], [jar, otherWorkspace], [otherBrowser, first]]) {
    assert.equal(await claimRefreshCoachmark({ document: browser.document(location), location, nonce, settle: immediate }), true);
  }
});

test("blocked or throwing cookie storage keeps the coachmark hidden", async () => {
  const location = site("first"), jar = browserJar({ blocked: true });
  assert.equal(await claimRefreshCoachmark({ location, document: jar.document(location), nonce, settle: immediate }), false);
  assert.equal(rememberRefreshCoachmark({ location, document: jar.document(location) }), false);
  const denied = { get cookie() { throw new Error("Cookie access blocked"); }, set cookie(_) { throw new Error("Cookie write blocked"); } };
  assert.equal(await claimRefreshCoachmark({ location, document: denied, nonce, settle: immediate }), false);
  assert.equal(rememberRefreshCoachmark({ location, document: denied }), false);
});

test("manual refresh setup consumes the workspace-wide tip before it is offered", async () => {
  const jar = browserJar(), first = site("first"), second = site("second");
  assert.equal(rememberRefreshCoachmark({ location: first, document: jar.document(first) }), true);
  assert.equal(await claimRefreshCoachmark({ location: second, document: jar.document(second), nonce, settle: immediate }), false);
});

test("an in-progress claim suppresses another tab and loses to explicit setup", async () => {
  const jar = browserJar(), first = site("first"), second = site("second");
  let release;
  const pending = claimRefreshCoachmark({ location: first, document: jar.document(first), nonce,
    settle: () => new Promise(resolve => { release = resolve; }) });
  assert.equal(await claimRefreshCoachmark({ location: second, document: jar.document(second), nonce, settle: immediate }), false);
  rememberRefreshCoachmark({ location: second, document: jar.document(second) });
  release();
  assert.equal(await pending, false);
});

test("cancellation and a replaced claim cannot show a stale coachmark", async () => {
  const jar = browserJar(), location = site("first"), document = jar.document(location);
  assert.equal(await claimRefreshCoachmark({ location, document, nonce, settle: immediate, cancelled: () => true }), false);
  assert.equal(jar.writes.length, 0);
  assert.equal(await claimRefreshCoachmark({ location, document, nonce, settle: async () => {
    document.cookie = `${REFRESH_COACHMARK_COOKIE}=another-tab-token; Domain=example.chatgpt.site; Path=/; Secure`;
  } }), false);
  assert.equal(await claimRefreshCoachmark({ location, document, nonce, settle: immediate }), false);
});

test("unsupported hosts and unsafe claim tokens never write a cookie", async () => {
  const jar = browserJar(), location = new URL("https://custom.example.com");
  assert.equal(await claimRefreshCoachmark({ location, document: jar.document(location), nonce, settle: immediate }), false);
  assert.equal(await claimRefreshCoachmark({ location: site("first"), document: jar.document(site("first")), nonce: () => "; Domain=other.test", settle: immediate }), false);
  assert.equal(jar.writes.length, 0);
});

test("verification reminder dismissal is shared across workspace Sites without renewing on reads", () => {
  const jar = browserJar(), first = site("first"), second = site("second");
  assert.equal(readVerificationReminderDismissed({ location: first, document: jar.document(first) }), false);
  assert.equal(jar.writes.length, 0);
  assert.equal(rememberVerificationReminderDismissed({ location: first, document: jar.document(first) }), true);
  for (let read = 0; read < 20; read += 1) {
    assert.equal(readVerificationReminderDismissed({ location: second, document: jar.document(second) }), true);
  }
  assert.equal(jar.writes.length, 1, "Opening or rendering another dashboard does not renew the cookie");
  const [pair, ...attributes] = jar.writes[0].split("; ");
  assert.equal(pair, `${VERIFICATION_REMINDER_COOKIE}=1`);
  assert.ok(Buffer.byteLength(pair) < 64, "The request carries only one compact flag, not an identity or dashboard list");
  assert.deepEqual(attributes, ["Domain=example.chatgpt.site", "Path=/", "Max-Age=34560000", "Secure", "SameSite=Lax"]);
});

test("verification reminder cookies stay within their workspace and browser", () => {
  const jar = browserJar(), otherBrowser = browserJar();
  const first = site("first"), otherWorkspace = new URL("https://first.other.chatgpt.site/");
  assert.equal(rememberVerificationReminderDismissed({ location: first, document: jar.document(first) }), true);
  assert.equal(readVerificationReminderDismissed({ location: otherWorkspace, document: jar.document(otherWorkspace) }), false);
  assert.equal(readVerificationReminderDismissed({ location: first, document: otherBrowser.document(first) }), false);
  assert.equal(rememberVerificationReminderDismissed({ location: otherWorkspace, document: jar.document(otherWorkspace) }), true);
  assert.equal(readVerificationReminderDismissed({ location: first, document: jar.document(first) }), true);
  assert.equal(readVerificationReminderDismissed({ location: otherWorkspace, document: jar.document(otherWorkspace) }), true);
});

test("verification reminder storage has no unsupported-host or malformed-location fallback", () => {
  for (const location of [
    ...["http://first.example.chatgpt.site", "https://dashboard.chatgpt.site", "https://chatgpt.site",
      "https://custom.example.com", "https://localhost", "https://a.b.c.chatgpt.site", "https://a.b.chatgpt.site.evil.test"]
      .map(href => new URL(href)),
    null, {}, { protocol: "https:", hostname: 123 },
  ]) {
    let accessed = false;
    const document = { get cookie() { accessed = true; return `${VERIFICATION_REMINDER_COOKIE}=1`; },
      set cookie(_) { accessed = true; } };
    assert.equal(readVerificationReminderDismissed({ location, document }), false);
    assert.equal(rememberVerificationReminderDismissed({ location, document }), false);
    assert.equal(accessed, false, "Unsupported locations do not read or write cookies");
  }
});

test("verification reminder reads accept only one exact flag and fail closed for malformed cookies", () => {
  const location = site("first");
  for (const cookie of ["", `${VERIFICATION_REMINDER_COOKIE}=0`, `${VERIFICATION_REMINDER_COOKIE}=true`,
    `${VERIFICATION_REMINDER_COOKIE}=01`, `${VERIFICATION_REMINDER_COOKIE}=%31`, `${VERIFICATION_REMINDER_COOKIE}="1"`,
    `${VERIFICATION_REMINDER_COOKIE}=1x`, `other_${VERIFICATION_REMINDER_COOKIE}=1`,
    `${VERIFICATION_REMINDER_COOKIE}=1; ${VERIFICATION_REMINDER_COOKIE}=0`,
    `${VERIFICATION_REMINDER_COOKIE}=1; ${VERIFICATION_REMINDER_COOKIE}=1`, null, 1]) {
    assert.equal(readVerificationReminderDismissed({ location, document: { cookie } }), false, String(cookie));
  }
  assert.equal(readVerificationReminderDismissed({ location, document: {
    cookie: `unrelated=1; ${VERIFICATION_REMINDER_COOKIE}=1; another=0`,
  } }), true);
});

test("verification reminder writes require readback and leave the reminder enabled when storage fails", () => {
  const location = site("first"), blocked = browserJar({ blocked: true });
  for (const document of [null, blocked.document(location),
    { get cookie() { throw new Error("Cookie access blocked"); }, set cookie(_) {} },
    { get cookie() { return ""; }, set cookie(_) { throw new Error("Cookie write blocked"); } },
    { get cookie() { return `${VERIFICATION_REMINDER_COOKIE}=0`; }, set cookie(_) {} },
  ]) {
    assert.equal(readVerificationReminderDismissed({ location, document }), false);
    assert.equal(rememberVerificationReminderDismissed({ location, document }), false);
  }
});

test("verification and refresh cookies coexist without dismissing each other's reminders", async () => {
  const first = site("first"), second = site("second");
  const verificationFirst = browserJar();
  assert.equal(rememberVerificationReminderDismissed({ location: first, document: verificationFirst.document(first) }), true);
  assert.equal(await claimRefreshCoachmark({ location: second, document: verificationFirst.document(second), nonce, settle: immediate }), true);
  assert.equal(readVerificationReminderDismissed({ location: second, document: verificationFirst.document(second) }), true);
  assert.equal(await claimRefreshCoachmark({ location: first, document: verificationFirst.document(first), nonce, settle: immediate }), false);

  const refreshFirst = browserJar();
  assert.equal(rememberRefreshCoachmark({ location: first, document: refreshFirst.document(first) }), true);
  assert.equal(readVerificationReminderDismissed({ location: second, document: refreshFirst.document(second) }), false);
  assert.equal(rememberVerificationReminderDismissed({ location: second, document: refreshFirst.document(second) }), true);
  assert.equal(await claimRefreshCoachmark({ location: first, document: refreshFirst.document(first), nonce, settle: immediate }), false);
  assert.equal(readVerificationReminderDismissed({ location: first, document: refreshFirst.document(first) }), true);
  assert.equal(refreshFirst.document(first).cookie.split("; ").length, 2);
});

test("coachmark is owner-only, published-only, idle, non-modal, and only points to the refresh menu", async () => {
  const { readFile } = await import("node:fs/promises");
  const chrome = await readFile(new URL("../src/components/DataAppChrome.jsx", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/components/RefreshSetupCoachmark.jsx", import.meta.url), "utf8");
  assert.match(chrome, /mode !== "edit" && generatedAt && canEdit && surface !== "report"[\s\S]*?<DataAppRefreshControl[^>]*published=\{published\}/u);
  assert.match(chrome, /blocked=\{open \|\| menuOpen\}[^>]*anchor=\{trigger\}/u);
  assert.match(chrome, /if \(published === true\) rememberRefreshCoachmark\(\)/u);
  assert.match(source, /published !== true \|\| blocked \|\| !refreshCoachmarkDomain\(\) \|\| window.top !== window/u);
  assert.match(source, /document.visibilityState !== "visible"/u);
  assert.match(source, /setTimeout\(offerWhenIdle, 1800\)/u);
  assert.match(source, /cancelled: \(\) => cancelled \|\| isBusy\(\)/u);
  assert.match(source, /if \(!cancelled && claimed\) setVisible\(true\)/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /Set up automatic refreshes from this menu/u);
  assert.equal((source.match(/<button\b/gu) ?? []).length, 1, "The coachmark only has its dismissal control");
  assert.doesNotMatch(source, /onSetup|autoFocus|<[^>]*role="dialog"|href=|fetch\(|getActionHref|sendPrompt/u);
});
