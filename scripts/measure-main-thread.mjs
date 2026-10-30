// Main-thread renderer time on Beaver Creek in Chromium (F0e's exit): the
// player's own profile of its 3D section while the game plays, at each view.
import { chromium } from "playwright";

const [BASE = "http://localhost:3100", SECONDS = "20", QUERY = "&hdr=1&dynres=0"] = process.argv.slice(2);
const VIEWS = [
  { name: "overview", yaw: 0.5, pitch: 0.55, distance: 55, target: [0, 0, 0], fov: 1.0 },
  { name: "creek", yaw: 1.57, pitch: 0.15, distance: 12, target: [0, 1, 0], fov: 1.0 },
  { name: "base", yaw: -0.4, pitch: 0.2, distance: 14, target: [-25, 1.5, 0], fov: 1.0 },
];
// As capture-aaa.mjs launches it: SwiftShader unless CBX_GPU=1. SwiftShader runs in the GPU process, so the main
// thread's time here is the page's own; only the GPU's is a software floor.
const device = process.env.CBX_GPU
  ? ["--ignore-gpu-blocklist"]
  : ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH === "/opt/pw-browsers" ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
  args: ["--enable-unsafe-webgpu", ...device, "--enable-dawn-features=allow_unsafe_apis", "--enable-webgpu-developer-features", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on("console", (m) => { if (m.type() === "error") console.log("console:", m.text().slice(0, 200)); });
await page.goto(`${BASE}/lockout?map=beaver&capture=1${QUERY}`, { waitUntil: "networkidle", timeout: 600000 });
await page.getByRole("button", { name: "Play", exact: true }).click({ timeout: 300000 });
await page.waitForFunction(() => window.cartboxPlayer, null, { timeout: 600000 });
await page.evaluate(() => window.cartboxPlayer.setProfiling(true));
// The title, then a match of the highlighted game type once its intro has run (as capture-aaa.mjs starts one).
await page.waitForTimeout(20000);
const press = async (key) => { await page.keyboard.down(key); await page.waitForTimeout(150); await page.keyboard.up(key); };
await page.mouse.click(640, 400);
await press("z");
await page.waitForTimeout(15000);
await press("z");
await page.waitForTimeout(15000);
for (const view of VIEWS) {
  await page.evaluate((v) => window.cartboxPlayer.setEditorCamera({ yaw: v.yaw, pitch: v.pitch, distance: v.distance, target: v.target, fov: v.fov, hud: false }), view);
  await page.waitForTimeout(3000);
  // The profile covers the last second or so; on a software GPU a frame can take longer, so each sample is read
  // just after a frame lands.
  const samples = [];
  for (let s = 0; s < Number(SECONDS); s += 1) {
    const from = await page.evaluate(() => window.cartboxPlayer.frame());
    await page.waitForFunction((to) => window.cartboxPlayer.frame() > to, from, { timeout: 600000, polling: 50 });
    const p = await page.evaluate(() => window.cartboxPlayer.profile());
    if (p && p.frames > 0) samples.push(p);
  }
  const mean = (pick) => { const v = samples.map(pick).filter((x) => Number.isFinite(x)); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
  console.log(JSON.stringify({ view: view.name, samples: samples.length, render: mean((p) => p.sections.render.avg), scene: mean((p) => p.sections.scene.avg), shadow: mean((p) => p.sections.shadow.avg), sky: mean((p) => p.sections.sky.avg), cart: mean((p) => p.sections.cart.avg), total: mean((p) => p.total.avg), gpuMs: mean((p) => p.render?.gpuMs) }));
}
await browser.close();
