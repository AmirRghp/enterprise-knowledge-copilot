import React from "react";
import { ChartRenderer, DataComponent, DataTable, ReportSection, RichNarrative, useDataApp } from "../../data-app-public.jsx";
import { ReportDisclosure } from "../shared/ReportDisclosure.jsx";
import { ReportTaskLink } from "../shared/ReportTaskLink.jsx";
import { actions, authoredChart, number, percent, summarize, supportsPickupContext } from "./report-model.mjs";

function Narrative({ id, title, queries, children }) {
  const { reviewedRows, visible } = useDataApp();
  if (!visible(id)) return null;
  return <ReportSection id={id} title={title} queryId={queries[0]} queryIds={queries}
    sourceRowsByQuery={Object.fromEntries(queries.map((queryId) => [queryId, reviewedRows(queryId)]))}
    showHeading={false}>{children}</ReportSection>;
}

function Figure({ id, title, queryId, kind, description }) {
  const { reviewedRows, chartOverrides, chartProps, visible } = useDataApp();
  const rows = reviewedRows(queryId);
  if (!visible(id)) return null;
  const plotted = kind === "timing" ? rows.map(row => ({ ...row,
    groupLabel: row.group.replace(" · before 14:00", " <14:00").replace(" · 14:00–16:00", " 14–16") })) : rows;
  const chart = authoredChart(kind, rows, reviewedRows("research"), chartOverrides[id]);
  return <DataComponent id={id} title={title} queryId={queryId} sourceRows={rows} displayRows={plotted}
    kind="chart" chart={chart} headingLevel={3} description={description}>
    <ChartRenderer spec={chart} rows={plotted} height={300} {...chartProps(id)} />
  </DataComponent>;
}

function Recommendation({ action }) {
  return <Narrative id={action.id} title={action.title} queries={action.queries}>
    <RichNarrative id={`${action.id}:body`} value={action.text} />
    <ReportTaskLink id={action.id} narrativeId={`${action.id}:body`} text={action.text}
      queryId={action.queries[0]} queryIds={action.queries} period="history"
      intent="prepare" deliverable={action.deliverable}>{action.label}</ReportTaskLink>
  </Narrative>;
}

