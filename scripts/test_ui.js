/* Drives the local pages in headless Edge: search UI + pre-market UI.
   Not part of the no-dependency pipeline - needs `npm i puppeteer-core` (anywhere
   on NODE_PATH) and `node scripts/dev_server.js` running on port 8123. */
const puppeteer = require("puppeteer-core");

(async () => {
  const browser = await puppeteer.launch({
    executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    headless: "new",
  });
  const page = await browser.newPage();
  page.on("pageerror", e => { console.error("PAGE ERROR:", e.message); process.exitCode = 1; });
  await page.setViewport({ width: 1400, height: 1200 });
  await page.goto("http://localhost:8123/stocks.html", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#tbody tr", { timeout: 30000 });

  const fail = msg => { console.error("FAIL  " + msg); process.exitCode = 1; };
  const pass = msg => console.log("PASS  " + msg);

  // 1) universe size
  const n = await page.$eval("#universe-n", el => el.textContent);
  +n >= 450 ? pass(`universe loaded: ${n} stocks`) : fail(`universe too small: ${n}`);

  // 2) search by company name
  await page.type("#search", "tesla");
  await new Promise(r => setTimeout(r, 300));
  let rows = await page.$$eval("#tbody tr.stock-row", trs => trs.map(tr => tr.dataset.t));
  rows.includes("TSLA") && rows.length <= 3 ? pass(`name search "tesla" -> ${rows.join(",")}`) : fail(`name search got ${rows.join(",")}`);

  // 3) search by ticker, exact match first
  await page.$eval("#search", el => el.value = "");
  await page.type("#search", "AMD");
  await new Promise(r => setTimeout(r, 300));
  rows = await page.$$eval("#tbody tr.stock-row", trs => trs.map(tr => tr.dataset.t));
  rows[0] === "AMD" ? pass(`ticker search "AMD" -> first row ${rows[0]}`) : fail(`expected AMD first, got ${rows.join(",")}`);

  // 4) unknown ticker -> live-fetch button appears
  await page.$eval("#search", el => el.value = "");
  await page.type("#search", "RIVN"); // Rivian: US-listed but not in the S&P 500
  await new Promise(r => setTimeout(r, 300));
  const btn = await page.$("#fetch-live");
  btn ? pass("unknown ticker RIVN -> fetch-live button shown") : fail("no fetch-live button for RIVN");

  // 5) click it -> live fetch from Yahoo, row appears scored
  if (btn) {
    await btn.click();
    try {
      await page.waitForSelector('#tbody tr.stock-row[data-t="RIVN"]', { timeout: 30000 });
      const cells = await page.$eval('#tbody tr.stock-row[data-t="RIVN"]', tr => tr.innerText.replace(/\s+/g, " "));
      pass("RIVN fetched live and scored: " + cells.slice(0, 90));
    } catch (e) {
      fail("RIVN row did not appear after live fetch (network?): " + e.message);
    }
  }

  // 6) clearing search restores the filtered table
  await page.$eval("#search", el => { el.value = ""; el.dispatchEvent(new Event("input")); });
  await new Promise(r => setTimeout(r, 300));
  rows = await page.$$eval("#tbody tr.stock-row", trs => trs.length);
  rows > 100 ? pass(`cleared search -> ${rows} rows (leading sectors)`) : fail(`cleared search -> only ${rows} rows`);

  // 7) pre-market UI (?pretest forces the pre session; quotes are fabricated
  //    when no real pre-market trades exist, so this runs at any hour)
  await page.goto("http://localhost:8123/stocks.html?pretest", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#tbody tr", { timeout: 30000 });
  const bannerVisible = await page.$eval("#pre-banner", el => el.style.display !== "none" && el.textContent.includes("PRE-MARKET"));
  bannerVisible ? pass("stocks.html pretest -> pre-market banner shown") : fail("pre-market banner missing");
  try {
    await page.waitForFunction(() => document.querySelector("#picks") && document.querySelector("#picks").innerText.includes("PRE $"), { timeout: 30000 });
    pass("top picks show PRE prices");
  } catch (e) { fail("top picks never showed PRE prices"); }
  await page.click("#tbody tr.stock-row");
  try {
    await page.waitForFunction(() => { const d = document.querySelector("tr.detail"); return d && d.innerText.includes("Pre-market"); }, { timeout: 30000 });
    pass("detail row shows Pre-market entry");
  } catch (e) { fail("detail row missing Pre-market entry"); }

  // 8) index.html: pre-market note on every view
  await page.goto("http://localhost:8123/index.html?pretest", { waitUntil: "networkidle2", timeout: 60000 });
  try {
    await page.waitForFunction(() => document.getElementById("view-hint").innerText.includes("PRE-MARKET"), { timeout: 90000 });
    pass("index flow map hint notes PRE-MARKET");
  } catch (e) { fail("index flow map hint missing PRE-MARKET note"); }
  for (const v of ["rrg", "history"]) {
    await page.click(`#view-seg button[data-v="${v}"]`);
    await new Promise(r => setTimeout(r, 400));
    const noted = await page.$eval("#view-hint", el => el.innerText.includes("PRE-MARKET"));
    noted ? pass(`index ${v} view hint notes PRE-MARKET`) : fail(`index ${v} view hint missing note`);
  }
  const rankNoted = await page.$eval("#pre-note-rank", el => el.innerText.includes("PRE-MARKET"));
  rankNoted ? pass("rankings panel notes PRE-MARKET") : fail("rankings panel missing note");

  // 9) themes page renders from social.json
  await page.goto("http://localhost:8123/themes.html", { waitUntil: "networkidle2", timeout: 60000 });
  try {
    await page.waitForFunction(() => { const n = document.getElementById("hero-name"); return n && n.textContent.length > 2 && !n.textContent.includes("not available"); }, { timeout: 20000 });
    const hero = await page.$eval("#hero-name", el => el.textContent);
    pass(`themes hero shows main theme: ${hero}`);
  } catch (e) { fail("themes hero did not render"); }
  const lbRows = await page.$$eval("#leaderboard .lb-row", r => r.length);
  lbRows >= 10 ? pass(`theme leaderboard: ${lbRows} themes`) : fail(`leaderboard only ${lbRows} rows`);
  await page.click("#leaderboard .lb-row");
  const detail = await page.$(".lb-detail");
  detail ? pass("theme row expands with examples/tickers") : fail("theme detail did not expand");
  const scCards = await page.$$eval(".sc-card", c => c.length);
  scCards >= 2 ? pass(`supply chain renders ${scCards} segments`) : fail("supply-chain segments missing in detail");
  const heroSC = await page.$eval("#hero-mets", el => el.innerText.includes("Supply chain"));
  heroSC ? pass("hero shows supply-chain callout") : fail("hero missing supply-chain callout");

  // 10) deep link: themes → stocks.html?q=NVDA pre-fills search
  await page.goto("http://localhost:8123/stocks.html?q=NVDA", { waitUntil: "networkidle2", timeout: 60000 });
  await page.waitForSelector("#tbody tr", { timeout: 30000 });
  const firstT = await page.$eval("#tbody tr.stock-row", tr => tr.dataset.t);
  firstT === "NVDA" ? pass("deep link ?q=NVDA filters to NVDA") : fail(`deep link got ${firstT}`);

  await page.screenshot({ path: "C:\\Users\\User\\ui_test.png" });
  await browser.close();
  console.log(process.exitCode ? "\nUI TESTS FAILED" : "\nUI TESTS PASSED");
})();
