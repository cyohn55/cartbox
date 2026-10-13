/**
 * Level design in the editor, end to end (ENGINE_PARITY_ROADMAP.md Phase F):
 * Beaver Creek opens on its scene with its markup as actors; Show →
 * Collision and Navigation draw; an actor picked in the outliner shows its
 * Details; a spawn placed with Place Actors appears; Map Check runs; Build
 * rewrites the cart's map lines; a camera bookmark is kept and recalled.
 * Screenshots go to CBX_OUT.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-level-design.mjs
 *
 * Needs a dev server (NEXT_PUBLIC_STATIC_EXPORT=1 runs one with no services)
 * and Playwright's Chromium. Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => {
  if (!/supabase/i.test(e.message)) errors.push(e.message);
});
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

await page.goto(`${BASE}/edit/new?model=xbox360&starter=beaver`, { waitUntil: "load", timeout: 600000 });
await page.getByRole("button", { name: "Start creating" }).click({ timeout: 300000 });
await page.getByRole("button", { name: /More/ }).first().click();
await page.getByText(/^.?Mesh$/).first().click();

const tree = page.getByRole("tree", { name: "Gameplay actors" });
await tree.waitFor({ timeout: 300000 });
const rows = () => tree.getByRole("treeitem", { includeHidden: true }).count();
check("Beaver Creek opens with its markup as actors", (await rows()) > 100, `${await rows()} actors`);
const canvas = page.getByRole("img", { name: /3D scene/ });
check("…on its whole scene", await canvas.isVisible());
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/level-gameplay.png` });

await page.getByRole("checkbox", { name: "Show collision" }).check();
await page.getByRole("checkbox", { name: "Show navigation" }).check();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/level-collision-nav.png` });
check("Show → Collision and Navigation turn on", (await page.getByRole("checkbox", { name: "Show collision" }).isChecked()) && (await page.getByRole("checkbox", { name: "Show navigation" }).isChecked()));
await page.getByRole("checkbox", { name: "Show collision" }).uncheck();
await page.getByRole("checkbox", { name: "Show navigation" }).uncheck();

// Pick the first teleporter in the outliner: its Details show its facing.
await tree.getByRole("treeitem", { name: "Teleporter 1", exact: true }).click();
check("an actor picked in the outliner shows its Details", await page.getByRole("spinbutton", { name: /Degrees/ }).isVisible());
check("…and stays selected", (await tree.getByRole("treeitem", { name: "Teleporter 1", exact: true, selected: true }).count()) === 1);
await page.getByRole("checkbox", { name: "Show labels" }).check();
await canvas.focus();
await page.keyboard.press("w");
await page.keyboard.press("f");
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/level-teleporter.png` });

// Drag the gizmo's centre: the teleporter moves, and Undo puts it back.
const feetX = () => page.getByRole("spinbutton", { name: "X", exact: true }).first().inputValue();
const x0 = await feetX();
const dbg = await page.evaluate(() => globalThis.gizmoDebug);
const box = await canvas.boundingBox();
const k = box.width / (await canvas.evaluate((c) => c.width));
const [ox, oy] = [box.x + dbg[2][0] * k, box.y + dbg[2][1] * k];
await page.mouse.move(ox, oy);
await page.mouse.down();
await page.mouse.move(ox + 40, oy + 10, { steps: 5 });
await page.mouse.move(ox + 90, oy + 20, { steps: 5 });
await page.mouse.up();
const x1 = await feetX();
check("dragging the gizmo moves the teleporter", x1 !== x0, `x ${x0} → ${x1}`);
await page.getByRole("button", { name: "Undo", exact: true }).first().click();
await page.waitForTimeout(500);
check("…and Undo puts it back", (await feetX()) === x0, `x ${await feetX()}`);

// Place a red spawn where the view looks.
const before = await rows();
await page.getByRole("button", { name: "+ Red spawn" }).click();
check("Place Actors adds a red spawn, selected", (await rows()) === before + 1 && (await tree.getByRole("treeitem", { name: /\(red\)/, selected: true }).count()) === 1);

// Map Check: the new spawn may stand anywhere; the list (or "no problems") shows.
await page.getByRole("button", { name: "Map Check" }).click();
const report = page.getByRole("list", { name: "Map Check" });
check("Map Check reports", await report.waitFor({ timeout: 60000 }).then(() => true, () => false));

// Build: the code's map lines follow the new spawn.
await page.getByRole("button", { name: "Build", exact: true }).click();
check("Build rewrites the map lines", await page.getByText(/Rewrote \d+ map line/).waitFor({ timeout: 120000 }).then(() => true, () => false));

// A camera bookmark: keep the view in slot 2, look elsewhere, come back.
await canvas.focus();
await page.keyboard.press("Shift+Digit2");
check("Shift+2 keeps a view", (await page.getByTitle(/Camera bookmarks/).innerText()).includes("2"));
await page.keyboard.press("Home");
await page.keyboard.press("Digit2");
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/level-final.png` });

// Save (the static build keeps it in this browser), then play it in the demo.
await page.getByRole("button", { name: "⋯" }).or(page.getByRole("button", { name: /More actions|Menu/ })).first().click();
await page.getByRole("menuitem", { name: /^Save/ }).or(page.getByRole("button", { name: /^Save/ })).first().click();
await page.waitForTimeout(4000);
const drafts = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("cartbox.demo.cart.")));
const cart = drafts[0]?.slice("cartbox.demo.cart.".length);
check("the edited map saves in this browser", !!cart, drafts.join(", "));
await page.goto(`${BASE}/lockout?map=beaver&assets=${encodeURIComponent(cart ?? "none")}`, { waitUntil: "load", timeout: 600000 });
check(
  "the demo plays the saved cart's edited Beaver Creek markup",
  await page.getByText(/Playing the saved cart's edited Beaver Creek markup/).waitFor({ timeout: 300000 }).then(() => true, () => false),
);
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.waitForTimeout(20000);
await page.screenshot({ path: `${OUT}/level-demo.png` });
check(
  "…and the game starts on it, with public matchmaking off",
  (await page.getByText("Matchmaking unavailable").isVisible()) && !(await page.locator("p[role=alert]").isVisible().catch(() => false)),
);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length > 0 ? 1 : 0);
