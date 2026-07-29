/**
 * Smoke-tests a deployed console (Vercel, Pages, or a local dev server).
 *
 * Deliberately does NOT assume the database has content: a fresh deployment
 * legitimately has no carts and no posts. What it asserts instead is that each
 * screen lands in an *honest* state — Browse lists whatever catalog the backend
 * has, and the Feed shows either cards or its "nothing published yet" empty
 * state, never its "could not be reached" error state.
 *
 * That last distinction is the point. An empty feed and an unreachable backend
 * used to render identically (the API answered 200 with an empty list either
 * way), so "the feed looks fine" was not evidence the backend was up.
 *
 *   CBX_BASE_URL=https://<host> node scripts/verify-deployed-console.mjs
 *
 * Run with Windows Node against a CDP-attached Chrome; see verify-console.mjs
 * for the WSL setup this shares.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const CDP_URL = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const BASE_URL = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const SHOT_DIR = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(SHOT_DIR, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function pressShellButton(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await button.dispatchEvent("pointerup", { pointerId: 1 });
}

console.log(`Target: ${BASE_URL}\n`);

const browser = await chromium.connectOverCDP(CDP_URL);

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  });
  const page = await context.newPage();

  const pageErrors = [];
  const failedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("response", (response) => {
    const url = response.url();
    if (response.status() >= 400 && new URL(url).origin === new URL(BASE_URL).origin) {
      failedRequests.push(`${response.status()} ${url}`);
    }
  });

  await page.goto(`${BASE_URL}/console`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 30000 });
  check("console boots to the title screen", true);

  await pressShellButton(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Continue as guest" }).click();

  // --- Feed: cards, or an honest empty state --------------------------------
  // The feed reports its own state, so this reads the state rather than
  // pattern-matching the copy on screen.
  const feedElement = page.getByTestId("home-feed");
  await feedElement.waitFor({ timeout: 30000 });
  await page.waitForTimeout(3000);
  const feed = await page.evaluate(() => ({
    state: document.querySelector('[data-testid="home-feed"]')?.dataset.feedState ?? null,
    cards: document.querySelectorAll(".os-card").length,
  }));
  check(
    "feed reports an honest state, not a backend failure",
    feed.state === "ready" || feed.state === "empty",
    feed.state === "ready" ? `${feed.cards} cards` : `state: ${feed.state}`,
  );
  await page.screenshot({ path: `${SHOT_DIR}/deployed-feed.png` });

  // --- Browse: the catalog the backend actually has -------------------------
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 15000 });
  await page
    .locator(".os-grid-card, .os-empty")
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  const browse = await page.evaluate(() => ({
    total: document.querySelectorAll(".os-grid-card").length,
    games: document.querySelectorAll('.os-grid-card[data-entry-kind="game"]').length,
    carts: document.querySelectorAll('.os-grid-card[data-entry-kind="cart"]').length,
    unreachable: /could not be reached/i.test(document.querySelector(".os-empty")?.textContent ?? ""),
    loading: Boolean(document.querySelector(".os-loading")),
  }));
  check("browse reaches the catalog", !browse.unreachable && !browse.loading);
  check(
    "browse lists the ported games",
    browse.games > 0,
    `${browse.games} games, ${browse.carts} carts`,
  );
  await page.screenshot({ path: `${SHOT_DIR}/deployed-browse.png` });

  check("no page errors", pageErrors.length === 0, pageErrors[0] ?? "");
  check("no failing same-origin requests", failedRequests.length === 0, failedRequests[0] ?? "");

  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
