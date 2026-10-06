import assert from "node:assert/strict";
import test from "node:test";

import { canUseDashboardAsk, chartMarkTooltipPosition, chartPointerTooltipPosition, chartPointSelection, dashboardAskPrompt, pinnedChartCardPosition } from "../src/dashboard-ask.js";

test("custom chart mark tooltips stay anchored and contained at viewport edges", () => {
  const card = { width: 280, height: 120 }, viewport = { width: 390, height: 844 };
  assert.deepEqual(chartMarkTooltipPosition({left:150,width:60,top:200,bottom:244},card,viewport), {left:40,top:72});
  assert.deepEqual(chartMarkTooltipPosition({left:350,width:40,top:10,bottom:54},card,viewport), {left:98,top:62});
  assert.deepEqual(chartMarkTooltipPosition({left:0,width:20,top:800,bottom:844},card,viewport), {left:12,top:672});
});

test("pointer tooltips start beside the cursor and flip at viewport edges", () => {
  const mark = {left:0,width:900,top:100,bottom:140}, card = {width:200,height:100}, viewport = {width:1000,height:600};
  const place = pointer => chartMarkTooltipPosition(mark,card,viewport,12,8,pointer);
  assert.deepEqual(place({x:50,y:120}), {left:58,top:128});
  assert.deepEqual(place({x:950,y:570}), {left:742,top:462});
  assert.deepEqual(place({x:NaN,y:120}), chartMarkTooltipPosition(mark,card,viewport));
});

test("touch tooltips clear the finger above the point and move below near the top edge", () => {
  const mark = { left: 0, width: 390, top: 0, bottom: 844 };
  const card = { width: 170, height: 96 }, viewport = { width: 390, height: 844 };
  assert.deepEqual(chartMarkTooltipPosition(mark, card, viewport, 12, 8,
    { x: 180, y: 410, type: "touch" }), { left: 95, top: 290 });
  assert.deepEqual(chartMarkTooltipPosition(mark, card, viewport, 12, 8,
    { x: 20, y: 38, type: "touch" }), { left: 12, top: 62 });
  const chart = { left: 30, top: 80, width: 330, height: 400 };
  assert.deepEqual(chartPointerTooltipPosition(chart, { width: 330, height: 400 }, card, viewport,
    { x: 180, y: 410, type: "touch" }), { x: 65, y: 210 });
});

test("item tooltip position follows every pointer coordinate independently of cell centers", () => {
  const chart = {left:100,top:80,width:600,height:400}, size = {width:600,height:400};
  const card = {width:150,height:80}, viewport = {width:1000,height:800};
  const place = pointer => chartPointerTooltipPosition(chart,size,card,viewport,pointer);
  assert.deepEqual(place({x:130,y:110}), {x:38,y:38});
  assert.deepEqual(place({x:131,y:111}), {x:39,y:39});
  assert.deepEqual(place({x:190,y:170}), {x:98,y:98});
  assert.deepEqual(place({x:950,y:750}), {x:692,y:582});
  assert.deepEqual(chartPointerTooltipPosition(chart,{width:300,height:200},card,viewport,{x:190,y:170}), {x:49,y:49});
  const dense = chartPointerTooltipPosition(chart, size, {width:240,height:432}, {width:1280,height:720}, {x:600,y:350});
  assert.deepEqual(dense, {x:508,y:196}, "When neither side fits, a tall tooltip clamps to the bottom instead of covering sticky chrome");
});

