// How long pressing Play holds the main thread (DEMO_QUALITY_ROADMAP.md R2):
// opens /lockout?map=<map>, leaves the lobby open a while (as a player reading
// it would, and as the sidecar's worker needs), presses Play, and records every
// long task (over 50 ms) from the click until the game mounts.
//
// Run the web app first (NEXT_PUBLIC_SUPABASE_URL and _ANON_KEY can be
// dummies), then:
//   node scripts/measure-play.mjs [base url] [map] [lobby ms] [runs]
// e.g. node scripts/measure-play.mjs http://localhost:3100 beaver 8000 3
// On a machine with a real GPU, CBX_GPU=1 launches Chromium on it instead of
// SwiftShader. Prints one JSON line a run: the time to mount, the longest task
// and the total blocked.

import { chromium } from "playwright";

const [BASE = "http://localhost:3000", MAP = "beaver", LOBBY = "8000", RUNS = "1"] = process.argv.slice(2);

function launch() {
  const device = process.env.CBX_GPU
    ? ["--ignore-gpu-blocklist"]
    : ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  return chromium.launch({
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH === "/opt/pw-browsers" ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
    args: ["--enable-unsafe-webgpu", ...device],
  });
}

for (let run = 0; run < Number(RUNS); run += 1) {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  // ?capture=1 hands the page's player to the script (window.cartboxPlayer) once it mounts.
  await page.goto(`${BASE}/lockout?map=${MAP}&capture=1`, { waitUntil: "networkidle", timeout: 300000 });
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.waitFor({ timeout: 180000 });
  await page.waitForTimeout(Number(LOBBY));
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: "longtask", buffered: false });
    window.__clicked = performance.now();
  });
  await play.click();
  await page.waitForFunction(() => window.cartboxPlayer, null, { timeout: 300000, polling: 50 });
  const result = await page.evaluate(() => {
    const tasks = window.__long.filter((t) => t.start >= window.__clicked);
    return {
      toMountMs: Math.round(performance.now() - window.__clicked),
      longestMs: Math.round(Math.max(0, ...tasks.map((t) => t.ms))),
      blockedMs: Math.round(tasks.reduce((s, t) => s + t.ms, 0)),
      tasks: tasks.length,
    };
  });
  console.log(JSON.stringify({ map: MAP, device: process.env.CBX_GPU ? "hardware" : "swiftshader", ...result }));
  await browser.close();
}
