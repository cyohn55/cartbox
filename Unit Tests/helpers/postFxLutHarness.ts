/**
 * Runs inside Chromium for postfx-lut-webgl.test.ts: the real post-process pass
 * (WebGL1) draws a frame of every colour through each grading LUT, and the
 * result is compared, pixel for pixel, with the CPU reference (applyLut).
 */

import { PostFxPass } from "../../packages/player/src/fx/PostFxPass";
import { applyLut, encodeLut, parseCubeLut, IMPORTED_LOOK } from "../../packages/player/src/fx/lutModel";
import { defaultPostFxSettings, uniformsFromSettings } from "../../packages/player/src/fx/postfx";

const W = 64;
const H = 64;

/** Every pixel a different colour: red across, green down, blue in 4×4 blocks. */
function frame(): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      out[o] = (x * 4) % 256;
      out[o + 1] = (y * 4) % 256;
      out[o + 2] = ((x >> 3) + (y >> 3) * 8) * 4;
      out[o + 3] = 255;
    }
  }
  return out;
}

interface LutReport {
  readonly maxDelta: number;
  readonly far: number;
  readonly changed: number;
  readonly error?: string;
}

(globalThis as unknown as { runLut: (look: number, strength: number, cube: string | null) => LutReport }).runLut = (look, strength, cube) => {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const pass = PostFxPass.create(canvas);
  if (!pass) return { maxDelta: 0, far: 0, changed: 0, error: "no WebGL" };
  const settings = defaultPostFxSettings();
  settings.enabled.lut = true;
  settings.values["lut.look"] = look;
  settings.values["lut.strength"] = strength;
  if (cube !== null) {
    const parsed = parseCubeLut(cube);
    if (!parsed) return { maxDelta: 0, far: 0, changed: 0, error: "bad cube" };
    settings.lut = encodeLut(parsed);
    settings.values["lut.look"] = IMPORTED_LOOK;
  }
  const uniforms = uniformsFromSettings(settings);
  const source = frame();
  pass.render(source, W, H, uniforms);
  const read = document.createElement("canvas");
  read.width = W;
  read.height = H;
  const ctx = read.getContext("2d")!;
  ctx.drawImage(canvas, 0, 0);
  const got = ctx.getImageData(0, 0, W, H).data;
  let maxDelta = 0;
  let far = 0;
  let changed = 0;
  for (let i = 0; i < W * H; i += 1) {
    const [r, g, b] = [source[i * 4]! / 255, source[i * 4 + 1]! / 255, source[i * 4 + 2]! / 255];
    const graded = applyLut(uniforms.lut!, r, g, b);
    const want = [r + (graded[0] - r) * strength, g + (graded[1] - g) * strength, b + (graded[2] - b) * strength].map((v) => v * 255);
    let worst = 0;
    for (let c = 0; c < 3; c += 1) worst = Math.max(worst, Math.abs(got[i * 4 + c]! - want[c]!));
    maxDelta = Math.max(maxDelta, worst);
    if (worst > 3) far += 1;
    if (Math.abs(got[i * 4]! - source[i * 4]!) + Math.abs(got[i * 4 + 1]! - source[i * 4 + 1]!) + Math.abs(got[i * 4 + 2]! - source[i * 4 + 2]!) > 6) changed += 1;
  }
  pass.dispose();
  return { maxDelta, far, changed };
};
