import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { dateRangePresets } from "../src/date-range.js";

import {
  dashboardUrlWithState,
  dashboardViewSearchParams,
  readDashboardUrlState,
  resolveDashboardUrlFilters,
  serializeDashboardUrlState,
  validFilterValue,
} from "../src/dashboard-url-state.js";

const emptyState = { tab: null, filters: {}, hasViewState: false, complete: false,
  assumptions: {}, sections: {}, charts: {}, tabViews: {}, focus: {} };

test("multi-select URL, saved tab, drill and clear states preserve validated arrays", async () => {
  const { dashboardView, drillDashboardView } = await import("../src/dashboard-view-state.js");
  const multi = { filters: [
    { id: "region", field: "region", multiple: true, defaultValue: ["EMEA"], queryIds: ["regional"] },
    { id: "private", field: "region", multiple: true, shareInUrl: false },
  ], queries: { regional: { rows: [{ region: "EMEA" }, { region: "Americas" }, { region: "Asia, Pacific" }] },
    unrelated: { rows: [{ region: "unscoped" }] } } };
  const views = [{ id: "overview", filterIds: ["region"] }];
  const urlFor = filters => dashboardUrlWithState("https://dashboard.chatgpt.site/", multi, views, { filters });
  const selected = ["Americas", "EMEA"];
  const state = readDashboardUrlState(multi, views, urlFor({ region: [...selected].reverse(), private: ["EMEA"] }));
  assert.deepEqual(state.filters, { private: ["EMEA"], region: selected });
  assert.deepEqual(dashboardView(multi, views, "overview", { filters: state.filters }).filters, { region: selected });
  assert.deepEqual(drillDashboardView(multi, views, "overview", {}, { filters: state.filters }).filters, { region: selected });
  assert.deepEqual(readDashboardUrlState(multi, views, urlFor({ region: [] })).filters, { region: [] });
  assert.deepEqual(readDashboardUrlState(multi, views, urlFor({ region: ["Asia, Pacific"] })).filters, { region: ["Asia, Pacific"] });
  assert.equal(urlFor({ region: ["EMEA"] }).search, "?view=1");
  for (const value of [["unscoped"], ["all"], [null], [5], ["EMEA".repeat(600)]]) {
    assert.equal(validFilterValue(multi, multi.filters[0], value), false);
    assert.equal(urlFor({ region: value }).search, "?view=1");
  }
  assert.equal(validFilterValue(multi, { ...multi.filters[0], multiple: false }, selected), false);
  assert.deepEqual(readDashboardUrlState(multi, views, "https://dashboard.chatgpt.site/?f.region=%5Bbad").filters, {});
  assert.deepEqual(readDashboardUrlState(multi, views, "https://dashboard.chatgpt.site/?f.region=EMEA&f.region=Americas").filters, {});
  assert.deepEqual(readDashboardUrlState(multi, views, "https://dashboard.chatgpt.site/?f.region=EMEA").filters, { region: "EMEA" });
});

const snapshot = {
  filters: [
    { id: "week", field: "week", defaultValue: "2026-08-10" },
    { id: "segment", field: "segment", defaultValue: "all" },
    { id: "region", field: "region", defaultValue: "all", queryIds: ["regional"] },
    { id: "account", field: "account", defaultValue: "all", shareInUrl: false },
  ],
  queries: {
    regional: {
      rows: [
        { week: "2026-08-10", segment: "API", region: "North America", account: "private@example.com" },
        { week: "2026-08-03", segment: "Search & discovery", region: "EMEA", account: "another@example.com" },
      ],
    },
    other: {
      rows: [{ week: "2026-08-10", segment: "東京", region: "unscoped", account: "hidden@example.com" }],
    },
  },
};
const tabs = [{ id: "dashboard", label: "Dashboard" }, { id: "adoption", label: "Adoption" }];

