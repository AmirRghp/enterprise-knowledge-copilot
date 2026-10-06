import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  consolidatedReceipt,
  formatReviewedSql, isTemporalField, referencedDefinitionVariable, reviewedDateRange,
  receiptSourceEntries, reviewedDefinitionLineage, reviewedQueryLink, reviewedSource, safeSourceHref, scopedMetricDefinitions, sourceTrustLabels,
} from "../src/source-provenance.js";

test("receipt consolidation deduplicates shared facts without merging data or losing conflicting scope", () => {
  const definition = { label: "Activation", definition: "Share completing setup.", formula: "activated / eligible" };
  const queries = [{ id: "first", summary: "Supported conclusion.", source: {
    label: "First cohort", metricDefinitions: [definition], filters: ["Plan: all"], caveats: ["Shared limitation."],
    files: [{ label: "counts.csv" }], evidenceFlow: [{ title: "Recorded inputs", detail: "Counts were supplied." }],
  }, rows: [{ activated: 1 }], reportingPeriod: "August 2026" }, {
    id: "second", summary: "Supported conclusion.", source: {
      label: "Second cohort", metricDefinitions: [definition], filters: ["Plan: all"], caveats: ["Shared limitation."],
      files: [{ label: "counts.csv" }], evidenceFlow: [{ detail: "Counts were supplied.", title: "Recorded inputs" }],
    }, rows: [{ activated: 2 }], reportingPeriod: "September 2026",
  }];
  const before = JSON.stringify(queries);
  const result = consolidatedReceipt(queries, "finding");
  assert.equal(result.definitions.length, 1);
  assert.equal(result.summaries.length, 1);
  assert.equal(result.caveats.length, 1);
  assert.equal(result.sources.length, 1);
  assert.equal(result.evidence.length, 1);
  assert.deepEqual(result.evidence[0].sourceLabels, ["First cohort", "Second cohort"]);
  assert.deepEqual(result.filters.find(({ value }) => value.label === "Plan").scopeLabels, []);
  assert.deepEqual(result.periods.map(({ scopeLabels }) => scopeLabels),
    [["First cohort"], ["Second cohort"]]);
  assert.deepEqual(result.periods.map(({ value }) => value), ["August 2026", "September 2026"]);
  assert.equal(result.filters.length, 1, "Reporting periods are not duplicated as filter chips");
  assert.equal(JSON.stringify(queries), before, "Consolidating presentation must not mutate either recorded result");

  queries[1].source.metricDefinitions = [{ ...definition, formula: "activated / invited" }];
  queries[1].source.filters = [];
  const conflicting = consolidatedReceipt(queries, "finding");
  assert.equal(conflicting.definitions.length, 2);
  assert.deepEqual(conflicting.definitions.map(({ scopeLabels }) => scopeLabels), [["First cohort"], ["Second cohort"]]);
  assert.deepEqual(conflicting.filters.find(({ value }) => value.label === "Plan").scopeLabels, ["First cohort"],
    "A missing filter must not become a shared filter");
});

test("receipt attribution distinguishes separate queries with the same source label", () => {
  const queries = ["first", "second"].map((id) => ({ id, source: { label: "Shared warehouse",
    metricDefinitions: [{ label: "Rate", definition: `${id} denominator.` }],
    filters: [`Cohort: ${id}`], evidenceFlow: [{ title: `${id} query`, detail: `Executed ${id}.` }],
  } }));
  const receipt = consolidatedReceipt(queries, "finding");
  for (const section of [receipt.definitions, receipt.filters])
    assert.deepEqual(section.map(({ scopeLabels }) => scopeLabels), [["Shared warehouse · first"], ["Shared warehouse · second"]]);
  assert.deepEqual(receipt.evidence.map(({ sourceLabels }) => sourceLabels), [["Shared warehouse · first"], ["Shared warehouse · second"]]);
  assert.equal(receipt.sources.length, 1, "Source identity remains shared; only query attribution is disambiguated");
});

test("consolidated definition lineage cannot borrow validation from a different source", () => {
  const definition = { label: "Accounts", definition: "Recorded accounts." };
  const result = consolidatedReceipt([{ id: "a", source: { label: "A", tables: ["alpha.accounts"],
    metricDefinitions: [{ ...definition, sourceLineage: [{ tables: ["alpha.accounts", "beta.accounts"] }] }] } },
  { id: "b", source: { label: "B", tables: ["beta.accounts"], metricDefinitions: [definition] } }], "finding");
  assert.equal(result.definitions.length, 1);
  assert.deepEqual(result.definitions[0].value.sourceLineage.flatMap(({ tables }) => tables), ["alpha.accounts"]);
});

test("one source chip preserves distinct recorded roles without borrowing another source's role", () => {
  const link = { label: "Shared document", href: "https://example.com/document" };
  const role = (text) => ({ kind: "link", ...link, role: text });
  const queries = [{ id: "a", source: { label: "A", links: [link] }, sourceRoles: [role("Records timing.\nIncludes dates.")] },
    { id: "b", source: { label: "B", links: [link] }, sourceRoles: [role("Records timing.\nIncludes dates.")] },
    { id: "c", source: { label: "C", links: [link] }, sourceRoles: [role("Defines the scope.")] },
    { id: "d", source: { label: "D", links: [{ ...link, href: "https://example.com/other" }] },
      sourceRoles: [role("Must not leak from a different destination.")] }];
  const before = JSON.stringify(queries);
  const result = consolidatedReceipt(queries, "finding");
  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].value.role, "Records timing.\nIncludes dates.\nDefines the scope.");
  assert.equal(result.sources[1].value.role, undefined);
  assert.equal(JSON.stringify(queries), before);
});

