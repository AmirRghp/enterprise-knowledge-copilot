import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { before, after, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { barChartSpec, barPresentations, barPresentationIssue, barValue, segmentCalloutsFit, rangePosition } from "../src/charting/bar-family.js";
import { chartDataShape, projectChartSpec } from "../src/charting/chart-data-shape.js";
import { semanticColorResolver } from "../src/charting/chart-theme.js";

let server, Chart, BarFamily, Explorer, availableTypes, BarTooltip, ChartTooltip, ProgressTooltip, Library, Shell, labSnapshot, State, iconNames, DataAppContext;
const originalWindow = globalThis.window, originalLocation = globalThis.location;
before(async () => {
  globalThis.location = new URL("../examples/component-lab/index.html", import.meta.url);
  globalThis.window = { location: globalThis.location };
  server = await createServer({ root: fileURLToPath(new URL("../", import.meta.url)), configFile: false,
    appType: "custom", logLevel: "silent", server: { middlewareMode: true } });
  Chart = (await server.ssrLoadModule("/src/charting/ChartRenderer.jsx")).ChartRenderer;
  BarFamily = (await server.ssrLoadModule("/src/charting/BarFamilyRenderer.jsx")).BarFamilyRenderer;
  Explorer = (await server.ssrLoadModule("/src/components/ChartExplorer.jsx")).ChartExplorer;
  availableTypes = (await server.ssrLoadModule("/src/components/ChartExplorer.jsx")).availableChartTypes;
  BarTooltip = (await server.ssrLoadModule("/src/charting/BarFamilyRenderer.jsx")).BarTooltip;
  ChartTooltip = (await server.ssrLoadModule("/src/charting/ChartTooltip.jsx")).ChartTooltip;
  ProgressTooltip = (await server.ssrLoadModule("/src/charting/BarFamilyRenderer.jsx")).ProgressTooltip;
  Library = await server.ssrLoadModule("/examples/component-lab/Library.jsx");
  State = await server.ssrLoadModule("/src/charting/ChartState.jsx");
  iconNames = (await server.ssrLoadModule("/src/components/Icon.jsx")).dashboardIconNames;
  Shell = (await server.ssrLoadModule("/src/DataAppShell.jsx")).DataAppShell;
  DataAppContext = (await server.ssrLoadModule("/src/DataAppContext.jsx")).DataAppContext;
  labSnapshot = (await server.ssrLoadModule("/examples/component-lab/data.js")).snapshot;
});
after(async () => { await server?.close(); globalThis.window = originalWindow; globalThis.location = originalLocation; });
const render = (rows, recipe) => renderToStaticMarkup(React.createElement(Chart, { rows, spec: barChartSpec(recipe) }));

test("authored content receives an explicit inactive export signal without changing chart state", () => {
  let context;
  function Content() {
    context = React.useContext(DataAppContext);
    return React.createElement("output", null, String(context.chartExportActive));
  }
  const html = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true }, React.createElement(Content)));
  assert.equal(context.chartExportActive, false);
  assert.match(html, /<output>false<\/output>/u);
  assert.equal(typeof context.chartProps, "function");
  assert.equal(typeof context.componentActions.additionalActions, "function");
  assert.deepEqual(context.chartProps("export-contract").visibleSeries, context.chartStates["export-contract"]?.visibleSeries);
  assert.deepEqual(context.chartProps("export-contract").zoomRange, context.chartStates["export-contract"]?.zoomRange);
});

test("native wide time series render every configured field beyond the argument-count limit", () => {
  // A reviewed dashboard has 615 dates × 992 model series. Keep this shape;
  // lowering source rows or dropping fields would conceal the regression.
  const fields = Array.from({ length: 992 }, (_, index) => `model-${index}`);
  const rows = Array.from({ length: 615 }, (_, index) => ({
    day: index,
    ...Object.fromEntries(fields.map(field => [field, 1])),
  }));
  rows.at(-1)[fields.at(-1)] = 19;
  const spec = { type: "stackedArea", x: "day", y: fields[0], fields,
    rightAxisFields: [], groupOther: false, showLegend: false };
  const shape = chartDataShape(spec, rows);
  assert.deepEqual(shape.fields, fields);
  assert.equal(rows.at(-1)[fields.at(-1)], 19);
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(Chart, { rows, spec })));
});

