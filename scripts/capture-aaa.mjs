// Before-and-after captures of the arena maps on the AAA tier
// (AAA_FIDELITY_ROADMAP.md F11a): each map from the same fixed views, once as
// it ships on the Xbox 360 tier ("before": its shading, at its 1280x720 frame)
// and once on the AAA tier's path ("after": linear HDR and the rest of
// Milestone A, at the display's own resolution), with the GPU's frame time of
// each view and the render scale dynamic resolution would settle at for it.
//
// Both are GPU-presented frames, read back through the player (?capture=1
// hands it to this script), since a screenshot of a WebGPU canvas can come out
// blank. Each view's frame time is measured with the game playing; its picture
// is taken with the game paused and stepped until the history settles. The
// after captures render at the full native size (?dynres=0); the report says
// what share of it the frame-time budget leaves.
//
// Run the web app first (NEXT_PUBLIC_SUPABASE_URL and _ANON_KEY can be
// dummies), then:
//   node scripts/capture-aaa.mjs <out dir> [maps] [base url] [device scale]
// e.g. node scripts/capture-aaa.mjs /tmp/f11a lockout,beaver http://localhost:3100 1.5
// On a machine with a real GPU, CBX_GPU=1 launches Chromium on it instead of
// SwiftShader (whose frame times are a software floor, not a device class).

import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "playwright";

const [OUT = "captures", MAPS = "lockout,beaver", BASE = "http://localhost:3000", SCALE = "1.5"] = process.argv.slice(2);
const DEVICE_SCALE = Number(SCALE);
const VIEWPORT = { width: 1280, height: 720 };
const BUDGET_MS = 1000 / 60;
mkdirSync(OUT, { recursive: true });

/** Fixed orbits round each map's centre (the player's editor camera): yaw and pitch in radians, distance and target in metres. */
const VIEWS = {
  lockout: [
    { name: "overview", yaw: 0.7, pitch: 0.55, distance: 30, target: [0, 0, 0], fov: 1.0 },
    { name: "walkway", yaw: 2.4, pitch: 0.22, distance: 13, target: [0, 1.5, 0], fov: 1.0 },
    { name: "pit", yaw: -0.6, pitch: 0.45, distance: 7, target: [0, 0, 0], fov: 1.0 },
    { name: "skyline", yaw: 3.7, pitch: 0.06, distance: 15, target: [0, 3, 0], fov: 1.1 },
  ],
  beaver: [
    { name: "overview", yaw: 0.5, pitch: 0.55, distance: 55, target: [0, 0, 0], fov: 1.0 },
    { name: "creek", yaw: 1.57, pitch: 0.15, distance: 12, target: [0, 1, 0], fov: 1.0 },
    { name: "base", yaw: -0.4, pitch: 0.2, distance: 14, target: [-25, 1.5, 0], fov: 1.0 },
  ],
};

// The before frames are presented from the GPU too (?present=gpu): the tier's own shading at its
// 1280x720 frame, which F0a holds to the byte path pixel for pixel, but with no readback to wait on.
// (On software rendering the byte path shows its 3D read back a minute or more behind the scene.)
const TIERS = [
  { tag: "before", query: "&present=gpu" },
  { tag: "after", query: "&hdr=1&dynres=0" },
];

/** RGBA rows as a PNG (8-bit, no filter). */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** The render scale dynamic resolution settles at for a frame that takes `ms` whole (render/dynamicResolution.ts). */
function settledScale(ms) {
  if (!(ms > 0) || ms <= 0.95 * BUDGET_MS) return 1;
  const steps = Math.floor(Math.sqrt((0.85 * BUDGET_MS) / ms) / 0.05 + 1e-6);
  return Math.min(1, Math.max(0.5, steps * 0.05));
}

/** Frames a paused view steps through for its history (TAA) to settle: TAA keeps a tenth of each frame, so after 20 the old view is an eighth. */
const SETTLE_STEPS = 20;

/** Press and release a key. */
async function press(page, key) {
  await page.keyboard.down(key);
  await page.waitForTimeout(200);
  await page.keyboard.up(key);
}

/** Wait for `n` more frames of game time (on software rendering, seconds each). */
async function frames(page, n) {
  const from = await page.evaluate(() => window.cartboxPlayer.frame());
  await page.waitForFunction((to) => window.cartboxPlayer.frame() >= to, from + n, { timeout: 900000, polling: 1000 });
}

/** Advance the paused game `n` frames, showing each, and wait for the GPU to finish the last (so the queue stays short). */
const step = (page, n) =>
  page.evaluate(async (count) => {
    for (let i = 1; i < count; i += 1) window.cartboxPlayer.stepFrame();
    const shown = window.cartboxPlayer.captureFrame();
    window.cartboxPlayer.stepFrame();
    await shown;
  }, n);

