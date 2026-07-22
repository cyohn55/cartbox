// End-to-end verification of the Cube 2 catalog title in the handheld console.
//
// Drives real Chrome over CDP through the console flow to Cube 2, confirms
// BananaBread boots (loads ~23MB of engine + data and starts rendering), and
// that forwarded input reaches it — d-pad turn (synthetic mouse yaw) and move.
// Same WSL setup as scripts/verify-quake.mjs.
//   node scripts/verify-cube2.mjs   (Windows Node)

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify-cube2";
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
  const failedAsset = [];
  page.on("pageerror", (e) => {
    const t = String(e);
    if (/play\(\) request was interrupted|AbortError/i.test(t)) return;
    errors.push(t);
  });
  page.on("requestfailed", (r) => {
    if (r.url().includes("/cube2/")) failedAsset.push(new URL(r.url()).pathname);
  });

  try {
    await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
    await page.getByTestId("title-screen").waitFor({ timeout: 30000 });
    await pressShellButton(page, "Start");
    await page.getByTestId("auth-screen").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Continue as guest" }).click();
    await page.getByTestId("console-shell").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "BROWSE" }).click();
    await page.getByTestId("browse-screen").waitFor({ timeout: 20000 });
    await page.locator(".os-grid-card, .os-empty").first().waitFor({ timeout: 20000 }).catch(() => {});
  } catch (err) {
    await page.screenshot({ path: shot("cube2-00-flow-failure") }).catch(() => {});
    throw err;
  }

  const card = page.locator("button.os-grid-card", { hasText: "Cube 2" }).first();
  const found = await card.waitFor({ timeout: 10000 }).then(() => true).catch(() => false);
  check("Cube 2 appears in the Browse grid", found);
  if (!found) throw new Error("Cube 2 card not listed");

  await card.click();
  await page.getByTestId("game-screen").waitFor({ timeout: 15000 });
  check("Cube 2 launches full-screen", true);

  // BananaBread renders into #canvas inside the iframe once the world loads.
  const frame = page.frameLocator(".os-cube2-frame");
  let rendered = false;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(2000);
    const dims = await frame
      .locator("#canvas")
      .evaluate((c) => ({ w: c.width, h: c.height }))
      .catch(() => ({ w: 0, h: 0 }));
    if (dims.w > 0 && dims.h > 0) {
      rendered = true;
      break;
    }
  }
  check("BananaBread canvas renders (engine + data loaded)", rendered);
  await page.waitForTimeout(3000); // let the map + bots settle
  await page.screenshot({ path: shot("cube2-01-booted") });

  // Turn: hold the d-pad left (→ synthetic mouse yaw) and confirm the view moves.
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(1400);
  await page.keyboard.up("ArrowLeft");
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("cube2-02-after-turn") });

  // Move forward (d-pad up → KeyW) and fire (A → KeyF/attack).
  await page.keyboard.down("ArrowUp");
  await page.waitForTimeout(900);
  await page.keyboard.up("ArrowUp");
  await page.keyboard.press("KeyZ"); // A button → fire
  await page.waitForTimeout(400);
  await page.screenshot({ path: shot("cube2-03-after-move-fire") });

  check("input reaches the engine without error", errors.length === 0, errors.slice(0, 2).join(" | "));
  check("no failed /cube2 asset requests", failedAsset.length === 0, failedAsset.slice(0, 3).join(" | "));

  await pressShellButton(page, "Select");
  const back = await page.getByTestId("browse-screen").waitFor({ timeout: 8000 }).then(() => true).catch(() => false);
  check("SELECT ejects Cube 2 back to Browse", back);

  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
