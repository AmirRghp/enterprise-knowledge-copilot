import React from "react";
import { SharedAnnotationExample } from "../shared/chart-annotations/SharedAnnotationExample.jsx";

export function DashboardContent() {
  return <section className="annotation-example-dashboard"><header>
    <h1>Shared chart annotations</h1>
    <p>Synthetic reviewed evidence. Change the period or hide a series to see which exact anchors remain.</p>
  </header><SharedAnnotationExample /></section>;
}
