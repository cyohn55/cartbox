// Diagnoses the handheld → cartridge input chain, link by link, on the seeded
// "hold right to score" demo cart. Compares canvas pixels before/after each
// input source to see which link (trusted key, synthetic key, shell button)
// actually reaches the game. Run like verify-console.mjs (Windows Node + CDP).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";

// WebGL canvases read back as zeros via drawImage (no preserveDrawingBuffer),
// so probe frames with element screenshots and hash the PNG bytes instead.
async function canvasHash(page) {
  const canvas = page.locator(".os-game-stage canvas").first();
  const png = await canvas.screenshot();
  let hash = 0;
  for (let i = 0; i < png.length; i += 13) {
    hash = ((hash << 5) - hash + png[i]) | 0;
  }
  return String(hash);
}

const browser = await chromium.connectOverCDP(CDP);
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("PAGE ERROR:", String(error).slice(0, 200)));
page.on("console", (message) => {
  if (message.type() === "error") console.log("CONSOLE ERROR:", message.text().slice(0, 200));
});
page.on("response", (response) => {
  if (response.status() >= 400) console.log("HTTP", response.status(), response.url().slice(0, 140));
});

await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
await page.getByTestId("title-screen").waitFor({ timeout: 10000 });
await page.getByTestId("title-screen").click();
await page.getByRole("button", { name: "Continue as guest" }).click();
await page.getByRole("button", { name: "BROWSE" }).click();
await page.locator(".os-grid-card").first().waitFor({ timeout: 10000 });

// Launch the seeded score demo ("hold right"), not a blank draft.
const target = page.locator("button.os-grid-card", { hasText: "Ring Runner" });
const count = await target.count();
console.log("Ring Runner cards found:", count);
await (count > 0 ? target.first() : page.locator("button.os-grid-card").first()).click();
await page.locator(".os-game-stage canvas").waitFor({ timeout: 25000 });
await page.waitForTimeout(1500); // let frame 0 settle

const idle1 = await canvasHash(page);
await page.waitForTimeout(800);
const idle2 = await canvasHash(page);
console.log("idle frame stable:", idle1 === idle2, `(${idle1} vs ${idle2})`);

// Link 1: trusted keyboard (bypasses the shell entirely).
await page.keyboard.down("ArrowRight");
await page.waitForTimeout(1200);
const afterTrusted = await canvasHash(page);
await page.keyboard.up("ArrowRight");
console.log("trusted ArrowRight changes frame:", afterTrusted !== idle2);

// Link 2: synthetic KeyboardEvent on window (what the input bus dispatches).
await page.waitForTimeout(500);
const beforeSynthetic = await canvasHash(page);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
});
await page.waitForTimeout(1200);
const afterSynthetic = await canvasHash(page);
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowRight", bubbles: true }));
});
console.log("synthetic ArrowRight changes frame:", afterSynthetic !== beforeSynthetic);

// Link 3: the shell's physical Right button (pointer events → bus → keys).
await page.waitForTimeout(500);
const beforeShell = await canvasHash(page);
await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerdown", { pointerId: 7 });
await page.waitForTimeout(1200);
const afterShell = await canvasHash(page);
await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerup", { pointerId: 7 });
console.log("shell Right button changes frame:", afterShell !== beforeShell);

// Link 3b: real tap (touchscreen) on the shell button.
await page.waitForTimeout(500);
const beforeTap = await canvasHash(page);
const box = await page.getByRole("button", { name: "Right", exact: true }).boundingBox();
await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(1200);
const afterTap = await canvasHash(page);
console.log("real tap on shell Right changes frame:", afterTap !== beforeTap);

// Imported TIC-80 cart: does a stock tic80.com game run and take input?
await page.getByRole("button", { name: "Select", exact: true }).dispatchEvent("pointerdown", { pointerId: 9 });
await page.getByRole("button", { name: "Select", exact: true }).dispatchEvent("pointerup", { pointerId: 9 });
await page.getByTestId("browse-screen").waitFor({ timeout: 15000 }).catch(async () => {
  // SELECT cycles tabs; land on Browse whichever tab we came back to.
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 10000 });
});
await page.locator(".os-grid-card").first().waitFor({ timeout: 10000 }).catch(() => {});
const imported = page.locator("button.os-grid-card", { hasText: "FLOCK BLOCK" });
if ((await imported.count()) > 0) {
  await imported.first().click();
  await page.locator(".os-game-stage canvas").waitFor({ timeout: 25000 });
  await page.waitForTimeout(2000);
  const ticIdle = await canvasHash(page);
  await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerdown", { pointerId: 11 });
  await page.waitForTimeout(1200);
  const ticAfter = await canvasHash(page);
  await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerup", { pointerId: 11 });
  console.log("imported TIC-80 cart responds to shell input:", ticAfter !== ticIdle);
  await page.screenshot({ path: "C:/Temp/cbx-verify/13-flock-block.png" });
} else {
  console.log("imported TIC-80 cart responds to shell input: SKIPPED (not found in Browse)");
}

await browser.close();
