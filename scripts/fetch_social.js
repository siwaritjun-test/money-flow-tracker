#!/usr/bin/env node
/**
 * Social listening → investment themes (1–2 month horizon). No dependencies.
 * Runs in GitHub Actions every 2h but self-skips unless social.json is ≥11h
 * old, so the data effectively refreshes every ~12 hours.
 *
 * Sources (each optional — a failed source never kills the run):
 *  - Reddit hot posts: r/wallstreetbets, r/stocks, r/StockMarket, r/investing, r/options
 *  - ApeWisdom (aggregated Reddit ticker mentions)
 *  - StockTwits trending symbols
 *  - Finance-news RSS headlines: CNBC (top + markets), MarketWatch, Yahoo Finance
 *
 * Each theme is scored from keyword/ticker matches weighted by engagement,
 * then confirmed against real 1-month price action of its ticker basket
 * (Yahoo). Confidence = source diversity + dominance + price confirmation.
 * Output: social.json (current scores, daily finalized winners, history).
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MIN_AGE_H = 11; // self-skip window

/* ---------------- theme dictionary ---------------- */
const THEMES = [
  { id: "ai-semis", name: "AI & Semiconductors", kw: ["artificial intelligence", " ai ", "ai bubble", "ai capex", "ai spending", "chip", "semiconductor", "gpu", "datacenter", "data center", "nvidia", "openai", "anthropic", "llm", "blackwell", "foundry"], tickers: ["NVDA","AMD","AVGO","TSM","MU","INTC","ARM","SMCI","MRVL","ASML","AMAT","LRCX","KLAC","SNDK","WDC","MSFT","ORCL","PLTR","CRWV"] },
  { id: "datacenter-power", name: "Data-Center Power & Grid", kw: ["power demand", "electricity demand", "grid", "utility", "megawatt", "gigawatt", "power purchase", "energy for ai", "cooling"], tickers: ["VST","CEG","ETN","VRT","PWR","NEE","GEV","TLN","SO","D"] },
  { id: "nuclear", name: "Nuclear & Uranium", kw: ["nuclear", "uranium", "reactor", "smr ", "small modular", "enrichment", "fission"], tickers: ["CCJ","OKLO","SMR","LEU","CEG","UEC","NNE","BWXT"] },
  { id: "glp1", name: "GLP-1 / Obesity Drugs", kw: ["glp-1", "ozempic", "wegovy", "zepbound", "obesity drug", "weight loss drug", "weight-loss"], tickers: ["LLY","NVO","VKTX","HIMS","AMGN","PFE"] },
  { id: "defense", name: "Defense & Geopolitics", kw: ["defense", "defence", "missile", "drone", "nato", "ukraine", "israel", "iran", "taiwan", "military", "war ", "geopolit"], tickers: ["LMT","RTX","NOC","GD","LHX","AVAV","KTOS","PLTR","RHM","BA"] },
  { id: "crypto", name: "Crypto & Digital Assets", kw: ["bitcoin", "btc", "ethereum", "crypto", "stablecoin", "blockchain", "halving", "etf inflow"], tickers: ["COIN","MSTR","HOOD","MARA","RIOT","CLSK","GLXY","CRCL","BMNR"] },
  { id: "rates-fed", name: "Fed, Rates & Inflation", kw: ["fed ", "federal reserve", "rate cut", "rate hike", "fomc", "powell", "inflation", "cpi ", "pce ", "treasury yield", "bond yield", "soft landing", "recession"], tickers: ["TLT","JPM","BAC","GS","MS","SCHW","KRE"] },
  { id: "quantum", name: "Quantum Computing", kw: ["quantum"], tickers: ["IONQ","RGTI","QBTS","IBM","GOOGL"] },
  { id: "ev-autonomous", name: "EV & Autonomous Driving", kw: ["electric vehicle", " ev ", "robotaxi", "self-driving", "autonomous", "fsd", "lidar", "charging"], tickers: ["TSLA","RIVN","LCID","UBER","GM","F","XPEV","NIO","MBLY"] },
  { id: "robotics", name: "Robotics & Humanoids", kw: ["robot", "humanoid", "automation", "optimus", "figure ai"], tickers: ["TSLA","NVDA","ROK","ISRG","TER","SYM"] },
  { id: "space", name: "Space Economy", kw: ["space", "rocket", "satellite", "starlink", "spacex", "launch", "orbit"], tickers: ["RKLB","ASTS","LUNR","RDW","BA","PL"] },
  { id: "energy-oil", name: "Oil & Gas", kw: ["oil price", "crude", "opec", "natural gas", "natgas", "lng", "barrel", "drilling"], tickers: ["XOM","CVX","OXY","COP","SLB","HAL","EOG","FANG","LNG"] },
  { id: "gold-havens", name: "Gold & Safe Havens", kw: ["gold price", "gold hits", "gold rally", "silver", "safe haven", "bullion", "precious metal"], tickers: ["GLD","NEM","GOLD","AEM","WPM","SLV","FNV"] },
  { id: "housing", name: "Housing & Homebuilders", kw: ["housing", "mortgage rate", "homebuilder", "home sales", "real estate market", "rent"], tickers: ["DHI","LEN","PHM","NVR","TOL","HD","LOW"] },
  { id: "biotech", name: "Biotech & FDA Catalysts", kw: ["fda approval", "fda ", "biotech", "clinical trial", "phase 3", "drug approval", "gene therapy", "obesity pill"], tickers: ["XBI","AMGN","GILD","VRTX","REGN","MRNA","CRSP","SRPT"] },
  { id: "meme-retail", name: "Meme / Retail Squeeze", kw: ["short squeeze", "meme stock", "yolo", "diamond hands", "short interest", "gamma squeeze", "to the moon"], tickers: ["GME","AMC","BBAI","DJT","OPEN","BYND"] },
];