function pointFixture({ cursor = true, dots = true, explicit = false, staleHover = false, scale = 1 } = {}) {
  const element = (left, top, width, height, fill = "rgb(220, 60, 160)") => ({
    getBoundingClientRect: () => ({ left, top, width, height }),
    style: { fill, stroke: "rgb(255, 255, 255)", strokeWidth: "3px", opacity: "1", fillOpacity: "1" },
  });
  const current = element(staleHover ? 345 : 245, 115, 10, 10);
  const previous = element(staleHover ? 345 : 245, 165, 10, 10, "rgb(240, 160, 210)");
  const focused = element(245, 115, 10, 10);
  focused.matches = selector => selector === "circle";
  const rule = element(staleHover ? 350 : 250, 70, 0, 200);
  rule.style.stroke = "rgb(204, 204, 204)";
  const wrapper = element(100, 50, 800, 300);
  wrapper.offsetWidth = 800 / scale;
  wrapper.offsetHeight = 300 / scale;
  wrapper.querySelector = selector => {
    assert.ok(!/tick|axis/i.test(selector), "Point selection must never infer geometry from sparse display ticks");
    return selector === ".recharts-tooltip-cursor" ? cursor ? rule : null
      : selector === ".recharts-cartesian-grid" ? element(130, 70, 750, 200) : null;
  };
  wrapper.querySelectorAll = selector => {
    assert.equal(selector, ".recharts-active-dot circle");
    return dots ? [current, previous] : [];
  };
  const target = { closest: selector => selector === ".recharts-dot" && explicit ? focused : null };
  return { wrapper, target, readStyle: item => item.style };
}

test("clicking one date freezes its thin cursor and both series dots, never a display-tick band", () => {
  const fixture = pointFixture();
  const region = chartPointSelection(fixture.wrapper, fixture.target, fixture.readStyle);
  assert.equal(region.selectionType, "point");
  assert.deepEqual([region.left, region.top, region.width, region.height], [149.5, 20, 1, 200]);
  assert.deepEqual(region.points.map(({ x, y, radius, fill }) => ({ x, y, radius, fill })), [
    { x: 0.5, y: 50, radius: 5, fill: "rgb(220, 60, 160)" },
    { x: 0.5, y: 100, radius: 5, fill: "rgb(240, 160, 210)" },
  ]);
  assert.equal(region.cursorStroke, "rgb(204, 204, 204)");
  // Frozen values do not track Recharts when the pointer moves after selection.
  fixture.wrapper.querySelectorAll = () => [];
  assert.equal(region.points.length, 2);
});

test("missing hover cursor uses the actual active point, not the entire line path", () => {
  const fixture = pointFixture({ cursor: false });
  const region = chartPointSelection(fixture.wrapper, fixture.target, fixture.readStyle);
  assert.deepEqual([region.left, region.width, region.height], [149.5, 1, 200]);
  assert.equal(region.points.length, 2);
});

test("keyboard point selection ignores a stale hover at a different date", () => {
  const fixture = pointFixture({ explicit: true, staleHover: true });
  const region = chartPointSelection(fixture.wrapper, fixture.target, fixture.readStyle);
  assert.equal(region.left, 149.5);
  assert.equal(region.points.length, 1);
  assert.equal(region.points[0].y, 50);
});

test("point selection converts screen bounds to chart-local coordinates under scaling", () => {
  const fixture = pointFixture({ scale: 2 });
  const region = chartPointSelection(fixture.wrapper, fixture.target, fixture.readStyle);
  assert.deepEqual([region.left, region.top, region.width, region.height], [74.5, 10, 1, 100]);
  assert.equal(region.points[0].radius, 2.5);
  assert.equal(region.points[0].y, 25);
});

test("a chart with no rendered point or cursor cannot invent a selected time range", () => {
  const fixture = pointFixture({ cursor: false, dots: false });
  assert.equal(chartPointSelection(fixture.wrapper, fixture.target, fixture.readStyle), null);
});

test("selected chart card preserves the hover anchor and bounds overflow without moving ordinary cards", () => {
  assert.deepEqual(pinnedChartCardPosition({x:200,y:160}, {width:280}, {width:1000,height:800}),
    {left:200,top:160,width:280,maxHeight:628});
  assert.deepEqual(pinnedChartCardPosition({x:300,y:760}, {width:400}, {width:390,height:800}),
    {left:12,top:720,width:366,maxHeight:68});
  const small = pinnedChartCardPosition({x:-10,y:-20}, {width:240}, {width:320,height:400});
  assert.equal(small.left,12);
  assert.equal(small.top,12);
  assert.equal(small.maxHeight,376);
});

