import React, { useRef, useState } from "react";
import * as UI from "../../src/data-app-public.jsx";
import { chartTypeGroups } from "../../src/components/ChartExplorer.jsx";
import { barPresentations } from "../../src/charting/bar-family.js";
import { ProgressTooltip } from "../../src/charting/BarFamilyRenderer.jsx";
import { dashboardIconNames } from "../../src/components/Icon.jsx";
import { snapshot, funnelExamples, planToneColors, categoryToneColors } from "./data.js";

const aliases = { ChartRenderer: "Chart", Table: "DataTable" };
const availableDates = Array.from({ length: 28 }, (_, day) => new Date(Date.UTC(2026, 7, day + 1)).toISOString().slice(0, 10));
const groups = {
  Charts: ["Chart", "ChartRenderer", "ChartEditor", "EvidenceChart", "ChartMark", "ChartTooltip"],
  Metrics: ["MetricCard", "MetricCardTabs", "MetricSparkline"],
  Controls: ["DateRangePicker", "Dropdown", "NativeSelect", "Filters", "InlineFilters", "SegmentedControl", "Switch", "Slider", "RangeSlider"],
  Content: ["QueryDataBoundary", "DataComponent", "DataTable", "Table", "ExecutiveSummary", "EditableText", "ReportSection", "RichNarrative", "Section", "SectionHeader", "SectionNavigator", "Icon"],
  Interaction: ["Button", "Dialog", "ContainedDialog", "InfoTooltip", "Menu", "MenuItem", "MenuSub", "MenuGroup", "MenuSeparator", "Tooltip", "TruncatedText", "Tabs", "TabPanel", "SourceInspector", "SourceSidebar", "SortableItem", "SortableRegion"],
};
const groupOf = name => aliases[name] ? "Aliases" : Object.keys(groups).find(group => groups[group].includes(name)) ?? "Missing demo";
const notes = {
  Chart: "Supported chart forms and bar presentations, side by side. Hover/focus marks, select them, then dismiss with click-away/Escape. Each card retains source inspection and editing.",
  ChartEditor: "Shared chart preview, draft history, save and cancel. The caller supplies dialog/select controls and owns persistence; this example keeps edits in the current view.",
  EvidenceChart: "A shared chart with source actions, edited spec, persisted legend/zoom and visibility connected. Authors choose its rows, sizing, controls and surrounding layout.",
  ChartMark: "Native keyboard-focusable mark with the shared hover-to-selection action card. Activate with Enter/Space; Escape dismisses.",
  ChartTooltip: "The same tooltip content used by progress charts, shown persistently here for inspection—not a replacement implementation.",
  Dropdown: "Select one or several options; searchable mode supports typing and keyboard navigation. Empty multi-selection means no restriction. A disabled prop is not currently exposed.",
  NativeSelect: "A native single-selection control for contained hosts. It shares the reviewed-choice contract without a portaled menu.",
  DateRangePicker: "The same date control used by Filters: data-bounded presets and a custom range calendar. Historical snapshots use their loaded dates, not today. The caller applies the emitted range to its data.",
  Filters: "Controlled tab/section filter values; clears affect only their declared scope. The event readout shows the selection; charts or tables are separate consumers.",
  InlineFilters: "Controlled categorical filter. The caller applies its selected value to the appropriate data; no table is part of the component.",
  SegmentedControl: "Single/multiple selection, disabled state, compact/theme-default sizing. Named options avoid color-only meaning.",
  Switch: "Controlled boolean state and native switch semantics. Space toggles; disabled prevents changes.",
  Slider: "Controlled numeric range. Arrow keys change one step; Home/End reach bounds. Disabled is a real input state.",
  RangeSlider: "Two independently focusable range inputs with ordering and minimum-distance constraints.",
  DataTable: "Search, sortable columns, numeric formatting, pagination, and whole-row selection. The selected record appears below.",
  MetricCard: "Value, delta, sparkline, component actions and shared geometry-preserving loading/error states.",
  MetricCardTabs: "Controlled selection, three densities, horizontal/vertical layout and arrow/Home/End navigation.",
  MetricSparkline: "Compact trend without axes or a separate hover interaction; negative changes its semantic treatment.",
  ExecutiveSummary: "Optional controlled/uncontrolled disclosure. It is not automatically inserted into dashboards.",
  ReportSection: "Source-backed report section with optional headings/actions and one or several reviewed queries. Use RichNarrative for editable prose.",
  RichNarrative: "Markdown-backed rich text with shared inline formatting, links, lists, and safe source previews. Use the shell Edit mode; reviewed values remain read-only.",
  EditableText: "Authored narrative becomes editable in the shell's Edit mode. Reviewed values remain read-only.",
  QueryDataBoundary: "Waits for the declared complete queries before mounting query-dependent content. This loaded example keeps the native table search, sorting and source actions; hosted on-demand apps also show loading and retry states.",
  DataComponent: "The shared wrapper owns actions, source scope, title editing and loading. Skeleton/error are real component states.",
  Section: "Shared heading, content spacing and scoped filter slot. Filtering below is performed by the caller.",
  SectionHeader: "Stable editable heading and inline controls; controls wrap when necessary. Edit mode exposes heading actions.",
  SectionNavigator: "Optional section-jump rail for a long page. Hover or click to open; keyboard navigation, Escape, click-away and active-section tracking use the shared menu. Auto placement hides unless the rail and expanded menu fit outside the content; this isolated demo explicitly uses inline placement.",
  Tabs: "Local views inside a section or inspector, with linked panels and arrow/Home/End navigation. Dashboard-level navigation belongs to the shell, which also owns tab filters and persistence.",
  TabPanel: "The content region belonging to a tab. It connects to Tabs through accessible IDs and mounts its children only when active; it is not another navigation control.",
  Menu: "The public menu and MenuItem primitives provide keyboard navigation, selection, dismissal and disabled items.",
  MenuItem: "Used inside Menu, not as an unrelated standalone button.",
  Tooltip: "Transient explanatory text on hover and keyboard focus. Interactive content belongs in a menu or dialog instead.",
  SourceInspector: "Reviewed rows, source metadata and definitions. All evidence here is a synthetic Lab fixture.",
  SourceSidebar: "Open the real source sidebar, then inspect its tabs or close with Escape/backdrop/close button.",
  SortableRegion: "Switch the shell to Edit to test pointer/keyboard reordering. This freeform composition does not impose canvas sizing rules.",
  SortableItem: "A stable movable block inside the shared region. Presentation persistence is owned by the shell.",
  Icon: "All bundled product icons, using the real Icon component. Select one to see its API name; icons are decorative unless their parent control supplies an accessible label.",
  Button: "Shared button styling with native button and disabled behavior.",
  Dialog: "Modal content with focus containment, Escape/backdrop dismissal and focus restoration.",
  ContainedDialog: "A nonmodal dialog within its caller's layout, with local keyboard handling and focus restoration. The caller provides its surrounding layout styles.",
  InfoTooltip: "Shared information trigger with explanatory tooltip on pointer hover or keyboard focus.",
  TruncatedText: "Reveals the full text after a short hover delay, only when its label is clipped. Editing suppresses the tooltip.",
  MenuSub: "A nested menu, including keyboard navigation and collision-aware placement.",
  MenuGroup: "A labeled group of menu actions; displayed inside its parent menu.",
  MenuSeparator: "A visual divider between related menu action groups.",
};

