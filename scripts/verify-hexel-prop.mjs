// Verifies hexels can be published as backdrop props end-to-end: open the Voxel
// editor, switch the cell shape to Hex, confirm the Shape tool and axis-scale are
// available (no longer cube-only), publish the sculpt as a backdrop prop, then
// load the /backdrop manager and confirm the hexel prop appears and renders.
//
// WSL dev setup (see verify-console.mjs): Windows Chrome headless + CDP, run with
// Windows Node:  node scripts/verify-hexel-prop.mjs

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const OUT = process.env.CBX_SHOT_DIR ?? "C:\\Temp\\cbx-hexel";
mkdirSync(OUT, { recursive: true });
const shot = (name) => `${OUT}/${name}.png`;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

const PROP_NAME = "Hexel Test Prop";
const browser = await chromium.connectOverCDP(CDP);
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // Accept the shape-switch confirm and answer the "name this prop" prompt.
  page.on("dialog", (dialog) => dialog.accept(dialog.type() === "prompt" ? PROP_NAME : undefined));

  await page.goto(BASE + "/edit/new", { waitUntil: "domcontentloaded" });
  await page.waitForURL("**/edit/**", { timeout: 15000 });
  // Start from a clean working set so only this run's prop is asserted.
  await page.evaluate(() => localStorage.removeItem("cartbox.backdrop.working"));
  // Open the Voxel tab.
  await page.getByRole("button", { name: "Voxel", exact: true }).click();
  const hex = page.getByRole("button", { name: "Hex", exact: true });
  await hex.waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);

  // Switch to hexels and confirm it took before doing anything shape-dependent.
  await hex.click();
  await page.waitForTimeout(600);
  check("Hex cell shape selected", (await hex.getAttribute("aria-pressed")) === "true");

  // The Shape tool and axis-scale are now offered for hexels.
  check("Shape tool available in hexel mode", await page.getByRole("button", { name: "Shape", exact: true }).isVisible().catch(() => false));
  check("Scale-axis panel available in hexel mode", await page.getByText("Scale axis").isVisible().catch(() => false));

  // Publish is enabled (no "not supported" note).
  const publishBtn = page.getByRole("button", { name: /Publish as prop|Update prop/ });
  const disabled = await publishBtn.isDisabled().catch(() => true);
  const notSupported = await page.getByText(/aren.t supported as backdrop props/).isVisible().catch(() => false);
  check("Publish enabled for hexels", !disabled && !notSupported);
  await page.screenshot({ path: shot("01-editor-hexel") });

  // Publish the hexel sculpt as a backdrop prop.
  await publishBtn.scrollIntoViewIfNeeded();
  await publishBtn.click();
  await page.waitForTimeout(1200);
  const published = await page.getByText(/Published/).count();
  check("hexel sculpt published to the scene", published > 0);

  // The working set is saved to localStorage; read it back and confirm the newly
  // published prop carries a hexel-shaped voxel payload (shape:"hexel" in the JSON).
  const storedHexel = await page.evaluate((name) => {
    const raw = localStorage.getItem("cartbox.backdrop.working");
    if (!raw) return false;
    const prop = JSON.parse(raw).props.find((p) => p.name === name);
    if (!prop || !prop.voxel) return false;
    try {
      return JSON.parse(prop.voxel).shape === "hexel";
    } catch {
      return false;
    }
  }, PROP_NAME);
  check("published prop stores a hexel voxel payload", storedHexel);

  // Load the backdrop manager (same context → same localStorage working set) and
  // confirm the hexel prop is listed and its preview renders without error.
  await page.goto(BASE + "/backdrop", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  // The manager shows each prop's name in an editable input, so match on value.
  const propListed = await page.locator(`input[value="${PROP_NAME}"]`).count();
  check("hexel prop listed in the backdrop manager", propListed > 0);
  const canvases = await page.locator("canvas").count();
  check("backdrop manager rendered prop canvases", canvases > 0, `${canvases} canvases`);
  await page.screenshot({ path: shot("02-backdrop-manager"), fullPage: true });

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  await context.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
