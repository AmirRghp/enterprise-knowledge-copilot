import React, { useMemo } from "react";
import { ChartMark, ChartTooltip } from "../../data-app-public.jsx";
import { cohortCellId } from "./retention-interaction.js";

export function CohortTooltip({ cell }) {
  const measuredAt = new Date(`${cell.cutoff}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return <ChartTooltip active label={`${cell.cohortLabel} · Month ${cell.age}`} headerValue={`${Math.round(cell.retentionRate * 100)}%`}
    details={[{ label: "Retained", value: `${cell.retainedAccounts} of ${cell.eligibleAccounts} customers` }, { label: "Measured", value: measuredAt }]} />;
}

export function CohortTable({ cells, selectedCell, onSelect }) {
  const rows = useMemo(() => {
    const grouped = new Map();
    for (const cell of cells) {
      if (!grouped.has(cell.cohort)) grouped.set(cell.cohort, []);
      grouped.get(cell.cohort).push(cell);
    }
    return [...grouped.values()];
  }, [cells]);
  const ages = [...new Set(cells.map(cell => cell.age))].sort((a,b) => a-b);
  const date = value => new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return <div className="bp-cohort-scroll" tabIndex={0} role="region" aria-label="Customer retention by cohort" data-reviewed-rows data-chart-interaction-root>
    <table className="bp-cohort-table">
      <thead><tr><th scope="col">First paid</th><th scope="col">Customers</th>{ages.map(age => <th key={age} scope="col">Month {age}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={row[0].cohort}>
        <th scope="row">{row[0].cohortLabel}</th><td className="bp-cohort-size">{row[0].eligibleAccounts}</td>
        {ages.map(age => {
          const cell = row.find(item => item.age === age);
          const observed = cell?.mature && cell.retentionRate != null;
          const value = observed ? `${Math.round(cell.retentionRate * 100)}%` : "—";
          const description = observed ? `${cell.cohortLabel}, Month ${age}: ${value}, ${cell.retainedAccounts} of ${cell.eligibleAccounts} customers retained on ${date(cell.cutoff)}` : `${row[0].cohortLabel}, Month ${age}: not yet observed`;
          return <td key={age} data-observed={observed || undefined} style={observed ? { "--cohort-fill": `color-mix(in srgb, var(--chart-1) ${8 + Math.max(0, Math.min(1, cell.retentionRate)) * 42}%, var(--surface))` } : undefined}>
            {observed ? <ChartMark id={cohortCellId(cell)} aria-label={description}
              aria-pressed={selectedCell?.cohort === cell.cohort && selectedCell?.age === age}
              context={{ kind: "chart", chartType: "heatmap", label: `${cell.cohortLabel} · Month ${age}`, series: "Paid-customer retention", value,
                row: cell, actions: [{ label: "View customers", onSelect: () => onSelect(cell) }] }} tooltip={<CohortTooltip cell={cell} />}>
              {value}</ChartMark> : <span aria-label={description}>{value}</span>}
          </td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}
