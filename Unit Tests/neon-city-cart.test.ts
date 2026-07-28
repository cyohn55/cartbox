/**
 * NEON CITY cart — behavioural tests.
 *
 * These load the *real* Cartbox Pro WASM core (packages/engine/dist/pro/engine.js),
 * pack the actual cart.lua into a cartridge, run it, and assert on the pixels the
 * engine produces. Nothing is stubbed and no expected image is baked in: every
 * assertion is derived from the cart's own design contract (its layer speeds,
 * palette ramps and waterline) applied to the frames the engine renders, so the
 * tests prove the effects happen rather than restating a golden output.
 *
 * What is proven end-to-end on the shipped engine:
 *   1. it renders a 640x360, many-colour Pro frame;
 *   2. the palette is applied in true colour (guards the RGBA framebuffer fix —
 *      before it, every pixel's red channel was clamped to 255 and the night sky
 *      came out red);
 *   3. parallax is real: the far skyline scrolls slower than the near skyline in
 *      the same ratio as their depth speeds;
 *   4. the puddle is a genuine screen-space reflection — reflected brightness
 *      below the waterline tracks the emitters rendered above it;
 *   5. neon is emissive: it is drawn as a multi-step bloom ramp, not a flat fill.
 *
 * Skips (with a warning) if the Pro engine has not been built.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The cart's own build harness is the single source of truth for how the cart is
// packed and which engine runs it — reuse it instead of re-deriving the format.
import {
  buildLuaCart,
  createRunner,
  WIDTH,
  HEIGHT,
  ENGINE,
} from "../../neon-city-cart/build.mjs";

const CART_LUA = fileURLToPath(
  new URL("../../neon-city-cart/cart.lua", import.meta.url),
);

// --- the cart's design contract (mirrors constants in cart.lua) --------------
// The waterline where the reflection begins, and the per-layer scroll speeds and
// palette-ramp endpoints the cart draws with. Expectations are computed from
// these the same way the cart computes its pixels.
const WATERLINE = 250;
const CAM_STEP = 1.4; // camera advance per frame when auto-walking
const FAR_SPEED = 0.2;
const NEAR_SPEED = 0.8;

/** clampByte + ramp reproduce cart.lua's palette generator exactly, so a layer's
 * on-screen colours can be predicted from its two ramp endpoints. */
function clampByte(v: number): number {
  const r = Math.floor(v + 0.5);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}
function ramp(
  n: number,
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number[] {
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    const r = clampByte(r1 + (r2 - r1) * t);
    const g = clampByte(g1 + (g2 - g1) * t);
    const b = clampByte(b1 + (b2 - b1) * t);
    out.push((r << 16) | (g << 8) | b);
  }
  return out;
}

// Layer silhouette ramps and one neon glow ramp, copied endpoint-for-endpoint
// from cart.lua's setup().
const FAR_COLORS = new Set(ramp(4, 14, 14, 34, 30, 26, 58));
const NEAR_COLORS = new Set(ramp(4, 5, 5, 16, 18, 14, 40));
const CYAN_NEON = ramp(8, 4, 26, 34, 200, 255, 255);

// --- pixel helpers -----------------------------------------------------------
type Frame = Uint8Array; // RGBA, row-major, WIDTH*HEIGHT*4

const rgbKey = (f: Frame, i: number) => (f[i] << 16) | (f[i + 1] << 8) | f[i + 2];
const lumAt = (f: Frame, x: number, y: number) => {
  const i = (y * WIDTH + x) * 4;
  return (f[i] + f[i + 1] + f[i + 2]) / 3;
};

/** Per-column count of pixels whose exact colour is in `set`, over a y-range.
 * TIC-80 writes each pixel as one unblended palette colour, so exact-colour
 * matching cleanly isolates a single depth layer from everything drawn over it. */
