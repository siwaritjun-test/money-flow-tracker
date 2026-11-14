/* Bear-market resilience math for resilience.html: which stocks hold up better
   than their OWN sector ETF while that sector is under stress.
   No DOM, no fetch — also runs in Node for scripts/test_resilience.js.
   Row shape: { ts, close, vol, adj, high, low } — daily bars, ascending.

   Stress window per sector: if the sector ETF is now >= BEAR_DD below its
   1-year high, the window runs from that high to today ("active"); otherwise it
   is the sector's deepest peak-to-trough decline of the last year ("past").
   Every stock is then measured against its sector on the same dates. */

const BEAR_DD = 0.10;     // sector >= 10% below its high = bear / correction
const MILD_DD = 0.05;     // shallower episodes are too small to say much
const RES_WEIGHTS = { downCap: 0.25, relDD: 0.20, alpha: 0.20, rsHigh: 0.15, udVol: 0.10, bounce: 0.10 };

const resDay = ts => new Date(ts).toISOString().slice(0, 10);
const px = r => r.adj ?? r.close;

/* Rows of `rows` on the dates `bench` also has, paired up: [{ s, b }]. */
function alignPair(rows, bench) {
  const mB = new Map(bench.map(r => [resDay(r.ts), r]));
  const out = [];
  for (const r of rows) {
    const b = mB.get(resDay(r.ts));
    if (b) out.push({ s: r, b });
  }
  return out;
}

/* Deepest drawdown of a price list: { dd (negative), peak, trough } as indexes. */
function maxDrawdown(vals, from = 0, to = vals.length - 1) {
  let pk = from, best = { dd: 0, peak: from, trough: from };
  for (let i = from; i <= to; i++) {
    if (vals[i] > vals[pk]) pk = i;
    const dd = vals[i] / vals[pk] - 1;
    if (dd < best.dd) best = { dd, peak: pk, trough: i };
  }
  return best;
}

/* The sector's stress episode (see header). Indexes refer to `rows`. */
function stressWindow(rows) {
  if (!rows || rows.length < 30) return null;
  const vals = rows.map(px);
  const last = vals.length - 1;
  let pk = 0;
  for (let i = 0; i <= last; i++) if (vals[i] >= vals[pk]) pk = i;
  const curDD = vals[last] / vals[pk] - 1;
  let w;
  if (curDD <= -BEAR_DD) {
    const tr = maxDrawdown(vals, pk, last);
    w = { active: true, peak: pk, trough: tr.trough, end: last, depth: tr.dd };
  } else {
    const tr = maxDrawdown(vals);
    w = { active: false, peak: tr.peak, trough: tr.trough, end: tr.trough, depth: tr.dd };
  }
  w.curDD = curDD;
  w.peakDate = resDay(rows[w.peak].ts);
  w.troughDate = resDay(rows[w.trough].ts);
  w.endDate = resDay(rows[w.end].ts);
  w.days = w.end - w.peak;
  w.status = w.active ? "bear" : curDD <= -MILD_DD ? "pullback" : w.depth <= -BEAR_DD ? "recovered" : "calm";
  w.mild = w.depth > -MILD_DD;
  return w;
}

/* Least-squares fit of y on x: { alpha, beta } (alpha per day). */
function ols(xs, ys) {
  const n = xs.length;
  if (n < 5) return null;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
  mx /= n; my /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  if (!sxx) return null;
  const beta = sxy / sxx;
  return { alpha: my - beta * mx, beta };
}

/* One stock vs its sector over the sector's stress window. `win` comes from
   stressWindow(sectorRows); dates are matched, so a stock that listed late
   simply has fewer days (and is skipped if it misses most of the window). */
function resilienceMetrics(rows, sectorRows, win) {
  if (!rows || !sectorRows || !win) return null;
  const pairs = alignPair(rows, sectorRows);
  const startDay = win.peakDate, endDay = win.endDate, troughDay = win.troughDate;
  const iStart = pairs.findIndex(p => resDay(p.b.ts) >= startDay);
  if (iStart < 0) return null;
  let iEnd = pairs.length - 1;
  while (iEnd > iStart && resDay(pairs[iEnd].b.ts) > endDay) iEnd--;
  if (iEnd - iStart < Math.max(5, win.days * 0.7)) return null;
  const S = pairs.map(p => px(p.s)), B = pairs.map(p => px(p.b));

  // daily returns inside the window
  const rs = [], rb = [];
  let upV = 0, dnV = 0;
  for (let i = iStart + 1; i <= iEnd; i++) {
    rs.push(S[i] / S[i - 1] - 1);
    rb.push(B[i] / B[i - 1] - 1);
    const c = pairs[i].s.close, c0 = pairs[i - 1].s.close;
    if (c > c0) upV += pairs[i].s.vol; else if (c < c0) dnV += pairs[i].s.vol;
  }
  // capture ratios: mean stock return on the sector's down (up) days ÷ the sector's
  let sd = 0, bd = 0, nd = 0, su = 0, bu = 0, nu = 0;
  for (let i = 0; i < rb.length; i++) {
    if (rb[i] < 0) { sd += rs[i]; bd += rb[i]; nd++; }
    else if (rb[i] > 0) { su += rs[i]; bu += rb[i]; nu++; }
  }
  const downCap = nd >= 3 && bd ? sd / bd : null;
  const upCap = nu >= 3 && bu ? su / bu : null;

  const fit = ols(rb, rs);
  const stockDD = maxDrawdown(S, iStart, iEnd).dd;
  const secDD = maxDrawdown(B, iStart, iEnd).dd;
  const relDD = secDD < -0.005 ? stockDD / secDD : null;
  const winRet = S[iEnd] / S[iStart] - 1, secWinRet = B[iEnd] / B[iStart] - 1;

  // relative-strength line (stock ÷ sector) over the full year
  const rsLine = S.map((v, i) => v / B[i]);
  const last = rsLine.length - 1;
  const rsHigh = rsLine[last] / Math.max(...rsLine);
  // RS leading: RS line at a 1-year high while the sector itself is well off its high
  const rsLead = rsHigh >= 0.97 && win.curDD <= -MILD_DD;

  // bounce leadership: stock vs sector from the sector's trough to today
  const iTr = pairs.findIndex(p => resDay(p.b.ts) >= troughDay);
  const bounce = iTr >= 0 && last - iTr >= 3 ? (S[last] / S[iTr]) - (B[last] / B[iTr]) : null;

  // recovery: first close after the sector trough above the stock's own 50-day SMA
  let recoverDays = null;
  if (iTr >= 0) {
    for (let i = Math.max(iTr, 49); i <= last; i++) {
      let s = 0;
      for (let j = i - 49; j <= i; j++) s += S[j];
      if (S[i] > s / 50) { recoverDays = i - iTr; break; }
    }
  }

  return {
    downCap, upCap,
    alpha21: fit ? fit.alpha * 21 : null, beta: fit ? fit.beta : null,
    stockDD, secDD, relDD, winRet, secWinRet, relRet: winRet - secWinRet,
    udVol: dnV ? upV / dnV : null,
    rsHigh, rsLead, bounce, recoverDays,
    nDays: rs.length,
  };
}

