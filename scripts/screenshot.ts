/**
 * Drive the UI in headless Chromium and capture screenshots:
 * home page -> create league -> league lobby -> start match -> live trading.
 *
 *   PORT=3210 tsx scripts/screenshot.ts <outDir>
 */
import { chromium } from "playwright";

const base = `http://localhost:${process.env.PORT ?? 3210}`;
const outDir = process.argv[2] ?? ".";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });

// Home page
await page.goto(base);
await page.fill("#username", "sid");
await page.screenshot({ path: `${outDir}/1-home.png` });

// Create a league (2-minute match so events flow fast)
await page.fill("#duration", "2");
await page.click("text=Create league");
await page.waitForURL("**/league/**");
await page.waitForSelector("table.market");
await page.screenshot({ path: `${outDir}/2-lobby.png` });

// Buy some shares in the lobby, then start the match
await page.click("button.qty >> text=100");
const rows = page.locator("table.market tbody tr");
await rows.nth(16).locator("button.buy").click(); // Amara Kone
await page.waitForSelector(".toast");
await rows.nth(8).locator("button.sell").click(); // short Rio Tanaka
await page.click("text=▶ Start match");
await page.waitForSelector(".badge.live");

// Let the match run a bit so sparklines/ticker/prices move, then capture
await page.waitForTimeout(20_000);
await page.screenshot({ path: `${outDir}/3-live.png` });

await browser.close();
console.log("screenshots saved");
