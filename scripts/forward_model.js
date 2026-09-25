/* Forward-test math: how picks made on the Stock Picker have done since.
   No DOM, no fetch — also runs in Node for scripts/test_forward.js.
   Row shape: { ts, close, vol, adj, high, low } — daily bars, ascending.

   A position records the price shown when it was added (entryPrice), not a
   later close: the forward test measures the decision as it was made. Returns
   are dividend-adjusted by scaling that price with the adj/close ratio of the
   entry bar in *current* data, so a later dividend adjustment of the history
   does not look like a loss. */

const dayOf = ts => new Date(ts).toISOString().slice(0, 10);
const adjOf = r => (r.adj > 0 ? r.adj : r.close);

/** adj/close on `date` (or the first bar after it); 1 when the date is not covered. */
function adjFactor(rows, date) {
  const r = rows && rows.find(x => dayOf(x.ts) >= date);
  return r && r.close > 0 ? adjOf(r) / r.close : 1;
}

/** Performance of one position against a benchmark (SPY) over the same days. */
function positionPerf(pos, rows, benchRows) {
  const entryDate = pos.entryDate;
  const endDate = pos.status === "closed" ? pos.exitDate : null;
  const inWindow = r => dayOf(r.ts) >= entryDate && (!endDate || dayOf(r.ts) <= endDate);

  const base = pos.entryPrice * adjFactor(rows, entryDate);
  const benchBase = pos.benchEntry ? pos.benchEntry * adjFactor(benchRows, entryDate) : null;
  const benchByDay = new Map((benchRows || []).map(r => [dayOf(r.ts), adjOf(r)]));

  // One point per session from the entry day on, each measured from the price
  // at the moment of adding -- so a pick added mid-session moves the same day.
  const curve = [];
  let mfe = 0, mae = 0, stopHit = null;
  for (const r of (rows || []).filter(inWindow)) {
    const d = dayOf(r.ts);
    const ret = adjOf(r) / base - 1;
    const b = benchByDay.get(d);
    curve.push({ date: d, ret, bench: benchBase && b ? b / benchBase - 1 : null });
    mfe = Math.max(mfe, ret);
    mae = Math.min(mae, ret);
    // The system's own exit rule: did a later session trade through the 2×ATR
    // stop? (The entry day's low may predate the click, so it does not count.)
    if (!stopHit && pos.stop && d > entryDate && r.low > 0 && r.low <= pos.stop) stopHit = d;
  }
  if (!curve.length) curve.push({ date: entryDate, ret: 0, bench: 0 });

  const last = curve[curve.length - 1];
  let ret = last.ret;
  let lastDate = last.date;
  let lastPrice = rows && rows.length ? rows.filter(inWindow).slice(-1)[0]?.close : null;
  // A closed position ends at the price recorded when it was closed.
  if (endDate && pos.exitPrice) {
    ret = (pos.exitPrice * adjFactor(rows, endDate)) / base - 1;
    lastPrice = pos.exitPrice;
    lastDate = endDate;
  }
  const bench = endDate && pos.benchExit && benchBase
    ? (pos.benchExit * adjFactor(benchRows, endDate)) / benchBase - 1
    : last.bench;

  return {
    ret,
    bench,
    excess: bench == null ? null : ret - bench,
    mfe: Math.max(mfe, ret),
    mae: Math.min(mae, ret),
    stopHit,
    sessions: curve.filter(p => p.date > entryDate).length,
    lastDate,
    lastPrice,
    curve,
  };
}

/** Equal-weight, daily-rebalanced curve of every position while it was held,
    against the benchmark over exactly the days something was held. */
