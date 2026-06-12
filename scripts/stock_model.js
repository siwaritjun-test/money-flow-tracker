/* Pure indicator & scoring math for the Stock Picker (stocks.html).
   No DOM, no fetch — also runs in Node for scripts/test_model.js.
   Row shape: { ts, close, vol, adj, high, low } — daily bars, ascending.
   ETF rows (from data.json) have no high/low; only stock metrics need them. */

/* ---------- indicators ---------- */
function smaLast(vals, n) {
  if (vals.length < n) return null;
  let s = 0;
  for (let i = vals.length - n; i < vals.length; i++) s += vals[i];
  return s / n;
}

function nRet(rows, n) { // n-trading-day adjusted return; US equities share a calendar so bar counts align
  if (rows.length < n + 1) return null;
  const a = rows[rows.length - 1], b = rows[rows.length - 1 - n];
  return (a.adj ?? a.close) / (b.adj ?? b.close) - 1;
}

function mfi(rows, n = 14) { // Money Flow Index: volume-weighted RSI on typical price, 0–100
  if (rows.length < n + 1) return null;
  let pos = 0, neg = 0;
  for (let i = rows.length - n; i < rows.length; i++) {
    const tp = (rows[i].high + rows[i].low + rows[i].close) / 3;
    const tpPrev = (rows[i - 1].high + rows[i - 1].low + rows[i - 1].close) / 3;
    const f = tp * rows[i].vol;
    if (tp > tpPrev) pos += f; else if (tp < tpPrev) neg += f;
  }
  return (pos + neg) ? 100 * pos / (pos + neg) : 50;
}

/* OBV change over n days, expressed in days-of-average-volume (scale-free, so a
   $3T mega-cap and a $30B stock are comparable). +21 = every one of the last 21
   sessions was net buying; around 0 = churn. */
function obvTrend(rows, n = 21) {
  if (rows.length < n + 1) return null;
  let obvNow = 0, obvThen = 0, avg = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].close > rows[i - 1].close ? rows[i].vol : rows[i].close < rows[i - 1].close ? -rows[i].vol : 0;
    obvNow += d;
    if (i < rows.length - n) obvThen = obvNow;
  }
  for (let i = rows.length - n; i < rows.length; i++) avg += rows[i].vol;
  avg /= n;
  return avg ? (obvNow - obvThen) / avg : 0;
}

function dollarFlow(rows, n = 21) { // signed $ volume over n days: estimated net buying, $M
  if (rows.length < n + 1) return null;
  let s = 0;
  for (let i = rows.length - n; i < rows.length; i++) {
    if (rows[i].close > rows[i - 1].close) s += rows[i].close * rows[i].vol;
    else if (rows[i].close < rows[i - 1].close) s -= rows[i].close * rows[i].vol;
  }
  return s / 1e6;
}

function atr(rows, n = 14) {
  if (rows.length < n + 1) return null;
  let s = 0;
  for (let i = rows.length - n; i < rows.length; i++) {
    s += Math.max(rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close));
  }
  return s / n;
}

function volSurge(rows, short = 5, long = 63) { // recent volume vs its norm; >1 = waking up
  if (rows.length < long) return null;
  const vols = rows.map(r => r.vol);
  const a = smaLast(vols, short), b = smaLast(vols.slice(0, vols.length), long);
  return b ? a / b : null;
}

/* ---------- per-stock metrics ---------- */
function stockMetrics(rows) {
  if (!rows || rows.length < 70) return null;
  const adjs = rows.map(r => r.adj ?? r.close);
  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  const sma20 = smaLast(adjs, 20), sma50 = smaLast(adjs, 50);
  const lastAdj = adjs[adjs.length - 1];
  const hi52 = Math.max(...adjs.slice(-252));
  return {
    price: last.close,
    lastTs: last.ts,
    chg1d: lastAdj / adjs[adjs.length - 2] - 1,
    ret5: nRet(rows, 5),
    ret21: nRet(rows, 21),
    ret63: nRet(rows, 63),
    mfi: mfi(rows),
    obvT: obvTrend(rows),
    flow21: dollarFlow(rows),
    atr: atr(rows),
    volX: volSurge(rows),
    prox52: lastAdj / hi52,
    aboveS20: sma20 != null && lastAdj > sma20,
    aboveS50: sma50 != null && lastAdj > sma50,
    avgDollarVol: smaLast(rows.map(r => r.close * r.vol), Math.min(21, rows.length)),
    lastVol: last.vol,
    unusualVol: (() => { const a = smaLast(rows.map(r => r.vol), Math.min(63, rows.length)); return a ? last.vol / a : null; })(),
    spark: adjs.slice(-90),
  };
}

