import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalDashboardPath,
  chartPermalink,
  componentPermalink,
  componentPermalinkId,
  componentPermalinkShortId,
  isComponentPermalinkTargetVisible,
  readChartPermalink,
  readComponentPermalink,
  validComponentId,
} from "../src/chart-permalink.js";
import { codexDataAppActionUrl, currentDataAppReference } from "../src/runtime-environment.js";

const urlUuidNamespace = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");
const componentUuidPattern = /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
const componentShortIdPattern = /^[A-Za-z0-9_-]{8}$/u;

test("permalink targets must be connected, rendered, and available for focus", () => {
  function element({ connected = true, hidden = false, rects = [{}], visibility = "visible" } = {}) {
    return {
      isConnected: connected,
      closest: (selector) => {
        assert.equal(selector, "[hidden], [inert]");
        return hidden ? {} : null;
      },
      getClientRects: () => rects,
      ownerDocument: { defaultView: { getComputedStyle: () => ({ visibility }) } },
    };
  }

  assert.equal(isComponentPermalinkTargetVisible(element()), true);
  for (const target of [
    undefined,
    element({ connected: false }),
    element({ hidden: true }),
    element({ rects: [] }),
    element({ visibility: "hidden" }),
    element({ visibility: "collapse" }),
  ]) {
    assert.equal(isComponentPermalinkTargetVisible(target), false);
  }
});

