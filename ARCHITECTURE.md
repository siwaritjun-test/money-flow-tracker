# Architecture & Scaling Plan

How the site works today, what was optimized, and the designed path to a real
frontend/backend when the project outgrows GitHub Pages.

## Current architecture (Phase 1 — static, $0/month)

```
┌────────────────────────── GitHub Actions (cron, every 2h weekdays) ─────────────────────────┐
│  fetch_universe.js ──► universe.json   (S&P 500 list: ticker, name, sector — from Wikipedia) │
│  fetch_data.js ──────► data.json       (43 ETFs/gauges, 1y daily bars, every run)            │
│                 ─────► stocks.json     (~500 stocks + high/low, refreshed once per           │
│                                         trading day — skipped when already current)          │
│                 ─────► archive.json    (permanent ETF daily history, merged forever)         │
└──────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                               │ git commit → GitHub Pages (CDN, gzip)
                                               ▼
                 index.html ── flow map / RRG / history / regime (reads data.json)
                 stocks.html ─ momentum screener (reads universe.json + data.json + stocks.json)
                 assets.html ─ asset guide
                 scripts/stock_model.js ─ pure scoring math, shared browser ⇄ Node (tested
                                          by scripts/test_model.js against the real JSON)
```

Design choices that keep this fast and free:

- **All computation happens in the browser** from precomputed JSON. Pages' CDN
  gzips JSON ~5×, so the 6 MB stocks.json travels as ~1.3 MB, cached by the CDN.
- **stocks.json updates once per trading day**, not every 2h — momentum metrics
  are daily, and this caps repo-history growth (the dominant cost of committing
  data to git). ETF data stays fresh every 2h; intraday quotes top up via the
  spark endpoint on the main page.
- **The universe maintains itself** — the Action re-parses the S&P 500
  constituent list weekly-ish; a failed parse keeps the last good file and the
  page falls back to a built-in 88-stock list. Tickers outside the universe are
  fetched live in the browser through CORS proxies on demand (search → Enter).
- **Live fallback**: every page still works opened as a bare file with no
  pipeline, fetching through CORS proxies (slower, less reliable).

Known limits of Phase 1 (accept until they hurt):

| Limit | Why it's tolerable now |
|---|---|
| Universe = S&P 500, not all ~8,000 US tickers | covers ~80% of US market cap; search fetches anything else on demand |
| Yahoo's unofficial API can break/rate-limit | retries + multi-host + validation; worst case the site serves yesterday's file |
| Repo history grows with every data commit | stocks.json daily + delta compression; if it bloats, squash history or move data to a Release asset / separate branch |
| No user accounts — watchlist is per-browser localStorage | acceptable for a single-user tool |

## Phase 2 — serverless backend (still ~$0, unlocks full market)

Trigger to do this: wanting all-US coverage, or Yahoo blocking Actions, or
>10s page loads on mobile.

```
Cloudflare Pages (static HTML, unchanged) ── /api/* ──► Cloudflare Worker
                                                          │
        ┌─────────────────────────────────────────────────┼──────────────┐
        │ R2 / KV storage                                  │ Cron Trigger │
        │  bars/{ticker}.json   (per-ticker shards)        │ (daily ETL)  │
        │  screen/latest.json   (precomputed scores, ~200KB)│              │
        │  search-index.json    (8k tickers × name, ~300KB) └──────────────┘
        └────────────────────────────────────────────────────────────────┘
```

- **Shard per ticker**: the client downloads the precomputed screen result
  (~200 KB) instead of all bars; bars/{t}.json is fetched only when a detail
  row opens. This is what makes a full-market universe (~8,000 tickers) viable
  in a browser.
- **Score server-side**: the ETL runs `stock_model.js` (it's already pure Node)
  over the whole market and writes `screen/latest.json`. The browser only
  renders and filters.
- **Universe**: NASDAQ Trader symbol directory (`nasdaqtraded.txt`, public,
  ~11k symbols) filtered to common stocks ≥ some $-volume floor.
- **Data source**: keep Yahoo initially; if reliability matters, switch the ETL
  to a vendor free tier — Tiingo (~all US EOD, 1k req/day), Polygon (5 req/min,
  2y history), or EODHD. The ETL needs ~1 bulk run/day, well within free tiers.
- API sketch (Worker routes):
  - `GET /api/screen?sector=XLK&min_score=70&sort=score` → precomputed rows
  - `GET /api/stock/:ticker` → bars + metrics (computed on read, cached in KV)
  - `GET /api/search?q=app` → from the search index
  - `GET /api/sectors` / `GET /api/regime`

## Phase 3 — full backend (when it becomes a product)

Trigger: multiple users, alerts, backtesting, or intraday signals.

- **API**: Node/Fastify or Python/FastAPI on Fly.io / Railway (~$5–10/mo).
- **DB**: Postgres + TimescaleDB hypertable `bars(symbol, day, o,h,l,c,adj,vol)`
  (~8k symbols × 250 days/yr ≈ 2M rows/yr — small), `tickers`, `scores(day,
  symbol, score, rs21, rs63, mfi, obv_trend, ...)` for point-in-time history —
  which also enables **backtesting the composite score** honestly.
- **Cache**: Redis for hot endpoints; HTTP cache headers for everything else.
- **Auth + sync**: Supabase auth; watchlists/settings move server-side.
- **Alerts**: a worker evaluates user rules daily after the ETL ("score crossed
  80", "ACC flag on watchlist stock", "sector turned Leading") → email/LINE
  Notify/Telegram.
- **Quotes**: optional WebSocket relay for live prices on open pages.
- Keep `stock_model.js` as the single scoring implementation — same math in
  ETL, API, and backtests; `test_model.js` becomes its CI gate.

## Operational notes

- If a Yahoo schema change breaks the fetcher, the workflow fails loudly
  (validation aborts before writing) and the site keeps serving the last good
  data — by design, never commit garbage.
- Repo housekeeping: if `.git` exceeds a few hundred MB, either squash the
  data-bot commits (`git filter-repo` on data files) or move data artifacts to
  a `data` branch / Release assets and point the fetch URLs there.
- All scoring math lives in `scripts/stock_model.js`; never duplicate it in
  page code — import it in both places and test it in Node.
