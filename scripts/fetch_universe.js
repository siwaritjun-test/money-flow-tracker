#!/usr/bin/env node
/**
 * Refreshes universe.json — the full S&P 500 constituent list (ticker, name,
 * GICS sector mapped to its SPDR sector ETF) parsed from Wikipedia.
 * Runs in GitHub Actions before fetch_data.js; no dependencies.
 * On any failure it exits 0 WITHOUT writing, so the site keeps the last good
 * universe (or falls back to the built-in 88-stock list in stock_universe.js).
 */
const fs = require("fs");
const path = require("path");

const URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
const UA = "money-flow-tracker/1.0 (github.com/siwaritjun-test/money-flow-tracker)";
const ROOT = path.join(__dirname, "..");

const SECTOR_TO_ETF = {
  "Information Technology": "XLK", "Financials": "XLF", "Health Care": "XLV",
  "Energy": "XLE", "Industrials": "XLI", "Consumer Staples": "XLP",
  "Consumer Discretionary": "XLY", "Utilities": "XLU", "Materials": "XLB",
  "Real Estate": "XLRE", "Communication Services": "XLC",
};

const strip = html => html.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();

(async function main() {
  try {
    const r = await fetch(URL, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const html = await r.text();
    const tableMatch = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
    if (!tableMatch) throw new Error("constituents table not found");
    const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/g).slice(1); // skip header
    const sectors = {};
    let count = 0;
    for (const tr of rows) {
      const tds = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/g);
      if (!tds || tds.length < 3) continue;
      const sym = strip(tds[0]).replace(/\./g, "-"); // BRK.B → BRK-B (Yahoo format)
      const name = strip(tds[1]);
      const etf = SECTOR_TO_ETF[strip(tds[2])];
      if (!sym || !/^[A-Z][A-Z0-9-]{0,6}$/.test(sym) || !name || !etf) continue;
      (sectors[etf] = sectors[etf] || []).push({ t: sym, n: name });
      count++;
    }
    // sanity: a real S&P 500 list has ~500 names across all 11 sectors
    if (count < 450 || Object.keys(sectors).length !== 11) {
      throw new Error(`implausible parse: ${count} tickers, ${Object.keys(sectors).length} sectors`);
    }
    for (const list of Object.values(sectors)) list.sort((a, b) => a.t.localeCompare(b.t));
    fs.writeFileSync(path.join(ROOT, "universe.json"),
      JSON.stringify({ updated: new Date().toISOString(), source: "wikipedia S&P 500", count, sectors }));
    console.log(`Wrote universe.json: ${count} tickers across ${Object.keys(sectors).length} sectors`);
  } catch (e) {
    console.error("Universe refresh failed (keeping previous universe.json): " + e.message);
  }
})();