function nodeCryptoComponentUuid(origin, id) {
  const digest = createHash("sha1")
    .update(urlUuidNamespace)
    .update(`openai.data-app.component\0${origin}\0${id}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nodeCryptoComponentShortId(origin, id) {
  return createHash("sha1")
    .update(urlUuidNamespace)
    .update(`openai.data-app.component\0${origin}\0${id}`, "utf8")
    .digest()
    .subarray(0, 6)
    .toString("base64url");
}

test("compact component aliases use exactly six independent UUIDv5 bytes and eight URL-safe characters", () => {
  for (const [origin, id] of [
    ["https://dashboard.chatgpt.site", "usage-trend"],
    ["https://dashboard.chatgpt.site", "Revenue & growth 📈"],
    ["https://dashboard.chatgpt.site", "東京"],
    ["https://dashboard.chatgpt.site", "é"],
    ["https://dashboard.chatgpt.site", "e\u0301"],
    ["https://dashboard.chatgpt.site", "component-5"],
    ["https://dashboard.chatgpt.site", "component-31"],
    ["http://localhost:4173", "%2F"],
    ["https://dashboard.chatgpt.site", "x".repeat(200)],
    ["https://dashboard.chatgpt.site", "📈".repeat(100)],
  ]) {
    const alias = componentPermalinkShortId(origin, id);
    const uuidBytes = Buffer.from(componentPermalinkId(origin, id).replaceAll("-", ""), "hex");

    assert.equal(alias, nodeCryptoComponentShortId(origin, id), id);
    assert.equal(alias, uuidBytes.subarray(0, 6).toString("base64url"), id);
    assert.match(alias, componentShortIdPattern, id);
    assert.doesNotMatch(alias, /[+=/]/u, id);
  }

  assert.equal(componentPermalinkShortId("https://dashboard.chatgpt.site", "component-5"), "qH-bbQ5J");
  assert.equal(componentPermalinkShortId("https://dashboard.chatgpt.site", "component-31"), "Optwf_mB");
  const fixtureSite = "https://permalink-fixture.chatgpt.site";
  assert.equal(componentPermalinkShortId(fixtureSite, "usage-trend"), "eOKqShll");
  assert.equal(componentPermalinkShortId(fixtureSite, "active-users"), "xEJQEdbv");
});

test("component permalink UUIDs match independent RFC 4122 UUIDv5 SHA-1 reference vectors", () => {
  for (const [origin, id] of [
    ["https://dashboard.chatgpt.site", "usage-trend"],
    ["https://dashboard.chatgpt.site", "Revenue & growth 📈"],
    ["https://dashboard.chatgpt.site", "東京"],
    ["https://dashboard.chatgpt.site", "é"],
    ["https://dashboard.chatgpt.site", "e\u0301"],
    ["http://localhost:4173", "%2F"],
    ["https://dashboard.chatgpt.site", "x".repeat(200)],
    ["https://dashboard.chatgpt.site", "📈".repeat(100)],
  ]) {
    const actual = componentPermalinkId(origin, id);
    assert.equal(actual, nodeCryptoComponentUuid(origin, id), id);
    assert.match(actual, componentUuidPattern, id);
  }

  const origin = "https://permalink-fixture.chatgpt.site";
  assert.equal(componentPermalinkId(origin, "usage-trend"), "78e2aa4a-1965-59d7-b7c0-5a4725540a1c");
  assert.equal(componentPermalinkId(origin, "active-users"), "c4425011-d6ef-5fa6-8007-8cef80307a4e");
});

test("component UUIDv5 SHA-1 remains correct across one- and two-block padding boundaries", () => {
  const origin = "http://a";
  const prefixLength = urlUuidNamespace.length + Buffer.byteLength(`openai.data-app.component\0${origin}\0`);

  for (const totalLength of [55, 56, 63, 64, 119, 120, 127, 128, 191, 192, 249, 250, 251]) {
    const id = "x".repeat(totalLength - prefixLength);
    assert.equal(
      componentPermalinkId(origin, id),
      nodeCryptoComponentUuid(origin, id),
      `SHA-1 input length ${totalLength} bytes`,
    );
  }
});

test("component UUID identity uses only canonical HTTP origin and exact authored UTF-8 ID", () => {
  const id = "usage-trend";
  const expected = componentPermalinkId("https://dashboard.chatgpt.site", id);
  const expectedShort = componentPermalinkShortId("https://dashboard.chatgpt.site", id);

  for (const location of [
    "https://dashboard.chatgpt.site/",
    "https://PUBLISHER:secret@DASHBOARD.CHATGPT.SITE:443/published?token=private#draft",
    new URL("https://dashboard.chatgpt.site/_data/components/old?token=private#draft"),
    {
      href: "https://dashboard.chatgpt.site/_data/charts/old/detail?token=private#draft",
    },
    { origin: "https://dashboard.chatgpt.site" },
  ]) {
    assert.equal(componentPermalinkId(location, id), expected);
    assert.equal(componentPermalinkShortId(location, id), expectedShort);
  }

  assert.equal(
    componentPermalinkId("http://dashboard.chatgpt.site:80/private", id),
    componentPermalinkId("http://dashboard.chatgpt.site", id),
  );
  assert.equal(
    componentPermalinkShortId("http://dashboard.chatgpt.site:80/private", id),
    componentPermalinkShortId("http://dashboard.chatgpt.site", id),
  );
  assert.notEqual(componentPermalinkId("http://dashboard.chatgpt.site", id), expected);
  assert.notEqual(componentPermalinkShortId("http://dashboard.chatgpt.site", id), expectedShort);
  assert.notEqual(componentPermalinkId("https://dashboard.chatgpt.site:444", id), expected);
  assert.notEqual(componentPermalinkShortId("https://dashboard.chatgpt.site:444", id), expectedShort);
  assert.notEqual(componentPermalinkId("https://another.chatgpt.site", id), expected);
  assert.notEqual(componentPermalinkShortId("https://another.chatgpt.site", id), expectedShort);
  assert.notEqual(componentPermalinkId("https://dashboard.chatgpt.site", "USAGE-TREND"), expected);
  assert.notEqual(componentPermalinkShortId("https://dashboard.chatgpt.site", "USAGE-TREND"), expectedShort);
  assert.notEqual(componentPermalinkId("https://dashboard.chatgpt.site", " usage-trend "), expected);
  assert.notEqual(componentPermalinkShortId("https://dashboard.chatgpt.site", " usage-trend "), expectedShort);
  assert.notEqual(
    componentPermalinkId("https://dashboard.chatgpt.site", "é"),
    componentPermalinkId("https://dashboard.chatgpt.site", "e\u0301"),
  );
  assert.notEqual(
    componentPermalinkShortId("https://dashboard.chatgpt.site", "é"),
    componentPermalinkShortId("https://dashboard.chatgpt.site", "e\u0301"),
  );
  assert.notEqual(
    componentPermalinkId("http://a", "bc"),
    componentPermalinkId("http://ab", "c"),
    "NUL-separated origin and component identity cannot be ambiguously concatenated.",
  );
  assert.notEqual(componentPermalinkShortId("http://a", "bc"), componentPermalinkShortId("http://ab", "c"));
  assert.doesNotMatch(expected, /usage-trend|dashboard|publisher|secret|private/u);
  assert.doesNotMatch(expectedShort, /usage-trend|dashboard|publisher|secret|private/u);
});

test("each authored starter component receives a distinct opaque UUID with legacy route compatibility", () => {
  const location = new URL("https://dashboard.chatgpt.site/");
  const componentIds = [
    "active-users",
    "growth",
    "conversion",
    "forecast-gap",
    "usage-trend",
    "growth-drivers",
    "adoption-scenario",
    "segment-breakdown",
    "forecast-outlook",
    "priority-accounts",
    "usage-details",
  ];
  const aliases = componentIds.map((id) => componentPermalinkId(location, id));
  const shortAliases = componentIds.map((id) => componentPermalinkShortId(location, id));

  assert.equal(new Set(aliases).size, componentIds.length);
  assert.equal(new Set(shortAliases).size, componentIds.length);
  for (const [index, alias] of aliases.entries()) {
    const shortAlias = shortAliases[index];
    assert.match(alias, componentUuidPattern);
    assert.match(shortAlias, componentShortIdPattern);
    assert.equal(
      componentIds.some((id, candidate) => candidate !== index && id === shortAlias),
      false,
      `${componentIds[index]}'s compact alias must not shadow a different legacy authored component ID.`,
    );
    assert.deepEqual(readComponentPermalink(new URL(componentPermalink(location, shortAlias))), {
      id: shortAlias,
      detail: false,
      kind: "component",
    });
    assert.deepEqual(readChartPermalink(new URL(chartPermalink(location, shortAlias, { detail: true }))), {
      id: shortAlias,
      detail: true,
    });
    assert.deepEqual(readComponentPermalink(new URL(componentPermalink(location, alias))), {
      id: alias,
      detail: false,
      kind: "component",
    });
    assert.deepEqual(readChartPermalink(new URL(chartPermalink(location, alias, { detail: true }))), {
      id: alias,
      detail: true,
    });
    assert.deepEqual(
      readComponentPermalink(new URL(componentPermalink(location, componentIds[index]))),
      {
        id: componentIds[index],
        detail: false,
        kind: "component",
      },
      "Existing authored-ID component links remain valid.",
    );
  }
});

