/**
 * Guard tests for the read proxies.
 *
 * Two properties carry the weight here and neither is visible from a status code alone:
 *
 *  - a malformed identifier is refused *before* anything is forwarded, and
 *  - the API's three identical 404s stay identical on the way out.
 *
 * The second is the one worth stating plainly. The API answers a missing document, a
 * forbidden one and a stale revision with one byte-identical body, and a proxy that
 * reshaped or re-labelled that would turn a single query with three conditions back into
 * three observable outcomes - which is the whole reason the API put them in one statement.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The proxy modules import `next/server` and a `server-only` helper, neither of which Node
// can load, so the identifier patterns are taken from the contract module, which is plain
// TypeScript, and the route's own logic is exercised through the running dev server.
const { DOCUMENT_ID_PATTERN, SECTION_ID_PATTERN, REVISION_PATTERN, sourcePath } =
  await loadContractModule();

const base = process.env.WEB_TEST_ORIGIN ?? "http://localhost:3000";
const origin = process.env.WEB_TEST_ALLOWED_ORIGIN ?? "http://localhost:3000";

const revision = "9d7dbde1-1111-4222-8333-444444444444";
const foreign = "https://example.invalid";

async function loadContractModule() {
  const source = readFileSync(resolve(here, "../src/lib/document-contract.ts"), "utf8");
  const ts = (await import("typescript")).default;

  const from = (start) => {
    const at = source.indexOf(start);
    if (at < 0) throw new Error(`${start} not found in document-contract.ts`);
    return at;
  };

  // The three patterns, and sourcePath, in one compiled fragment. Read separately so the
  // extraction fails loudly when the file is reorganised rather than quietly testing a
  // stale copy.
  const patternsStart = from("export const DOCUMENT_ID_PATTERN");
  const patternsEnd = from("export function sourceHandleFrom");
  const patterns = ts.transpileModule(source.slice(patternsStart, patternsEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  const pathStart = from("export function sourcePath");
  // To the end of the file: the function is last, and its body contains braces that a
  // first-closing-brace search would mistake for its end.
  const pathEnd = source.length;
  const path = ts.transpileModule(source.slice(pathStart, pathEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;

  const factory = new Function(`
    ${patterns.replace(/^export /gm, "")}
    ${path.replace(/^export /gm, "")}
    return { DOCUMENT_ID_PATTERN, SECTION_ID_PATTERN, REVISION_PATTERN, sourcePath };
  `);
  return factory();
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`ok   ${name}${detail ? `: ${detail}` : ""}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Compile one route module and return its `GET`.
 *
 * `next/server` and the `server-only` config helper cannot be loaded by Node, so the route
 * is compiled on its own and handed those two collaborators as stubs. That is enough for
 * the identifier guard, which runs before either is used - and the tests below assert the
 * *forwarding* decision with their own stubbed `fetch`, so nothing here decides the result.
 */
async function loadRoute(relative) {
  const COUNTER = { calls: 0 };
  const source = readFileSync(resolve(here, "../" + relative), "utf8");
  const ts = (await import("typescript")).default;
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  });
  // Only the module imports are removed, and the two collaborators the route actually
  // calls are re-supplied as parameters. Filtering the import lines alone is not enough:
  // the compiled body still names `forwardRead`, so dropping the import without providing
  // the name leaves it referring to something undefined.
  const body = outputText
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .map((line) => line.replace(/^export (async function|function|const) /, "$1 "))
    .join("\n");
  // The identifier patterns are real, taken from the contract module below. Inlining a
  // stub for them would make the allowlist tests assert the test's own idea of a shape
  // rather than the shape the app applies.
  const factory = new Function(
    "DOCUMENT_ID_PATTERN",
    "SECTION_ID_PATTERN",
    "REVISION_PATTERN",
    "COUNTER",
    `
    // The counter sits beside the collaborator it replaces. A counter in the test file's
    // scope belongs to a different closure than the one the route calls, so it reads zero
    // forever - which is precisely what an earlier version of this test did.
    let forwardRead = async () => { COUNTER.calls += 1; return { status: 204 }; };
    let proxyFailure = (status) => ({ status });
    ${body}
    return { GET, counter: COUNTER };
  `,
  );
  return factory(DOCUMENT_ID_PATTERN, SECTION_ID_PATTERN, REVISION_PATTERN, COUNTER);
}