test("receipt sources preserve usage and enrich an exact source with one unambiguous snapshot", () => {
  const table = { name: "analytics.reviewed.daily", href: "https://catalog.example.com/daily" };
  const trust = { provider: "Snowflake", queryCount: 0, windowDays: 30,
    usageAsOf: "2026-09-04T12:00:00Z", usageNote: "Successful queries including reads through views." };
  const dashboard = { kind: "dashboard", label: "Revenue overview", href: "https://bi.example.com/revenue",
    trust: { viewCount: 24, windowDays: 7 } };
  const queries = [
    { id: "first", source: { label: "First", tables: [table], links: [dashboard] } },
    { id: "second", source: { label: "Second", tables: [{ ...table, trust }], links: [dashboard] } },
    { id: "third", source: { label: "Third", tables: [{ ...table, trust: {
      usageNote: trust.usageNote, usage_as_of: trust.usageAsOf, window_days: 30, query_count: 0, provider: "Snowflake",
    } }] } },
  ];
  const before = JSON.stringify(queries);
  const entries = receiptSourceEntries(reviewedSource(queries[1].source));
  assert.deepEqual(entries[0].trust, trust);
  assert.deepEqual(entries[1].trust, dashboard.trust);
  for (const ordering of [queries, [...queries].reverse()]) {
    const sources = consolidatedReceipt(ordering, "finding").sources;
    assert.equal(sources.length, 2, "Equal normalized snapshots deduplicate independently of input order");
    const recordedTable = sources.find(({ value }) => value.kind === "table");
    assert.deepEqual(recordedTable.value.trust, trust);
    assert.deepEqual(recordedTable.scopeLabels, []);
    assert.deepEqual(sources.find(({ value }) => value.kind === "dashboard").value.trust, dashboard.trust);
  }
  assert.equal(JSON.stringify(queries), before, "Enrichment must not mutate reviewed query metadata");
});

test("receipt sources preserve conflicting usage snapshots and leave ambiguous missing metadata absent", () => {
  const table = { name: "analytics.reviewed.daily", href: "https://catalog.example.com/daily" };
  const trust = { queryCount: 12, windowDays: 7, usageAsOf: "2026-09-04T12:00:00Z",
    usageNote: "Successful queries." };
  const snapshots = [trust, { ...trust, windowDays: 30 }, { ...trust, queryCount: 13 },
    { ...trust, usageAsOf: "2026-09-03T12:00:00Z" }, { ...trust, usageNote: "Current user only." }, undefined];
  const queries = snapshots.map((snapshot, index) => ({ id: `query-${index}`, source: {
    label: `Snapshot ${index}`, tables: [{ ...table, ...(snapshot ? { trust: snapshot } : {}) }],
  } }));
  const sources = consolidatedReceipt(queries, "finding").sources;
  assert.equal(sources.length, snapshots.length);
  assert.deepEqual(sources.map(({ value }) => value.trust), snapshots,
    "Counts, windows, observation times, and coverage are separate snapshots, never combined or summed");
  assert.deepEqual(sources.map(({ sourceLabels }) => sourceLabels), snapshots.map((_, index) => [`Snapshot ${index}`]));
  assert.equal(Object.hasOwn(sources.at(-1).value, "trust"), false);
});

test("receipt usage remains attached to the exact table and source type", () => {
  const href = "https://catalog.example.com/asset";
  const trust = { queryCount: 10, windowDays: 30 };
  const queries = [
    { id: "first", source: { label: "First", tables: [{ name: "alpha.daily", href, trust }],
      links: [{ kind: "dashboard", label: "Dashboard", href, trust: { viewCount: 80 } }] } },
    { id: "second", source: { label: "Second", tables: [
      { name: "beta.daily", href }, { name: "alpha.daily", href: "https://catalog.example.com/other" },
    ], files: [{ label: "Export", href }], links: [{ label: "Documentation", href }] } },
  ];
  const sources = consolidatedReceipt(queries, "finding").sources.map(({ value }) => value);
  assert.equal(sources.length, 6);
  assert.deepEqual(sources.filter((entry) => entry.trust).map(({ kind, label, trust: usage }) => ({ kind, label, usage })), [
    { kind: "table", label: "alpha.daily", usage: trust },
    { kind: "dashboard", label: "Dashboard", usage: { viewCount: 80 } },
  ]);
});

test("source provenance retains nested reviewed evidence and rejects unsafe links", () => {
  const source = reviewedSource({
    url: "javascript:alert(1)",
    links: ["https://example.com/reviewed"],
    assumptions: ["Coverage excludes unverified rows."],
    query: {
      sql: "SELECT value FROM reviewed_table",
      tables_used: ["reviewed_table"],
      filters: ["status = 'reviewed'"],
      executed_at: "2026-07-27T12:00:00Z",
      metric_definitions: [{ label: "Value", definition: "Reviewed measurement." }],
      evidence_flow: ["Reviewed warehouse query", "Bounded dashboard snapshot"],
    },
  });

  assert.equal(source.sql, "SELECT value FROM reviewed_table");
  assert.deepEqual(source.tables, ["reviewed_table"]);
  assert.deepEqual(source.links, ["https://example.com/reviewed"]);
  assert.equal(source.definitions.length, 1);
  assert.equal(source.evidenceFlow.length, 2);
  assert.equal(safeSourceHref("file:///tmp/private"), null);
  assert.deepEqual(reviewedSource({}).evidenceFlow, []);
});

test("provider query links preserve recorded editor and execution destinations", () => {
  const id = "01f11e2b-9c0a-10d3-a337-d98569f1d830";
  for (const [href, provider] of [
    ["https://workspace.cloud.databricks.com/sql/editor/123456789?o=123456", "Databricks"],
    [`https://workspace.cloud.databricks.com/sql/editor/${id}?o=123456`, "Databricks"],
    [`https://adb-123.4.azuredatabricks.net/sql/queries/${id}`, "Databricks"],
    [`https://workspace.gcp.databricks.com/sql/history?queryId=${id}&o=123456`, "Databricks"],
    [`https://workspace.cloud.databricks.com/?o=123456#sql/queries/${id}`, "Databricks"],
    [`https://app.snowflake.com/org/account/#/compute/history/queries/${id}/detail`, "Snowflake"],
    ["https://app.snowflake.com/org/account/#/worksheets/worksheet123", "Snowflake"],
    ["https://app.snowflake.com/org/account/ws/worksheet123", "Snowflake"],
  ]) {
    const expected = { href, label: `Open in ${provider}` };
    for (const source of [{ queryUrl: href }, { query_url: href }, { query: { url: href } },
      { url: href }, { href }, { links: [{ href, label: "Recorded query" }] }, { query: { links: [href] } }]) {
      assert.deepEqual(reviewedQueryLink(source), expected);
      assert.deepEqual(reviewedSource(source).queryLink, expected);
    }
    if (new URL(href).search || new URL(href).hash) assert.equal(safeSourceHref(href), null,
      "Query routing exceptions must not broaden the ordinary source URL contract");
  }
});

