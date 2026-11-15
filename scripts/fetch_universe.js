#!/usr/bin/env node
/**
 * Refreshes universe.json — the S&P 500 plus the Nasdaq-100 (ticker, name,
 * sector mapped to its SPDR sector ETF), both parsed from Wikipedia.
 * Runs in GitHub Actions before fetch_data.js; no dependencies.
 *
 * The S&P 500 is required: if it fails, the script exits 0 WITHOUT writing, so
 * the site keeps the last good universe (or falls back to the built-in 88-stock
 * list in stock_universe.js). The Nasdaq-100 is an addition: if it fails, the
 * S&P 500 universe is still written, just without the Nasdaq-only names.
 *
 * Each entry is { t, n } plus flags: ndx: true when in the Nasdaq-100, and
 * sp: false for the Nasdaq-100 names that are not in the S&P 500.
 */
const fs = require("fs");
const path = require("path");

const SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const NDX_URL = "https://en.wikipedia.org/wiki/List_of_NASDAQ-100_companies";
const UA = "money-flow-tracker/1.0 (github.com/siwaritjun-test/money-flow-tracker)";
const ROOT = path.join(__dirname, "..");

// The S&P 500 list carries GICS sectors.
const SECTOR_TO_ETF = {
  "Information Technology": "XLK", "Financials": "XLF", "Health Care": "XLV",
  "Energy": "XLE", "Industrials": "XLI", "Consumer Staples": "XLP",
  "Consumer Discretionary": "XLY", "Utilities": "XLU", "Materials": "XLB",
  "Real Estate": "XLRE", "Communication Services": "XLC",
};
// The Nasdaq-100 list carries ICB industries instead. Only used for names not
// already in the S&P 500 (those keep their GICS sector); ICB and GICS mostly
// agree at this level, the main difference being that ICB files some internet
// platforms under Technology.
const ICB_TO_ETF = {
  "Technology": "XLK", "Telecommunications": "XLC", "Health Care": "XLV",
  "Financials": "XLF", "Real Estate": "XLRE", "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP", "Industrials": "XLI", "Basic Materials": "XLB",
  "Energy": "XLE", "Utilities": "XLU",
};

const TICKER_RE = /^[A-Z][A-Z0-9-]{0,6}$/;
const strip = html => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

// Returns rows as objects keyed by header text (footnote markers like "[2]" removed),
// so an added/reordered column on Wikipedia doesn't silently shift the parse.
async function tableRows(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const html = await r.text();
  const table = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
  if (!table) throw new Error("constituents table not found");
  const rows = table[0].match(/<tr[\s\S]*?<\/tr>/g)
    .map(tr => (tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g) || []).map(strip));
  const head = rows[0].map(h => h.replace(/\[[^\]]*\]/g, "").trim());
  return rows.slice(1).map(c => Object.fromEntries(head.map((h, i) => [h, c[i] || ""])));
}
const col = (row, ...names) => { for (const n of names) if (row[n]) return row[n]; return ""; };

async function sp500() {
  const out = [];
  for (const row of await tableRows(SP500_URL)) {
    const t = col(row, "Symbol", "Ticker").replace(/\./g, "-"); // BRK.B → BRK-B (Yahoo format)
    const n = col(row, "Security", "Company");
    const etf = SECTOR_TO_ETF[col(row, "GICS Sector")];
    if (TICKER_RE.test(t) && n && etf) out.push({ t, n, etf, ind: col(row, "GICS Sub-Industry") });
  }
  // sanity: a real S&P 500 list has ~500 names across all 11 sectors
  if (out.length < 450 || new Set(out.map(s => s.etf)).size !== 11) {
    throw new Error(`implausible S&P 500 parse: ${out.length} tickers`);
  }
  return out;
}

async function nasdaq100() {
  const out = [];
  for (const row of await tableRows(NDX_URL)) {
    const t = col(row, "Ticker", "Symbol").replace(/\./g, "-");
    const n = col(row, "Company", "Security");
    const etf = ICB_TO_ETF[col(row, "ICB Industry")];
    if (TICKER_RE.test(t) && n && etf) out.push({ t, n, etf, ind: col(row, "ICB Subsector") });
  }
  if (out.length < 95 || out.length > 110) throw new Error(`implausible Nasdaq-100 parse: ${out.length} tickers`);
  return out;
}

(async function main() {
  let sp;
  try {
    sp = await sp500();
  } catch (e) {
    console.error("Universe refresh failed (keeping previous universe.json): " + e.message);
    return;
  }

  let ndx = [];
  try {
    ndx = await nasdaq100();
  } catch (e) {
    console.error("Nasdaq-100 refresh failed (writing the S&P 500 only): " + e.message);
  }

  const inNdx = new Set(ndx.map(s => s.t));
  const inSp = new Set(sp.map(s => s.t));
  const sectors = {};
  const add = (etf, entry) => (sectors[etf] = sectors[etf] || []).push(entry);
  for (const s of sp) add(s.etf, inNdx.has(s.t) ? { t: s.t, n: s.n, ind: s.ind, ndx: true } : { t: s.t, n: s.n, ind: s.ind });
  const ndxOnly = ndx.filter(s => !inSp.has(s.t));
  for (const s of ndxOnly) add(s.etf, { t: s.t, n: s.n, ind: s.ind, ndx: true, sp: false });

  for (const list of Object.values(sectors)) list.sort((a, b) => a.t.localeCompare(b.t));
  const count = sp.length + ndxOnly.length;
  fs.writeFileSync(path.join(ROOT, "universe.json"), JSON.stringify({
    updated: new Date().toISOString(),
    source: ndx.length ? "wikipedia S&P 500 + Nasdaq-100" : "wikipedia S&P 500",
    count,
    sp500: sp.length,
    nasdaq100: ndx.length,
    sectors,
  }));
  console.log(`Wrote universe.json: ${count} tickers (S&P 500 ${sp.length}, Nasdaq-100 ${ndx.length}, ${ndxOnly.length} Nasdaq-only)`);
})();
