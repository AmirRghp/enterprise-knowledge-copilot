import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const templateRoot = fileURLToPath(new URL("../", import.meta.url));
let components;
let server;

before(async () => {
  server = await createServer({
    root: templateRoot,
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  components = await server.ssrLoadModule("/src/components/MetricCard.jsx");
});

after(async () => {
  await server?.close();
});

const items = [
  {
    id: "teams",
    title: "Active teams",
    value: "307",
    comparison: "+5.5% vs. Jun 30",
    tone: "neutral",
    trendValues: [251, 263, 278, 291, 307],
  },
  {
    id: "tasks",
    title: "Completed tasks",
    value: "659",
    comparison: "+5.6% vs. Jun 30",
    tone: "neutral",
    trendValues: [548, 571, 602, 624, 659],
  },
  {
    id: "target",
    title: "Target attainment",
    value: "99.6%",
    comparison: "-0.4 pp vs. target",
    tone: "neutral",
  },
];

test("metric cards apply explicit delta meaning to both text and sparkline without changing values", () => {
  const render = props => renderToStaticMarkup(React.createElement(components.MetricCard,
    { id: "delta-reading", queryId: "reviewed", title: "Change", value: "42",
      trendValues: [40, 41, 42], showActions: false, ...props }));
  for (const [comparison, deltaTone] of [["+4.2%", "positive"], ["+8.1%", "negative"],
    ["−4.2 pp", "positive"], ["+3%", "neutral"], [0, "neutral"]]) {
    const html = render({ comparison, deltaTone });
    assert.ok(html.includes(`data-delta="${deltaTone}">${comparison}</span>`));
    assert.ok(html.includes(`data-direction="${deltaTone}"`));
    assert.match(html, />42<\/p>/u);
  }
  assert.match(render({ comparison: "−3%", negative: true }), /data-delta="negative"/u);
  assert.match(render({ comparison: "+3%", deltaTone: "neutral", negative: true }), /data-delta="neutral"/u);
  assert.match(render({ comparison: "+3%", deltaTone: "invalid" }), /data-delta="neutral"/u);
  assert.doesNotMatch(render({ comparison: null }), /data-delta=/u);
  const withChart = render({ comparison: "+3%", deltaTone: "positive", children: React.createElement("div", null, "Trend") });
  assert.match(withChart, /data-metric-chart/u);
  assert.doesNotMatch(withChart, /data-metric-sparkline/u, "An integrated chart must not gain a duplicate sparkline");
});

test("metric cards preserve comparison basis and identify the trend period", () => {
  const markup = renderToStaticMarkup(React.createElement(components.MetricCard, {
    id: "history", queryId: "reviewed", title: "Active teams", value: "42", showActions: false,
    comparison: "+5.5% vs. Jun 30", trendValues: [40, 41, 42], trendLabel: "Daily active teams, Jul 1–3",
  }));
  assert.match(markup, /\+5\.5% vs\. Jun 30/u);
  assert.match(markup, /role="img" aria-label="Daily active teams, Jul 1–3"/u);
  assert.match(markup, /<title>Daily active teams, Jul 1–3<\/title>/u);
  const combined = renderToStaticMarkup(React.createElement(components.MetricCard, {
    id: "combined", queryId: "current", queryIds: ["comparison"], title: "Change", value: "2",
    displayRows: [{ change: 2 }], showActions: false,
    sourceRowsByQuery: { current: [{ value: 12 }], comparison: [{ value: 10 }] },
  }));
  assert.match(combined, />2<\/p>/u, "MetricCard forwards explicit multi-source display rows to DataComponent");
});

test("metric sparklines preserve the full supplied history and missing-observation gaps", () => {
  const render = values => renderToStaticMarkup(React.createElement(components.MetricSparkline, { values }));
  const full = render(Array.from({ length: 16 }, (_, i) => i));
  const points = full.match(/<polyline points="([^"]+)"/u)[1].split(" ");
  assert.equal(points.length, 16);
  assert.equal(points[0], "2,21");
  assert.equal(points.at(-1), "56,5");
  const gaps = render([1, 2, null, 3, 4, undefined, 5]);
  assert.equal((gaps.match(/<polyline /gu) ?? []).length, 2);
  assert.equal((gaps.match(/<circle /gu) ?? []).length, 1);
  assert.match(gaps, /cx="56"/u);
  assert.equal(render([null, 1, null]), "");
});

test("MetricCardTabs renders one accessible controlled panel during SSR", () => {
  const { MetricCardTabs } = components;
  const markup = renderToStaticMarkup(React.createElement(
    MetricCardTabs,
    {
      items,
      selectedId: "tasks",
      onChange: () => {},
      ariaLabel: "Operating metric",
    },
    ({ item }) => React.createElement("p", null, `Panel for ${item.title}`),
  ));

  assert.match(markup, /role="tablist" aria-label="Operating metric"/u);
  assert.equal((markup.match(/role="tab"/gu) ?? []).length, items.length);
  assert.equal((markup.match(/role="tabpanel"/gu) ?? []).length, 1);
  assert.match(markup, /aria-selected="true"[^>]*tabindex="0"/u);
  assert.equal((markup.match(/tabindex="-1"/gu) ?? []).length, items.length - 1);

  const selectedTabId = markup.match(/id="([^"]+-tab-tasks)"[^>]*role="tab"/u)?.[1];
  const panelId = markup.match(/id="([^"]+-panel)" role="tabpanel"/u)?.[1];
  assert.ok(selectedTabId, "The selected metric should have an item-stable tab id");
  assert.ok(panelId, "The controlled content should have one generated panel id");
  assert.match(markup, new RegExp(`aria-controls="${panelId}"`, "u"));
  assert.match(markup, new RegExp(`aria-labelledby="${selectedTabId}"`, "u"));
  assert.match(markup, /Panel for Completed tasks/u);
  assert.match(markup, /\+5\.6% vs\. Jun 30/u,
    "Metric tabs should retain the actual comparison observation");
  assert.equal((markup.match(/data-direction="neutral"/gu) ?? []).length, 2,
    "Neutral metric readings must not have favorable green sparklines");
});