test("dashboard view parameters round-trip known tabs and declared non-default filters", () => {
  const state = {
    tab: "adoption",
    filters: { week: "2026-08-03", segment: "Search & discovery", region: "EMEA" },
  };
  const serialized = serializeDashboardUrlState(snapshot, tabs, state);

  assert.equal(serialized.toString(),
    "view=1&tab=adoption&f.region=EMEA&f.segment=Search+%26+discovery&f.week=2026-08-03");
  assert.deepEqual(readDashboardUrlState(snapshot, tabs,
    `https://dashboard.chatgpt.site/?${serialized}`), { ...emptyState, ...state, complete: true, hasViewState: true });
});

test("default dashboard tabs and filters retain an explicit complete-view marker and tab", () => {
  const state = { tab: "dashboard", filters: { week: "2026-08-10", segment: "all", region: "all" } };
  assert.equal(serializeDashboardUrlState(snapshot, tabs, state).toString(), "view=1&tab=dashboard");
  assert.equal(dashboardUrlWithState("https://dashboard.chatgpt.site/?tab=dashboard&f.segment=all", snapshot,
    tabs, state).toString(), "https://dashboard.chatgpt.site/?view=1&tab=dashboard");
});

test("dashboard filter serialization remains stable and correctly encodes reviewed Unicode values", () => {
  assert.equal(serializeDashboardUrlState(snapshot, tabs, {
    tab: "dashboard",
    filters: { week: "2026-08-03", segment: "東京", region: "EMEA" },
  }).toString(), "view=1&tab=dashboard&f.region=EMEA&f.segment=%E6%9D%B1%E4%BA%AC&f.week=2026-08-03");
});

test("unknown, stale, malformed, duplicate, and query-out-of-scope filter values are rejected", () => {
  const url = "https://dashboard.chatgpt.site/?tab=deleted&f.segment=unknown&f.week=2026-08-03"
    + "&f.week=2026-08-10&f.region=unscoped&f.missing=secret";
  assert.deepEqual(readDashboardUrlState(snapshot, tabs, url), {
    ...emptyState,
  });
  assert.equal(serializeDashboardUrlState(snapshot, tabs, {
    tab: "deleted",
    filters: { segment: "unknown", region: "unscoped", missing: "secret" },
  }).toString(), "view=1");
});

test("legacy links retain shareInUrl opt-outs while new complete links include every declared selection", () => {
  const url = "https://dashboard.chatgpt.site/?f.account=private%40example.com&f.region=EMEA";
  const state = readDashboardUrlState(snapshot, tabs, url);
  assert.deepEqual(state, { ...emptyState, filters: { region: "EMEA" }, hasViewState: true });
  assert.equal(serializeDashboardUrlState(snapshot, tabs, {
    filters: { account: "private@example.com", region: "EMEA" },
  }).toString(), "view=1&f.account=private%40example.com&f.region=EMEA");
  assert.deepEqual(resolveDashboardUrlFilters(snapshot,
    { account: "private@example.com", segment: "API" }, state), {
    account: "private@example.com",
    region: "EMEA",
    segment: "all",
    week: "2026-08-10",
  });
});

test("explicit URL selections override local state while ordinary visits preserve local exploration", () => {
  const local = { week: "2026-08-03", segment: "API", region: "North America" };
  const explicit = readDashboardUrlState(snapshot, tabs, "https://dashboard.chatgpt.site/?f.region=EMEA");
  const ordinary = readDashboardUrlState(snapshot, tabs, "https://dashboard.chatgpt.site/?token=private");

  assert.deepEqual(resolveDashboardUrlFilters(snapshot, local, explicit), {
    week: "2026-08-10", segment: "all", region: "EMEA",
  });
  assert.deepEqual(resolveDashboardUrlFilters(snapshot, local, ordinary), local);
  assert.deepEqual(resolveDashboardUrlFilters(snapshot, local, ordinary, { reset: true }), {
    week: "2026-08-10", segment: "all", region: "all",
  });
});