/* ---------- sector model ---------- */
/* JdK-style RRG point for one series vs benchmark (same math as index.html). */
function rrgPoint(rows, benchRows, step = 5, smaN = 21) {
  if (!rows || !benchRows) return null;
  const key = ts => new Date(ts).toISOString().slice(0, 10);
  const mB = new Map(benchRows.map(r => [key(r.ts), r.adj ?? r.close]));
  const rs = [];
  for (const r of rows) {
    const b = mB.get(key(r.ts));
    if (b) rs.push((r.adj ?? r.close) / b);
  }
  if (rs.length < smaN + step + 1) return null;
  const ratioAt = i => {
    let s = 0;
    for (let j = i - smaN + 1; j <= i; j++) s += rs[j];
    return 100 * rs[i] / (s / smaN);
  };
  const i = rs.length - 1;
  const ratio = ratioAt(i), mom = 100 + (ratio - ratioAt(i - step));
  const quad = ratio >= 100 ? (mom >= 100 ? "Leading" : "Weakening") : (mom >= 100 ? "Improving" : "Lagging");
  return { ratio, mom, quad };
}

/* Flow per sector ETF, same methodology as the main tracker:
   (return − group mean) × avg daily $ volume, capped at 2.5× median. $M/day. */
function sectorFlows(sectorRowsByT, period = 21) {
  const stats = [];
  for (const [t, rows] of Object.entries(sectorRowsByT)) {
    if (!rows || rows.length < period + 1) continue;
    const ret = nRet(rows, period);
    let dv = 0;
    for (let i = rows.length - period; i < rows.length; i++) dv += rows[i].close * rows[i].vol;
    dv /= period;
    stats.push({ t, ret, dv });
  }
  if (stats.length < 2) return {};
  const mean = stats.reduce((s, x) => s + x.ret, 0) / stats.length;
  const dvs = stats.map(s => s.dv).sort((a, b) => a - b);
  const cap = dvs[Math.floor(dvs.length / 2)] * 2.5;
  const out = {};
  for (const s of stats) out[s.t] = (s.ret - mean) * Math.min(s.dv, cap) / 1e6;
  return out;
}

/* ---------- US trading session (handles DST via the IANA timezone) ---------- */
function marketSession(now = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(now));
  const get = t => parts.find(p => p.type === t).value;
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return "closed";
  const mins = (+get("hour") % 24) * 60 + +get("minute");
  if (mins >= 240 && mins < 570) return "pre";      // 04:00–09:30 ET
  if (mins >= 570 && mins < 960) return "regular";  // 09:30–16:00 ET
  if (mins >= 960 && mins < 1200) return "post";    // 16:00–20:00 ET
  return "closed";
}

/* Extract the latest pre-market trade from a Yahoo chart response fetched with
   includePrePost=true. Returns null unless the last trade is from TODAY's (ET)
   pre-market session — yesterday's bars and market holidays never qualify. */
function parsePreFromChart(j, now = Date.now()) {
  const res = j?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0];
  if (!res?.timestamp || !q || !Array.isArray(q.close)) return null;
  let i = res.timestamp.length - 1;
  while (i >= 0 && q.close[i] == null) i--;
  if (i < 0) return null;
  const ts = res.timestamp[i] * 1000;
  const regStart = (res.meta?.currentTradingPeriod?.regular?.start || 0) * 1000;
  if (!regStart || ts >= regStart) return null; // not a pre-market trade
  const etDay = d => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (etDay(ts) !== etDay(now)) return null;    // stale session
  return { price: q.close[i], ts };
}

/* ---------- composite scoring ---------- */
function pctRank(sortedVals, v) { // fraction of universe at or below v
  if (v == null || !sortedVals.length) return 0.5;
  let lo = 0, hi = sortedVals.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedVals[m] <= v) lo = m + 1; else hi = m; }
  return lo / sortedVals.length;
}

const SCORE_WEIGHTS = { rs63: 0.20, rs21: 0.15, mfi: 0.125, obvT: 0.125, prox52: 0.15, volX: 0.10, trend: 0.15 };

/* Build the full model: per-stock metrics + relative strength vs own sector,
   percentile-ranked composite score 0–100, sector status, breadth stats. */
