import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const templateRoot = fileURLToPath(new URL("../", import.meta.url));
let components;
let server;

before(async () => {
  server = await createServer({
    root: templateRoot,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  components = await server.ssrLoadModule("/src/components/Controls.jsx");
});

after(async () => {
  await server?.close();
});

test("evidence charts share edited specs and persistent interactions without taking over custom content", async () => {
  const { EvidenceChart } = await server.ssrLoadModule("/src/components/EvidenceChart.jsx");
  const { DataAppContext } = await server.ssrLoadModule("/src/DataAppContext.jsx");
  const rows = [{ week: "2026-08-03", users: 12 }], sourceRows = [{ ...rows[0], plan: "Plus" }];
  const spec = { type: "line", x: "week", y: "users" };
  const edited = { ...spec, type: "bar", beginning: 20, ending: 32 };
  let dataInputs = { beginning: 100, ending: 112 };
  const onZoomChange = () => {}, onVisibleSeriesChange = () => {}, getMarkActions = () => [];
  let renderedPlot, effectiveChart, actionComponent;
  const shell = { snapshot: {}, chartOverrides: { adoption: edited }, visible: () => true,
    chartProps: id => ({ chartId: id, zoomRange: { start: 0, end: 0 }, visibleSeries: ["users"], onZoomChange, onVisibleSeriesChange }),
    componentActions: { additionalActions: component => { actionComponent = component; return null; } } };
  const render = () => renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: shell },
    React.createElement(EvidenceChart, { id: "adoption", queryId: "usage", title: "Adoption", variant: "card",
      spec: shell.chartOverrides.adoption ?? spec, dataInputs, rows, sourceRows, height: 176,
      headerControls: React.createElement("button", null, "Plan"),
      chartOptions: { getMarkActions, chartId: "wrong", spec: {}, rows: [], onZoomChange: () => {} },
      renderPlot: (plot, chart) => { renderedPlot = plot; effectiveChart = chart; return React.createElement("div", { className: "custom-plot" }, plot); },
    }, React.createElement("button", null, "Inspect selection"))));
  const html = render();
  assert.deepEqual(effectiveChart, { ...edited, ...dataInputs });
  assert.deepEqual(actionComponent.chart, effectiveChart, "Chart actions must receive the plotted spec and current data inputs");
  assert.equal(renderedPlot.props.spec, effectiveChart);
  assert.equal(renderedPlot.props.rows, rows);
  assert.equal(renderedPlot.props.chartId, "adoption");
  assert.equal(renderedPlot.props.height, 176);
  assert.equal(renderedPlot.props.onZoomChange, onZoomChange);
  assert.equal(renderedPlot.props.onVisibleSeriesChange, onVisibleSeriesChange);
  assert.equal(renderedPlot.props.getMarkActions, getMarkActions);
  assert.match(html, /data-component-id="adoption"/u);
  assert.match(html, /View data source|Adoption actions/u);
  assert.match(html, /custom-plot/u);
  assert.match(html, /Inspect selection/u);
  assert.equal(sourceRows[0].plan, "Plus");
  shell.chartOverrides = { adoption: JSON.parse(JSON.stringify(actionComponent.chart)) };
  dataInputs = undefined;
  render();
  assert.deepEqual(effectiveChart, { ...edited, beginning: 100, ending: 112 },
    "Legacy callers selecting the saved spec retain reviewed totals after serialization");
  assert.deepEqual(actionComponent.chart, effectiveChart);
  dataInputs = { beginning: 0, ending: undefined };
  render();
  assert.deepEqual(effectiveChart, { ...edited, ...dataInputs });
  assert.deepEqual(actionComponent.chart, effectiveChart, "Actions must track refreshed and explicitly unavailable totals");
  shell.chartOverrides = {};
  render();
  assert.deepEqual(effectiveChart, { ...spec, ...dataInputs }, "Reset returns to authored settings with current reviewed inputs");
  shell.visible = () => false;
  assert.equal(render(), "", "standalone hidden charts do not leave empty evidence cards");
});

