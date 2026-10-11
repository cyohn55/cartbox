/**
 * The Start menu's controller settings, end to end (CONTROLLER_SETTINGS_ROADMAP.md
 * C1): Lockout with a fake standard-mapping controller, the Controls tab's live
 * stick picture reading it, the stick layout and a dead zone changed from the
 * menu, what the game receives following them, and the settings kept; and
 * (C2) sensitivity reaching Lockout as a turn speed, not a pre-scaled stick.
 *
 *   CBX_BASE_URL=http://localhost:3000 node scripts/verify-controller-settings.mjs
 *
 * Needs a dev server (with any Supabase URL/key) and Playwright's Chromium
 * (CBX_CHROMIUM to point at another). Exits non-zero if a check fails.
 */
import { tmpdir } from "node:os";
import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const OUT = process.env.CBX_OUT ?? tmpdir();
const browser = await chromium.launch({ ...(process.env.CBX_CHROMIUM ? { executablePath: process.env.CBX_CHROMIUM } : {}), args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => { if (!/supabase/i.test(e.message)) console.log("pageerror", e.message); });
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

// A controller the page sees through the Gamepad API, its sticks and triggers set from the test.
await page.addInitScript(() => {
  const pad = {
    id: "Fake controller (STANDARD GAMEPAD)",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  window.__pad = pad;
  window.__setPad = (axes, lt = 0, rt = 0) => {
    pad.axes = axes;
    pad.buttons[6] = { pressed: lt > 0.5, touched: lt > 0, value: lt };
    pad.buttons[7] = { pressed: rt > 0.5, touched: rt > 0, value: rt };
    pad.timestamp += 1;
  };
  navigator.getGamepads = () => [pad, null, null, null];
});
const setPad = (axes, lt, rt) => page.evaluate(([a, l, r]) => window.__setPad(a, l, r), [axes, lt, rt]);
const receives = async () => (await page.getByText(/The game receives/).textContent()).replace(/\s+/g, " ").trim();
/** Wait (the game renders in software here, so frames are slow) until the line matches. */
async function receivesUntil(pattern, ms = 15000) {
  const end = Date.now() + ms;
  let line = "";
  while (Date.now() < end) {
    line = await receives().catch(() => "");
    if (pattern.test(line)) break;
    await page.waitForTimeout(150);
  }
  return line;
}
const count = async (locator, want, ms = 15000) => {
  const end = Date.now() + ms;
  let n = 0;
  while (Date.now() < end && (n = await locator.count()) !== want) await page.waitForTimeout(150);
  return n;
};

await page.goto(`${BASE}/lockout`, { waitUntil: "load", timeout: 600000 });
await page.evaluate(() => localStorage.removeItem("cartbox:settings:lockout"));
await page.reload({ waitUntil: "load" });
await page.getByRole("button", { name: "Play", exact: true }).click();
await page.getByRole("button", { name: "Menu" }).waitFor({ timeout: 120000 });
await page.getByRole("button", { name: "Menu" }).click();
await page.getByRole("dialog", { name: "Start menu" }).waitFor();

for (const label of ["Horizontal sensitivity", "Vertical sensitivity", "Response curve", "Invert look left/right", "Zoom sensitivity", "Look acceleration", "Stick layout", "Left stick dead zone", "Right stick axial dead zone", "Right stick max input", "LT presses at"]) {
  check(`the Controls tab has ${label}`, (await page.getByText(new RegExp(`^${label}`)).count()) > 0);
}

// Left stick 0.55 right, right stick nearly straight up with a little drift; LT pulled 30%.
await setPad([0.55, 0, 0.1, -0.9], 0.3, 0);
let line = await receivesUntil(/move 0\.45, 0\.00 · look 0\.10, −0\.88/);
check("the preview shows what the game receives (default layout)", /move 0\.45, 0\.00 · look 0\.10, −0\.88/.test(line), line);
check("LT at 30% is short of its 50% pull", (await count(page.getByRole("img", { name: "LT: pulled 30%, presses at 50%" }), 1)) === 1);

// Southpaw swaps them.
await page.getByLabel("Stick layout").selectOption("southpaw");
line = await receivesUntil(/move 0\.10, −0\.88 · look 0\.45, 0\.00/);
check("southpaw: the right stick moves and the left looks", /move 0\.10, −0\.88 · look 0\.45, 0\.00/.test(line), line);

// An axial dead zone on the right stick drops its sideways drift.
await page.getByLabel("Stick layout").selectOption("default");
const axial = page.getByRole("slider", { name: "Right stick axial dead zone" });
await axial.fill("0.15");
line = await receivesUntil(/look 0\.00, −0\.8\d/);
check("a right-stick axial dead zone keeps a push straight up straight", /look 0\.00, −0\.8\d/.test(line), line);
check("the axial dead zone draws on the right stick", (await count(page.locator('svg[aria-label="Right stick: dead zones and position"] rect'), 2)) === 2);

// Lockout reads its look gain (C2): sensitivity becomes a turn speed, and the stick stays as leaned.
await page.getByRole("slider", { name: "Horizontal sensitivity" }).fill("2");
line = await receivesUntil(/×2\.00 turn/);
check("sensitivity reaches Lockout as a turn speed, the stick unscaled", /look 0\.00, −0\.8\d at ×2\.00 turn, ×1\.00 pitch/.test(line), line);

// A lighter trigger pull presses LT at 30%.
const lt = page.getByRole("slider", { name: "LT presses at" });
await lt.fill("0.25");
check("LT presses at a 25% pull", (await count(page.getByText(/^LT pressed/), 1)) === 1);
await page.screenshot({ path: `${OUT}/controller-settings.png` });

const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("cartbox:settings:lockout") ?? "{}").controls ?? {});
check(
  "the settings are kept",
  saved.rightStick?.axial === 0.15 && saved.leftTrigger === 0.25 && saved.stickLayout === "default" && saved.lookSensitivity === 2,
  JSON.stringify({ rightStick: saved.rightStick, leftTrigger: saved.leftTrigger, lookSensitivity: saved.lookSensitivity }),
);

// Touch has its own tab.
await page.getByRole("tab", { name: "Touch" }).click();
check("the Touch tab holds the on-screen pad's size and opacity", (await page.getByText(/^Touch controls size/).count()) === 1 && (await page.getByText(/^Touch controls opacity/).count()) === 1);

// Reset puts back the look, sticks and triggers.
await page.getByRole("tab", { name: "Controls" }).click();
await page.getByRole("button", { name: /Reset look, sticks/ }).click();
line = await receivesUntil(/look 0\.10, −0\.88 at ×1\.00 turn/);
check("reset puts the defaults back", /look 0\.10, −0\.88 at ×1\.00 turn/.test(line), line);

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed; screenshot in ${OUT}`);
process.exit(failed ? 1 : 0);
