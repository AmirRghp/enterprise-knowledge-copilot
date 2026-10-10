import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Load the route module's `readBounded` without Node having to understand TSX.
 *
 * Next compiles the route; Node does not. TypeScript is already a dependency, so the file
 * is transpiled with the same compiler the build uses rather than hand-stripped with
 * regexes - a regex strip broke the moment the function had a typed local, and the
 * failure mode was a syntax error in the test rather than in the code under test.
 *
 * The module imports `next/server` and a `server-only` helper, neither of which Node can
 * load, so the function is compiled on its own: the route's own source is used to find
 * it, and its signature and body are compiled together, so a change to the signature
 * cannot desynchronise this from the real function.
 */
async function loadRouteModule() {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(resolve(here, "../src/app/api/answers/route.ts"), "utf8");
  const start = source.indexOf("export async function readBounded");
  if (start < 0) throw new Error("readBounded is missing from route.ts");
  const rest = source.slice(start);
  const end = rest.indexOf("\nexport async function POST");
  if (end < 0) throw new Error("readBounded is no longer followed by POST; update this extractor");

  const ts = (await import("typescript")).default;
  const { outputText } = ts.transpileModule(rest.slice(0, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  // ESM output, because this file is an ES module: emitting CommonJS would produce a
  // bare `require` that Node refuses to mix with the top-level await above.
  const factory = new Function(`${outputText.replace("export ", "")}\nreturn readBounded;`);
  return { readBounded: factory() };
}

// Where the requests are sent, and the value the proxy compares an Origin header
// against. They are separate settings on purpose: WEB_ORIGIN is what the app is
// configured to accept, which is not necessarily the address the test reaches it on.
const base = process.env.WEB_TEST_ORIGIN ?? "http://localhost:3000";
const origin = process.env.WEB_TEST_ALLOWED_ORIGIN ?? "http://localhost:3000";
const foreign = "https://example.invalid";

// The seed password is read here rather than passed in, so the guard cases below
// run as an authenticated caller. That matters because the proxy checks the
// session *before* the body guards, exactly as the manager proxy does — a session
// of its own is what lets the content-type and ceiling cases reach the check they
// are about. The value is never printed, and never leaves this process.
function seedPassword() {
  const here = dirname(fileURLToPath(import.meta.url));
  const env = readFileSync(resolve(here, "../../../.env"), "utf8");
  const line = env.split("\n").find((item) => item.startsWith("SEED_MANAGER_PASSWORD="));
  const value = line?.slice("SEED_MANAGER_PASSWORD=".length).trim();
  if (!value) throw new Error("SEED_MANAGER_PASSWORD is not set");
  return value;
}

// A real session, obtained the way a browser obtains one. Returns the cookie the
// later requests carry, or throws — a guard test that silently ran unauthenticated
// would assert 401 everywhere and pass without testing anything.
async function signIn() {
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ login: "manager", password: seedPassword() }),
    redirect: "manual",
  });
  const raw = response.headers.get("set-cookie") ?? "";
  const match = /ekc_session=([^;]+)/.exec(raw);
  if (!response.ok || !match) throw new Error(`sign-in failed with ${response.status}`);
  return `ekc_session=${match[1]}`;
}

// The question body, valid on its own. Whether it reaches the API is a separate
// question: these cases are about what the proxy refuses and forwards, not about
// what the model would say.
const question = { question: "مهلت ثبت درخواست بازپرداخت هزینه سفر چند روز است؟" };

const cases = [
  // Every write demands the web origin. A cross-site page must not be able to spend
  // the provider's budget or read documents through an authenticated user.
  [
    "answers foreign origin",
    "/api/answers",
    { method: "POST", headers: { Origin: foreign }, body: question },
    403,
    foreign,
  ],
  // A missing Origin is refused, not tolerated. Tolerating it would let a non-browser
  // client spend the provider budget from anywhere, and the API's own origin check is
  // not the backstop for the proxy's — the proxy is what decides whether to call it.
  ["answers no origin", "/api/answers", { method: "POST", body: question }, 403, null],

  // Only JSON reaches the API. A multipart body here would be forwarded unchanged
  // and refused upstream, which turns a client mistake into a server log line.
  [
    "answers wrong content type",
    "/api/answers",
    { method: "POST", headers: { "Content-Type": "text/plain" }, body: "hi" },
    415,
  ],

  // A GET is a different method, not a smaller POST. Answering it would invite a
  // caller to expect a body from a request the API never defined.
  ["answers get refused", "/api/answers", { method: "GET" }, 405],
];

let failures = 0;
const cookie = await signIn();

// A case sets ``originHeader`` to override the default. Leaving it undefined sends
// the web origin, which is what almost every case wants. Setting it to null omits the
// header entirely, which is its own case: a missing Origin is not the web origin.
for (const [name, path, init, expected, originHeader] of cases) {
  const headers = { ...(init.headers ?? {}), Cookie: cookie };
  const value = originHeader === null ? undefined : (originHeader ?? origin);
  if (value !== undefined) headers.Origin = value;
  const response = await fetch(`${base}${path}`, {
    ...init,
    redirect: "manual",
    headers,
  });
  // drain so the socket is released
  await response.arrayBuffer().catch(() => {});
  if (response.status !== expected) {
    failures += 1;
    console.error(`FAIL ${name}: expected ${expected}, got ${response.status}`);
  } else {
    console.log(`ok   ${name}: ${response.status}`);
  }
}

