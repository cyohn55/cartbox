/**
 * Reflections on the AAA tier (AAA_FIDELITY_ROADMAP.md F3f): the Hi-Z chain's
 * levels and uniforms, the Epic preset, and on a real device a mirror floor
 * showing a glowing red block standing on it, the chain holding each block's
 * nearest depth, a rough floor's reflection spreading and fading into the
 * probes', and (Epic) a red panel above the screen's top, which only the BVH
 * trace can show, in the mirror.
 */

import { describe, expect, it } from "vitest";

import { composeModelMatrix, defaultSceneLighting, projectionMatrix, viewMatrix, type MeshAsset, type MeshSceneInstance, type Occluder } from "@cartbox/editor";
import { MeshOverlaySurface, QUALITY_LEVELS, QUALITY_PRESETS, WebgpuSceneRenderer, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { HIZ_MAX_LEVELS, HIZ_UNIFORM_FLOATS, hizLevels, hizUniforms } from "../packages/player/src/render/hizReflections";

describe("the Hi-Z reflections' set-up", () => {
  it("takes a level per halving of the frame, up to the limit", () => {
    expect(hizLevels(1, 1)).toBe(1);
    expect(hizLevels(64, 48)).toBe(7);
    expect(hizLevels(1920, 1080)).toBe(HIZ_MAX_LEVELS);
  });

  it("carries the levels, the trace, the history and the frame in its uniforms", () => {
    const u = hizUniforms(viewMatrix([0, 0, 5], [0, 0, 0]), projectionMatrix(1, 1, 0.1, 50), 1500, 7, true, false);
    expect(u).toHaveLength(HIZ_UNIFORM_FLOATS);
    expect([u[51], u[52], u[53], u[54]]).toEqual([1500 % 1024, 7, 1, 0]);
  });

  it("traces off-screen reflections at Epic alone, above high", () => {
    expect(QUALITY_LEVELS.at(-1)).toBe("epic");
    expect(QUALITY_PRESETS.epic.tracedReflections).toBe(true);
    expect(QUALITY_PRESETS.high.tracedReflections).toBeUndefined();
  });
});

describe("the player under Epic reflections", () => {
  it("hands the AAA renderer the still scene to trace at Epic, and nothing below it or elsewhere", async () => {
    const draws: GpuSceneDraw[] = [];
    const make = (cascades: boolean) => ({ backend: "webgpu", sunCascades: cascades, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} }) as unknown as SceneRenderer;
    const presenter = { present: (_frame: PresentFrame) => undefined, stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
    const floor = { name: "floor", primitives: [{ positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: null, indices: Uint32Array.from([0, 2, 1]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 1, roughnessFactor: 0 } }] } as unknown as MeshAsset;
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const scene = { instances: [{ mesh: floor, model: IDENTITY }], bounds: { min: [-1, 0, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 2 }, lighting: defaultSceneLighting() } as never;
    const frame = async (cascades: boolean, level: "high" | "epic") => {
      const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, make(cascades), { presenter, reflections: true } as never);
      surface.setQuality(QUALITY_PRESETS[level]);
      surface.setHudMode(true);
      surface.blit(new Uint8Array(32 * 24 * 4));
      return draws.at(-1)!;
    };
    const epic = await frame(true, "epic");
    expect(epic.reflections).toBe(true);
    expect(epic.reflectionTrace?.occluders).toHaveLength(1);
    expect(typeof epic.reflectionTrace?.key).toBe("string");
    expect((await frame(true, "high")).reflectionTrace).toBeUndefined();
    expect((await frame(false, "epic")).reflectionTrace).toBeUndefined();
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

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 800 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

function half(h: number): number {
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  const s = h & 0x8000 ? -1 : 1;
  return e === 0 ? s * 2 ** -14 * (m / 1024) : s * 2 ** (e - 15) * (1 + m / 1024);
}

const W = 96;
const H = 96;

const material = (colour: [number, number, number], rough: number, metal: number, glow: [number, number, number] = [0, 0, 0]) => ({ name: "m", baseColorImage: null, baseColorFactor: [...colour, 1], metallicFactor: metal, roughnessFactor: rough, emissiveFactor: glow });
/** A unit square in XZ facing up (or down). */
const quad = (m: object, down = false): MeshAsset =>
  ({
    name: "quad",
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from(down ? [0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0] : [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from(down ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]),
        material: m,
      },
    ],
  }) as unknown as MeshAsset;
const cube = (m: object): MeshAsset => {
  const p: number[] = [];
  const n: number[] = [];
  const idx: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [f, a, b] of faces) {
    const base = p.length / 3;
    for (const [s, t] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.push(f[0]! + a[0]! * s! + b[0]! * t!, f[1]! + a[1]! * s! + b[1]! * t!, f[2]! + a[2]! * s! + b[2]! * t!);
      n.push(...f);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { name: "cube", primitives: [{ positions: Float32Array.from(p), normals: Float32Array.from(n), uvs: new Float32Array((p.length / 3) * 2), indices: Uint32Array.from(idx), material: m }] } as unknown as MeshAsset;
};

const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 60);

/** Render `frames` frames of `instances`; the last frame's linear light as a sampler of [r, g, b] at a pixel, and the renderer's Hi-Z chain read back. */
async function render(instances: MeshSceneInstance[], view: Float64Array | number[], options: Record<string, unknown>, frames = 12): Promise<{ at: (x: number, y: number) => [number, number, number]; chain: (level: number) => Promise<{ w: number; h: number; z: Float32Array }> }> {
  const renderer = (await WebgpuSceneRenderer.create(device, W, H, undefined, { hdr: true }))!;
  device.pushErrorScope("validation");
  let texture: any = null;
  for (let f = 0; f < frames; f += 1) {
    texture = renderer.renderToTexture!(instances, {
      width: W,
      height: H,
      view,
      projection: PROJECTION,
      ambient: 0.2,
      lightDirection: [0, -1, 0],
      lights: [],
      prepass: true,
      temporal: true,
      ambientOcclusion: false,
      ...options,
    } as any);
  }
  const error = await settled(device.popErrorScope());
  expect(error ? String((error as any).message ?? error) : null).toBeNull();
  const readTexture = async (source: any, level: number, w: number, h: number, bytes: number) => {
    const bytesPerRow = Math.ceil((w * bytes) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * h, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture: source, mipLevel: level }, { buffer, bytesPerRow, rowsPerImage: h }, { width: w, height: h });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const data = buffer.getMappedRange().slice(0);
    buffer.unmap();
    buffer.destroy();
    return { data, bytesPerRow };
  };
  const frame = await readTexture(texture, 0, W, H, 8);
  const halves = new Uint16Array(frame.data);
  const hz = (renderer as any).hiz;
  const levels: { w: number; h: number; z: Float32Array }[] = [];
  if (hz) {
    for (let level = 0; level < hz.levels; level += 1) {
      const w = Math.max(1, W >> level);
      const h = Math.max(1, H >> level);
      const got = await readTexture(hz.chain, level, w, h, 4);
      const rows = new Float32Array(got.data);
      const z = new Float32Array(w * h);
      for (let y = 0; y < h; y += 1) z.set(rows.subarray((y * got.bytesPerRow) / 4, (y * got.bytesPerRow) / 4 + w), y * w);
      levels.push({ w, h, z });
    }
  }
  renderer.dispose();
  return {
    at: (x, y) => {
      const sum: [number, number, number] = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const i = ((y + dy) * frame.bytesPerRow) / 2 + (x + dx) * 4;
          for (let c = 0; c < 3; c += 1) sum[c] += half(halves[i + c]!) / 9;
        }
      }
      return sum;
    },
    chain: async (level) => levels[level]!,
  };
}

/** Where a world point lands on screen under `view`. */
function screen(view: Float64Array | number[], p: [number, number, number]): [number, number] {
  const m = (a: ArrayLike<number>, v: number[]) => [0, 1, 2, 3].map((r) => a[r]! * v[0]! + a[4 + r]! * v[1]! + a[8 + r]! * v[2]! + a[12 + r]! * v[3]!);
  const c = m(PROJECTION, m(view, [...p, 1]));
  return [Math.round((c[0]! / c[3]! * 0.5 + 0.5) * W), Math.round((0.5 - (c[1]! / c[3]!) * 0.5) * H)];
}

describe.skipIf(!device)("Hi-Z reflections, on a real device", { timeout: 180_000 }, () => {
  // A glowing red block on a floor, seen from above and in front; the floor's reflection of the block lies
  // between the block's foot and the camera, mirrored about the floor.
  const block: MeshSceneInstance = { mesh: cube(material([0, 0, 0], 1, 0, [1, 0, 0])), model: composeModelMatrix([0, 0.5, -1], [0, 0, 0], [0.6, 0.5, 0.3]) };
  const floorOf = (rough: number): MeshSceneInstance => ({ mesh: quad(material([0.9, 0.9, 0.9], rough, 1)), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [4, 1, 4]) });
  const VIEW = viewMatrix([0, 1.2, 3], [0, 0.2, -1]);
  // The block's mirror image's middle (its foot's at y = 0): y = −0.5 below the block, seen in the floor.
  const mirrored = (): [number, number] => screen(VIEW, [0, -0.35, -0.7]);

  it("shows a mirror floor the block standing on it, and the chain holds each block's nearest depth", async () => {
    const plain = await render([floorOf(0), block], VIEW, { reflections: false });
    const lit = await render([floorOf(0), block], VIEW, { reflections: true });
    const [x, y] = mirrored();
    const before = plain.at(x, y);
    const after = lit.at(x, y);
    // Without reflections on screen the mirror shows the black sky's probe; with them, the red block.
    expect(after[0]).toBeGreaterThan(before[0] + 0.15);
    expect(after[0]).toBeGreaterThan(after[1] * 4);
    // The block's own face, as a reference: the mirror gives back most of it (a metal's f0 is its colour).
    const [bx, by] = screen(VIEW, [0, 0.5, -0.69]);
    expect(after[0] / lit.at(bx, by)[0]).toBeGreaterThan(0.5);
    // Each level of the chain is the nearest of the four texels under it.
    const l0 = await lit.chain(0);
    const l1 = await lit.chain(1);
    const l3 = await lit.chain(3);
    let worst = 0;
    for (let yy = 0; yy < l1.h; yy += 1) {
      for (let xx = 0; xx < l1.w; xx += 1) {
        const m = Math.min(l0.z[2 * yy * l0.w + 2 * xx]!, l0.z[2 * yy * l0.w + 2 * xx + 1]!, l0.z[(2 * yy + 1) * l0.w + 2 * xx]!, l0.z[(2 * yy + 1) * l0.w + 2 * xx + 1]!);
        worst = Math.max(worst, Math.abs(l1.z[yy * l1.w + xx]! - m));
      }
    }
    // (The floor and block hold depths short of the sky's, so the comparison isn't over a blank chain.)
    expect(Math.min(...l1.z)).toBeLessThan(0.999);
    expect(worst).toBe(0);
    const min0 = Math.min(...l0.z.subarray(0, 8 * l0.w).filter((_, i) => i % l0.w < 8));
    expect(l3.z[0]).toBeCloseTo(min0, 6);
  });

  it("spreads a rough floor's reflection, which fades into the probes' past the limit", async () => {
    const [x, y] = mirrored();
    const sharp = (await render([floorOf(0), block], VIEW, { reflections: true }, 16)).at(x, y);
    const rough = await render([floorOf(0.35), block], VIEW, { reflections: true }, 24);
    const plainRough = await render([floorOf(0.35), block], VIEW, { reflections: false }, 1);
    // Still red, but spread out: less at the image's middle than the mirror's.
    const r = rough.at(x, y);
    expect(r[0]).toBeGreaterThan(plainRough.at(x, y)[0] + 0.03);
    expect(r[0]).toBeLessThan(sharp[0]);
    // Past the roughness limit the trace leaves the probes' reflection as it was.
    const past = await render([floorOf(0.95), block], VIEW, { reflections: true }, 4);
    const pastPlain = await render([floorOf(0.95), block], VIEW, { reflections: false }, 4);
    const a = past.at(x, y);
    const b = pastPlain.at(x, y);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(0.01 + b[0] * 0.05);
  });

  it("at Epic, traces what lies off the screen through the still scene's BVH", async () => {
    // A glowing red panel high above, facing down: the camera looks steeply down and never sees it, but the
    // mirror floor does.
    const panel: MeshSceneInstance = { mesh: quad(material([0, 0, 0], 1, 0, [1, 0, 0]), true), model: composeModelMatrix([0, 4, -1], [0, 0, 0], [3, 1, 3]) };
    const floor = floorOf(0);
    const view = viewMatrix([0, 2.5, 1.5], [0, 0, -0.5]);
    const [px, py] = screen(view, [0, 4, -1]);
    expect(py < 0 || py >= H || px < 0 || px >= W).toBe(true);
    const occluders: Occluder[] = [floor, panel].map((i) => ({ mesh: i.mesh, model: i.model as never }));
    const [x, y] = screen(view, [0, 0, -0.6]);
    const screenOnly = (await render([floor, panel], view, { reflections: true }, 8)).at(x, y);
    const traced = (await render([floor, panel], view, { reflections: true, reflectionTrace: { occluders, key: "panel" } }, 8)).at(x, y);
    expect(screenOnly[0]).toBeLessThan(0.05);
    expect(traced[0]).toBeGreaterThan(0.3);
    expect(traced[0]).toBeGreaterThan(traced[1] * 4);
  });
});
