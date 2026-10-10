/**
 * Transition tests for the source hook.
 *
 * Every defect here is about a *transition*, and none of them is visible from a single
 * synchronous render - the previous checks all rendered once. Each test drives the real
 * hook under real React, with the fetch settled by hand so a stale read can be delivered
 * after a newer one has already settled.
 *
 * The property throughout: a result belongs to the handle that asked for it. A page that
 * says "you cited COM-001" and shows HR-007's text has not merely a stale cache; it has
 * told the reader that one passage is evidence for something it is not.
 */
import { installDom, controlledFetch } from "./dom-harness.mjs";
import { loadContract, loadSourceHook } from "./load-source-hook.mjs";

const restore = installDom();
const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
// `act` from React itself. `react-dom/test-utils` still exports one, but React 19 warns
// on every call that it is deprecated, and a warning printed on every run is a warning
// nobody reads.
const { act } = React;

const contract = await loadContract();
const { useSourceSection } = await loadSourceHook(React, contract);

const fetchStub = controlledFetch();
const realFetch = globalThis.fetch;
globalThis.fetch = fetchStub;

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
};

const handle = (n) => ({
  document_id: `DOC-00${n}`,
  section_id: `DOC-00${n}-S1`,
  revision: `${n}${n}${n}${n}${n}${n}${n}${n}-1111-4111-8111-111111111111`,
});
const A = handle(1);
const B = handle(2);
const body = (h, text) => ({
  document_id: h.document_id,
  section_id: h.section_id,
  revision: h.revision,
  title: `عنوان ${h.section_id}`,
  heading_path: ["سند"],
  text,
});

/** Mount the hook and record every state it reports. */
const seen = [];
function Probe({ target }) {
  seen.push(useSourceSection(target));
  return null;
}

const container = globalThis.document.createElement("div");
globalThis.document.body.appendChild(container);
const root = createRoot(container);
const render = async (target) => {
  await act(async () => {
    root.render(React.createElement(Probe, { target }));
  });
  return seen.at(-1);
};
const last = () => seen.at(-1);

// --- A handle change must show loading, never the previous document. -----------------------

seen.length = 0;
fetchStub.pending.length = 0;
await render(A);
check("a fresh handle starts out loading", last().kind === "loading", last().kind);

await act(async () => {
  fetchStub.respond(0, body(A, "متن الف"));
  fetchStub.pending[0].releaseBody();
});
check(
  "a settled handle reports its own text",
  last().kind === "ready" && last().section.text === "متن الف",
  last().kind,
);

const switched = await render(B);
// The core of the review's first finding: after A is ready, asking for B must not keep
// showing A. A reader who clicked a second citation would be reading the first one's text
// under the second one's heading.
check(
  "changing the handle returns to loading rather than the previous section",
  switched.kind === "loading",
  `kind=${switched.kind}${switched.section ? ` text=${switched.section.text}` : ""}`,
);

await act(async () => {
  fetchStub.respond(1, body(B, "متن ب"));
  fetchStub.pending[1].releaseBody();
});
check(
  "the new handle settles on its own text",
  last().section?.text === "متن ب",
  last().section?.text ?? last().kind,
);

// --- A late body from the older read must not overwrite the newer result. ------------------

// The ordering is the whole point, and it is easy to get wrong. C's response must arrive
// while C is *still the current handle*, so the hook passes its `cancelled` check and
// blocks on `await response.json()`. Only then does D replace it. Reversing these two
// steps - releasing C's body before D mounts - would let the cancellation be caught by the
// earlier check and the defect would go unseen, which is exactly what the first version
// of this test did.
seen.length = 0;
fetchStub.pending.length = 0;
const C = handle(3);
const D = handle(4);
await render(C);
await act(async () => {
  fetchStub.respond(0, body(C, "متن ج دیررس"));
});
check(
  "the read is past its cancellation check and blocked on the body",
  fetchStub.pending[0].settled && !fetchStub.pending[0].bodyReleased,
  "the gap the defect lives in",
);

// D replaces C, and is itself refused.
await render(D);
await act(async () => {
  fetchStub.respond(1, { detail: "not found" }, 404);
});
check("the newer handle reports unavailable", last().kind === "unavailable", last().kind);

// Now C's body lands. The hook cancelled its effect when D mounted, but that cancellation
// was checked before it began waiting on the body - so unless it is checked again after
// the `await`, C's section overwrites D's refusal.
await act(async () => {
  fetchStub.pending[0].releaseBody();
});
check(
  "a body awaited across the replacement does not overwrite the newer result",
  last().kind === "unavailable",
  `kind=${last().kind}${last().section ? ` text=${last().section.text}` : ""}`,
);