test("explicit all selections round-trip for categorical filters with non-all dashboard defaults", () => {
  const defaultedSnapshot = {
    ...snapshot,
    filters: snapshot.filters.map((filter) => filter.id === "segment"
      ? { ...filter, defaultValue: "API" } : filter),
  };
  const state = readDashboardUrlState(defaultedSnapshot, tabs,
    "https://dashboard.chatgpt.site/?f.segment=all");

  assert.deepEqual(state, { ...emptyState, filters: { segment: "all" }, hasViewState: true });
  assert.equal(resolveDashboardUrlFilters(defaultedSnapshot, { segment: "API" }, state).segment, "all");
  assert.equal(serializeDashboardUrlState(defaultedSnapshot, tabs, {
    filters: { segment: "all" },
  }).toString(), "view=1&f.segment=all");
});

test("date filters with a required non-all default reject unavailable all selections", () => {
  assert.deepEqual(readDashboardUrlState(snapshot, tabs,
    "https://dashboard.chatgpt.site/?f.week=all"), {
    ...emptyState,
  });
  assert.equal(serializeDashboardUrlState(snapshot, tabs, {
    filters: { week: "all" },
  }).toString(), "view=1");
});

test("invalid or deleted URL selections cannot replace saved viewer-local filter state", () => {
  const local = { week: "2026-08-03", segment: "API", region: "North America" };

  for (const href of [
    "https://dashboard.chatgpt.site/?tab=deleted",
    "https://dashboard.chatgpt.site/?tab=adoption&tab=dashboard",
    "https://dashboard.chatgpt.site/?f.region=unknown",
    "https://dashboard.chatgpt.site/?f.week=2026-08-03&f.week=2026-08-10",
  ]) {
    const state = readDashboardUrlState(snapshot, tabs, href);
    assert.equal(state.hasViewState, false, `${href} must not count as an explicit shareable view.`);
    assert.deepEqual(resolveDashboardUrlFilters(snapshot, local, state), local);
  }
});

test("copied component URLs include only validated view state and strip browser-private context", () => {
  const source = "https://publisher:secret@dashboard.chatgpt.site/_data/charts/Ab12Cd34"
    + "?token=private&codexThreadId=thread&f.account=private%40example.com#codexThreadId=thread";
  const shared = dashboardUrlWithState(source, snapshot, tabs, {
    tab: "adoption",
    filters: { region: "EMEA" },
  }, { preserveExisting: false });

  assert.equal(shared.toString(), "https://dashboard.chatgpt.site/_data/charts/Ab12Cd34?view=1&tab=adoption&f.region=EMEA");
  assert.doesNotMatch(shared.toString(), /publisher|secret|private|codexThreadId|account/u);
});

