import React, { useState } from "react";
import { ChartRenderer, DataComponent, useDataApp } from "../../../data-app-public.jsx";
import { chartSpec } from "./fixture.mjs";
import "./example.css";

// This composition is installed unchanged into the report and dashboard.
export function SharedAnnotationExample() {
  const { filters, setFilter, reviewedRows, chartProps, chartOverrides } = useDataApp();
  const savedSpec = chartOverrides["annotated-history"] ?? chartSpec;
  const [geometry, setGeometry] = useState(null);
  const rows = reviewedRows("annotation_history", ["date"]);
  // A saved chart edit wins immediately over a prior, temporary example choice.
  // Selecting another geometry retains the saved measure choices. It never
  // reintroduces a measure the ordinary chart editor removed.
  const selectedGeometry = geometry?.source === savedSpec ? geometry.type : null;
  const type = selectedGeometry ?? savedSpec.type;
  const fields = savedSpec.fields ?? [savedSpec.y];
  const barField = fields.includes("repeatAccounts") ? "repeatAccounts" : fields[0];
  // A grouped bar has no single point center; explicit bar examples use one series.
  const spec = selectedGeometry ? { ...savedSpec, type,
    ...(["bar", "horizontalBar"].includes(type) ? { y: barField, fields: [barField] } : {}) } : savedSpec;
  return <section className="annotation-example" aria-label="Shared annotation example">
    <div className="annotation-example-controls">
      <label>Example period <select aria-label="Example period" value={filters.period} onChange={(event) => setFilter("period", event.target.value)}>
        <option value="all">All reviewed dates</option>
        <option value="2026-08-01..2026-08-03">First three dates</option>
        <option value="2026-08-06..2026-08-08">Last three dates</option>
      </select></label>
      <label>Chart geometry <select aria-label="Chart geometry" value={type}
        onChange={(event) => setGeometry({ source: savedSpec, type: event.target.value })}>
        {!["line", "area", "bar", "horizontalBar"].includes(type) && <option value={type}>Edited chart ({type})</option>}
        <option value="line">Line</option><option value="area">Area</option>
        <option value="bar">Bar</option><option value="horizontalBar">Horizontal bar</option>
      </select></label>
    </div>
    <DataComponent id="annotated-history" title="Daily account activity" queryId="annotation_history"
      kind="chart" chart={spec} displayRows={rows} sourceRows={rows}
      description="Synthetic daily activity with reviewed reference marks; the event is not a causal estimate.">
      <ChartRenderer spec={spec} rows={rows} height={300} {...chartProps("annotated-history")} />
    </DataComponent>
  </section>;
}