test("explicit query destinations take precedence without inventing links from SQL or metadata", () => {
  const href = "https://warehouse.example/permalink/reviewed-query";
  const source = { queryUrl: href, sql: "SELECT 1", provider: "Snowflake", query: { id: "123" },
    url: "https://workspace.cloud.databricks.com/sql/editor/123" };
  const before = JSON.stringify(source);
  assert.deepEqual(reviewedQueryLink(source), { href, label: "Open query" });
  assert.equal(JSON.stringify(source), before);
  assert.equal(reviewedQueryLink({ url: href }), null, "Generic source links are not necessarily query pages");
  assert.equal(reviewedQueryLink({ sql: "SELECT 1", provider: "Snowflake", query: { id: "123" } }), null);
  assert.equal(reviewedQueryLink(null), null);
  assert.equal(reviewedSource({}).queryLink, null);
});

test("query links exclude home, catalog, and dashboard destinations", () => {
  for (const href of [
    "https://workspace.cloud.databricks.com/",
    "https://workspace.cloud.databricks.com/sql/editor",
    "https://workspace.cloud.databricks.com/sql/history?o=123",
    "https://workspace.cloud.databricks.com/explore/data/catalog/schema/table",
    "https://workspace.cloud.databricks.com/sql/dashboards/123",
    "https://app.snowflake.com/org/account/",
    "https://app.snowflake.com/org/account/#/data/databases",
    "https://app.snowflake.com/org/account/#/dashboards/123",
  ]) {
    assert.equal(reviewedQueryLink({ queryUrl: href }), null, href);
    assert.equal(reviewedQueryLink({ links: [href] }), null, href);
  }
});

test("provider query routing rejects unsafe or unrecognized state instead of stripping it", () => {
  const editor = "https://workspace.cloud.databricks.com/sql/editor/123";
  const history = "https://app.snowflake.com/org/account/#/compute/history/queries/01f11e2b-9c0a-10d3-a337-d98569f1d830/detail";
  for (const href of [
    editor.replace("https:", "http:"), editor.replace("https://", "https://user:password@"),
    editor.replace(".com/", ".com:8443/"), `${editor}?token=private`, `${editor}?o=123&access_token=private`,
    `${editor}?o=123&o=456`, `${editor}?o=123%26token%3Dprivate`, `${editor}?query=SELECT+1`,
    `${editor}#access_token=private`, `${editor}?o=123#query/123`, `${editor}\n`,
    `${history}?token=private`, `${history}/token/private`,
    history.replace("/detail", "%3Ftoken%3Dprivate/detail"),
    history.replace("org/account/", "org/access_token-private/"),
    "https://warehouse.example/permalink/reviewed?token=private",
    "https://warehouse.example/permalink/reviewed#private",
    "javascript:alert(1)", "file:///tmp/query.sql",
  ]) assert.equal(reviewedQueryLink({ queryUrl: href }), null, href);
  assert.equal(reviewedQueryLink({ links: [editor.replace(".com/", ".com.evil.example/")] }), null);
  assert.deepEqual(reviewedQueryLink({ queryUrl: `${editor}?token=private`, links: [editor] }),
    { href: editor, label: "Open in Databricks" }, "An unsafe candidate must not hide another reviewed valid query link");
});

test("reviewed metric definitions preserve existing compact entries across supported metadata aliases", () => {
  const legacy = { label: "Active users", definition: "Distinct reviewed active accounts." };
  for (const source of [
    { metricDefinitions: [legacy] },
    { metric_definitions: [legacy] },
    { query: { metricDefinitions: [legacy] } },
    { query: { metric_definitions: [legacy] } },
  ]) {
    assert.deepEqual(reviewedSource(source).definitions, [legacy],
      "Existing simple metric definitions must remain compact and backward compatible");
  }

  assert.deepEqual(reviewedSource({
    metricDefinitions: [
      "Active users: Distinct reviewed active accounts.",
      "Activation rate = Activated accounts divided by qualified accounts.",
    ],
  }).definitions, [
    { label: "Active users", definition: "Distinct reviewed active accounts." },
    { label: "Activation rate", definition: "Activated accounts divided by qualified accounts." },
  ], "Only explicitly labeled legacy strings can become reviewed metric definitions");
});

test("reviewed metric definitions retain explicitly reviewed formulas, scope, dependencies, and lineage", () => {
  const definition = {
    label: "  Activation rate  ",
    definition: "  Activated accounts divided by qualified accounts.  ",
    variable: "  activation_rate  ",
    formula: "  activated_accounts / qualified_accounts  ",
    componentIds: ["conversion", "conversion", "", null],
    dependencies: ["activated_accounts", "qualified_accounts", "", null],
    numerator: { field: "  activated_accounts  ", label: "  Activated accounts  " },
    denominator: { field: "  qualified_accounts  ", label: "  Qualified accounts  " },
    sourceLineage: [{
      tables: ["analytics.reviewed.activation", "", null],
      files: ["models/activation.sql", "", null],
    }],
  };

  const [normalized] = reviewedSource({ metricDefinitions: [definition] }).definitions;

  assert.equal(normalized.label, "Activation rate");
  assert.equal(normalized.definition, "Activated accounts divided by qualified accounts.");
  assert.equal(normalized.variable, "activation_rate");
  assert.equal(normalized.formula, "activated_accounts / qualified_accounts");
  assert.deepEqual(normalized.componentIds, ["conversion"]);
  assert.deepEqual(normalized.dependencies, ["activated_accounts", "qualified_accounts"]);
  assert.equal(normalized.numerator.field, "activated_accounts");
  assert.equal(normalized.numerator.label, "Activated accounts");
  assert.equal(normalized.denominator.field, "qualified_accounts");
  assert.equal(normalized.denominator.label, "Qualified accounts");
  assert.deepEqual(normalized.sourceLineage, [{
    tables: ["analytics.reviewed.activation"],
    files: ["models/activation.sql"],
  }]);
});

test("missing or malformed metric definitions fail closed without invented labels or formulas", () => {
  for (const source of [
    {},
    { metricDefinitions: null },
    { metricDefinitions: "Active users" },
    { metricDefinitions: [
      null,
      false,
      12,
      {},
      { label: "Active users" },
      { definition: "Distinct reviewed active accounts." },
      { label: " ", definition: "Distinct reviewed active accounts." },
      { label: "Active users", definition: " " },
      "An unlabeled explanation cannot become a metric.",
      ": missing label",
      "Missing explanation:",
    ] },
  ]) {
    assert.deepEqual(reviewedSource(source).definitions, [],
      "Unreviewed or incomplete methodology must not become an invented definition");
  }

  const [simple] = reviewedSource({ metricDefinitions: [{
    label: "Active users", definition: "Distinct reviewed active accounts.",
  }] }).definitions;
  assert.equal(Object.hasOwn(simple, "formula"), false,
    "A raw reviewed count must not acquire an invented or decorative formula");
  assert.equal(Object.hasOwn(simple, "sourceLineage"), false,
    "A simple reviewed definition must not acquire fabricated source lineage");
});