test("in-browser URL updates preserve unrelated host query parameters and Codex task fragments", () => {
  const source = "https://dashboard.chatgpt.site/_data/charts/Ab12Cd34?token=private&f.old=stale"
    + "#codexThreadId=550e8400-e29b-41d4-a716-446655440000";
  const next = dashboardUrlWithState(source, snapshot, tabs, {
    tab: "adoption",
    filters: { segment: "API" },
  });

  assert.equal(next.searchParams.get("token"), "private");
  assert.equal(next.searchParams.get("tab"), "adoption");
  assert.equal(next.searchParams.get("f.segment"), "API");
  assert.equal(next.searchParams.has("f.old"), false);
  assert.match(next.hash, /^#codexThreadId=/u);
});

test("invalid locations and oversized values never create unsafe dashboard view state", () => {
  assert.deepEqual(readDashboardUrlState(snapshot, tabs, "not a URL"), {
    ...emptyState,
  });
  assert.equal(dashboardUrlWithState("not a URL", snapshot, tabs, {}), null);
  assert.throws(() => serializeDashboardUrlState(snapshot, tabs, {
    filters: { segment: "x".repeat(65_537) },
  }), { code: "DATA_APP_VIEW_TOO_LARGE" });
});

test("declared filter identifiers cannot mutate dashboard URL-state object prototypes", () => {
  const unusualSnapshot = {
    filters: [{ id: "__proto__", field: "category", defaultValue: "all" }],
    queries: { reviewed: { rows: [{ category: "safe" }] } },
  };
  const state = readDashboardUrlState(unusualSnapshot, tabs,
    "https://dashboard.chatgpt.site/?f.__proto__=safe");

  assert.equal(Object.getPrototypeOf(state.filters), Object.prototype);
  assert.equal(Object.hasOwn(state.filters, "__proto__"), false);
  const resolved = resolveDashboardUrlFilters(unusualSnapshot, {}, state);
  assert.equal(Object.getPrototypeOf(resolved), Object.prototype);
  assert.equal(Object.hasOwn(resolved, "__proto__"), false);
});


test("tab scopes restore independent views and drill through only declared destination fields", async () => {
  const { dashboardTabId, dashboardTabSnapshot, dashboardView, drillDashboardView } = await import("../src/dashboard-view-state.js");
  const definitions = [{ id: "dashboard", filterIds: ["week", "region"] },
    { id: "adoption", aliases: ["retention"], filterIds: ["week", "segment"], focusFields: ["accountId"] }];
  const manual = { filters: { week: "2026-08-03", segment: "API" }, focus: { accountId: "private-account" } };
  const overview = dashboardView(snapshot, definitions, "dashboard", { filters: { region: "EMEA", segment: "API" } });
  assert.deepEqual(overview.filters, { week: "2026-08-10", region: "EMEA" });
  const target = drillDashboardView(snapshot, definitions, "adoption", manual, {
    filters: { week: "2026-08-10", segment: "東京", region: "EMEA", sql: "private" },
    focus: { accountId: "selected-account", sql: "private" },
  });
  assert.deepEqual(target, { filters: { week: "2026-08-10", segment: "東京" }, focus: { accountId: "selected-account" } });
  assert.deepEqual(dashboardView(snapshot, definitions, "adoption", manual), manual, "temporary drill does not change saved browsing state");
  assert.equal(dashboardTabId(definitions, "retention"), "adoption");
  const scoped = dashboardTabSnapshot(snapshot, definitions, "adoption");
  const url = serializeDashboardUrlState(scoped, tabs, { tab: "adoption", filters: { ...target.filters, accountId: "selected-account", region: "EMEA" } }).toString();
  assert.ok(!url.includes("account") && !url.includes("region") && !url.includes("sql"));
  assert.deepEqual(dashboardView(snapshot, definitions, "adoption", manual, readDashboardUrlState(scoped, tabs,
    `https://dashboard.chatgpt.site/?${url}`)).filters, target.filters);
  assert.equal(dashboardTabSnapshot(snapshot, tabs, "adoption"), snapshot, "legacy definitions retain shared filters");
});

test("inclusive date ranges round-trip and invalid boundaries are rejected", () => {
  const ranged = { ...snapshot, filters: [{ id: "date", field: "week", mode: "through", defaultValue: "2026-08-10" }] };
  const state = { tab: "adoption", filters: { date: "2026-08-03..2026-08-10" } };
  const url = serializeDashboardUrlState(ranged, tabs, state);
  assert.deepEqual(readDashboardUrlState(ranged, tabs, `https://dashboard.chatgpt.site/?${url}`).filters, state.filters);
  for (const invalid of ["2026-08-10..2026-08-03", "2026-08-01..2026-08-10", "2026-02-30..2026-08-10"])
    assert.deepEqual(readDashboardUrlState(ranged, tabs, `https://dashboard.chatgpt.site/?f.date=${invalid}`).filters, {});
});

test("sparse-date calendar presets round-trip without snapping to observations", () => {
  const ranged = { filters: [{ id: "date", field: "week", mode: "through", queryIds: ["weekly"] }],
    queries: { weekly: { rows: ["2026-07-01", "2026-07-08", "2026-08-05", "2026-08-12"].map(week => ({week})) },
      unrelated: { rows: [{week:"2026-06-01"},{week:"2026-09-01"}] } } };
  const filter = ranged.filters[0];
  const presets = dateRangePresets("2026-07-01", "2026-08-12");
  assert.equal(presets.length, 3);
  for (const {value} of presets) {
    const filters = {date:value};
    const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", ranged, tabs, {filters});
    assert.equal(url.searchParams.get("f.date"), value);
    assert.deepEqual(readDashboardUrlState(ranged,tabs,url).filters, filters);
  }
  for (const invalid of ["2026-06-30..2026-08-12", "2026-07-01..2026-08-13",
    "2026-07-31..2026-07-01", "2026-07-32..2026-08-12", "2026-02-30..2026-08-12"])
    assert.equal(validFilterValue(ranged,filter,invalid),false,invalid);
  assert.equal(validFilterValue({...ranged,queries:{}},filter,presets[0].value),false);
});

test("a complete default link resets all recipient filters, including previously local-only choices", () => {
  const local = { week: "2026-08-03", segment: "API", region: "EMEA", account: "private@example.com" };
  const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", snapshot, tabs,
    { tab: "dashboard", filters: { week: "2026-08-10", segment: "all", region: "all", account: "all" } });
  assert.equal(url.search, "?view=1&tab=dashboard");
  const state = readDashboardUrlState(snapshot, tabs, url);
  assert.deepEqual(state, { ...emptyState, tab: "dashboard", complete: true, hasViewState: true });
  assert.deepEqual(resolveDashboardUrlFilters(snapshot, local, state),
    { week: "2026-08-10", segment: "all", region: "all", account: "all" });
  const selected = dashboardUrlWithState(url, snapshot, tabs, { filters: { account: "another@example.com" } });
  assert.deepEqual(readDashboardUrlState(snapshot, tabs, selected).filters, { account: "another@example.com" });
  assert.equal(resolveDashboardUrlFilters(snapshot, local, readDashboardUrlState(snapshot, tabs, selected)).account,
    "another@example.com");
});

