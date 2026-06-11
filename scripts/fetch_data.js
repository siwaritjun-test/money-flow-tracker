#!/usr/bin/env node
/**
 * Server-side data fetcher — runs in GitHub Actions (Node 20+, no dependencies).
 * Fetches 6 months of daily bars for all tickers from Yahoo Finance,
 * writes data.json (rolling window) and merges into archive.json (grows forever).
 * Exits non-zero if too many tickers fail, so a bad run never commits garbage.
 */
const fs = require("fs");
const path = require("path");

const TICKERS = [
  // cross-asset
  "SPY", "QQQ", "IWM", "EFA", "EEM", "AGG", "GLD", "USO", "UUP", "BTC-USD",
  // US sectors
  "XLK", "XLF", "XLV", "XLE", "XLI", "XLP", "XLY", "XLU", "XLB", "XLRE", "XLC",
  // bonds & credit
  "BIL", "SHY", "IEF", "TLT", "TIP", "LQD", "HYG", "EMB",
];

const ROOT = path.join(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchTicker(t, attempt = 1) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=6mo&interval=1d`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error("no timestamps");
    const q = res.indicators.quote[0];
    const rows = [];
    for (let i = 0; i < res.timestamp.length; i++) {
      const c = q.close[i], v = q.volume[i];
      if (c != null && v != null) rows.push([res.timestamp[i] * 1000, +c.toFixed(4), v]);
    }
    if (rows.length < 25) throw new Error("too few rows: " + rows.length);
    return rows;
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 2000 * attempt));
      return fetchTicker(t, attempt + 1);
    }
    console.error(`FAIL ${t}: ${e.message}`);
    return null;
  }
}

(async function main() {
  const series = {};
  let idx = 0, ok = 0;
  async function worker() {
    while (idx < TICKERS.length) {
      const t = TICKERS[idx++];
      const rows = await fetchTicker(t);
      if (rows) { series[t] = rows; ok++; console.log(`OK   ${t}: ${rows.length} bars, last close ${rows[rows.length - 1][1]}`); }
      await new Promise(r => setTimeout(r, 300)); // be polite
    }
  }
  await Promise.all([worker(), worker(), worker()]);

  if (ok < TICKERS.length * 0.7) {
    console.error(`Only ${ok}/${TICKERS.length} tickers fetched — aborting without writing.`);
    process.exit(1);
  }

  // data.json — rolling window the site loads directly (no CORS proxies needed)
  const out = { updated: new Date().toISOString(), tickers: ok, series };
  fs.writeFileSync(path.join(ROOT, "data.json"), JSON.stringify(out));
  console.log(`Wrote data.json (${ok} tickers)`);

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