test("canonical bar-family plots infer orientation from type and preserve explicit overrides", () => {
  for (const [type, orientation, expected] of [["horizontalBar",undefined,"vertical"],
    ["bar",undefined,"horizontal"],["horizontalBar","vertical","horizontal"],["bar","horizontal","vertical"]]) {
    let tree;
    function Probe() {
      tree = BarFamily({rows:[{category:"A",value:3}],spec:{type,x:"category",y:"value",presentation:"plot",barOptions:{orientation}}});
      return tree;
    }
    renderToStaticMarkup(React.createElement(Probe));
    const layouts = [];
    function visit(element) {
      if (!React.isValidElement(element)) return;
      if (element.props.layout) layouts.push(element.props.layout);
      React.Children.forEach(element.props.children,visit);
    }
    visit(tree);
    assert.deepEqual(layouts,[expected],`${type}, orientation=${orientation}`);
  }
});

test("ranked-list selections request detail actions for the clicked reviewed row", () => {
  const rows = [{ channel: "Search", value: 3 }, { channel: "Partner", value: 9 }];
  const requested = [];
  let tree;
  function Probe() {
    const renderer = Chart({ rows, spec: { type: "rankedList", x: "channel", y: "value" },
      getMarkActions: mark => { requested.push(mark); return [{ label: "View records", onSelect() {} }]; } });
    // Capture the rendered ranking's callbacks without a browser event harness.
    tree = renderer.type(renderer.props);
    return tree;
  }
  renderToStaticMarkup(React.createElement(Probe));
  const buttons = [];
  function visit(element) {
    if (!React.isValidElement(element)) return;
    if (element.props.className === "chart-ranked-list-row") buttons.push(element);
    React.Children.forEach(element.props.children, visit);
  }
  visit(tree);
  assert.equal(buttons.length, 2);
  buttons[0].props.onClick({ nativeEvent: {} });
  buttons[1].props.onClick({ nativeEvent: {} });
  assert.deepEqual(requested, [{ row: rows[1], field: "value" }, { row: rows[0], field: "value" }]);
});

test("bar recipes round-trip only supported options and preserve every source dependency", () => {
  const spec = barChartSpec({ presentation: "bullet", category: "team", value: "actual", target: "goal",
    projection: "forecast", range: ["low", "high"], rangeLabelField: "rangeLabel", style: { colorField: "color", sql: "private" },
    format: { style: "currency", currency: "USD", maximumFractionDigits: 0 },
    markers: [{ value: 50, label: "Target", sql: "private" }], sql: "private", formatValue: () => "unsafe" });
  assert.deepEqual(JSON.parse(JSON.stringify(projectChartSpec(spec))), spec);
  assert.ok(!JSON.stringify(spec).includes("private") && !JSON.stringify(spec).includes("unsafe"));
  const shape = chartDataShape(spec, [{ team: "A", actual: 10, goal: 20, forecast: 15, low: 5, high: 12, rangeLabel: "5–12", color: "red" }]);
  for (const field of ["team", "actual", "goal", "forecast", "low", "high"]) assert.ok(shape.requiredRowFields.includes(field));
  for (const field of ["color", "rangeLabel"]) assert.ok(shape.optionalRowFields.includes(field));
});

test("compact bar presentations render through Chart with shared mark interactions", () => {
  const rows = [{ category: "Core", value: 25, goal: 100, previous: 20, other: 75 }];
  for (const [presentation, options, className] of [
    ["bullet", { target: "goal" }, "bar-family-bullets"],
    ["segmented", { series: ["value", "other"] }, "bar-family-segmented"],
    ["groupedList", { series: [{ key: "value" }, { key: "previous" }] }, "bar-family-grouped-list"],
    ["rankedList", {}, "bar-family-list--rankedList"],
    ["progress", { track: { max: "goal" } }, "bar-family-list--progress"],
    ["comparison", {}, "bar-family-list--comparison"],
    ["rangePosition", { range: ["previous", "goal"] }, "bar-family-range"],
  ]) {
    const html = render(rows, { category: "category", value: "value", presentation, ...options });
    assert.ok(html.includes(className), presentation);
    assert.match(html, /data-chart-interaction-root/u);
    assert.match(html, /data-chart-mark/u);
    assert.doesNotMatch(html, /NaN|Infinity|Unsupported/u);
  }
});