test("invalid supplied component scopes fail closed while absent legacy scopes remain available", () => {
  const legacy = {
    label: "Legacy accounts",
    definition: "A reviewed metric recorded before component ownership existed.",
  };
  const owned = {
    label: "Owned accounts",
    definition: "A reviewed metric belonging to its exact component.",
    componentIds: ["owned-component"],
  };

  for (const invalidScope of [
    "private-component",
    null,
    false,
    12,
    {},
    [],
    ["", " ", null, 12],
  ]) {
    const definitions = reviewedSource({ metricDefinitions: [legacy, {
      label: "Private accounts",
      definition: "A supplied component scope must never silently disappear.",
      componentIds: invalidScope,
    }, owned] }).definitions;

    assert.deepEqual(definitions, [legacy, owned],
      `Invalid supplied component scope ${JSON.stringify(invalidScope)} must reject its definition`);
    assert.deepEqual(scopedMetricDefinitions(definitions, "unrelated-component"), [legacy],
      "An unrelated component may retain genuinely absent legacy ownership, never malformed supplied ownership");
    assert.deepEqual(scopedMetricDefinitions(definitions, "owned-component"), [owned],
      "Legacy methodology must not clutter an explicitly owned component");
  }
});

test("direct component scoping also rejects malformed ownership before any legacy fallback", () => {
  const legacy = {
    label: "Legacy accounts",
    definition: "A reviewed source recorded before component scopes existed.",
  };
  const owner = {
    label: "Owned accounts",
    definition: "Reviewed methodology owned by its selected component.",
    componentIds: ["owned-component"],
  };

  for (const malformed of ["private-component", null, [], [" ", false]]) {
    const privateDefinition = {
      label: "Private accounts",
      definition: "Invalid explicit ownership cannot become public.",
      componentIds: malformed,
    };
    assert.deepEqual(scopedMetricDefinitions([privateDefinition, legacy, owner], "unrelated"), [legacy],
      `A direct helper call must reject malformed supplied scope ${JSON.stringify(malformed)}`);
    assert.deepEqual(scopedMetricDefinitions([privateDefinition], "unrelated"), [],
      "A malformed-only query must fail closed rather than restoring every reviewed definition");
  }
});

test("reviewed source files preserve only explicit labels and safe reviewed links", () => {
  const safe = { label: "models/activation.sql", href: "https://reviewed.example.com/activation.sql" };
  for (const source of [
    { files: [safe] },
    { sourceFiles: [safe] },
    { query: { files: [safe] } },
    { query: { sourceFiles: [safe] } },
  ]) {
    assert.deepEqual(reviewedSource(source).files, [safe],
      "Explicit reviewed source files must survive supported source metadata aliases");
  }

  const source = reviewedSource({
    files: [
      safe,
      { label: "models/private.sql", href: "file:///tmp/private.sql" },
      { label: "models/unsafe.sql", href: "javascript:alert(1)" },
      { href: "https://reviewed.example.com/unlabeled.sql" },
      { label: " " },
    ],
  });
  assert.deepEqual(source.files, [
    safe,
    { label: "models/private.sql", href: null },
    { label: "models/unsafe.sql", href: null },
  ], "Unsafe or unlabeled provenance cannot become a navigable reviewed source");
});

test("reviewed query filters remain explicit, deduplicated provenance without invented predicates", () => {
  const source = reviewedSource({
    filters: ["tenant_id = 'reviewed'", "tenant_id = 'reviewed'", null],
    query: {
      filters: [
        "reporting_week >= DATE '2026-07-20'",
        "tenant_id = 'reviewed'",
        42,
        { field: "private_scope" },
      ],
    },
    metricDefinitions: [{
      label: "Active users",
      definition: "Distinct reviewed active accounts.",
      componentIds: ["active-users"],
    }],
  });

  assert.deepEqual(source.filters, [
    "tenant_id = 'reviewed'",
    "reporting_week >= DATE '2026-07-20'",
  ], "Only exact predicates explicitly supplied by reviewed source metadata may appear in provenance");
  assert.equal(Object.hasOwn(source.definitions[0], "filters"), false,
    "A reviewed source filter must not be silently attributed to an individual metric");
});

test("component metric definitions use exact reviewed ownership without leaking neighboring metrics", () => {
  const active = {
    label: "Active users",
    definition: "Distinct reviewed active accounts.",
    componentIds: ["active-users", "usage-trend"],
  };
  const conversion = {
    label: "Activation rate",
    definition: "Activated accounts divided by qualified accounts.",
    componentIds: ["conversion"],
  };
  const inactive = {
    label: "Inactive users",
    definition: "Accounts without a qualifying event.",
    componentIds: ["inactive-users"],
  };

  assert.deepEqual(scopedMetricDefinitions([active, conversion, inactive], "active-users"), [active],
    "An active-user metric must show exactly its own reviewed definition");
  assert.deepEqual(scopedMetricDefinitions([active, conversion, inactive], "conversion"), [conversion],
    "A neighboring conversion metric must never inherit active-user methodology");
  assert.deepEqual(scopedMetricDefinitions([active, conversion, inactive], "usage-trend"), [active],
    "A chart should inherit only definitions explicitly attached to that chart");
  assert.deepEqual(scopedMetricDefinitions([active, conversion, inactive], "growth"), [],
    "A metric without reviewed ownership must fail closed instead of showing a nearby definition");
  assert.deepEqual(scopedMetricDefinitions([active, conversion, inactive], "active"), [],
    "Component ownership must never match a component-id substring");
  assert.deepEqual(scopedMetricDefinitions([], "active-users"), []);
});

