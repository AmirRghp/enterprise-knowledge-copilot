import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import "../../src/theme.css";
import "../../src/styles.css";
import { claimRefreshCoachmark, REFRESH_COACHMARK_COOKIE } from "../../src/refresh-coachmark.js";
import { RefreshSetupCoachmarkCard } from "../../src/components/RefreshSetupCoachmark.jsx";
import { Icon } from "../../src/components/Icon.jsx";

// Test-only transport adapter. Exercise the production cookie algorithm on two
// localhost ports (distinct origins, shared cookie domain), without touching
// production Site cookies or adding a development bypass to the runtime.
const fixtureCookie = "data_app_refresh_coachmark_fixture_v1";
const locationForTest = new URL(`https://dashboard-${location.port}.example.chatgpt.site/`);
const cookieDocument = {
  get cookie() { return document.cookie.replaceAll(fixtureCookie, REFRESH_COACHMARK_COOKIE); },
  set cookie(value) {
    document.cookie = value.replace(REFRESH_COACHMARK_COOKIE, fixtureCookie).replace("Domain=example.chatgpt.site", "Domain=localhost");
  },
};

function Fixture() {
  const anchor = useRef(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState("Not checked");
  const [setupOpened, setSetupOpened] = useState(false);
  async function check() {
    const claimed = await claimRefreshCoachmark({ document: cookieDocument, location: locationForTest });
    setVisible(claimed);
    setResult(claimed ? "First visit: coachmark shown" : "Already seen or unavailable: coachmark hidden");
  }
  return <>
    <header className="dashboard-topbar" style={{ padding: "0 24px" }}>
      <div className="dashboard-topbar-inner" style={{ justifyContent: "flex-start", gap: 20 }}>
        <strong>Dashboard · {location.port}</strong>
        <button ref={anchor} className="freshness freshness-button dashboard-refresh-trigger" aria-label="Refresh data" onClick={() => setSetupOpened(true)}>
          <Icon name="refresh" size={16} /><span>Updated today</span>
        </button>
      </div>
    </header>
    <main style={{ padding: "48px 24px" }}>
      <h1>Refresh coachmark test</h1>
      <p>Local fixture. No live Sites, data refreshes, or automations are changed.</p>
      <p role="status">{result}</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <button className="button" onClick={check}>Check this dashboard</button>
        <button className="button" onClick={() => {
          document.cookie = `${fixtureCookie}=; Domain=localhost; Path=/; Max-Age=0; Secure; SameSite=Lax`;
          setVisible(false); setResult("Test marker cleared"); setSetupOpened(false);
        }}>Reset test marker</button>
      </div>
      {setupOpened && <p>Refresh button selected. No automation was created.</p>}
    </main>
    {visible && <RefreshSetupCoachmarkCard anchor={anchor} onDismiss={() => setVisible(false)} />}
  </>;
}

createRoot(document.getElementById("root")).render(<Fixture />);
