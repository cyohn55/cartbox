/**
 * The physical camera (AAA_FIDELITY_ROADMAP.md F4c): exposure from aperture,
 * shutter and ISO; the thin lens's circle of confusion; post volumes pulling
 * the aperture, focus and motion blur; the player's exposure and hand-off; and
 * on a real device the histogram's metering modes, bokeh that blurs what is
 * out of focus and leaves what is in focus sharp, and motion blur that smears
 * what moves and leaves what stands still.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_PHYSICAL_CAMERA,
  blendPostVolumes,
  cameraEv100,
  cameraExposure,
  circleOfConfusion,
  cocTerms,
  composeModelMatrix,
  defaultSceneLighting,
  parsePhysicalCamera,
  parseSceneLighting,
  projectionMatrix,
  resolvePhysicalCamera,
  shutterFraction,
  viewMatrix,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { GpuPresenter, MeshOverlaySurface, WebgpuSceneRenderer, type GpuSceneDraw, type PresentFrame, type SceneRenderer } from "@cartbox/player";
import { DOF_MAX_COC, cocPixels } from "../packages/player/src/render/cameraEffects";

describe("the physical camera's model", () => {
  it("takes 'sunny 16' to EV100 15, exposure 1, and a stop of aperture to a stop of exposure", () => {
    expect(cameraEv100(16, 1 / 125, 100)).toBeCloseTo(14.97, 2);
    expect(cameraExposure({ aperture: 16, shutter: 1 / 125, iso: 100 })).toBeCloseTo(1.02, 2);
    const a = cameraExposure({ aperture: 8, shutter: 1 / 125, iso: 100 });
    const b = cameraExposure({ aperture: 8 * Math.SQRT2, shutter: 1 / 125, iso: 100 });
    expect(a / b).toBeCloseTo(2, 5);
    expect(cameraExposure({ aperture: 8, shutter: 1 / 125, iso: 200 }) / a).toBeCloseTo(2, 5);
  });

  it("blurs nothing at the focus, the near field negative, toward its limit far beyond", () => {
    const cam = { aperture: 2, focusDistance: 5, focalLength: 50, sensorWidth: 36 };
    expect(circleOfConfusion(cam, 5)).toBeCloseTo(0, 9);
    expect(circleOfConfusion(cam, 2)).toBeLessThan(0);
    expect(circleOfConfusion(cam, 50)).toBeGreaterThan(0);
    const { scale, focus } = cocTerms(cam);
    expect(circleOfConfusion(cam, 1e6)).toBeCloseTo(scale, 6);
    for (const d of [1, 3, 7, 40]) expect(scale * (1 - focus / d)).toBeCloseTo(circleOfConfusion(cam, d), 9);
    // Stopping down a stop halves the blur's area: its diameter by √2.
    expect(circleOfConfusion({ ...cam, aperture: 2 * Math.SQRT2 }, 50) / circleOfConfusion(cam, 50)).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.abs(cocPixels(1, 1, 1e6, 100))).toBeCloseTo(DOF_MAX_COC * 100, 6);
  });

  it("reads its settings in range and survives a save", () => {
    expect(parsePhysicalCamera({ aperture: 0.5, iso: 1e6, metering: "matrix", blades: 3, shutter: 2 })).toEqual({ aperture: 1.2, iso: 12800, blades: 0, shutter: 1 });
    const rig = parseSceneLighting({ camera: { exposure: "manual", aperture: 4, depthOfField: true } });
    expect(parseSceneLighting(JSON.parse(JSON.stringify(rig))).camera).toEqual({ exposure: "manual", aperture: 4, depthOfField: true });
    expect(resolvePhysicalCamera(null)).toEqual(DEFAULT_PHYSICAL_CAMERA);
    expect(shutterFraction(1 / 120)).toBeCloseTo(0.5, 9);
    expect(shutterFraction(1)).toBe(1);
  });

  it("lets a post volume pull the aperture, focus and motion blur from the camera's own", () => {
    const volume = { id: "v", name: "v", center: [0, 0, 0] as const, size: [2, 2, 2] as const, blend: 2, aperture: 2, focusDistance: 1 };
    const camera = { aperture: 8, focusDistance: 10, motionBlur: 1 };
    const inside = blendPostVolumes([volume], [0, 0, 0], camera);
    expect([inside.aperture, inside.focusDistance, inside.motionBlur]).toEqual([2, 1, undefined]);
    const edge = blendPostVolumes([volume], [2, 0, 0], camera);
    expect(edge.aperture!).toBeGreaterThan(2);
    expect(edge.aperture!).toBeLessThan(8);
    expect(blendPostVolumes([volume], [9, 0, 0], camera).aperture).toBeUndefined();
  });
});

describe("the player under a physical camera", () => {
  const draws: GpuSceneDraw[] = [];
  const presented: PresentFrame[] = [];
  const renderer = { backend: "webgpu", sunCascades: true, render: () => {}, renderToTexture: (_i: unknown, draw: GpuSceneDraw) => (draws.push(draw), {}), dispose: () => {} } as unknown as SceneRenderer;
  const presenter = { present: (frame: PresentFrame) => void presented.push(frame), stats: { luminance: null, luminanceSeq: 0, sunVisible: null, seq: 0 } };
  const floor = { name: "floor", primitives: [{ positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1]), normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: null, indices: Uint32Array.from([0, 2, 1]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }] } as unknown as MeshAsset;
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const frame = async (camera: object) => {
    const scene = { instances: [{ mesh: floor, model: IDENTITY }], bounds: { min: [-1, 0, -1], max: [1, 1, 1], center: [0, 0, 0], radius: 2 }, lighting: { ...defaultSceneLighting(), tonemap: true, exposure: 1, camera } } as never;
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, scene, renderer, { presenter, prepass: true } as never);
    surface.setHudMode(true);
    surface.blit(new Uint8Array(32 * 24 * 4));
    return { draw: draws.at(-1)!, present: presented.at(-1)! };
  };

  it("exposes by the camera in manual mode, and hands the AAA renderer its depth of field and motion blur", async () => {
    const manual = await frame({ exposure: "manual", aperture: 8, shutter: 1 / 125, iso: 100, depthOfField: true, focusDistance: 4, motionBlur: true });
    expect(manual.draw.tonemap?.exposure).toBeCloseTo(cameraExposure({ aperture: 8, shutter: 1 / 125, iso: 100 }), 6);
    const terms = cocTerms({ ...DEFAULT_PHYSICAL_CAMERA, aperture: 8, focusDistance: 4 });
    expect(manual.draw.camera?.dof).toEqual({ scale: terms.scale, focus: terms.focus, blades: 6 });
    expect(manual.draw.camera?.motionBlur?.fraction).toBeCloseTo(shutterFraction(1 / 125), 9);
  });

  it("meters as the camera says in auto mode", async () => {
    const auto = await frame({ exposure: "auto", metering: "spot" });
    expect(auto.present.measure).toEqual({ luminance: true, sun: null, metering: "spot" });
    expect(auto.draw.camera).toBeNull();
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
function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const i = new Uint32Array(f.buffer)[0]!;
  const s = (i >> 16) & 0x8000;
  const e = ((i >> 23) & 0xff) - 127 + 15;
  if (e <= 0) return s;
  if (e >= 31) return s | 0x7c00;
  return s | (e << 10) | ((i >> 13) & 0x3ff);
}

const N = 64;

describe.skipIf(!device)("the camera on a real device", { timeout: 180_000 }, () => {
  /** A linear frame: dim everywhere (0.05), bright (4) in a disc round the centre a quarter of the frame across. */
  function spotScene(): any {
    const data = new Uint16Array(N * N * 4);
    for (let y = 0; y < N; y += 1) {
      for (let x = 0; x < N; x += 1) {
        const r = Math.hypot(x + 0.5 - N / 2, y + 0.5 - N / 2) / (N / 2);
        const v = toHalf(r < 0.25 ? 4 : 0.05);
        data.set([v, v, v, toHalf(1)], (y * N + x) * 4);
      }
    }
    const texture = device.createTexture({ size: { width: N, height: N }, format: "rgba16float", usage: 0x04 | 0x02 | 0x10 });
    device.queue.writeTexture({ texture }, data, { bytesPerRow: N * 8, rowsPerImage: N }, { width: N, height: N });
    return texture;
  }
  async function metered(metering?: "average" | "centre" | "spot"): Promise<number> {
    const presenter = new GpuPresenter(device, N, N, { hdr: true });
    const out = device.createTexture({ size: { width: N, height: N }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    presenter.present({ base: { kind: "colour", rgba: [0, 0, 0, 255] }, scene: spotScene(), tonemap: { exposure: 1 }, measure: { luminance: true, sun: null, ...(metering ? { metering } : {}) } }, out, "rgba8unorm");
    for (let i = 0; i < 200 && presenter.stats.seq === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      device.tick?.();
    }
    const l = presenter.stats.luminance!;
    presenter.dispose();
    out.destroy();
    return l;
  }

  it("meters the frame by its histogram: the spot reads the bright centre, the average the dim rest", async () => {
    const plain = await metered();
    const average = await metered("average");
    const centre = await metered("centre");
    const spot = await metered("spot");
    // The spot sees the bright disc alone (within a histogram bin).
    expect(spot).toBeGreaterThan(4 * 0.85);
    expect(spot).toBeLessThan(4 * 1.15);
    // The average drops the brightest tenth, so the small disc barely moves it from the dim rest.
    expect(average).toBeLessThan(0.05 * 1.3);
    expect(average).toBeLessThan(plain);
    // Centre-weighted lies between.
    expect(centre).toBeGreaterThan(average);
    expect(centre).toBeLessThan(spot);
  });

  /** Glowing bars on black: `near` a column of them 2 m off, `far` another 20 m off, each at its own side of the frame. */
  const bar = {
    name: "bar",
    primitives: [
      {
        positions: Float32Array.from([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorImage: null, baseColorFactor: [0, 0, 0, 1], metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [1, 1, 1] },
      },
    ],
  } as unknown as MeshAsset;
  const W = 96;
  const PROJECTION = projectionMatrix(Math.PI / 3, 1, 0.1, 100);
  const VIEW = viewMatrix([0, 0, 0], [0, 0, -1]);

  async function render(scene: (f: number) => MeshSceneInstance[], camera: GpuSceneDraw["camera"], frames: number): Promise<(x: number, y: number) => number> {
    const renderer = (await WebgpuSceneRenderer.create(device, W, W, undefined, { hdr: true }))!;
    device.pushErrorScope("validation");
    let texture: any = null;
    for (let f = 0; f < frames; f += 1) {
      texture = renderer.renderToTexture!(scene(f), { width: W, height: W, view: VIEW, projection: PROJECTION, ambient: 0, lightDirection: [0, 0, 1], lights: [], prepass: true, ambientOcclusion: false, camera } as any);
    }
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const bytesPerRow = Math.ceil((W * 8) / 256) * 256;
    const buffer = device.createBuffer({ size: bytesPerRow * W, usage: 0x01 | 0x08 });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: W }, { width: W, height: W });
    device.queue.submit([encoder.finish()]);
    await settled(buffer.mapAsync(0x01));
    const halves = new Uint16Array(buffer.getMappedRange().slice(0));
    buffer.unmap();
    buffer.destroy();
    renderer.dispose();
    return (x, y) => half(halves[(y * bytesPerRow) / 2 + x * 4 + 1]!);
  }
  /** How sharp a row is: its largest step between neighbouring pixels. */
  const sharpness = (img: (x: number, y: number) => number, y: number, from: number, to: number) => {
    let best = 0;
    for (let x = from; x < to - 1; x += 1) best = Math.max(best, Math.abs(img(x + 1, y) - img(x, y)));
    return best;
  };

  it("blurs what lies out of focus into bokeh, and leaves what is in focus sharp", async () => {
    // Bars 2 m away on the left (scaled to look the same size as the far ones), 20 m away on the right.
    const scene = (): MeshSceneInstance[] => [
      ...[0, 1, 2].map((i) => ({ mesh: bar, model: composeModelMatrix([-0.9 + i * 0.15, 0, -2], [0, 0, 0], [0.05, 0.8, 1]) })),
      ...[0, 1, 2].map((i) => ({ mesh: bar, model: composeModelMatrix([3 + i * 1.5, 0, -20], [0, 0, 0], [0.5, 8, 1]) })),
    ];
    const terms = cocTerms({ aperture: 1.4, focusDistance: 2, focalLength: 50, sensorWidth: 36 });
    const sharp = await render(scene, null, 1);
    const bokeh = await render(scene, { dof: { scale: terms.scale, focus: terms.focus, blades: 6 } }, 1);
    const y = W / 2;
    // The far bars (right half) lose their hard edges; the near ones (left half), in focus, keep theirs.
    expect(sharpness(bokeh, y, W / 2, W)).toBeLessThan(sharpness(sharp, y, W / 2, W) * 0.6);
    expect(sharpness(bokeh, y, 0, W / 2)).toBeGreaterThan(sharpness(sharp, y, 0, W / 2) * 0.8);
    // The blur moves light about, it doesn't make or lose it.
    let a = 0;
    let b = 0;
    for (let x = W / 2; x < W; x += 1) {
      a += sharp(x, y);
      b += bokeh(x, y);
    }
    expect(Math.abs(b - a) / a).toBeLessThan(0.15);
  });

  it("smears what moves along its motion, and leaves what stands still sharp", async () => {
    // A bar sweeping right in the top half, one standing still in the bottom half, 5 m away.
    const scene = (f: number): MeshSceneInstance[] => [
      { mesh: bar, model: composeModelMatrix([-1.5 + f * 0.6, 0.8, -5], [0, 0, 0], [0.3, 1, 1]) },
      { mesh: bar, model: composeModelMatrix([0, -0.8, -5], [0, 0, 0], [0.3, 1, 1]) },
    ];
    const still = await render(scene, null, 6);
    const blurred = await render(scene, { motionBlur: { fraction: 1 } }, 6);
    const top = Math.round(W / 2 - (0.8 / (5 * Math.tan(Math.PI / 6))) * (W / 2));
    const bottom = W - top;
    expect(sharpness(blurred, top, 0, W)).toBeLessThan(sharpness(still, top, 0, W) * 0.6);
    expect(sharpness(blurred, bottom, 0, W)).toBeGreaterThan(sharpness(still, bottom, 0, W) * 0.9);
  });
});