test("edited chart fields replace stale definitions through exact reviewed series identity", () => {
  const active = {
    label: "Active users",
    definition: "Distinct reviewed active accounts.",
    field: "activeUsers",
    componentIds: ["usage-trend"],
  };
  const target = {
    label: "Target users",
    definition: "Reviewed account target.",
    variable: "targetUsers",
    componentIds: ["usage-trend"],
  };
  const conversion = {
    label: "Conversion",
    definition: "Activated accounts divided by qualified accounts.",
    field: "conversion",
    formula: "activated_users / qualified_users",
    componentIds: ["conversion-card"],
  };
  const converted = {
    label: "Converted accounts",
    definition: "Accounts used for an unrelated exact reviewed series.",
    field: "conversion_shadow",
    componentIds: ["private-conversion"],
  };
  const activated = {
    label: "Activated users",
    definition: "Reviewed accounts that completed activation.",
    variable: "activated_users",
  };
  const qualified = {
    label: "Qualified users",
    definition: "Reviewed accounts eligible to activate.",
    variable: "qualified_users",
  };
  const privateVariable = {
    label: "Private qualified users",
    definition: "A numerator explicitly owned by another component.",
    variable: "qualified_users",
    componentIds: ["private-component"],
  };
  const definitions = [active, target, conversion, converted, activated, qualified, privateVariable];

  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: ["conversion"], chartEdited: true,
  }), [conversion, activated, qualified],
  "An edited chart must show its exact reviewed replacement series and unscoped dependencies, not stale or private inputs");
  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: ["ACTIVE_USERS", "target-users"], chartEdited: true,
  }), [active, target], "Exact canonical reviewed aliases may normalize casing and separators");
  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: ["conversion"], chartEdited: false,
  }), [active, target], "An unedited authored chart must retain its explicit stable component ownership");
  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: [], chartEdited: true,
  }), [active, target], "An override without reviewed displayed fields must retain ordinary component ownership");
  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: ["convers"], chartEdited: true,
  }), [], "Partial series identifiers must not import another component's reviewed definition");
  assert.deepEqual(scopedMetricDefinitions(definitions, "usage-trend", {
    displayedFields: ["private_users"], chartEdited: true,
  }), [], "Unknown edited series must fail closed rather than restoring unrelated authored methodology");
});

test("edited chart definitions prefer the component's exact field over another owner's collision", () => {
  const current = {
    label: "Current conversion",
    definition: "Reviewed conversion specific to the current component.",
    field: "conversion",
    componentIds: ["usage-trend"],
  };
  const shared = {
    label: "Shared conversion",
    definition: "Reviewed legacy conversion used only when no owner exists.",
    field: "conversion",
  };
  const other = {
    label: "Private conversion",
    definition: "Reviewed conversion owned by another component.",
    field: "conversion",
    componentIds: ["private-component"],
  };

  assert.deepEqual(scopedMetricDefinitions([other, shared, current], "usage-trend", {
    displayedFields: ["conversion"], chartEdited: true,
  }), [current], "Exact reviewed fields owned by the current component take precedence");
  assert.deepEqual(scopedMetricDefinitions([other, shared], "usage-trend", {
    displayedFields: ["conversion"], chartEdited: true,
  }), [shared], "A genuinely unscoped exact field takes precedence over another component's ownership");
});

test("legacy unscoped definitions remain available without leaking explicitly scoped definitions", () => {
  const legacy = { label: "Active users", definition: "Distinct reviewed active accounts." };
  const other = { label: "Conversion", definition: "Reviewed conversion rate." };
  const scoped = {
    label: "Private activation",
    definition: "Definition owned by another component.",
    componentIds: ["conversion"],
  };

  assert.deepEqual(scopedMetricDefinitions([legacy, other], "active-users"), [legacy, other],
    "Existing unscoped sources must retain their historical reviewed definitions");
  assert.deepEqual(scopedMetricDefinitions([legacy, scoped], "active-users"), [legacy],
    "Scoped definitions belonging to another component must not leak into a legacy fallback");
  assert.deepEqual(scopedMetricDefinitions([legacy, scoped], "conversion"), [scoped],
    "Unrelated unscoped definitions must not clutter an explicitly owned component");
});

test("starter forecast-gap provenance includes both reviewed formula operands and exact identifiers", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../src/data.json", import.meta.url), "utf8"));
  const source = reviewedSource(snapshot.queries.forecast_outlook.source);
  const projected = source.definitions.find(({ label }) => label === "Projected users");
  const target = source.definitions.find(({ label }) => label === "Target users");
  const gap = source.definitions.find(({ label }) => label === "Forecast gap");
  const visible = scopedMetricDefinitions(source.definitions, "forecast-gap");

  assert.ok(projected, "The reviewed forecast must define its projected-user input");
  assert.ok(target, "The reviewed forecast must define its target-user input");
  assert.ok(gap, "The reviewed forecast must define its calculated gap");
  assert.equal(projected.variable, "projectedUsers");
  assert.equal(target.variable, "targetUsers");
  assert.deepEqual(projected.componentIds, ["forecast-outlook", "forecast-gap"]);
  assert.deepEqual(target.componentIds, ["forecast-outlook", "forecast-gap"]);
  assert.equal(gap.formula, "projectedUsers - targetUsers");
  assert.deepEqual(visible.map(({ label }) => label), [
    "Projected users", "Target users", "Forecast gap",
  ], "The selected metric must expose both exact reviewed operands without unrelated forecast series");
  assert.equal(referencedDefinitionVariable(projected, visible), "projectedUsers");
  assert.equal(referencedDefinitionVariable(target, visible), "targetUsers");
  assert.deepEqual(reviewedDefinitionLineage(projected, source), ["product_adoption_forecast"]);
  assert.deepEqual(reviewedDefinitionLineage(target, source), ["product_adoption_forecast"]);
});

test("explicit metric dependencies include shared reviewed variables recursively in stable source order", () => {
  const qualified = {
    label: "Qualified accounts",
    definition: "Reviewed accounts eligible to activate.",
    variable: "qualified_accounts",
    dependencies: ["excluded_accounts"],
    formula: "all_accounts - excluded_accounts",
  };
  const excluded = {
    label: "Excluded accounts",
    definition: "Accounts excluded by reviewed eligibility rules.",
    variable: "excluded_accounts",
  };
  const activation = {
    label: "Activation rate",
    definition: "Activated accounts divided by qualified accounts.",
    componentIds: ["conversion"],
    formula: "activated_accounts / qualified_accounts",
    dependencies: ["activated_accounts", "qualified_accounts"],
    numerator: { field: "activated_accounts" },
    denominator: { field: "qualified_accounts" },
  };
  const activated = {
    label: "Activated accounts",
    definition: "Reviewed accounts that completed activation.",
    variable: "activated_accounts",
  };
  const unrelated = {
    label: "Retention",
    definition: "Accounts retained after the reviewed period.",
    variable: "retained_accounts",
  };
  const definitions = [qualified, unrelated, excluded, activation, activated];

  assert.deepEqual(scopedMetricDefinitions(definitions, "conversion"),
    [qualified, excluded, activation, activated],
    "Only reviewed transitive numerator, denominator, and explicit shared variables may accompany the metric");
  assert.equal(referencedDefinitionVariable(qualified, definitions), "qualified_accounts");
  assert.equal(referencedDefinitionVariable(activated, definitions), "activated_accounts");
  assert.equal(referencedDefinitionVariable(excluded, definitions), "excluded_accounts");
  assert.equal(referencedDefinitionVariable(unrelated, definitions), null,
    "Unreferenced shared variables must not acquire a decorative leading variable label");
});