test("metric tabs preserve zero comparisons and distinguish IDs that share a slug", () => {
  const variants = ["net revenue", "net-revenue", "net%20revenue"];
  const render = comparison => renderToStaticMarkup(React.createElement(components.MetricCardTabs, {
    items: variants.map(id => ({id,title:id,value:"42",comparison,tone:"neutral",trendValues:[4,4,4]})),
    selectedId:variants[0],onChange() {},
  }, "Selected metric"));
  const html = render(0);
  const ids = [...html.matchAll(/\bid="([^"]+)"/gu)].map(match=>match[1]);
  assert.equal(new Set(ids).size,ids.length,"Distinct reviewed IDs must not create duplicate DOM IDs");
  const selected = html.match(/<button[^>]*aria-selected="true"[^>]*>/u)[0].match(/\bid="([^"]+)"/u)[1];
  assert.ok(html.includes(`aria-labelledby="${selected}"`));
  assert.equal((html.match(/class="data-metric-reading-change\b/gu) ?? []).length,variants.length);
  assert.equal((html.match(/data-tone="neutral"[^>]*>0<\/span>/gu) ?? []).length,variants.length);
  for (const absent of [null,undefined,""]) assert.doesNotMatch(render(absent),/class="data-metric-reading-change\b/u);
});

test("MetricCardTabs exposes its vertical layout to assistive technology", () => {
  const { MetricCardTabs } = components;
  const markup = renderToStaticMarkup(React.createElement(
    MetricCardTabs,
    {
      items,
      selectedId: "teams",
      orientation: "vertical",
    },
    React.createElement("p", null, "Vertical metric panel"),
  ));

  assert.match(markup, /class="data-metric-card-tabs"[^>]*data-orientation="vertical"/u);
  assert.match(markup, /role="tablist"[^>]*aria-orientation="vertical"/u);
});

test("MetricCardTabs exposes deterministic wrapped keyboard navigation", () => {
  const { metricTabIndexForKey } = components;
  assert.equal(metricTabIndexForKey("ArrowRight", 2, 3, "horizontal"), 0);
  assert.equal(metricTabIndexForKey("ArrowLeft", 0, 3, "horizontal"), 2);
  assert.equal(metricTabIndexForKey("ArrowDown", 2, 3, "vertical"), 0);
  assert.equal(metricTabIndexForKey("ArrowUp", 0, 3, "vertical"), 2);
  assert.equal(metricTabIndexForKey("ArrowDown", 1, 3, "horizontal"), null);
  assert.equal(metricTabIndexForKey("ArrowUp", 1, 3, "horizontal"), null);
  assert.equal(metricTabIndexForKey("Home", 2, 3, "vertical"), 0);
  assert.equal(metricTabIndexForKey("End", 0, 3, "horizontal"), 2);
  assert.equal(metricTabIndexForKey("Enter", 1, 3, "horizontal"), null);
});
