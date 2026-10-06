import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/generate.mjs";

test("finance fixture preserves its base measurement invariants", () => {
  const data = fixture();
  for (const row of data.queries.market_prices.rows) {
    assert.ok(row.low <= Math.min(row.open,row.close));
    assert.ok(row.high >= Math.max(row.open,row.close));
    assert.ok(row.volume >= 0);
  }
  const tickers = new Set(data.queries.market_prices.rows.map(row => row.ticker));
  assert.deepEqual(new Set(data.queries.analyst_scenarios.rows.map(row => row.ticker)), tickers,
    "Every watchlist stock has matching, explicitly illustrative scenario evidence");
  for (const ticker of tickers) {
    const rows = data.queries.market_prices.rows.filter(row => row.ticker === ticker);
    assert.equal(new Set(rows.map(row => row.date)).size, rows.length);
    assert.equal(rows.at(-1).date, "2026-08-21");
    assert.ok(rows.length >= 1250, "Each stock supports the full displayed five-year window");
  }
});

import { availableTimeframes, timeframeRows, bucketRows, scenarioResults } from "../content/dashboard/model.js";

test("calendar windows use loaded coverage, not fixed trading-row counts", () => {
  const rows = ["2026-01-01", "2026-06-30", "2026-07-01", "2026-07-31"].map(date => ({date}));
  assert.deepEqual(timeframeRows(rows, "1M").map(row => row.date), ["2026-07-01", "2026-07-31"]);
  assert.deepEqual(timeframeRows(rows, "YTD"), rows);
  assert.deepEqual(availableTimeframes(rows), ["1M", "3M", "6M", "YTD", "All"]);
  assert.deepEqual(availableTimeframes(rows.slice(-1)), ["All"]);
  assert.deepEqual(timeframeRows([], "1Y"), []);
  assert.deepEqual(availableTimeframes([]), []);
  assert.deepEqual(timeframeRows(["2024-02-29", "2024-03-01", "2024-03-31"].map(date => ({date})), "1M").map(row => row.date), ["2024-03-01", "2024-03-31"]);
});

test("candle compression conserves OHLC, volume and interval identity including the last partial bucket", () => {
  const rows = [
    {date:"2026-08-03", open:10, high:16, low:9, close:14, volume:100},
    {date:"2026-08-04", open:14, high:15, low:7, close:8, volume:200},
    {date:"2026-08-05", open:8, high:12, low:6, close:11, volume:300},
    {date:"2026-08-06", open:11, high:20, low:10, close:18, volume:400},
    {date:"2026-08-07", open:18, high:21, low:16, close:17, volume:500},
  ];
  assert.deepEqual(bucketRows(rows, 2), [
    {date:"2026-08-05", startDate:"2026-08-03", sessions:3, open:10, high:16, low:6, close:11, volume:600},
    {date:"2026-08-07", startDate:"2026-08-06", sessions:2, open:11, high:21, low:10, close:17, volume:900},
  ]);
  assert.equal(bucketRows(rows, 10), rows);
  assert.deepEqual(bucketRows([], 2), []);
  assert.throws(() => bucketRows(rows, 0));
});

test("long/short scenarios use inspectable assumptions and reject missing inputs", () => {
  const outlook = {horizon:"1 month", bearPercent:-20, bullPercent:30};
  const long = scenarioResults(100, 10, "Long", outlook), short = scenarioResults(100, 10, "Short", outlook);
  assert.equal(long.bearPrice, 80); assert.equal(long.bullPrice, 130);
  assert.equal(long.bearResult, -200); assert.equal(long.bullResult, 300);
  assert.equal(short.bearResult, 200); assert.equal(short.bullResult, -300);
  for (const side of ["Long", "Short"]) {
    const emptyPosition = scenarioResults(100, 0, side, outlook);
    assert.equal(emptyPosition.bearResult, 0);
    assert.equal(emptyPosition.bullResult, 0);
    assert.equal(scenarioResults(100, 10, side, { ...outlook, bearPercent: 0 }).bearResult, 0);
  }
  for (const args of [[null,10,"Long",outlook], [100,"","Long",outlook], [100,-1,"Long",outlook], [100,10,"Sell",outlook], [100,10,"Long",null], [100,10,"Long",{...outlook,bearPercent:null}]]) assert.equal(scenarioResults(...args), null);
  const data = fixture();
  for (const row of data.queries.scenario_outlooks.rows) assert.ok(scenarioResults(100, 10, "Long", row));
  assert.deepEqual(new Set(data.queries.analyst_scenarios.rows.map(row => row.ticker)), new Set(data.queries.market_prices.rows.map(row => row.ticker)));
});