test("reviewed numerator and denominator fields include shared variables without inventing a formula", () => {
  const numerator = {
    label: "Activated accounts",
    definition: "Reviewed accounts that completed activation.",
    variable: "activated_accounts",
  };
  const denominator = {
    label: "Qualified accounts",
    definition: "Reviewed accounts eligible to activate.",
    variable: "qualified_accounts",
  };
  const unrelated = {
    label: "Retained accounts",
    definition: "Reviewed accounts retained in the next period.",
    variable: "retained_accounts",
  };
  const ratio = {
    label: "Activation rate",
    definition: "Activated accounts divided by qualified accounts.",
    componentIds: ["conversion"],
    numerator: { field: "activated_accounts" },
    denominator: { field: "qualified_accounts" },
  };

  assert.deepEqual(scopedMetricDefinitions([numerator, unrelated, denominator, ratio], "conversion"),
    [numerator, denominator, ratio],
    "Explicit reviewed numerator/denominator aliases must retain only their corresponding shared variables");
  assert.equal(Object.hasOwn(ratio, "formula"), false,
    "Known ratio inputs must not cause an unreviewed formula to be invented");
});

test("formula dependencies match whole identifiers instead of overlapping metric-token substrings", () => {
  const active = {
    label: "Active accounts",
    definition: "Reviewed active accounts.",
    variable: "active",
  };
  const inactive = {
    label: "Inactive accounts",
    definition: "Reviewed accounts without recent activity.",
    variable: "inactive",
  };
  const rate = {
    label: "Rate",
    definition: "Reviewed conversion rate.",
    variable: "rate",
  };
  const prorated = {
    label: "Prorated total",
    definition: "Reviewed prorated value.",
    variable: "prorated",
  };
  const target = {
    label: "Activation efficiency",
    definition: "Reviewed activation divided by the exact rate.",
    componentIds: ["efficiency"],
    formula: "inactive / prorated",
  };
  const definitions = [active, inactive, rate, prorated, target];

  assert.deepEqual(scopedMetricDefinitions(definitions, "efficiency"), [inactive, prorated, target],
    "A whole-token formula match must not pull active from inactive or rate from prorated");
  assert.equal(referencedDefinitionVariable(active, [active, target]), null);
  assert.equal(referencedDefinitionVariable(rate, [rate, target]), null);
  assert.equal(referencedDefinitionVariable(inactive, [inactive, target]), "inactive");
  assert.equal(referencedDefinitionVariable(prorated, [prorated, target]), "prorated");
});

test("shared metric variables never bypass another component's explicit ownership", () => {
  const protectedVariable = {
    label: "Protected accounts",
    definition: "Owned by a different reviewed component.",
    variable: "protected_accounts",
    componentIds: ["private-component"],
  };
  const publicMetric = {
    label: "Public rate",
    definition: "A reviewed public metric.",
    componentIds: ["public-component"],
    dependencies: ["protected_accounts"],
    formula: "protected_accounts / 10",
  };

  assert.deepEqual(scopedMetricDefinitions([protectedVariable, publicMetric], "public-component"),
    [publicMetric], "A formula reference must not override explicit component ownership");
  assert.deepEqual(scopedMetricDefinitions([protectedVariable, publicMetric], "private-component"),
    [protectedVariable]);
});

test("metric lineage renders only exact reviewed source identifiers without invented lookalikes", () => {
  const source = {
    tables: ["analytics.finance.activation", "warehouse.reporting.qualified_accounts"],
    files: [
      { label: "models/activation.sql", href: "https://reviewed.example.com/activation.sql" },
      { label: "models/eligibility.sql", href: null },
    ],
  };
  const definition = {
    label: "Activation rate",
    definition: "Reviewed account activation.",
    sourceLineage: [{
      tables: [
        "analytics.finance.activation",
        "activation",
        "analytics.finance.activation_shadow",
      ],
      files: [
        "models/activation.sql",
        "activation.sql",
        "models/unreviewed.sql",
      ],
    }, {
      tables: ["analytics.finance.activation", "warehouse.reporting.qualified_accounts"],
      files: ["models/eligibility.sql", "models/activation.sql"],
    }],
  };

  assert.deepEqual(reviewedDefinitionLineage(definition, source), [
    "activation", "activation.sql", "qualified_accounts", "eligibility.sql",
  ], "Only exact, explicitly reviewed tables/files can yield stable deduplicated short lineage labels");
  assert.deepEqual(reviewedDefinitionLineage({
    label: "Constant", definition: "Reviewed contractual constant.", formula: "12",
  }, source), [], "A reviewed constant must not inherit an unrelated query table");
  assert.deepEqual(reviewedDefinitionLineage({
    label: "Unreviewed", definition: "Unknown source.", sourceLineage: [{
      tables: ["warehouse.private.accounts"], files: ["../../private.sql"],
    }],
  }, source), [], "Unknown or path-like provenance must fail closed");
});

test("colliding reviewed table and file names retain distinct minimally qualified lineage", () => {
  const source = {
    tables: [
      "warehouse.current.accounts",
      "warehouse.archive.accounts",
      "warehouse.reporting.activation",
    ],
    files: [
      { label: "models/current/accounts.sql" },
      { label: "models/archive/accounts.sql" },
      { label: "models/activation" },
    ],
  };
  const definition = {
    label: "Reviewed accounts",
    definition: "Only the explicitly recorded warehouse and model sources.",
    sourceLineage: [{
      tables: [
        "warehouse.current.accounts",
        "warehouse.archive.accounts",
        "warehouse.reporting.activation",
        "warehouse.private.accounts",
      ],
      files: [
        "models/current/accounts.sql",
        "models/archive/accounts.sql",
        "models/activation",
        "models/private/accounts.sql",
      ],
    }, {
      tables: ["warehouse.current.accounts"],
      files: ["models/current/accounts.sql"],
    }],
  };

  assert.deepEqual(reviewedDefinitionLineage(definition, source), [
    "current.accounts",
    "archive.accounts",
    "reporting.activation",
    "current/accounts.sql",
    "archive/accounts.sql",
    "models/activation",
  ], "Distinct reviewed tables/files with colliding leaves require their shortest unique qualifiers");
});

