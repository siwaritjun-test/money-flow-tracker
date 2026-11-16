#!/usr/bin/env node
/**
 * Builds what the Stock Picker actually loads, so the page never downloads raw bars:
 *
 *   screen.json — per-stock metrics for the S&P 500 + Nasdaq-100 (bars from
 *                 stocks.json) plus the extended universe: every other
 *                 US-listed common stock with a market cap of $1B or more.
 *   sparks.json — 90-day price sparklines, loaded only when a row is opened.
 *
 * The extended list comes from Nasdaq's public screener (ticker, name, market
 * cap, sector, industry). Its bars are fetched from Yahoo here, turned into
 * metrics and thrown away — they are never committed. Runs after fetch_data.js
 * and rebuilds only when stocks.json has been refreshed (once per trading day).
 * A failed run keeps the previous files; nothing here can fail the workflow.
 */
const fs = require("fs");
const path = require("path");
const { fetchSet, loadUniverse, trackedTickers } = require("./fetch_data");
const { stockMetrics, describeStock } = require("./stock_model");

const ROOT = path.join(__dirname, "..");
const MIN_CAP_M = 1000; // extended universe floor, $ millions
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8"));
const toRows = rows => rows.map(([ts, close, vol, adj, high, low]) => ({
  ts, close, vol, adj: adj > 0 ? adj : close, high: high > 0 ? high : close, low: low > 0 ? low : close,
}));

// Nasdaq's sector labels → the SPDR sector ETF used as the benchmark.
// "Miscellaneous"/blank have no benchmark and go to OTHER (no RS columns).
const NASDAQ_TO_ETF = {
  "Technology": "XLK", "Finance": "XLF", "Health Care": "XLV", "Energy": "XLE",
  "Industrials": "XLI", "Consumer Staples": "XLP", "Consumer Discretionary": "XLY",
  "Utilities": "XLU", "Basic Materials": "XLB", "Real Estate": "XLRE", "Telecommunications": "XLC",
};
// The screener also lists preferreds, notes, warrants, units and LP interests
// under the issuer's market cap; only common shares belong in a stock screen.
const NOT_COMMON = /%|preferred|depositary|\bnotes?\b|debenture|warrant|\bunits?\b|\brights?\b|subordinated|\bL\.?P\.?\b/i;
const cleanName = n => n.replace(/\s+(Class [A-Z]\s+)?(Common Stock|Common Shares|Ordinary Shares|Common Stock.*|Class [A-Z].*)$/i, "").replace(/\s+/g, " ").trim();

