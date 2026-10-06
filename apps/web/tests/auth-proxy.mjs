import assert from "node:assert/strict";

// Where the requests are sent, and the value the proxy compares an Origin header
// against. They are separate settings on purpose: WEB_ORIGIN is what the app is
// configured to accept, which is not necessarily the address the test reaches it on.
const base = process.env.WEB_TEST_ORIGIN ?? "http://localhost:3000";
const origin = process.env.WEB_TEST_ALLOWED_ORIGIN ?? "http://localhost:3000";
const cases = [
  ["manager unknown path", "/api/manager/unknown", {}, 404],
  ["manager query forbidden", "/api/manager/documents?role=manager", {}, 404],
  ["manager delete unavailable", "/api/manager/documents", { method: "DELETE" }, 405],
  // The replacement and delete endpoints exist only on a single document, and both
  // are writes, so both demand the web origin rather than merely tolerating it.
  ["manager replace origin required", "/api/manager/documents/DOC-001", { method: "PUT" }, 403],
  ["manager delete origin required", "/api/manager/documents/DOC-001", { method: "DELETE" }, 403],
  [
    "manager replace foreign origin",
    "/api/manager/documents/DOC-001",
    { method: "PUT", headers: { Origin: "https://example.invalid" } },
    403,
  ],
  [
    "manager delete foreign origin",
    "/api/manager/documents/DOC-001",
    { method: "DELETE", headers: { Origin: "https://example.invalid" } },
    403,
  ],
  [
    "manager replace unauthenticated",
    "/api/manager/documents/DOC-001",
    { method: "PUT", headers: { Origin: origin } },
    401,
  ],
  [
    "manager delete unauthenticated",
    "/api/manager/documents/DOC-001",
    { method: "DELETE", headers: { Origin: origin } },
    401,
  ],
  // A malformed identifier is refused by the proxy's own allowlist, so it is never
  // forwarded and never becomes a path the API would have to interpret.
  [
    "malformed document id on replace",
    "/api/manager/documents/DOC-001%21bad",
    { method: "PUT", headers: { Origin: origin } },
    404,
  ],
  [
    "malformed document id on delete",
    "/api/manager/documents/DOC-001%2Fsections",
    { method: "DELETE", headers: { Origin: origin } },
    404,
  ],
  ["document query forbidden", "/api/manager/documents/DOC-001?force=1", {}, 404],
  [
    "job is not writable",
    "/api/manager/jobs/1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    { method: "PUT", headers: { Origin: origin } },
    405,
  ],
  [
    "malformed job id on delete",
    "/api/manager/jobs/not-a-uuid",
    { method: "DELETE", headers: { Origin: origin } },
    404,
  ],
  ["manager upload origin required", "/api/manager/documents", { method: "POST" }, 403],
  [
    "manager foreign read origin",
    "/api/manager/documents",
    { headers: { Origin: "https://example.invalid" } },
    403,
  ],
  ["manager authentication required", "/api/manager/documents", {}, 401],
  [
    "manager forged role rejected",
    "/api/manager/documents",
    { headers: { "X-Role": "manager" } },
    401,
  ],
  ["unknown path", "/api/auth/unknown", {}, 404],
  ["query forbidden", "/api/auth/me?role=manager", {}, 404],
  ["wrong method", "/api/auth/login", {}, 405],
  ["no origin", "/api/auth/logout", { method: "POST" }, 403],
  [
    "foreign origin",
    "/api/auth/logout",
    { method: "POST", headers: { Origin: "https://example.invalid" } },
    403,
  ],
  ["null origin", "/api/auth/logout", { method: "POST", headers: { Origin: "null" } }, 403],
  [
    "wrong content type",
    "/api/auth/login",
    { method: "POST", headers: { Origin: origin }, body: "x" },
    415,
  ],
  [
    "malformed JSON",
    "/api/auth/login",
    { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{" },
    422,
  ],
  [
    "password sanitized",
    "/api/auth/login",
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ login: "employee", password: { secret: "fake-secret-sentinel" } }),
    },
    422,
  ],
  [
    "body size bounded",
    "/api/auth/login",
    {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: "x".repeat(8193),
    },
    413,
  ],
  [
    "forged role ignored",
    "/api/auth/me",
    { headers: { "X-Role": "manager", "X-User-Id": "manager", Authorization: "Bearer forged" } },
    401,
  ],
];
for (const [name, path, options, expected] of cases) {
  const response = await fetch(base + path, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, name);
  assert.equal(response.headers.get("cache-control"), "no-store", name);
  assert(!(await response.text()).includes("fake-secret-sentinel"), name);
  console.log(`PASS ${name}`);
}
console.log(`${cases.length} proxy boundary checks passed.`);
