import React, { useEffect, useMemo, useRef, useState } from "react";

import {
  DataComponent,
  Chart,
  barChartSpec,
  MetricSparkline,
  SegmentedControl,
  Slider,
  useDataApp,
} from "../../data-app-public.jsx";
import { Icon } from "../../data-app-public.jsx";
import "./example.css";
import { timeframeRows, availableTimeframes, bucketRows, scenarioResults, priceStatistics, watchNotes } from "./model.js";

const currency = (value) => Number.isFinite(value) ? new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2,
}).format(value) : "—";
const compactNumber = (value) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0);
const axisNumber = (value) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value ?? 0);
const axisCompactNumber = (value) => new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 0 }).format(value ?? 0);
const signedPercent = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%` : "—";
const companyName = (value) => value && value === value.toUpperCase()
  ? `${value.slice(0, 1)}${value.slice(1).toLowerCase()}`
  : value;
const shortDate = (value) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
  .format(new Date(`${value}T00:00:00Z`));
const longDate = (value) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  .format(new Date(`${value}T00:00:00Z`));

function useContainerWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(900);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(1, entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function FlagIcon({ className, x, y }) {
  return <svg className={className} x={x} y={y} width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 4.6405C8.14486 3.74467 9.6336 4.18817 11.3124 4.81067C11.4311 4.85469 11.5513 4.89999 11.6733 4.94593C13.3072 5.56146 15.2418 6.29025 17.7738 5.55804C17.8375 5.53959 17.9132 5.55221 17.9674 5.58773C17.9883 5.60145 17.9973 5.61409 18 5.61808C18 5.61771 18 5.61838 18 5.61808V14.2515C15.8581 14.7894 14.3554 14.3169 12.6399 13.7776C12.448 13.7172 12.2535 13.6561 12.0551 13.5954C11.0694 13.2939 9.9815 13.0088 8.73583 13.0151C7.88099 13.0195 6.97966 13.1602 6 13.4946V4.6405ZM18 14.2793C18 14.2796 18 14.2796 18 14.2793V14.2793ZM6 15.637C7.06717 15.1778 7.95744 15.0191 8.74594 15.0151C9.68064 15.0104 10.5334 15.2214 11.4701 15.5079C11.657 15.5651 11.8472 15.6255 12.0411 15.6871C13.7733 16.2375 15.806 16.8834 18.556 16.1737C19.4513 15.9427 20 15.1264 20 14.2793V5.61808C20 4.07013 18.4318 3.28578 17.2182 3.63676C15.3407 4.17972 13.9832 3.67282 12.3112 3.04849C12.2112 3.01116 12.1101 2.97341 12.0077 2.93544C10.1745 2.25566 8.06074 1.59139 5.17004 2.81992C4.41981 3.13876 4 3.87464 4 4.61804V21C4 21.5523 4.44772 22 5 22C5.55228 22 6 21.5523 6 21V15.637Z" fill="currentColor" />
  </svg>;
}

function CandlestickVolumeChart({ rows, costBasis, stories }) {
  const plotted = useMemo(() => bucketRows(rows), [rows]);
  const [containerRef, width] = useContainerWidth();
  const [activeIndex, setActiveIndex] = useState(null);
  const [hoveredStoryIndex, setHoveredStoryIndex] = useState(null);
  const height = 548;
  const margin = { top: 18, right: 0, bottom: 30, left: 4 };
  const valueBadgeWidth = 44;
  const volumeHeight = 52;
  const plotGap = 26;
  const plotWidth = width - margin.left - margin.right;
  const priceHeight = height - margin.top - margin.bottom - volumeHeight - plotGap;
  const minimum = Math.min(...plotted.map((row) => row.low));
  const maximum = Math.max(...plotted.map((row) => row.high));
  const pricePadding = Math.max(1, (maximum - minimum) * .08);
  const priceMin = minimum - pricePadding;
  const priceMax = maximum + pricePadding;
  const volumeMax = Math.max(...plotted.map((row) => row.volume), 1);
  const step = plotWidth / Math.max(1, plotted.length);
  const candleWidth = Math.max(1.5, Math.min(9, step * .68));
  const xFor = (index) => margin.left + step * (index + .5);
  const priceY = (value) => margin.top + (priceMax - value) / (priceMax - priceMin) * priceHeight;
  const volumeTop = margin.top + priceHeight + plotGap;
  const volumeY = (value) => volumeTop + volumeHeight - value / volumeMax * volumeHeight;
  const priceTicks = Array.from({ length: 5 }, (_, index) => priceMin + (priceMax - priceMin) * index / 4).reverse();
  const spansYears = rows[0]?.date.slice(0, 4) !== rows.at(-1)?.date.slice(0, 4);
  // End labels face inward. Allow room for those full labels plus the half-width
  // of the next centered tick, including the wider monospace themes.
  const dateIntervals = Math.max(1, Math.min(4, Math.floor(plotWidth / (spansYears ? 110 : 84))));
  const dateTickIndexes = Array.from(new Set(Array.from({ length: dateIntervals + 1 }, (_, index) =>
    Math.min(plotted.length - 1, Math.round((plotted.length - 1) * index / dateIntervals)))));
  const active = activeIndex == null ? null : plotted[activeIndex];
  const activeX = active == null ? null : xFor(activeIndex);
  const activeY = active == null ? null : priceY(active.high);
  const latest = plotted.at(-1);
  const axisDate = new Intl.DateTimeFormat(undefined, { month: "short",
    ...(spansYears ? { year: "numeric" } : { day: "numeric" }), timeZone: "UTC" });
  const costBasisY = priceY(costBasis);
  const latestY = priceY(latest?.close);
  const storyPoints = stories.map((story) => {
    const storyIndex = plotted.reduce((best, row, index) =>
      Math.abs(new Date(row.date) - new Date(story.date)) < Math.abs(new Date(plotted[best].date) - new Date(story.date)) ? index : best, 0);
    return {
      ...story,
      x: xFor(storyIndex),
      y: Math.max(margin.top + 12, priceY(plotted[storyIndex].high) - 16),
    };
  });
  const hoveredStory = hoveredStoryIndex == null ? null : storyPoints[hoveredStoryIndex];

  function updateActive(event) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const localX = event.clientX - bounds.left - margin.left;
    const nextIndex = Math.max(0, Math.min(plotted.length - 1, Math.floor(localX / step)));
    setActiveIndex(nextIndex);
  }

  return <div className="finance-combined-chart" ref={containerRef}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label="Candlestick price chart with trading volume"
      onPointerMove={updateActive} onPointerLeave={() => setActiveIndex(null)}>
      <defs>
        <linearGradient id="finance-story-stem" x1="0" y1={volumeTop + volumeHeight} x2="0" y2={margin.top}
          gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#73737a" stopOpacity=".1" />
          <stop offset="100%" stopColor="#73737a" stopOpacity=".6" />
        </linearGradient>
      </defs>
      {priceTicks.map((tick) => <g key={tick}>
        <line className="finance-grid-line" x1={margin.left} x2={width}
          y1={priceY(tick)} y2={priceY(tick)} />
        <text className="finance-axis-label" x={width + 8} y={priceY(tick) + 4} textAnchor="start">
          ${axisNumber(tick)}
        </text>
      </g>)}
      {Number.isFinite(costBasis) && costBasisY >= margin.top && costBasisY <= margin.top + priceHeight && <g className="finance-position-marker">
        <line x1={margin.left} x2={width} y1={costBasisY} y2={costBasisY} data-kind="basis" />
        <text className="finance-position-name" x={margin.left + 7} y={costBasisY - 7}>Modeled basis</text>
        <rect className="finance-position-value-bg" data-kind="basis" x={width + 4}
          y={costBasisY - 10} width={valueBadgeWidth} height="20" rx="4" />
        <text className="finance-position-value" x={width + 4 + valueBadgeWidth / 2} y={costBasisY + 4} textAnchor="middle">
          ${axisNumber(costBasis)}
        </text>
      </g>}
      <g className="finance-position-marker">
        <line x1={margin.left} x2={width} y1={latestY} y2={latestY} data-kind="last" />
        <text className="finance-position-name" x={margin.left + 7} y={latestY - 7}>Last price</text>
        <rect className="finance-position-value-bg" data-kind="last" x={width + 4}
          y={latestY - 10} width={valueBadgeWidth} height="20" rx="4" />
        <text className="finance-position-value" x={width + 4 + valueBadgeWidth / 2} y={latestY + 4} textAnchor="middle">
          ${axisNumber(latest?.close)}
        </text>
      </g>
      <text className="finance-axis-label" x={width + 8} y={volumeTop + 4} textAnchor="start">{axisCompactNumber(volumeMax)}</text>
      <text className="finance-axis-label" x={width + 8} y={volumeTop + volumeHeight} textAnchor="start">0</text>
      {active && !hoveredStory && <rect
        className="finance-hover-band"
        x={Math.max(margin.left, activeX - step / 2)}
        y={margin.top}
        width={Math.min(step, width - Math.max(margin.left, activeX - step / 2))}
        height={volumeTop + volumeHeight - margin.top}
        rx={Math.min(4, step / 3)}
        aria-hidden="true"
      />}
      {plotted.map((row, index) => {
        const positive = row.close >= row.open;
        const bodyTop = Math.min(priceY(row.open), priceY(row.close));
        const bodyHeight = Math.max(1.5, Math.abs(priceY(row.open) - priceY(row.close)));
        return <g key={row.date} className="finance-candle" data-direction={positive ? "up" : "down"}>
          <line className="finance-candle-wick" x1={xFor(index)} x2={xFor(index)}
            y1={priceY(row.high)} y2={priceY(row.low)} />
          <rect className="finance-candle-body" x={xFor(index) - candleWidth / 2} y={bodyTop}
            width={candleWidth} height={bodyHeight} rx={Math.min(1.5, candleWidth / 4)} />
          <rect className="finance-volume-bar" x={xFor(index) - Math.max(1, candleWidth * .46)}
            y={volumeY(row.volume)} width={Math.max(1.5, candleWidth * .92)}
            height={volumeTop + volumeHeight - volumeY(row.volume)} rx={1} />
        </g>;
      })}
      {storyPoints.map((story, index) => {
        return <g className="finance-story-marker" data-kind={story.type.toLowerCase()}
          data-active={hoveredStoryIndex === index || undefined} key={`${story.date}-${story.type}`}
          role="button" tabIndex="0" aria-label={`${story.type}: ${story.title}, ${longDate(story.date)}`}
          onPointerEnter={() => setHoveredStoryIndex(index)} onPointerLeave={() => setHoveredStoryIndex(null)}
          onFocus={() => setHoveredStoryIndex(index)} onBlur={() => setHoveredStoryIndex(null)}>
          <line x1={story.x} x2={story.x} y1={story.y + 10} y2={volumeTop + volumeHeight} />
          <circle cx={story.x} cy={story.y} r="10" />
          <FlagIcon className="finance-story-flag" x={story.x - 6} y={story.y - 6} />
        </g>;
      })}
      {dateTickIndexes.map((index) => <text key={index} className="finance-axis-label finance-date-label"
        x={index === 0 ? margin.left : index === plotted.length - 1 ? width : xFor(index)}
        y={height - 4} textAnchor={index === 0 ? "start" : index === plotted.length - 1 ? "end" : "middle"}>
        {axisDate.format(new Date(`${plotted[index].date}T00:00:00Z`))}
      </text>)}
    </svg>
    {active && !hoveredStory && <div className="finance-chart-tooltip chart-tooltip chart-tooltip--plain" role="status"
      data-horizontal={activeX > width * .7 ? "end" : "start"}
      data-vertical={activeY < height * .3 ? "below" : "above"}
      style={{ left: `${activeX / width * 100}%`, top: `${activeY / height * 100}%` }}>
      <strong>{active.startDate ? `${shortDate(active.startDate)} – ${longDate(active.date)}` : longDate(active.date)}</strong>
      <span>Open<b>{currency(active.open)}</b></span>
      <span>High<b>{currency(active.high)}</b></span>
      <span>Low<b>{currency(active.low)}</b></span>
      <span>Close<b>{currency(active.close)}</b></span>
      <span>Volume<b>{compactNumber(active.volume)}</b></span>
    </div>}
    {hoveredStory && <div className="finance-story-tooltip chart-tooltip chart-tooltip--plain" role="status"
      data-horizontal={hoveredStory.x > width * .62 ? "end" : "start"}
      style={{ left: `${hoveredStory.x / width * 100}%`, top: `${hoveredStory.y / height * 100}%` }}>
      <time>{longDate(hoveredStory.date)}</time>
      <strong>{hoveredStory.title}</strong>
      <p>{hoveredStory.detail}</p>
    </div>}
  </div>;
}

function MiniSparkline({ values, negative }) {
  const width = 64;
  const height = 24;
  const minimum = Math.min(...values);
  const range = Math.max(1, Math.max(...values) - minimum);
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const medianY = height - 2 - (median - minimum) / range * (height - 4);
  const points = values.map((value, index) =>
    `${index / Math.max(1, values.length - 1) * width},${height - 2 - (value - minimum) / range * (height - 4)}`).join(" ");
  return <svg className="finance-watch-spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" data-negative={negative || undefined}>
    <line className="finance-watch-median" x1="0" x2={width} y1={medianY} y2={medianY} />
    <polyline points={points} fill="none" />
  </svg>;
}

function StockNavigation({ stocks, histories, selectedTicker, timeframe, onSelect }) {
  return <nav className="finance-stock-list" aria-label="Watched stocks">
    {stocks.map((stock) => {
      const rows = timeframeRows(histories[stock.ticker], timeframe);
      const latest = rows.at(-1);
      const change = rows[0]?.close ? latest.close / rows[0].close - 1 : 0;
      const sparkValues = rows.slice(-24).map((row) => row.close);
      return <button key={stock.ticker} type="button" aria-pressed={stock.ticker === selectedTicker}
        onClick={() => onSelect(stock.ticker)}>
        <span><strong>{stock.ticker}</strong><small>{stock.company}</small></span>
        <MiniSparkline values={sparkValues} negative={change < 0} />
        <span className="finance-nav-quote"><strong>{currency(latest?.close)}</strong>
          <small data-negative={change < 0 || undefined}>{signedPercent(change)}</small></span>
      </button>;
    })}
  </nav>;
}

function MarketMetrics({ rows }) {
  const latest = rows.at(-1);
  const stats = priceStatistics(rows);
  const groups = [
    [["Open", currency(latest.open)], ["High", currency(latest.high)], ["Low", currency(latest.low)]],
    [["Volume", compactNumber(latest.volume)], ["30-session avg.", compactNumber(stats.averageVolume)],
      ["Relative volume", stats.relativeVolume == null ? "—" : `${stats.relativeVolume.toFixed(2)}×`]],
    [["High", currency(stats.yearHigh)], ["Low", currency(stats.yearLow)], ["Max. drawdown", signedPercent(stats.drawdown), stats.drawdown]],
    [["1 month", signedPercent(stats.monthChange), stats.monthChange], ["Year to date", signedPercent(stats.ytdChange), stats.ytdChange], ["1 year", signedPercent(stats.yearChange), stats.yearChange]],
  ];
  const headings = ["Latest session", "Trading volume", "Past-year range", "Price change"];
  return <div className="finance-statistics">
    <div className="finance-market-metrics">
      {groups.map((metrics, groupIndex) => <section key={groupIndex}>
        <h3>{headings[groupIndex]}</h3>
        <dl>{metrics.map(([label, value, change]) => <div key={label}><dt>{label}</dt>
          <dd data-tone={Number.isFinite(change) && change !== 0 ? change < 0 ? "negative" : "positive" : undefined}>{value}</dd></div>)}</dl>
      </section>)}
    </div>
  </div>;
}

function CompanyNews({ stories }) {
  const carouselRef = useRef(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  useEffect(() => {
    const element = carouselRef.current;
    if (!element) return;
    const update = () => setEdges(previous => {
      const next = { start: element.scrollLeft > 2, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 };
      return previous.start === next.start && previous.end === next.end ? previous : next;
    });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    element.addEventListener("scroll", update, { passive: true });
    element.scrollLeft = 0;
    update();
    return () => { observer.disconnect(); element.removeEventListener("scroll", update); };
  }, [stories[0]?.ticker]);
  const moveCarousel = (direction) => carouselRef.current?.scrollBy({ left: direction * 250, behavior: "smooth" });
  return <DataComponent variant="plain" id="finance-stories" queryId="company_news" kind="custom"
    title="News & events" description="Curated primary-source news, verified August 25, 2026—not a live feed. News follows the selected company, independently of the simulated price chart’s timeframe."
    sourceRows={stories} displayRows={stories} className="finance-stories-card">
    <div className="finance-story-controls" aria-label="Story carousel controls">
      <button type="button" aria-label="Previous stories" disabled={!edges.start} onClick={() => moveCarousel(-1)}>
        <Icon name="chevronLeft" size={20} />
      </button>
      <button type="button" aria-label="Next stories" disabled={!edges.end} onClick={() => moveCarousel(1)}>
        <Icon name="chevronRight" size={20} />
      </button>
    </div>
    <div className="finance-story-list" ref={carouselRef} data-fade-start={edges.start || undefined} data-fade-end={edges.end || undefined}>
      {!stories.length && <p>No sourced news is available for this company.</p>}
      {stories.map((story) => <DataComponent key={`${story.date}-${story.type}`} variant="card" kind="custom"
        id={`finance-news-${story.ticker.toLowerCase()}-${story.date}-${story.type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
        title={story.title} queryId="company_news" sourceRows={[story]} displayRows={[story]}
        showHeading={false} showActions={false} className="finance-news-card">
        <a href={story.url} target="_blank" rel="noopener noreferrer">
        <span className="finance-news-meta"><time dateTime={story.date}>{longDate(story.date)}</time><span>{story.type}</span></span>
        <strong>{story.title}</strong>
        <p>{story.detail}</p>
        <span className="finance-news-source">{story.publisher}<Icon name="arrowUpRight" size={14} /></span>
        </a>
      </DataComponent>)}
    </div>
  </DataComponent>;
}

