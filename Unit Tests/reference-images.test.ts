/**
 * Reference-image regression (AAA_PRODUCTION_ROADMAP.md Q3): fixed views of
 * the look-dev stage under each rig, the Forerunner ruin (F11b), Lockout and
 * Beaver Creek, rendered by the AAA renderer on a real WebGPU device (CI's
 * `gpu` job: Mesa's lavapipe) and compared with stored references by a
 * perceptual measure, so a change that alters the AAA image shows in review.
 *
 * The scenes are drawn as the game draws them: the arena maps and the ruin go
 * through the player's own mesh overlay, whose renderer is the real WebGPU one
 * with each frame kept on the GPU and read back here. One frame each from a
 * fresh renderer (so nothing temporal accumulates), tone-mapped with the
 * draw's own exposure, then compared on luminance by mean SSIM over 8×8
 * windows and by the mean absolute difference.
 *
 * Updating: `CBX_UPDATE_REFERENCES=1 npm run test:gpu -- -t "reference images"`
 * rewrites `fixtures/reference-images/*.png`; commit them with the change that
 * meant to alter the picture. A missing reference fails rather than skips.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { arenaMap, encodeRgbaPng, lockoutMeshSidecar, ruinSidecar } from "@cartbox/editor";
import { MODELS, MeshOverlaySurface, WebgpuSceneRenderer, parseMeshScene, rasterStyleFor } from "@cartbox/player";
import { LOOK_DEV_RIGS, lookDevStage } from "../packages/player/src/render/lookDev";
import { lookDevDraw, readLinearTexture } from "../packages/player/src/render/lookDevCheck";
import { decodeRgbaPng } from "./helpers/pngDecode";

const W = 160;
const H = 90;
const DIR = path.resolve(__dirname, "fixtures/reference-images");
const UPDATE = process.env.CBX_UPDATE_REFERENCES === "1";
/** Pass when the luminance is this alike (mean SSIM)… */
export const MIN_SSIM = 0.97;
/** …and the 8-bit channels differ by no more than this on average. */
export const MAX_MEAN_DIFF = 2;

/** Linear radiance to 8-bit sRGB: the draw's exposure, a Reinhard curve, the sRGB transfer. */
export function toSrgb8(linear: Float32Array, exposure: number): Uint8Array {
  const out = new Uint8Array((linear.length / 4) * 4);
  const encode = (v: number) => {
    const x = Math.max(0, v * exposure);
    const t = x / (1 + x);
    const s = t <= 0.0031308 ? 12.92 * t : 1.055 * t ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255);
  };
  for (let i = 0; i < linear.length; i += 4) {
    out[i] = encode(linear[i]!);
    out[i + 1] = encode(linear[i + 1]!);
    out[i + 2] = encode(linear[i + 2]!);
    out[i + 3] = 255;
  }
  return out;
}

/** Mean SSIM of two RGBA images' luminance, over 8×8 windows every 4 pixels. */
export function meanSsim(a: Uint8Array, b: Uint8Array, width: number, height: number): number {
  const luma = (img: Uint8Array) => {
    const y = new Float64Array(width * height);
    for (let i = 0; i < y.length; i += 1) y[i] = 0.2126 * img[i * 4]! + 0.7152 * img[i * 4 + 1]! + 0.0722 * img[i * 4 + 2]!;
    return y;
  };
  const ya = luma(a);
  const yb = luma(b);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let windows = 0;
  for (let y0 = 0; y0 + 8 <= height; y0 += 4) {
    for (let x0 = 0; x0 + 8 <= width; x0 += 4) {
      let ma = 0;
      let mb = 0;
      for (let y = y0; y < y0 + 8; y += 1) for (let x = x0; x < x0 + 8; x += 1) {
        ma += ya[y * width + x]!;
        mb += yb[y * width + x]!;
      }
      ma /= 64;
      mb /= 64;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let y = y0; y < y0 + 8; y += 1) for (let x = x0; x < x0 + 8; x += 1) {
        const da = ya[y * width + x]! - ma;
        const db = yb[y * width + x]! - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= 63;
      vb /= 63;
      cov /= 63;
      total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 1;
}

/** Mean absolute difference of the colour channels (0..255). */
export function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k += 1) sum += Math.abs(a[i + k]! - b[i + k]!);
    n += 3;
  }
  return n > 0 ? sum / n : 0;
}

