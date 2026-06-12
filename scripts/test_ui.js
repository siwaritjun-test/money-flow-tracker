/* Drives the local stocks.html in headless Edge and exercises the search UI.
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
  rows.includes("TSLA") && rows.length <= 3 ? pass(`name search "tesla" โ’ ${rows.join(",")}`) : fail(`name search got ${rows.join(",")}`);

  // 3) search by ticker, exact match first
  await page.$eval("#search", el => el.value = "");
  await page.type("#search", "AMD");
  await new Promise(r => setTimeout(r, 300));
  rows = await page.$$eval("#tbody tr.stock-row", trs => trs.map(tr => tr.dataset.t));
  rows[0] === "AMD" ? pass(`ticker search "AMD" โ’ first row ${rows[0]}`) : fail(`expected AMD first, got ${rows.join(",")}`);

  // 4) unknown ticker โ’ live-fetch button appears
  await page.$eval("#search", el => el.value = "");
  await page.type("#search", "RIVN"); // Rivian: US-listed but not in the S&P 500
  await new Promise(r => setTimeout(r, 300));
  const btn = await page.$("#fetch-live");
  btn ? pass("unknown ticker RIVN โ’ fetch-live button shown") : fail("no fetch-live button for RIVN");

  // 5) click it โ’ live fetch from Yahoo, row appears scored
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
  rows > 100 ? pass(`cleared search โ’ ${rows} rows (leading sectors)`) : fail(`cleared search โ’ only ${rows} rows`);

  await page.screenshot({ path: "C:\\Users\\User\\search_test.png" });
  await browser.close();
  console.log(process.exitCode ? "\nSEARCH UI TEST FAILED" : "\nSEARCH UI TEST PASSED");
})();