function AnalystConsensus({ ticker }) {
  const { reviewedRows } = useDataApp();
  const analyst = reviewedRows("analyst_scenarios", ["ticker"]).find(row => row.ticker === ticker);
  if (!analyst) return null;
  const analystCount = analyst.buy + analyst.hold + analyst.sell;
  const consensusRows = [{ scope: "Analyst recommendations", sell: analyst.sell, hold: analyst.hold, buy: analyst.buy }];
  const consensusSpec = barChartSpec({
    type: "bar",
    category: "scope",
    presentation: "segmented",
    series: [
      { key: "sell", label: "Sell", color: "var(--negative)" },
      { key: "hold", label: "Hold", color: "var(--border-strong)" },
      { key: "buy", label: "Buy", color: "var(--positive)" },
    ],
    axes: false,
    labels: { value: false, position: "below", align: "spread", primary: "value", secondary: "label" },
    style: { thickness: 7, radius: 999, segmentGap: 3, fontSize: 14 },
  });
  return <DataComponent variant="card" id="finance-analyst-consensus" queryId="analyst_scenarios" kind="chart"
    chart={consensusSpec}
    title="Illustrative analyst views" description={`Synthetic demo ratings, not collected analyst research or an investment recommendation. ${analystCount} sample ratings: ${analyst.buy} buy, ${analyst.hold} hold, and ${analyst.sell} sell.`}
    sourceRows={[analyst]} displayRows={consensusRows} className="finance-rail-card finance-analyst-card">
    <div className="finance-analyst-heading"><strong data-neutral={analyst.label === "Hold" || undefined}>{analyst.label}</strong></div>
    <Chart className="finance-consensus-renderer" spec={consensusSpec} rows={consensusRows} />
  </DataComponent>;
}