function columnColorProfile(f: Frame, set: Set<number>, y0: number, y1: number): Float64Array {
  const profile = new Float64Array(WIDTH);
  for (let x = 0; x < WIDTH; x++) {
    let count = 0;
    for (let y = y0; y < y1; y++) {
      if (set.has(rgbKey(f, (y * WIDTH + x) * 4))) count++;
    }
    profile[x] = count;
  }
  return profile;
}

/** The whole-number horizontal shift (0..maxShift) that best aligns `later` onto
 * `earlier`, by minimising mean absolute difference. Content scrolling left makes
 * this positive. This is how the layer scroll rate is read back from pixels. */
function bestHorizontalShift(earlier: Float64Array, later: Float64Array, maxShift: number): number {
  let best = 0;
  let bestError = Infinity;
  for (let shift = 0; shift <= maxShift; shift++) {
    let error = 0;
    let samples = 0;
    for (let x = 0; x + shift < WIDTH; x++) {
      error += Math.abs(later[x] - earlier[x + shift]);
      samples++;
    }
    error /= samples;
    if (error < bestError) {
      bestError = error;
      best = shift;
    }
  }
  return best;
}

function pearson(a: Float64Array, b: Float64Array): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
}

// ENGINE is an absolute path string exported by the harness; existsSync it directly.
const engineBuilt = existsSync(ENGINE);
const suite = engineBuilt ? describe : describe.skip;
if (!engineBuilt) {
  console.warn(`[neon-city-cart] Pro engine not built at ${ENGINE}; skipping. Run npm run engine:build:pro.`);
}

