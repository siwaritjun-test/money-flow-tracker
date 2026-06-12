#!/usr/bin/env node
/**
 * Server-side data fetcher — runs in GitHub Actions (Node 20+, no dependencies).
 * Fetches 1 year of daily bars for all tickers from Yahoo Finance,
 * writes data.json (rolling window) and merges into archive.json (grows forever).
 * Row format: [ts, close, volume, adjClose] — adjClose is dividend/split-adjusted
 * and is what the site uses for returns; raw close × volume is used for $ volume.
 * Validates every series (dedupe, ascending, positive prices, no absurd one-day
 * moves, recent last bar) and exits non-zero if too many tickers fail,
 * so a bad run never commits garbage.
 */
const fs = require("fs");
const path = require("path");
const { STOCK_UNIVERSE } = require("./stock_universe");

const TICKERS = [
  // cross-asset
  "SPY", "QQQ", "IWM", "EFA", "EEM", "AGG", "GLD", "USO", "UUP", "BTC-USD",
  // US sectors
  "XLK", "XLF", "XLV", "XLE", "XLI", "XLP", "XLY", "XLU", "XLB", "XLRE", "XLC",
  // bonds & credit
  "BIL", "SHY", "IEF", "TLT", "TIP", "LQD", "HYG", "EMB",
  // factors / style
  "IWF", "IWD", "MTUM", "QUAL", "USMV", "SPHB", "SPLV", "RSP", "SMH",
  // regime gauges (indices & futures — volume may be 0, used for ratios/levels only)
  "^VIX", "^TNX", "^IRX", "GC=F", "HG=F",
];

// individual stocks (stocks.html) — fetched with high/low for MFI/ATR,
// written to stocks.json, never archived (keeps archive.json lean).
// Universe: auto-refreshed S&P 500 list (universe.json, see fetch_universe.js),
// falling back to the built-in 88-stock list if it's missing/implausible.
function loadUniverse(root) {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(root, "universe.json"), "utf8"));
    if (u?.sectors && u.count > 450) return u.sectors;
  } catch (e) {}
  return STOCK_UNIVERSE;
}

const ROOT = path.join(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchTicker(t, withHL = false, attempt = 1) {
  const host = attempt % 2 ? "query1" : "query2"; // alternate hosts on retry
  const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error("no timestamps");
    const q = res.indicators.quote[0];
    const adj = res.indicators.adjclose?.[0]?.adjclose;
    // one row per UTC day, last write wins (dedupes intraday repeats), validated
    const byDay = new Map();
    for (let i = 0; i < res.timestamp.length; i++) {
      const c = q.close[i], v = q.volume[i];
      if (c == null || v == null || !(c > 0) || v < 0) continue;
      const a = (adj && adj[i] > 0) ? adj[i] : c;
      const ts = res.timestamp[i] * 1000;
      const row = [ts, +c.toFixed(4), v, +a.toFixed(4)];
      if (withHL) {
        const h = q.high[i], l = q.low[i];
        row.push(+(h > 0 ? h : c).toFixed(4), +(l > 0 ? l : c).toFixed(4));
      }
      byDay.set(new Date(ts).toISOString().slice(0, 10), row);
    }
    const rows = [...byDay.values()].sort((x, y) => x[0] - y[0]);
    if (rows.length < 25) throw new Error("too few rows: " + rows.length);
    // sanity: flag absurd one-day moves (bad ticks). Crypto and indices exempt —
    // VIX legitimately spikes >35%/day, and low short-term yields (^IRX) move hugely in % terms.
    // Single stocks can gap >35% on earnings, so they get a looser 60% threshold.
    if (!t.includes("-USD") && !t.startsWith("^")) {
      const maxMove = withHL ? 0.60 : 0.35;
      for (let i = 1; i < rows.length; i++) {
        const chg = rows[i][3] / rows[i - 1][3] - 1;
        if (Math.abs(chg) > maxMove) throw new Error(`suspect bar: ${(chg * 100).toFixed(1)}% on ${new Date(rows[i][0]).toISOString().slice(0, 10)}`);
      }
    }
    // sanity: last bar must be recent (≤7 days), else the feed is stale/broken
    if (Date.now() - rows[rows.length - 1][0] > 7 * 86400000) throw new Error("stale: last bar " + new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10));
    return rows;
  } catch (e) {
    if (attempt < 4) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return fetchTicker(t, withHL, attempt + 1);
    }
    console.error(`FAIL ${t}: ${e.message}`);
    return null;
  }
}