test("component UUID creation rejects invalid authored IDs, malformed Unicode, and non-hosted URLs", () => {
  for (const id of [
    "",
    " ",
    ".",
    "..",
    "parent/child",
    "parent\\child",
    "trend\0chart",
    "x".repeat(201),
    "x".repeat(199) + "📈",
    "\uD800",
    "\uDC00",
    "\uDC00\uD800",
    undefined,
    null,
    42,
  ]) {
    assert.throws(
      () => componentPermalinkId("https://dashboard.chatgpt.site/", id),
      /safe dashboard component ID/u,
      String(id),
    );
    assert.throws(
      () => componentPermalinkShortId("https://dashboard.chatgpt.site/", id),
      /safe dashboard component ID/u,
      String(id),
    );
  }

  for (const location of [
    "file:///tmp/dashboard/dist/index.html",
    "ftp://dashboard.chatgpt.site/",
    "javascript:alert(1)",
    "not a URL",
    { href: "not a URL" },
    { origin: "null" },
    undefined,
    null,
  ]) {
    assert.throws(() => componentPermalinkId(location, "usage-trend"), /valid hosted Data app URL/u, String(location));
    assert.throws(
      () => componentPermalinkShortId(location, "usage-trend"),
      /valid hosted Data app URL/u,
      String(location),
    );
  }
});

