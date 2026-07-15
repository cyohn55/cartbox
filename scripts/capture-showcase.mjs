// Capture a consistent walkthrough of the handheld feature for the showcase:
// signup form, the handheld picker, and the re-skinned console — all Iron Man.
// Run: node scripts/capture-showcase.mjs

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify\\showcase";
mkdirSync(OUT, { recursive: true });

const ironMan = {
  face: "#195ba6",
  lButton: "#195ba6",
  rButton: "#195ba6",
  buttonLetter: "#fad937",
  dpadArrow: "#fad937",
  buttonDiamond: "#fad937",
  dpadRing: "#fad937",
};

const browser = await chromium.connectOverCDP(CDP);
try {
  // --- Signup form (desktop) ---
  const desktop = await browser.newContext({ viewport: { width: 1000, height: 760 } });
  const login = await desktop.newPage();
  await login.goto(BASE + "/login", { waitUntil: "networkidle" });
  const toggle = login.getByRole("button", { name: "Create one" });
  const username = login.getByPlaceholder("username");
  for (let i = 0; i < 5 && !(await username.isVisible().catch(() => false)); i += 1) {
    await toggle.click().catch(() => {});
    await login.waitForTimeout(400);
  }
  await username.fill("pixelpete");
  await login.getByPlaceholder("you@email.com").fill("pete@example.com");
  await login.getByPlaceholder("password").fill("supersecret");
  await login.screenshot({ path: `${OUT}\\1-signup.png` });

  // --- Handheld picker (desktop) ---
  const pick = await desktop.newPage();
  await pick.goto(BASE + "/onboarding/handheld", { waitUntil: "domcontentloaded" });
  await pick.locator("canvas").waitFor({ timeout: 20000 });
  await pick.waitForFunction(() => {
    const c = document.querySelector("canvas");
    if (!c || c.width < 100) return false;
    const { data } = c.getContext("2d").getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  }, { timeout: 20000 });
  await pick.getByRole("button", { name: /Iron Man/i }).click();
  await pick.waitForTimeout(200);
  await pick.screenshot({ path: `${OUT}\\2-picker.png` });

  // --- Re-skinned console (phone), Iron Man ---
  const phone = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true });
  await phone.addInitScript((s) => {
    localStorage.setItem("cartbox.handheld", JSON.stringify({ presetId: "iron-man", scheme: s }));
    localStorage.setItem("cartbox.console.settings", JSON.stringify({ theme: "handheld" }));
  }, ironMan);
  const consolePage = await phone.newPage();
  await consolePage.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await consolePage.locator(".hh-root").waitFor({ timeout: 20000 });
  await consolePage
    .waitForFunction(() => document.querySelector(".hh-root")?.getAttribute("data-theme") === "handheld", { timeout: 15000 })
    .catch(() => {});
  await consolePage.waitForTimeout(600);
  await consolePage.screenshot({ path: `${OUT}\\3-console.png` });

  console.log("captured 1-signup.png, 2-picker.png, 3-console.png ->", OUT);
} finally {
  await browser.close();
}