test("segmented progress preserves attainment and validates segment counts", () => {
  const recipe = { presentation: "progress", category: "label", value: "actual", track: {max:"goal"}, style:{segments:10}, detailField:"detail" };
  for (const [actual, expected] of [[0,0],[44,4],[46,5],[125,10],[null,0]]) {
    const html = render([{label:"Capacity",actual,goal:100,detail:"Reviewed goal"}],recipe);
    assert.equal((html.match(/<span data-active="true"/g) ?? []).length, expected);
    assert.match(html, actual === null ? /Capacity: —/u : new RegExp(`Capacity: ${actual}%`));
    assert.doesNotMatch(html, /NaN|Infinity/u);
  }
  const spec = barChartSpec(recipe);
  assert.match(render([{label:"Capacity",actual:.746,goal:1}],{...recipe,labels:{value:"formatted",position:"summary"},format:{style:"percent",maximumFractionDigits:1}}), /74.6%/u);
  assert.deepEqual(projectChartSpec(JSON.parse(JSON.stringify(spec))), spec);
  assert.ok(chartDataShape(spec,[{label:"Capacity",actual:44,goal:100,detail:"Reviewed goal"}]).optionalRowFields.includes("detail"));
  for (const segments of [0,1,2.5,41]) assert.match(barPresentationIssue([],barChartSpec({...recipe,style:{segments}})),/Segment count/u);
});

test("range positions handle signed, collapsed, unknown and out-of-range evidence without changing values", () => {
  for (const [low,high,value,expected] of [[-10,10,0,50],[80,120,104,60],[80,120,135,100],[80,120,60,0],[5,5,5,50],[5,5,6,100],[5,5,4,0],[null,10,5,null],[0,10,null,null],[10,0,5,null]])
    assert.equal(rangePosition(low,high,value),expected);
  const spec = barChartSpec({presentation:"rangePosition",category:"label",value:"current",range:["low","high"]});
  const rows = [{label:"Observed range",low:-10,high:10,current:15}];
  assert.equal(barPresentationIssue(rows,spec),null);
  assert.match(render(rows,{...spec}), /Observed range: 15; -10 to 10/u);
  assert.deepEqual(chartDataShape(spec,rows).requiredRowFields,["label","current","low","high"]);
  assert.deepEqual(projectChartSpec(JSON.parse(JSON.stringify(spec))),spec);
  assert.match(barPresentationIssue([],barChartSpec({presentation:"rangePosition"})), /low and high/u);
  assert.match(barPresentationIssue([{low:10,high:5}],spec),/ordered/u);
  const unknown = render([{label:"Unknown",low:0,high:10,current:null}],spec);
  assert.doesNotMatch(unknown, /<i style=/u);
});

test("range tooltip and editor retain current value separately from both endpoints", () => {
  const html = renderToStaticMarkup(React.createElement(BarTooltip, {row:{label:"Price",current:135,low:80,high:120},spec:{
    presentation:"rangePosition",category:"label",value:"current",range:["low","high"],tooltipFields:[],formatCategory:String,formatValue:value=>`$${value}`,
  }}));
  assert.match(html, /\$135/u);
  assert.match(html, /Low<b>\$80/u);
  assert.match(html, /High<b>\$120/u);
  assert.doesNotMatch(html, /<i |data-comparison/u);
  const spec = barChartSpec({presentation:"rangePosition",category:"label",value:"current",range:["low","high"]});
  const editor = renderToStaticMarkup(React.createElement(Explorer,{component:{id:"range",chart:spec},rows:[{label:"Price",current:135,low:80,high:120}],onChange:()=>{}}));
  for (const field of ["Range start","Range end","Current value"]) assert.ok(editor.includes(field));
});