test("the shared permalink-safe component ID validator agrees with chart and widget URLs", () => {
  const location = new URL("https://dashboard.chatgpt.site/");

  for (const id of [
    "active-users",
    "Revenue & growth 📈",
    "  surrounded by spaces  ",
    "...",
    ".chart",
    "%2F",
    "x".repeat(200),
    "📈".repeat(100),
    "x".repeat(198) + "📈",
    "\uD83D\uDCC8",
  ]) {
    assert.equal(validComponentId(id), true, id);
    assert.deepEqual(readChartPermalink(new URL(chartPermalink(location, id))), { id, detail: false }, id);
    assert.deepEqual(
      readComponentPermalink(new URL(componentPermalink(location, id))),
      {
        id,
        detail: false,
        kind: "component",
      },
      id,
    );
  }

  for (const id of [
    "",
    " ",
    "\t\n",
    ".",
    "..",
    "parent/child",
    "parent\\child",
    "\0",
    "trend\0chart",
    "x".repeat(201),
    "x".repeat(199) + "📈",
    "\uD800",
    "\uDBFF",
    "\uDC00",
    "\uDFFF",
    "\uDC00\uD800",
    "valid\uD800",
    "\uDC00valid",
    "x".repeat(199) + "\uD800",
    undefined,
    null,
    42,
    false,
    {},
    [],
  ]) {
    assert.equal(validComponentId(id), false, String(id));
    assert.throws(() => chartPermalink(location, id), /safe chart component ID/, String(id));
    assert.throws(() => componentPermalink(location, id), /safe dashboard component ID/, String(id));

    if (typeof id === "string") {
      let encoded;
      try {
        encoded = encodeURIComponent(id);
      } catch (error) {
        assert.ok(error instanceof URIError, "Only malformed UTF-16 IDs should fail URL encoding.");
        continue;
      }
      assert.equal(readChartPermalink({ pathname: `/_data/charts/${encoded}` }), null, id);
      assert.equal(readComponentPermalink({ pathname: `/_data/components/${encoded}` }), null, id);
    }
  }
});

test("published component menus offer Copy link only for centrally validated stable IDs", async () => {
  const source = await readFile(new URL("../src/components/DataComponent.jsx", import.meta.url), "utf8");

  assert.match(
    source,
    /import\s*\{\s*validComponentId\s*\}\s*from\s*"\.\.\/chart-permalink\.js"/u,
    "Component menus must reuse the same validator as permalink builders and parsers.",
  );
  assert.match(
    source,
    /published\s*&&\s*onCopy\s*&&\s*validComponentId\(component\.id\)\s*&&\s*<MenuItem\s+key="copy-link"\s+icon="link"/u,
    "An unsafe stable ID must hide only the published Copy link action.",
  );
  assert.match(
    source,
    /onCopy\s*&&\s*<MenuItem\s+key="copy-data"\s+icon="copy"/u,
    "Reviewed-data copy remains available even when the component ID cannot be shared.",
  );
});

test("hosted chart links encode stable IDs at the canonical dashboard root", () => {
  const location = new URL("https://publisher:secret@dashboard.chatgpt.site/published?token=private#draft");
  const componentId = "Revenue & growth 📈";
  const encodedId = "Revenue%20%26%20growth%20%F0%9F%93%88";

  assert.equal(chartPermalink(location, componentId), `https://dashboard.chatgpt.site/_data/charts/${encodedId}`);
  assert.equal(
    chartPermalink(location, componentId, { detail: true }),
    `https://dashboard.chatgpt.site/_data/charts/${encodedId}/detail`,
  );
  assert.equal(
    chartPermalink({ origin: "http://127.0.0.1:4173" }, "usage-trend"),
    "http://127.0.0.1:4173/_data/charts/usage-trend",
  );
  assert.equal(
    chartPermalink(new URL("https://dashboard.chatgpt.site/_data/charts/old/detail"), "new"),
    "https://dashboard.chatgpt.site/_data/charts/new",
  );
});