function TradePlanner({ rows }) {
  const latest = rows.at(-1);
  const currentPrice = latest?.close ?? 0;
  const { reviewedRows } = useDataApp();
  const outlookRows = reviewedRows("scenario_outlooks", ["horizon"]);
  const horizons = outlookRows.map(row => row.horizon);
  const [side, setSide] = useState("Long");
  const [shares, setShares] = useState(10);
  const [horizon, setHorizon] = useState("3 months");
  const outlook = outlookRows.find(row => row.horizon === horizon) ?? outlookRows[0];

  const result = scenarioResults(currentPrice, shares, side, outlook);
  const { bearResult = null, bullResult = null } = result ?? {};
  const maxResult = Math.max(Math.abs(bearResult ?? 0), Math.abs(bullResult ?? 0), 1);
  const resultY = (value) => 48 - value / maxResult * 28;
  const signedCurrency = (value) => `${value > 0 ? "+" : ""}${currency(value)}`;

  return <DataComponent variant="card" id="finance-trade-planner" queryId="market_prices" queryIds={["market_prices", "scenario_outlooks"]} kind="custom"
    title="Trade scenario" description="Illustrative long/short price scenarios, not forecasts. Entry is the latest synthetic close; excludes fees, dividends and borrowing costs."
    sourceRowsByQuery={{market_prices: rows, scenario_outlooks: outlook ? [outlook] : []}} displayRows={result ? [result] : []} className="finance-rail-card finance-planner-card">
    <SegmentedControl className="finance-order-side" ariaLabel="Order side"
      value={side} fullWidth options={["Long", "Short"]} onChange={setSide} />
    <label className="finance-share-input">
      <span>Shares</span>
      <input type="number" min="1" max="100" step="1" inputMode="numeric" value={shares}
        onChange={(event) => setShares(event.target.value)}
        onBlur={() => setShares(Math.min(100, Math.max(1, Number(shares) || 1)))} />
    </label>
    <Slider className="finance-outlook-slider" label="Outlook timeframe"
      showBounds={false}
      min={0} max={Math.max(0, horizons.length - 1)} step={1}
      value={Math.max(0, horizons.indexOf(outlook?.horizon))}
      onChange={(value) => setHorizon(horizons[value])}
      formatValue={(value) => horizons[value]} />
    {result && <div className="finance-outlook-chart">
      <div><span>Scenario profit / loss</span></div>
      <div className="finance-outlook-values">
        <strong data-negative={bearResult < 0 || undefined}>{signedCurrency(bearResult)}</strong>
        <strong data-negative={bullResult < 0 || undefined}>{signedCurrency(bullResult)}</strong>
      </div>
      <svg viewBox="0 0 238 82" preserveAspectRatio="none" role="img" aria-label={`${horizon} scenario profit or loss: bear ${signedCurrency(bearResult)}, bull ${signedCurrency(bullResult)}`}>
        <line className="finance-outlook-zero" x1="12" y1="48" x2="226" y2="48" />
        <g className="finance-outlook-segment" data-negative={bearResult < 0 || undefined}>
          <path d={`M 12 ${resultY(bearResult)} L 119 48 L 12 48 Z`} />
          <line x1="12" y1={resultY(bearResult)} x2="119" y2="48" />
          <circle cx="12" cy={resultY(bearResult)} r="3" />
        </g>
        <g className="finance-outlook-segment" data-negative={bullResult < 0 || undefined}>
          <path d={`M 119 48 L 226 ${resultY(bullResult)} L 226 48 Z`} />
          <line x1="119" y1="48" x2="226" y2={resultY(bullResult)} />
          <circle cx="226" cy={resultY(bullResult)} r="3" />
        </g>
      </svg>
      <div className="finance-outlook-labels"><span>Bear</span><span>Break-even</span><span>Bull</span></div>
    </div>}
  </DataComponent>;
}