test("missing values and absent bullet targets are not presented as zero", () => {
  assert.equal(barValue({ value: 0 }, "value"), 0);
  for (const value of [null, undefined, "", NaN]) assert.equal(barValue({ value }, "value"), null);
  const html = render([{ category: "Unknown", value: null }], { category: "category", value: "value", presentation: "bullet" });
  assert.match(html, /Unknown: —/u);
  assert.doesNotMatch(html, /target 0|<i style=|bullet-projection/u);
});

test("signed data, incomplete compositions, invalid goals and reversed ranges fail honestly", () => {
  const recipe = { category: "category", value: "value", presentation: "progress", track: { max: "goal" } };
  assert.match(barPresentationIssue([{ value: -1, goal: 5 }], barChartSpec(recipe)), /signed/u);
  for (const goal of [0, null, undefined, -1]) assert.match(barPresentationIssue([{ value: 5, goal }], barChartSpec(recipe)), /positive goal/u);
  assert.match(barPresentationIssue([{ value: 5, other: null }], barChartSpec({ ...recipe, presentation: "segmented", series: ["value", "other"] })), /complete/u);
  assert.match(barPresentationIssue([{ low: 10, high: 5 }], barChartSpec({ category: "category", value: "value", range: ["low", "high"] })), /ordered/u);
  assert.equal(barPresentationIssue([{ value: -5 }], barChartSpec({ ...recipe, presentation: "plot" })), null);
});

test("zero-total compositions do not invent percentage shares", () => {
  const html = render([{ category: "No activity", a: 0, b: 0 }], { presentation: "segmented", category: "category",
    series: ["a", "b"], annotations: true, labels: { primary: "share", position: "below" } });
  assert.match(html, /—/u);
  assert.doesNotMatch(html, /0% of total|NaN|Infinity/u);
});

test("source projection retains all grouped measures and presentation metadata", () => {
  const spec = barChartSpec({ category: "category", presentation: "groupedList",
    series: [{ key: "actual", label: "Current", color: "green" }, { key: "previous", label: "Previous", color: "gray" }] });
  const projected = projectChartSpec(spec);
  assert.deepEqual(projected.barOptions.series, spec.barOptions.series);
  assert.deepEqual(chartDataShape(projected, [{ category: "A", actual: 2, previous: 1 }]).requiredRowFields,
    ["category", "actual", "previous"]);
});

test("specialized chart edits expose supported mappings only and respect read-only viewers", () => {
  const chart = barChartSpec({ presentation: "bullet", category: "team", value: "actual", target: "goal" });
  const props = { component: { id: "example", chart }, rows: [{ team: "A", actual: 5, goal: 10 }] };
  const readOnly = renderToStaticMarkup(React.createElement(Explorer, { ...props, canEdit: false }));
  assert.doesNotMatch(readOnly, /explorer-controls/u);
  const editable = renderToStaticMarkup(React.createElement(Explorer, { ...props, canEdit: true }));
  assert.match(editable, /Reviewed data settings/u);
  assert.match(editable, />Target</u);
  assert.doesNotMatch(editable, /Chart type|Split series by|Show legend/u);
});

test("annotated chart editors render the shared visibility switch in either state", () => {
  for (const type of ["line", "bar"]) for (const showAnnotations of [true, false]) {
    const chart = { type, x: "date", y: "value", showAnnotations,
      annotations: [{ id: "release", kind: "event", at: "2026-07-20", label: "Release" }] };
    const html = renderToStaticMarkup(React.createElement(Explorer, {
      component: { id: "annotated", chart }, rows: [{ date: "2026-07-20", value: 10 }],
    }));
    assert.match(html, new RegExp(`role="switch" aria-label="Show annotations" aria-checked="${showAnnotations}"`));
  }
});

