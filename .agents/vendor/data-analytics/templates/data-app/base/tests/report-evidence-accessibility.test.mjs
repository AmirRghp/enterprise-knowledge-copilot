import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { normalizeInlineSourcesInput } from "../../../../skills/visualize-data/scripts/inline-sources-input.mjs";

test("shared report evidence exposes useful accessible names without replacing current interactions", async (t) => {
  const server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
    configFile: false, server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
  try {
    const [{ DataTable }, { ChartFrame, collapsedLegendLayout }, { ChartRenderer }, { SourceInspector }, { DataAppContext },
      { DataComponent }, { RichNarrative }, { SourcesReceipt }] = await Promise.all([
      server.ssrLoadModule("/src/components/Controls.jsx"),
      server.ssrLoadModule("/src/charting/ChartFrame.jsx"),
      server.ssrLoadModule("/src/charting/ChartRenderer.jsx"),
      server.ssrLoadModule("/src/components/SourceInspector.jsx"),
      server.ssrLoadModule("/src/DataAppContext.jsx"),
      server.ssrLoadModule("/src/components/DataComponent.jsx"),
      server.ssrLoadModule("/src/components/RichMarkdown.jsx"),
      server.ssrLoadModule("/src/components/SourcesReceipt.jsx"),
    ]);
    const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
    const receiptPanel = (html, id) => html.match(new RegExp(`<section[^>]*id="[^"]*-panel-${id}"[^>]*>([\\s\\S]*?)<\\/section>`, "u"))?.[1] ?? "";

    await t.test("chart-only release projection preserves the ordinary source inspector", async () => {
      const chartServer = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)),
        configFile: false, define: { __DATA_SOURCE_RECEIPTS__: "false" },
        server: { middlewareMode: true, watch: null, hmr: false, ws: false }, appType: "custom" });
      try {
        const { SourceInspector: ChartSourceInspector } = await chartServer.ssrLoadModule("/src/components/SourceInspector.jsx");
        const rows = [{ date: "2026-08-03", requests: 10 }];
        const props = { component: { id: "requests", queryId: "q", title: "Requests",
          chart: { type: "line", x: "date", y: "requests" } },
          query: { rows, source: { label: "Reviewed requests", sql: "SELECT date, requests FROM reviewed" } },
          rows, filters: [], allowCopy: false };
        assert.equal(render(ChartSourceInspector, props), render(SourceInspector, props));
      } finally {
        await chartServer.close();
      }
    });

    await t.test("receipt source chips carry only their own escaped, recorded tooltip role", () => {
      const queries = [{ id: "doc", source: { label: "Document", links: [
        { label: "Release note", href: "https://example.com/releases" },
        { label: "Other note", href: "https://example.com/other" },
      ] }, sourceRoles: [{ kind: "link", label: "Release note", href: "https://example.com/releases",
        role: 'Records <scope> & "timing".' }] }];
      const html = render(SourcesReceipt, { items: [{ id: "finding", title: "Release timing", queries }] });
      assert.match(html, /data-source-title="Release note" data-source-reason="Records &lt;scope&gt; &amp; &quot;timing&quot;\."/u);
      assert.equal((html.match(/data-source-reason=/gu) ?? []).length, 2);
      assert.doesNotMatch(html, /<scope>/u);
    });

    await t.test("receipt file icons use only a recorded filename extension with a generic fallback", () => {
      for (const [label, icon] of [
        ["counts.csv", "file"], ["release.PDF", "document"], ["report.md", "document"],
        ["deck.pptx", "presentation"], ["query.sql", "code"], ["figure.png", "image"],
        ["demo.mp4", "video"], ["interview.wav", "audio"], ["report.pdf draft", "file"],
      ]) {
        const html = render(SourcesReceipt, { items: [{ id: "finding", title: "Recorded file", queries: [{
          id: "file", source: { label: "Sample", files: [{ label }] },
        }] }] });
        assert.match(html, new RegExp(`data-source-kind="file" data-source-icon="${icon}"`, "u"), label);
        assert.match(html, /<span>Sources<\/span>/u);
      }
      const html = render(SourcesReceipt, { items: [{ id: "finding", title: "Source types", queries: [{
        id: "mixed", source: { label: "Mixed", tables: ["demo.weekly"], links: [
          { label: "Dashboard", href: "https://example.com/dashboard", kind: "dashboard" },
          { label: "Reference", href: "https://example.com/reference" },
        ] },
      }] }] });
      for (const kind of ["table", "dashboard", "link"])
        assert.match(html, new RegExp(`data-source-kind="${kind}" data-source-icon="${kind}"`, "u"));
    });

    await t.test("original Sources disclosure text and scoped qualifications", () => {
      const queries = [{ id: "doc", source: { label: "Document", files: [{ label: "release.md" }], caveats: ["Impact not measured."] } }];
      const item = { id: "first", title: "Release date", queries,
        assumptions: ["Release means public availability."] };
      const html = render(SourcesReceipt, { items: [item] });
      const toolbar = html.split('class="receipt-expander"')[0];
      assert.match(toolbar, /<span>Sources<\/span>/u);
      assert.match(toolbar, /aria-expanded="false"/u);
      assert.match(html,
        /Assumptions and caveats[\s\S]*Release means public availability[\s\S]*Impact not measured/u);
      assert.doesNotMatch(html, /receipt-confidence|High confidence|Not assessed/u);
      assert.match(html, /<ul class="receipt-qualification-list"><li>Release means public availability\.<\/li><li>Impact not measured\.<\/li><\/ul>/u);
      assert.equal(receiptPanel(html, "evidence"), "", "A caveat alone does not add an Evidence flow tab");
      const second = { ...item, id: "second", title: "Impact", assumptions: [] };
      const mixed = render(SourcesReceipt, { items: [item, second] });
      assert.match(mixed.split('class="receipt-expander"')[0], /<span>Sources • 2<\/span>/u);
      const cards = [...mixed.matchAll(/<article[\s\S]*?<\/article>/gu)].map(([card]) => card);
      assert.match(cards[0], /Release means public availability/u);
      assert.doesNotMatch(cards[1], /Release means public availability/u);
      assert.match(cards[1], /<ul class="receipt-qualification-list"><li>Impact not measured\.<\/li><\/ul>/u,
        "A single caveat remains a semantic list item");
      assert.doesNotMatch(mixed, /receipt-confidence|Mixed confidence|No causal check/u);
      const supported = structuredClone(item);
      supported.queries[0].source.caveats.push("Only completed cohorts are included.");
      supported.queries.push({ id: "policy", source: { label: "Metric policy", files: [{ label: "policy.md" }] } });
      const qualificationList = (value) => render(SourcesReceipt, { items: [value] })
        .match(/<ul class="receipt-qualification-list">([\s\S]*?)<\/ul>/u)[1];
      assert.doesNotMatch(qualificationList(supported), /receipt-qualification-scope|Document:/u,
        "A supporting source without caveats must not add repetitive attribution to one caveat scope");
      supported.queries[1].source.caveats = ["Policy applies only after launch."];
      assert.doesNotMatch(qualificationList(supported), /receipt-qualification-scope|Document:|Metric policy:/u,
        "Different source scopes never introduce automatic prefixes");
      assert.match(qualificationList(supported), /Impact not measured[\s\S]*Policy applies only after launch/u,
        "Authored caveat sentences are retained verbatim");
      supported.queries[1].source.caveats = ["Impact not measured."];
      assert.match(qualificationList(supported), /<li>Impact not measured\.<\/li>/u);
      assert.match(qualificationList(supported), /<li>Only completed cohorts are included\.<\/li>/u);
      supported.assumptions.push("Impact not measured.");
      assert.equal((qualificationList(supported).match(/Impact not measured\./gu) ?? []).length, 1,
        "Identical authored qualifications appear once even across assumptions and source ownership");
    });

    await t.test("one receipt card shares four tabs without mixing its sources or losing recorded methods", () => {
      const queries = [{ id: "first", source: {
        label: "First source", files: [{ label: "first.csv" }], sql: "SELECT first_value FROM first_table;",
        caveats: ["Only the first cohort."], evidenceFlow: [{ title: "First recorded step", detail: "First source detail." }],
      }, summary: "First source scope.", capturedAt: "2026-08-26T17:00:00Z", reportingPeriod: "First period", rows: [{ first_value: 123 }],
      methods: [{ language: "calculation", code: "123 / 456" }] }, {
        id: "second", source: { label: "Second source", files: [{ label: "second.csv" }],
          sql: "SELECT second_value FROM second_table;", caveats: ["Only the second cohort."] },
        summary: "Second source scope.", capturedAt: "2026-08-26T17:01:00Z", reportingPeriod: "Second period", rows: [{ second_value: 789 }],
        methods: [{ language: "python", code: "\nresult = second_value / denominator\n" }],
      }];
      const html = render(SourcesReceipt, { items: [{ id: "finding", title: "A supported finding", queries }] });
      assert.equal((html.match(/<article /gu) ?? []).length, 1);
      assert.equal((html.match(/role="tablist"/gu) ?? []).length, 1);
      assert.equal((html.match(/role="tab"/gu) ?? []).length, 4);
      assert.equal((html.match(/role="tabpanel"/gu) ?? []).length, 4);
      assert.doesNotMatch(html, /role="combobox"|Source for |receipt-query-picker/u);
      assert.equal((html.match(/<table /gu) ?? []).length, 2, "The two result tables; no duplicate source table without a rationale");
      const sections = [...html.matchAll(/<section class="receipt-source-section" aria-label="([^"]+)">([\s\S]*?)<\/section>/gu)];
      assert.equal(sections.length, 4, "Only the two distinct tables and queries need source-specific sections");
      for (const [, label, body] of sections) {
        const text = body.replace(/<[^>]+>/gu, "");
        if (label === "First source") assert.doesNotMatch(text, /Second source|second_value|second_table|789/u);
        else assert.doesNotMatch(text, /First source|first_value|first_table|123/u);
      }
      assert.equal((html.match(/123 \/ 456/gu) ?? []).length, 1, "Worked arithmetic appears only in its evidence step");
      assert.doesNotMatch(html, /receipt-attribution| · First source| · Second source/u,
        "Explanatory content must not repeat source-name annotations");
      assert.equal((html.match(/>Sources<\/p>/gu) ?? []).length, 1);
      assert.equal((html.match(/>Assumptions and caveats<\/p>/gu) ?? []).length, 1);
      assert.equal((html.match(/>Filters<\/p>/gu) ?? []).length, 0, "Reporting periods do not create an empty Filters section");
      assert.doesNotMatch(html, /What this supports/u);
      assert.equal((html.match(/<ol class="source-trace"/gu) ?? []).length, 1, "The finding has one evidence flow");
      assert.match(html, /<details[^>]*>[\s\S]*Python[\s\S]*<code>\nresult = second_value \/ denominator\n<\/code>/u);
      assert.match(html, /First period/u);
      assert.match(html, /Second period/u);
      assert.match(html, /Only the first cohort/u);
      assert.match(html, /Only the second cohort/u);
      queries.forEach((query) => { query.source.label = "Shared warehouse"; });
      const sameSource = render(SourcesReceipt, { items: [{ id: "finding", title: "Separate query cuts", queries }] });
      for (const id of ["first", "second"]) {
        assert.equal((sameSource.match(new RegExp(`aria-label="Shared warehouse · ${id}"`, "gu")) ?? []).length, 2,
          "Tables and SQL are separately named even when the source identity is shared");
        assert.match(sameSource, new RegExp(`<h3 class="receipt-source-heading">Shared warehouse · ${id}</h3>`, "u"));
      }
    });

    await t.test("receipt Overview renders one shared definition and formula while preserving the full method in Evidence flow", () => {
      const source = { label: "Weekly counts", files: [{ label: "weekly.csv" }], filters: ["Plan: all"],
        metricDefinitions: [{ label: "Activation rate", definition: "Activation rate is the share that completed setup.", formula: "activated / eligible" }],
        caveats: ["Illustrative inputs."] };
      const queries = [{ id: "first", source, reportingPeriod: "August 2026", rows: [{ activated: 240, eligible: 400 }],
        methods: [{ language: "calculation", code: "240 / 400 = 60%" }] }, {
        id: "second", source: { ...source, label: "Cross-check" }, reportingPeriod: "August 2026", rows: [{ activated: 240, eligible: 400 }],
      }];
      const html = render(SourcesReceipt, { items: [{ id: "finding", title: "Activation", queries }] });
      assert.equal((html.match(/class="receipt-definitions"/gu) ?? []).length, 1);
      assert.match(html, /<ul class="receipt-definition-list"><li class="receipt-definition-entry">/u,
        "Definition entries are a semantic list");
      assert.equal((html.match(/activated \/ eligible/gu) ?? []).length, 1, "A formula already in Overview is not repeated in Calculation");
      assert.equal((html.match(/data-source-title="weekly.csv"/gu) ?? []).length, 1, "Do not repeat a source without additional selection rationale");
      assert.equal((html.match(/Illustrative inputs\./gu) ?? []).length, 1);
      assert.equal((html.match(/Plan = all/gu) ?? []).length, 1);
      assert.doesNotMatch(html, /receipt-periods/u);
      const primary = receiptPanel(html, "overview");
      const secondary = receiptPanel(html, "evidence");
      assert.match(primary, /<strong>Activation rate<\/strong> is the share/u);
      assert.match(primary, /Assumptions and caveats[\s\S]*Illustrative inputs/u);
      assert.doesNotMatch(primary, /receipt-filters|receipt-details|Snapshot captured/u);
      assert.ok(secondary, "Supporting metadata lives in Evidence flow, not an Overview disclosure");
      assert.match(secondary, /Plan = all/u);
      assert.doesNotMatch(secondary, /Illustrative inputs/u);
      assert.match(secondary, /Filters and reporting period[\s\S]*August 2026/u);
      assert.equal((secondary.match(/data-checkpoint=/gu) ?? []).length, 2);
      assert.doesNotMatch(html, /receipt-details|class="receipt-filter"|data-tooltip-text=/u, "Readable filters need no Overview disclosure or truncated pills");
      source.metricDefinitions[0].calculationSummary = "Divide activated by eligible accounts for August 2026.";
      const scoped = structuredClone(queries);
      scoped[1].source.metricDefinitions = structuredClone(scoped[1].source.metricDefinitions);
      scoped[1].source.metricDefinitions[0].calculationSummary = "Divide activated by eligible accounts for July 2026.";
      scoped[1].reportingPeriod = "July 2026";
      const withSubtitles = render(SourcesReceipt, { items: [{ id: "finding", title: "Activation", queries: scoped }] });
      const subtitleOverview = receiptPanel(withSubtitles, "overview");
      assert.equal((subtitleOverview.match(/class="receipt-definition-entry"/gu) ?? []).length, 2,
        "Equal definitions with different calculation windows must keep separate ownership");
      assert.match(subtitleOverview, /receipt-definition-method">Divide activated by eligible accounts for August 2026/u);
      assert.match(subtitleOverview, /receipt-definition-method">Divide activated by eligible accounts for July 2026/u);
      assert.doesNotMatch(subtitleOverview, /Weekly counts|Cross-check|receipt-attribution/u);
      assert.doesNotMatch(receiptPanel(withSubtitles, "evidence"), /Divide activated by eligible accounts for/u);
      assert.match(receiptPanel(withSubtitles, "evidence"), /receipt-calculation-text">activated \/ eligible/u);
      assert.doesNotMatch(subtitleOverview, /source-definition-formula|receipt-periods/u,
        "The receipt prefers the calculation subtitle over the formula and has no loose reporting period");
      assert.doesNotMatch(secondary, /receipt-trace-section-label">Calculation|data-checkpoint="definition"|Share that completed/u);
      assert.match(html, /<p class="receipt-calculation-text">240 \/ 400 = 60%<\/p>/u);
    });

    await t.test("filters form one wrapping group and distinguish only genuinely different periods or values", () => {
      const queries = [{ id: "first", source: { label: "First query", filters: [
        "Plan: all", "product: codex", "feature: Codex", "Reporting period: August 2026",
      ] }, reportingPeriod: "August 2026" }, {
        id: "second", source: { label: "Second query", filters: ["Plan: all", "request_country: ALL", "product: other"] },
        reportingPeriod: "September 2026",
      }];
      const html = render(SourcesReceipt, { items: [{ id: "filters", title: "Filter scope", queries }] });
      const panel = receiptPanel(html, "evidence").match(/<li[^>]*data-checkpoint="filter">([\s\S]*?)<\/li>/u)[1];
      const pills = [...panel.matchAll(/<code class="receipt-trace-chip">([^<]*)<\/code>/gu)].map((match) => match[1]);
      assert.deepEqual(pills, ["First query: Reporting period = August 2026", "Second query: Reporting period = September 2026",
        "Plan = all", "First query: product = codex", "First query: feature = Codex", "Second query: request_country = ALL", "Second query: product = other"]);
      assert.equal((panel.match(/class="receipt-trace-chip"/gu) ?? []).length, pills.length,
        "No pill contains attribution markup or a differently styled child");
      assert.equal((panel.match(/class="receipt-trace-chips"/gu) ?? []).length, 1, "No unexplained per-source gaps");
      assert.doesNotMatch(panel, /query: Plan/u, "Only shared filters can omit scope in consolidated evidence");
      assert.doesNotMatch(panel, /<p[^>]*>Reporting period|<p[^>]*>August 2026|receipt-attribution/u);
      queries[1].reportingPeriod = "August 2026";
      queries[1].source.filters.pop();
      const shared = receiptPanel(render(SourcesReceipt, { items: [{ id: "filters", title: "Filter scope", queries }] }), "evidence");
      assert.equal((shared.match(/Reporting period = August 2026/gu) ?? []).length, 1,
        "Deduplicate the same period even when one query also repeats it in its filters");
      assert.doesNotMatch(shared, /query: Reporting period/u);
      queries[1].source.filters = ["request_country: ALL"];
      const absent = receiptPanel(render(SourcesReceipt, { items: [{ id: "filters", title: "Filter scope", queries }] }), "evidence");
      assert.match(absent, />First query: Plan = all<\/code>/u,
        "A filter absent from another query must not appear shared even without a conflicting value");
      queries[0].source.sql = "SELECT first_value FROM first_table;";
      queries[1].source.sql = "SELECT second_value FROM second_table;";
      const withSql = render(SourcesReceipt, { items: [{ id: "filters", title: "Filter scope", queries }] });
      assert.equal((withSql.match(/Reporting period = August 2026/gu) ?? []).length, 1,
        "A shared period must not reappear beside SQL when repeated in one query's filter metadata");
      assert.match(receiptPanel(withSql, "evidence"), />First query: Plan = all<\/code>/u,
        "SQL presence does not establish that an authored filter is represented in the query");
      assert.match(receiptPanel(withSql, "evidence"), />Second query: request_country = ALL<\/code>/u);
      const firstSql = withSql.match(/aria-label="First query">([\s\S]*?)<\/section>/u)[1];
      const secondSql = withSql.match(/aria-label="Second query">([\s\S]*?)<\/section>/u)[1];
      assert.doesNotMatch(firstSql + secondSql, /receipt-trace-chip|Plan = all|request_country = ALL/u,
        "The SQL tab shows each labeled query without duplicating filter pills");
      assert.match(firstSql, /first_value/u);
      assert.match(secondSql, /second_value/u);
      delete queries[1].source.sql;
      const mixed = render(SourcesReceipt, { items: [{ id: "filters", title: "Filter scope", queries }] });
      assert.match(receiptPanel(mixed, "sql"), /receipt-source-heading">First query<\/h3>/u,
        "A lone SQL query still needs its heading when another source has different filters");
      assert.doesNotMatch(receiptPanel(mixed, "sql"), /receipt-trace-chip/u);
      assert.match(receiptPanel(mixed, "evidence"), />Second query: request_country = ALL<\/code>/u,
        "A source without SQL keeps its explicitly scoped filters in Evidence flow");
      const extraScopeQueries = [
        { id: "a", source: { label: "Query A", filters: ["Plan: paid"], sql: "SELECT 1;" } },
        { id: "b", source: { label: "Query B", sql: "SELECT 2;" } },
      ];
      const extraScope = render(SourcesReceipt, { items: [{ id: "filters", title: "Query scope", queries: extraScopeQueries }] });
      assert.match(receiptPanel(extraScope, "evidence"), />Query A: Plan = paid<\/code>/u,
        "Extra recorded scope cannot disappear merely because SQL exists");
      delete extraScopeQueries[0].source.filters;
      const sqlOnly = render(SourcesReceipt, { items: [{ id: "filters", title: "Query scope", queries: extraScopeQueries }] });
      assert.doesNotMatch(sqlOnly, />Evidence flow<|data-checkpoint="filter"/u,
        "SQL alone creates no empty Evidence tab or synthetic filter list");
    });

    await t.test("definitions remain sentences and supporting context moves to Evidence flow", () => {
      const source = { label: "Metric reference", metricDefinitions: [{ label: "Active users", definition: "People active in the last seven days." }] };
      const queries = [{ id: "definition", source, summary: "Additional scope context.", capturedAt: "2026-08-26T17:00:00Z" }];
      const html = render(SourcesReceipt, { items: [{ id: "finding", title: "Weekly activity", queries }] });
      const primary = receiptPanel(html, "overview");
      const secondary = receiptPanel(html, "evidence");
      assert.match(primary, /People active in the last seven days/u);
      assert.doesNotMatch(primary, /<strong>Active users<\/strong>:/u, "The renderer must not prepend a label-colon fallback");
      assert.doesNotMatch(primary, /Additional scope context|Snapshot captured/u);
      assert.match(secondary, /Additional scope context/u);
      assert.doesNotMatch(secondary, /Snapshot captured|Recorded snapshots|data-checkpoint="source"/u);
      assert.doesNotMatch(secondary, /data-checkpoint="result"|data-checkpoint="calculation"|Passed|Verified/u, "A snapshot creates no calculation or verification claim");
      const thin = render(SourcesReceipt, { items: [{ id: "finding", title: "Weekly activity", queries: [{ id: "definition", source }] }] });
      assert.doesNotMatch(thin, /receipt-details|role="tab/u);
      const auditOnly = render(SourcesReceipt, { items: [{ id: "finding", title: "Weekly activity", queries: [{
        id: "definition", capturedAt: "2026-08-26T17:00:00Z", source: { ...source, evidenceFlow: [
          { kind: "source", title: "Read rows", detail: "Query completed without truncation.", showInReceipt: false },
        ] },
      }] }] });
      assert.doesNotMatch(auditOnly, /role="tab|Read rows|Query completed|Snapshot captured/u,
        "Routine audit metadata creates neither prose nor an empty Evidence tab");
      const material = render(SourcesReceipt, { items: [{ id: "finding", title: "Weekly activity", queries: [{
        id: "definition", source: { ...source, evidenceFlow: [
          { kind: "source", title: "Incomplete source", detail: "A required source was unavailable." },
        ] },
      }] }] });
      assert.match(receiptPanel(material, "evidence"), /A required source was unavailable/u,
        "Material source problems remain visible by default");
    });

    await t.test("document-backed receipts separate recorded limitations without inventing methods or data", () => {
      const queries = [{ id: "document", summary: "The note records the release date, not its impact.",
        source: { label: "Supplied release note", files: [{ label: "release-note.md" }],
          caveats: ["No causal effect was measured."] } }];
      const html = render(SourcesReceipt, { items: [{ id: "release", title: "What changed?", queries }] });
      assert.equal((html.match(/role="tab"/gu) ?? []).length, 0);
      assert.doesNotMatch(html, /What this supports|receipt-details/u);
      assert.match(html, /The note records the release date, not its impact/u);
      assert.match(html, /No causal effect was measured/u);
      assert.match(html, /release-note\.md/u);
      assert.match(html, /class="source-section receipt-overview"[\s\S]*The note records the release date/u);
      assert.match(html, /Assumptions and caveats[\s\S]*No causal effect/u);
      assert.equal(receiptPanel(html, "evidence"), "");
      assert.doesNotMatch(html, /Data preview|SQL query|Query executed|Snapshot captured|data-checkpoint="calculation"/u);
      const multiple = render(SourcesReceipt, { items: [{ id: "release", title: "What changed?", queries },
        { id: "other", title: "A separate finding", queries }] });
      assert.equal((multiple.match(/role="tab"/gu) ?? []).length, 0);
      assert.doesNotMatch(multiple, /What this supports|receipt-details/u);
      assert.match(multiple, /class="receipt-card-toggle" aria-label="What changed\?"[^>]*aria-expanded="false" aria-controls="receipt-card-/u);
      assert.equal((multiple.match(/class="receipt-card-toggle"/gu) ?? []).length, 2,
        "Each card owns one persistent native toggle");
      assert.doesNotMatch(multiple, /class="receipt-card-collapse"|class="receipt-card-toggle" hidden/u,
        "The expanded toolbar reserves space instead of mounting a replacement chevron");
    });

    await t.test("collapsed legends fit two measured rows and omit partial third rows", () => {
      assert.deepEqual(collapsedLegendLayout([]), { height: 0, visibleCount: 0 });
      assert.deepEqual(collapsedLegendLayout([0, 0, 20, 20, 20, 40].map(offsetTop => ({ offsetTop, offsetHeight: 20 }))),
        { height: 40, visibleCount: 5 });
      assert.deepEqual(collapsedLegendLayout([0, 28, 56, 84].map(offsetTop => ({ offsetTop, offsetHeight: 24 }))),
        { height: 52, visibleCount: 2 });
    });

    await t.test("multi-source narrative keeps header controls but suppresses stale actions during loading", () => {
      const queries = { current: { rows: [{ count: 3 }] }, prior: { rows: [{ count: 2 }] } };
      const context = { snapshot: { surface: "report" }, queries, canEdit: false, mode: "view", narrativeEdits: {} };
      const props = { id: "summary", title: "Summary", queryId: "current", queryIds: ["current", "prior"],
        sourceRowsByQuery: { current: queries.current.rows, prior: queries.prior.rows }, kind: "custom", showHeading: false,
        headerControls: React.createElement("button", { type: "button" }, "Period"), loadingHeight: 200 };
      const renderState = loading => renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: context },
        React.createElement(DataComponent, { ...props, loading }, React.createElement(RichNarrative, { id: "summary-text", value: "## Authored heading\n\nEvidence." }))));
      const loaded = renderState(false), pending = renderState(true);
      assert.match(loaded, /data-query-ids="current prior"/u);
      assert.match(loaded, /Authored heading/u);
      assert.doesNotMatch(loaded, /class="component-title"/u);
      assert.match(pending, /aria-busy="true"/u);
      assert.match(pending, />Period<\/button>/u);
      assert.doesNotMatch(pending, /Summary actions|Authored heading/u);
    });

    await t.test("legacy report heading merging only rewrites RichNarrative children", () => {
      const shell = { snapshot: { surface: "report" }, queries: { reviewed: { rows: [] } },
        canEdit: false, mode: "view", narrativeEdits: {}, setNarrativeEdit() {} };
      const report = (...children) => renderToStaticMarkup(React.createElement(DataAppContext.Provider,
        { value: shell }, React.createElement(DataComponent,
          { id: "legacy-report", title: "Reviewed finding", queryId: "reviewed", kind: "custom", showActions: false },
          ...children)));
      function StructuralValue({ id, value }) {
        return React.createElement("output", { id }, value);
      }
      const structural = React.createElement(StructuralValue, { id: "status", value: "Ready" });
      const input = React.createElement("input", { id: "response", value: "Unchanged", readOnly: true });
      const html = report(structural, input);
      assert.match(html, /<output id="status">Ready<\/output>/u);
      assert.match(report(input), /<input id="response"[^>]*value="Unchanged"\/>/u);
      assert.match(html, /<h2 class="component-title">/u, "Structural children keep the component heading");

      const narrative = React.createElement(RichNarrative, { id: "finding:body", value: "Reviewed evidence." });
      const merged = report(structural, narrative);
      assert.match(merged, /<output id="status">Ready<\/output>/u);
      assert.doesNotMatch(merged, /class="component-title"/u);
      assert.equal((merged.match(/<h2>/gu) ?? []).length, 1, "The real narrative owns the single legacy heading");
      assert.match(merged, /<h2>Reviewed finding<\/h2>/u);
      assert.match(merged, /<p>Reviewed evidence\.<\/p>/u);
    });

    await t.test("source inspection retains funnel definitions for cosmetic edits but not a replacement measure", async () => {
      const snapshot = JSON.parse(await readFile(new URL("../src/data.json", import.meta.url), "utf8"));
      const query = snapshot.queries.activation_journey;
      assert.ok(query, "Use the starter's reviewed activation journey");
      const chart = { type: "funnel", x: "stage", y: "accounts" };
      const component = { id: "activation-funnel", queryId: "activation_journey", kind: "chart",
        title: "Account activation journey", chart };
      const inspect = (override) => renderToStaticMarkup(React.createElement(DataAppContext.Provider,
        { value: { chartOverrides: override ? { [component.id]: override } : {} } },
        React.createElement(SourceInspector, { component: { ...component, chart: override ?? chart },
          query, rows: query.rows, filters: [] })));
      for (const override of [undefined, { ...chart, colors: { accounts: "purple" } },
        { ...chart, showValues: false }]) {
        const html = inspect(override);
        for (const { label, definition } of query.source.metricDefinitions) {
          assert.ok(html.includes(label), `Keep ${label} after a cosmetic chart edit`);
          assert.ok(html.includes(definition), `Keep the reviewed meaning of ${label}`);
        }
      }
      const replaced = inspect({ ...chart, y: "revenue", colors: { revenue: "purple" } });
      for (const { label, definition } of query.source.metricDefinitions) {
        assert.ok(!replaced.includes(label), `Do not attribute ${label} to a replacement measure`);
        assert.ok(!replaced.includes(definition), "An unknown measure must not inherit stale funnel methodology");
      }
    });

    await t.test("source execution metadata never falls back to report preparation time", async () => {
      const executedAt = "2026-08-17T12:00:00Z";
      const formatted = new Intl.DateTimeFormat(undefined, { day: "numeric", hour: "numeric",
        minute: "2-digit", month: "short", year: "numeric" }).format(new Date(executedAt));
      const props = {
        component: { id: "evidence", title: "Reviewed evidence", kind: "table", queryId: "reviewed" },
        rows: [{ date: "2026-08-01", count: 12 }], filters: [], generatedAt: "2040-01-01T00:00:00Z",
      };
      const metadata = (source) => {
        const html = render(SourceInspector, { ...props, query: { rows: props.rows, source } });
        assert.equal((html.match(/role="tab"/gu) ?? []).length, source.sql ? 3 : 2, "Only recorded evidence has a tab");
        for (const label of ["Overview", "Data preview"]) {
          assert.ok(html.includes(label), `Keep the available ${label} tab`);
        }
        assert.equal(html.includes("SQL query"), Boolean(source.sql));
        assert.doesNotMatch(html, /Evidence flow/u);
        return html.match(/<dl class="source-metadata">([\s\S]*?)<\/dl>/u)?.[1];
      };
      for (const source of [{}, { retrievedAt: executedAt }]) {
        const html = metadata(source);
        assert.match(html, /<dt>Reporting period<\/dt>/u);
        assert.doesNotMatch(html, /Query executed|Last updated|2040/u,
          "Missing execution metadata must not acquire preparation or retrieval timestamps");
      }
      for (const source of [{ executedAt }, { executed_at: executedAt }, { query: { executed_at: executedAt } }]) {
        const html = metadata(source);
        assert.match(html, /<dt>Source captured<\/dt>/u);
        assert.ok(html.includes(`<dd>${formatted}</dd>`), "Explicit execution aliases preserve the recorded timestamp");
        assert.doesNotMatch(html, /Last updated|2040/u);
      }
      const inspector = await readFile(new URL("../src/components/SourceInspector.jsx", import.meta.url), "utf8");
      assert.doesNotMatch(inspector, /generatedAt/u, "Synthesized evidence must not use report preparation time either");
      assert.match(metadata({ executedAt, sql: "SELECT value FROM reviewed" }), /<dt>Query executed<\/dt>/u);
    });

    await t.test("native tables have captions, scoped sortable headers, and an overflow region", async () => {
      const html = render(DataTable, { rows: [{ count: 1000, status: "Ready" }], caption: "Reviewed evidence",
        columns: [{ field: "count", label: "Accounts" }, { field: "status", presentation: "status" }] });
      assert.match(html, /role="region" aria-label="Reviewed evidence table"/u);
      assert.match(html, /<caption class="visually-hidden">Reviewed evidence<\/caption>/u);
      assert.equal((html.match(/scope="col" aria-sort="none"/gu) ?? []).length, 2);
      assert.match(html, />Accounts<\/button>/u, "Current authored column labels survive");
      assert.match(html, /table-cell-status/u, "Current table presentations survive");
      assert.match(render(DataTable, { rows: [], label: "Explicit label", searchable: false }),
        /<caption class="visually-hidden">Explicit label<\/caption>/u);
      assert.match(render(DataTable, { rows: [], searchable: false }),
        /<caption class="visually-hidden">Reviewed data<\/caption>/u);
      const rows = Array.from({ length: 117 }, (_, value) => ({ value }));
      const defaultPage = render(DataTable, { rows, searchable: false });
      assert.equal(defaultPage.match(/<tbody>(.*?)<\/tbody>/su)[1].match(/<tr>/gu).length, 8,
        "Existing app tables keep their eight-row pages");
      const receiptPage = render(DataTable, { rows, searchable: false, pageSize: 50, paginationStyle: "receipt" });
      assert.equal(receiptPage.match(/<tbody>(.*?)<\/tbody>/su)[1].match(/<tr>/gu).length, 50);
      assert.match(receiptPage, /role="status" aria-live="polite"/u);
    });

    await t.test("receipt previews preserve year values, column labels, units, and numeric measures", () => {
      const input = { schemaVersion: 1, items: [{ id: "annual-change", title: "Annual change", queries: [{
        id: "annual-comparison", source: { label: "Recorded annual values" },
        columns: ["year", { field: "annual_anomaly_c", label: "Annual anomaly (°C)" }, "count"],
        rows: [{ year: 2024, annual_anomaly_c: 1.28, count: 2024 },
          { year: 2025, annual_anomaly_c: 1.19, count: 2025 }],
      }] }] };
      const normalized = normalizeInlineSourcesInput(input);
      const html = render(SourcesReceipt, { items: normalized.items });
      assert.match(html, /<th scope="col" aria-sort="none"><button type="button">Year<\/button>/u);
      assert.match(html, /<th[^>]*class="numeric"><button type="button">Annual anomaly \(°C\)<\/button>/u);
      assert.match(html, /<td>2024<\/td><td class="numeric">1\.28<\/td><td class="numeric">2,024<\/td>/u);
      assert.match(html, /<td>2025<\/td><td class="numeric">1\.19<\/td><td class="numeric">2,025<\/td>/u);
      for (const compactNumbers of [true, false]) {
        const table = render(DataTable, { compactNumbers, rows: [{ fiscalYear: 2025, year_over_year_change: 2025 }] });
        assert.match(table, /<td>2025<\/td><td class="numeric">/u,
          "Calendar years stay literal and left aligned without changing year-over-year measures");
      }
      normalized.items[0].queries[0].rows = [];
      assert.match(render(SourcesReceipt, { items: normalized.items }), /Annual anomaly \(°C\)/u,
        "Recorded empty results still retain their approved column labels");
    });

    await t.test("chart frames are named groups that preserve interactive SVG descendants", () => {
      const html = render(ChartFrame, { accessibleLabel: "Observed and modeled accounts",
        chart: React.createElement("svg", { role: "application" }),
        legend: [{ label: "Observed", value: "observed", color: "blue" }], onLegendToggle() {} });
      assert.match(html, /class="chart-frame"[^>]*role="group" aria-label="Observed and modeled accounts"/u);
      assert.doesNotMatch(html, /class="chart-frame"[^>]*role="img"/u,
        "An outer image role would flatten Recharts keyboard-accessible descendants");
      assert.match(html, /aria-label="Toggle Observed"/u);
      const chart = { type: "line", x: "week", y: "activeUsers" };
      const rows = [{ week: "2026-08-03", activeUsers: 10 }, { week: "2026-08-10", activeUsers: 12 }];
      assert.match(render(ChartRenderer, { spec: chart, rows }), /aria-label="Active Users by Week"/u);
      assert.match(render(ChartRenderer, { spec: chart, rows, accessibleLabel: "Reviewed account trend" }),
        /aria-label="Reviewed account trend"/u);
    });

    await t.test("custom table cells receive raw evidence without replacing keyboard row actions", () => {
      const row = { workspace: "Example team", events: 0, eligible: false };
      let received;
      const html = render(DataTable, { rows: [row], searchable: false, onRowSelect() {}, rowActionLabel: () => "Inspect workspace",
        columns: [{ field: "workspace" }, { field: "events", renderCell: (value, source) => {
          received = [value, source];
          return React.createElement("button", { type: "button" }, source.eligible ? `${value} events` : "Not included");
        } }] });
      assert.deepEqual(received, [0, row]);
      assert.match(html, /aria-label="Inspect workspace"/u);
      assert.match(html, /<button type="button">Not included<\/button>/u);
      assert.equal((html.match(/<td/g) ?? []).length, 2);

      const paged = render(DataTable, { rows: [row, { ...row, workspace: "Second team" }],
        searchable: false, pageSize: 1, rowKey: "workspace", selectedRowKey: row.workspace,
        onRowSelect() {}, rowActionLabel: item => `Inspect ${item.workspace}`,
        columns: [{ field: "workspace" }, { field: "events" }] });
      assert.equal((paged.match(/data-row-action="true"/gu) ?? []).length, 1);
      assert.match(paged, /data-selected="true"/u);
      assert.match(paged, /aria-label="Inspect Example team"/u);
      assert.match(paged, /1–1 of 2 results/u);

      for (const definition of [
        {field:"workspace",presentation:"identity",secondaryField:"plan"},
        {field:"workspace",presentation:"status"},
        {field:"workspace",renderCell:()=>React.createElement("a",{href:"#record"},"Open source record")},
      ]) {
        const rich = render(DataTable,{rows:[{...row,plan:"Enterprise"}],searchable:false,
          columns:[definition],onRowSelect() {},rowActionLabel:()=>"Inspect workspace"});
        assert.match(rich,/aria-label="Inspect workspace"/u);
        if (definition.presentation === "identity") assert.match(rich,/<strong>Example team<\/strong><span>Enterprise<\/span>/u);
        if (definition.presentation === "status") assert.match(rich,/class="table-status"/u);
        if (definition.renderCell) {
          assert.match(rich,/<a href="#record">Open source record<\/a>/u);
          const cell = rich.match(/<td\b[^>]*>([\s\S]*?)<\/td>/u)[1];
          assert.doesNotMatch(cell,/<button[^>]*>[\s\S]*?<a /u,"Custom links must not be nested in row-action buttons");
        }
      }
    });

    await t.test("table delta tones use row evidence without changing signs or legacy defaults", () => {
      const rows = [
        { metric: "Adoption", change: "+12.34%", tone: "positive" },
        { metric: "Reach", change: "+0.0007%", tone: "neutral" },
        { metric: "Lower cost", change: "−4.25%", tone: "positive" },
        { metric: "More errors", change: "+8.12%", tone: "negative" },
        { metric: "Unknown", change: "+1.00%", tone: "invalid" },
      ];
      const before = JSON.stringify(rows);
      for (const signedDeltas of [false, true]) {
        const html = render(DataTable, { rows, signedDeltas, searchable: false,
          columns: [{ field: "metric" }, { field: "change", deltaTone: (value, row) => {
            assert.equal(value, row.change);
            return row.tone;
          } }] });
        const cells = [...html.matchAll(/data-delta="([^"]+)">([^<]+)<\/td>/gu)]
          .map(([, tone, value]) => ({ tone, value }));
        assert.deepEqual(cells, rows.map(({ change, tone }) => ({
          tone: tone === "invalid" ? "neutral" : tone, value: change,
        })));
      }
      assert.equal(JSON.stringify(rows), before, "Presentation must not mutate reviewed rows");
      const renderTone = (deltaTone) => render(DataTable, { rows: [{ change: 3 }],
        signedDeltas: true, columns: [{ field: "change", deltaTone }] });
      assert.match(renderTone(undefined), /data-delta="positive">\+3<\/td>/u);
      assert.match(renderTone("negative"), /data-delta="negative">\+3<\/td>/u);
      for (const tone of ["neutral", null, false, "invalid", () => undefined,
        () => { throw new Error("Invalid authored color rule"); }]) {
        assert.match(renderTone(tone), /data-delta="neutral">\+3<\/td>/u);
      }
      assert.doesNotMatch(render(DataTable, { rows: [{ change: 3 }] }), /data-delta/u);
      assert.match(render(DataTable, { rows: [{ change: -3 }], signedDeltas: true }),
        /data-delta="negative">-3<\/td>/u);
    });
  } finally {
    await server.close();
  }
});
