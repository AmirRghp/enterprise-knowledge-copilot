import React from "react";

import {
  ChartRenderer, DataComponent, MetricCard, ReportSection, RichNarrative,
  SortableItem, SortableRegion, useDataApp,
} from "../../data-app-public.jsx";
import { adoptionBrief, rate } from "./adoption-brief.js";
import { ReportTaskLink } from "../shared/ReportTaskLink.jsx";

// A complete short operating readout. Replace its question, analysis, and
// composition for another task; none of these sections is required by the shell.
const growthBridge = { type: "waterfall", x: "driver", y: "change",
  xLabel: "Growth driver", yLabel: "Active accounts", startAtZero: false };
const sectionOrder = ["report-trend", "report-methods"];

export function ReportContent() {
  const { snapshot, reviewedPeriodRows, reviewedAggregatePeriodRows, chartOverrides, chartProps, visible,
    canEdit, mode, appTitle, setAppTitle } = useDataApp();
  const history = reviewedAggregatePeriodRows("usage_summary");
  const latestRows = reviewedAggregatePeriodRows("usage_summary", { period: "latest" });
  const previousRows = reviewedAggregatePeriodRows("usage_summary", { period: "previous" });
  const [latest] = latestRows;
  const [previous] = previousRows;
  const drivers = reviewedAggregatePeriodRows("growth_drivers").filter((row) => row.week === latest?.week);
  const segments = reviewedPeriodRows("segment_usage").filter((row) => row.week === latest?.week);
  const summary = adoptionBrief(latest, previous, drivers, segments, reviewedPeriodRows("account_health"));
  const trend = chartOverrides["report-trend"] ?? growthBridge;
  const sources = { usage_summary: [...latestRows, ...previousRows], growth_drivers: drivers };

  return <article className="report-content" aria-label="Analytical report">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        aria-label={canEdit && mode === "edit" ? "Edit report heading" : undefined}
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}
        onKeyDown={canEdit && mode === "edit" ? (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        } : undefined}>{appTitle}</h1>
      <RichNarrative id="report:description" value="Are we growing against plan, what explains the movement, and where should attention go?"
        className="report-deck" label="Edit report introduction" />
    </header>

    {visible("report-summary") && <ReportSection id="report-summary" title={summary.title}
      queryId="usage_summary" sourceRows={[...latestRows, ...previousRows]} showHeading={false} className="report-summary">
      <RichNarrative id="report-summary:body" className="report-summary-lead" label="Edit finding"
        value={`## ${summary.title}\n\n${summary.text}`} />
    </ReportSection>}

    <div className="report-facts" aria-label="Key metrics">
      {visible("report-metric-active") && <MetricCard id="report-metric-active" title="Active accounts"
        queryId="usage_summary" sourceRows={history} value={summary.number(latest?.activeUsers)}
        comparison={summary.accountComparison} negative={summary.change < 0}
        description="Distinct active accounts; change versus the preceding reviewed week."
        trendValues={history.map((row) => row.activeUsers)} />}
      {visible("report-metric-conversion") && <MetricCard id="report-metric-conversion" title="Activation rate"
        queryId="usage_summary" sourceRows={history} value={rate(latest?.conversion)}
        comparison={summary.conversionComparison} negative={latest?.conversion < previous?.conversion}
        description={summary.conversionDescription} trendValues={history.map((row) => row.conversion)} />}
    </div>

    <SortableRegion id="report:sections" label="Report sections" variant="stack" authoredOrder={sectionOrder}
      className="report-sortable-sections">
      {visible("report-trend") && <SortableItem id="report-trend" label="What explains the movement" kind="chart">
        <section className="report-section">
          {visible("report-drivers") && <ReportSection id="report-drivers" title="What explains the movement" queryId="growth_drivers"
            queryIds={["growth_drivers", "usage_summary"]} sourceRowsByQuery={sources} showHeading={false}>
            <RichNarrative id="report-trend:interpretation" className="report-analysis" label="Edit growth analysis"
              value={`## What explains the movement\n\n${summary.bridgeText}`} />
          </ReportSection>}
          {summary.bridgeValid && <DataComponent id="report-trend" title="How the account base changed" queryId="growth_drivers"
            kind="chart" chart={trend} displayRows={drivers} sourceRows={drivers} description="Recorded contributions to the latest weekly change.">
            <ChartRenderer spec={trend} rows={drivers} height={300} {...chartProps("report-trend")} />
          </DataComponent>}
        </section>
      </SortableItem>}
      {visible("report-methods") && <SortableItem id="report-methods" label="Where attention should go" kind="narrative">
        <ReportSection id="report-methods" title="Where attention should go" queryId="segment_usage"
          queryIds={summary.accounts.length ? ["segment_usage", "account_health"] : ["segment_usage"]}
          sourceRowsByQuery={summary.accounts.length
            ? { segment_usage: segments, account_health: summary.accounts } : { segment_usage: segments }}
          sourceRows={segments} showHeading={false} className="report-methods">
          <RichNarrative id="report-methods:body" className="report-caveat" label="Edit implication and evidence notes"
            value={`## Where attention should go\n\n${summary.attention}`} />
          <ReportTaskLink id="report-methods" narrativeId="report-methods:body"
            text={`## Where attention should go\n\n${summary.attention}`}
            queryId="segment_usage" queryIds={summary.accounts.length ? ["segment_usage", "account_health"] : ["segment_usage"]}>
            Review retention risks
          </ReportTaskLink>
          {snapshot.status === "fixture" && <RichNarrative id="report:disclosure" className="report-disclosure"
            value="Synthetic example. Source panels contain the reviewed definitions, rows, and queries. The growth bridge accounts for active-account movement; it does not establish the cause of the activation-rate change."
            label="Edit source disclosure" />}
        </ReportSection>
      </SortableItem>}
    </SortableRegion>
  </article>;
}