describe("the comparison", () => {
  const flat = (v: number) => Uint8Array.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 255 : v));
  it("calls an image identical to itself, and tells a changed one apart", () => {
    const img = Uint8Array.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 37) % 251));
    expect(meanSsim(img, img, W, H)).toBeCloseTo(1, 10);
    expect(meanDiff(img, img)).toBe(0);
    const shifted = img.map((v, i) => (i % 4 === 3 ? 255 : Math.min(255, v + 30)));
    expect(meanDiff(img, shifted)).toBeGreaterThan(MAX_MEAN_DIFF);
    const noise = Uint8Array.from({ length: W * H * 4 }, (_, i) => (i % 4 === 3 ? 255 : (i * 7919) % 256));
    expect(meanSsim(img, noise, W, H)).toBeLessThan(MIN_SSIM);
    expect(meanSsim(flat(100), flat(100), W, H)).toBeCloseTo(1, 10);
  });

  it("tone-maps with the exposure, so a darker picture is a different picture", () => {
    const linear = new Float32Array(W * H * 4).fill(0.5);
    expect(toSrgb8(linear, 1)[0]).toBeGreaterThan(toSrgb8(linear, 0.25)[0]! + 30);
    expect(toSrgb8(new Float32Array([0, 0, 0, 1]), 1)[0]).toBe(0);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

describe.skipIf(!device)("reference images on a real device", { timeout: 600_000 }, () => {
  const settled = async <T,>(promise: Promise<T>): Promise<T> => {
    let done = false;
    void promise.then(
      () => (done = true),
      () => (done = true),
    );
    for (let i = 0; i < 40_000 && !done; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      device.tick?.();
    }
    return promise;
  };
  const renderer = async () => (await WebgpuSceneRenderer.create(device, W, H, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true }))!;

  /** One frame of a scene as the player's mesh overlay draws it, read back linear, with the draw's exposure. */
  async function sceneFrame(sidecar: string): Promise<{ linear: Float32Array; exposure: number }> {
    const real = await renderer();
    let captured: { texture: unknown; exposure: number } | null = null;
    const tap = new Proxy(real as object, {
      get(target, property) {
        if (property === "render") {
          return (instances: unknown, draw: { tonemap?: { exposure?: number } }) => {
            captured ??= { texture: (target as WebgpuSceneRenderer).renderToTexture(instances as never, draw as never), exposure: draw.tonemap?.exposure ?? 1 };
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, W, H, parseMeshScene(sidecar)!, tap as never, {});
    surface.blit(new Uint8Array(W * H * 4));
    expect(captured).not.toBeNull();
    const image = await readLinearTexture(device, captured!.texture, W, H, settled);
    surface.destroy();
    real.dispose();
    return { linear: image.data, exposure: captured!.exposure };
  }

  /** Compare with the stored reference (or write it, updating), naming where a failing frame was saved. */
  function compare(name: string, linear: Float32Array, exposure: number): void {
    const actual = toSrgb8(linear, exposure);
    const file = path.join(DIR, `${name}.png`);
    if (UPDATE) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, encodeRgbaPng(actual, W, H));
      return;
    }
    expect(existsSync(file), `no reference for ${name}: run with CBX_UPDATE_REFERENCES=1 and commit it`).toBe(true);
    const reference = decodeRgbaPng(readFileSync(file));
    expect([reference.width, reference.height]).toEqual([W, H]);
    const ssim = meanSsim(actual, reference.data, W, H);
    const diff = meanDiff(actual, reference.data);
    if (ssim < MIN_SSIM || diff > MAX_MEAN_DIFF) {
      const out = mkdtempSync(path.join(tmpdir(), "cbx-reference-"));
      writeFileSync(path.join(out, `${name}.actual.png`), encodeRgbaPng(actual, W, H));
      expect.fail(`${name}: SSIM ${ssim.toFixed(4)} (min ${MIN_SSIM}), mean difference ${diff.toFixed(2)} (max ${MAX_MEAN_DIFF}); this frame is at ${out}`);
    }
  }

  for (const rig of LOOK_DEV_RIGS.filter((r) => r.id !== "hdri")) {
    it(`the look-dev stage under the ${rig.id} rig`, async () => {
      const stage = lookDevStage(null, { rig: rig.id }, W / H);
      const r = await renderer();
      const image = await readLinearTexture(device, r.renderToTexture(stage.instances, lookDevDraw(stage, W, H) as never), W, H, settled);
      r.dispose();
      compare(`lookdev-${rig.id}`, image.data, stage.exposure);
    });
  }

  it("the Forerunner ruin (F11b)", async () => {
    const frame = await sceneFrame(ruinSidecar());
    compare("ruin", frame.linear, frame.exposure);
  });

  it("Lockout", async () => {
    const frame = await sceneFrame(lockoutMeshSidecar());
    compare("lockout", frame.linear, frame.exposure);
  });

  it("Beaver Creek", async () => {
    const frame = await sceneFrame(arenaMap("beaver").sidecar());
    compare("beaver-creek", frame.linear, frame.exposure);
  });
});
