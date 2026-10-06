import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DashboardTabs } from "../../src/components/DashboardTabs.jsx";
import "../../src/theme.css";
import "../../src/styles.css";

function TabsFixture() {
  const [active, setActive] = useState("first");
  return <div className="dashboard-root"><DashboardTabs tabs={[
    { id: "first", label: "Core Agentic Product Adoption and Customer Growth" },
    { id: "second", label: "Company Wide Growth and Retention by Product" },
    { id: "third", label: "Short" },
  ]} activeTabId={active} onChange={setActive} /></div>;
}

createRoot(document.getElementById("root")).render(<TabsFixture />);