import { priceStatistics, watchNotes } from "../content/dashboard/model.js";

test("price statistics and watch notes describe evidence, with stable dates across timeframe changes", () => {
  const rows = [
    {date:"2026-05-01",open:90,high:105,low:89,close:100,volume:100},
    {date:"2026-06-01",open:100,high:125,low:99,close:120,volume:300},
    {date:"2026-07-01",open:120,high:121,low:80,close:90,volume:200},
    {date:"2026-08-01",open:90,high:115,low:88,close:110,volume:200},
  ];
  const stats = priceStatistics(rows);
  assert.equal(stats.averageVolume,200); assert.equal(stats.relativeVolume,1);
  assert.equal(stats.yearHigh,125); assert.equal(stats.yearLow,80); assert.equal(stats.drawdown,-.25);
  assert.ok(Math.abs(stats.yearChange-.1)<1e-10);
  assert.equal(priceStatistics([]),null); assert.deepEqual(watchNotes([]),[]);
  const notes = watchNotes(rows);
  assert.equal(notes.find(note=>note.type==="Volume").date,"2026-06-01");
  assert.equal(notes.find(note=>note.type==="Fall").date,"2026-07-01");
  assert.match(notes.find(note=>note.type==="Fall").detail,/-25.00%/);
  assert.equal(notes.find(note=>note.type==="High").price,125);
  const narrower = timeframeRows(rows,"3M");
  const visible = notes.filter(note=>note.date>=narrower[0].date);
  assert.deepEqual(visible.map(note=>note.date),["2026-06-01","2026-06-01","2026-07-01","2026-08-01"]);
  for(const note of visible) assert.ok(rows.some(row=>row.date===note.date && row.high===note.price));
  assert.equal(watchNotes(rows.map((row,index)=>({...row,close:100+index}))).some(note=>note.type==="Fall"),false);
});


test("news is independently sourced for every watchlist company with stable publication and event dates", () => {
  const data = fixture(), news = data.queries.company_news.rows;
  const tickers = new Set(data.queries.market_prices.rows.map(row => row.ticker));
  assert.deepEqual(new Set(news.map(row => row.ticker)), tickers);
  for (const ticker of tickers) {
    const stories = news.filter(row => row.ticker === ticker);
    assert.ok(stories.length >= 4, `${ticker} needs at least four real news/events cards`);
    assert.equal(new Set(stories.map(row => row.url)).size, stories.length,
      `${ticker} must not pad coverage by splitting one source into several cards`);
    assert.equal(new Set(stories.map(row => row.title)).size, stories.length);
    assert.equal(new Set(stories.map(row => `${row.ticker}-${row.date}-${row.type}`)).size, stories.length,
      "News cards need distinct component identities");
  }
  for (const row of news) {
    assert.ok(Number.isFinite(Date.parse(row.date)) && row.date <= "2026-08-25");
    assert.ok(row.date <= data.generatedAt.slice(0, 10), "No news may postdate the assembled snapshot");
    assert.equal(new URL(row.url).protocol, "https:");
    assert.ok(row.publisher && row.title && row.detail);
    if (row.eventDate) assert.ok(Number.isFinite(Date.parse(row.eventDate)) && row.eventDate >= row.date);
    assert.equal(row.close, undefined, "News does not assert a simulated market-price observation");
  }
  const copied = fixture();
  copied.queries.company_news.rows[0].title = "Changed";
  assert.notEqual(fixture().queries.company_news.rows[0].title, "Changed");
});