const t0 = Date.now();
/** A progress line, with the minutes since the start. */
const note = (text) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)} min] ${text}`);

const median = (xs) => {
  const s = xs.filter((x) => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
};

/** A browser with WebGPU, and timestamp queries for the GPU's frame time. */
function launch() {
  const device = process.env.CBX_GPU
    ? ["--ignore-gpu-blocklist"]
    : ["--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  return chromium.launch({
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH === "/opt/pw-browsers" ? { executablePath: "/opt/pw-browsers/chromium" } : {}),
    args: ["--enable-unsafe-webgpu", ...device, "--enable-dawn-features=allow_unsafe_apis", "--enable-webgpu-developer-features", "--autoplay-policy=no-user-gesture-required"],
  });
}

const report = { budgetMs: BUDGET_MS, viewport: VIEWPORT, deviceScale: DEVICE_SCALE, device: process.env.CBX_GPU ? "hardware" : "swiftshader", maps: {} };
for (const map of MAPS.split(",")) {
  report.maps[map] = {};
  for (const tier of TIERS) {
    const browser = await launch();
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
    page.on("pageerror", (e) => console.error(`[${map} ${tier.tag}] page error: ${e.message}`));
    await page.goto(`${BASE}/lockout?map=${map}&capture=1${tier.query}`, { waitUntil: "networkidle", timeout: 300000 });
    await page.getByRole("button", { name: "Play", exact: true }).click({ timeout: 180000 });
    await page.waitForFunction(() => window.cartboxPlayer, null, { timeout: 180000 });
    await page.evaluate(() => window.cartboxPlayer.setProfiling(true));
    // The title, then a match of the highlighted game type (Free for All) once its intro has run.
    await page.waitForTimeout(20000);
    note(`${map} ${tier.tag}: playing`);
    await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height * 0.55);
    await press(page, "z");
    // Skip the intro (Z again), and let the match get going.
    await frames(page, 15);
    await press(page, "z");
    await frames(page, 30);
    note(`${map} ${tier.tag}: in the match`);
    const views = [];
    for (const view of VIEWS[map] ?? VIEWS.lockout) {
      await page.evaluate((v) => window.cartboxPlayer.setEditorCamera({ yaw: v.yaw, pitch: v.pitch, distance: v.distance, target: v.target, fov: v.fov, hud: false }), view);
      // The frame's time, while the game plays on.
      await frames(page, 2);
      const samples = [];
      for (let i = 0; i < 3; i += 1) {
        await frames(page, 1);
        samples.push(await page.evaluate(() => window.cartboxPlayer.profile()));
      }
      // The picture, with the game paused and stepped a frame at a time, so the view holds still.
      await page.evaluate(() => window.cartboxPlayer.pause());
      note(`${map} ${tier.tag} ${view.name}: timed; settling`);
      for (let i = 0; i < SETTLE_STEPS; i += 10) await step(page, 10);
      const file = `${OUT}/${map}-${view.name}-${tier.tag}.png`;
      const frame = await page.evaluate(async () => {
        const next = window.cartboxPlayer.captureFrame();
        window.cartboxPlayer.stepFrame();
        const f = await next;
        if (!f) return null;
        let s = "";
        for (let i = 0; i < f.rgba.length; i += 0x8000) s += String.fromCharCode(...f.rgba.subarray(i, i + 0x8000));
        return { width: f.width, height: f.height, data: btoa(s) };
      });
      if (!frame) throw new Error(`${map} ${tier.tag}: the frame isn't GPU-presented (no WebGPU canvas?)`);
      writeFileSync(file, encodePng(frame.width, frame.height, new Uint8Array(Buffer.from(frame.data, "base64"))));
      const size = [frame.width, frame.height];
      await page.evaluate(() => window.cartboxPlayer.resume());
      const last = samples[samples.length - 1];
      const gpuMs = median(samples.map((s) => s?.render?.gpuMs));
      const frameMs = median(samples.map((s) => s?.total?.avg));
      const passes = last?.render?.passes ?? [];
      views.push({
        view: view.name,
        file,
        size,
        backend: last?.render?.backend ?? null,
        rendered: last?.render?.resolution ?? null,
        gpuMs,
        cpuFrameMs: frameMs,
        settledScale: tier.tag === "after" ? settledScale(gpuMs) : null,
        drawCalls: last?.render?.drawCalls ?? null,
        triangles: last?.render?.triangles ?? null,
        passes: passes.map((p) => ({ name: p.name, ms: Number(p.ms.toFixed(3)) })),
      });
      note(`${map} ${tier.tag} ${view.name}: ${size.join("x")}, GPU ${gpuMs?.toFixed(2) ?? "?"} ms`);
    }
    report.maps[map][tier.tag] = views;
    // Written as it goes: a long run that stops early keeps what it measured.
    writeFileSync(`${OUT}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    await browser.close();
  }
}
