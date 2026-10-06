import "../../src/content/report/report.css";
import React from "react";
import { createRoot } from "react-dom/client";

import { DataAppShell } from "../shell.jsx";
import { ReportContent } from "../reports/delivery-diagnostic/ReportContent.jsx";
import { snapshot } from "./data.js";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <DataAppShell snapshot={snapshot} hosted={false}>
      <ReportContent />
    </DataAppShell>
  </React.StrictMode>,
);