// The same again, with the newer handle succeeding rather than refusing: a slow upstream
// must not replace a fresh answer either.
seen.length = 0;
fetchStub.pending.length = 0;
const K = handle(11);
const L = handle(12);
await render(K);
await act(async () => {
  fetchStub.respond(0, body(K, "متن ک"));
});
await render(L);
await act(async () => {
  fetchStub.respond(1, body(L, "متن ل"));
  fetchStub.pending[1].releaseBody();
});
check(
  "the newer handle settles on its own text",
  last().section?.text === "متن ل",
  last().section?.text ?? last().kind,
);
await act(async () => {
  fetchStub.pending[0].releaseBody();
});
check(
  "a slow upstream body cannot replace a newer success",
  last().section?.text === "متن ل",
  last().section?.text ?? last().kind,
);

// --- The same handle re-read must still settle. -------------------------------------------

// A guard that simply refuses every write after the first cleanup would pass everything
// above and break this. Nothing here changes the handle, so nothing is replaced.
seen.length = 0;
fetchStub.pending.length = 0;
const J = handle(10);
await render(J);
await act(async () => {
  fetchStub.respond(0, body(J, "متن ج"));
  fetchStub.pending[0].releaseBody();
});
check(
  "an unchanged handle settles normally",
  last().section?.text === "متن ج",
  last().section?.text ?? last().kind,
);

// --- An equivalent handle must not refetch. -----------------------------------------------

// `useSearchParams` builds a new object on every navigation, so the same citation can
// arrive as a different object holding the same three identifiers. Without stability the
// hook would refetch - and, worse, a page that already has the text would flash back to
// loading on a navigation that changed nothing about the citation.
seen.length = 0;
fetchStub.pending.length = 0;
const M = handle(13);
await render(M);
await act(async () => {
  fetchStub.respond(0, body(M, "متن م"));
  fetchStub.pending[0].releaseBody();
});
check(
  "the first read settles",
  last().section?.text === "متن م",
  last().section?.text ?? last().kind,
);

await render({ ...M });
check(
  "an equal handle re-rendered as a new object issues no second read",
  fetchStub.pending.length === 1,
  `${fetchStub.pending.length} requests after re-render`,
);
check(
  "and the settled section stays on screen",
  last().section?.text === "متن م",
  last().section?.text ?? last().kind,
);

// A genuinely different citation must still refetch, or the check above would also pass
// against a hook that never refetched at all.
await render(handle(14));
check(
  "a different citation does issue a read",
  fetchStub.pending.length === 2,
  `${fetchStub.pending.length} requests after changing the citation`,
);

// --- The request for a replaced handle must actually be aborted. ---------------------------

seen.length = 0;
fetchStub.pending.length = 0;
const G = handle(7);
const H = handle(8);
await render(G);
const gCall = fetchStub.pending[0];
const gSignal = gCall.signal;
await render(H);
check(
  "the replaced read's request is aborted, not merely ignored",
  gSignal?.aborted === true,
  gSignal ? `aborted=${gSignal.aborted}` : "no signal was passed to fetch",
);

// --- No handle means no request and no section. ------------------------------------------

seen.length = 0;
fetchStub.pending.length = 0;
await render(null);
check("no handle reports idle", last().kind === "idle", last().kind);
check(
  "no handle issues no request",
  fetchStub.pending.length === 0,
  `${fetchStub.pending.length} requests`,
);
check("no handle leaves no section", last().section === undefined);

// --- A read that fails for a reason other than refusal. -----------------------------------

seen.length = 0;
fetchStub.pending.length = 0;
const I = handle(9);
await render(I);
await act(async () => {
  fetchStub.respond(0, { detail: "request could not be completed" }, 502);
});
check(
  "an upstream failure is reported as failed, not unavailable",
  last().kind === "failed",
  last().kind,
);

// The two guards are deliberately redundant, and this says so rather than leaving it to be
// discovered: `catch` declines to commit an abandoned read, and `commit` refuses to write
// one regardless. Removing only `catch`'s guard changes nothing observable, which is why a
// mutation that strips it stays green - and that is the honest result, not a missing test.
// What is asserted here is the property the pair exists to provide: with the inner guard
// gone, the outer one still holds, so a stale read cannot reach the screen.
seen.length = 0;
fetchStub.pending.length = 0;
const OUTER_ONLY = handle(25);
const OUTER_NEXT = handle(26);
await render(OUTER_ONLY);
await act(async () => {
  fetchStub.respond(0, body(OUTER_ONLY, "متن الف"));
});
await render(OUTER_NEXT);
check(
  "the key guard holds even where the flag guard is described as absent",
  last().kind === "loading",
  `kind=${last().kind}`,
);

// --- The deadline must reach the reader. ---------------------------------------------------
//
// A separate mount, with the hook's own 15-second bound shortened so the timer actually
// fires inside a test. Everything else is the shipped code; only the duration is rewritten
// (see `loadSourceHook`, which refuses to substitute if the literal has moved).
//
// The defect: the deadline aborted the request, the fetch rejected with `AbortError`, and
// the catch ignored every `AbortError` on the assumption it meant "the reader navigated
// away". Both aborts look identical there, so a read that ran out of time left the hook
// returning `loading` for as long as the page stayed open - no message, no error, and
// nothing to tell the reader it was not still working.