test("every hosted dashboard component receives a clean, encoded root widget permalink", () => {
  const location = new URL("https://publisher:secret@dashboard.chatgpt.site/published?token=private#draft");

  assert.equal(
    componentPermalink(location, "Revenue & growth 📈"),
    "https://dashboard.chatgpt.site/_data/components/Revenue%20%26%20growth%20%F0%9F%93%88",
  );
  assert.equal(
    componentPermalink({ origin: "http://127.0.0.1:4173" }, "active-users"),
    "http://127.0.0.1:4173/_data/components/active-users",
  );
  assert.equal(
    componentPermalink(new URL("https://dashboard.chatgpt.site/_data/charts/old/detail"), "notes"),
    "https://dashboard.chatgpt.site/_data/components/notes",
  );
  assert.equal(
    componentPermalink(new URL("https://dashboard.chatgpt.site/_data/components/old"), "usage-details"),
    "https://dashboard.chatgpt.site/_data/components/usage-details",
  );
});

test("chart links reject unsafe, missing, or excessively long component IDs", () => {
  const location = new URL("https://dashboard.chatgpt.site/");

  for (const componentId of [
    "",
    " ",
    ".",
    "..",
    "parent/child",
    "parent\\child",
    "\0",
    "trend\0chart",
    "x".repeat(201),
    undefined,
    null,
    42,
  ]) {
    assert.throws(() => chartPermalink(location, componentId), /safe chart component ID/, String(componentId));
    assert.throws(() => componentPermalink(location, componentId), /safe dashboard component ID/, String(componentId));
  }

  assert.doesNotThrow(() => chartPermalink(location, "x".repeat(200)));
  assert.doesNotThrow(() => componentPermalink(location, "x".repeat(200)));
  assert.throws(
    () => chartPermalink(new URL("file:///tmp/dashboard/dist/index.html"), "trend"),
    /valid hosted Data app URL/,
  );
  assert.throws(
    () => componentPermalink(new URL("file:///tmp/dashboard/dist/index.html"), "active-users"),
    /valid hosted Data app URL/,
  );
  assert.throws(() => chartPermalink({ href: "not a URL" }, "trend"), /valid hosted Data app URL/);
  assert.throws(() => componentPermalink({ href: "not a URL" }, "active-users"), /valid hosted Data app URL/);
});

test("chart permalinks decode one safe component segment and recognize detail routes", () => {
  assert.deepEqual(readChartPermalink(new URL("https://dashboard.chatgpt.site/_data/charts/usage-trend")), {
    id: "usage-trend",
    detail: false,
  });
  assert.deepEqual(
    readChartPermalink({
      pathname: "/_data/charts/Revenue%20%26%20growth/detail",
    }),
    {
      id: "Revenue & growth",
      detail: true,
    },
  );
  assert.deepEqual(readChartPermalink("/_data/charts/%F0%9F%93%88"), {
    id: "📈",
    detail: false,
  });
  assert.deepEqual(
    readChartPermalink("/_data/charts/%252F"),
    {
      id: "%2F",
      detail: false,
    },
    "A literal percent-encoded component ID is decoded exactly once.",
  );
  assert.deepEqual(readChartPermalink(`/_data/charts/${"x".repeat(200)}`), {
    id: "x".repeat(200),
    detail: false,
  });
});