test("complete links preserve explicit all, empty multi-select, and selection equal to an authored default", () => {
  const multi = { ...snapshot, filters: [
    { id: "region", field: "region", multiple: true, defaultValue: ["EMEA"] },
    { id: "segment", field: "segment", defaultValue: "API" },
  ] };
  for (const filters of [
    { region: ["EMEA"], segment: "API" },
    { region: [], segment: "all" },
    { region: "all", segment: "all" },
  ]) {
    const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", multi, tabs, { filters });
    const state = readDashboardUrlState(multi, tabs, url);
    assert.deepEqual(resolveDashboardUrlFilters(multi, { region: ["North America"], segment: "東京" }, state), filters);
  }
});

test("large reviewed multi-selects and long reviewed values survive the complete round trip", () => {
  const choices = Array.from({ length: 500 }, (_, index) => `Reviewed choice ${String(index).padStart(3, "0")}`);
  const longChoice = "A reviewed value ".repeat(500);
  const large = { filters: [{ id: "choices", field: "choice", multiple: true, defaultValue: [] },
    { id: "long", field: "choice", defaultValue: "all" }],
  queries: { reviewed: { rows: [...choices, longChoice].map(choice => ({ choice })) } } };
  assert.ok(JSON.stringify(choices).length > 2_000);
  assert.ok(longChoice.length > 2_000);
  const state = { filters: { choices, long: longChoice } };
  const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", large, tabs, state);
  assert.deepEqual(readDashboardUrlState(large, tabs, url).filters, state.filters);
  assert.deepEqual([...dashboardViewSearchParams(url)], [...url.searchParams]);
  const tooLong = "x".repeat(65_537);
  const unicodeTooLong = "東京".repeat(12_000);
  for (const choice of [tooLong, unicodeTooLong]) {
    const oversized = { ...large, queries: { reviewed: { rows: [{ choice }] } } };
    assert.equal(validFilterValue(oversized, oversized.filters[1], choice), false);
    const url = new URL("https://dashboard.chatgpt.site/?view=1");
    url.searchParams.set("f.long", choice);
    assert.deepEqual(readDashboardUrlState(oversized, tabs, url).filters, {});
    assert.equal(dashboardViewSearchParams(url).has("f.long"), false);
  }
});