/* tickers that are common English words — count only with a $ prefix */
const AMBIGUOUS = new Set(["A","ALL","ANY","ARE","BE","BIG","BY","CAN","CEO","COST","DD","EAT","EDIT","EV","FOR","GO","GDP","HOLD","IT","LOVE","MOON","NEXT","NOW","ON","ONE","OPEN","OR","OUT","PLAY","PM","POST","REAL","SEE","SO","STAY","TELL","TV","US","USA","VERY","WELL","YOLO","AI","IPO","ETF","CPI","FBI","IRS","WSB","IMO","LOL","DOW","KEY","SAVE","NICE","FAST","CARE","LIFE","HAS","NEW","LOW"]);

const get = async (url, ms = 15000, accept = "") => {
  const r = await fetch(url, { headers: { "User-Agent": UA, ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r;
};

/* ---------------- sources ---------------- */
const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&");

async function fetchReddit() {
  const subs = ["wallstreetbets", "stocks", "StockMarket", "investing", "options"];
  const posts = [];
  for (const sub of subs) {
    // JSON API first (has engagement scores), RSS fallback (datacenter IPs get
    // 403 on the JSON API but the .rss feed stays open)
    try {
      const j = await (await get(`https://www.reddit.com/r/${sub}/hot.json?limit=50`, 15000, "application/json")).json();
      for (const c of j?.data?.children || []) {
        const d = c.data;
        if (!d?.title || d.stickied) continue;
        posts.push({ sub, text: (d.title + " " + (d.selftext || "").slice(0, 800)), score: d.score || 0, comments: d.num_comments || 0 });
      }
    } catch (e) {
      try {
        let xml;
        try {
          xml = await (await get(`https://www.reddit.com/r/${sub}/hot/.rss`, 15000)).text();
        } catch (e429) { // unauthenticated RSS is tightly rate-limited — wait out a 429 once
          if (!String(e429.message).includes("429")) throw e429;
          await new Promise(r => setTimeout(r, 35000));
          xml = await (await get(`https://www.reddit.com/r/${sub}/hot/.rss`, 15000)).text();
        }
        for (const en of (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).slice(0, 40)) {
          const title = en.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "";
          const body = unesc(en.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || "").replace(/<[^>]*>/g, " ");
          if (!title) continue;
          // RSS carries no vote counts → flat weight comparable to a mid-engagement post
          posts.push({ sub, text: unesc(title) + " " + body.slice(0, 800), score: 30, comments: 0 });
        }
      } catch (e2) { console.error(`reddit r/${sub}: json ${e.message}, rss ${e2.message}`); }
    }
    await new Promise(r => setTimeout(r, 6000)); // stay far under Reddit's unauthenticated rate limit
  }
  return posts;
}

async function fetchApeWisdom() {
  try {
    const j = await (await get("https://apewisdom.io/api/v1.0/filter/all-stocks/page/1")).json();
    return (j?.results || []).map(r => ({ t: (r.ticker || "").toUpperCase(), mentions: +r.mentions || 0, upvotes: +r.upvotes || 0 })).filter(r => r.t);
  } catch (e) { console.error("apewisdom: " + e.message); return []; }
}

async function fetchStockTwits() {
  try {
    const j = await (await get("https://api.stocktwits.com/api/2/trending/symbols.json", 15000, "application/json")).json();
    return (j?.symbols || []).map(s => (s.symbol || "").toUpperCase()).filter(Boolean);
  } catch (e) { console.error("stocktwits: " + e.message); return []; }
}

async function fetchHeadlines() {
  const feeds = [
    ["CNBC Top", "https://www.cnbc.com/id/100003114/device/rss/rss.html"],
    ["CNBC Markets", "https://www.cnbc.com/id/20910258/device/rss/rss.html"],
    ["MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"],
    ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
  ];
  const out = [];
  for (const [src, url] of feeds) {
    try {
      const xml = await (await get(url)).text();
      const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
      for (const it of items.slice(0, 30)) {
        const m = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        if (m && m[1].trim()) out.push({ src, title: m[1].trim().replace(/&amp;/g, "&").replace(/&#039;|&apos;/g, "'").replace(/&quot;/g, '"') });
      }
    } catch (e) { console.error(`rss ${src}: ${e.message}`); }
  }
  return out;
}

/* ---------------- analysis ---------------- */
function themeMatches(text) {
  const lc = " " + text.toLowerCase() + " ";
  return THEMES.filter(th => th.kw.some(k => lc.includes(k)));
}

function extractTickers(text, validSet) {
  const found = new Map(); // t → weight
  for (const m of text.matchAll(/\$([A-Za-z]{1,5})\b/g)) {
    const t = m[1].toUpperCase();
    if (validSet.has(t)) found.set(t, Math.max(found.get(t) || 0, 1));
  }
  for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) {
    const t = m[1];
    if (validSet.has(t) && !AMBIGUOUS.has(t)) found.set(t, Math.max(found.get(t) || 0, 0.5));
  }
  return found;
}

async function fetchRet21(t) { // 1-month adjusted return for basket confirmation
  try {
    const j = await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=3mo&interval=1d`, 12000, "application/json")).json();
    const res = j?.chart?.result?.[0];
    const adj = res?.indicators?.adjclose?.[0]?.adjclose?.filter(v => v > 0);
    if (!adj || adj.length < 25) return null;
    return adj[adj.length - 1] / adj[adj.length - 22] - 1;
  } catch (e) { return null; }
}

(async function main() {
  const outPath = path.join(ROOT, "social.json");
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(outPath, "utf8")); } catch (e) {}
  if (prev && (Date.now() - Date.parse(prev.updated)) / 36e5 < MIN_AGE_H && !process.argv.includes("--force")) {
    console.log(`social.json is ${(((Date.now() - Date.parse(prev.updated)) / 36e5)).toFixed(1)}h old — skipping (refreshes every ~12h).`);
    return;
  }

  // valid tickers = S&P universe + every theme ticker
  const validSet = new Set(THEMES.flatMap(t => t.tickers));
  try {
    const u = JSON.parse(fs.readFileSync(path.join(ROOT, "universe.json"), "utf8"));
    for (const list of Object.values(u.sectors || {})) for (const s of list) validSet.add(s.t);
  } catch (e) {}

  console.log("Fetching sources…");
  const [reddit, ape, st, headlines] = await Promise.all([fetchReddit(), fetchApeWisdom(), fetchStockTwits(), fetchHeadlines()]);
  console.log(`reddit posts: ${reddit.length}, apewisdom: ${ape.length}, stocktwits: ${st.length}, headlines: ${headlines.length}`);
  const sourcesUp = (reddit.length ? 1 : 0) + (ape.length || st.length ? 1 : 0) + (headlines.length ? 1 : 0);
  if (sourcesUp < 2) { console.error("Fewer than 2 source families reachable — keeping previous social.json."); process.exit(prev ? 0 : 1); }

  // score themes + collect ticker buzz
  const S = {}; // id → {reddit, news, buzz, examples, tickerHits}
  for (const th of THEMES) S[th.id] = { reddit: 0, news: 0, buzz: 0, examples: [], tickerHits: new Map() };
  const buzz = new Map(); // ticker → {mentions, sources:Set}
  const addBuzz = (t, w, src) => { const b = buzz.get(t) || { w: 0, sources: new Set() }; b.w += w; b.sources.add(src); buzz.set(t, b); };
  const tickerThemes = new Map(); // ticker → themes containing it
  for (const th of THEMES) for (const t of th.tickers) (tickerThemes.get(t) || tickerThemes.set(t, []).get(t)).push(th.id);

  for (const p of reddit) {
    const w = 1 + Math.log10(1 + p.score + p.comments);
    const tk = extractTickers(p.text, validSet);
    for (const [t, tw] of tk) addBuzz(t, w * tw, "reddit");
    for (const th of themeMatches(p.text)) {
      S[th.id].reddit += w;
      if (S[th.id].examples.length < 6) S[th.id].examples.push({ src: "r/" + p.sub, title: p.text.slice(0, 140) });
      for (const [t, tw] of tk) if (th.tickers.includes(t)) S[th.id].tickerHits.set(t, (S[th.id].tickerHits.get(t) || 0) + w * tw);
    }
    // posts that only name a theme ticker still count (half weight)
    for (const [t, tw] of tk) for (const id of tickerThemes.get(t) || []) S[id].reddit += 0.5 * w * tw;
  }
  for (const h of headlines) {
    const w = 2.5;
    const tk = extractTickers(h.title, validSet);
    for (const [t, tw] of tk) addBuzz(t, w * tw, "news");
    for (const th of themeMatches(h.title)) {
      S[th.id].news += w;
      if (S[th.id].examples.length < 6) S[th.id].examples.push({ src: h.src, title: h.title.slice(0, 140) });
    }
  }
  for (const r of ape) {
    const w = 2 * Math.log10(1 + r.mentions);
    addBuzz(r.t, w, "mentions");
    for (const id of tickerThemes.get(r.t) || []) S[id].buzz += w;
  }
  for (const t of st) {
    addBuzz(t, 3, "trending");
    for (const id of tickerThemes.get(t) || []) S[id].buzz += 3;
  }

  // price confirmation: basket 1m return (up to 6 most-liquid tickers per theme) vs SPY
  console.log("Confirming with 1-month price action…");
  const retCache = new Map();
  const ret = async t => { if (!retCache.has(t)) retCache.set(t, await fetchRet21(t)); return retCache.get(t); };
  const spyRet = await ret("SPY");
  const themesOut = [];
  const totalRaw = Object.values(S).reduce((s, x) => s + x.reddit + x.news + x.buzz, 0) || 1;
  for (const th of THEMES) {
    const s = S[th.id];
    const raw = s.reddit + s.news + s.buzz;
    const rets = [];
    for (const t of th.tickers.slice(0, 6)) { const r = await ret(t); if (r != null) rets.push(r); }
    const basketRet = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
    const excess = (basketRet != null && spyRet != null) ? basketRet - spyRet : null;
    // confidence: source diversity (40) + dominance (30) + price confirmation (30)
    const diversity = ((s.reddit > 0) + (s.news > 0) + (s.buzz > 0)) / 3 * 40;
    const dominance = Math.min(raw / totalRaw / 0.30, 1) * 30;
    const priceConf = excess == null ? 10 : Math.max(0, Math.min(1, (excess + 0.02) / 0.07)) * 30;
    const confidence = Math.round(diversity + dominance + priceConf);
    const prevRaw = prev?.rawScores?.[th.id] ?? null;
    themesOut.push({
      id: th.id, name: th.name, raw: +raw.toFixed(1),
      score: Math.round(100 * raw / totalRaw),
      momentum: prevRaw == null ? null : +(raw - prevRaw).toFixed(1),
      confidence, confLabel: confidence >= 70 ? "HIGH" : confidence >= 45 ? "MEDIUM" : "LOW",
      sources: { reddit: +s.reddit.toFixed(1), news: +s.news.toFixed(1), buzz: +s.buzz.toFixed(1) },
      basketRet1m: basketRet == null ? null : +basketRet.toFixed(4),
      excess1m: excess == null ? null : +excess.toFixed(4),
      tickers: th.tickers,
      topTickers: [...S[th.id].tickerHits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t),
      examples: s.examples.slice(0, 4),
    });
  }
  themesOut.sort((a, b) => b.raw - a.raw);

  const buzzOut = [...buzz.entries()]
    .map(([t, b]) => ({ t, w: +b.w.toFixed(1), sources: [...b.sources] }))
    .sort((a, b) => b.w - a.w).slice(0, 20);

  // finalize today's main theme (UTC day) and keep 30 days of winners
  const today = new Date().toISOString().slice(0, 10);
  const daily = (prev?.daily || []).filter(d => d.date !== today).slice(-29);
  const top = themesOut[0];
  daily.push({ date: today, id: top.id, name: top.name, score: top.score, confidence: top.confidence, confLabel: top.confLabel });

  // rolling snapshot history for trend display (last 28 snapshots ≈ 14 days)
  const history = (prev?.history || []).slice(-27);
  history.push({ ts: Date.now(), scores: Object.fromEntries(themesOut.map(t => [t.id, t.raw])) });

  const out = {
    updated: new Date().toISOString(),
    sourcesUp, counts: { reddit: reddit.length, apewisdom: ape.length, stocktwits: st.length, headlines: headlines.length },
    spyRet1m: spyRet == null ? null : +spyRet.toFixed(4),
    themes: themesOut,
    rawScores: Object.fromEntries(themesOut.map(t => [t.id, t.raw])),
    buzz: buzzOut, daily, history,
  };
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`Wrote social.json — main theme today: ${top.name} (share ${top.score}%, confidence ${top.confidence} ${top.confLabel})`);
})();
