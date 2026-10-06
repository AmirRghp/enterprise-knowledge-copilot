import React from "react";
import { Filters, useDataApp } from "../../data-app-public.jsx";

// Compose only the reviewed measurements needed for this dashboard's job.
// Resolve current component docs through the AGENTS.md workflow before authoring.
// This empty starter is scaffolding, not a completed dashboard.
export function DashboardContent() {
  const { snapshot, queries, filters, setFilter } = useDataApp();
  return snapshot.filters?.length
    ? <Filters filters={snapshot.filters} queries={queries} values={filters} onChange={setFilter} />
    : null;
}