test("public chart entry points and component actions agree on saved settings and reviewed inputs", async () => {
  const { Chart, ChartRenderer, DataComponent, EvidenceChart } = await server.ssrLoadModule("/src/data-app-public.jsx");
  const { DataAppContext } = await server.ssrLoadModule("/src/DataAppContext.jsx");
  const rows = [{ segment: "A", users: 100, accounts: 10 }, { segment: "B", users: 40, accounts: 4 }];
  const saved = { type: "rankedList", x: "segment", y: "accounts", fields: ["accounts"], showLegend: false,
    beginning: 10, ending: 24 };
  const authored = { ...saved, type: "line", y: "users", fields: ["users"], xLabel: "Old label",
    annotations: [{ id: "old", kind: "threshold", value: 50, label: "Old threshold" }] };
  const dataInputs = { beginning: 0, ending: 14, type: "pie", y: "users" };
  const expected = { ...saved, beginning: 0, ending: 14 };
  let actionComponent, evidencePlot;
  const shell = { snapshot: {}, chartOverrides: { adoption: saved }, visible: () => true,
    chartProps: id => ({ chartId: id }),
    componentActions: { additionalActions: component => { actionComponent = component; return null; } } };
  const componentProps = { id: "adoption", queryId: "usage", title: "Adoption", dataInputs };
  for (const [name, Plot] of [["EvidenceChart", EvidenceChart], ["ChartRenderer", ChartRenderer], ["Chart", Chart]]) {
    const content = Plot === EvidenceChart
      ? React.createElement(Plot, { ...componentProps, spec: authored, rows, sourceRows: rows,
        renderPlot: (plot, chart) => { evidencePlot = chart; return plot; } })
      : React.createElement(DataComponent, { ...componentProps, kind: "chart", chart: authored, displayRows: rows, sourceRows: rows },
        React.createElement(Plot, { ...shell.chartProps("adoption"), spec: authored, dataInputs, rows }));
    actionComponent = null;
    const html = renderToStaticMarkup(React.createElement(DataAppContext.Provider, { value: shell }, content));
    assert.deepEqual(actionComponent.chart, expected, `${name}: actions must use the complete saved settings and current inputs`);
    assert.match(html, /role="list" aria-label="Accounts by Segment"/u, `${name}: the saved type and field must drive the plot`);
    assert.match(html, /aria-label="A: 10"/u);
    assert.match(html, /aria-label="B: 4"/u);
    assert.doesNotMatch(html, /Old label|Old threshold/u);
  }
  assert.deepEqual(evidencePlot, expected);
  assert.equal(saved.beginning, 10);
});

test("sortable owners hide complete slots and restore saved placement without authored visibility guards", async () => {
  const { SortableRegion, SortableItem } = await server.ssrLoadModule("/src/components/SortableRegion.jsx");
  const { DataAppContext, DataAppBlockLayoutContext } = await server.ssrLoadModule("/src/DataAppContext.jsx");
  for (const variant of ["canvas", "stack", "freeform"]) {
    const saved = { order: ["b", "a"], rows: [{ id: "pair", items: ["b", "a"] }], authoredRevision: 1 };
    const original = JSON.stringify(saved);
    const render = hidden => renderToStaticMarkup(React.createElement(DataAppContext.Provider,
      { value: { hiddenBlockIds: new Set(hidden), canEdit: false, mode: "view", snapshot: {} } },
      React.createElement(DataAppBlockLayoutContext.Provider, { value: { blockLayouts: { grouped: saved }, setBlockLayout() {} } },
        React.createElement(SortableRegion, { id: "grouped", variant, rows: [{ id: "pair", items: ["a", "b"] }] },
          ["a", "b"].map(id => React.createElement(SortableItem, { id, key: id }, `block-${id}`))))));
    const hidden = render(["b"]);
    assert.match(hidden, /block-a/u);
    assert.doesNotMatch(hidden, /block-b|data-sortable-id="b"/u);
    const restored = render([]);
    assert.ok(restored.indexOf("block-b") < restored.indexOf("block-a"), `${variant}: restored saved order`);
    assert.equal(JSON.stringify(saved), original, "visibility never rewrites saved layout");
    const empty = render(["a", "b"]);
    assert.doesNotMatch(empty, /block-a|block-b/u);
    if (variant === "canvas") assert.match(empty, /sortable-canvas-row--empty/u, "empty rows retain restore metadata but occupy no space");
  }
});

