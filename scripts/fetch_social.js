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

/* ---------------- theme dictionary ----------------
   Each theme also defines its supply chain as `subs` (upstream → downstream).
   Sub-segments are scored from the same posts/headlines/ticker-buzz and get
   their own 1-month basket, so you can see WHERE in the chain attention sits. */
const THEMES = [
  { id: "ai-semis", name: "AI & Semiconductors", kw: ["artificial intelligence", " ai ", "ai bubble", "ai capex", "ai spending", "chip", "semiconductor", "gpu", "datacenter", "data center", "nvidia", "openai", "anthropic", "llm", "blackwell", "foundry"], tickers: ["NVDA","AMD","AVGO","TSM","MU","INTC","ARM","SMCI","MRVL","ASML","AMAT","LRCX","KLAC","SNDK","WDC","MSFT","ORCL","PLTR","CRWV"], subs: [
    { id: "materials", name: "Rare Earth & Materials", kw: ["rare earth", "neodymium", "gallium", "germanium", "wafer", "polysilicon", "silicon carbide", "export control"], tickers: ["MP","USAR","UUUU","FCX","TMC"] },
    { id: "equipment", name: "Fab Equipment", kw: ["lithography", "euv", "etch", "deposition", "fab equipment", "wafer fab"], tickers: ["ASML","AMAT","LRCX","KLAC","TER"] },
    { id: "chips", name: "Chip Design & Foundry", kw: ["gpu", "foundry", "accelerator", "asic", "tapeout", "node", "tsmc"], tickers: ["NVDA","AMD","AVGO","TSM","INTC","ARM","MRVL","QCOM"] },
    { id: "memory", name: "Memory & Storage", kw: ["hbm", "dram", "nand", "memory chip", "high bandwidth memory", "flash", "ssd"], tickers: ["MU","SNDK","WDC","STX"] },
    { id: "infra", name: "Servers & Networking", kw: ["server", "rack", "networking", "interconnect", "optical", "switch"], tickers: ["SMCI","DELL","ANET","VRT","CSCO","CIEN"] },
    { id: "apps", name: "AI Applications", kw: ["copilot", "chatbot", "chatgpt", "gemini", "ai software", "ai agent", "inference", "ai cloud"], tickers: ["MSFT","GOOGL","META","ORCL","PLTR","CRM","NOW","CRWV"] },
  ]},
  { id: "datacenter-power", name: "Data-Center Power & Grid", kw: ["power demand", "electricity demand", "grid", "utility", "megawatt", "gigawatt", "power purchase", "energy for ai", "cooling"], tickers: ["VST","CEG","ETN","VRT","PWR","NEE","GEV","TLN","SO","D"], subs: [
    { id: "generation", name: "Power Generation", kw: ["power plant", "gas turbine", "ppa", "power purchase", "independent power"], tickers: ["VST","CEG","TLN","NEE","SO","D"] },
    { id: "grid", name: "Grid & Electrical Equipment", kw: ["transformer", "switchgear", "grid equipment", "electrification", "turbine order"], tickers: ["ETN","PWR","GEV","HUBB"] },
    { id: "cooling", name: "Cooling & DC Infrastructure", kw: ["liquid cooling", "cooling", "hvac", "thermal"], tickers: ["VRT","JCI","TT","NVT"] },
    { id: "dc-reits", name: "Data-Center REITs", kw: ["data center reit", "colocation", "hyperscale lease"], tickers: ["DLR","EQIX","IRM"] },
  ]},
  { id: "nuclear", name: "Nuclear & Uranium", kw: ["nuclear", "uranium", "reactor", "smr ", "small modular", "enrichment", "fission"], tickers: ["CCJ","OKLO","SMR","LEU","CEG","UEC","NNE","BWXT"], subs: [
    { id: "mining", name: "Uranium Mining", kw: ["uranium mine", "u3o8", "uranium price", "spot uranium"], tickers: ["CCJ","UEC","DNN","NXE","UUUU"] },
    { id: "fuel", name: "Enrichment & Fuel", kw: ["enrichment", "haleu", "nuclear fuel"], tickers: ["LEU","BWXT"] },
    { id: "reactors", name: "Reactors & SMR Builders", kw: ["smr", "small modular", "reactor design", "new reactor"], tickers: ["OKLO","SMR","NNE","BWXT","GEV"] },
    { id: "operators", name: "Plant Operators", kw: ["nuclear plant", "restart", "nuclear power deal"], tickers: ["CEG","VST","TLN","DUK"] },
  ]},
  { id: "glp1", name: "GLP-1 / Obesity Drugs", kw: ["glp-1", "ozempic", "wegovy", "zepbound", "obesity drug", "weight loss drug", "weight-loss"], tickers: ["LLY","NVO","VKTX","HIMS","AMGN","PFE"], subs: [
    { id: "pharma", name: "Drug Makers", kw: ["ozempic", "wegovy", "zepbound", "orforglipron", "obesity pill", "trial data"], tickers: ["LLY","NVO","AMGN","PFE","VKTX"] },
    { id: "supply", name: "Manufacturing & Devices", kw: ["fill-finish", "syringe", "auto-injector", "cdmo", "capacity"], tickers: ["TMO","WST","CRL"] },
    { id: "channel", name: "Telehealth & Distribution", kw: ["telehealth", "compounded", "pharmacy"], tickers: ["HIMS","CVS","MCK"] },
  ]},
  { id: "defense", name: "Defense & Geopolitics", kw: ["defense", "defence", "missile", "drone", "nato", "ukraine", "israel", "iran", "taiwan", "military", "war ", "geopolit"], tickers: ["LMT","RTX","NOC","GD","LHX","AVAV","KTOS","PLTR","BA"], subs: [
    { id: "primes", name: "Prime Contractors", kw: ["contract award", "pentagon", "procurement", "missile defense"], tickers: ["LMT","RTX","NOC","GD","LHX"] },
    { id: "drones", name: "Drones & Defense AI", kw: ["drone", "uav", "counter-uas", "autonomous weapons", "battlefield ai"], tickers: ["AVAV","KTOS","PLTR","ONDS"] },
    { id: "components", name: "Aerospace Components", kw: ["aerospace parts", "aftermarket", "engine parts"], tickers: ["HEI","TDG","CW"] },
    { id: "ships", name: "Ships & Munitions", kw: ["shipbuilding", "submarine", "ammunition", "munitions", "artillery"], tickers: ["HII","GD","BA"] },
  ]},
  { id: "crypto", name: "Crypto & Digital Assets", kw: ["bitcoin", "btc", "ethereum", "crypto", "stablecoin", "blockchain", "halving", "etf inflow"], tickers: ["COIN","MSTR","HOOD","MARA","RIOT","CLSK","GLXY","CRCL","BMNR"], subs: [
    { id: "exchanges", name: "Exchanges & Brokers", kw: ["exchange volume", "trading app", "listing"], tickers: ["COIN","HOOD","GLXY"] },
    { id: "treasuries", name: "Treasury Holders", kw: ["bitcoin treasury", "btc holdings", "accumulation strategy"], tickers: ["MSTR","BMNR"] },
    { id: "miners", name: "Miners", kw: ["miner", "hashrate", "mining difficulty", "ai pivot"], tickers: ["MARA","RIOT","CLSK","CIFR"] },
    { id: "stablecoins", name: "Stablecoins & Payments", kw: ["stablecoin", "usdc", "genius act", "payments rail"], tickers: ["CRCL","PYPL","V","MA"] },
  ]},
  { id: "rates-fed", name: "Fed, Rates & Inflation", kw: ["fed ", "federal reserve", "rate cut", "rate hike", "fomc", "powell", "inflation", "cpi ", "pce ", "treasury yield", "bond yield", "soft landing", "recession"], tickers: ["TLT","JPM","BAC","GS","MS","SCHW","KRE"], subs: [
    { id: "megabanks", name: "Money-Center Banks", kw: ["net interest", "loan growth", "bank earnings"], tickers: ["JPM","BAC","C","WFC"] },
    { id: "capmarkets", name: "Capital Markets", kw: ["ipo", "m&a", "trading revenue", "deal"], tickers: ["GS","MS","SCHW"] },
    { id: "regionals", name: "Regional Banks", kw: ["regional bank", "commercial real estate", "deposits"], tickers: ["KRE","TFC","USB"] },
    { id: "duration", name: "Bonds & Duration", kw: ["treasury yield", "bond rally", "duration", "10-year"], tickers: ["TLT","IEF","AGG"] },
  ]},
  { id: "quantum", name: "Quantum Computing", kw: ["quantum"], tickers: ["IONQ","RGTI","QBTS","IBM","GOOGL"], subs: [
    { id: "pureplays", name: "Pure Plays", kw: ["qubit", "ion trap", "annealing", "quantum startup"], tickers: ["IONQ","RGTI","QBTS"] },
    { id: "bigtech", name: "Big-Tech Labs", kw: ["willow", "quantum chip", "error correction"], tickers: ["IBM","GOOGL","MSFT","NVDA"] },
  ]},
  { id: "ev-autonomous", name: "EV & Autonomous Driving", kw: ["electric vehicle", " ev ", "robotaxi", "self-driving", "autonomous", "fsd", "lidar", "charging"], tickers: ["TSLA","RIVN","LCID","UBER","GM","F","XPEV","NIO","MBLY"], subs: [
    { id: "automakers", name: "Automakers", kw: ["deliveries", "ev sales", "production ramp"], tickers: ["TSLA","RIVN","LCID","GM","F","XPEV","NIO"] },
    { id: "batteries", name: "Batteries & Lithium", kw: ["lithium", "battery", "cathode", "gigafactory"], tickers: ["ALB","SQM","LAC"] },
    { id: "autonomy", name: "Autonomy & Robotaxi", kw: ["robotaxi", "waymo", "fsd", "self-driving", "lidar"], tickers: ["UBER","MBLY","GOOGL","TSLA"] },
    { id: "charging", name: "Charging Network", kw: ["charging station", "supercharger", "charging network"], tickers: ["CHPT","EVGO"] },
  ]},
  { id: "robotics", name: "Robotics & Humanoids", kw: ["robot", "humanoid", "automation", "optimus", "figure ai"], tickers: ["TSLA","NVDA","ROK","ISRG","TER","SYM"], subs: [
    { id: "humanoids", name: "Humanoids & Brains", kw: ["humanoid", "optimus", "figure ai", "robot foundation model"], tickers: ["TSLA","NVDA"] },
    { id: "industrial", name: "Industrial Automation", kw: ["factory automation", "industrial robot", "plc"], tickers: ["ROK","EMR","HON"] },
    { id: "warehouse", name: "Warehouse & Medical", kw: ["warehouse robot", "fulfillment", "surgical robot"], tickers: ["SYM","ISRG","TER"] },
  ]},
  { id: "space", name: "Space Economy", kw: ["space", "rocket", "satellite", "starlink", "spacex", "launch", "orbit"], tickers: ["RKLB","ASTS","LUNR","RDW","BA","PL"], subs: [
    { id: "launch", name: "Launch Providers", kw: ["launch", "rocket", "neutron", "starship"], tickers: ["RKLB"] },
    { id: "satellites", name: "Satellites & Comms", kw: ["satellite", "constellation", "direct-to-cell", "broadband from space"], tickers: ["ASTS","IRDM","VSAT","PL"] },
    { id: "moon-defense", name: "Lunar & Defense Space", kw: ["lunar", "moon mission", "space force", "golden dome"], tickers: ["LUNR","RDW","LMT","NOC"] },
  ]},
  { id: "energy-oil", name: "Oil & Gas", kw: ["oil price", "crude", "opec", "natural gas", "natgas", "lng", "barrel", "drilling"], tickers: ["XOM","CVX","OXY","COP","SLB","HAL","EOG","FANG","LNG"], subs: [
    { id: "majors", name: "Integrated Majors", kw: ["refining", "downstream", "dividend"], tickers: ["XOM","CVX","COP"] },
    { id: "shale", name: "Shale E&P", kw: ["permian", "shale", "rig count", "production cut"], tickers: ["EOG","FANG","OXY","DVN"] },
    { id: "services", name: "Oilfield Services", kw: ["drilling services", "frac", "offshore"], tickers: ["SLB","HAL","BKR"] },
    { id: "lng", name: "LNG & Midstream", kw: ["lng", "pipeline", "export terminal", "natgas"], tickers: ["LNG","WMB","KMI","ET"] },
  ]},
  { id: "gold-havens", name: "Gold & Safe Havens", kw: ["gold price", "gold hits", "gold rally", "silver", "safe haven", "bullion", "precious metal"], tickers: ["GLD","NEM","GOLD","AEM","WPM","SLV","FNV"], subs: [
    { id: "miners", name: "Gold Miners", kw: ["gold miner", "production", "all-in cost"], tickers: ["NEM","GOLD","AEM"] },
    { id: "royalty", name: "Royalty & Streaming", kw: ["royalty", "streaming"], tickers: ["WPM","FNV","RGLD"] },
    { id: "silver", name: "Silver", kw: ["silver"], tickers: ["SLV","PAAS","AG"] },
    { id: "bullion", name: "Bullion ETFs", kw: ["bullion", "gold etf", "central bank buying"], tickers: ["GLD","IAU"] },
  ]},
  { id: "housing", name: "Housing & Homebuilders", kw: ["housing", "mortgage rate", "homebuilder", "home sales", "real estate market", "rent"], tickers: ["DHI","LEN","PHM","NVR","TOL","HD","LOW"], subs: [
    { id: "builders", name: "Homebuilders", kw: ["homebuilder", "new home", "housing starts"], tickers: ["DHI","LEN","PHM","NVR","TOL"] },
    { id: "supply", name: "Materials & Retail", kw: ["building products", "home improvement", "lumber"], tickers: ["HD","LOW","BLDR","SHW"] },
    { id: "mortgage", name: "Mortgage Finance", kw: ["mortgage rate", "refinanc", "mortgage application"], tickers: ["RKT","UWMC"] },
  ]},
  { id: "biotech", name: "Biotech & FDA Catalysts", kw: ["fda approval", "fda ", "biotech", "clinical trial", "phase 3", "drug approval", "gene therapy", "obesity pill"], tickers: ["XBI","AMGN","GILD","VRTX","REGN","MRNA","CRSP","SRPT"], subs: [
    { id: "largecap", name: "Large-Cap Biopharma", kw: ["blockbuster", "patent", "drug sales"], tickers: ["AMGN","GILD","VRTX","REGN"] },
    { id: "geneedit", name: "Gene Editing & Therapy", kw: ["gene editing", "crispr", "gene therapy", "cell therapy"], tickers: ["CRSP","NTLA","BEAM","SRPT"] },
    { id: "tools", name: "Tools & CDMO", kw: ["life science tools", "bioprocessing", "contract manufactur"], tickers: ["TMO","DHR","A"] },
  ]},
  { id: "meme-retail", name: "Meme / Retail Squeeze", kw: ["short squeeze", "meme stock", "yolo", "diamond hands", "short interest", "gamma squeeze", "to the moon"], tickers: ["GME","AMC","BBAI","DJT","OPEN","BYND"], subs: [
    { id: "classics", name: "The Classics", kw: ["gamestop", "apes"], tickers: ["GME","AMC"] },
    { id: "runners", name: "Current Runners", kw: ["squeeze candidate", "high short interest"], tickers: ["BBAI","DJT","OPEN","BYND"] },
  ]},
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

  // score themes + supply-chain sub-segments + collect ticker buzz
  const S = {}; // id → {reddit, news, buzz, examples, tickerHits, subs}
  for (const th of THEMES) S[th.id] = { reddit: 0, news: 0, buzz: 0, examples: [], tickerHits: new Map(), subs: Object.fromEntries((th.subs || []).map(sb => [sb.id, 0])) };
  const buzz = new Map(); // ticker → {mentions, sources:Set}
  const addBuzz = (t, w, src) => { const b = buzz.get(t) || { w: 0, sources: new Set() }; b.w += w; b.sources.add(src); buzz.set(t, b); };
  const tickerThemes = new Map(); // ticker → theme ids containing it
  const tickerSubs = new Map();   // ticker → [{th, sub}] supply-chain segments containing it
  for (const th of THEMES) {
    for (const t of th.tickers) (tickerThemes.get(t) || tickerThemes.set(t, []).get(t)).push(th.id);
    for (const sb of th.subs || []) {
      for (const t of sb.tickers) {
        (tickerSubs.get(t) || tickerSubs.set(t, []).get(t)).push({ th: th.id, sub: sb.id });
        validSet.add(t); // sub-only tickers (e.g. MP, ASTS) must be extractable
      }
    }
  }
  // attribute a matched text to the theme's supply-chain segments by sub
  // keywords or sub tickers mentioned in the text
  const creditSubs = (th, text, tk, w) => {
    const lc = " " + text.toLowerCase() + " ";
    for (const sb of th.subs || []) {
      if (sb.kw.some(k => lc.includes(k)) || sb.tickers.some(t => tk.has(t))) S[th.id].subs[sb.id] += w;
    }
  };

  for (const p of reddit) {
    const w = 1 + Math.log10(1 + p.score + p.comments);
    const tk = extractTickers(p.text, validSet);
    for (const [t, tw] of tk) addBuzz(t, w * tw, "reddit");
    for (const th of themeMatches(p.text)) {
      S[th.id].reddit += w;
      creditSubs(th, p.text, tk, w);
      if (S[th.id].examples.length < 6) S[th.id].examples.push({ src: "r/" + p.sub, title: p.text.slice(0, 140) });
      for (const [t, tw] of tk) if (th.tickers.includes(t)) S[th.id].tickerHits.set(t, (S[th.id].tickerHits.get(t) || 0) + w * tw);
    }
    // posts that only name a theme/segment ticker still count (half weight)
    for (const [t, tw] of tk) {
      for (const id of tickerThemes.get(t) || []) S[id].reddit += 0.5 * w * tw;
      for (const { th, sub } of tickerSubs.get(t) || []) S[th].subs[sub] += 0.5 * w * tw;
    }
  }
  for (const h of headlines) {
    const w = 2.5;
    const tk = extractTickers(h.title, validSet);
    for (const [t, tw] of tk) addBuzz(t, w * tw, "news");
    for (const th of themeMatches(h.title)) {
      S[th.id].news += w;
      creditSubs(th, h.title, tk, w);
      if (S[th.id].examples.length < 6) S[th.id].examples.push({ src: h.src, title: h.title.slice(0, 140) });
    }
  }
  for (const r of ape) {
    const w = 2 * Math.log10(1 + r.mentions);
    addBuzz(r.t, w, "mentions");
    for (const id of tickerThemes.get(r.t) || []) S[id].buzz += w;
    for (const { th, sub } of tickerSubs.get(r.t) || []) S[th].subs[sub] += w;
  }
  for (const t of st) {
    addBuzz(t, 3, "trending");
    for (const id of tickerThemes.get(t) || []) S[id].buzz += 3;
    for (const { th, sub } of tickerSubs.get(t) || []) S[th].subs[sub] += 3;
  }

  // price confirmation: 1m basket returns for themes AND their supply-chain
  // segments vs SPY — prefetched with a small worker pool (≈200 tickers)
  console.log("Confirming with 1-month price action…");
  const retCache = new Map();
  const need = new Set(["SPY"]);
  for (const th of THEMES) {
    for (const t of th.tickers.slice(0, 6)) need.add(t);
    for (const sb of th.subs || []) for (const t of sb.tickers.slice(0, 4)) need.add(t);
  }
  {
    const queue = [...need];
    let qi = 0;
    const worker = async () => {
      while (qi < queue.length) {
        const t = queue[qi++];
        retCache.set(t, await fetchRet21(t));
        await new Promise(r => setTimeout(r, 150));
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
  }
  const ret = t => retCache.get(t) ?? null;
  const avgRet = tickers => {
    const rets = tickers.map(ret).filter(r => r != null);
    return rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  };
  const spyRet = ret("SPY");
  const themesOut = [];
  const totalRaw = Object.values(S).reduce((s, x) => s + x.reddit + x.news + x.buzz, 0) || 1;
  for (const th of THEMES) {
    const s = S[th.id];
    const raw = s.reddit + s.news + s.buzz;
    const basketRet = avgRet(th.tickers.slice(0, 6));
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
      subs: (() => { // supply chain: chatter share within the theme + own 1m basket
        const list = (th.subs || []).map(sb => ({ id: sb.id, name: sb.name, raw: +(s.subs[sb.id] || 0).toFixed(1), tickers: sb.tickers, basketRet1m: (v => v == null ? null : +v.toFixed(4))(avgRet(sb.tickers.slice(0, 4))) }));
        const tot = list.reduce((a, b) => a + b.raw, 0);
        for (const sb of list) sb.share = tot ? Math.round(100 * sb.raw / tot) : 0;
        return list.sort((a, b) => b.raw - a.raw);
      })(),
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