test("unified component parser identifies widget links and backward-compatible chart/detail links", () => {
  assert.deepEqual(readComponentPermalink(new URL("https://dashboard.chatgpt.site/_data/components/active-users")), {
    id: "active-users",
    detail: false,
    kind: "component",
  });
  assert.deepEqual(
    readComponentPermalink({
      pathname: "/_data/components/Revenue%20%26%20growth",
    }),
    {
      id: "Revenue & growth",
      detail: false,
      kind: "component",
    },
  );
  assert.deepEqual(readComponentPermalink("/_data/components/%F0%9F%93%88"), {
    id: "📈",
    detail: false,
    kind: "component",
  });
  assert.deepEqual(
    readComponentPermalink("/_data/components/%252F"),
    {
      id: "%2F",
      detail: false,
      kind: "component",
    },
    "Generic component IDs are also decoded exactly once.",
  );
  assert.deepEqual(
    readComponentPermalink("/_data/components/detail"),
    {
      id: "detail",
      detail: false,
      kind: "component",
    },
    "Detail remains a valid stable component ID, not a generic route suffix.",
  );
  assert.deepEqual(readComponentPermalink(`/_data/components/${"x".repeat(200)}`), {
    id: "x".repeat(200),
    detail: false,
    kind: "component",
  });
  assert.deepEqual(readComponentPermalink("/_data/charts/usage-trend"), {
    id: "usage-trend",
    detail: false,
    kind: "chart",
  });
  assert.deepEqual(readComponentPermalink("/_data/charts/usage-trend/detail"), {
    id: "usage-trend",
    detail: true,
    kind: "chart",
  });
  assert.equal(
    readChartPermalink("/_data/components/usage-trend"),
    null,
    "The original chart-only parser contract remains unchanged.",
  );
});

test("malformed chart routes, traversal, separators, NUL, and oversized IDs are rejected", () => {
  for (const pathname of [
    "/_data/charts",
    "/_data/charts/",
    "/_data/charts//detail",
    "/_data/charts/usage-trend/",
    "/_data/charts/usage-trend/details",
    "/_data/charts/usage-trend/detail/",
    "/_data/charts/usage-trend/detail/extra",
    "/_data/charts/.",
    "/_data/charts/..",
    "/_data/charts/%2e",
    "/_data/charts/%2E%2e",
    "/_data/charts/%2F",
    "/_data/charts/%2f",
    "/_data/charts/parent%2Fchild",
    "/_data/charts/%5C",
    "/_data/charts/parent%5cchild",
    "/_data/charts/%00",
    "/_data/charts/trend%00chart",
    "/_data/charts/%20",
    "/_data/charts/%",
    "/_data/charts/%E0%A4%A",
    "/_data/charts/%ED%A0%80",
    "/_data/charts/%ED%B0%80",
    `/_data/charts/${"x".repeat(201)}`,
    "/nested/_data/charts/usage-trend",
    "/_DATA/charts/usage-trend",
    "/_data/chart/usage-trend",
  ]) {
    assert.equal(readChartPermalink({ pathname }), null, pathname);
    assert.equal(readComponentPermalink({ pathname }), null, pathname);
    assert.equal(canonicalDashboardPath(pathname), pathname, pathname);
  }

  assert.equal(readChartPermalink({ pathname: null }), null);
  assert.equal(readChartPermalink(null), null);
});

test("generic widget routes reject detail suffixes, traversal, malformed escapes, and oversized IDs", () => {
  for (const pathname of [
    "/_data/components",
    "/_data/components/",
    "/_data/components//detail",
    "/_data/components/active-users/",
    "/_data/components/active-users/detail",
    "/_data/components/active-users/detail/",
    "/_data/components/active-users/extra",
    "/_data/components/.",
    "/_data/components/..",
    "/_data/components/%2e",
    "/_data/components/%2E%2e",
    "/_data/components/%2F",
    "/_data/components/%2f",
    "/_data/components/parent%2Fchild",
    "/_data/components/%5C",
    "/_data/components/parent%5cchild",
    "/_data/components/%00",
    "/_data/components/widget%00name",
    "/_data/components/%20",
    "/_data/components/%",
    "/_data/components/%E0%A4%A",
    "/_data/components/%ED%A0%80",
    "/_data/components/%ED%B0%80",
    `/_data/components/${"x".repeat(201)}`,
    "/nested/_data/components/active-users",
    "/_DATA/components/active-users",
    "/_data/component/active-users",
    "/_data/COMPONENTS/active-users",
  ]) {
    assert.equal(readComponentPermalink({ pathname }), null, pathname);
    assert.equal(canonicalDashboardPath(pathname), pathname, pathname);
  }

  assert.equal(readComponentPermalink({ pathname: null }), null);
  assert.equal(readComponentPermalink(null), null);
});

