// Verifies the feed's playable cart cards and the shell v2 features:
// gameplay previews render, PLAY IN FEED visibly runs the game and the shell
// buttons drive it, shoulders switch tabs, swap + custom colors apply, and
// the portrait screen is edge-to-edge.
// Run like verify-console.mjs (Windows Node + CDP Chrome).

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

async function press(page, label, holdMs = 60) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await page.waitForTimeout(holdMs);
  await button.dispatchEvent("pointerup", { pointerId: 1 });
  await page.waitForTimeout(120);
}

async function hashOf(locator) {
  const png = await locator.screenshot();
  let hash = 0;
  for (let i = 0; i < png.length; i += 13) hash = ((hash << 5) - hash + png[i]) | 0;
  return String(hash);
}

const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 160)));

  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 12000 });

  // Full-width screen check (portrait).
  const widths = await page.evaluate(() => ({
    bezel: document.querySelector(".hh-screen-bezel")?.getBoundingClientRect().width ?? 0,
    viewport: window.innerWidth,
  }));
  check("portrait screen is edge-to-edge", widths.bezel >= widths.viewport - 1, `${widths.bezel}/${widths.viewport}`);

  await page.getByTestId("title-screen").click();
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });
  await page.waitForTimeout(500);

  // 1. The active cart card shows a moving gameplay preview (attract mount).
  const previewStage = page.locator("[data-testid='cart-preview-attract'], [data-testid='cart-preview-loop']").first();
  const hasPreview = await previewStage
    .waitFor({ timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  check("cart card mounts a gameplay preview", hasPreview);
  if (hasPreview) {
    const previewCanvas = previewStage.locator("canvas");
    const canvasUp = await previewCanvas
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    check("preview canvas renders", canvasUp);
    await page.screenshot({ path: `${OUT}/30-feed-preview.png` });
  }

  // 2. PLAY IN FEED runs the game visibly and shell buttons drive it.
  await page.getByTestId("play-in-feed").first().click();
  const liveStage = page.locator("[data-testid='cart-live-stage'] canvas").first();
  await liveStage.waitFor({ timeout: 25000 });
  await page.waitForTimeout(2000); // engine boot
  const idle = await hashOf(liveStage);
  const visible = await liveStage.evaluate((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return rect.width > 50 && rect.height > 50;
  });
  check("in-feed game canvas is visible (stacking fix)", visible);

  await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerdown", { pointerId: 3 });
  await page.waitForTimeout(1200);
  const moved = await hashOf(liveStage);
  await page.getByRole("button", { name: "Right", exact: true }).dispatchEvent("pointerup", { pointerId: 3 });
  check("shell buttons drive the in-feed game", moved !== idle, `${idle} → ${moved}`);
  await page.screenshot({ path: `${OUT}/31-feed-playing.png` });

  await press(page, "Select");
  await page.getByTestId("play-in-feed").first().waitFor({ timeout: 5000 });
  check("SELECT ejects the in-feed game", true);

  // 3. Shoulder buttons: R1 next tab, L1 previous.
  await press(page, "R1");
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });
  check("R1 switches to the next tab", true);
  await press(page, "L1");
  await page.getByTestId("home-feed").waitFor({ timeout: 8000 });
  check("L1 switches back", true);

  // 4. Settings: swap + custom colors.
  await press(page, "Start");
  await page.getByTestId("settings-screen").waitFor({ timeout: 5000 });
  await page.getByRole("radio", { name: "BOTH" }).click();
  await page.getByRole("button", { name: "⇄ SWAP D-PAD / JOYSTICK" }).click();
  const swapped = await page.evaluate(() => document.querySelector(".hh-system .hh-dpad-compact") !== null);
  check("swap puts the D-pad in the system row (joystick main)", swapped);
  await page.screenshot({ path: `${OUT}/32-swapped-both.png` });

  await page.getByLabel("A button color").fill("#ff0000");
  await page.getByLabel("D-pad color").fill("#00ff88");
  const styleVars = await page.evaluate(() => {
    const root = document.querySelector(".hh-root");
    return {
      face: root?.style.getPropertyValue("--hh-face-a-hi"),
      dpad: root?.style.getPropertyValue("--hh-dpad-a"),
    };
  });
  check("custom colors apply as live CSS variables", styleVars.face === "#ff0000" && styleVars.dpad === "#00ff88", JSON.stringify(styleVars));
  await page.screenshot({ path: `${OUT}/33-custom-colors.png` });

  // Neon differs from four-color now (on the default theme they were close;
  // on arcade they were identical — the snes block pins them apart).
  // Custom colors are inline overrides that outrank both presets, so clear
  // them first or the probe reads the custom value twice.
  await page.getByRole("button", { name: "RESET CUSTOM COLORS" }).click();
  await page.getByRole("radio", { name: "ARCADE SHELL" }).click();
  await page.getByRole("radio", { name: "FOUR-COLOR" }).click();
  const fourColor = await page.evaluate(
    () => getComputedStyle(document.querySelector(".hh-root")).getPropertyValue("--hh-face-x-hi").trim(),
  );
  await page.getByRole("radio", { name: "NEON" }).click();
  const neon = await page.evaluate(
    () => getComputedStyle(document.querySelector(".hh-root")).getPropertyValue("--hh-face-x-hi").trim(),
  );
  check("four-color and neon are distinct on the arcade theme", fourColor !== neon, `${fourColor} vs ${neon}`);

  // Reset for future runs.
  await page.getByRole("button", { name: "RESET CUSTOM COLORS" }).click();
  await page.getByRole("radio", { name: "INDIGO WORKBENCH" }).click();
  await page.getByRole("radio", { name: "D-PAD", exact: true }).click();
  await page.getByRole("radio", { name: "FOUR-COLOR" }).click();
  await page.getByRole("button", { name: "⇄ SWAPPED" }).click();
  await page.getByRole("button", { name: "DONE" }).click();

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