test("assumptions, sections, charts, scoped tabs, and focus round-trip without carrying reviewed rows", () => {
  const state = {
    tab: "adoption", filters: { region: "EMEA" }, assumptions: { retentionLift: 0, activationLift: 7.5 },
    sections: { sales: { category: "Pens", regions: ["East", "West"] }, inventory: { available: true } },
    charts: { "revenue-chart": { inlineFilters: { category: "Pens" }, visibleSeries: ["Revenue", "Orders"],
      zoomRange: { start: "2026-08-03", end: "2026-08-10" } }, "empty-chart": { visibleSeries: [] } },
    tabViews: { adoption: { filters: { region: "EMEA" }, focus: { accountId: "selected-account" } },
      dashboard: { filters: { region: "all" } } },
    focus: { accountId: "selected-account" },
  };
  const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", snapshot, tabs, state);
  const expected = { ...emptyState, ...state, assumptions: { activationLift: 7.5 },
    charts: { ...state.charts, "revenue-chart": { ...state.charts["revenue-chart"], visibleSeries: ["Orders", "Revenue"] } },
    complete: true, hasViewState: true };
  assert.deepEqual(readDashboardUrlState(snapshot, tabs, url), expected);
  assert.deepEqual(readDashboardUrlState(snapshot, tabs,
    `https://dashboard.chatgpt.site/?${dashboardViewSearchParams(url)}`), expected);
  assert.equal(url.searchParams.has("rows"), false);
});

test("default auxiliary state stays compact, including cleared chart controls", () => {
  const parameters = serializeDashboardUrlState(snapshot, tabs, {
    assumptions: { activationLift: 0, retentionLift: 0 }, sections: { sales: {} },
    charts: { chart: { visibleSeries: undefined, inlineFilters: {}, zoomRange: null } },
    tabViews: { dashboard: { filters: {}, focus: {} } }, focus: {},
  });
  assert.equal(parameters.toString(), "view=1");
  assert.deepEqual(readDashboardUrlState(snapshot, tabs, `https://dashboard.chatgpt.site/?${parameters}`),
    { ...emptyState, hasViewState: true, complete: true });
});

test("malformed, duplicate, unsupported, and oversized auxiliary context is ignored", () => {
  const invalidValues = {
    a: ['{"activationLift":"5"}', '{"activationLift":1e400}', '[]', '{"nested":{"amount":2}}'],
    s: ['{"sales":{"category":{"nested":"value"}}}', '{"sales":[]}', '{"sales":{"category":[{}]}}'],
    c: ['{"chart":{"sql":"SELECT secret"}}', '{"chart":{"visibleSeries":[1]}}',
      '{"chart":{"zoomRange":{"start":1,"end":2,"secret":"token"}}}'],
    t: ['{"overview":{"filters":[],"focus":{}}}', '{"overview":{"unknown":"value"}}'],
    focus: ['{"accountId":3}', '{"accountId":{"secret":true}}'],
  };
  const property = { a: "assumptions", s: "sections", c: "charts", t: "tabViews", focus: "focus" };
  for (const [parameter, invalid] of Object.entries(invalidValues)) {
    for (const value of [...invalid, "{bad", "x".repeat(65_537)]) {
      const url = new URL("https://dashboard.chatgpt.site/?view=1");
      url.searchParams.set(parameter, value);
      assert.deepEqual(readDashboardUrlState(snapshot, tabs, url)[property[parameter]], {}, parameter);
      assert.equal(dashboardViewSearchParams(url).has(parameter), false, parameter);
    }
    const url = new URL("https://dashboard.chatgpt.site/?view=1");
    url.searchParams.append(parameter, "{}");
    url.searchParams.append(parameter, "{}");
    assert.deepEqual(readDashboardUrlState(snapshot, tabs, url)[property[parameter]], {});
    assert.equal(dashboardViewSearchParams(url).has(parameter), false);
  }
});

