#!/usr/bin/env node
/* Checks the forward-test math on synthetic bars with known answers.
   Run: node scripts/test_forward.js — exits non-zero on any failed assertion. */
const { positionPerf, portfolioCurve, rulePerf, summarize, adjFactor } = require("./forward_model");

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

// Rule test: X (100 -> 105) and Y (50 -> 45, no bar on 09-03) bought equally on 09-01.
const yRows = [bar("2026-09-01", 50), bar("2026-09-02", 52), bar("2026-09-04", 48), bar("2026-09-08", 45)];
const rule = { entryDate: "2026-09-01", benchEntry: 500, status: "open",
  members: [{ t: "X", entryPrice: 100 }, { t: "Y", entryPrice: 50 }, { t: "GONE", entryPrice: 10 }] };
const rp = rulePerf(rule, { X: stock, Y: yRows }, spy);
check(near(rp.ret, (0.05 - 0.10) / 2), `basket return is the mean of member returns: ${rp.ret}`);
check(near(rp.excess, rp.ret - 0.02), "basket vs SPY over the same days");
check(rp.n === 2 && rp.missing === 1, "members without prices are counted as missing, not as zero");
check(rp.winners === 1 && rp.beatSpy === 1 && rp.best.m.t === "X" && rp.worst.m.t === "Y", "winners, beat-SPY count, best and worst member");
const d3 = rp.curve.find(q => q.date === "2026-09-03");
check(near(d3.ret, (0.10 + 0.04) / 2), `a member with no bar that day keeps its last return: ${d3.ret}`);
const rc = rulePerf({ ...rule, status: "closed", exitDate: "2026-09-02", exitPrices: { X: 104, Y: 52 }, benchExit: 505 }, { X: stock, Y: yRows }, spy);
check(near(rc.ret, (0.04 + 0.04) / 2) && near(rc.bench, 0.01), `a stopped rule test is frozen at its exit prices: ${rc.ret}`);
check(rulePerf({ ...rule, members: [{ t: "GONE", entryPrice: 1 }] }, {}, spy) === null, "no priced members -> null");

// Syncing picks between browsers and the repo copy.
const { mergePositions } = require("./forward_store");
const pick = (id, extra) => Object.assign({ id, t: id.split("-")[0], status: "open", addedAt: "2026-09-24T10:00:00Z" }, extra);
const repo = [pick("META-a"), pick("CRWD-b", { addedAt: "2026-09-24T11:00:00Z" })];
const phone = [pick("META-a"), pick("NVDA-c", { addedAt: "2026-09-25T01:00:00Z", updatedAt: "2026-09-25T01:00:00Z" })];
let m = mergePositions(repo, phone);
check(m.map(x => x.id).join() === "META-a,CRWD-b,NVDA-c", "merge keeps picks from both sides, oldest first, no duplicates");
m = mergePositions(repo, [pick("META-a", { status: "closed", closedAt: "2026-09-26T00:00:00Z", exitPrice: 800 })]);
check(m.find(x => x.id === "META-a").status === "closed", "a later close beats the open copy");
m = mergePositions([pick("META-a", { status: "closed", closedAt: "2026-09-26T00:00:00Z" })], [pick("META-a")]);
check(m.find(x => x.id === "META-a").status === "closed", "an older open copy cannot reopen a closed pick");
m = mergePositions(repo, [{ id: "CRWD-b", t: "CRWD", status: "deleted", updatedAt: "2026-09-25T00:00:00Z" }]);
check(m.find(x => x.id === "CRWD-b").status === "deleted", "a delete survives a merge with the old copy");
check(mergePositions([null, { t: "X" }], repo).length === 2, "rows without an id are dropped");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
