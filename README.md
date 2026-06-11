# Money Flow Tracker

Live market-rotation monitor: estimates money flowing between US sectors, bonds & credit, and major asset classes from price × volume. Three views: Sankey flow map, Relative Rotation Graph (RRG), and 12-week flow history heatmap. Daily / weekly / monthly periods.

Single file (`index.html`), no build, no server, no API key. Data: Yahoo Finance daily bars fetched in the browser via CORS proxies, with offline sample fallback.

## Publish on GitHub Pages (~3 minutes)

1. Sign in at github.com → **+** → **New repository** → name it `money-flow-tracker`, set **Public**, click **Create repository**.
2. Click **uploading an existing file** → drag in `index.html` and `README.md` → **Commit changes**.
3. **Settings** → **Pages** (left sidebar) → under *Build and deployment*: Source = **Deploy from a branch**, Branch = **main** / **/(root)** → **Save**.
4. Wait ~1 minute. Your site is live at: `https://<your-username>.github.io/money-flow-tracker/`

To update later: edit/replace `index.html` in the repo — Pages redeploys automatically.

## Methodology

Flow per asset = (return − group average return) × average daily dollar volume, capped at 2.5× group median so one giant asset can't dominate. Negative = money out, positive = money in; outflows distributed to inflows pro-rata for the Sankey. RRG is a JdK-style approximation: RS-Ratio = 100 × RS / SMA21(RS); RS-Momentum = 100 + 5-day change in RS-Ratio. Benchmarks: SPY (sectors), AGG (bonds), equal-weight basket (cross-asset). Estimates, not actual fund flows; not investment advice.
