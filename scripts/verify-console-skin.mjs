// Verify the live console adopts the player's handheld colours via the
// "My Handheld" theme. Seeds localStorage (as onboarding would), loads /console,
// and reads the shell's computed CSS variables. Run: node scripts/verify-console-skin.mjs

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

// Bubblegum scheme (as HANDHELD_PRESETS defines it).
const scheme = {
  face: "#e84d8a",
  lButton: "#e84d8a",
  rButton: "#e84d8a",
  buttonLetter: "#fff3b0",
  dpadArrow: "#fff3b0",
  buttonDiamond: "#fff3b0",
  dpadRing: "#fff3b0",
};

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true });
  // Seed localStorage the way onboarding does, before any page script runs.
  await context.addInitScript(
    ([s]) => {
      localStorage.setItem("cartbox.handheld", JSON.stringify({ presetId: "green", scheme: s }));
      localStorage.setItem("cartbox.console.settings", JSON.stringify({ theme: "handheld" }));
    },
    [scheme],
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.locator(".hh-root").waitFor({ timeout: 20000 });
  // Settings load from localStorage in an effect after hydration; wait for it.
  await page
    .waitForFunction(() => document.querySelector(".hh-root")?.getAttribute("data-theme") === "handheld", {
      timeout: 15000,
    })
    .catch(() => {});

  const vars = await page.evaluate(() => {
    const root = document.querySelector(".hh-root");
    const cs = getComputedStyle(root);
    const read = (name) => cs.getPropertyValue(name).trim();
    return {
      theme: root.getAttribute("data-theme"),
      shellA: read("--hh-shell-a"),
      dpadA: read("--hh-dpad-a"),
      faceXhi: read("--hh-face-x-hi"),
    };
  });

  check("console is on the My Handheld theme", vars.theme === "handheld", vars.theme);
  check("shell body adopts the chassis colour", vars.shellA.toLowerCase() === "#e84d8a", vars.shellA);
  check("d-pad adopts the ring colour", vars.dpadA.toLowerCase() === "#fff3b0", vars.dpadA);
  check("face buttons adopt the diamond colour", vars.faceXhi.toLowerCase() === "#fff3b0", vars.faceXhi);

  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}\\console-skin.png` });
  check("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  process.exitCode = passed === results.length ? 0 : 1;
} finally {
  await browser.close();
}