export const componentNames = Object.keys(UI).filter(name => /^[A-Z]/u.test(name)).sort();
export const libraryChartTypes = chartTypeGroups.flatMap(group => group.choices);
export const libraryChartChoices = [...libraryChartTypes, ...barPresentations.map(name => `bar:${name}`)];
const presentationLabels = { plot: "Bar plot + markers/ranges", bullet: "Bullet / target", segmented: "Segmented composition",
  groupedList: "Grouped bar list", rankedList: "Ranked bar list", progress: "Progress", comparison: "Large-value comparison", rangePosition: "Low / high / current" };
const chartChoiceLabels = Object.fromEntries(libraryChartChoices.map(choice => [choice,
  choice.startsWith("bar:") ? presentationLabels[choice.slice(4)] : choice.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/100$/, " (100%)")]));
export function libraryStates(name) {
  name = aliases[name] ?? name;
  if (name === "DateRangePicker") return ["Default", "Empty", "Disabled"];
  if (["Chart", "EvidenceChart", "DataComponent", "MetricCard"].includes(name)) return ["Default", "Empty", "Loading", "Error", "Long labels"];
  if (["Button", "NativeSelect", "Switch", "SegmentedControl", "Slider", "RangeSlider", "Menu", "MenuItem"].includes(name)) return ["Default", "Disabled", "Long labels"];
  if (["DataTable", "Dropdown", "Filters", "InlineFilters"].includes(name)) return ["Default", "Empty", "Long labels"];
  return ["Default"];
}