test("goal and projection tooltips distinguish reference roles from observed values", () => {
  const html = renderToStaticMarkup(React.createElement(BarTooltip, {
    row: { name: "Steps", actual: 8000, goal: 10000, projected: 9500 },
    spec: { category: "name", value: "actual", target: "goal", projection: "projected",
      series: [], tooltipFields: [], style: { color: "green" }, formatCategory: String, formatValue: String },
  }));
  assert.match(html, /data-comparison="current"[^>]*background:green/u);
  assert.match(html, /data-comparison="target"[^>]*background:var\(--secondary\)/u);
  assert.match(html, /data-comparison="projection"[^>]*background:var\(--secondary\)/u);
  assert.match(html, /Actual/u);
  assert.match(html, /Target/u);
  assert.match(html, /Projected/u);
});

test("public-component inventory exposes controls and unique chart identities", () => {
  const inventory = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true }, React.createElement(Library.LibraryInventory)));
  for (const name of ["Chart", "DataTable", "DateRangePicker", "RangeSlider", "ExecutiveSummary", "SourceInspector"])
    assert.ok(inventory.includes(`>${name}</button>`), name);
  assert.match(inventory, /Find a component/u);
  assert.match(inventory, /Minimum card width/u);
  assert.match(inventory, /Aliases/u);
  const ids = [...inventory.matchAll(/data-component-id="(library-chart-[^"]+)"/gu)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, "simultaneous variants retain separate source/edit identities");
  for (const presentation of barPresentations) assert.ok(ids.includes(`library-chart-bar-${presentation}`), presentation);
  for (const type of Library.libraryChartTypes) assert.ok(ids.includes(`library-chart-${type}-standard`), type);
});

test("non-additive series cannot acquire stacked transformations when editing", () => {
  const chart = projectChartSpec({ type: "bar", x: "month", y: "users", series: "platform", stackable: false });
  const choices = availableTypes(chart);
  assert.ok(choices.includes("bar") && choices.includes("line"));
  assert.ok(!choices.some(type => /stacked/iu.test(type)));
  assert.ok(availableTypes({ ...chart, stackable: true }).some(type => /stacked/iu.test(type)));
});

test("review category colors remain distinct and stable when categories are filtered", () => {
  const resolve = semanticColorResolver(labSnapshot.queries);
  const rows = labSnapshot.queries.category_performance.rows;
  const colors = rows.map(row => resolve({ dimension: "segment", value: row.segment }));
  assert.equal(new Set(colors).size, rows.length);
  for (const row of rows.slice(2)) assert.equal(resolve({ dimension: "segment", value: row.segment }), colors[rows.indexOf(row)]);
});

test("skeletons preserve category counts and heatmap dimensions without copying values", () => {
  const rows = [{day:"Mon",period:"AM",value:9182},{day:"Tue",period:"AM",value:9182},{day:"Mon",period:"PM",value:9182}];
  const renderSkeleton = chart => renderToStaticMarkup(React.createElement(State.ComponentSkeleton, { chart, rows }));
  assert.equal((renderSkeleton({type:"bar"}).match(/<i /g) ?? []).length, 3);
  const heatmap = renderSkeleton({type:"heatmap",x:"day",series:"period"});
  assert.match(heatmap, /--skeleton-columns:2;--skeleton-rows:2/u);
  assert.equal((heatmap.match(/<i /g) ?? []).length, 4);
  assert.doesNotMatch(heatmap, /9182/u);
});

test("date picker is the real bounded control with disabled and empty states", async () => {
  const {DateRangePicker} = await server.ssrLoadModule("/src/data-app-public.jsx");
  const renderPicker = props => renderToStaticMarkup(React.createElement(DateRangePicker, props));
  const loaded = renderPicker({choices:["2026-08-28","invalid","2026-02-30","2026-08-01"]});
  assert.match(loaded, /Latest 28 days|Last 28 days/u);
  assert.doesNotMatch(loaded, /invalid|Feb/u);
  assert.match(renderPicker({choices:[]}), /disabled=""[^>]*aria-label="Date range"/u);
  assert.match(renderPicker({choices:["2026-08-01"],disabled:true}), /disabled=""/u);
});