/* Quadrant from capture ratios — 1.0 = moves exactly like its sector. */
function resQuadrant(m) {
  if (!m || m.downCap == null || m.upCap == null) return null;
  const lowDown = m.downCap < 1, highUp = m.upCap >= 1;
  return lowDown ? (highUp ? "Leader" : "Defensive") : (highUp ? "High beta" : "Fragile");
}

function resPctRank(sortedVals, v) { // same as stock_model.js pctRank (kept local so this file stands alone)
  if (v == null || !sortedVals.length) return 0.5;
  let lo = 0, hi = sortedVals.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedVals[m] <= v) lo = m + 1; else hi = m; }
  return lo / sortedVals.length;
}

/* Score every stock 0–100, percentile-ranked WITHIN its own sector so each
   stock is only compared with its industry peers.
   Returns { sectors: { [etf]: { t, win } }, stocks: [...] }. */
function buildResilience(stockSeries, universe, etfSeries) {
  const sectors = {}, stocks = [];
  for (const [sec, list] of Object.entries(universe)) {
    const secRows = etfSeries[sec];
    const win = stressWindow(secRows);
    if (!win) continue;
    sectors[sec] = { t: sec, win };
    const peers = [];
    for (const { t, n, ndx, sp } of list) {
      const rows = stockSeries[t];
      const m = resilienceMetrics(rows, secRows, win);
      if (!m) continue;
      Object.assign(m, { t, n, sector: sec, ndx: !!ndx, sp: sp !== false, price: rows[rows.length - 1].close, lastTs: rows[rows.length - 1].ts });
      m.quad = resQuadrant(m);
      m.spark = rows.slice(-252).map(px);
      peers.push(m);
    }
    const sorted = {};
    for (const d of ["downCap", "relDD", "alpha21", "rsHigh", "udVol", "bounce"]) sorted[d] = peers.map(s => s[d]).filter(v => v != null).sort((a, b) => a - b);
    const lowBetter = (d, v) => v == null ? 0.5 : 1 - resPctRank(sorted[d], v) + 1 / (sorted[d].length || 1);
    const w = RES_WEIGHTS;
    for (const s of peers) {
      s.score = 100 * Math.min(1, Math.max(0,
        w.downCap * lowBetter("downCap", s.downCap) +
        w.relDD * lowBetter("relDD", s.relDD) +
        w.alpha * resPctRank(sorted.alpha21, s.alpha21) +
        w.rsHigh * resPctRank(sorted.rsHigh, s.rsHigh) +
        w.udVol * resPctRank(sorted.udVol, s.udVol) +
        w.bounce * resPctRank(sorted.bounce, s.bounce)));
      s.peerN = peers.length;
      stocks.push(s);
    }
    sectors[sec].n = peers.length;
  }
  stocks.sort((a, b) => b.score - a.score);
  return { sectors, stocks };
}

/* Market backdrop: SPY's distance from its high and from its 200-day average. */
function marketBear(spyRows) {
  if (!spyRows || spyRows.length < 30) return null;
  const vals = spyRows.map(px);
  const last = vals[vals.length - 1];
  const dd = last / Math.max(...vals.slice(-252)) - 1;
  const n = Math.min(200, vals.length);
  const sma = vals.slice(-n).reduce((a, b) => a + b, 0) / n;
  const below200 = last < sma;
  return { dd, below200, vsSma: last / sma - 1, bear: dd <= -0.2, correction: dd <= -BEAR_DD || below200 };
}

if (typeof module !== "undefined") {
  module.exports = { BEAR_DD, MILD_DD, RES_WEIGHTS, alignPair, maxDrawdown, stressWindow, ols, resilienceMetrics, resQuadrant, buildResilience, marketBear };
}
