/**
 * The editor's layout on a tablet, end to end (TABLET_EDITOR_ROADMAP.md T4):
 * an emulated iPad (touch, coarse pointer, 2× pixels) in landscape and
 * portrait, and a phone for contrast.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-editor-tablet-layout.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";
const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };
/** iOS Safari's largest canvas, in pixels. */
const CANVAS_LIMIT = 16_777_216;

async function open(width, height, path = "/edit/new?model=xbox360&starter=lockout") {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/supabase/i.test(e.message)) console.log("pageerror", e.message); });
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 600000 });
  await page.waitForTimeout(8000);
  const start = page.getByRole("button", { name: "Start creating" });
  if (await start.count()) await start.tap();
  await page.waitForTimeout(2000);
  return { ctx, page };
}
const tab = async (page, name) => {
  if (name === "Mesh") {
    await page.getByRole("button", { name: /More/ }).first().tap();
    await page.getByText(/^.?Mesh$/).first().tap();
  } else await page.getByRole("button", { name: new RegExp(`${name}$`) }).first().tap();
  await page.waitForTimeout(4000);
};
/** Controls under 44 px (packed picker cells, segments in their 44 px track and controls on a gesture surface aside). */
const smallTargets = (page) => page.evaluate(() => {
  const small = [];
  for (const el of document.querySelectorAll("button, select, input")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
    if (/swatch|tileCell/.test(el.className) || el.closest("[data-tablet-gestures]")) continue;
    if (el.tagName === "INPUT" && /checkbox|radio/.test(el.type)) continue;
    const min = /segment/.test(el.className) ? 38 : 44;
    if (r.height < min - 0.5) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return small;
});

// --- iPad landscape. ---
{
  const { ctx, page } = await open(1180, 820);
  check("landscape: the pointer is coarse", await page.evaluate(() => matchMedia("(pointer: coarse)").matches));
  for (const name of ["Assets", "Map", "Mesh"]) {
    if (name !== "Assets") await tab(page, name);
    const small = await smallTargets(page);
    check(`landscape ${name}: every control is a 44 px target`, small.length === 0, small.slice(0, 6).join("; "));
  }
  // The Mesh tab's Edit modes wrap in the rail rather than clipping; Paint is tappable.
  await page.getByText("bot 1", { exact: true }).first().tap();
  await page.waitForTimeout(2000);
  const paint = page.getByRole("button", { name: "Paint", exact: true }).first();
  // Inside the rail, and clear of the stage beside it (which paints over anything wider).
  const fits = await paint.evaluate((b) => {
    const r = b.getBoundingClientRect();
    const rail = b.closest("aside").getBoundingClientRect();
    const stage = document.querySelector('canvas[aria-label^="3D mesh preview"]').closest("section").getBoundingClientRect();
    return r.left >= rail.left && r.right <= rail.right + 0.5 && rail.right <= stage.left + 0.5;
  });
  await paint.tap();
  await page.waitForTimeout(1500);
  check("landscape Mesh: the Edit modes fit the rail, and Paint taps", fits && (await paint.getAttribute("aria-pressed")) === "true");
  const canvas = page.locator('canvas[aria-label^="3D mesh preview"]').first();
  // (Chromium has no -webkit-touch-callout to report; Safari reads it from the same rule.)
  const style = await canvas.evaluate((c) => ({ select: getComputedStyle(c).userSelect, touch: getComputedStyle(c).touchAction, marked: c.hasAttribute("data-tablet-gestures") }));
  check("canvases: no text selection, no page gestures, marked as a gesture surface", style.select === "none" && style.touch === "none" && style.marked, JSON.stringify(style));
  await page.screenshot({ path: `${OUT}/tablet-layout-mesh.png` });
  await ctx.close();
}

// --- The sprite selection's keys, as buttons. ---
{
  const { ctx, page } = await open(1180, 820, "/edit/new?model=xbox360");
  const canvas = page.locator('canvas[aria-label^="Sprite "]').first();
  await page.getByRole("button", { name: /Select$/ }).first().tap();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.45, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  const pixels = () => canvas.evaluate((c) => c.toDataURL());
  const before = await pixels();
  await page.getByRole("button", { name: "Flip horizontally" }).tap();
  await page.waitForTimeout(500);
  const flipped = (await pixels()) !== before;
  await page.getByRole("button", { name: "Copy", exact: true }).tap();
  const paste = await page.getByRole("button", { name: "Paste", exact: true }).isVisible();
  check("sprites: the selection's keys are buttons (flip changes the art; Copy offers Paste)", flipped && paste, `flipped ${flipped}, paste ${paste}`);
  await ctx.close();
}

// --- iPad portrait, and the map at every zoom. ---
{
  const { ctx, page } = await open(820, 1180);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check("portrait: nothing runs off the side", overflow <= 0, `${overflow} px over`);
  await tab(page, "Map");
  const canvas = page.locator('canvas[aria-label^="Map, "]').first();
  const sizes = [];
  let drawn = true;
  for (const zoom of ["S", "M", "L", "XL"]) {
    await page.getByRole("button", { name: zoom, exact: true }).first().tap();
    await page.waitForTimeout(1500);
    // Into the middle of the map, where a whole-map canvas used to draw nothing.
    await canvas.evaluate((c) => {
      const v = c.parentElement.parentElement;
      v.scrollTo(v.scrollWidth / 2, v.scrollHeight / 2);
      c.parentElement.parentElement.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(800);
    const s = await canvas.evaluate((c) => {
      const r = c.getBoundingClientRect();
      const x = Math.max(0, -r.left), y = Math.max(0, -r.top);
      const d = c.getContext("2d").getImageData(x, y, Math.min(200, c.width - x), Math.min(200, c.height - y)).data;
      const colours = new Set();
      for (let i = 0; i < d.length; i += 4) colours.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      return { area: c.width * c.height, colours: colours.size };
    });
    sizes.push(`${zoom} ${(s.area / 1e6).toFixed(1)}M px, ${s.colours} colours`);
    if (s.area > CANVAS_LIMIT || s.colours < 2) drawn = false;
  }
  check("portrait Map: the canvas fits iOS's limit and draws at every zoom", drawn, sizes.join("; "));
  await tab(page, "Mesh");
  const preview = page.locator('canvas[aria-label^="3D mesh preview"]').first();
  const top = (await preview.count()) ? (await preview.boundingBox())?.y ?? Infinity : Infinity;
  check("portrait Mesh: the 3D viewport opens, first on the page", top < 1180 && !(await page.getByText(/needs a larger screen/).isVisible()), `viewport top ${Math.round(top)} px`);
  await page.screenshot({ path: `${OUT}/tablet-layout-portrait.png` });
  await ctx.close();
}

// --- A phone still gets the notice for the 3D tabs. ---
{
  const { ctx, page } = await open(390, 844);
  await tab(page, "Mesh");
  check("phone: the 3D tabs say they need a larger screen", await page.getByText(/needs a larger screen/).isVisible());
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
