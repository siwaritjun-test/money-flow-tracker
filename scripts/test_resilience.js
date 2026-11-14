#!/usr/bin/env node
/* Checks the bear-market resilience math on synthetic series with known answers,
   then sanity-checks it against the real data.json / stocks.json.
   Run: node scripts/test_resilience.js — exits non-zero on any failed assertion. */
const fs = require("fs");
const path = require("path");
const { STOCK_UNIVERSE } = require("./stock_universe");
const { maxDrawdown, stressWindow, ols, resilienceMetrics, resQuadrant, buildResilience, marketBear } = require("./resilience_model");

const ROOT = path.join(__dirname, "..");
const toRows = arr => arr.map(([ts, close, vol, adj, high, low]) => ({
  ts, close, vol, adj: adj > 0 ? adj : close,
  high: high > 0 ? high : close, low: low > 0 ? low : close,
}));

let failures = 0;
const check = (cond, msg) => { if (cond) { console.log("PASS  " + msg); } else { failures++; console.error("FAIL  " + msg); } };
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) <= tol;

/* ---------- synthetic ---------- */
const DAY = 864e5, T0 = Date.UTC(2026, 0, 5, 14, 30);
const series = closes => closes.map((c, i) => ({ ts: T0 + i * DAY, close: c, adj: c, vol: 1e6, high: c, low: c }));

// sector: 60 days up 0.5%/day, then 40 days alternating −2% / +0.5% (an active bear)
const secR = [];
for (let i = 0; i < 60; i++) secR.push(0.005);
for (let i = 0; i < 40; i++) secR.push(i % 2 ? 0.005 : -0.02);
const path_ = (rets, k = 1, a = 0) => { const out = [100]; for (const r of rets) out.push(out[out.length - 1] * (1 + a + k * r)); return out; };
const sector = series(path_(secR));
const half = series(path_(secR, 0.5));          // moves half as much as the sector
const twice = series(path_(secR, 2));           // twice as much
const alphaS = series(path_(secR, 1, 0.001));   // the sector + 0.1%/day

check(near(maxDrawdown([100, 120, 90, 130, 117]).dd, -0.25), "maxDrawdown finds the deepest peak-to-trough (−25%)");
const w = stressWindow(sector);
check(w && w.active && w.peak === 60 && w.end === 100, `active stress window from the high to today (peak ${w && w.peak}, end ${w && w.end})`);
check(w.status === "bear" && w.depth < -0.1, `status "bear", depth ${(w.depth * 100).toFixed(1)}%`);
const fit = ols([1, 2, 3, 4, 5, 6], [3, 5, 7, 9, 11, 13]);
check(near(fit.beta, 2) && near(fit.alpha, 1), "ols recovers y = 1 + 2x");

const mHalf = resilienceMetrics(half, sector, w);
const mTwice = resilienceMetrics(twice, sector, w);
const mSame = resilienceMetrics(sector, sector, w);
check(near(mHalf.downCap, 0.5) && near(mHalf.upCap, 0.5), "half-beta stock: down/up capture = 0.5");
check(near(mTwice.downCap, 2) && near(mTwice.upCap, 2), "double-beta stock: down/up capture = 2");
check(near(mSame.downCap, 1) && near(mSame.relDD, 1) && near(mSame.relRet, 0) && near(mSame.beta, 1), "the sector vs itself: capture 1, relDD 1, rel return 0, beta 1");
check(mHalf.relDD < 1 && mTwice.relDD > 1, `relative drawdown orders correctly (${mHalf.relDD.toFixed(2)} < 1 < ${mTwice.relDD.toFixed(2)})`);
const mAlpha = resilienceMetrics(alphaS, sector, w);
check(near(mAlpha.alpha21, 0.021, 1e-3) && near(mAlpha.beta, 1, 0.02), `alpha stock: +2.1%/month alpha (${(mAlpha.alpha21 * 100).toFixed(2)}%), beta ≈ 1`);
check(resQuadrant(mHalf) === "Defensive" && resQuadrant(mTwice) === "High beta", "quadrants: half-beta Defensive, double-beta High beta");
check(resQuadrant({ downCap: 0.6, upCap: 1.3 }) === "Leader" && resQuadrant({ downCap: 1.4, upCap: 0.7 }) === "Fragile", "quadrants: Leader / Fragile");