test("only valid reserved chart routes resolve to the canonical dashboard pathname", () => {
  assert.equal(canonicalDashboardPath("/_data/components/active-users"), "/");
  assert.equal(canonicalDashboardPath("/_data/components/Revenue%20growth"), "/");
  assert.equal(canonicalDashboardPath("/_data/charts/usage-trend"), "/");
  assert.equal(canonicalDashboardPath("/_data/charts/usage-trend/detail"), "/");
  assert.equal(canonicalDashboardPath("/_data/charts/Revenue%20growth"), "/");
  assert.equal(canonicalDashboardPath("/"), "/");
  assert.equal(canonicalDashboardPath("/one"), "/one");
  assert.equal(canonicalDashboardPath("/two"), "/two");
  assert.equal(canonicalDashboardPath("/published"), "/published");
});

test("chart permalinks share the sanitized root dashboard identity and ChatGPT link", () => {
  for (const pathname of [
    "/_data/components/active-users",
    "/_data/components/notes",
    "/_data/charts/usage-trend",
    "/_data/charts/usage-trend/detail",
  ]) {
    const location = new URL(`https://publisher:secret@dashboard.chatgpt.site${pathname}?token=private#draft`);

    assert.deepEqual(currentDataAppReference(location), {
      sourceUrl: "https://dashboard.chatgpt.site/",
    });
    const handoff = codexDataAppActionUrl("Refresh the dashboard", location);
    assert.equal(`${handoff.origin}${handoff.pathname}`, "https://chatgpt.com/");
    assert.equal(handoff.searchParams.get("q"), "Refresh the dashboard");
  }

  assert.deepEqual(
    currentDataAppReference({
      href: "https://publisher:secret@dashboard.chatgpt.site/published?token=private#draft",
    }),
    { sourceUrl: "https://dashboard.chatgpt.site/published" },
  );
  assert.deepEqual(
    currentDataAppReference({
      href: "https://dashboard.chatgpt.site/_data/charts/parent%2Fchild?token=private#draft",
    }),
    { sourceUrl: "https://dashboard.chatgpt.site/_data/charts/parent%2Fchild" },
  );
  assert.deepEqual(
    currentDataAppReference({
      href: "https://dashboard.chatgpt.site/_data/components/parent%2Fchild?token=private#draft",
    }),
    {
      sourceUrl: "https://dashboard.chatgpt.site/_data/components/parent%2Fchild",
    },
  );
  assert.deepEqual(
    currentDataAppReference({
      href: "https://dashboard.chatgpt.site/_data/components/active-users/detail?token=private#draft",
    }),
    {
      sourceUrl: "https://dashboard.chatgpt.site/_data/components/active-users/detail",
    },
  );
  assert.deepEqual(
    currentDataAppReference({
      href: "file:///_data/charts/usage-trend?token=private#draft",
    }),
    {
      htmlPath: "/_data/charts/usage-trend",
      root: "/_data/charts",
      sourceUrl: "file:///_data/charts/usage-trend",
    },
  );
  assert.deepEqual(
    currentDataAppReference({
      href: "file:///_data/components/active-users?token=private#draft",
    }),
    {
      htmlPath: "/_data/components/active-users",
      root: "/_data/components",
      sourceUrl: "file:///_data/components/active-users",
    },
  );
});
