import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ChartRenderer } from "../base/src/charting/ChartRenderer.jsx";
import { renderLiveChartImage } from "../base/src/chart-image.js";
import { reviewedRowsAsTsv } from "../base/src/source-provenance.js";
import { ChartEditor } from "../base/src/components/ChartEditor.jsx";
import { ContainedDialog } from "../base/src/components/contained-ui.jsx";
import { Icon, prepareDashboardIcons } from "../base/src/components/Icon.jsx";
import { semanticColorResolver } from "../base/src/charting/chart-theme.js";
import { InfoTooltip, Menu, MenuItem, MenuSeparator, Select, useInputModality } from "../base/src/components/ui.jsx";
import dashboardStyles from "../base/src/styles.css?inline";
import {
  inlineChartEditorCapabilities,
  originalInlineChartPresentation,
  validateInlineChartPresentation,
} from "./chart-presentation.js";
import inlineStyles from "./inline.css?inline";

import { copySelection, copyPng } from "./clipboard.js";

const mountedCharts = new WeakMap();

function scopeDashboardStyles(styles) {
  return styles.replace(/:root((?:\[[^\]]+\]|:(?:is|not|where)\([^)]*\))*)/gu, (_, conditions) =>
    conditions ? `:host(${conditions})` : ":host",
  );
}

function chartMappingKey(chart) {
  return JSON.stringify([
    chart.type,
    chart.x,
    chart.y,
    chart.series ?? "",
    chart.fields ?? [chart.y],
    chart.barFields ?? [],
    chart.source ?? null,
    chart.target ?? null,
    chart.stages ?? [],
  ]);
}

function InlineChart({ host, payload }) {
  useInputModality(host);
  useEffect(() => {
    // The dark menu hover token differs from its surface. Mirror the resolved
    // host scheme so shared dashboard selectors also apply inside Shadow DOM.
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    const previous = host.getAttribute("data-color-scheme");
    const media = win.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const scheme = win.getComputedStyle(host).colorScheme;
      host.dataset.colorScheme = scheme === "dark" || scheme === "light"
        ? scheme : media.matches ? "dark" : "light";
    };
    const observer = new win.MutationObserver(sync);
    for (let element = host; element; element = element.parentElement) {
      observer.observe(element, { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-color-mode"] });
    }
    media.addEventListener("change", sync);
    sync();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", sync);
      if (previous === null) host.removeAttribute("data-color-scheme");
      else host.setAttribute("data-color-scheme", previous);
    };
  }, [host]);
  const { component, rows, query, height } = payload;
  const originalPresentation = useMemo(() => originalInlineChartPresentation(component), [component]);
  const [presentation, setPresentation] = useState(originalPresentation);
  const titleTailParts = presentation.description
    ? /^(.*\s)(\S+)$/us.exec(presentation.title) ?? ["", "", presentation.title] : null;
  const actionsTrigger = useRef(null);
  const nativeActions = useRef(null);
  const visibleActions = () => nativeActions.current?.getBoundingClientRect().width
    ? nativeActions.current : actionsTrigger.current;
  const card = useRef(null);
  const [actionStatus, setActionStatus] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState(null);
  const [zoomRange, setZoomRange] = useState(null);
  const appliedComponent = useMemo(() => ({ ...component, ...presentation }), [component, presentation]);
  const mappingKey = chartMappingKey(presentation.chart);
  const previewHeight = Math.min(360, Math.max(240, height ?? 280));
  const resolveColor = useMemo(() => semanticColorResolver({ [component.queryId]: query }), [component.queryId, query]);
  const getRows = useCallback(() => rows, [rows]);
  const getCapabilities = useCallback(
    (draftChart) => inlineChartEditorCapabilities(component, rows, draftChart),
    [component, rows],
  );
  const validatePresentation = useCallback(
    (candidate) => validateInlineChartPresentation(component, rows, candidate),
    [component, rows],
  );
  const wasEditorOpen = useRef(false);
  useLayoutEffect(() => {
    // Restore focus after React removes inert, not before a deferred commit.
    if (wasEditorOpen.current && !editorOpen) visibleActions()?.focus({ preventScroll: true });
    wasEditorOpen.current = editorOpen;
  }, [editorOpen]);
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const openEditor = useCallback(() => setEditorOpen(true), []);
  const applyPresentation = useCallback(
    (chart, metadata) => {
      const next = validatePresentation({
        chart,
        title: metadata?.title ?? presentation.title,
        description: metadata?.description ?? presentation.description,
      });
      if (chartMappingKey(next.chart) !== mappingKey) {
        setVisibleSeries(null);
        setZoomRange(null);
      }
      setPresentation(next);
    },
    [mappingKey, presentation.description, presentation.title, validatePresentation],
  );

  async function copy(format) {
    setActionStatus("");
    try {
      if (format === "image") {
        const png = renderLiveChartImage(card.current).then(result => result.blob);
        await copyPng(png, visibleActions());
        setActionStatus("Chart image copied.");
      } else {
        const text = reviewedRowsAsTsv(rows);
        try {
          await navigator.clipboard.writeText(text);
        } catch { copySelection(text, visibleActions()); }
        setActionStatus("Chart data copied.");
      }
    } catch (error) {
      setActionStatus(format === "image" ? "Image copy is unavailable in this view." : "Copy is unavailable in this view.");
    }
  }

  return (
    <div className="data-inline-chart-stage" style={{ "--data-inline-chart-preview-height": `${previewHeight}px` }}>
      <section
        ref={card}
        className="dashboard-component data-inline-chart-content"
        data-component-id={component.id}
        data-component-kind="chart"
        data-query-id={component.queryId}
        inert={editorOpen}
      >
        <header className="component-header">
          <h2 className="component-title">
            <span className="component-title-text">{titleTailParts ? <>{titleTailParts[1]}
              <span className="component-title-tail">{titleTailParts[2]}
                <InfoTooltip portalContainer={host.shadowRoot}>{presentation.description}</InfoTooltip>
              </span></> : presentation.title}</span>
          </h2>
          <span className="component-custom-actions"><Menu
            label={`${presentation.title} actions`}
            portalContainer={host.shadowRoot}
            trigger={
              <button ref={actionsTrigger} type="button" className="menu-trigger"
                aria-label={`${presentation.title} actions`}>
                <Icon name="more" />
              </button>
            }
          >
            <MenuItem icon="edit" onSelect={openEditor}>Edit chart</MenuItem>
            <MenuSeparator />
            <MenuItem icon="copy" onSelect={() => copy("image")}>Copy as image</MenuItem>
            <MenuItem icon="copy" onSelect={() => copy("data")}>Copy data</MenuItem>
          </Menu></span>
          <span className="menu-trigger component-native-actions">
            <Icon name="more" />
            <select ref={nativeActions} aria-label={`${presentation.title} actions`}
              onChange={event => {
                const action = event.currentTarget.value;
                event.currentTarget.selectedIndex = -1;
                if (action === "edit") requestAnimationFrame(openEditor);
                else if (action === "image" || action === "data") void copy(action);
              }}>
              <option value="edit">Edit chart</option>
              <option value="image">Copy as image</option>
              <option value="data">Copy data</option>
            </select>
          </span>
        </header>
        <ChartRenderer
          key={mappingKey}
          spec={presentation.chart}
          rows={rows}
          height={height}
          chartId={component.id}
          resolveColor={resolveColor}
          themeRoot={host}
          visibleSeries={visibleSeries}
          onVisibleSeriesChange={setVisibleSeries}
          zoomRange={zoomRange}
          onZoomChange={setZoomRange}
        />
      </section>
      <span className="visually-hidden" role="status">{actionStatus}</span>
      {editorOpen && (
        <ChartEditor
          DialogComponent={ContainedDialog}
          SelectComponent={Select}
          component={appliedComponent}
          getRows={getRows}
          resolveColor={resolveColor}
          visibleSeries={visibleSeries}
          zoomRange={zoomRange}
          onClose={closeEditor}
          onSave={applyPresentation}
          variant="contained"
          portalContainer={host.shadowRoot}
          themeRoot={host}
          previewHeight={previewHeight}
          saveLabel="Apply"
          editMetadata
          resetPresentation={originalPresentation}
          resetLabel="Reset"
          validatePresentation={validatePresentation}
          getCapabilities={getCapabilities}
        />
      )}
    </div>
  );
}

