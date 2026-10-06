import React from "react";
import { ChartMark, ChartTooltip, DataTable } from "../../data-app-public.jsx";
import { dollars, percent } from "./performance-data.js";
const productColors = { Workspace: "var(--chart-1)", Automations: "var(--chart-2)", API: "var(--chart-3)" };

export function ProductEconomics({ rows, onSelect }) {
  const maximum = Math.max(1, ...rows.map(row => row.revenueUsd ?? 0));
  return <div className="bp-product-economics" data-chart-interaction-root>
    {rows.map(row => <ChartMark key={row.category} className="bp-economics-row"
      style={{ "--product-color": productColors[row.category] ?? "var(--chart-1)" }}
      aria-label={`${row.category}: ${dollars(row.revenueUsd)} revenue, ${dollars(row.grossProfitUsd)} gross profit, ${percent(row.grossMarginRate)} margin`}
      context={{ kind: "chart", label: row.category, row, actions: [{ label: "Explore product", onSelect: () => onSelect(row) }] }}
      tooltip={<ChartTooltip active label={row.category} details={[{ label: "Revenue", value: dollars(row.revenueUsd) }, { label: "Gross profit", value: dollars(row.grossProfitUsd) }, { label: "Margin", value: percent(row.grossMarginRate) }]} />}>
      <span className="bp-economics-name"><strong>{row.category}</strong><span>{percent(row.grossMarginRate)} margin</span></span>
      {[["revenueUsd", "Revenue"], ["grossProfitUsd", "Gross profit"]].map(([field, label]) => <span className="bp-economics-measure" key={field}>
        <span><span>{label}</span><b>{dollars(row[field])}</b></span>
        {Number.isFinite(row[field]) && row[field] >= 0 && <span className="bp-economics-track" aria-hidden="true"><i data-profit={field === "grossProfitUsd" || undefined} style={{ width: `${Math.max(0, row[field] ?? 0) / maximum * 100}%` }} /></span>}
      </span>)}
    </ChartMark>)}
  </div>;
}

export function RetentionByProduct({ rows }) {
  const nrrMaximum = Math.max(1.1, ...rows.map(row => row.netRevenueRetention ?? 0));
  const rateColumn = (field, label, maximum = 1) => ({ field, label, renderCell: value => value == null ? "—" : <span className="bp-retention-rate">
    <span>{percent(value)}</span><span className="bp-retention-track" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(value / maximum, 1)) * 100}%` }} />
      {maximum > 1 && <b style={{ left: `${100 / maximum}%` }} />}
    </span>
  </span> });
  return <DataTable rows={rows} searchable={false} columns={[
    { field: "category", label: "Product" }, rateColumn("netRevenueRetention", "NRR", nrrMaximum),
    rateColumn("grossRevenueRetention", "GRR"), rateColumn("paidAccountRetention", "Accounts"),
    { field: "churnedAccounts", label: "Churned" },
  ]} />;
}

export function RevenueMovers({ rows, onSelect }) {
  const maximum = Math.max(1, ...rows.map(row => Math.abs(row.deltaUsd ?? 0)));
  return <div className="bp-revenue-movers" data-chart-interaction-root>{rows.map(row => <ChartMark key={row.accountId}
    className="bp-mover" aria-label={`${row.account}: ${row.deltaUsd == null ? "No comparison" : dollars(row.deltaUsd)} revenue change`}
    context={{ kind: "chart", label: row.account, row, actions: [{ label: "View account", onSelect: () => onSelect(row) }] }}
    tooltip={<ChartTooltip active label={row.account} details={[{ label: "Revenue", value: dollars(row.revenueUsd) }, { label: "Change", value: row.deltaUsd == null ? "—" : dollars(row.deltaUsd) }]} />}>
    <span className="bp-mover-copy"><strong>{row.account}</strong><b data-tone={row.deltaUsd < 0 ? "negative" : row.deltaUsd > 0 ? "positive" : "neutral"}>{row.deltaUsd == null ? "—" : `${row.deltaUsd > 0 ? "+" : ""}${dollars(row.deltaUsd)}`}</b></span>
    <span className="bp-mover-track" aria-hidden="true"><i style={{ left: `${row.deltaUsd < 0 ? 50 - Math.abs(row.deltaUsd) / maximum * 50 : 50}%`, width: `${Math.abs(row.deltaUsd ?? 0) / maximum * 50}%`, background: row.deltaUsd < 0 ? "var(--negative)" : "var(--positive)" }} /></span>
  </ChartMark>)}</div>;
}
