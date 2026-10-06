import React from "react";
import { SharedAnnotationExample } from "../shared/chart-annotations/SharedAnnotationExample.jsx";

export function ReportContent() {
  return <article className="report-content"><header className="report-hero">
    <h1>Shared chart annotations</h1>
    <p className="report-deck">A synthetic example of reviewed benchmarks, events, ranges, and observations. The event establishes timing, not causation.</p>
  </header><SharedAnnotationExample /></article>;
}