test("source provenance keeps labeled reviewed links and rejects unsafe object URLs", () => {
  const source = reviewedSource({
    links: [
      { label: "Open reviewed query", href: "https://example.com/query" },
      { label: "Unsafe query", href: "javascript:alert(1)" },
    ],
    query: { links: [{ label: "Warehouse source", url: "https://example.com/warehouse" }] },
  });
  assert.deepEqual(source.links, [
    { label: "Open reviewed query", href: "https://example.com/query" },
    { label: "Warehouse source", href: "https://example.com/warehouse" },
  ]);
});

test("warehouse table chips link only when reviewed provenance supplies a safe URL", () => {
  const source = reviewedSource({
    tables: ["analytics.reviewed.daily", {
      name: "analytics.reviewed.cataloged", href: "https://catalog.example.com/tables/cataloged",
    }],
    tableLinks: [{ name: "analytics.reviewed.daily", href: "https://catalog.example.com/tables/daily" }, {
      name: "analytics.reviewed.unsafe", href: "javascript:alert(1)",
    }],
  });
  assert.deepEqual(source.tables, [
    "analytics.reviewed.daily", "analytics.reviewed.cataloged", "analytics.reviewed.unsafe",
  ]);
  assert.deepEqual(source.tableLinks, {
    "analytics.reviewed.daily": "https://catalog.example.com/tables/daily",
    "analytics.reviewed.cataloged": "https://catalog.example.com/tables/cataloged",
  });
});

test("reviewed source trust preserves explicit provider-neutral table and dashboard evidence", () => {
  const source = reviewedSource({
    tables: [{
      name: "analytics.reviewed.daily",
      href: "https://catalog.example.com/tables/daily",
      trust: {
        provider: " Warehouse ", uniqueUsers: 207, queryCount: 8967, windowDays: 30,
        verified: true, popularityScore: 0.98, ownerEmail: "private@example.com",
      },
    }],
    links: [{
      kind: "dashboard", label: "Weekly revenue overview", href: "https://bi.example.com/revenue",
      trust: { provider: "Omni", view_count: 123, favorite_count: 17 },
    }],
  });

  assert.deepEqual(source.tables, ["analytics.reviewed.daily"]);
  assert.deepEqual(source.tableLinks, {
    "analytics.reviewed.daily": "https://catalog.example.com/tables/daily",
  });
  assert.deepEqual(source.tableTrust, {
    "analytics.reviewed.daily": {
      provider: "Warehouse", uniqueUsers: 207, queryCount: 8967, windowDays: 30, verified: true,
    },
  });
  assert.deepEqual(source.links, [{
    href: "https://bi.example.com/revenue", label: "Weekly revenue overview",
    trust: { provider: "Omni", viewCount: 123, favoriteCount: 17 },
    kind: "dashboard",
  }]);
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.reviewed.daily"]),
    ["Warehouse", "207 users", "8,967 queries in last 30 days", "Verified"]);
  assert.deepEqual(sourceTrustLabels(source.links[0].trust), ["Omni", "123 views", "17 favorites"]);
});

test("source trust uses actual execution counts and asset-local metadata", () => {
  const source = reviewedSource({
    trust: { provider: "Must not transfer", queryCount: 999 },
    tables: [{ name: "analytics.reviewed.daily", trust: { provider: "Warehouse", queryCount: 3 } }],
    links: [{ kind: "dashboard", label: "Reviewed asset", href: "https://example.com/report", trust: {
      provider: "Omni", viewCount: 842, windowDays: 28, verified: true,
      editedAt: "2026-08-10T12:00:00.000Z",
    } }],
  });

  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.reviewed.daily"]),
    ["Warehouse", "3 queries"]);
  assert.deepEqual(sourceTrustLabels(source.links[0].trust),
    ["Omni", "842 views in last 28 days", "Verified", "Edited Aug 10"]);
  assert.equal(source.links[0].kind, "dashboard",
    "Explicit reviewed asset types must survive labels and URLs without dashboard keywords");
  assert.equal(Object.hasOwn(source, "trust"), false,
    "Query-level metadata must not be attributed to an unrelated source asset");
  const invalidDate = reviewedSource({ tables: [{ name: "analytics.invalid", trust: {
    provider: "Warehouse", editedAt: "not a date",
  } }] });
  assert.deepEqual(invalidDate.tableTrust["analytics.invalid"], { provider: "Warehouse" },
    "Invalid edit timestamps must not appear as reviewed dashboard metadata");
});

test("table usage retains reviewed zero counts and absolute observation dates without inventing missing values", () => {
  const source = reviewedSource({
    usageAsOf: "2026-09-04T12:00:00Z", queryCount: 99,
    tables: [{ name: "analytics.zero", trust: {
      query_count: 0, unique_users: 0, window_days: 30, usage_as_of: "2026-09-04T12:00Z",
      last_queried_at: "2026-08-01T23:30:00-07:00", usage_note: "  Successful queries including reads through views.  ",
    } }, { name: "analytics.last_only", trust: { lastQueriedAt: "2026-09-03T12:00:00Z" } },
    { name: "analytics.unknown" }],
  });
  assert.deepEqual(source.tableTrust["analytics.zero"], {
    uniqueUsers: 0, queryCount: 0, windowDays: 30, lastQueriedAt: "2026-08-01T23:30:00-07:00",
    usageAsOf: "2026-09-04T12:00Z", usageNote: "Successful queries including reads through views.",
  });
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.zero"]), [
    "0 users", "0 queries over 30 days ending Sep 4, 2026", "Last queried Aug 2, 2026",
  ], "Usage dates are rendered in UTC, including the year, so a snapshot cannot imply current activity");
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.last_only"]), ["Last queried Sep 3, 2026"]);
  assert.equal(source.tableTrust["analytics.unknown"], undefined);
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.unknown"]), []);
  assert.deepEqual(sourceTrustLabels(reviewedSource({ tables: [{ name: "single", trust: {
    queryCount: 1, windowDays: 1, usageAsOf: "2026-09-04T12:00:00Z",
  } }] }).tableTrust.single), ["1 query over 1 day ending Sep 4, 2026"]);
});