const synth = buildResilience({ H: half, D: twice, A: alphaS, S: sector },
  { XLK: [{ t: "H", n: "Half" }, { t: "D", n: "Double" }, { t: "A", n: "Alpha" }, { t: "S", n: "Same" }] }, { XLK: sector });
const rank = t => synth.stocks.findIndex(s => s.t === t);
check(rank("D") === synth.stocks.length - 1, "double-beta stock scores last among its peers");
check(synth.stocks.every(s => s.score >= 0 && s.score <= 100), "synthetic scores within 0–100");

// a sector that fell 12% and fully recovered → a "past" window, not active
const recov = series(path_([...Array(30).fill(0.004), ...Array(20).fill(-0.0065), ...Array(40).fill(0.006)]));
const wr = stressWindow(recov);
check(wr && !wr.active && wr.end === wr.trough && wr.status === "recovered", `recovered sector uses its past episode (status ${wr && wr.status})`);

/* ---------- real data ---------- */
let data, stk;
try {
  data = JSON.parse(fs.readFileSync(path.join(ROOT, "data.json"), "utf8"));
  stk = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks.json"), "utf8"));
} catch (e) { console.log("SKIP  real-data checks (data.json / stocks.json not present)"); }
if (data && stk) {
  const etf = {}, stocks = {};
  for (const [t, rows] of Object.entries(data.series)) etf[t] = toRows(rows);
  for (const [t, rows] of Object.entries(stk.series)) stocks[t] = toRows(rows);
  let universe = STOCK_UNIVERSE;
  try {
    const u = JSON.parse(fs.readFileSync(path.join(ROOT, "universe.json"), "utf8"));
    if (u?.sectors && u.count > 450) universe = u.sectors;
  } catch (e) {}
  const expected = Object.values(universe).flat().length;
  const res = buildResilience(stocks, universe, etf);
  check(Object.keys(res.sectors).length === 11, `stress window for all 11 sectors (${Object.keys(res.sectors).length})`);
  check(res.stocks.length >= expected * 0.85, `resilience scored for ${res.stocks.length}/${expected} stocks`);
  check(res.stocks.every(s => s.score >= 0 && s.score <= 100), "all scores within 0–100");
  check(res.stocks.every(s => s.relDD == null || s.relDD >= 0), "relative drawdown never negative");
  check(res.stocks.every(s => s.stockDD <= 0 && s.secDD <= 0), "drawdowns are ≤ 0");
  check(res.stocks.every(s => s.rsHigh > 0 && s.rsHigh <= 1.0001), "RS-line proximity within (0, 1]");
  check(res.stocks.every(s => s.quad), "every stock has a quadrant");
  const mb = marketBear(etf.SPY);
  check(mb && mb.dd <= 0, `market backdrop: SPY ${(mb.dd * 100).toFixed(1)}% from high, ${mb.below200 ? "below" : "above"} 200d`);

  console.log("\nSector stress windows:");
  for (const s of Object.values(res.sectors)) {
    const w = s.win;
    console.log(`  ${s.t.padEnd(5)} ${w.status.padEnd(9)} ${w.peakDate} → ${w.troughDate}  depth ${(w.depth * 100).toFixed(1).padStart(6)}%  now ${(w.curDD * 100).toFixed(1).padStart(6)}%  (${s.n} stocks)`);
  }
  console.log("\nTop 10 resilient (vs own sector):");
  for (const s of res.stocks.slice(0, 10)) {
    console.log(`  ${s.t.padEnd(6)} ${s.sector.padEnd(5)} score ${s.score.toFixed(0).padStart(3)}  ${s.quad.padEnd(9)} downCap ${s.downCap.toFixed(2)}  DD ${(s.stockDD * 100).toFixed(1)}% vs ${(s.secDD * 100).toFixed(1)}%  α/mo ${(s.alpha21 * 100).toFixed(1)}%${s.rsLead ? "  RS-LEAD" : ""}`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
