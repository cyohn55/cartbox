// Regression check for the onboarding carousel's repaint flicker
// (/onboarding/handheld). Turning the carousel used to repaint every device from
// scratch — clearing each canvas, recomputing the full-resolution chassis
// composite, and re-decoding the marquee sheet asynchronously — so the ring
// flickered repeatedly on every flip.
//
// The check samples an 8x8 RGB fingerprint of each device canvas once per
// animation frame while the carousel is flipped, then counts *large* frame-to-
// frame content jumps. A flip legitimately changes each device exactly once (it
// becomes a different premade), so the jump count per device should track the
// number of flips. Before the fix this read 115-131 jumps for 6 flips.
//
// Connects to an already-running Chrome over CDP when one is reachable
// (see verify-console.mjs for the WSL setup), otherwise launches its own.
//   node scripts/verify-handheld-flicker.mjs

import { chromium } from "playwright";

const BASE = process.env.CBX_BASE_URL ?? "http://localhost:3000";
const CDP = process.env.CBX_CDP_URL ?? "http://127.0.0.1:9222";
const CHROME = process.env.CBX_CHROME_PATH;

const FLIPS = 6;
// One content change per flip, plus slack for the frame a device enters the ring
// on. Anything above this is a repaint the player sees as flicker.
const MAX_JUMPS_PER_DEVICE = FLIPS + 2;
// Mean per-channel difference (0-255) across the fingerprint that counts as a
// content change rather than the marquee animating within the device.
const JUMP_THRESHOLD = 10;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
};

async function openBrowser() {
  try {
    return await chromium.connectOverCDP(CDP);
  } catch {
    return await chromium.launch({
      ...(CHROME ? { executablePath: CHROME } : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
  }
}

const browser = await openBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 940 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));

  await page.goto(BASE + "/onboarding/handheld", { waitUntil: "domcontentloaded" });
  await page.getByRole("region", { name: "Handheld carousel" }).waitFor({ timeout: 30000 });
  // The premades' marquees are pre-warmed on load; sample only once they settle,
  // so the warm-up's own paints aren't counted as flicker.
  await page.waitForTimeout(5000);

  // Sample every device canvas once per animation frame.
  await page.evaluate(() => {
    const probe = { frames: [], running: true };
    window.__handheldFlicker = probe;
    const scratch = document.createElement("canvas");
    scratch.width = 8;
    scratch.height = 8;
    const context = scratch.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (!probe.running) return;
      probe.frames.push(
        [...document.querySelectorAll("section canvas")].map((canvas) => {
          if (!canvas.width || !canvas.height) return null;
          context.clearRect(0, 0, 8, 8);
          context.drawImage(canvas, 0, 0, 8, 8);
          return [...context.getImageData(0, 0, 8, 8).data];
        }),
      );
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  const nextArrow = page.getByRole("button", { name: "Next premade" });
  for (let flip = 0; flip < FLIPS; flip++) {
    await nextArrow.click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(600);

  const report = await page.evaluate((threshold) => {
    const probe = window.__handheldFlicker;
    probe.running = false;
    const frames = probe.frames;
    const slots = Math.max(...frames.map((frame) => frame.length));
    const jumps = [];
    for (let slot = 0; slot < slots; slot++) {
      let previous = null;
      let count = 0;
      for (const frame of frames) {
        const current = frame[slot];
        if (!current) continue;
        if (previous) {
          let distance = 0;
          for (let i = 0; i < current.length; i++) distance += Math.abs(current[i] - previous[i]);
          if (distance / current.length > threshold) count++;
        }
        previous = current;
      }
      jumps.push(count);
    }
    return { frameCount: frames.length, slots, jumps };
  }, JUMP_THRESHOLD);

  check("devices rendered in the carousel", report.slots >= 3, `${report.slots} devices`);
  check("frames sampled during the flips", report.frameCount > 60, `${report.frameCount} frames`);

  const worst = Math.max(...report.jumps);
  check(
    `each device repaints at most once per flip (<= ${MAX_JUMPS_PER_DEVICE})`,
    worst <= MAX_JUMPS_PER_DEVICE,
    `jumps per device: ${report.jumps.join(", ")} over ${FLIPS} flips`,
  );

  // Every device must actually follow the ring, or "no flicker" would be
  // trivially satisfied by a carousel that never repaints at all.
  check(
    "every device follows the ring",
    report.jumps.every((count) => count >= FLIPS - 1),
    `jumps per device: ${report.jumps.join(", ")}`,
  );

  check("no page errors", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
