import assert from "node:assert/strict";

const origin = process.env.WEB_TEST_ORIGIN ?? "http://localhost:3000";
const cases = [
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
  const response = await fetch(origin + path, {
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
