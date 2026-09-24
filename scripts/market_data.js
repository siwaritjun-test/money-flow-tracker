/* Shared data layer: the Action's committed JSON files, plus live Yahoo daily
   bars through public CORS proxies for tickers the files don't carry. */
const PROXIES = [
  u => u,
  u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  u => "https://corsproxy.io/?url=" + encodeURIComponent(u),
  u => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u),
];
const rowsFromArr = rows => rows.map(([ts, close, vol, adj, high, low]) => ({
  ts, close, vol, adj: adj > 0 ? adj : close,
  high: high > 0 ? high : close, low: low > 0 ? low : close,
}));

async function loadJson(file) {
  const r = await fetch(file + "?t=" + Date.now(), { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  if (!j?.series) throw new Error("bad payload");
  return j;
}

async function fetchTickerLive(t, withHL) {
  const base = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1y&interval=1d`;
  for (const wrap of PROXIES) {
    try {
      const r = await fetch(wrap(base), { signal: AbortSignal.timeout(12000) });
      if (!r.ok) continue;
      const res = (await r.json())?.chart?.result?.[0];
      if (!res?.timestamp) continue;
      const q = res.indicators.quote[0];
      const adj = res.indicators.adjclose?.[0]?.adjclose;
      const byDay = new Map();
      for (let i = 0; i < res.timestamp.length; i++) {
        const c = q.close[i], v = q.volume[i];
        if (c == null || v == null || !(c > 0) || v < 0) continue;
        const ts = res.timestamp[i] * 1000;
        byDay.set(new Date(ts).toISOString().slice(0, 10), {
          ts, close: c, vol: v, adj: (adj && adj[i] > 0) ? adj[i] : c,
          high: (withHL && q.high[i] > 0) ? q.high[i] : c, low: (withHL && q.low[i] > 0) ? q.low[i] : c,
        });
      }
      const rows = [...byDay.values()].sort((a, b) => a.ts - b.ts);
      if (rows.length > 25) return rows;
    } catch (e) { /* next proxy */ }
  }
  return null;
}