function portfolioCurve(items) {
  const days = new Set();
  for (const { perf } of items) perf.curve.forEach(p => days.add(p.date));
  const sorted = [...days].sort();
  let port = 1, bench = 1;
  const out = [];
  for (const d of sorted) {
    const rets = [], benchRets = [];
    for (const { perf } of items) {
      const i = perf.curve.findIndex(p => p.date === d);
      if (i < 0) continue; // not held on d
      // The first point is measured from the entry price, i.e. from 0.
      const prev = i ? perf.curve[i - 1] : { ret: 0, bench: 0 };
      const cur = perf.curve[i];
      rets.push((1 + cur.ret) / (1 + prev.ret) - 1);
      if (cur.bench != null && prev.bench != null) benchRets.push((1 + cur.bench) / (1 + prev.bench) - 1);
    }
    if (!rets.length) continue;
    port *= 1 + rets.reduce((a, b) => a + b, 0) / rets.length;
    if (benchRets.length) bench *= 1 + benchRets.reduce((a, b) => a + b, 0) / benchRets.length;
    out.push({ date: d, port: port - 1, bench: bench - 1, held: rets.length });
  }
  return out;
}

/** A rule test: the stocks that matched a Stock Picker rule on one day, bought in
    equal amounts at that day's prices and held unchanged (no rebalancing, no new
    entrants) until the test is stopped. rule.members: [{ t, entryPrice, ... }]. */
function rulePerf(rule, stockRows, benchRows) {
  const members = [];
  for (const m of rule.members || []) {
    const rows = stockRows[m.t];
    if (!rows || !(m.entryPrice > 0)) continue;
    const pos = {
      entryDate: rule.entryDate, entryPrice: m.entryPrice, benchEntry: rule.benchEntry, status: rule.status,
      exitDate: rule.exitDate, exitPrice: rule.exitPrices && rule.exitPrices[m.t], benchExit: rule.benchExit,
    };
    members.push({ m, perf: positionPerf(pos, rows, benchRows) });
  }
  if (!members.length) return null;

  // Buy-and-hold equal weight = the plain mean of member returns; a member with
  // no bar on some day (halt) keeps its last return rather than dropping out.
  const dates = [...new Set(members.flatMap(x => x.perf.curve.map(p => p.date)))].sort();
  const maps = members.map(x => new Map(x.perf.curve.map(p => [p.date, p])));
  const lastRet = members.map(() => 0);
  let bench = null;
  const curve = dates.map(d => {
    maps.forEach((mp, i) => { const p = mp.get(d); if (p) { lastRet[i] = p.ret; if (p.bench != null) bench = p.bench; } });
    return { date: d, ret: lastRet.reduce((a, b) => a + b, 0) / lastRet.length, bench };
  });

  const ret = members.reduce((a, x) => a + x.perf.ret, 0) / members.length;
  const benchRet = members.find(x => x.perf.bench != null)?.perf.bench ?? null;
  const byRet = members.slice().sort((a, b) => b.perf.ret - a.perf.ret);
  return {
    ret,
    bench: benchRet,
    excess: benchRet == null ? null : ret - benchRet,
    mfe: Math.max(0, ret, ...curve.map(p => p.ret)),
    mae: Math.min(0, ret, ...curve.map(p => p.ret)),
    n: members.length,
    missing: (rule.members || []).length - members.length,
    winners: members.filter(x => x.perf.ret > 0).length,
    beatSpy: members.filter(x => x.perf.excess != null && x.perf.excess > 0).length,
    best: byRet[0],
    worst: byRet[byRet.length - 1],
    members: byRet,
    sessions: curve.filter(p => p.date > rule.entryDate).length,
    curve,
  };
}

function summarize(perfs) {
  const n = perfs.length;
  if (!n) return { n: 0 };
  const rets = perfs.map(p => p.ret);
  const ex = perfs.map(p => p.excess).filter(v => v != null);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    n,
    avgRet: mean(rets),
    avgExcess: mean(ex),
    winRate: rets.filter(r => r > 0).length / n,
    beatRate: ex.length ? ex.filter(r => r > 0).length / ex.length : null,
    best: Math.max(...rets),
    worst: Math.min(...rets),
  };
}

if (typeof module !== "undefined") {
  module.exports = { dayOf, adjFactor, positionPerf, portfolioCurve, rulePerf, summarize };
}