/** Mount the shared chart and editor inside an isolated inline host. */
export function mountInlineChart(host, payload) {
  if (!host || typeof host.attachShadow !== "function") {
    throw new TypeError("An inline chart requires a valid Shadow DOM host.");
  }
  if (payload?.schemaVersion !== 1) {
    throw new TypeError("An inline chart requires a supported reviewed payload.");
  }
  if (typeof payload.theme?.css !== "string") {
    throw new TypeError("An inline chart requires its bundled dashboard theme.");
  }

  mountedCharts.get(host)?.();

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
  const previousTheme = host.getAttribute("data-app-theme");
  host.setAttribute("data-app-theme", payload.theme.id);

  const fixedScheme = ["dark", "light"].includes(payload.theme.fixedScheme) ? payload.theme.fixedScheme : "inherit";
  const styles = (resolvedDashboardStyles, resolvedInlineStyles) => [
    scopeDashboardStyles(resolvedDashboardStyles),
    scopeDashboardStyles(payload.theme.css),
    resolvedInlineStyles,
    `:host { color-scheme: ${fixedScheme}; }`,
  ].join("\n");

  const stylesheet = host.ownerDocument.createElement("style");
  stylesheet.setAttribute("data-inline-dashboard-styles", "");

  const container = host.ownerDocument.createElement("div");
  container.className = "data-inline-react-root";
  shadow.append(stylesheet, container);

  const root = createRoot(container);
  let disposed = false;
  Promise.all([dashboardStyles, inlineStyles, prepareDashboardIcons()]).then(([css, inlineCss]) => {
    if (disposed) return;
    stylesheet.textContent = styles(css, inlineCss);
    root.render(<InlineChart host={host} payload={payload} />);
  }).catch((error) => {
    if (disposed) return;
    container.setAttribute("role", "alert");
    container.textContent = "Unable to load chart styles. Reload to try again.";
    console.error(error);
  });

  function unmount() {
    if (mountedCharts.get(host) !== unmount) return;
    disposed = true;
    mountedCharts.delete(host);
    root.unmount();
    container.remove();
    stylesheet.remove();
    if (previousTheme === null) host.removeAttribute("data-app-theme");
    else host.setAttribute("data-app-theme", previousTheme);
  }

  mountedCharts.set(host, unmount);
  return unmount;
}