test("unsafe prototype keys cannot enter nested state or the handoff allowlist", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    for (const [parameter, value] of [
      ["a", `{${JSON.stringify(key)}:1}`],
      ["s", `{"section":{${JSON.stringify(key)}:"value"}}`],
      ["c", `{"chart":{"inlineFilters":{${JSON.stringify(key)}:"value"}}}`],
      ["t", `{"overview":{"focus":{${JSON.stringify(key)}:"value"}}}`],
      ["focus", `{${JSON.stringify(key)}:"value"}`],
    ]) {
      const url = new URL("https://dashboard.chatgpt.site/?view=1");
      url.searchParams.set(parameter, value);
      url.searchParams.set(`f.${key}`, "value");
      assert.equal(dashboardViewSearchParams(url).toString(), "view=1");
      assert.deepEqual(readDashboardUrlState(snapshot, tabs, url),
        { ...emptyState, hasViewState: true, complete: true });
    }
  }
  assert.equal({}.polluted, undefined);
});

test("handoff allowlist preserves view state while dropping host tokens, credentials, fragments, and unknown state", () => {
  const url = new URL("https://owner:secret@dashboard.chatgpt.site/_data/charts/Ab12Cd34?view=1"
    + "&tab=adoption&f.region=EMEA&token=private&codexThreadId=thread&__proto__=bad#session-private");
  url.searchParams.set("a", JSON.stringify({ activationLift: 3 }));
  assert.equal(dashboardViewSearchParams(url).toString(),
    "view=1&tab=adoption&f.region=EMEA&a=%7B%22activationLift%22%3A3%7D");
  assert.equal(dashboardViewSearchParams({ href: url.href }).toString(), dashboardViewSearchParams(url).toString());
  assert.equal(dashboardViewSearchParams("not a URL").toString(), "");
  for (const view of ["view=2", "view=1&view=1", "view=1&view=2", ""]) {
    const href = `https://dashboard.chatgpt.site/?${view}&f.region=EMEA&a=%7B%22activationLift%22%3A3%7D`;
    assert.equal(dashboardViewSearchParams(href).toString(), "f.region=EMEA");
    assert.equal(readDashboardUrlState(snapshot, tabs, href).complete, false);
    assert.deepEqual(readDashboardUrlState(snapshot, tabs, href).assumptions, {});
  }
  const duplicates = "https://dashboard.chatgpt.site/?view=1&tab=adoption&tab=dashboard&f.region=EMEA&f.region=North+America";
  assert.equal(dashboardViewSearchParams(duplicates).toString(), "view=1");
});

test("replacing URL state removes stale auxiliary selections but retains host-only browser parameters", () => {
  const source = new URL("https://dashboard.chatgpt.site/?view=1&tab=adoption&f.region=EMEA&token=private#host-only");
  for (const parameter of ["a", "s", "c", "t", "focus"]) source.searchParams.set(parameter, "{}");
  const next = dashboardUrlWithState(source, snapshot, tabs, {});
  assert.equal(next.search, "?token=private&view=1");
  assert.equal(next.hash, "#host-only");
  const shared = dashboardUrlWithState(source, snapshot, tabs, {}, { preserveExisting: false });
  assert.equal(shared.href, "https://dashboard.chatgpt.site/?view=1");
});

