import React from "react";
import { ChartMark, ChartTooltip, DataComponent, DataTable, Dialog } from "../../data-app-public.jsx";
import { featureFields, featureUsage, percent } from "./product-model.js";

export function FeatureScorecard({ rows, onSelect }) {
  return <div className="product-feature-scorecards" data-chart-interaction-root>
    {rows.map((row, index) => <ChartMark key={row.feature} className="product-feature-score" style={{ "--feature-color": `var(--chart-${index + 1})` }}
      context={{ kind: "chart", label: row.feature, row, actions: [{ label: "Explore feature", onSelect: () => onSelect(row) }] }}
      tooltip={<ChartTooltip active label={row.feature} details={[{ label: "Using / eligible active workspaces", value: `${row.adopters} / ${row.eligible}` }]} />}
      aria-label={`${row.feature}: ${percent(row.adoptionRate)} adoption`}>
      <span>{row.feature}</span><strong>{percent(row.adoptionRate)}</strong>
      <span className="product-adoption-track" aria-hidden="true"><i style={{ width: `${Math.max(0, (row.adoptionRate ?? 0) * 100)}%` }} /></span>
      <span className="product-feature-foot"><span>{row.adopters} of {row.eligible} workspaces</span>
        <b data-tone={row.change == null || row.change === 0 ? "neutral" : row.change > 0 ? "positive" : "negative"}>
          {row.change == null ? "—" : `${row.change > 0 ? "+" : ""}${(row.change * 100).toFixed(1)} pp`}</b></span>
    </ChartMark>)}
  </div>;
}

export function AdoptionMap({ rows, onSelect }) {
  const columns = [{ field: "workspace", label: "Workspace", presentation: "identity", secondaryField: "plan" },
    ...Object.entries(featureFields).map(([feature, field]) => ({ field, label: feature, renderCell: (value, row) => {
      const usage = featureUsage(row, feature);
      return <ChartMark className="product-adoption-cell" data-usage={usage} aria-label={`${row.workspace}, ${feature}: ${usage}`}
        context={{ kind: "chart", chartType: "heatmap", label: `${row.workspace} · ${feature}`, row,
          actions: [{ label: "View workspace", onSelect: () => onSelect(row) }] }}
        tooltip={<ChartTooltip active label={feature} details={[{ label: row.workspace, value: usage },
          ...(["Not included", "Not observed"].includes(usage) ? [] : [{ label: "Events this week", value }])]} />}>
        <span aria-hidden="true">{usage === "Used" ? "●" : usage === "Not used" ? "○" : usage === "Not observed" ? "?" : "—"}</span>
      </ChartMark>;
    } }))];
  return <div className="product-adoption-map" data-chart-interaction-root>
    <div className="product-map-key" aria-label="Feature usage key"><span data-usage="Used">● Used</span><span data-usage="Not used">○ Not used</span><span>— Not included</span>{rows.some(row => Object.keys(featureFields).some(feature => featureUsage(row, feature) === "Not observed")) && <span>? Not observed</span>}</div>
    <DataTable rows={rows} columns={columns} rowKey="workspaceId" onRowSelect={onSelect} rowActionLabel={row => `View ${row.workspace}`} />
  </div>;
}

export function FeedbackRecords({ rows, onClose, onSelect }) {
  return <Dialog title="Feedback records" onClose={onClose} initialFocusSelector=".dialog-header" className="product-feedback-dialog">
    <DataComponent id="product-feedback-records" title="Feedback records" showHeading={false} queryId="workspace_feedback" kind="table" sourceRows={rows} displayRows={rows}>
      <DataTable rows={rows.map(row => ({ ...row, feature: row.feature ?? "Unassigned" }))} rowKey="feedbackId"
        columns={[{ field: "workspace", label: "Workspace" }, { field: "request", label: "Request" },
          { field: "feedbackSource", label: "Source" }, { field: "feature", label: "Feature" }, { field: "roadmap", label: "Roadmap status" }]}
        onRowSelect={row => { onClose(); onSelect(row); }} rowActionLabel={row => `View ${row.workspace}`} />
    </DataComponent>
  </Dialog>;
}