async function fetchSet(tickers, withHL, workers = 3) {
  const series = {};
  let idx = 0, ok = 0;
  async function worker() {
    while (idx < tickers.length) {
      const t = tickers[idx++];
      const rows = await fetchTicker(t, withHL);
      if (rows) { series[t] = rows; ok++; console.log(`OK   ${t}: ${rows.length} bars, last close ${rows[rows.length - 1][1]}`); }
      await new Promise(r => setTimeout(r, 250)); // be polite
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return { series, ok };
}

/* ~500 tickers → refreshed once per trading day: skip when the existing file
   already has the same last bar day as SPY and is <20h old (the screener's
   metrics are daily anyway, and this keeps repo history from ballooning). */
async function updateStocks(etfSeries) {
  const stockTickers = [...new Set(Object.values(loadUniverse(ROOT)).flatMap(l => l.map(s => s.t)))];
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks.json"), "utf8"));
    const ageH = (Date.now() - Date.parse(prev.updated)) / 36e5;
    const lastDay = rows => new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10);
    const prevRows = prev.series && Object.values(prev.series)[0];
    const sameUniverse = prev.tickers >= stockTickers.length * 0.9;
    if (ageH < 20 && sameUniverse && etfSeries.SPY && prevRows && lastDay(etfSeries.SPY) === lastDay(prevRows)) {
      console.log(`stocks.json is current (${ageH.toFixed(1)}h old, same last bar) — skipping stock fetch.`);
      return;
    }
  } catch (e) { /* no previous stocks.json → fetch */ }
  const stk = await fetchSet(stockTickers, true, 5);
  if (stk.ok >= stockTickers.length * 0.7) {
    fs.writeFileSync(path.join(ROOT, "stocks.json"),
      JSON.stringify({ updated: new Date().toISOString(), tickers: stk.ok, series: stk.series }));
    console.log(`Wrote stocks.json (${stk.ok}/${stockTickers.length} stocks)`);
  } else {
    console.error(`Only ${stk.ok}/${stockTickers.length} stocks fetched — keeping previous stocks.json.`);
  }
}

(async function main() {
  const { series, ok } = await fetchSet(TICKERS, false);

  if (ok < TICKERS.length * 0.7) {
    console.error(`Only ${ok}/${TICKERS.length} tickers fetched — aborting without writing.`);
    process.exit(1);
  }

  // data.json — rolling window the site loads directly (no CORS proxies needed)
  const out = { updated: new Date().toISOString(), tickers: ok, series };
  fs.writeFileSync(path.join(ROOT, "data.json"), JSON.stringify(out));
  console.log(`Wrote data.json (${ok} tickers)`);

  // stocks.json — individual stocks for stocks.html, row [ts, close, vol, adj, high, low].
  // A bad stock run never blocks the ETF data above or the archive merge below.
  await updateStocks(series);

  // archive.json — permanent daily-close history, merged across runs
  const archPath = path.join(ROOT, "archive.json");
  let arch = {};
  try { arch = JSON.parse(fs.readFileSync(archPath, "utf8")); } catch (e) {}
  let added = 0;
  for (const [t, rows] of Object.entries(series)) {
    arch[t] = arch[t] || {};
    for (const [ts, close, vol] of rows) {
      const day = new Date(ts).toISOString().slice(0, 10);
      if (!arch[t][day]) added++;
      arch[t][day] = [close, vol];
    }
  }
  fs.writeFileSync(archPath, JSON.stringify(arch));
  console.log(`Merged archive.json (+${added} new daily bars)`);
})();