test("nested canvases expose only their first visible inferred gap to the containing section", async () => {
  const { Section } = await server.ssrLoadModule("/src/components/Section.jsx");
  const { SortableRegion, SortableItem } = await server.ssrLoadModule("/src/components/SortableRegion.jsx");
  const { DataAppContext, DataAppBlockLayoutContext } = await server.ssrLoadModule("/src/DataAppContext.jsx");
  const render = spacing => renderToStaticMarkup(React.createElement(DataAppContext.Provider,
    { value: { hiddenBlockIds: new Set(["hidden"]), canEdit: false, mode: "view", snapshot: { surface: "dashboard" } } },
    React.createElement(DataAppBlockLayoutContext.Provider, { value: { blockLayouts: {}, setBlockLayout() {} } },
      React.createElement(Section, null, React.createElement(SortableRegion, {
        id: "nested", variant: "canvas", spacing: "standard", columns: 12,
        rows: [{ id: "hidden-row", items: ["hidden"] }, { id: "first", items: ["a"], spacing },
          { id: "second", items: ["b"] }],
      }, ["a", "b"].map(id => React.createElement(SortableItem, { key: id, id }, id)))))));
  const inferred = render(undefined);
  const first = inferred.match(/<section[^>]*data-sortable-row="first"[^>]*>/u)?.[0];
  const second = inferred.match(/<section[^>]*data-sortable-row="second"[^>]*>/u)?.[0];
  assert.match(first, /data-section-leading-space="auto"/u);
  assert.doesNotMatch(second, /data-section-leading-space/u);
  const explicit = render("section").match(/<section[^>]*data-sortable-row="first"[^>]*>/u)?.[0];
  assert.match(explicit, /data-section-spacing="section"/u);
  assert.doesNotMatch(explicit, /data-section-leading-space/u);
});

test("chart-local population and measure controls share one header without duplicating context", async () => {
  const { DataComponent } = await server.ssrLoadModule("/src/components/DataComponent.jsx");
  const { Dropdown } = components;
  const headerControls = React.createElement(React.Fragment, null,
    React.createElement(Dropdown, { label: "Plan", showLabel: true, value: "Plus", choices: ["Plus", "Pro"], onChange() {} }),
    React.createElement(Dropdown, { label: "Measure", showLabel: true, value: "users", choices: ["users", "adoption"],
      choiceLabels: { users: "Active users", adoption: "Adoption" }, onChange() {} }));
  const html = renderToStaticMarkup(React.createElement(DataComponent, { id: "plan-history", queryId: "usage", title: "Plan history",
    kind: "chart", headerControls, description: "Adoption uses active users, not licensed seats.", showActions: false },
    React.createElement("div", { "data-plot": true })));
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  assert.match(header, /aria-label="Plan"/u);
  assert.match(header, /aria-label="Measure"/u);
  assert.match(header, />Active users<\/span>/u);
  assert.equal((html.match(/class="filter-trigger select-trigger"/gu) ?? []).length, 2);
  assert.doesNotMatch(html.slice(html.indexOf("</header>")), /Adoption uses active users/u,
    "The info description must not become an unsolicited body paragraph");
});

test("Filters keeps custom controls inside the shared sticky bar", () => {
  const { Filters } = components;
  const markup = renderToStaticMarkup(React.createElement(
    Filters,
    {
      sticky: true,
      filters: [
        { id: "family", label: "Chart family", field: "family" },
        { id: "chartType", label: "Chart type", field: "chartType", searchable: true,
          allLabel: "All chart types", showLabel: false },
      ],
      queries: { catalog: { rows: [
        { family: "Trend", chartType: "Line" },
        { family: "Comparison", chartType: "Bar" },
      ] } },
      values: { family: "all", chartType: "all" },
      onChange: () => {},
    },
    React.createElement("div", { "data-layout-control": true }, "Top Left"),
  ));

  assert.match(markup, /class="filters filter-bar"/u);
  assert.match(markup, /data-layout-control="true">Top Left/u);
  assert.equal((markup.match(/data-layout-control/g) ?? []).length, 1, "Custom controls render once");
  assert.ok(
    markup.indexOf("data-layout-control") < markup.indexOf("Chart family"),
    "Custom controls should lead the generated data filters",
  );
  assert.match(markup, /role="combobox" aria-label="Chart type"/u);
  assert.match(markup, /class="filter-typeahead"><div class="typeahead"/u);
  assert.match(markup, /value="All chart types"/u);
  assert.doesNotMatch(markup, /<span class="filter-label">Chart type/u);
});

