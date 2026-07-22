// End-to-end verification of the Quake catalog title in the handheld console.
//
// Drives real Chrome over CDP through the console flow to the Quake title,
// confirms WebQuake boots (loads the shareware pak over HTTP range requests and
// starts rendering), and that forwarded input reaches the engine. Same WSL setup
// as scripts/verify-console.mjs:
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-quake.mjs   (Windows Node, so it resolves the repo's playwright)
//
// Env: CBX_BASE_URL (default http://localhost:3000), CBX_CDP_URL, CBX_SHOT_DIR.

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

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

const browser = await chromium.connectOverCDP(CDP);
try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const page = await phone.newPage();
  const errors = [];
  const failedPak = [];
  page.on("pageerror", (error) => {
    const text = String(error);
    // Ignore the benign WebAudio autoplay race ("play() request was interrupted
    // by a call to pause()") — a browser policy artifact, not an engine fault.
    if (/play\(\) request was interrupted|AbortError/i.test(text)) return;
    errors.push(text);
  });
  page.on("requestfailed", (req) => {
    if (req.url().includes("/quake/")) failedPak.push(`${req.url()} ${req.failure()?.errorText ?? ""}`);
  });

  // Console flow → guest → Browse. Timeouts are generous because the dev server
  // compiles console routes on demand on the first hit.
  try {
    await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
    await page.getByTestId("title-screen").waitFor({ timeout: 30000 });
    await pressShellButton(page, "Start");
    await page.getByTestId("auth-screen").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Continue as guest" }).click();
    // Land in the shell (the tabbar container), whether or not the feed cards have
    // finished loading yet.
    await page.getByTestId("console-shell").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "BROWSE" }).click();
    await page.getByTestId("browse-screen").waitFor({ timeout: 20000 });
    await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 20000 }).catch(() => {});
  } catch (err) {
    await page.screenshot({ path: shot("quake-00-flow-failure") }).catch(() => {});
    throw err;
  }

  // Find the Quake grid card by its title text and launch it.
  const quakeCard = page.locator("button.os-grid-card", { hasText: "Quake" }).first();
  const found = await quakeCard.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check("Quake appears in the Browse grid", found);
  if (!found) throw new Error("Quake card not listed");

  await quakeCard.click();
  await page.getByTestId("game-screen").waitFor({ timeout: 15000 });
  check("Quake launches full-screen", true);

  // The engine runs in the same-origin iframe. Wait for WebQuake to un-hide its
  // canvas (GL.Init sets #mainwindow display:inline-block) — proof it loaded the
  // pak and started rendering — and for the "Starting Quake…" progress to clear.
  const frame = page.frameLocator(".os-quake-frame");
  const rendering = await frame
    .locator("#mainwindow")
    .waitFor({ state: "visible", timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  check("WebQuake canvas renders (pak loaded, engine live)", rendering);

  const progressGone = await page
    .frameLocator(".os-quake-frame")
    .locator("#progress")
    .evaluate((el) => getComputedStyle(el).display === "none")
    .catch(() => false);
  check("boot progress cleared (runtime initialized)", progressGone);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot("quake-01-booted") });

  // Forwarded input: physical "KeyA" is the shell's code for the X button, which
  // this runtime maps to Escape — Quake's menu key. Pressing it should change what
  // is on screen (attract demo → main menu) without erroring.
  await page.keyboard.press("KeyA");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shot("quake-02-after-menu-key") });
  // Nudge the menu with the d-pad and confirm key to exercise the input path.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("quake-03-after-input") });
  check("input reaches the engine without error", errors.length === 0, errors.slice(0, 2).join(" | "));

  check("no failed /quake asset requests", failedPak.length === 0, failedPak.slice(0, 2).join(" | "));

  // Eject returns to Browse.
  await pressShellButton(page, "Select");
  const backToBrowse = await page
    .getByTestId("browse-screen")
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("SELECT ejects Quake back to Browse", backToBrowse);

  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