test("table usage rejects invalid or ambiguous timestamps and malformed usage notes", () => {
  const invalidTimestamps = [null, 0, {}, "not a date", "2026-09-04", "2026-09-04T12:00:00",
    "2026-02-29T12:00:00Z", "2026-04-31T12:00:00Z", "2026-09-04T24:00:00Z",
    "2026-13-04T12:00:00Z", "2026-09-04T12:00:00+25:00"];
  for (const invalid of invalidTimestamps) {
    const trust = reviewedSource({ tables: [{ name: "reviewed", trust: {
      queryCount: 0, windowDays: 7, lastQueriedAt: invalid, usageAsOf: invalid, usageNote: { text: "Unsupported" },
    } }] }).tableTrust.reviewed;
    assert.deepEqual(trust, { queryCount: 0, windowDays: 7 }, `Invalid timestamp must not survive: ${JSON.stringify(invalid)}`);
    assert.deepEqual(sourceTrustLabels(trust), ["0 queries in last 7 days"]);
  }
  const leapDay = reviewedSource({ tables: [{ name: "reviewed", trust: {
    lastQueriedAt: "2024-02-29T12:00:00.123Z", usageNote: "  ",
  } }] }).tableTrust.reviewed;
  assert.deepEqual(leapDay, { lastQueriedAt: "2024-02-29T12:00:00.123Z" });
  assert.deepEqual(sourceTrustLabels(leapDay), ["Last queried Feb 29, 2024"]);
});

test("source trust rejects invented, malformed, and ambiguous adoption metadata", () => {
  const source = reviewedSource({
    tables: [{ name: "analytics.valid.daily", trust: {
      uniqueUsers: 1, queryCount: 1, windowDays: 1, verified: "true",
    } }, {
      name: "analytics.reviewed.daily",
      trust: {
        uniqueUsers: -1, uniqueViewers: 1.5, queryCount: "8967", viewCount: Infinity,
        favoriteCount: Number.MAX_SAFE_INTEGER + 1, windowDays: 0,
        usage_count: 984, popularity_score: 0.98, verified: "yes",
      },
    }],
  });

  assert.deepEqual(source.tableTrust, {
    "analytics.valid.daily": { uniqueUsers: 1, queryCount: 1, windowDays: 1 },
  });
  assert.deepEqual(sourceTrustLabels(source.tableTrust["analytics.valid.daily"]),
    ["1 user", "1 query in last 1 day"]);
  assert.deepEqual(sourceTrustLabels(null), []);
});

test("duplicate reviewed source entries merge safe links and explicitly supplied trust", () => {
  const source = reviewedSource({
    tables: [{ name: "analytics.reviewed.daily", trust: { unique_viewers: 12, window_days: 7 } }],
    tableLinks: [{ name: "analytics.reviewed.daily", href: "https://catalog.example.com/daily" }],
    href: "https://bi.example.com/dashboard",
    links: [{ href: "https://bi.example.com/dashboard", kind: "dashboard", label: "Reviewed dashboard",
      trust: { uniqueViewers: 24, viewCount: 72, windowDays: 30, verified: true } }],
  });

  assert.deepEqual(source.tableTrust, {
    "analytics.reviewed.daily": { uniqueViewers: 12, windowDays: 7 },
  });
  assert.deepEqual(source.tableLinks, { "analytics.reviewed.daily": "https://catalog.example.com/daily" });
  assert.deepEqual(sourceTrustLabels(source.links[0].trust),
    ["24 viewers", "72 views in last 30 days", "Verified"]);
  assert.equal(source.links[0].trust.verified, true);
  assert.equal(source.links[0].kind, "dashboard");
});

test("source provenance upgrades a repeated raw URL to its descriptive reviewed label", () => {
  assert.deepEqual(reviewedSource({
    href: "https://example.com/query",
    links: [{ label: "Open reviewed warehouse query", href: "https://example.com/query" }],
  }).links, [{ label: "Open reviewed warehouse query", href: "https://example.com/query" }]);
});

test("SQL formatting preserves quoted literals, identifiers, and comments exactly", () => {
  const sql = "SELECT note, `FROM, column` FROM reviewed WHERE note = 'rock AND roll' "
    + "AND category = 'one, two' AND author = 'O''Reilly' /* FROM, OR */ -- WHERE AND, comment\n"
    + "AND status = 'reviewed'";
  const formatted = formatReviewedSql(sql);
  for (const token of ["'rock AND roll'", "'one, two'", "'O''Reilly'", "`FROM, column`",
    "/* FROM, OR */", "-- WHERE AND, comment\n"]) {
    assert.ok(formatted.includes(token), `Formatting changed the reviewed SQL token ${token}`);
  }
  assert.match(formatted, /^SELECT\n  note,\n  /);
  assert.match(formatted, /\nFROM\n  reviewed\nWHERE\n  /);
  assert.equal(formatReviewedSql(""), "No reviewed SQL provided.");
});

test("date filters match complete field tokens rather than unrelated substrings", () => {
  for (const field of ["week", "reporting_week", "eventDate", "created_timestamp"]) {
    assert.equal(isTemporalField(field), true, `${field} should be treated as a reporting dimension`);
  }
  for (const field of ["lifetime_value", "candidate_status", "daylight_savings", "updated_flag"]) {
    assert.equal(isTemporalField(field), false, `${field} is not a date dimension`);
  }
  assert.equal(isTemporalField("recorded_at", "datetime"), true,
    "Explicit date metadata should identify nonstandard reporting fields");
});

test("reviewed periods use the designated reporting field and omit ambiguous date columns", () => {
  const rows = [
    { reporting_week: "2026-07-27", signup_date: "2021-01-04", contract_date: "2030-10-09" },
    { reporting_week: "2026-08-03", signup_date: "2020-02-11", contract_date: "2031-01-02" },
  ];
  const component = { queryId: "usage" };
  for (const options of [
    { component, query: { reportingField: "reporting_week" } },
    { component: { ...component, chart: { x: "reporting_week" } } },
    { component, filters: [{ field: "reporting_week", queryIds: ["usage"] }] },
  ]) {
    const period = reviewedDateRange(rows, options);
    assert.match(period, /2026/);
    assert.doesNotMatch(period, /2020|2021|2030|2031/,
      "Unrelated signup and contract dates cannot become the reviewed reporting period");
  }
  assert.equal(reviewedDateRange(rows, { component }), "",
    "Ambiguous reporting dimensions must not create invented provenance");
  assert.match(reviewedDateRange([{ week: "2026-07-27" }]), /2026/);
});