export function libraryChartCase(type) {
  const s = { type, showXAxisLabel: false, showYAxisLabel: false };
  if (["line", "area", "sparkline"].includes(type)) return { queryId: "weekly_activity", spec: { ...s, x: "week", y: "activeTeams" } };
  if (type === "stackedArea") return { queryId: "weekly_composition", spec: { ...s, x: "week", y: "activeTeams", series: "plan", colors: planToneColors } };
  if (/StackedBar|stackedBar/.test(type)) return { queryId: "account_composition", spec: { ...s, x: "region", y: "accounts", series: "plan", colors: planToneColors } };
  if (type === "histogram") return { queryId: "response_distribution", spec: { ...s, x: "team", y: "responseMinutes" } };
  if (type === "scatter") return { queryId: "team_relationship", spec: { ...s, x: "weeklyUsers", y: "tasksPerUser", labelField: "team" } };
  if (type === "heatmap") return { queryId: "request_intensity", spec: { ...s, x: "day", series: "period", y: "requests" } };
  if (type === "boxPlot") return { queryId: "segment_distribution", spec: { ...s, x: "segment", y: "responseMinutes" } };
  if (type === "waterfall") return { queryId: "revenue_bridge", spec: { ...s, x: "driver", y: "change" } };
  if (type === "funnel") return { queryId: "activation_funnel", spec: { ...s, x: "stage", y: "accounts" } };
  if (type === "sankey") return { queryId: "account_flows", spec: { ...s, x: "source", y: "accounts", stages: ["source", "product", "outcome"] } };
  return { queryId: "category_performance", spec: { ...s, x: "segment", y: "value" } };
}