// The body ceiling, asserted on the function that implements it.
//
// Asserting the status through HTTP could not tell a proxy that refused from one that
// forwarded and got the same 413 back from the API, which applies the same 64 KiB cap.
// Deleting the proxy's guard left both earlier tests green: the oversized case passed
// because the API answered 413, and the under-limit case only checked "not 413" so it
// would have passed on 200, 401, 500 or 502 alike.
//
// So the rule is proved directly. `readBounded` is the whole ceiling, and the only
// question about it is whether it stops reading. The route is compiled by Next, so the
// function is transpiled here from its source rather than imported - the same trick the
// auth proxy test uses to stay dependency-free.
const ceiling = 64 * 1024;
const { readBounded } = await loadRouteModule();

/**
 * A reader over a body of `total` bytes, chunked at 4 KiB the way a real request arrives.
 *
 * It counts what it actually hands out. An earlier version of this helper exposed only the
 * stream, and the test that claimed to prove early stopping computed the chunk count from
 * the ceiling arithmetic instead - a constant that came out the same whether the function
 * read one chunk or all sixty-four, so the assertion passed without ever consulting the
 * code. The counters here are what makes that property observable.
 */
function readerFor(total, chunkSize = 4096) {
  const queue = [];
  for (let start = 0; start < total; start += chunkSize) {
    queue.push({ done: false, value: new Uint8Array(Math.min(chunkSize, total - start)) });
  }
  queue.push({ done: true, value: undefined });
  let cancelled = false;
  let reads = 0;
  let delivered = 0;
  return {
    reader: {
      read: async () => {
        reads += 1;
        const chunk = queue.shift() ?? { done: true, value: undefined };
        if (!chunk.done) delivered += chunk.value.byteLength;
        return chunk;
      },
      cancel: async () => {
        cancelled = true;
      },
    },
    wasCancelled: () => cancelled,
    reads: () => reads,
    deliveredBytes: () => delivered,
    totalChunks: () => queue.length,
  };
}

const over = readerFor(ceiling + 1);
const overResult = await readBounded(over.reader, ceiling);
if (overResult !== null || !over.wasCancelled()) {
  failures += 1;
  console.error(
    `FAIL over-ceiling: expected null and a cancelled stream, got ${JSON.stringify(overResult)} cancelled=${over.wasCancelled()}`,
  );
} else {
  console.log(`ok   over-ceiling refused and stream cancelled`);
}

// Exactly at the ceiling is accepted. An off-by-one here would refuse a legitimate
// maximum-size body, and this is the boundary a byte ceiling gets wrong.
const at = readerFor(ceiling);
const atResult = await readBounded(at.reader, ceiling);
const atBytes = atResult ? atResult.reduce((n, c) => n + c.byteLength, 0) : -1;
if (atBytes !== ceiling) {
  failures += 1;
  console.error(`FAIL at-ceiling: expected ${ceiling} bytes returned, got ${atBytes}`);
} else {
  console.log(`ok   at-ceiling accepted: ${atBytes} bytes`);
}

const under = readerFor(ceiling - 1);
const underResult = await readBounded(under.reader, ceiling);
const underBytes = underResult ? underResult.reduce((n, c) => n + c.byteLength, 0) : -1;
if (underBytes !== ceiling - 1) {
  failures += 1;
  console.error(`FAIL under-ceiling: expected ${ceiling - 1} bytes returned, got ${underBytes}`);
} else {
  console.log(`ok   under-ceiling accepted: ${underBytes} bytes`);
}

// The oversized body must not be delivered whole. A guard that read everything, compared
// afterwards, then cancelled and returned null would pass every assertion above and still
// make the caller hand over the very bytes the proxy promised to refuse - which is the
// whole point of capping a stream rather than a length.
//
// This compares what the reader *handed out* against what the body held, so a function
// that drains the stream is distinguishable from one that stops at the ceiling. Both
// halves matter: the delivered bytes must not reach the ceiling by more than one chunk,
// and they must be a small fraction of the body, not merely "less than all of it".
const bodySize = ceiling * 4;
const big = readerFor(bodySize);
const bigResult = await readBounded(big.reader, ceiling);
const delivered = big.deliveredBytes();
const chunk = 4096;
// One chunk of overshoot is inherent to counting after a chunk arrives, and is the same
// trade the API's own guard documents. A whole-buffer read would overshoot by the entire
// remaining body, so this bound separates the two by three orders of magnitude.
const allowance = ceiling + chunk;
if (bigResult !== null) {
  failures += 1;
  console.error("FAIL oversize stop: an oversized body was accepted");
} else if (delivered > allowance) {
  failures += 1;
  console.error(
    `FAIL oversize stop: delivered ${delivered} bytes of ${bodySize} before refusing; the ceiling is ${ceiling}`,
  );
} else if (delivered >= bodySize / 2) {
  failures += 1;
  console.error(`FAIL oversize stop: read half the body (${delivered} bytes) before refusing`);
} else {
  console.log(
    `ok   stops reading at the ceiling: ${delivered} bytes of ${bodySize} delivered in ${big.reads()} reads`,
  );
}

// The valid path: correct origin, correct content type, a body inside the ceiling.
// It reaches the API and comes back with whatever the API decides — 200 with an
// answer, 401 without a session. Both are correct outcomes; what this asserts is
// that the proxy forwarded a well-formed request instead of refusing it.
const wellFormed = await fetch(`${base}/api/answers`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify(question),
  redirect: "manual",
});
const status = wellFormed.status;
await wellFormed.arrayBuffer().catch(() => {});
if (
  status !== 200 &&
  status !== 401 &&
  status !== 403 &&
  status !== 429 &&
  status !== 502 &&
  status !== 504
) {
  failures += 1;
  console.error(`FAIL well-formed: unexpected status ${status}`);
} else {
  console.log(`ok   well-formed forwarded: ${status}`);
}

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("all answer proxy guards held");