function buildModel(stockSeries, universe, etfSeries, opts = {}) {
  const spy = etfSeries.SPY;
  const sectors = {};
  const sectorRowsByT = {};
  for (const sec of Object.keys(universe)) {
    const rows = etfSeries[sec];
    if (!rows) continue;
    sectorRowsByT[sec] = rows;
    sectors[sec] = {
      t: sec,
      ret21: nRet(rows, 21), ret63: nRet(rows, 63),
      ex21: spy ? nRet(rows, 21) - nRet(spy, 21) : null,
      ex63: spy ? nRet(rows, 63) - nRet(spy, 63) : null,
      rrg: spy ? rrgPoint(rows, spy) : null,
    };
  }
  const flows = sectorFlows(sectorRowsByT);
  for (const sec of Object.keys(sectors)) sectors[sec].flow = flows[sec] ?? null;

  // sector momentum rank: blend of 1m + 3m excess return vs SPY
  const secList = Object.values(sectors).filter(s => s.ex21 != null && s.ex63 != null);
  const e21 = secList.map(s => s.ex21).sort((a, b) => a - b);
  const e63 = secList.map(s => s.ex63).sort((a, b) => a - b);
  for (const s of secList) s.score = 100 * (0.5 * pctRank(e21, s.ex21) + 0.5 * pctRank(e63, s.ex63));
  secList.sort((a, b) => b.score - a.score).forEach((s, i) => s.rank = i + 1);

  // per-stock metrics
  const stocks = [];
  for (const [sec, list] of Object.entries(universe)) {
    const secM = sectors[sec];
    for (const { t, n } of list) {
      const m = stockMetrics(stockSeries[t]);
      if (!m) continue;
      m.t = t; m.n = n; m.sector = sec;
      m.rs21 = (secM && secM.ret21 != null && m.ret21 != null) ? m.ret21 - secM.ret21 : null;
      m.rs63 = (secM && secM.ret63 != null && m.ret63 != null) ? m.ret63 - secM.ret63 : null;
      m.rsSpy21 = (spy && m.ret21 != null) ? m.ret21 - nRet(spy, 21) : null;
      stocks.push(m);
    }
  }

  // percentile-rank cross-sectional metrics, then weighted composite
  const dims = ["rs63", "rs21", "obvT", "prox52", "volX"];
  const sorted = {};
  for (const d of dims) sorted[d] = stocks.map(s => s[d]).filter(v => v != null).sort((a, b) => a - b);
  for (const s of stocks) {
    const w = SCORE_WEIGHTS;
    s.score = 100 * (
      w.rs63 * pctRank(sorted.rs63, s.rs63) +
      w.rs21 * pctRank(sorted.rs21, s.rs21) +
      w.mfi * ((s.mfi ?? 50) / 100) +
      w.obvT * pctRank(sorted.obvT, s.obvT) +
      w.prox52 * pctRank(sorted.prox52, s.prox52) +
      w.volX * pctRank(sorted.volX, s.volX) +
      w.trend * ((s.aboveS20 ? 0.5 : 0) + (s.aboveS50 ? 0.5 : 0))
    );
    // divergence flags: price and on-balance volume disagreeing
    s.flagAcc = s.ret21 != null && s.obvT != null && s.ret21 < 0 && s.obvT > 2;       // quiet accumulation
    s.flagDist = s.ret21 != null && s.obvT != null && s.ret21 > 0.02 && s.obvT < -2;  // rally being sold into
    s.flagVol = s.unusualVol != null && s.unusualVol >= 2;                            // unusual volume today
    s.flagHi = s.prox52 != null && s.prox52 >= 0.98;                                  // at/near 52w high
  }
  stocks.sort((a, b) => b.score - a.score);

  // breadth across the universe
  const n = stocks.length || 1;
  const breadth = {
    n: stocks.length,
    pctAbove20: stocks.filter(s => s.aboveS20).length / n,
    pctAbove50: stocks.filter(s => s.aboveS50).length / n,
    advancers: stocks.filter(s => s.chg1d > 0).length / n,
    near52: stocks.filter(s => s.prox52 >= 0.95).length / n,
    medRet21: (() => { const r = stocks.map(s => s.ret21).filter(v => v != null).sort((a, b) => a - b); return r.length ? r[Math.floor(r.length / 2)] : null; })(),
  };

  return { stocks, sectors, secList, breadth };
}

if (typeof module !== "undefined") {
  module.exports = { smaLast, nRet, mfi, obvTrend, dollarFlow, atr, volSurge, stockMetrics, rrgPoint, sectorFlows, pctRank, buildModel, SCORE_WEIGHTS, marketSession, parsePreFromChart };
}