export function LibraryStory({ name, title, state = "Default", chartType = "bar", presentation = "standard", options = {}, onRetry, onEvent = () => {} }) {
  const shell = UI.useDataApp();
  const [single, setSingle] = useState("all"), [multi, setMulti] = useState([]), [checked, setChecked] = useState(true);
  const multiple = Boolean(options.multiple), searchable = Boolean(options.searchable);
  const [value, setValue] = useState(64), [range, setRange] = useState([25, 80]);
  const [tab, setTab] = useState("first"), [selectedRow, setSelectedRow] = useState(null), [sidebar, setSidebar] = useState(false);
  const [hover, setHover] = useState(false), [dialog, setDialog] = useState(false);
  const [editedChart, setEditedChart] = useState({ type: "bar", x: "segment", y: "value" });
  const [dateRange, setDateRange] = useState("2026-08-01..2026-08-28");
  const canonical = aliases[name] ?? name;
  const disabled = state === "Disabled", empty = state === "Empty", long = state === "Long labels";
  const queryId = "category_performance";
  const rows = empty ? [] : snapshot.queries[queryId].rows.map(row => long ? { ...row, segment: `${row.segment} — international customer success and platform operations` } : row);
  const choices = ["all", ...rows.map(row => row.segment)];
  const change = (setter, label) => next => { setter(next); onEvent(`${label}: ${JSON.stringify(next)}`); };
  const filtered = rows.filter(row => multiple ? !multi.length || multi.includes(row.segment) : single === "all" || row.segment === single);
  const component = { id: "library-preview", title: long ? `${title ?? name} for international customer success and platform operations` : title ?? `${name} example`, queryId, kind: "table", sourceRows: rows, displayRows: rows };
  const table = <UI.DataTable rows={filtered} rowKey="segment" selectedRowKey={selectedRow}
    onRowSelect={row => { setSelectedRow(row.segment); onEvent(`Selected ${row.segment}`); }} rowActionLabel={row => `Inspect ${row.segment}`} />;

  if (canonical === "Chart" || canonical === "EvidenceChart") {
    const example = libraryChartCase(chartType);
    let spec = example.spec, sourceRows = snapshot.queries[example.queryId].rows;
    if (chartType === "funnel" && options.funnelExample && options.funnelExample !== "default") {
      const specimen = funnelExamples.find(example => example.id === options.funnelExample);
      if (specimen) {
        example.queryId = `funnel_${specimen.id}`;
        sourceRows = snapshot.queries[example.queryId].rows;
        spec = { ...spec, y: "count", colors: specimen.colors };
      }
    }
    if (chartType === "line" && options.gradient) spec = {...spec,lineGradients:Object.fromEntries(
      (spec.fields ?? [spec.y]).map((field,index) => [field,[`var(--chart-${index+1})`,`color-mix(in srgb, var(--chart-${index+1}) 40%, var(--surface))`]]))};
    if (presentation !== "standard") {
      example.queryId = "category_performance";
      sourceRows = snapshot.queries.category_performance.rows;
      spec = UI.barChartSpec({ presentation, category: "segment", value: "value",
        ...(["bullet", "plot"].includes(presentation) ? { target: "target" } : {}),
        ...(presentation === "progress" ? { track: { max: "target" } } : {}),
        ...(presentation === "progress" && options.segmentedTrack ? {style:{segments:10, thickness:7}} : {}),
        ...(presentation === "groupedList" ? { series: [{ key: "value", label: "Actual", color: "var(--chart-1)", colors: sourceRows.map(row => categoryToneColors[row.segment]) },
          { key: "target", label: "Target", color: "color-mix(in srgb, var(--text) 16%, var(--surface))" }], style: { thickness: 12, radius: 6, gap: 12 } } : {}),
        ...(presentation === "rankedList" ? { style: { color: "color-mix(in srgb, var(--text) 9%, transparent)", textColor: "var(--text)", thickness: 36, radius: 8, gap: 8 } } : {}) });
      if (presentation === "comparison") {
        sourceRows = sourceRows.slice(0, 2);
        spec = UI.barChartSpec({ presentation, category: "segment", value: "value",
          labels: { position: "above" }, style: { thickness: 32, radius: 6 } });
      }
      if (presentation === "segmented") {
        example.queryId = "team_capacity_mix";
        const facts = snapshot.queries.team_capacity_mix.rows.filter(row => row.team === "Core product");
        sourceRows = [{ team: "Core product", ...Object.fromEntries(facts.map(row => [row.workType, row.share])) }];
        spec = UI.barChartSpec({ presentation, category: "team", series: facts.map((row, index) => ({ key: row.workType, label: row.workType,
          color: `color-mix(in srgb, var(--chart-1) ${100 - index * 24}%, var(--surface))` })), annotations: true });
      }
      if (presentation === "rangePosition") {
        example.queryId = "range_positions";
        sourceRows = snapshot.queries.range_positions.rows;
        spec = UI.barChartSpec({ presentation, category: "label", value: "current", range: ["low", "high"] });
      }
    }
    // State fixtures are derived copies; the immutable bundled snapshot is never edited.
    const id = `library-chart-${chartType}-${presentation}${options.funnelExample ? `-${options.funnelExample}` : options.gradient ? "-gradient" : options.segmentedTrack ? "-segmented" : ""}`;
    spec = shell.chartOverrides[id] ?? spec;
    const displayRows = empty ? [] : long ? sourceRows.map(row => typeof row[spec.x] === "string" && !/^\d{4}-/.test(row[spec.x])
      ? { ...row, [spec.x]: `${row[spec.x]} — long category label for responsive inspection` } : row) : sourceRows;
    return <UI.EvidenceChart {...component} id={id} queryId={example.queryId} spec={spec}
      sourceRows={displayRows} rows={displayRows} variant="card" height={280} onRetry={onRetry} loading={state === "Loading"} loadingError={state === "Error"}
      chartOptions={{ getMarkActions: ({ row }) => [{ label: "Inspect this observation", onSelect: () => onEvent(JSON.stringify(row)) }] }} />;
  }
  if (canonical === "QueryDataBoundary") return <UI.QueryDataBoundary queryIds={["category_performance"]}><QueryBoundaryContent /></UI.QueryDataBoundary>;
  if (canonical === "DateRangePicker") return <div className="library-isolated-control"><UI.DateRangePicker value={dateRange} choices={empty ? [] : availableDates} disabled={disabled} onChange={change(setDateRange, "Date range")} /></div>;
  if (canonical === "SectionNavigator") return <div className="library-section-navigation">
    <UI.SectionNavigator placement="inline" sections={[{id:"library-section-first",label:"Overview"},{id:"library-section-second",label:"Details"}]} />
    <section id="library-section-first"><h3>Overview</h3><p>Scroll or use Sections to move between these content regions.</p></section>
    <section id="library-section-second"><h3>Details</h3><p>Navigation moves focus here without changing filters or dashboard tabs.</p></section>
  </div>;
  if (canonical === "Dropdown") return <div className="library-isolated-control"><UI.Dropdown key={`${multiple}-${searchable}`} label="Segment" showLabel multiple={multiple} searchable={searchable}
    value={multiple ? multi : single} choices={choices} onChange={change(multiple ? setMulti : setSingle, "Selection")} /></div>;
  if (canonical === "NativeSelect") return <div className="library-isolated-control"><UI.NativeSelect label="Segment"
    value={single} choices={choices} disabled={disabled} onChange={change(setSingle, "Selection")} /></div>;
  if (canonical === "Filters" || canonical === "InlineFilters") return <>
    {canonical === "Filters" ? <UI.Filters filters={[{ id: "segment", label: "Segment", field: "segment", queryIds: [queryId] }]}
      queries={{ [queryId]: { rows } }} values={{ segment: single }} onChange={(_id, next) => change(setSingle, "Filter")(next)} />
      : <UI.InlineFilters label="Segment" field="segment" rows={rows} value={single} onChange={change(setSingle, "Filter")} />}</>;
  if (canonical === "SegmentedControl") return <div className="library-isolated-control"><UI.SegmentedControl disabled={disabled} size={options.compact ? "compact" : "default"} ariaLabel="Segment selection"
      selectionMode={multiple ? "multiple" : "single"} value={multiple ? multi : single} onChange={change(multiple ? setMulti : setSingle, "Selection")}
      options={choices.slice(0, 4).map(choice => ({ value: choice, label: choice === "all" ? "All" : choice }))} /></div>;
  if (canonical === "Switch") return React.createElement(UI[name], { label: long ? "Compare against the corresponding previous reporting period" : "Previous period",
    checked, disabled, onChange: change(setChecked, "Enabled") });
  if (canonical === "Slider" || canonical === "RangeSlider") return React.createElement(UI[canonical], {
    label: long ? "Capacity reserved for the selected planning period" : "Capacity", disabled, min: 0, max: 100,
    value: canonical === "Slider" ? value : range, onChange: change(canonical === "Slider" ? setValue : setRange, "Capacity"), formatValue: n => `${n}%`, showBounds: true });
  if (canonical === "DataTable") return <>{table}{selectedRow && <p role="status">Selected: {selectedRow}</p>}</>;
  if (canonical === "MetricCard") return <UI.MetricCard {...component} value={empty ? "—" : "84"} comparison={empty ? undefined : "+10.5%"} deltaTone={options.deltaTone ?? "positive"}
    trendValues={empty ? [] : [60, 64, 70, 76, 84]} onRetry={onRetry} loading={state === "Loading"} loadingError={state === "Error"} />;
  if (canonical === "MetricSparkline") return <UI.MetricSparkline values={options.negative ? [84, 76, 70, 64, 60] : [60, 64, 70, 76, 84]} negative={options.negative} />;
  if (canonical === "MetricCardTabs") return <UI.MetricCardTabs items={[{ id: "first", title: "Enterprise", value: "84", trendValues: [60, 76, 84] },
      { id: "second", title: "Growth", value: "69", trendValues: [50, 62, 69] }]} selectedId={tab} onChange={change(setTab, "Metric")}
      size={options.size ?? "medium"} orientation={options.vertical ? "vertical" : "horizontal"}>{({ item }) => <p>{item.title}: {item.value}</p>}</UI.MetricCardTabs>;
  if (canonical === "ExecutiveSummary") return <UI.ExecutiveSummary preview="Synthetic example · expandable summary" onOpenChange={next => onEvent(`Expanded: ${next}`)}>
    <p>Use this optional disclosure only when the dashboard explicitly needs a written readout.</p></UI.ExecutiveSummary>;
  if (canonical === "DataComponent") return <UI.DataComponent {...component} variant="card" onRetry={onRetry} loading={state === "Loading"} loadingError={state === "Error"}>{table}</UI.DataComponent>;
  if (["ReportSection", "RichNarrative"].includes(canonical)) return <UI.ReportSection {...component} showHeading={false}>
    <UI.RichNarrative id="library-rich-narrative" value="## Authored report narrative\n\nUse **Edit** to format this sentence, add a list, or link supporting evidence. The section retains its reviewed source and shared actions." />
  </UI.ReportSection>;
  if (canonical === "EditableText") return <UI.DataComponent {...component} kind="text" variant="card"><UI.EditableText data-editable-id="library-narrative">Switch to Edit and change this authored sentence.</UI.EditableText></UI.DataComponent>;
  if (["Section", "SectionHeader"].includes(canonical)) return <UI.Section id="library-section" title="Customer segments" spacing="content"
    filters={<UI.Dropdown label="Segment" value={single} choices={choices} onChange={change(setSingle, "Section filter")} />}>{table}</UI.Section>;
  if (["Tabs", "TabPanel"].includes(canonical)) return <><UI.Tabs id="library-tabs" label="Example views" items={[{ id: "first", label: "Summary" }, { id: "second", label: "Records" }]}
    value={tab} onChange={change(setTab, "Tab")} /><UI.TabPanel tabsId="library-tabs" tabId="first" active={tab === "first"}>Summary panel</UI.TabPanel>
    <UI.TabPanel tabsId="library-tabs" tabId="second" active={tab === "second"}>{table}</UI.TabPanel></>;
  if (canonical === "Button") return <div className="library-isolated-control"><UI.Button disabled={disabled} onClick={() => onEvent("Button clicked")}>{long ? "Inspect the complete selected observation" : "Inspect"}</UI.Button></div>;
  if (canonical === "Dialog") return <><UI.Button onClick={() => setDialog(true)}>Open dialog</UI.Button><UI.Dialog open={dialog} title="Example dialog" onClose={() => setDialog(false)}><p>Dialog content. Press Escape or close to return.</p></UI.Dialog></>;
  if (canonical === "ContainedDialog") return <><UI.Button onClick={() => setDialog(true)}>Open contained dialog</UI.Button>
    {dialog && <UI.ContainedDialog title="Contained example" layerClassName="library-contained-dialog" onClose={() => setDialog(false)}>
      <p>This dialog stays in the example's layout. Press Escape or close to return.</p>
    </UI.ContainedDialog>}</>;
  if (canonical === "ChartEditor") return <><UI.ChartRenderer spec={editedChart} rows={rows} height={280} />
    <UI.Button onClick={() => setDialog(true)}>Edit chart</UI.Button>
    {dialog && <UI.ChartEditor component={{ ...component, kind: "chart", chart: editedChart }} getRows={() => rows}
      DialogComponent={UI.Dialog} SelectComponent={UI.Dropdown} TooltipComponent={UI.Tooltip}
      onClose={() => setDialog(false)} onSave={change(setEditedChart, "Chart")} />}</>;
  if (canonical === "InfoTooltip") return <div className="library-isolated-control"><UI.InfoTooltip>Additional context for this control.</UI.InfoTooltip></div>;
  if (canonical === "TruncatedText") return <UI.TruncatedText className="library-truncated-example" tabIndex={0}>International customer success and platform operations</UI.TruncatedText>;
  if (["Menu", "MenuItem", "MenuSub", "MenuGroup", "MenuSeparator"].includes(canonical)) return <UI.Menu label="Example actions" trigger={<button className="filter-trigger">Open menu</button>}>
    <UI.MenuGroup label="Data">
    <UI.MenuItem disabled={disabled} onSelect={() => onEvent("Inspect action selected")}>{long ? "Inspect the complete selected observation" : "Inspect"}</UI.MenuItem>
    </UI.MenuGroup><UI.MenuSeparator /><UI.MenuSub label="More actions"><UI.MenuItem onSelect={() => onEvent("Nested action selected")}>Nested action</UI.MenuItem></UI.MenuSub></UI.Menu>;
  if (canonical === "Tooltip") return <span className="library-tooltip-trigger"><button className="filter-trigger"
    onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
    aria-describedby={hover ? "library-tooltip" : undefined}>Hover or focus</button>{hover && <UI.Tooltip id="library-tooltip" visible>Additional context</UI.Tooltip>}</span>;
  if (canonical === "ChartTooltip") return <ProgressTooltip label="Sleep" actual={7.7} goal={8} unit="hours" />;
  if (canonical === "ChartMark") return <UI.DataComponent {...component} variant="card"><div data-chart-interaction-root>
    <UI.ChartMark className="filter-trigger" context={{ kind: "chart", chartType: "bar", row: rows[0], label: "Enterprise", value: 84,
      actions: [{ label: "Inspect Enterprise", onSelect: () => onEvent("Enterprise action selected") }] }}
      tooltip={<UI.ChartTooltip active label="Enterprise" details={[{ label: "Accounts", value: "84" }]} />}>Enterprise · 84</UI.ChartMark>
  </div></UI.DataComponent>;
  if (canonical === "SourceInspector") return <UI.SourceInspector component={component} query={snapshot.queries[queryId]} rows={rows} filters={[]} />;
  if (canonical === "SourceSidebar") return <><button className="filter-trigger" onClick={() => setSidebar(true)}>Open source sidebar</button>
    {sidebar && <UI.SourceSidebar component={component} getSource={() => ({ query: snapshot.queries[queryId], rows, filters: [] })} onClose={() => setSidebar(false)} />}</>;
  if (["SortableRegion", "SortableItem"].includes(canonical)) return <UI.SortableRegion id="library-sortable" variant="freeform" label="Library movable blocks" className="library-sortable">
    {["first", "second"].map(id => <UI.SortableItem key={id} id={`library-${id}`} kind="table"><UI.DataComponent {...component} id={`library-${id}`} title={`${id} block`} variant="card">{table}</UI.DataComponent></UI.SortableItem>)}
  </UI.SortableRegion>;
  if (canonical === "Icon") return <IconLibrary onEvent={onEvent} />;
  return <p>No interactive case is registered for this export yet.</p>;
}

