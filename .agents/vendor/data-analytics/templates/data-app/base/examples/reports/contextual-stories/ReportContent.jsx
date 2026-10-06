import React from "react";
import { ChartRenderer, DataComponent, ReportSection, RichNarrative, useDataApp } from "../../data-app-public.jsx";
import { contextualCases, contextualAnswer, reconcileContextAnnotations } from "./context.mjs";

function ContextualStory({ story }) {
  const { reviewedRows, chartOverrides, chartProps, visible } = useDataApp();
  const rows = reviewedRows(story.queryId);
  const answerId = `context-${story.id}-answer`;
  const chartId = `context-${story.id}-chart`;
  const chart = reconcileContextAnnotations(story, {
    type: story.chartType, x: "date", y: story.valueField, fields: [story.valueField],
    yLabel: story.yLabel, showXAxisLabel: false, showLegend: false, startAtZero: true,
  }, chartOverrides[chartId], rows);
  if (!visible(answerId) && !visible(chartId)) return null;
  return <section className="contextual-story" data-contextual-story={story.id}>
    {visible(answerId) && <ReportSection id={answerId} title={story.question} queryId={story.queryId}
      sourceRowsByQuery={{ [story.queryId]: rows }} showHeading={false}>
      <RichNarrative id={`${answerId}:body`} value={`## ${story.question}\n\n${contextualAnswer(story, rows)}`}
        label="Edit contextual interpretation" />
    </ReportSection>}
    {visible(chartId) && <DataComponent id={chartId} title={story.title} queryId={story.queryId}
      description={`Fictional example. Measurements are ${story.unit}; context comes from the accompanying fictional record.`}
      kind="chart" chart={chart} displayRows={rows} sourceRows={rows} headingLevel={3}>
      <ChartRenderer spec={chart} rows={rows} height={280} {...chartProps(chartId)} />
    </DataComponent>}
  </section>;
}

export function ReportContent() {
  const { appTitle, setAppTitle, canEdit, mode } = useDataApp();
  return <article className="report-content contextual-stories-report" aria-label="Contextual reporting examples">
    <header className="report-hero">
      <h1 data-data-app-title contentEditable={canEdit && mode === "edit"} suppressContentEditableWarning
        aria-label={canEdit && mode === "edit" ? "Edit report heading" : undefined}
        onBlur={canEdit && mode === "edit" ? (event) => setAppTitle(event.currentTarget.textContent.trim() || appTitle) : undefined}
        onKeyDown={canEdit && mode === "edit" ? (event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        } : undefined}>{appTitle}</h1>
      <RichNarrative id="contextual-stories:description" className="report-deck"
        value="Three fictional examples, with observations and context records created together for this gallery. Each annotation adds a fact the plotted measurements do not contain. Source panels retain the records and calculations." />
    </header>
    {contextualCases.map((story) => <ContextualStory key={story.id} story={story} />)}
  </article>;
}
