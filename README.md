# Money Flow Tracker

Live market-rotation monitor: estimates money flowing between US sectors, factors/styles, bonds & credit, and major asset classes from price × volume. Views: Sankey flow map, Relative Rotation Graph (RRG), 12-week flow history heatmap, plus an Asset Guide page detailing all 43 tickers. Daily / weekly / monthly periods, auto-refresh.

**Stock Picker** (`stocks.html`) turns the rotation signal into a momentum-style stock screen: sectors are ranked by money flow + RRG quadrant, then the **full S&P 500 plus the Nasdaq-100** (auto-refreshed constituent lists, `universe.json`; a Nasdaq-100 filter shows just those) is scored 0–100 on a composite of relative strength vs their own sector (1m/3m), Money Flow Index, OBV money-flow trend, distance to 52-week high, volume surge and 20/50-day trend filters. A search box filters by ticker/name, and **any other US ticker** can be pulled live from Yahoo (press Enter) and scored against the same percentiles. Includes a market-breadth gauge, accumulation/distribution divergence flags, unusual-volume alerts, an ATR-based stop-loss + position-size calculator, and a watchlist (saved in the browser). See `ARCHITECTURE.md` for the scaling plan (serverless backend → full backend).

**Forward Test** (`forward.html`) tracks picks you choose on the Stock Picker (▶ *Start forward test* in a stock's detail row, or ▶ *Track* on a Top Pick) from the price on screen at that moment until you press *Stop tracking*. Each position stores its signal at entry (score, sector quadrant, regime, 2×ATR stop), and the page shows its dividend-adjusted return against SPY over the same days, best/worst close since entry, whether the stop was traded through, an equal-weight portfolio curve vs SPY, and returns grouped by the entry signal. Positions live in the browser's localStorage (like the watchlist); export/import a JSON file to back up or move them.

A **macro regime bar** sits above the views: risk-appetite ratios (discretionary/staples, high-beta/low-vol, equal-weight breadth, semis, small caps, high-yield credit, copper/gold — each scored on its ~1-month trend), the VIX level, and the 10y−3m yield-curve slope, summarized into a RISK-ON / MIXED / RISK-OFF verdict. Momentum signals are most trustworthy when they agree with the regime.

## Files

- `index.html` — the tracker
- `stocks.html` — momentum stock picker (sector rotation → stock selection)
- `themes.html` — social-listening investment themes (1–2 month horizon): Reddit + ApeWisdom mentions + StockTwits trending + CNBC/MarketWatch/Yahoo headlines, scored against a 16-theme keyword dictionary, confirmed with 1-month basket returns; main theme finalized daily, refreshed every ~12h
- `scripts/fetch_social.js` — the social-listening job (runs in the Action, self-skips unless social.json is ≥11h old)
- `social.json` — created by the Action; theme scores, confidence, ticker buzz, daily winners
- `assets.html` — asset guide (what each ticker is made of)
- `forward.html` — forward test of your own Stock Picker picks vs SPY
- `scripts/forward_model.js` — forward-test math (returns vs SPY, best/worst, stop hits, portfolio curve); tested by `scripts/test_forward.js`
- `scripts/forward_store.js` — forward-test positions in localStorage, with export/import
- `scripts/market_data.js` — shared data loading (committed JSON, live Yahoo via CORS proxies)
- `scripts/fetch_data.js` — server-side data fetcher (runs in GitHub Actions, no dependencies)
- `scripts/fetch_universe.js` — refreshes `universe.json` (S&P 500 + Nasdaq-100 with sectors) from Wikipedia
- `scripts/stock_universe.js` — built-in 88-stock fallback universe, used when universe.json is unavailable
- `scripts/stock_model.js` — pure indicator/scoring math (MFI, OBV, ATR, composite score), shared by page and tests
- `.github/workflows/update-data.yml` — schedule: refreshes data every 2h on weekdays
- `data.json` — created by the Action; the site loads this directly (no CORS proxies needed)
- `universe.json` — created by the Action; current S&P 500 + Nasdaq-100 constituents grouped by sector ETF
- `stocks.json` — created by the Action; daily bars (with high/low) for the stock universe, refreshed once per trading day
- `archive.json` — created by the Action; permanent daily history that grows beyond Yahoo's window

Data priority: `data.json` (if fresh) → live Yahoo via CORS proxies → offline sample data. So the site also works standalone without the Action — the pipeline just makes it faster and more reliable.

## Publish on GitHub Pages (~5 minutes)

1. Sign in at github.com → **+** → **New repository** → name it `money-flow-tracker`, set **Public** → **Create repository**.
2. Click **uploading an existing file** → drag in `index.html`, `assets.html`, `README.md`, and the `scripts` folder → **Commit changes**.
3. Add the workflow (the upload UI skips hidden folders, so create it manually): **Add file → Create new file** → type the filename exactly `.github/workflows/update-data.yml` → paste the contents of that file from this folder → **Commit changes**.
4. **Actions** tab → "Update market data" → **Run workflow** → wait ~30s. It commits `data.json` + `archive.json`. (If it can't push: Settings → Actions → General → Workflow permissions → "Read and write".)
5. **Settings** → **Pages** → Source = **Deploy from a branch**, Branch = **main** / **/(root)** → **Save**.
6. Live at `https://<your-username>.github.io/money-flow-tracker/` after ~1 minute.

From then on the Action keeps the data current automatically — you never touch it. To update the site itself, re-upload the changed HTML file.

## Methodology

Flow per asset = (return − group average return) × average daily dollar volume, capped at 2.5× group median so one giant asset can't dominate. Returns use **dividend/split-adjusted closes** (so ex-dividend price drops don't register as fake outflows — important for bond ETFs); dollar volume uses raw close × volume. All assets in a group are **aligned on common trading dates** before computing returns, so every asset's return covers the same calendar window (Bitcoin trades weekends, ETFs don't). Negative = money out, positive = money in; outflows distributed to inflows pro-rata for the Sankey. RRG is a JdK-style approximation: RS-Ratio = 100 × RS / SMA21(RS); RS-Momentum = 100 + 5-day change in RS-Ratio. Benchmarks: SPY (sectors), AGG (bonds), equal-weight basket (cross-asset). Estimates, not actual fund flows; not investment advice.

**Stock Picker scoring.** Composite (0–100) = 20% RS vs own sector (3m) + 15% RS vs sector (1m) + 12.5% MFI-14 + 12.5% OBV trend (21d change in on-balance volume, in days of average volume) + 15% proximity to 52-week high + 10% volume surge (5d/63d avg) + 15% trend filters (above 20d / 50d SMA). Cross-sectional inputs are percentile-ranked across the universe so no single metric's scale dominates. Default view shows only stocks in Leading/Improving (RRG) or top-5-ranked sectors — the momentum playbook of buying strength inside strong sectors. Suggested stop = 2×ATR(14) below price; position size = (account × risk%) ÷ stop distance.
