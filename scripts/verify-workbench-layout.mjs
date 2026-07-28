/**
 * Browser check for the workbench's cross-tab layout parity.
 *
 * The unit tests pin the ordering function; this drives the real editor in a
 * real browser and reads back what each tab actually renders — which rail groups
 * it shows, in what order, and which side of the screen the palette and the
 * material picker end up on. That is the claim the change is about, and it is
 * not observable from the ordering function alone: a tab could still hand a
 * material picker to the rail slot and pass every unit test.
 *
 * Run against a dev server (see the repo's web-dev-server notes). Per this
 * environment's constraints it connects to a Windows Chrome over CDP rather than
 * launching its own browser.
 *
 *   node scripts/verify-workbench-layout.mjs [baseUrl] [outDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "playwright";

const BASE_URL = process.argv[2] ?? "http://127.0.0.1:3000";
const OUT_DIR = process.argv[3] ?? "./workbench-shots";
const CDP_URL = process.env.CDP_URL ?? "http://127.0.0.1:9222";

/** Read the rail's group headings and the inspector's panel titles, in DOM order. */
const READ_LAYOUT = `(() => {
  const text = (node) => (node.textContent || "").trim();
  const rail = document.querySelector('[class*="rail"]');
  const inspector = document.querySelector('[class*="inspector"]');
  const headings = (root, selector) =>
    root ? Array.from(root.querySelectorAll(selector)).map(text).filter(Boolean) : null;
  return {
    rail: headings(rail, '[class*="groupLabel"]'),
    inspector: headings(inspector, '[class*="panelTitle"]'),
    // Where each of the two contested pickers actually landed.
    paletteSide: side('Palette'),
    materialSide: side('Material'),
  };

  // Where a *picker* by this name lives. Rail group labels count too, because
  // "the material picker moved to the rail" is exactly the regression this
  // guards — but a heading has to name a picker, so a chip grid must follow it.
  function side(title) {
    const headings = Array.from(document.querySelectorAll('[class*="panelTitle"], [class*="groupLabel"]'))
      .filter((node) => text(node) === title)
      // An inspector title sits inside a panelHead row; a rail label is a direct
      // child of its group. Step out to whichever block actually holds the chips.
      .filter((node) => {
        const head = node.closest('[class*="panelHead"]');
        const container = head ? head.parentElement : node.parentElement;
        return Boolean(container && container.querySelector('[class*="paletteGrid"]'));
      });
    if (headings.length === 0) return "absent";
    const sides = new Set(
      headings.map((node) =>
        node.closest('[class*="inspector"]') ? "inspector" : node.closest('[class*="rail"]') ? "rail" : "elsewhere",
      ),
    );
    return sides.size === 1 ? [...sides][0] : "split:" + [...sides].join("+");
  }
})()`;

/** Click a top-level workbench tab and wait for its body to mount. */
async function openTab(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(600);
}

/** Click one of the Assets tab's medium chips (Pixels / Voxels / Hexels). */
async function openMedium(page, name) {
  await page.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(900);
}

const failures = [];

/** Record a failed expectation without aborting the run — one pass, every result. */
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  failures.push(label);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  page.setViewportSize({ width: 1680, height: 1000 });

  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  console.log(`Opening ${BASE_URL}/edit/new`);
  await page.goto(`${BASE_URL}/edit/new`, { waitUntil: "domcontentloaded" });
  // The workbench boots the WASM engine before any tab renders.
  await page.waitForSelector('[class*="tabs"] button', { timeout: 60_000 });
  await page.waitForTimeout(2500);

  const layouts = {};

  // `paints` marks the surfaces that put colour on something, and so must offer
  // a palette. The rest legitimately have neither palette nor material.
  const surfaces = [
    { key: "assets-pixels", paints: true, open: async () => { await openTab(page, "Assets"); await openMedium(page, "Pixels"); } },
    { key: "assets-voxels", paints: true, open: async () => { await openMedium(page, "Voxels"); } },
    { key: "map", paints: true, open: async () => { await openTab(page, "Map"); } },
    { key: "fx", paints: false, open: async () => { await openTab(page, "FX"); } },
    { key: "sfx", paints: false, open: async () => { await openTab(page, "SFX"); } },
    { key: "music", paints: false, open: async () => { await openTab(page, "Music"); } },
    { key: "code", paints: false, open: async () => { await openTab(page, "Code"); } },
  ];

  for (const surface of surfaces) {
    console.log(`\n${surface.key}`);
    await surface.open();
    const layout = await page.evaluate(READ_LAYOUT);
    layouts[surface.key] = layout;
    console.log(`  rail:      ${JSON.stringify(layout.rail)}`);
    console.log(`  inspector: ${JSON.stringify(layout.inspector)}`);

    // Every tab wears the same three-zone skeleton — this is what the FX tab,
    // which used to be a bespoke two-column layout with no rail at all, gains.
    check(`${surface.key}: has a rail`, Array.isArray(layout.rail) && layout.rail.length > 0);
    check(`${surface.key}: has an inspector`, Array.isArray(layout.inspector) && layout.inspector.length > 0);

    // A tab that paints nothing has no palette and no material, and that is
    // fine; what must never happen again is either one turning up in the rail.
    for (const [name, side] of [
      ["palette", layout.paletteSide],
      ["material", layout.materialSide],
    ]) {
      check(
        `${surface.key}: ${name} is in the inspector, or absent`,
        side === "inspector" || side === "absent",
        `found in the ${side}`,
      );
    }
    if (surface.paints) {
      check(`${surface.key}: paints, so it has a palette`, layout.paletteSide === "inspector", layout.paletteSide);
    }

    await page.screenshot({ path: join(OUT_DIR, `${surface.key}.png`), fullPage: false });
  }

  // The Tool group must precede its options in every tab that has both.
  console.log("\ncross-tab order");
  for (const [key, layout] of Object.entries(layouts)) {
    const rail = layout.rail ?? [];
    const tool = rail.findIndex((label) => /^tool$/i.test(label));
    const brush = rail.findIndex((label) => /^(brush size|tolerance|shape|step)$/i.test(label));
    if (tool >= 0 && brush >= 0) {
      check(`${key}: Tool precedes its options`, tool < brush, `Tool@${tool} vs options@${brush}`);
    }
  }

  // Every tab that shows both puts the palette immediately above the material.
  for (const [key, layout] of Object.entries(layouts)) {
    const panels = layout.inspector ?? [];
    const palette = panels.indexOf("Palette");
    const material = panels.indexOf("Material");
    if (palette >= 0 && material >= 0) {
      check(`${key}: Material sits directly under Palette`, material === palette + 1, JSON.stringify(panels));
    }
  }

  writeFileSync(join(OUT_DIR, "layouts.json"), JSON.stringify(layouts, null, 2));

  if (errors.length > 0) {
    console.log(`\nPage errors (${errors.length}):`);
    for (const error of errors.slice(0, 12)) console.log(`  ${error}`);
  }

  await page.close();
  await browser.close();

  console.log(`\n${failures.length === 0 ? "PASS" : `FAIL — ${failures.length} check(s)`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