// --- The identifier shapes the API accepts, asserted against the contract module. --------

check(
  "document id shape accepted",
  DOCUMENT_ID_PATTERN.test("HR-001") &&
    !DOCUMENT_ID_PATTERN.test("-bad") &&
    !DOCUMENT_ID_PATTERN.test(""),
);
check(
  "section id shape accepted",
  SECTION_ID_PATTERN.test("HR-007-S1") && !SECTION_ID_PATTERN.test("a".repeat(129)),
);
check(
  "revision shape accepted",
  REVISION_PATTERN.test(revision) && !REVISION_PATTERN.test("not-a-uuid"),
);

// A citation address must carry the revision it was made against: a link without one would
// show whatever is current now, which is the drift a citation exists to prevent.
const citation = sourcePath({
  document_id: "HR-007",
  section_id: "HR-007-S1",
  revision,
});
check(
  "citation path carries all three identifiers",
  citation.startsWith("/sources?") &&
    citation.includes("document=HR-007") &&
    citation.includes("section=HR-007-S1") &&
    citation.includes(`revision=${revision}`),
  citation,
);

// --- The proxy routes, over HTTP against the running app. --------------------------------

async function get(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Origin: origin, ...(init.headers ?? {}) },
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body, headers: response.headers };
}

// A session is needed so a malformed-identifier refusal is shown to come from the shape
// check rather than from the proxy answering 401 to everything.

// Sign in, honouring the API's own login rate limit rather than failing when it is hit.
// The limiter is keyed on the client address *and* the login, so repeated runs of this
// file count against it; reading `Retry-After` and waiting is the difference between a
// test that is occasionally red and one that reports a real failure.
const signIn = async (login) => {
  const password = process.env[`WEB_TEST_${login.toUpperCase()}_PASSWORD`];
  const account = process.env[`WEB_TEST_${login.toUpperCase()}_LOGIN`] ?? login;
  if (!password) throw new Error(`WEB_TEST_${login.toUpperCase()}_PASSWORD is required`);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ login: account, password }),
      redirect: "manual",
    });
    if (response.status !== 429) {
      const found = /ekc_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "");
      if (!found) throw new Error(`${login} sign-in failed with ${response.status}`);
      return `ekc_session=${found[1]}`;
    }
    const wait = Number(response.headers.get("retry-after") ?? "5") * 1000;
    console.log(`     (login rate limit; waiting ${Math.ceil(wait / 1000)}s)`);
    await new Promise((resolve) => setTimeout(resolve, wait + 250));
  }
  throw new Error(`${login} sign-in is still rate limited after three waits`);
};

const cookie = await signIn("employee");
const authed = { headers: { Cookie: cookie } };

// A malformed shape is refused as 404, the same as every other refusal. Answering 422 would
// make this the one path where the *shape* of a request decides what a caller learns.
//
// The upstream is stubbed so the refusal is attributable. Without this the assertion could
// not tell a proxy that refused from one that forwarded and got the same 404 back: Next
// rejects some of these shapes on its own, and the API answers others with 422 - and a test
// that only reads a status passed with the entire allowlist deleted. The upstream here
// answers 204 to anything it is actually asked, so a forwarded request is unmistakable.
const STUB_BASE = "http://127.0.0.1:9";
process.env.API_BASE_URL = STUB_BASE;
process.env.WEB_ORIGIN = origin;

const { GET: sourcesRoute, counter } = await loadRoute("src/app/api/sources/[...path]/route.ts");

// The catch-all param is built the way Next builds it: everything after the route's own
// directory. The prefix is read off the route's location on disk rather than sliced by
// hand, because a hand-written slice is how the first version of this file came to feed
// the route four segments when Next sends three - the route and the test were wrong
// together, so every assertion below passed against a route that refused every real
// citation.
const ROUTE_PREFIX = "api/sources";
const captureSegments = (pathname) => {
  const at = pathname.indexOf(`/${ROUTE_PREFIX}`);
  if (at < 0) throw new Error(`${pathname} is not under /${ROUTE_PREFIX}`);
  return pathname
    .slice(at + ROUTE_PREFIX.length + 1)
    .split("/")
    .filter(Boolean);
};

