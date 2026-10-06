export const cohortCellId = cell => `retention-${cell.cohort}-${cell.age}`;

export function cohortDrillFocus(focus, cell) {
  if (!cell?.mature || cell.retentionRate == null) return null;
  return { ...focus, cohort: cell.cohort, age: String(cell.age), status: "all" };
}

export function captureCohortOrigin(cell, view = window) {
  const cellId = cohortCellId(cell);
  const mark = view.document.getElementById(cellId);
  return { cellId, x: view.scrollX, y: view.scrollY,
    scrollLeft: mark?.closest(".bp-cohort-scroll")?.scrollLeft ?? 0 };
}

export function revealCohortCustomers(view = window) {
  const detail = view.document.querySelector('[data-component-id="cohort-members"]');
  if (!detail) return;
  const header = view.document.querySelector(".dashboard-topbar")?.getBoundingClientRect().height ?? 52;
  const filters = view.document.querySelector(".filters.filter-bar")?.getBoundingClientRect().height ?? 0;
  detail.style.scrollMarginTop = `${header + filters + 16}px`;
  detail.focus({ preventScroll: true });
  detail.scrollIntoView({ block: "start", behavior: "instant" });
}

export function restoreCohortOrigin(origin, view = window) {
  if (!origin) return;
  const mark = view.document.getElementById(origin.cellId);
  const table = mark?.closest(".bp-cohort-scroll");
  if (table) table.scrollLeft = origin.scrollLeft;
  view.scrollTo({ left: origin.x, top: origin.y, behavior: "instant" });
  (mark ?? view.document.querySelector(".bp-cohort-scroll"))?.focus({ preventScroll: true });
}
