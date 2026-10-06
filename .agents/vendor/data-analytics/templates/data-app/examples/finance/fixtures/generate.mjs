import { news, newsVerifiedAt } from "./news.mjs";
const stocks = [
  { ticker: "COST", company: "Costco", sector: "Retail", startPrice: 432, drift: .00045, volatility: .013, baseVolume: 3100000 },
  { ticker: "WM", company: "Waste Management", sector: "Environmental services", startPrice: 150, drift: .00027, volatility: .010, baseVolume: 1500000 },
  { ticker: "GRMN", company: "Garmin", sector: "Consumer devices", startPrice: 145, drift: .00029, volatility: .018, baseVolume: 1100000 },
  { ticker: "AZO", company: "AutoZone", sector: "Auto parts", startPrice: 1540, drift: .00035, volatility: .014, baseVolume: 190000 },
  { ticker: "FDX", company: "FedEx", sector: "Logistics", startPrice: 272, drift: -.00008, volatility: .020, baseVolume: 2900000 },
  { ticker: "CTAS", company: "Cintas", sector: "Business services", startPrice: 108, drift: .00038, volatility: .014, baseVolume: 1700000 },
  { ticker: "MKC", company: "McCormick", sector: "Food and flavor", startPrice: 82, drift: -.00011, volatility: .013, baseVolume: 2100000 },
  { ticker: "FAST", company: "Fastenal", sector: "Industrial supplies", startPrice: 29, drift: .00031, volatility: .016, baseVolume: 5200000 },
];

const round = (value, digits = 2) => Number(value.toFixed(digits));
const seedFrom = (value) => [...value].reduce((total, character) => total + character.charCodeAt(0), 0) * 104729;

function marketHistory(stock) {
  let seed = seedFrom(stock.ticker);
  const random = () => {
    seed = seed * 48271 % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const rows = [];
  const date = new Date("2021-08-20T12:00:00Z");
  let previousClose = stock.startPrice;
  while (rows.length < 1305) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const cycle = Math.sin(rows.length / 37 + seedFrom(stock.ticker) / 10000) * .0017;
    const overnight = (random() - .5) * stock.volatility * .55;
    const sessionMove = stock.drift + cycle + (random() - .49) * stock.volatility;
    const open = Math.max(5, previousClose * (1 + overnight));
    const close = Math.max(5, open * (1 + sessionMove));
    const spread = stock.volatility * (.34 + random() * .72);
    const high = Math.max(open, close) * (1 + spread);
    const low = Math.min(open, close) * (1 - spread * .82);
    const volume = Math.round(stock.baseVolume * (.64 + random() * .72 + Math.abs(sessionMove) * 8.5));
    rows.push({
      ticker: stock.ticker,
      company: stock.company,
      sector: stock.sector,
      date: date.toISOString().slice(0, 10),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume,
    });
    previousClose = close;
  }
  return rows;
}

const priceRows = stocks.flatMap(marketHistory);
const analystViews = {
  COST: { label: "Moderate buy", score: 68, buy: 16, hold: 9, sell: 2 },
  WM: { label: "Moderate buy", score: 62, buy: 11, hold: 8, sell: 3 },
  GRMN: { label: "Moderate buy", score: 64, buy: 12, hold: 8, sell: 3 },
  AZO: { label: "Moderate buy", score: 67, buy: 14, hold: 8, sell: 3 },
  FDX: { label: "Hold", score: 49, buy: 9, hold: 14, sell: 6 },
  CTAS: { label: "Moderate buy", score: 63, buy: 11, hold: 8, sell: 3 },
  MKC: { label: "Hold", score: 48, buy: 5, hold: 12, sell: 4 },
  FAST: { label: "Hold", score: 52, buy: 7, hold: 11, sell: 4 },
};


export const snapshot = {
  id: "finance-example",
  title: "Stock watch",
  generatedAt: "2026-08-25T18:00:00Z",
  status: "fixture",
  surface: "dashboard",
  filters: [],
  queries: {
    company_news: { rows: news, source: { label: "Company newsrooms and investor relations",
      caveats: [`Primary-source stories verified ${newsVerifiedAt}; curated snapshot, not a live feed. Publication dates are distinct from scheduled event dates. Price and scenario data elsewhere in this dashboard are synthetic and do not explain these events.`] } },
    analyst_scenarios: { rows: Object.entries(analystViews).map(([ticker, values]) => ({ticker, ...values})),
      source: { label: "Illustrative analyst assumptions", caveats: ["Synthetic recommendations; not collected analyst research or derived from prices."] } },
    scenario_outlooks: { rows: [["1 month",-8,10],["3 months",-14,18],["6 months",-20,28],["1 year",-28,42]].map(([horizon,bearPercent,bullPercent]) => ({horizon,bearPercent,bullPercent})),
      source: { label: "Illustrative price-change assumptions", caveats: ["Modeled scenarios, not observed returns or forecasts. Excludes fees, dividends and borrowing costs."] } },
    market_prices: {
      rows: priceRows,
      source: {
        label: "Synthetic fixture: reviewed daily market prices",
        sql: "SELECT trading_date AS date, ticker, company, sector, open, high, low, close, volume FROM fixture.daily_market_prices ORDER BY ticker, trading_date",
        tables: ["fixture.daily_market_prices"],
        metricDefinitions: [
          { label: "Price statistics and price events",
            definition: "Period changes compare the first and last loaded closes in each calendar window, excluding dividends. Trailing-year high/low use daily extremes; maximum drawdown is the worst closing-price decline from a prior closing peak within that year. Relative volume divides latest volume by its trailing 30-session mean. Price-event annotations select the trailing-year highest-volume session, largest positive/negative close-to-close moves and intraday high; notes keep those dates when the visible range changes. No corporate news or fundamentals are inferred.",
            componentIds: ["finance-price-volume"],
            sourceLineage: [{ tables: ["fixture.daily_market_prices"] }] },
          {
            label: "Daily OHLC price",
            definition: "Modeled opening, high, low, and closing prices for each fictional trading session.",
            componentIds: ["finance-price-volume", "finance-market-overview", "finance-trade-planner"],
            sourceLineage: [{ tables: ["fixture.daily_market_prices"] }],
          },
          {
            label: "Trading volume",
            definition: "Modeled shares traded during each fictional trading session.",
            componentIds: ["finance-price-volume", "finance-market-overview"],
            sourceLineage: [{ tables: ["fixture.daily_market_prices"] }],
          },
        ],
      },
    },
  },
};

export function fixture() { return structuredClone(snapshot); }