test("filter headers preserve trailing-only controls and compare multi-select defaults by value", async () => {
  const { Filters } = components;
  const { Switch } = await server.ssrLoadModule("/src/components/Switch.jsx");
  const render = props => renderToStaticMarkup(React.createElement(Filters, {
    queries: { regions: { rows: [{ region: "EMEA" }, { region: "Americas" }] } },
    values: {}, onChange: () => {}, ...props,
  }));
  const toggle = React.createElement(Switch, { size: "compact", label: "Previous period", checked: true, disabled: true });
  const trailing = render({ trailingControls: toggle });
  assert.match(trailing, /role="switch" aria-label="Previous period" aria-checked="true" disabled/u);
  assert.match(trailing, /data-size="compact"/u);
  const filters = [{ id: "region", field: "region", multiple: true, defaultValue: ["EMEA", "Americas"] }];
  assert.doesNotMatch(render({ filters, values: { region: ["Americas", "EMEA"] } }), /class="clear-filters"/u);
  assert.match(render({ filters, values: { region: [] } }), /class="clear-filters"/u);
  assert.doesNotMatch(render({ filters: [{ ...filters[0], defaultValue: "all" }], values: { region: [] } }), /class="clear-filters"/u);
});

test("Dropdown adds searchable multi-select summaries without changing scalar values", () => {
  const { Dropdown } = components;
  const render = (props) => renderToStaticMarkup(React.createElement(Dropdown, {
    searchable: true,
    label: "Feedback sources",
    choices: ["all", "Support", "Reviews"],
    onChange: () => {},
    allLabel: "All sources",
    ...props,
  }));

  const empty = render({ multiple: true, value: [] });
  assert.match(empty, /value="All sources"/u);
  assert.match(empty, /aria-label="Open Feedback sources"/u);
  assert.match(empty, /data-dashboard-icon="chevronDown"/u);

  const single = render({ multiple: true, value: ["Support"] });
  assert.match(single, /value="Support"/u);
  assert.match(single, /class="typeahead-toggle"/u);
  assert.match(single, /aria-label="Open Feedback sources"/u);
  assert.doesNotMatch(single, /data-dashboard-icon="cross"/u);

  const several = render({ multiple: true, value: ["Support", "Reviews"] });
  assert.match(several, /value="2 selected"/u);

  const scalar = render({ value: "Support" });
  assert.match(scalar, /value="Support"/u);
  assert.doesNotMatch(scalar, /value="1 selected"/u);
});

test("Dropdown uses searchable and multiple as independent behavior flags", async () => {
  const { Dropdown } = components;
  const render = (props) => renderToStaticMarkup(React.createElement(Dropdown, {
    label: "Chart types",
    choices: ["all", "Line", "Bar"],
    onChange: () => {},
    ...props,
  }));

  const select = render({ value: "Line" });
  assert.doesNotMatch(select, /role="combobox"/u);
  assert.match(select, />Line</u);

  const multiSelect = render({ multiple: true, value: ["Line", "Bar"] });
  assert.doesNotMatch(multiSelect, /role="combobox"/u);
  assert.match(multiSelect, />2 selected</u);

  const searchable = render({ searchable: true, value: "Line" });
  assert.match(searchable, /role="combobox"/u);

  const searchableMulti = render({ searchable: true, multiple: true, value: ["Line", "Bar"] });
  assert.match(searchableMulti, /role="combobox"/u);
  assert.match(searchableMulti, /value="2 selected"/u);


});