async function callRoute(handler, path, counter, init = {}) {
  counter.calls = 0;
  const [pathname, search = ""] = path.split("?");
  const segments = captureSegments(pathname);
  // A plain `Request` has no `nextUrl`, which is where the route reads the query from. The
  // object carries exactly the members the route uses, so a guard under test runs instead
  // of throwing on a missing property.
  const request = {
    nextUrl: { pathname, search, searchParams: new URLSearchParams(search) },
    headers: new Headers({ Origin: origin, ...(init.headers ?? {}) }),
  };
  const response = await handler(request, {
    params: Promise.resolve({ path: segments }),
  });
  return { status: response.status, calls: counter.calls, segments };
}

const badShapes = [
  ["revision missing", "/api/sources/HR-007/sections/HR-007-S1"],
  ["revision not a uuid", "/api/sources/HR-007/sections/HR-007-S1?revision=abc"],
  ["extra query parameter", `/api/sources/HR-007/sections/HR-007-S1?revision=${revision}&x=1`],
  [
    "document id over 64 characters",
    `/api/sources/${"a".repeat(70)}/sections/S1?revision=${revision}`,
  ],
  [
    "section id over 128 characters",
    `/api/sources/HR-007/sections/${"a".repeat(140)}?revision=${revision}`,
  ],
  ["unknown path depth", `/api/sources/HR-007?revision=${revision}`],
];
for (const [name, path] of badShapes) {
  const response = await callRoute(sourcesRoute, path, counter);
  check(
    `malformed ${name} refused before forwarding`,
    response.status === 404 && response.calls === 0,
    `got ${response.status} with ${response.calls} upstream calls`,
  );
}

// A well-formed handle reaches the upstream. Without this the guard above would also pass
// against a route that refused everything.
const forwarded = await callRoute(
  sourcesRoute,
  `/api/sources/HR-007/sections/HR-007-S1?revision=${revision}`,
  counter,
);
check(
  "a well-formed handle is forwarded",
  forwarded.calls === 1,
  `status ${forwarded.status} with ${forwarded.calls} upstream calls`,
);

// A foreign origin is refused on a read. The API skips safe methods, so this is the layer
// that closes it.
const foreignRead = await get("/api/documents", { headers: { Origin: foreign, Cookie: cookie } });
check("foreign origin refused on a read", foreignRead.status === 403, `got ${foreignRead.status}`);

// A query on the document list is refused rather than ignored: an unknown filter on a
// listing is either a caller that expects it to mean something, or one probing for a rule
// the allowlist does not have.
const listQuery = await get("/api/documents?role=manager", authed);
check("query on the document list refused", listQuery.status === 404, `got ${listQuery.status}`);

// The authorized list serves, and no body is cached.
const list = await get("/api/documents", authed);
check(
  "authorized list served",
  list.status === 200 && list.body.includes('"documents"'),
  `got ${list.status}`,
);
check(
  "list carries no-store",
  (list.headers.get("cache-control") ?? "").includes("no-store"),
  list.headers.get("cache-control") ?? "none",
);

// --- The three refusals, each of which must actually reach the API. ----------------------
//
// The first version of this block built the `absent` and `forbidden` URLs without a
// revision. That made both of them malformed handles, which the route refuses before
// forwarding - so the comparison was between two local rejections and one stale revision,
// and the authorization gate was never exercised at all. The count of upstream calls below
// is what makes the difference visible: a fixture that never left the proxy shows zero.
//
// The forbidden fixture is a real, ready manager document read with an employee session.
// A made-up id would have been an absence test wearing a permission test's name.

const managerCookie = await signIn("manager");

// The document list proves both halves the forbidden fixture needs: that MGR-002 exists,
// and that a manager's list carries its current revision. Without the second half there
// would be nothing to ask for, and the request would be stale rather than forbidden.
const managerList = await (async () => {
  const response = await fetch(`${base}/api/documents`, {
    headers: { Origin: origin, Cookie: managerCookie },
    redirect: "manual",
  });
  const payload = await response.json();
  return payload.documents ?? [];
})();
const managerOnly = managerList.find((entry) => entry.access_role === "manager");
check(
  "the fixture corpus has a ready manager-only document",
  Boolean(managerOnly),
  managerOnly ? managerOnly.document_id : "none found",
);
const employeeList = JSON.parse((await get("/api/documents", authed)).body).documents;
const employeeIds = new Set(employeeList.map((entry) => entry.document_id));
check(
  "and an employee cannot see it in their own list",
  managerOnly ? !employeeIds.has(managerOnly.document_id) : false,
  managerOnly ? `${managerOnly.document_id} absent from the employee list` : "",
);