suite("NEON CITY cart on the real Cartbox Pro core", () => {
  const cart = () => buildLuaCart(readFileSync(CART_LUA, "utf8"));

  /** Run the cart and return snapshots (deep copies) at the requested frames. */
  async function capture(frames: number[]): Promise<Map<number, Frame>> {
    const runner = await createRunner(cart());
    const want = new Set(frames);
    const out = new Map<number, Frame>();
    const last = Math.max(...frames);
    for (let f = 0; f <= last; f++) {
      runner.tick(0);
      if (want.has(f)) out.set(f, Uint8Array.from(runner.framebuffer()));
    }
    runner.dispose();
    return out;
  }

  let frame: Frame;
  const WARM = 100;
  const DELTA = 30;

  beforeAll(async () => {
    frame = (await capture([WARM])).get(WARM)!;
  }, 30000);

  it("renders a 640x360, many-colour Pro frame", () => {
    expect(frame.byteLength).toBe(WIDTH * HEIGHT * 4);

    const colors = new Set<number>();
    let nonBlack = 0;
    for (let i = 0; i < frame.length; i += 4) {
      colors.add(rgbKey(frame, i));
      if (frame[i] || frame[i + 1] || frame[i + 2]) nonBlack++;
    }
    // A 16-colour Classic frame could not exceed 16 colours; a blank cart would
    // be mostly black. Both bounds are far from the measured scene.
    expect(colors.size).toBeGreaterThan(16);
    expect(nonBlack / (WIDTH * HEIGHT)).toBeGreaterThan(0.5);
  });

  it("applies the palette in true colour — the night sky is blue, not red", () => {
    // Guards the RGBA framebuffer fix: the sky ramp is indigo (low red, higher
    // blue), so a correct pipeline yields mean blue clearly above mean red. The
    // pre-fix red-clobber bug forced red to 255 and inverted this.
    let sumR = 0;
    let sumB = 0;
    let n = 0;
    for (let y = 8; y < 40; y++) {
      for (let x = 0; x < WIDTH; x += 4) {
        const i = (y * WIDTH + x) * 4;
        sumR += frame[i];
        sumB += frame[i + 2];
        n++;
      }
    }
    expect(sumB / n).toBeGreaterThan((sumR / n) * 1.3);
  });

  it("scrolls the far skyline slower than the near skyline (real parallax)", async () => {
    const shots = await capture([WARM, WARM + DELTA]);
    const a = shots.get(WARM)!;
    const b = shots.get(WARM + DELTA)!;

    // Isolate each layer by its exact silhouette colours over the sky band, then
    // read back how far it scrolled between the two frames.
    const skyTop = 40;
    const farShift = bestHorizontalShift(
      columnColorProfile(a, FAR_COLORS, skyTop, WATERLINE),
      columnColorProfile(b, FAR_COLORS, skyTop, WATERLINE),
      Math.ceil(CAM_STEP * DELTA) + 5,
    );
    const nearShift = bestHorizontalShift(
      columnColorProfile(a, NEAR_COLORS, skyTop, WATERLINE),
      columnColorProfile(b, NEAR_COLORS, skyTop, WATERLINE),
      Math.ceil(CAM_STEP * DELTA) + 5,
    );

    // Both layers move; the near layer moves further, in ~the ratio of their
    // depth speeds (0.8 / 0.2 == 4). Assert a clear, robust separation.
    expect(farShift).toBeGreaterThan(1);
    expect(nearShift).toBeGreaterThan(farShift * 2);

    // Sanity: each shift is near its predicted distance (speed * frames).
    expect(farShift).toBeCloseTo(FAR_SPEED * CAM_STEP * DELTA, -1);
    expect(nearShift).toBeCloseTo(NEAR_SPEED * CAM_STEP * DELTA, -1);
  }, 30000);

  it("reflects the scene in the puddle — reflected light tracks the emitters above", () => {
    // Per column, the brightest emitter above the waterline and the brightest
    // reflected pixel below it. A real screen-space reflection makes these
    // co-vary across columns; unrelated decoration would not.
    const above = new Float64Array(WIDTH);
    const below = new Float64Array(WIDTH);
    for (let x = 0; x < WIDTH; x++) {
      let hiAbove = 0;
      let hiBelow = 0;
      for (let y = WATERLINE - 100; y < WATERLINE - 2; y++) hiAbove = Math.max(hiAbove, lumAt(frame, x, y));
      for (let y = WATERLINE + 2; y < WATERLINE + 90; y++) hiBelow = Math.max(hiBelow, lumAt(frame, x, y));
      above[x] = hiAbove;
      below[x] = hiBelow;
    }

    expect(pearson(above, below)).toBeGreaterThan(0.3);

    // Separation: columns under bright emitters reflect more than columns under
    // dark sky. Compare the reflected brightness of the brightest-emitter
    // columns against the dimmest, both derived from the frame itself.
    const order = [...above.keys()].sort((i, j) => above[j] - above[i]);
    const q = Math.floor(WIDTH / 4);
    const meanBelow = (idx: number[]) => idx.reduce((s, i) => s + below[i], 0) / idx.length;
    const brightCols = meanBelow(order.slice(0, q));
    const darkCols = meanBelow(order.slice(-q));
    expect(brightCols).toBeGreaterThan(darkCols);
  });

  it("draws neon as an emissive bloom ramp, not a flat fill", () => {
    // The cyan neon is drawn as concentric halo rings from a dim tail up to a
    // hot core. If emissive bloom is really rendered, several distinct levels of
    // the cyan ramp appear in the frame; a flat neon would show only one.
    const present = new Set<number>();
    for (let i = 0; i < frame.length; i += 4) present.add(rgbKey(frame, i));
    const levelsShown = CYAN_NEON.filter((c) => present.has(c)).length;
    expect(levelsShown).toBeGreaterThanOrEqual(4);

    // And the emissive marks are genuinely bright and saturated (neon), not just
    // dim tints — count vivid pixels across the frame.
    let vivid = 0;
    for (let i = 0; i < frame.length; i += 4) {
      const r = frame[i];
      const g = frame[i + 1];
      const b = frame[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      if (mx > 150 && mx - mn > 90) vivid++;
    }
    expect(vivid).toBeGreaterThan(200);
  });
});