test("Searchable Dropdown can place its label inline while keeping the default value concise", () => {
  const { Dropdown } = components;
  const inline = renderToStaticMarkup(React.createElement(Dropdown, {
    searchable: true,
    label: "Feedback sources",
    choices: ["all", "Support"],
    multiple: true,
    showLabel: true,
    value: [],
    onChange: () => {},
  }));
  const labelIndex = inline.indexOf('<span class="filter-label">Feedback sources</span>');
  const inputIndex = inline.indexOf('role="combobox"');
  assert.ok(labelIndex >= 0 && labelIndex < inputIndex, "The visible label should lead the input inside the control");
  assert.match(inline, /value="All"/u);

  const standard = renderToStaticMarkup(React.createElement(Dropdown, {
    searchable: true,
    label: "Feedback sources",
    choices: ["all", "Support"],
    value: "all",
    onChange: () => {},
  }));
  assert.doesNotMatch(standard, /<span class="filter-label">Feedback sources<\/span>/u);
});

test("upstream table captions and delta tones retain dashboard row actions", async () => {
  const { resolveDeltaTone } = await import("../src/charting/table-data.js");
  const row = { team: "Core", costChange: 12 };
  const html = renderToStaticMarkup(React.createElement(components.DataTable, {
    rows: [row], searchable: false, caption: "Team cost changes", signedDeltas: true,
    rowKey: "team", onRowSelect: () => {}, columns: [{ field: "team" }, { field: "costChange", deltaTone: "negative" }],
  }));
  assert.match(html, /<caption class="visually-hidden">Team cost changes<\/caption>/u);
  assert.match(html, /role="region" aria-label="Team cost changes table"/u);
  assert.match(html, /scope="col" aria-sort="none"/u);
  assert.match(html, /data-row-action="true"/u);
  assert.match(html, /data-delta="negative"/u);
  assert.equal(resolveDeltaTone(undefined, 12, row, "positive"), "positive");
  assert.equal(resolveDeltaTone("invalid", 12, row, "positive"), "neutral");
  assert.equal(resolveDeltaTone(() => { throw new Error("invalid rule"); }, 12, row, "positive"), "neutral");
  assert.equal(resolveDeltaTone(value => value > 0 ? "negative" : "positive", 12, row), "negative");
});

test("select label, value, and chevron belong to one trigger hit target", async () => {
  const html = renderToStaticMarkup(React.createElement(components.Dropdown, {
    label: "Day", showLabel: true, value: "2026-08-21", choices: ["2026-08-21"],
    formatChoice: () => "Aug 21, 2026", onChange: () => {},
  }));
  assert.match(html, /<button[^>]*class="filter-trigger select-trigger"[^>]*aria-label="Day"/u);
  assert.match(html, /<span class="filter-label">Day<\/span><span class="select-value">Aug 21, 2026<\/span>/u);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
});


test("Dropdown preserves formatted labels for scalar and multiple searchable selections", () => {
  for (const searchable of [false, true]) {
    for (const multiple of [false, true]) {
      const html = renderToStaticMarkup(React.createElement(components.Dropdown, {
        label: "Metric", choices: ["active_users"],
        value: multiple ? ["active_users"] : "active_users", searchable, multiple,
        choiceLabels: { active_users: "Fallback label" }, formatChoice: () => "Active users",
      }));
      assert.ok(html.includes("Active users"), "The explicit formatter applies to both presentations");
      assert.ok(!html.includes("Fallback label"), "formatChoice takes precedence over choiceLabels");
    }
  }
});

test("table formatting distinguishes compact displays from exact evidence and opt-in deltas", () => {
  const rows = Object.freeze([Object.freeze({ activeUsers: 12345, netChange: 1234.567, year: 2026 })]);
  const cells = props => {
    const html = renderToStaticMarkup(React.createElement(components.DataTable, { rows, searchable: false, ...props }));
    return [...html.matchAll(/<td[^>]*>(.*?)<\/td>/gu)].map(([, text]) => text);
  };
  assert.deepEqual(cells({}), ["12.3K", "1,234.57", "2026"]);
  assert.deepEqual(cells({ compactNumbers: false }), ["12,345", "1,234.57", "2026"]);
  assert.deepEqual(cells({ compactNumbers: false, signedDeltas: true }), ["12,345", "+1,234.57", "2026"]);
  assert.equal(rows[0].netChange, 1234.567, "Formatting must not round the reviewed evidence");
});
