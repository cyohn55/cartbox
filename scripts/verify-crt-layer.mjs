// Focused check: the CRT shader sits between the game preview art and the
// cartridge front on the Browse grid cards.
//
// Run like verify-console.mjs (Windows Chrome over CDP, Windows Node):
//   chrome.exe --headless=new --remote-debugging-port=9222 --user-data-dir=C:\Temp\cbx-playwright about:blank
//   node scripts/verify-crt-layer.mjs

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-verify";
mkdirSync(OUT, { recursive: true });

async function pressShellButton(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  await button.dispatchEvent("pointerdown", { pointerId: 1 });
  await button.dispatchEvent("pointerup", { pointerId: 1 });
}

const browser = await chromium.connectOverCDP(CDP);
let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

try {
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  const page = await phone.newPage();
  await page.goto(BASE + "/console", { waitUntil: "domcontentloaded" });
  await page.getByTestId("title-screen").waitFor({ timeout: 10000 });
  await pressShellButton(page, "Start");
  await page.getByTestId("auth-screen").waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Continue as guest" }).click();
  await page.getByTestId("home-feed").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "BROWSE" }).click();
  await page.getByTestId("browse-screen").waitFor({ timeout: 8000 });

  // Switch to the TIC-80 archive: every entry ships a real cover image, so the
  // shader is seen landing on actual art rather than the ▦ empty placeholder
  // (the Cartbox catalog's local carts have no cover set).
  await page.getByRole("tab", { name: "TIC-80 ARCADE" }).click();
  await page.locator(".os-cart-crt").first().waitFor({ timeout: 12000 });

  // The CRT film must land exactly on the preview-art screen and paint above
  // it (later in DOM, same stacking level), and never intercept pointers.
  // Wait for a card whose cover image has actually decoded, so the assertions
  // and the screenshot both land on rendered art.
  const artCardIndex = await page
    .locator(".os-cart-card")
    .evaluateAll((cards) =>
      cards.findIndex((c) => {
        const img = c.querySelector("img.os-cart-label");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
      }),
    );
  if (artCardIndex < 0) {
    // Give lazy covers a beat to decode, then retry once.
    await page.waitForTimeout(2500);
  }
  const resolvedIndex = await page
    .locator(".os-cart-card")
    .evaluateAll((cards) =>
      cards.findIndex((c) => {
        const img = c.querySelector("img.os-cart-label");
        return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
      }),
    );
  check("a card with a decoded cover image is present", resolvedIndex >= 0,
    `index=${resolvedIndex}`);
  const card = page.locator(".os-cart-card").nth(resolvedIndex >= 0 ? resolvedIndex : 0);

  const geom = await card.evaluate((card) => {
    const label = card.querySelector(".os-cart-label");
    const crt = card.querySelector(".os-cart-crt");
    const shell = card.querySelector(".os-cart-shell-img");
    const r = (el) => (el ? el.getBoundingClientRect() : null);
    const cs = getComputedStyle(crt);
    // Both label and CRT are absolute with no z-index: later-in-DOM paints on
    // top. So the CRT following the label == the shader sits in front of the
    // game art. (elementFromPoint can't confirm this — pointer-events:none
    // makes the CRT invisible to hit-testing by design.)
    const crtAfterLabel =
      label && crt ? (label.compareDocumentPosition(crt) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 : false;
    return {
      hasAll: !!(label && crt && shell),
      labelIsImg: label?.tagName === "IMG",
      label: r(label),
      crt: r(crt),
      crtZ: cs.zIndex,
      labelZ: label ? getComputedStyle(label).zIndex : null,
      pointerEvents: cs.pointerEvents,
      blend: cs.mixBlendMode,
      crtAfterLabel,
    };
  });

  check("card has shell + preview art + CRT layers", geom.hasAll);
  const aligned =
    Math.abs(geom.crt.left - geom.label.left) < 1.5 &&
    Math.abs(geom.crt.top - geom.label.top) < 1.5 &&
    Math.abs(geom.crt.width - geom.label.width) < 1.5;
  check("CRT film aligns with the preview-art screen", aligned,
    `label ${geom.label.width.toFixed(0)}px vs crt ${geom.crt.width.toFixed(0)}px`);
  // In front of the art, behind the outer shell surface (equal z-index, later DOM).
  check("CRT sits between the preview art and the shell front", geom.crtAfterLabel && geom.crtZ === geom.labelZ,
    `crt z=${geom.crtZ} label z=${geom.labelZ} crtAfterLabel=${geom.crtAfterLabel}`);
  check("CRT never intercepts pointers", geom.pointerEvents === "none", geom.pointerEvents);
  check("CRT blends onto the art", geom.blend === "soft-light", geom.blend);

  // Zoom in on the chosen card for a visual record.
  await card.locator(".os-cart-shell").screenshot({ path: `${OUT}/crt-cartridge.png` });
  console.log(`\nscreenshot -> ${OUT}\\crt-cartridge.png`);
  await phone.close();
} finally {
  await browser.close();
}

console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed > 0 ? 1 : 0);
