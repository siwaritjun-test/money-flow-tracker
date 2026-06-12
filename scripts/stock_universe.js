/* Shared stock universe — ~8 of the largest / most liquid holdings of each
   SPDR sector ETF. Used by scripts/fetch_data.js (Node) and stocks.html
   (browser). Weights drift over time; refresh the lists occasionally. */
const STOCK_UNIVERSE = {
  XLK:  [ {t:"NVDA",n:"NVIDIA"}, {t:"MSFT",n:"Microsoft"}, {t:"AAPL",n:"Apple"}, {t:"AVGO",n:"Broadcom"}, {t:"ORCL",n:"Oracle"}, {t:"PLTR",n:"Palantir"}, {t:"AMD",n:"AMD"}, {t:"CRM",n:"Salesforce"} ],
  XLF:  [ {t:"BRK-B",n:"Berkshire Hathaway"}, {t:"JPM",n:"JPMorgan"}, {t:"V",n:"Visa"}, {t:"MA",n:"Mastercard"}, {t:"BAC",n:"Bank of America"}, {t:"WFC",n:"Wells Fargo"}, {t:"GS",n:"Goldman Sachs"}, {t:"MS",n:"Morgan Stanley"} ],
  XLV:  [ {t:"LLY",n:"Eli Lilly"}, {t:"UNH",n:"UnitedHealth"}, {t:"JNJ",n:"Johnson & Johnson"}, {t:"ABBV",n:"AbbVie"}, {t:"MRK",n:"Merck"}, {t:"TMO",n:"Thermo Fisher"}, {t:"ABT",n:"Abbott"}, {t:"AMGN",n:"Amgen"} ],
  XLE:  [ {t:"XOM",n:"Exxon Mobil"}, {t:"CVX",n:"Chevron"}, {t:"COP",n:"ConocoPhillips"}, {t:"EOG",n:"EOG Resources"}, {t:"SLB",n:"Schlumberger"}, {t:"MPC",n:"Marathon Petroleum"}, {t:"PSX",n:"Phillips 66"}, {t:"WMB",n:"Williams Cos"} ],
  XLI:  [ {t:"GE",n:"GE Aerospace"}, {t:"CAT",n:"Caterpillar"}, {t:"RTX",n:"RTX"}, {t:"UBER",n:"Uber"}, {t:"HON",n:"Honeywell"}, {t:"UNP",n:"Union Pacific"}, {t:"ETN",n:"Eaton"}, {t:"DE",n:"Deere"} ],
  XLP:  [ {t:"COST",n:"Costco"}, {t:"WMT",n:"Walmart"}, {t:"PG",n:"Procter & Gamble"}, {t:"KO",n:"Coca-Cola"}, {t:"PEP",n:"PepsiCo"}, {t:"PM",n:"Philip Morris"}, {t:"MDLZ",n:"Mondelez"}, {t:"CL",n:"Colgate-Palmolive"} ],
  XLY:  [ {t:"AMZN",n:"Amazon"}, {t:"TSLA",n:"Tesla"}, {t:"HD",n:"Home Depot"}, {t:"MCD",n:"McDonald's"}, {t:"BKNG",n:"Booking Holdings"}, {t:"LOW",n:"Lowe's"}, {t:"TJX",n:"TJX"}, {t:"SBUX",n:"Starbucks"} ],
  XLU:  [ {t:"NEE",n:"NextEra Energy"}, {t:"CEG",n:"Constellation Energy"}, {t:"SO",n:"Southern Co"}, {t:"DUK",n:"Duke Energy"}, {t:"VST",n:"Vistra"}, {t:"SRE",n:"Sempra"}, {t:"AEP",n:"American Electric"}, {t:"D",n:"Dominion Energy"} ],
  XLB:  [ {t:"LIN",n:"Linde"}, {t:"SHW",n:"Sherwin-Williams"}, {t:"APD",n:"Air Products"}, {t:"ECL",n:"Ecolab"}, {t:"FCX",n:"Freeport-McMoRan"}, {t:"NEM",n:"Newmont"}, {t:"CTVA",n:"Corteva"}, {t:"DOW",n:"Dow"} ],
  XLRE: [ {t:"PLD",n:"Prologis"}, {t:"AMT",n:"American Tower"}, {t:"EQIX",n:"Equinix"}, {t:"WELL",n:"Welltower"}, {t:"SPG",n:"Simon Property"}, {t:"PSA",n:"Public Storage"}, {t:"DLR",n:"Digital Realty"}, {t:"O",n:"Realty Income"} ],
  XLC:  [ {t:"META",n:"Meta Platforms"}, {t:"GOOGL",n:"Alphabet"}, {t:"NFLX",n:"Netflix"}, {t:"DIS",n:"Disney"}, {t:"TMUS",n:"T-Mobile"}, {t:"CMCSA",n:"Comcast"}, {t:"T",n:"AT&T"}, {t:"VZ",n:"Verizon"} ],
};

const SECTOR_NAMES = {
  XLK:"Technology", XLF:"Financials", XLV:"Health Care", XLE:"Energy",
  XLI:"Industrials", XLP:"Cons. Staples", XLY:"Cons. Discret.", XLU:"Utilities",
  XLB:"Materials", XLRE:"Real Estate", XLC:"Communication",
};

const SECTOR_COLORS = {
  XLK:"#58a6ff", XLF:"#56d364", XLV:"#f778ba", XLE:"#db6d28",
  XLI:"#8b949e", XLP:"#7ee787", XLY:"#d2a8ff", XLU:"#e3b341",
  XLB:"#a5715c", XLRE:"#79c0ff", XLC:"#b392f0",
};

if (typeof module !== "undefined") module.exports = { STOCK_UNIVERSE, SECTOR_NAMES, SECTOR_COLORS };