async function extendedUniverse(coreTickers) {
  const r = await fetch("https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true",
    { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const rows = (await r.json())?.data?.rows || [];
  const out = {};
  let n = 0;
  for (const row of rows) {
    const mc = Math.round(parseFloat(row.marketCap) / 1e6);
    const t = String(row.symbol).trim().replace(/[/.]/g, "-"); // BRK/B, LEN.B → Yahoo's BRK-B, LEN-B
    if (!(mc >= MIN_CAP_M) || row.country !== "United States") continue;
    if (!/^[A-Z][A-Z0-9-]{0,6}$/.test(t) || coreTickers.has(t) || NOT_COMMON.test(row.name)) continue;
    const sec = NASDAQ_TO_ETF[row.sector] || "OTHER";
    (out[sec] = out[sec] || []).push({ t, n: cleanName(row.name), ind: row.industry || "", mc });
    n++;
  }
  if (n < 500) throw new Error(`implausible extended universe: ${n} tickers`);
  return out;
}

/* ---- compact encoding ---- */
const COLS = ["t", "n", "sector", "ind", "mc", "ix", "price", "lastTs", "chg1d", "ret5", "ret21", "ret63", "mfi",
  "obvT", "flow21", "atr", "volX", "prox52", "trend", "avgDollarVol", "unusualVol"];
const rnd = (v, d) => v == null || !isFinite(v) ? null : +v.toFixed(d);
const sig = (v, n = 5) => v == null || !isFinite(v) ? null : +v.toPrecision(n);
function encodeRow(m) {
  return [m.t, m.n, m.sector, m.ind, m.mc,
    (m.sp ? 1 : 0) | (m.ndx ? 2 : 0) | (m.ext ? 4 : 0),
    sig(m.price, 6), Math.round(m.lastTs / 1000), rnd(m.chg1d, 4), rnd(m.ret5, 4), rnd(m.ret21, 4), rnd(m.ret63, 4),
    rnd(m.mfi, 1), rnd(m.obvT, 2), sig(m.flow21, 4), sig(m.atr, 4), rnd(m.volX, 3), rnd(m.prox52, 4),
    (m.aboveS20 ? 1 : 0) | (m.aboveS50 ? 2 : 0), Math.round(m.avgDollarVol || 0), rnd(m.unusualVol, 2)];
}
// sparkline → two base-36 chars per point, scaled 0–1295 between its own min and max
function encodeSpark(vals) {
  const min = Math.min(...vals), span = (Math.max(...vals) - min) || 1;
  return vals.map(v => Math.round((v - min) / span * 1295).toString(36).padStart(2, "0")).join("");
}

(async function main() {
  let data, stk;
  try { data = readJson("data.json"); stk = readJson("stocks.json"); }
  catch (e) { console.error("build_screen: data.json / stocks.json missing — skipped."); return; }

  let prev = null;
  try { prev = readJson("screen.json"); } catch (e) {}
  if (prev && prev.coreUpdated === stk.updated && prev.minCapM === MIN_CAP_M && !process.argv.includes("--force")) {
    console.log("screen.json is current (same stocks.json) — skipping.");
    return;
  }

  const core = loadUniverse(ROOT);
  const coreTickers = new Set(Object.values(core).flatMap(l => l.map(s => s.t)));

  // extended universe: fresh from the screener, else the list in the last screen.json
  let ext;
  try {
    ext = await extendedUniverse(coreTickers);
  } catch (e) {
    console.error("Extended universe refresh failed: " + e.message);
    ext = {};
    if (prev) {
      const c = Object.fromEntries(prev.cols.map((k, i) => [k, i]));
      for (const r of prev.rows) if (r[c.ix] & 4 && !coreTickers.has(r[c.t])) {
        (ext[r[c.sector]] = ext[r[c.sector]] || []).push({ t: r[c.t], n: r[c.n], ind: r[c.ind], mc: r[c.mc] });
      }
    }
  }
  const extTickers = Object.values(ext).flatMap(l => l.map(s => s.t));
  const tracked = trackedTickers(ROOT).filter(t => !stk.series[t] && !extTickers.includes(t));
  console.log(`Extended universe: ${extTickers.length} tickers (US, ≥ $${MIN_CAP_M / 1000}B, outside the S&P 500 / Nasdaq-100)`);

  // Smaller stocks legitimately gap far more than index members, so the bad-tick
  // check is loosened; two tries each — symbols Yahoo doesn't know just drop out.
  const fetched = await fetchSet([...extTickers, ...tracked], true, 6, { maxMove: 3, attempts: 2, quiet: true });
  console.log(`Extended bars: ${fetched.ok}/${extTickers.length + tracked.length} fetched`);
  if (extTickers.length && fetched.ok < extTickers.length * 0.6 && prev) {
    console.error("Too few extended tickers fetched — keeping the previous screen.json.");
    return;
  }

  // metrics
  const all = [], sparks = {};
  const add = (uni, series, isExt) => {
    for (const [sec, list] of Object.entries(uni)) for (const entry of list) {
      const raw = series[entry.t];
      const m = raw && stockMetrics(toRows(raw));
      if (!m) continue;
      sparks[entry.t] = encodeSpark(m.spark);
      all.push(describeStock(m, sec, entry, isExt));
    }
  };
  add(core, stk.series, false);
  add(ext, fetched.series, true);

  // Bars for open forward tests since their entry day (slim: ts, close, adj, low),
  // so the Stock Picker can show how they are doing without loading stocks.json.
  const fwd = {};
  try {
    for (const p of readJson("forward.json").positions || []) {
      if (!p.t || p.status !== "open" || fwd[p.t]) continue;
      const raw = stk.series[p.t] || fetched.series[p.t];
      if (!raw) continue;
      const from = Date.parse(p.entryDate) - 5 * 86400000;
      fwd[p.t] = raw.filter(r => r[0] >= from).map(r => [r[0], r[1], r[3], r[5]]);
    }
  } catch (e) {}

  const spy = data.series.SPY;
  const out = {
    updated: new Date().toISOString(),
    coreUpdated: stk.updated,
    barDay: spy ? new Date(spy[spy.length - 1][0]).toISOString().slice(0, 10) : null,
    minCapM: MIN_CAP_M,
    counts: { core: all.filter(m => !m.ext).length, ext: all.filter(m => m.ext).length },
    cols: COLS,
    rows: all.map(encodeRow),
    fwd,
  };
  if (out.counts.core < coreTickers.size * 0.7) {
    console.error(`Only ${out.counts.core}/${coreTickers.size} index stocks have metrics — keeping the previous screen.json.`);
    return;
  }
  fs.writeFileSync(path.join(ROOT, "screen.json"), JSON.stringify(out));
  fs.writeFileSync(path.join(ROOT, "sparks.json"), JSON.stringify({ updated: out.updated, points: 90, s: sparks }));
  console.log(`Wrote screen.json (${out.counts.core} index + ${out.counts.ext} extended stocks) and sparks.json`);
})().catch(e => console.error("build_screen failed (previous files kept): " + e.message));
