# Money Flow Tracker

Live market-rotation monitor: estimates money flowing between US sectors, factors/styles, bonds & credit, and major asset classes from price × volume. Views: Sankey flow map, Relative Rotation Graph (RRG), 12-week flow history heatmap, plus an Asset Guide page detailing all 43 tickers. Daily / weekly / monthly periods, auto-refresh.

A **macro regime bar** sits above the views: risk-appetite ratios (discretionary/staples, high-beta/low-vol, equal-weight breadth, semis, small caps, high-yield credit, copper/gold — each scored on its ~1-month trend), the VIX level, and the 10y−3m yield-curve slope, summarized into a RISK-ON / MIXED / RISK-OFF verdict. Momentum signals are most trustworthy when they agree with the regime.

## Files

- `index.html` — the tracker
- `assets.html` — asset guide (what each ticker is made of)
- `scripts/fetch_data.js` — server-side data fetcher (runs in GitHub Actions, no dependencies)
- `.github/workflows/update-data.yml` — schedule: refreshes data every 2h on weekdays
- `data.json` — created by the Action; the site loads this directly (no CORS proxies needed)
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