test("oversized outgoing views fail explicitly instead of producing a partially defaulted link", () => {
  const manyValues = Object.fromEntries(Array.from({ length: 2_049 }, (_, index) => [`key-${index}`, "x"]));
  const largeValues = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key-${index}`, "x".repeat(700)]));
  for (const state of [
    { focus: manyValues },
    { sections: { section: manyValues } },
    { charts: { chart: { inlineFilters: manyValues } } },
    { tabViews: { overview: { filters: manyValues } } },
    { sections: { section: largeValues } },
    { focus: { account: "東京".repeat(12_000) } },
  ]) {
    assert.throws(() => dashboardUrlWithState("https://dashboard.chatgpt.site/?view=1&f.region=EMEA",
      snapshot, tabs, state), { name: "RangeError", code: "DATA_APP_VIEW_TOO_LARGE" });
  }
  const largeFilter = "x".repeat(65_537);
  const reviewed = { filters: [{ id: "label", field: "label", defaultValue: "all" }],
    queries: { reviewed: { rows: [{ label: largeFilter }] } } };
  assert.throws(() => serializeDashboardUrlState(reviewed, tabs, { filters: { label: largeFilter } }),
    { code: "DATA_APP_VIEW_TOO_LARGE" });
});

test("the selected first tab remains explicit when a recipient has a different tab order", () => {
  const source = dashboardUrlWithState("https://dashboard.chatgpt.site/", snapshot, tabs, { tab: "dashboard" });
  assert.equal(source.searchParams.get("tab"), "dashboard");
  assert.equal(readDashboardUrlState(snapshot, [...tabs].reverse(), source).tab, "dashboard");
});

test("handoffs retain reviewed categorical labels that resemble JSON without interpreting their contents", () => {
  const labels = ["[Draft]", "[1,2]", '{"constructor":"reviewed text"}'];
  const reviewed = { filters: [{ id: "label", field: "label", defaultValue: "all" }],
    queries: { reviewed: { rows: labels.map(label => ({ label })) } } };
  for (const label of labels) {
    const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", reviewed, tabs, { filters: { label } });
    const handedOff = `https://dashboard.chatgpt.site/?${dashboardViewSearchParams(url)}`;
    assert.deepEqual(readDashboardUrlState(reviewed, tabs, handedOff).filters, { label });
  }
});


test("multi-selects without an authored default distinguish an explicit empty selection from all", () => {
  const multi = { ...snapshot, filters: [{ id: "region", field: "region", multiple: true }] };
  for (const region of [[], "all", ["EMEA"]]) {
    const url = dashboardUrlWithState("https://dashboard.chatgpt.site/", multi, tabs, { filters: { region } });
    const state = readDashboardUrlState(multi, tabs, url);
    assert.deepEqual(resolveDashboardUrlFilters(multi, { region: ["North America"] }, state), { region });
  }
});


test("URL state imports in metadata hosts without TextEncoder and counts UTF-8 limits correctly", () => {
  const moduleUrl = new URL("../src/dashboard-url-state.js", import.meta.url).href;
  const result = execFileSync(process.execPath, ["--input-type=module", "-e", `
    globalThis.TextEncoder = undefined;
    const { serializeDashboardUrlState } = await import(process.argv[1]);
    process.stdout.write(serializeDashboardUrlState({}, [], {}).toString());
  `, moduleUrl], { encoding: "utf8" });
  assert.equal(result, "view=1");
  for (const exact of ["a".repeat(65_536), "東".repeat(21_845) + "a", "😀".repeat(16_384),
    "\ud800".repeat(21_845) + "a", "\udc00".repeat(21_845) + "a"]) {
    const oversized = exact + "a";
    const reviewed = { filters: [{ id: "label", field: "label" }],
      queries: { reviewed: { rows: [{ label: exact }, { label: oversized }] } } };
    assert.equal(validFilterValue(reviewed, reviewed.filters[0], exact), true);
    assert.equal(validFilterValue(reviewed, reviewed.filters[0], oversized), false);
  }
});