function QueryBoundaryContent() {
  const { queries } = UI.useDataApp();
  const rows = queries.category_performance.rows;
  return <UI.DataComponent id="library-query-boundary" title="Query-backed table" queryId="category_performance"
    kind="table" sourceRows={rows} displayRows={rows} variant="card"><UI.DataTable rows={rows} rowKey="segment" /></UI.DataComponent>;
}

function IconLibrary({ onEvent }) {
  const [search, setSearch] = useState(""), [size, setSize] = useState(20);
  const names = dashboardIconNames.filter(name => name.toLowerCase().includes(search.toLowerCase()));
  return <><div className="library-properties"><input type="search" aria-label="Find an icon" placeholder="Find an icon" value={search} onChange={event => setSearch(event.target.value)} />
    <UI.Dropdown label="Icon size" showLabel choices={[16, 20, 24]} value={size} onChange={setSize} /></div>
    <div className="library-icon-grid">{names.map(name => <button type="button" key={name} onClick={() => onEvent(`Icon name: ${name}`)}>
      <UI.Icon name={name} size={size} /><span>{name}</span></button>)}</div>
    {!names.length && <p>No matching icons.</p>}</>;
}

export function LibraryChartGallery({ state = "Default", width = 480, onRetry, onEvent }) {
  const [search, setSearch] = useState("");
  const variants = [
    ...chartTypeGroups.map(group => ({ ...group, examples: group.choices.map(choice => ({ choice, chartType: choice, title: chartChoiceLabels[choice] })) })),
    { label: "Bar presentations", examples: barPresentations.map(presentation => ({ choice: `bar:${presentation}`, title: presentationLabels[presentation], chartType: "bar", presentation })) },
    { label: "Additional styling and data shapes", examples: [
      { choice: "gradient", title: "Gradient line", chartType: "line", options: { gradient: true } },
      { choice: "segmented-progress", title: "Segmented progress", chartType: "bar", presentation: "progress", options: { segmentedTrack: true } },
      ...funnelExamples.map(example => ({ choice: example.id, title: example.title, chartType: "funnel", options: { funnelExample: example.id } })),
    ] },
  ];
  const match = example => `${example.title} ${example.choice}`.toLowerCase().includes(search.toLowerCase());
  return <div className="library-chart-gallery">
    <input className="library-search" type="search" aria-label="Find a chart variation" placeholder="Find a chart variation" value={search} onChange={event => setSearch(event.target.value)} />
    {variants.map(group => {
      const examples = group.examples.filter(match);
      return examples.length ? <section className="library-chart-family" key={group.label} aria-label={group.label}>
        <h3>{group.label}</h3>
        <div className="library-chart-grid" style={{ "--library-card-width": `${width}px` }}>
          {examples.map(example => <LibraryStory key={example.choice} name="Chart" state={state} {...example} onRetry={onRetry} onEvent={onEvent} />)}
        </div>
      </section> : null;
    })}
    {!variants.some(group => group.examples.some(match)) && <p>No matching chart variations.</p>}
  </div>;
}

