// Capture an arena map as it plays (EDITOR_PRO_ROADMAP.md P9): the title,
// a frame of the intro fly-over, then five views turning on the spot after
// it, from a running web app. For side-by-side looks before and after an
// art pass. Software GL (SwiftShader) is slow, so frames take a while.
//
// Run the web app first (NEXT_PUBLIC_SUPABASE_URL and _ANON_KEY can be
// dummies), then:
//   node scripts/capture-map.mjs <out dir> <tag> [map id] [base url]
// e.g. node scripts/capture-map.mjs shots after beaver http://localhost:3100

import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [OUT = "shots", TAG = "map", MAP = "beaver", BASE = "http://localhost:3000"] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const shot = (name) => page.screenshot({ path: `${OUT}/${TAG}-${name}.png`, timeout: 240000 });
const press = async (key, ms) => {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
};

const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH === "/opt/pw-browsers" ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(`${BASE}/lockout?map=${MAP}`, { waitUntil: "networkidle", timeout: 300000 });
await page.getByRole("button", { name: "Play", exact: true }).click({ timeout: 180000 });
await page.waitForTimeout(20000);
await shot("title");
// Start the highlighted game type, catch the intro, then let it run out.
await page.mouse.click(640, 400);
await press("z", 200);
await page.waitForTimeout(6000);
await shot("intro");
await page.waitForTimeout(90000);
for (let i = 0; i < 5; i += 1) {
  await shot(`view${i}`);
  await press("ArrowLeft", 1800);
  await page.waitForTimeout(1500);
}
await browser.close();
