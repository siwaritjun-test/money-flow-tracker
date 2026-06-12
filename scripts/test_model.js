#!/usr/bin/env node
/* Sanity-checks the Stock Picker model against the real data.json / stocks.json.
   Run: node scripts/test_model.js — exits non-zero on any failed assertion. */
const fs = require("fs");
const path = require("path");
const { STOCK_UNIVERSE, SECTOR_NAMES } = require("./stock_universe");
const { buildModel, mfi, atr, nRet } = require("./stock_model");

const ROOT = path.join(__dirname, "..");
const toRows = arr => arr.map(([ts, close, vol, adj, high, low]) => ({
  ts, close, vol, adj: adj > 0 ? adj : close,
  high: high > 0 ? high : close, low: low > 0 ? low : close,
}));

let failures = 0;
const check = (cond, msg) => { if (cond) { console.log("PASS  " + msg); } else { failures++; console.error("FAIL  " + msg); } };

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
const stk = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks.json"), "utf8"));
const etf = {}, stocks = {};
for (const [t, rows] of Object.entries(data.series)) etf[t] = toRows(rows);
for (const [t, rows] of Object.entries(stk.series)) stocks[t] = toRows(rows);

const model = buildModel(stocks, STOCK_UNIVERSE, etf);

check(model.stocks.length >= 80, `model built: ${model.stocks.length} stocks scored`);
check(model.secList.length === 11, `all 11 sectors ranked (${model.secList.length})`);
check(model.stocks.every(s => s.score >= 0 && s.score <= 100), "all composite scores within 0–100");
check(model.stocks.every(s => s.mfi == null || (s.mfi >= 0 && s.mfi <= 100)), "all MFI values within 0–100");
check(model.stocks.every(s => s.atr == null || s.atr > 0), "all ATR values positive");
check(model.stocks.every(s => s.prox52 == null || (s.prox52 > 0.2 && s.prox52 <= 1.0001)), "52w-high proximity in (0.2, 1]");
check(model.stocks.every(s => s.obvT == null || Math.abs(s.obvT) <= 21.0001), "OBV trend bounded by ±21 days");

// scores must actually discriminate
const scores = model.stocks.map(s => s.score);
check(Math.max(...scores) - Math.min(...scores) > 30, `score spread ${(Math.max(...scores) - Math.min(...scores)).toFixed(0)} > 30`);

// the top stock should look like a momentum leader: positive 3m RS or near its high
const top = model.stocks[0];
check(top.rs63 > 0 || top.prox52 > 0.9, `top pick ${top.t} (score ${top.score.toFixed(0)}) has rs63=${(top.rs63 * 100).toFixed(1)}% prox52=${(top.prox52 * 100).toFixed(0)}%`);

// sector ranks are a permutation of 1..11
const ranks = model.secList.map(s => s.rank).sort((a, b) => a - b).join(",");
check(ranks === "1,2,3,4,5,6,7,8,9,10,11", "sector ranks are 1..11");

// hand-verify MFI bounds & ATR on one well-known series
const nvda = stocks.NVDA;
check(Math.abs(nRet(nvda, 21)) < 1, `NVDA 1m return sane: ${(nRet(nvda, 21) * 100).toFixed(1)}%`);
check(atr(nvda) < nvda[nvda.length - 1].close * 0.15, "NVDA ATR < 15% of price");
check(mfi(nvda) >= 0 && mfi(nvda) <= 100, `NVDA MFI = ${mfi(nvda).toFixed(1)}`);

// breadth fractions in [0,1]
const b = model.breadth;
check([b.pctAbove20, b.pctAbove50, b.advancers, b.near52].every(v => v >= 0 && v <= 1), "breadth fractions in [0,1]");

console.log("\n--- Sector ranking (1m+3m excess vs SPY) ---");
for (const s of model.secList) {
  console.log(`#${String(s.rank).padStart(2)} ${s.t.padEnd(5)} ${SECTOR_NAMES[s.t].padEnd(15)} quad=${(s.rrg ? s.rrg.quad : "–").padEnd(10)} ex1m=${(s.ex21 * 100).toFixed(1).padStart(6)}% ex3m=${(s.ex63 * 100).toFixed(1).padStart(6)}% flow=${s.flow == null ? "–" : s.flow.toFixed(0).padStart(6) + "M/d"}`);
}
console.log("\n--- Top 10 momentum picks (all sectors) ---");
for (const s of model.stocks.slice(0, 10)) {
  console.log(`${s.t.padEnd(6)} ${s.n.padEnd(20)} ${s.sector.padEnd(5)} score=${s.score.toFixed(0).padStart(3)} 1m=${(s.ret21 * 100).toFixed(1).padStart(6)}% rs1m=${(s.rs21 * 100).toFixed(1).padStart(6)}% MFI=${s.mfi.toFixed(0).padStart(3)} OBV=${s.obvT.toFixed(1).padStart(5)} 52wH=${(s.prox52 * 100).toFixed(0)}%${s.flagHi ? " HI" : ""}${s.flagVol ? " VOL" : ""}`);
}
console.log(`\nBreadth: above20=${(b.pctAbove20 * 100).toFixed(0)}% above50=${(b.pctAbove50 * 100).toFixed(0)}% advancers=${(b.advancers * 100).toFixed(0)}% near52wH=${(b.near52 * 100).toFixed(0)}% medianRet1m=${(b.medRet21 * 100).toFixed(1)}%`);

if (failures) { console.error(`\n${failures} assertion(s) FAILED`); process.exit(1); }
console.log("\nAll assertions passed.");