export function LibraryInventory({ barExamples, composedExamples }) {
  const [selected, setSelected] = useState(() => {
    const previousTab = new URLSearchParams(globalThis.location?.search ?? "").get("tab");
    return previousTab === "bar-experiments" && barExamples ? "Bar examples" : previousTab === "overview" && composedExamples ? "Composed examples" : "Chart";
  });
  const [search, setSearch] = useState(""), [navigationOpen, setNavigationOpen] = useState(false);
  const [state, setState] = useState("Default"), [width, setWidth] = useState(480);
  const [event, setEvent] = useState(""), [reset, setReset] = useState(0), [options, setOptions] = useState({});
  const detail = useRef(null);
  const canonical = aliases[selected] ?? selected;
  const composed = selected === "Bar examples" ? barExamples : selected === "Composed examples" ? composedExamples : null;
  const extraNames = [...(barExamples ? ["Bar examples"] : []), ...(composedExamples ? ["Composed examples"] : [])];
  const names = [...componentNames, ...extraNames];
  const groupFor = name => extraNames.includes(name) ? "Compositions" : groupOf(name);
  const properties = canonical === "Dropdown" ? ["multiple", "searchable"] : canonical === "SegmentedControl" ? ["multiple", "compact"]
    : canonical === "MetricSparkline" ? ["negative"] : canonical === "MetricCardTabs" ? ["vertical"] : [];
  const select = name => {
    setSelected(name); setState("Default"); setOptions({}); setEvent(""); setNavigationOpen(false);
    requestAnimationFrame(() => { detail.current?.scrollIntoView({ block: "start" }); detail.current?.focus({ preventScroll: true }); });
  };
  return <div className="component-library">
    <aside className="library-navigation" aria-label="Public component library" data-expanded={navigationOpen}>
      <button className="library-nav-toggle filter-trigger" type="button" aria-expanded={navigationOpen} aria-controls="library-nav-content" onClick={() => setNavigationOpen(open => !open)}>Components · {selected}<UI.Icon name="chevronDown" /></button>
      <div className="library-nav-content" id="library-nav-content">
        <input className="library-search" type="search" aria-label="Find a component" placeholder="Find a component" value={search} onChange={e => setSearch(e.target.value)} />
        <nav className="library-nav-items" aria-label="Components">
          {!names.some(name => name.toLowerCase().includes(search.toLowerCase())) && <p>No matching components. <button type="button" onClick={() => setSearch("")}>Clear search</button></p>}
          {[...Object.keys(groups), "Compositions", "Missing demo", "Aliases"].map(group => {
            const matches = names.filter(name => groupFor(name) === group && name.toLowerCase().includes(search.toLowerCase()));
            const buttons = matches.map(name => <button type="button" aria-pressed={selected === name} key={name} onClick={() => select(name)}>{name}</button>);
            return !matches.length ? null : group === "Aliases" ? <details key={group} open={Boolean(search) || Boolean(aliases[selected]) || undefined}><summary>{group}</summary>{buttons}</details>
              : <div key={group}><h3>{group}</h3>{buttons}</div>;
          })}
        </nav>
      </div>
    </aside>
    <section className="library-detail" ref={detail} tabIndex={-1} aria-label={selected}>
      <h2 className="library-title">{selected}</h2>
      <p>{composed ? "Examples composed from shared components; these are not additional public component APIs." : `${aliases[selected] ? `Alias for ${canonical}. ` : ""}${notes[canonical] ?? "Dedicated behavior documentation is still needed."}`}</p>
      {!composed && <>
        <div className="library-controls">
          {libraryStates(selected).length > 1 && <UI.Dropdown label="State" showLabel value={state} choices={libraryStates(selected)} onChange={setState} />}
          <button type="button" className="filter-trigger" onClick={() => { setReset(value => value + 1); setOptions({}); setEvent("Example controls reset."); }}>Reset controls</button>
        </div>
        {canonical !== "Icon" && <div className="library-width"><UI.Slider label={canonical === "Chart" ? "Minimum card width" : "Maximum preview width"} min={280} max={1200} step={40} value={width} onChange={setWidth} formatValue={n => `${n}px`} /></div>}
        {(properties.length > 0 || canonical === "MetricCardTabs" || canonical === "MetricCard") && <details className="library-settings"><summary>Example settings</summary><div className="library-properties">
          {canonical === "MetricCard" && <UI.Dropdown label="Delta meaning" showLabel choices={["positive", "negative", "neutral"]} value={options.deltaTone ?? "positive"} onChange={deltaTone => setOptions(current => ({ ...current, deltaTone }))} />}
          {properties.map(key => <UI.Switch key={key} label={key[0].toUpperCase() + key.slice(1)} checked={Boolean(options[key])} onChange={value => setOptions(current => ({ ...current, [key]: value }))} />)}
          {canonical === "MetricCardTabs" && <UI.Dropdown label="Density" showLabel choices={["small", "medium", "large"]} value={options.size ?? "medium"} onChange={size => setOptions(current => ({ ...current, size }))} />}
        </div></details>}
      </>}
      {composed ?? (canonical === "Chart" ? <LibraryChartGallery key={reset} state={state} width={width} onRetry={() => setState("Default")} onEvent={setEvent} /> :
        <div className="library-preview" style={{ maxWidth: width }}><LibraryStory key={`${selected}:${reset}`} name={selected} state={state} options={options} onRetry={() => setState("Default")} onEvent={setEvent} /></div>)}
      {event && <output className="library-event" aria-live="polite">{event}</output>}
      {!composed && <details><summary>Supported states</summary><p>State controls expose: {libraryStates(selected).join(", ")}. Test hover, keyboard focus, menus and selected marks directly. Use the shell's theme selector and View/Edit control.</p></details>}
      <details><summary>Shared versus custom</summary><p>All eight bar presentations use Chart. Portfolio breakdowns and pipeline comparisons compose those same primitives. OHLC + volume, trade planning and invoice workflows remain example-specific. Table-cell visuals, shell navigation, canvas resizing and host publication need integration checks beyond these isolated stories.</p></details>
    </section>
  </div>;
}
