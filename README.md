# Money Flow Tracker

Live market-rotation monitor: estimates money flowing between US sectors, bonds & credit, and major asset classes from price × volume. Three views: Sankey flow map, Relative Rotation Graph (RRG), and 12-week flow history heatmap. Daily / weekly / monthly periods.


## Methodology

Flow per asset = (return − group average return) × average daily dollar volume, capped at 2.5× group median so one giant asset can't dominate. Negative = money out, positive = money in; outflows distributed to inflows pro-rata for the Sankey. RRG is a JdK-style approximation: RS-Ratio = 100 × RS / SMA21(RS); RS-Momentum = 100 + 5-day change in RS-Ratio. Benchmarks: SPY (sectors), AGG (bonds), equal-weight basket (cross-asset). Estimates, not actual fund flows; not investment advice.
