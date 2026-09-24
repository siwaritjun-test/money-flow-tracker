#!/usr/bin/env node
/* Checks the forward-test math on synthetic bars with known answers.
   Run: node scripts/test_forward.js — exits non-zero on any failed assertion. */
const { positionPerf, portfolioCurve, summarize, adjFactor } = require("./forward_model");

let failures = 0;
const check = (cond, msg) => { if (cond) console.log("PASS  " + msg); else { failures++; console.error("FAIL  " + msg); } };
const near = (a, b, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

// Sessions open at 13:30 UTC, as in stocks.json.
const ts = d => Date.parse(d + "T13:30:00Z");
const bar = (d, close, extra = {}) => Object.assign({ ts: ts(d), close, adj: close, vol: 1e6, high: close, low: close }, extra);

const stock = [
  bar("2026-09-01", 100),
  bar("2026-09-02", 104, { low: 99 }),
  bar("2026-09-03", 110),
  bar("2026-09-04", 96, { low: 94 }),   // trades through a 95 stop
  bar("2026-09-08", 105),
];
const spy = [bar("2026-09-01", 500), bar("2026-09-02", 505), bar("2026-09-03", 510), bar("2026-09-04", 500), bar("2026-09-08", 510)];

const pos = { t: "X", entryDate: "2026-09-01", entryPrice: 100, benchEntry: 500, stop: 95, status: "open" };
const p = positionPerf(pos, stock, spy);
check(near(p.ret, 0.05), `open return is last close vs entry: ${p.ret}`);
check(near(p.bench, 0.02), `SPY over the same days: ${p.bench}`);
check(near(p.excess, 0.03), `excess = return - SPY: ${p.excess}`);
check(near(p.mfe, 0.10), `best close since entry: ${p.mfe}`);
check(near(p.mae, -0.04), `worst close since entry: ${p.mae}`);
check(p.stopHit === "2026-09-04", `2xATR stop flagged on the session that traded through it: ${p.stopHit}`);
check(p.sessions === 4, `sessions after entry: ${p.sessions}`);

// Added mid-session at 102 while the day later closed at 100: the entry day counts from the click.
const intraday = positionPerf({ ...pos, entryPrice: 102, stop: null }, stock.slice(0, 1), spy);
check(near(intraday.ret, 100 / 102 - 1), `entry-day move is measured from the click price: ${intraday.ret}`);

// A later dividend rescales history (adj < close). The return must not change.
const divStock = stock.map(r => ({ ...r, adj: r.close * (r.ts < ts("2026-09-04") ? 0.98 : 1) }));
const pd = positionPerf({ ...pos, stop: null }, divStock, spy);
check(near(pd.ret, 105 / (100 * 0.98) - 1), `dividend-adjusted return uses the entry bar's adj factor: ${pd.ret}`);
check(near(adjFactor(divStock, "2026-09-01"), 0.98), "adjFactor reads adj/close on the entry date");

// Closed: frozen at the exit price, curve stops at the exit date.
const closed = positionPerf({ ...pos, status: "closed", exitDate: "2026-09-03", exitPrice: 109, benchExit: 510 }, stock, spy);
check(near(closed.ret, 0.09), `closed return uses the recorded exit price: ${closed.ret}`);
check(near(closed.bench, 0.02), `closed SPY uses the recorded SPY exit: ${closed.bench}`);
check(closed.curve[closed.curve.length - 1].date === "2026-09-03", "closed curve ends on the exit date");
check(closed.stopHit === null, "a stop after the exit is not counted");

// Portfolio: two positions, one added a day later; equal weight while held.
const late = positionPerf({ t: "Y", entryDate: "2026-09-02", entryPrice: 104, benchEntry: 505, status: "open" }, stock, spy);
const curve = portfolioCurve([{ perf: p }, { perf: late }]);
check(curve[0].date === "2026-09-01" && curve[0].held === 1, "portfolio starts with the first position alone");
const day2 = curve.find(c => c.date === "2026-09-02");
check(day2.held === 2, "second position joins on its entry day");
// On 09-02: X moved 100->104 (+4%), Y entered at 104 and closed 104 (0%) -> average +2%
check(near(day2.port, 1.0 * 1.02 - 1), `equal-weight day return on the join day: ${day2.port}`);
const last = curve[curve.length - 1];
check(last.port > 0 && last.bench > 0, `portfolio and SPY compounded to the end: ${last.port.toFixed(4)} vs ${last.bench.toFixed(4)}`);

const s = summarize([p, closed, late]);
check(s.n === 3 && near(s.winRate, 1) && s.best === Math.max(p.ret, closed.ret, late.ret), "summary counts, win rate and best");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