test("empty, loading and error chart states are distinct and cover every chart family", () => {
  const empty = renderToStaticMarkup(React.createElement(Chart, { rows: [], spec: {type:"line",x:"date",y:"value"}, height:280 }));
  assert.match(empty, /No data to display/u);
  assert.match(empty, /min-height:280px/u);
  assert.doesNotMatch(empty, /recharts-cartesian|data-skeleton-family/u);
  for (const [type, family] of [["line","trend"],["pie","pie"],["heatmap","heatmap"],["scatter","scatter"],["sankey","sankey"],["funnel","funnel"],["boxPlot","boxPlot"],["horizontalBar","list"],["bar","bar"]]) {
    const html = renderToStaticMarkup(React.createElement(State.ComponentSkeleton, { chart:{type} }));
    assert.ok(html.includes(`data-skeleton-family="${family}"`), type);
    assert.doesNotMatch(html, /Loading|Updating/u);
  }
  for (const [presentation, family] of [["segmented","composition"],["bullet","list"],["progress","list"]])
    assert.equal(State.chartSkeletonFamily({type:"bar",presentation}), family);
  const unavailable = renderToStaticMarkup(React.createElement(State.ComponentState, {error:true,height:280}));
  assert.match(unavailable, /Couldn’t load this chart/u);
  assert.doesNotMatch(unavailable, /<button/u);
  const retryable = renderToStaticMarkup(React.createElement(State.ComponentState, {error:true,onRetry:()=>{}}));
  assert.match(retryable, /Try again<\/button>/u);
});

test("malformed chart bindings show a scoped diagnostic instead of blank marks or a report crash", () => {
  const spec = { type: "line", x: "week", y: ["siteA", "siteB"] };
  const rows = [{ week: "2026-08-03", siteA: 18, siteB: 12 }];
  for (const currentRows of [rows, []]) {
    const html = renderToStaticMarkup(React.createElement(Chart, {
      chartId: "throughput", spec, rows: currentRows, height: 280,
    }));
    assert.match(html, /role="alert"[^>]*data-chart-config-error="true"[^>]*data-chart-id="throughput"/u);
    assert.match(html, /chart\.y must be a single field name, not an array/u);
    assert.match(html, /y: &quot;siteA&quot;, fields: \[&quot;siteA&quot;,&quot;siteB&quot;\]/u);
    assert.doesNotMatch(html, /No data to display|recharts-cartesian/u);
  }
  for (const currentRows of [[], rows, [{ week: "2026-08-03", siteA: 0, siteB: null }]]) {
    const html = renderToStaticMarkup(React.createElement(Chart, {
      spec: { ...spec, y: "siteA", fields: ["siteA", "siteB"] }, rows: currentRows,
    }));
    assert.doesNotMatch(html, /data-chart-config-error/u);
  }
});

test("control stories are isolated and the icon story discovers the bundled assets", () => {
  for (const name of ["Dropdown","Filters","InlineFilters","SegmentedControl"]) {
    const html = renderToStaticMarkup(React.createElement(Shell, {snapshot:labSnapshot,hosted:true}, React.createElement(Library.LibraryStory, {name})));
    assert.doesNotMatch(html, /<table|Search data|Weekly:|role="switch"/u, name);
  }
  const icons = renderToStaticMarkup(React.createElement(Shell, {snapshot:labSnapshot,hosted:true}, React.createElement(Library.LibraryStory, {name:"Icon"})));
  for (const name of iconNames) assert.ok(icons.includes(`data-dashboard-icon="${name}"`),name);
  assert.match(icons, /Find an icon/u);
});