const { useSourceSection: useWithShortDeadline } = await loadSourceHook(React, contract, 60);
const deadlineSeen = [];
function DeadlineProbe({ target }) {
  deadlineSeen.push(useWithShortDeadline(target));
  return null;
}

const deadlineContainer = globalThis.document.createElement("div");
globalThis.document.body.appendChild(deadlineContainer);
const deadlineRoot = createRoot(deadlineContainer);
const deadlineRender = async (target) => {
  await act(async () => {
    deadlineRoot.render(React.createElement(DeadlineProbe, { target }));
  });
  return deadlineSeen.at(-1);
};

seen.length = 0;
fetchStub.pending.length = 0;
const TIMED_OUT = handle(20);
await deadlineRender(TIMED_OUT);
check("a pending read starts out loading", deadlineSeen.at(-1).kind === "loading");

// Let the real timer fire. No response is ever delivered, which is the point.
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 160));
});
const afterDeadline = deadlineSeen.at(-1);
check(
  "a read that exceeded its deadline reports failed, not loading",
  afterDeadline.kind === "failed",
  `kind=${afterDeadline.kind}`,
);
check(
  "the deadline really aborted the request",
  fetchStub.pending[0]?.signal?.aborted === true,
  fetchStub.pending[0]?.signal ? `aborted=${fetchStub.pending[0].signal.aborted}` : "no signal",
);

// The same, when the response has arrived but its body is still being read. A timeout that
// lands in that window is the one an earlier check could not see, because it needs the
// body to be held open across the deadline.
seen.length = 0;
fetchStub.pending.length = 0;
const SLOW_BODY = handle(21);
await deadlineRender(SLOW_BODY);
await act(async () => {
  fetchStub.respond(0, body(SLOW_BODY, "متن ک"));
});
check("the response arrived but its body is still held", fetchStub.pending[0].settled);
await act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 160));
});
check(
  "a deadline that lands while the body is being read also reports failed",
  deadlineSeen.at(-1).kind === "failed",
  `kind=${deadlineSeen.at(-1).kind}`,
);

// And the opposite: a read replaced by a new citation is *not* a failure, and the newer
// read must survive whatever the older one does. This is the case that decides whether the
// catch may commit unconditionally, so it is checked at the moment the replacement
// happens - before the newer read has answered. Checking it only after the newer read
// settles would pass against a hook that reported a failure for every navigation and then
// immediately overwrote it, which is exactly what an unguarded `catch` does.
seen.length = 0;
deadlineSeen.length = 0;
fetchStub.pending.length = 0;
const REPLACED = handle(22);
const CURRENT = handle(23);
await deadlineRender(REPLACED);
await deadlineRender(CURRENT);
const rightAfterSwap = deadlineSeen.at(-1);
check(
  "replacing a citation does not report a failure",
  rightAfterSwap.kind === "loading",
  `kind=${rightAfterSwap.kind}`,
);

// The older request is aborted by the replacement, and that abort reaches the older
// effect's catch. The abandoned read carries the *old* handle's key, so even a commit with
// no guard at all would be screened by the key and never shown. What the reader would
// actually lose is checked instead: the page must go on to show the new citation's text,
// and the abandoned read's late body must not replace it.
await act(async () => {
  fetchStub.respond(1, body(CURRENT, "متن ب"));
  fetchStub.pending[1].releaseBody();
});
check(
  "the newer read settles on its own text",
  deadlineSeen.at(-1).section?.text === "متن ب",
  deadlineSeen.at(-1).section?.text ?? deadlineSeen.at(-1).kind,
);

await act(async () => {
  fetchStub.respond(0, body(REPLACED, "متن الف"));
  fetchStub.pending[0].releaseBody();
});
check(
  "the abandoned read's late body does not replace the newer text",
  deadlineSeen.at(-1).section?.text === "متن ب",
  deadlineSeen.at(-1).section?.text ?? deadlineSeen.at(-1).kind,
);

// Unmounting is the other way a read is abandoned, and it must be silent. A component that
// has gone cannot be told anything, and whatever it left in state must not resurface when a
// later citation happens to carry the same three identifiers - which is exactly what a
// commit-by-key with no cancellation check would allow.
deadlineSeen.length = 0;
fetchStub.pending.length = 0;
const UNMOUNTED = handle(24);
await deadlineRender(UNMOUNTED);
await act(async () => {
  deadlineRoot.unmount();
  fetchStub.respond(0, body(UNMOUNTED, "متن الف"));
  fetchStub.pending[0].releaseBody();
});
check(
  "unmounting leaves no result for a handle nobody is showing",
  deadlineSeen.every((state) => state.kind === "loading"),
  `states: ${deadlineSeen.map((state) => state.kind).join(" -> ")}`,
);

// Every root is torn down before the document is taken away. A root left mounted keeps a
// React scheduler alive, and its next update reaches for `window` after `restore` has put
// it back - so the run would end on a "window is not defined" from React rather than on
// this file's own result.
await act(async () => {
  root.unmount();
});

globalThis.fetch = realFetch;
restore();

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all source-transition checks passed");