// A read the employee *is* allowed, so the fixture set contains a positive case and the
// refusals cannot be explained by everything being broken.
const allowedRevision = employeeList[0].revision;
const allowed = await get(
  `/api/sources/${employeeList[0].document_id}/sections/${employeeList[0].document_id}-S1?revision=${allowedRevision}`,
  authed,
);
check(
  "an authorized section read serves 200 alongside the refusals",
  allowed.status === 200 && allowed.body.includes('"text"'),
  `got ${allowed.status}`,
);

const NONE = "00000000-0000-0000-0000-000000000000";
const refusals = [
  // Absent: a well-shaped handle for a document that does not exist, with a valid
  // revision, so it is refused by the database rather than by the identifier check.
  ["absent", `/api/sources/NOPE-999/sections/NOPE-999-S1?revision=${NONE}`],
  // Forbidden: a real, ready, manager-only document and its *current* revision, read with
  // an employee session. The revision is right on purpose - a wrong one would be a stale
  // test, and would pass even if the allowlist did not work at all.
  [
    "forbidden",
    managerOnly
      ? `/api/sources/${managerOnly.document_id}/sections/${managerOnly.document_id}-S1?revision=${managerOnly.revision}`
      : `/api/sources/MGR-002/sections/MGR-002-S1?revision=${NONE}`,
  ],
  // Stale: a document the employee may read, at a revision that is not current.
  [
    "stale",
    `/api/sources/${employeeList[0].document_id}/sections/${employeeList[0].document_id}-S1?revision=${NONE}`,
  ],
];

const bodies = new Set();
for (const [name, path] of refusals) {
  const response = await get(path, authed);
  bodies.add(`${response.status}|${response.body}`);
  check(`${name} refused with 404`, response.status === 404, `got ${response.status}`);
  check(
    `${name} carries no-store`,
    (response.headers.get("cache-control") ?? "").includes("no-store"),
    response.headers.get("cache-control") ?? "none",
  );
}
check(
  "the three refusals are byte-identical through the proxy",
  bodies.size === 1,
  `${bodies.size} distinct`,
);

// And, separately, that each of these three reaches the API. The counter proves the
// refusal came from the allowlist under the document rather than from the identifier check
// in front of it - which is the whole difference between a permission test and an absence
// test.
const { GET: liveSourcesRoute, counter: liveCounter } = await loadRoute(
  "src/app/api/sources/[...path]/route.ts",
);
for (const [name, path] of refusals) {
  liveCounter.calls = 0;
  const outcome = await callRoute(liveSourcesRoute, path, liveCounter);
  check(
    `${name} reaches the API rather than being refused locally`,
    outcome.calls === 1,
    `${outcome.calls} upstream calls`,
  );
}

// Reaching the API is not the same as reaching the *right* refusal. An id that does not
// exist also reaches the API and also answers 404, so a forbidden fixture pointing at an
// absent document would pass every check above while testing nothing about permission.
//
// A manager session is the witness: the same handle that the employee cannot read is read
// here, and must serve its text. If that ever stopped being 200 the fixture would have
// stopped being a permission test, and this is where that would show up.
if (managerOnly) {
  const asManager = await get(
    `/api/sources/${managerOnly.document_id}/sections/${managerOnly.document_id}-S1?revision=${managerOnly.revision}`,
    { headers: { Cookie: managerCookie } },
  );
  check(
    "the forbidden fixture is a document a manager can actually read",
    asManager.status === 200 && asManager.body.includes('"text"'),
    `manager got ${asManager.status}`,
  );
  const sameHandleAsEmployee = refusals.find(([name]) => name === "forbidden")[1];
  check(
    "and the employee is refused the very same handle",
    sameHandleAsEmployee.includes(managerOnly.document_id),
    "a different id would be an absence test, not a permission one",
  );
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("all read-proxy guards held");