test("progress tooltips preserve units, missing values and uncapped attainment without a swatch grid", () => {
  for (const [actual, goal, expected] of [[7.7, 8, "96%"], [0, 8, "0%"], [10, 8, "125%"], [null, 8, "—"], [7.7, 0, "—"]]) {
    const html = renderToStaticMarkup(React.createElement(ProgressTooltip, { label: "Sleep", actual, goal, unit: "hours" }));
    assert.ok(html.includes(expected));
    assert.match(html, /chart-tooltip--plain/u);
    assert.match(html, /chart-tooltip-summary/u);
    assert.match(html, /hours/u);
    assert.doesNotMatch(html, /<i |data-comparison=/u);
  }
  const spec = barChartSpec({ presentation: "progress", category: "name", value: "actual", track: { max: "goal" }, unitField: "unit" });
  assert.equal(projectChartSpec(spec).barOptions.unitField, "unit");
  assert.ok(chartDataShape(spec, [{ name: "Sleep", actual: 7.7, goal: 8, unit: "hours" }]).optionalRowFields.includes("unit"));
});

test("adaptive pipeline annotations preserve both values and full stage names", () => {
  for (const annotations of ["auto", "aligned"]) {
    const html = render([{ period: "Current", discovery: 8, closed: 2 }, { period: "Prior", discovery: 6, closed: 4 }], {
      presentation: "segmented", category: "period", comparison: true, annotations,
      series: [{ key: "discovery", label: "Discovery" }, { key: "closed", label: "Closed won" }],
    });
    // Before measurement, use the readable table rather than flash overlapping callouts.
    assert.match(html, /data-callouts-fit="false"/u);
    assert.match(html, /bar-family-segment-callouts/u);
    assert.match(html, /bar-family-comparison-table/u);
    assert.match(html, /<th scope="row">Closed won<\/th><td>2<\/td><td>4<\/td>/u);
  }
});

test("aligned annotations require every current and comparison column to fit", () => {
  const roomy = { width: 160, labelWidth: 90, valueWidth: 120 };
  assert.equal(segmentCalloutsFit([roomy, roomy]), true);
  assert.equal(segmentCalloutsFit([roomy, { ...roomy, width: 72 }]), false);
  assert.equal(segmentCalloutsFit([{ ...roomy, labelWidth: 190 }, roomy]), false);
  assert.equal(segmentCalloutsFit([{ ...roomy, valueWidth: 190 }, roomy]), false);
  assert.equal(segmentCalloutsFit([{ width: 0, labelWidth: 0, valueWidth: 0 }]), false);
  assert.equal(segmentCalloutsFit([]), false);
});

test("every public library component mounts in each declared state using the real shell", () => {
  for (const name of Library.componentNames) for (const state of Library.libraryStates(name)) {
    const html = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true },
      React.createElement(Library.LibraryStory, { name, state })));
    assert.doesNotMatch(html, /No interactive case is registered/u, `${name}: ${state}`);
    if (state === "Loading") assert.match(html, /aria-busy="true"/u, name);
    // Closed portaled menu contents are not emitted by server rendering; browser coverage remains required there.
    if (state === "Disabled" && !["Menu", "MenuItem"].includes(name)) assert.match(html, /disabled|data-disabled/u, name);
  }
});

test("library chart recipes cover the actual editor types and all promoted bar presentations", () => {
  for (const type of Library.libraryChartTypes) {
    const example = Library.libraryChartCase(type);
    assert.ok(labSnapshot.queries[example.queryId].rows.some(row => example.spec.y in row), type);
    const html = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true },
      React.createElement(Library.LibraryStory, { name: "Chart", chartType: type })));
    assert.doesNotMatch(html, /Unsupported chart|NaN|Infinity/u, type);
  }
  for (const presentation of barPresentations) {
    assert.ok(Library.libraryChartChoices.includes(`bar:${presentation}`), `${presentation} is directly discoverable`);
    const html = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true },
      React.createElement(Library.LibraryStory, { name: "Chart", presentation })));
    assert.doesNotMatch(html, /Unsupported|requires|NaN|Infinity/u, presentation);
  }
});

test("retired adapters are absent and all three funnel specimens remain in the shared library", () => {
  for (const name of ["ExperimentalBarChart","Toggle"]) assert.ok(!Library.componentNames.includes(name));
  for (const id of ["sales","market","activation"]) {
    const rows = labSnapshot.queries[`funnel_${id}`].rows;
    for (let index=0;index<rows.length;index++) {
      assert.ok(rows[index].count >= 0);
      if (index) assert.ok(rows[index].count <= rows[index-1].count);
    }
    const html = renderToStaticMarkup(React.createElement(Shell, {snapshot:labSnapshot,hosted:true},
      React.createElement(Library.LibraryStory,{name:"Chart",chartType:"funnel",options:{funnelExample:id}})));
    assert.doesNotMatch(html, /Unsupported|NaN|Infinity/u);
  }
});