export function ReportContent() {
  const { appTitle, setAppTitle, canEdit, mode, reviewedRows } = useDataApp();
  const totals = summarize(reviewedRows("weekly"));
  const bridge = reviewedRows("bridge");
  const warehouse = reviewedRows("warehouse");
  const timing = reviewedRows("timing");
  const records = reviewedRows("research");
  const [offer] = reviewedRows("economics");
  const dispatch = bridge.find((row) => row.stage === "Missed dispatch");
  const transit = bridge.find((row) => row.stage === "After handoff");
  const afternoon = timing.find((row) => row.group === "East · 14:00–16:00");
  const scheduleSupported = supportsPickupContext(records);

  return <article className="report-content" aria-label="Delivery reliability diagnostic">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        aria-label={canEdit && mode === "edit" ? "Edit report heading" : undefined}
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}
        onKeyDown={canEdit && mode === "edit" ? (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        } : undefined}>{appTitle}</h1>
    </header>

    <section className="report-section">
      <Narrative id="delivery-summary" title="Why late deliveries increased" queries={["weekly", "research"]}>
        <RichNarrative id="delivery-summary:body" value={`Late delivery rose from **${percent(totals.beforeLate / totals.beforeOrders)} to ${percent(totals.late / totals.orders)}** for Meridian Home’s standard orders placed by 16:00. ${scheduleSupported ? "East’s pickup now arrives before its afternoon packing starts. That mismatch is the leading hypothesis, although staffing and order complexity also changed." : "The saved operations record no longer supports the earlier schedule hypothesis. Reconcile the revised evidence before choosing an intervention."}\n\n${scheduleSupported ? "**Recommendation:** pilot an earlier start to East’s afternoon packing. It currently starts at 16:45, after the 16:30 pickup. Measure whether the change improves on-time delivery and what it costs before paying for another daily collection." : "**Recommendation:** review the corrected operations record alongside the order-time comparison before drafting a dispatch test."}`} />
      </Narrative>
      <Figure id="delivery-trend" title="Late delivery rate by promised-delivery week" queryId="weekly" kind="trend"
        description="Synthetic case. June 22–July 19 versus July 20–August 16, 2026. Original promised-delivery dates, not revised promises. Outcomes through August 20. Event timing does not estimate an effect." />
    </section>

    <section className="report-section">
      <Narrative id="delivery-drivers" title="Most extra delays start before carrier handoff" queries={["weekly", "bridge", "research"]}>
        <RichNarrative id="delivery-drivers:body" value={`## Most extra delays start before carrier handoff\n\nAfter adjusting for higher order volume, **${number(dispatch.extraLateOrders)} of ${number(dispatch.extraLateOrders + transit.extraLateOrders)} additional late orders** missed their planned collection. Start there. Review the smaller after-handoff increase separately by carrier route.`} />
      </Narrative>
      <Figure id="delivery-bridge" title="What accounts for the additional late orders" queryId="bridge" kind="bridge"
        description="Baseline failure-stage rates scaled to recent volume. The mutually exclusive contributions sum to the additional late-order count; they are not causal effects." />
    </section>

    <section className="report-section">
      <Narrative id="delivery-timing" title="Focus the test on East’s afternoon orders" queries={["timing", "research"]}>
        <RichNarrative id="delivery-timing:body" value={`## Focus the test on East’s afternoon orders\n\nEast’s 14:00–16:00 orders now arrive late **${percent(afternoon.currentRate)} of the time, up from ${percent(afternoon.baselineRate)}**. Compare similar orders and staff experience when testing an earlier packing wave. More complex work and less-experienced staff could also explain part of the increase.`} />
      </Narrative>
      <Figure id="delivery-timing-chart" title="Late delivery rate by warehouse and order time" queryId="timing" kind="timing"
        description="Baseline: June 22–July 19. Recent: July 20–August 16. Every rate uses its own group’s order count. Local order-placement time, standard delivery only." />
      <Narrative id="delivery-evidence" title="Evidence and alternative explanations" queries={["warehouse", "timing", "research"]}>
        <ReportDisclosure id="delivery-evidence" label="Evidence and alternative explanations">
          <RichNarrative id="delivery-evidence:body" value="The operations review found 78 orders packed after pickup and 27 ready orders that still missed collection. It sampled 120 already-late East orders from support cases, so it identifies failure modes rather than their frequency across all orders.\n\nEast’s multi-item share also rose from 32% to 46%, and new staff supplied 28% of packing hours instead of 10%. Compare item count, staff experience, and staffing hours before attributing the change to the collection schedule alone." />
          <DataTable rows={warehouse} compactNumbers={false} columns={[{ field: "warehouse", label: "Warehouse" },
            { field: "beforeOrders", label: "Baseline orders" }, { field: "currentOrders", label: "Recent orders" },
            { field: "baselineRate", label: "Baseline late rate", presentation: "percent" },
            { field: "currentRate", label: "Recent late rate", presentation: "percent" }]}
            searchable={false} label="Warehouse comparison and denominators" />
        </ReportDisclosure>
      </Narrative>
    </section>

    <Narrative id="delivery-cost-decision" title="Test the packing change before buying another pickup" queries={["economics", "research"]}>
      <RichNarrative id="delivery-cost-decision:body" value={`## Test the packing change before buying another pickup\n\nThe additional collection costs **$${number(offer.quoteCost)} for ${offer.quoteDays} weekdays**. At $${number(offer.creditPerLateOrder)} per service credit, it would need to prevent **${number(Math.ceil(offer.quoteCost / offer.creditPerLateOrder))} late deliveries** just to offset that quote through credits alone. That is a break-even requirement, not an estimate of how many orders the pickup would save.\n\nSupport workload and repeat purchases could change the economics, but neither is measured here. First determine which orders an earlier packing wave can recover; price a second collection only for the remaining eligible volume. The quote is unaccepted, and no pickup is booked.`} />
    </Narrative>

    <section className="report-recommendations" aria-label="Recommended next steps">
      <RichNarrative id="delivery-actions:heading" value="## What to do next" />
      {actions.map((action) => <Recommendation key={action.id} action={action} />)}
    </section>

    <Narrative id="delivery-scope" title="Cost, sources, and scope" queries={["weekly", "warehouse", "bridge", "timing", "economics", "research"]}>
      <ReportDisclosure id="delivery-scope" label="Cost assumptions, sources, and scope">
        <RichNarrative id="delivery-scope:body" value={`**Synthetic research case.** Meridian Home, observations, and research records were authored together for this example. No real company research or live connector query is represented. The original question is “Why are more orders arriving late, and what should we fix first?”\n\nThe baseline covers June 22–July 19, 2026; the recent period covers July 20–August 16. Each includes four complete promised-delivery weeks. All eligible orders have final delivery scans by August 20. Express, pickup, split shipments, and orders placed after 16:00 are outside scope.\n\n**Calculation:** for each failure stage, scale the baseline late-order count by ${number(totals.orders)} ÷ ${number(totals.beforeOrders)}, then subtract that expected count from the recent count. The separate volume contribution applies the baseline late rate to the additional orders. This accounting split does not predict the effect of an intervention.\n\n**Pickup offer:** $${number(offer.quotePerDay)} per weekday, or $${number(offer.quoteCost)} for ${offer.quoteDays} collections, capped at ${number(offer.maxParcelsPerDay)} parcels a day. No pickup has been booked. The $${number(offer.creditPerLateOrder)} service credit per late order excludes support costs, customer retention, and operating costs; eligibility and benefit remain to be estimated.\n\n${records.map((record) => `### ${record.title}\n\n${record.id} · ${record.date}\n\n${record.text}`).join("\n\n")}`} />
      </ReportDisclosure>
    </Narrative>
    <RichNarrative id="delivery-demo-note" className="report-disclosure" value="Meridian Home · Illustrative demo data" />
  </article>;
}