export function DashboardContent() {
  const { reviewedRows, snapshot, appTitle, setAppTitle } = useDataApp();
  useEffect(() => {
    if (snapshot.status === "fixture" && ["Finance", "Juniper · Stock watch"].includes(appTitle)) setAppTitle(snapshot.title);
  }, [snapshot.title, snapshot.status, appTitle, setAppTitle]);
  const allRows = reviewedRows("market_prices", ["ticker", "date"]);
  const stocks = useMemo(() => [...new Map(allRows.map((row) => [row.ticker, {
    ticker: row.ticker, company: row.company, sector: row.sector,
  }])).values()], [allRows]);
  const histories = useMemo(() => Object.fromEntries(stocks.map((stock) => [stock.ticker,
    allRows.filter((row) => row.ticker === stock.ticker).sort((a, b) => a.date.localeCompare(b.date))])), [allRows, stocks]);
  const [selectedTicker, setSelectedTicker] = useState(stocks[0]?.ticker ?? "");
  const [timeframe, setTimeframe] = useState("1Y");
  const stock = stocks.find((item) => item.ticker === selectedTicker) ?? stocks[0];
  const history = histories[stock?.ticker] ?? [];
  const timeframes = availableTimeframes(history);
  const selectedTimeframe = timeframes.includes(timeframe) ? timeframe : "All";
  const visibleRows = timeframeRows(history, selectedTimeframe);
  const latest = visibleRows.at(-1);
  const change = visibleRows[0]?.close ? latest.close / visibleRows[0].close - 1 : 0;
  const basisRows = history.slice(-90, -60);
  const costBasis = basisRows.length ? basisRows.reduce((sum, row) => sum + row.close, 0) / basisRows.length : null;
  const notes = useMemo(() => watchNotes(history), [history]);
  const stories = notes.filter(note => note.date >= visibleRows[0]?.date && note.date <= visibleRows.at(-1)?.date);
  const newsRows = reviewedRows("company_news", ["ticker"]);
  const companyNews = useMemo(() => newsRows.filter(row => row.ticker === stock?.ticker)
    .toSorted((a,b) => b.date.localeCompare(a.date)), [newsRows, stock?.ticker]);

  if (!stock) return <p>No reviewed price history is available.</p>;
  return <article className="page finance-example-page" data-dashboard-layout="viewport">
    <section className="finance-hero" aria-label="Stock market dashboard">
      <aside className="finance-left-rail" aria-label="Watchlist">
        <DataComponent variant="card" id="finance-watchlist" title="Watchlist" queryId="market_prices"
          kind="custom" sourceRows={allRows} showActions={false} className="finance-watchlist-card">
          <StockNavigation stocks={stocks} histories={histories} selectedTicker={stock?.ticker}
            timeframe={selectedTimeframe} onSelect={setSelectedTicker} />
        </DataComponent>
      </aside>
      <div className="finance-workspace" role="region" aria-label="Stock details" tabIndex={0}>
      <div className="finance-main-column">
        <DataComponent variant="plain" id="finance-price-volume" queryId="market_prices" kind="custom"
          title="Price and volume" description="Synthetic OHLC prices and trading volume on independent axes. The illustrative basis is the mean closing price from sessions 61–90 before the latest session, not an actual holding."
          sourceRows={history} displayRows={visibleRows} className="finance-chart-panel">
          <div className="finance-chart-toolbar">
            <div className="finance-security-summary">
              <div className="finance-security-title">
                <strong>{companyName(stock?.company)}</strong>
                <span>{stock?.ticker}</span>
              </div>
              <div className="finance-security-price">
                <strong>{currency(latest?.close)}</strong>
                <span data-negative={change < 0 || undefined}>{signedPercent(change)}</span>
              </div>
            </div>
            <SegmentedControl className="finance-timeframes" ariaLabel="Chart timeframe"
              value={selectedTimeframe} options={timeframes} onChange={setTimeframe} />
          </div>
          <CandlestickVolumeChart rows={visibleRows} costBasis={costBasis} stories={stories} />
        </DataComponent>
        <DataComponent variant="card" id="finance-market-overview" className="finance-market-card" queryId="market_prices" kind="custom" title="Market overview"
          description="Latest session, trailing price range and volume statistics from the selected security's synthetic price history." sourceRows={history} displayRows={history}>
          <MarketMetrics rows={history} />
        </DataComponent>
        <CompanyNews stories={companyNews} />
      </div>
      <aside className="finance-right-rail" aria-label="Supporting market data">
        <AnalystConsensus ticker={stock?.ticker} />
        <TradePlanner rows={history} />
      </aside>
      </div>
    </section>
  </article>;
}