test("cohort-age headings and gradient-series swatches retain readable meaning", () => {
  const html = renderToStaticMarkup(React.createElement(ChartTooltip, {
    active:true, label:4, xLabel:"Weeks since activation", xField:"week",
    payload:[{dataKey:"revenue",name:"Revenue",value:258441,color:"url(#gradient)"}],
    resolveColor:()=>"#0057ff",
  }));
  assert.match(html, /<strong>Week 4<\/strong>/u);
  assert.match(html, /background:#0057ff/u);
  assert.doesNotMatch(html, /url\(#gradient\)/u);
});

test("pie hover retains category identity and explicit monetary units without an axis label", () => {
  const html = renderToStaticMarkup(React.createElement(ChartTooltip, {
    active:true, mode:"pie", xField:"category", payload:[{dataKey:"amount",name:"Amount",value:45320,payload:{category:"Stocks",amount:45320}}],
    formatValue: value => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(value),
  }));
  assert.match(html, /<strong>Stocks<\/strong>/u);
  assert.match(html, /\$45,320/u);
});

test("range indicators retain style choices without fabricating unavailable positions", () => {
  const html = render([{label:"Current",low:0,high:100,current:40}], {
    presentation:"rangePosition",category:"label",value:"current",range:["low","high"],style:{color:"var(--chart-2)",fontSize:12,gap:8},
  });
  assert.match(html, /--bar-family-range-color:var\(--chart-2\)/u);
  assert.match(html, /--bar-family-font-size:12px/u);
  assert.match(html, /40%/u);
});

test("thin grouped bars put exact values outside their clipped tracks", () => {
  const html = render([{ team: "Core", actual: 84, target: 76 }, { team: "Other", actual: 0, target: 2 }], {
    presentation: "groupedList", category: "team", value: "actual", style: { thickness: 10 },
    series: [{ key: "actual", label: "Actual" }, { key: "target", label: "Target" }],
  });
  assert.equal((html.match(/class="bar-family-grouped-value"/g) ?? []).length, 4);
  assert.match(html, /<\/span><strong class="bar-family-grouped-value">84/u);
  assert.match(html, /aria-label="Chart legend"/u);
});

test("inventory comparison does not claim an undrawn target", () => {
  const html = renderToStaticMarkup(React.createElement(Shell, { snapshot: labSnapshot, hosted: true }, React.createElement(Library.LibraryStory, { name: "Chart", state: "Default", chartType: "bar", presentation: "comparison", options: {}, onEvent: () => {} })));
  assert.match(html, /bar-family-list--comparison/u);
  assert.doesNotMatch(html, /data-track="true"/u);
  assert.equal((html.match(/class="bar-family-list-row"/g) ?? []).length, 2);
});


test("heatmap tooltip uses authored dimension labels once without losing values or maturity", () => {
  const render = unknown => renderToStaticMarkup(React.createElement(ChartTooltip, {
    active: true, mode: "heatmap", xField: "weekLabel", yField: "retention", groupField: "cohortShortLabel",
    detailFields: [{ field: "cohortShortLabel", label: "Cohort" }],
    payload: [{ payload: { weekLabel: "Week 2", cohortShortLabel: "Jun 15", retention: .287, __unknown: unknown } }],
    formatValue: value => `${(value * 100).toFixed(1)}%`,
  }));
  const html = render(false);
  assert.match(html, /Cohort<b>Jun 15<\/b>/u);
  assert.equal((html.match(/Jun 15/g) ?? []).length, 1);
  assert.doesNotMatch(html, /Short Label/u);
  assert.match(html, /28.7%/u);
  assert.match(render(true), /Not yet observed/u);
});