test("shows inline Ask ChatGPT only outside packaged Codex and local previews", () => {
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "example.com",
    }),
    true,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: true,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "example.com",
    }),
    true,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "edit",
      userAgent: "Mozilla/5.0",
      hostname: "example.com",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "CodexBrowser Mozilla/5.0",
      hostname: "example.com",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "ChatGPTBrowser Mozilla/5.0",
      hostname: "example.com",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "127.0.0.1",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "localhost",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "::1",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "dashboard.localhost",
    }),
    false,
  );
  assert.equal(
    canUseDashboardAsk({
      canEdit: false,
      mode: "view",
      userAgent: "Mozilla/5.0",
      hostname: "terminal.local",
    }),
    false,
  );
});

test("formats compact dashboard context before the labeled question", () => {
  const prompt = dashboardAskPrompt({
    question: "  Why did this decline?  ",
    dashboardTitle: "Product adoption and engagement",
    dashboardUrl: "https://example.com/dashboard",
    componentKind: "chart",
    componentTitle: "Weekly growth drivers",
    selectedContext: "Churn · -165",
  });

  assert.ok(prompt.startsWith("Why did this decline?"));
  assert.ok(prompt.includes("https://example.com/dashboard"));
  assert.ok(prompt.includes("Weekly growth drivers"));
  assert.ok(prompt.includes("Churn · -165"));
  assert.ok(prompt.includes("browser pane"));
});

test("uses the rich Sites project reference without repeating the raw dashboard URL", () => {
  const prompt = dashboardAskPrompt({
    question: "Why did this number go up?",
    dashboardTitle: "Data `quality` [review]\nDashboard",
    dashboardUrl: "https://dashboard.chatgpt.site/?token=private#selection",
    dashboardProjectId: "appgprj_123",
    componentKind: "chart",
    componentTitle: "Active accounts over time",
    selectedContext: "2026-03-30 · Active Users · 6K",
    selectedContextLabel: "Selected point",
  });

  assert.equal(
    prompt,
    [
      "Answer this question about [Data `quality` \\[review\\] Dashboard](sites-project://appgprj_123):",
      "Chart: Active accounts over time",
      "Selected point: 2026-03-30 · Active Users · 6K",
      "Question: Why did this number go up?",
    ].join("\n"),
  );
  assert.doesNotMatch(prompt, /Dashboard URL:|token=private|#selection/u);
});

test("Sites handoff references preserve punctuation with canonical title escaping", () => {
  for (const [title, escapedTitle] of [
    ["Revenue: *growth* + 12%!", "Revenue: *growth* + 12%!"],
    ["Data `quality`", "Data `quality`"],
    ["[Overview](quarterly)", "\\[Overview\\]\\(quarterly)"],
    ["North \\ South", "North \\\\ South"],
    ["Weekly\r\nactivity", "Weekly activity"],
  ]) {
    const prompt = dashboardAskPrompt({
      question: "What changed?",
      dashboardTitle: title,
      dashboardProjectId: "appgprj_123",
      selectedContext: "Entire dashboard",
    });
    assert.equal(
      prompt.split("\n")[0],
      `Answer this question about [${escapedTitle}](sites-project://appgprj_123):`,
      title,
    );
  }
});

test("omits unavailable or unsafe optional context", () => {
  assert.equal(
    dashboardAskPrompt({
      question: "What changed?",
      dashboardTitle: "Engagement",
      dashboardUrl: "file:///tmp/dashboard.html",
      dashboardProjectRoot: "/workspace/revenue-dashboard",
      selectedContext: "Selected text · “Retention”",
    }),
    [
      "Dashboard: Engagement",
      "Dashboard project directory: /workspace/revenue-dashboard",
      "Selected context: Selected text · “Retention”",
      "Question: What changed?",
    ].join("\n"),
  );
  assert.equal(
    dashboardAskPrompt({
      question: "   ",
      dashboardTitle: "Engagement",
      selectedContext: "Retention",
    }),
    null,
  );
});

test("Ask never forwards credentials from an unsafe optional dashboard URL", () => {
  const prompt = dashboardAskPrompt({ question: "What changed?", dashboardTitle: "Review",
    dashboardUrl: "https://user:secret@dashboard.example/?token=PRIVATE_TOKEN", selectedContext: "Entire dashboard" });
  assert.doesNotMatch(prompt, /secret|PRIVATE_TOKEN|user:|token=/u);
});
