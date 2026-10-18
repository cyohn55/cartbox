/**
 * Presenting a 3D frame from the GPU (AAA_FIDELITY_ROADMAP.md F0a).
 *
 * Two halves. Without a device: the uniform packers lay out what the WGSL
 * reads, and the shaft grid is the CPU pass's. On a real device (Dawn, as
 * webgpu-parity.test.ts runs it — it skips without one): the renderer's
 * GPU-kept frame is the frame its readback composites, byte for byte; and the
 * presenter's composite of sky, scene, sun shafts, HUD and holo matches the
 * byte path that does the same on the CPU, as do its measurements of the sun
 * and the frame's luminance.
 *
 * The composite is not byte-identical, and is not asked to be: the byte path
 * rounds to 8 bits between every step where the GPU keeps floats, and float32
 * against float64 maths moves a channel by a level or two. The reference sky
 * casts a ray a pixel, as the GPU does (the CPU's default interpolates them
 * across an 8-pixel grid, which is the larger difference). The bounds below
 * are what those come to, with margin, and well short of what a wrong layer
 * order, a missed key or a flipped axis would cost.
 */

import { describe, expect, it } from "vitest";

import {
  applySunShafts,
  LOCKOUT_FX,
  bakeCloudLayer,
  composeModelMatrix,
  frameLuminance,
  projectionMatrix,
  renderSkyBackground,
  sunScreenPosition,
  sunVisibility,
  viewMatrix,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
  type SunShafts,
} from "@cartbox/editor";
import {
  COMPOSE_UNIFORM_FLOATS,
  GpuPresenter,
  parsePostFxSettings,
  uniformsFromSettings,
  SKY_UNIFORM_FLOATS,
  WebgpuSceneRenderer,
  packComposeUniforms,
  packShaftUniforms,
  packSkyUniforms,
  shaftGrid,
  type PresentFrame,
  type PresentSky,
  type SceneDraw,
} from "@cartbox/player";

 

const W = 96;
const H = 64;

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

/** Pump Dawn until a promise settles (its callbacks run on tick). */
async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 400 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

/** Read an RGBA8 texture back to bytes. */
async function readTexture(texture: any, width: number, height: number): Promise<Uint8Array> {
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 }); // MAP_READ | COPY_DST
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  await settled(buffer.mapAsync(0x01));
  const padded = new Uint8Array(buffer.getMappedRange());
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) out.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
  buffer.unmap();
  buffer.destroy();
  return out;
}

function quad(color: [number, number, number, number]): MeshAsset {
  return {
    name: "q",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: color, baseColorImage: null },
      },
    ],
  };
}

/** Two quads below the horizon (the sky shows above them), and a gap between them the shafts shine through. */
function scene(): MeshSceneInstance[] {
  return [
    { mesh: quad([0.7, 0.35, 0.2, 1]), model: composeModelMatrix([-1.6, -0.6, -1], [0, 20, 0], [1.1, 1.4, 1]) },
    { mesh: quad([0.25, 0.5, 0.7, 1]), model: composeModelMatrix([1.5, -0.4, -1.2], [0, -25, 0], [1.1, 1.6, 1]) },
  ];
}

const VIEW = viewMatrix([0, 0.2, 4], [0, 0.4, 0]);
const PROJECTION = projectionMatrix(Math.PI / 3, W / H, 0.1, 100);
/** Toward the camera's view, a little up and to the right: on screen, in the gap. */
const SUN_DIRECTION: [number, number, number] = [0.08, 0.32, -1];

/** A small panorama: a vertical gradient, alpha full above the horizon (the glow shows there). */
function panorama(): DecodedTexture {
  const w = 128;
  const h = 64;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      const t = y / (h - 1);
      data[o] = 60 + 140 * t + 20 * Math.sin((x / w) * 6.283);
      data[o + 1] = 110 + 100 * t;
      data[o + 2] = 210 - 60 * t;
      data[o + 3] = t < 0.5 ? 255 : 0;
    }
  }
  return { width: w, height: h, data };
}

const CLOUDS = [bakeCloudLayer({ cover: 0.55, scale: 0.6, wind: [0.04, 0.01], color: [1, 1, 1], opacity: 0.8, seed: 7 })];
const SHAFTS: SunShafts = { strength: 1.4, length: 0.9 };
const SUN_COLOR: [number, number, number] = [1, 0.9, 0.7];

function sky(map: DecodedTexture): PresentSky {
  return { map, view: VIEW, projection: PROJECTION, sun: { direction: SUN_DIRECTION, color: SUN_COLOR }, clouds: CLOUDS, time: 3 };
}

/** A HUD frame: near-black void, a bright bar (covers), and a dim mark (under the key, lets the scene show). */
function hudFrame(): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const o = (y * W + x) * 4;
      out[o + 3] = 255;
      if (y >= H - 6 && x >= 10 && x < 50) out.set([240, 230, 90, 255], o);
      else if (y >= 4 && y < 8 && x >= 70) out.set([8, 6, 5, 255], o);
    }
  }
  return out;
}

/** A premultiplied holo layer: a half-covering cyan panel and an added glow. */
function holoLayer(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 8; y < 20; y += 1) {
    for (let x = 8; x < 40; x += 1) {
      const o = (y * W + x) * 4;
      out.set(x < 24 ? [40, 110, 120, 128] : [30, 60, 70, 0], o);
    }
  }
  return out;
}

/** The byte path's composite (gpuFrame.ts compositeFrame): a GPU frame over what's beneath it. */
function compositeOver(frame: Uint8ClampedArray, layer: ArrayLike<number>): void {
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    const a = layer[o + 3]!;
    if (a === 255) {
      frame[o] = layer[o]!;
      frame[o + 1] = layer[o + 1]!;
      frame[o + 2] = layer[o + 2]!;
      frame[o + 3] = 255;
    } else if (a > 0 || layer[o]! || layer[o + 1]! || layer[o + 2]!) {
      const k = (255 - a) / 255;
      frame[o] = layer[o]! + frame[o]! * k;
      frame[o + 1] = layer[o + 1]! + frame[o + 1]! * k;
      frame[o + 2] = layer[o + 2]! + frame[o + 2]! * k;
      frame[o + 3] = a + frame[o + 3]! * k;
    }
  }
}

/** The byte path's HUD key (compositeHudOverScene, threshold 30). */
function keyHud(frame: Uint8ClampedArray, hud: Uint8Array): void {
  for (let i = 0; i < W * H; i += 1) {
    const o = i * 4;
    if (hud[o]! + hud[o + 1]! + hud[o + 2]! > 30) frame.set([hud[o]!, hud[o + 1]!, hud[o + 2]!, 255], o);
  }
}

function difference(a: ArrayLike<number>, b: ArrayLike<number>): { mean: number; max: number; over8: number } {
  let sum = 0;
  let max = 0;
  let over8 = 0;
  for (let i = 0; i < W * H; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a[i * 4 + c]! - b[i * 4 + c]!);
      sum += d;
      max = Math.max(max, d);
      if (d > 8) over8 += 1;
    }
  }
  return { mean: sum / (W * H * 3), max, over8 };
}

describe("GPU presentation, without a device", () => {
  it("packs the sky's camera, sun, clock and cloud layers where the shader reads them", () => {
    const data = packSkyUniforms(sky(panorama()), W, H);
    expect(data.length).toBe(SKY_UNIFORM_FLOATS);
    // Camera right/up/back rows, with 1/p00 and 1/p11.
    [VIEW[0], VIEW[4], VIEW[8]].forEach((v, i) => expect(data[i * 4]).toBeCloseTo(v!, 6));
    expect(data[3]).toBeCloseTo(1 / PROJECTION[0]!, 5);
    expect(data[7]).toBeCloseTo(1 / PROJECTION[5]!, 5);
    expect(data[11]).toBe(1); // one cloud layer
    // The sun normalised, flagged on; its colour and the clock; the frame size.
    expect(Math.hypot(data[12]!, data[13]!, data[14]!)).toBeCloseTo(1, 5);
    expect(data[15]).toBe(1);
    expect(Array.from(data.slice(16, 20))).toEqual([1, 0.9, 0.7, 3].map(Math.fround));
    expect(Array.from(data.slice(20, 22))).toEqual([W, H]);
    // The layer: scale, wind, opacity, then colour.
    expect(Array.from(data.slice(24, 28))).toEqual([0.6, 0.04, 0.01, 0.8].map(Math.fround));
  });

  it("runs the shafts on the CPU pass's grid", () => {
    // 160 cells across at most, as applySunShafts steps.
    expect(shaftGrid(1280, 720)).toEqual({ step: 8, width: 160, height: 90 });
    expect(shaftGrid(1920, 1080)).toEqual({ step: 12, width: 160, height: 90 });
    expect(shaftGrid(96, 64)).toEqual({ step: 1, width: 96, height: 64 });
    const u = packShaftUniforms({ x: 640, y: 200 }, SHAFTS, SUN_COLOR, 1280, 720);
    expect(u[3]).toBe(8);
    expect([u[8], u[9]]).toEqual([79.5, 24.5]); // the sun in cell units, as the CPU centres cells
    expect(u[10]).toBeCloseTo(0.9 * Math.hypot(160, 90), 3);
  });

  it("flags the layers a frame carries", () => {
    const frame: PresentFrame = { base: { kind: "colour", rgba: [70, 104, 152, 255] }, scene: {}, hud: new Uint8Array(4), hudKey: 30 };
    const u = packComposeUniforms(frame, W, H);
    expect(u.length).toBe(COMPOSE_UNIFORM_FLOATS);
    expect(Array.from(u.slice(0, 8))).toEqual([0, 1, 0, 0, 1, 0, 30, Math.fround(0.35)]);
    expect(u[8]).toBeCloseTo(70 / 255, 5);
    // Shafts only ever over a sky.
    expect(packComposeUniforms({ ...frame, shafts: { sun: { x: 1, y: 1 }, color: SUN_COLOR, shafts: SHAFTS } }, W, H)[2]).toBe(0);
  });
});

describe.skipIf(!device)("GPU presentation, on a real device", () => {
  function draw(): SceneDraw {
    return { width: W, height: H, out: new Uint8ClampedArray(W * H * 4), depth: new Float32Array(W * H), view: VIEW, projection: PROJECTION, background: null };
  }

  it("keeps the frame on the GPU: the texture is exactly what the readback composites", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = scene();
    renderer.render(instances, draw());
    for (let i = 0; i < 200 && !renderer.ready; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      device.tick?.();
    }
    expect(renderer.ready).toBe(true);
    const viaReadback = draw();
    renderer.render(instances, viaReadback);
    const texture = renderer.renderToTexture(instances, { width: W, height: H, view: VIEW, projection: PROJECTION });
    expect(texture).not.toBeNull();
    const kept = await readTexture(texture, W, H);
    expect(kept.filter((_, i) => i % 4 === 3 && kept[i] === 255).length).toBeGreaterThan(500);
    expect(difference(kept, viaReadback.out).max).toBe(0);
    // A frame with nothing in it reads as nothing: the last frame doesn't linger.
    const empty = await readTexture(renderer.renderToTexture([], { width: W, height: H, view: VIEW, projection: PROJECTION }), W, H);
    expect(empty.every((v) => v === 0)).toBe(true);
    renderer.dispose();
  });

  it("composites sky, scene, sun shafts, HUD and holo as the byte path does", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const instances = scene();
    const sceneTexture = renderer.renderToTexture(instances, { width: W, height: H, view: VIEW, projection: PROJECTION });
    const sceneBytes = await readTexture(sceneTexture, W, H);
    const map = panorama();
    const hud = hudFrame();
    const holo = holoLayer();
    const sun = sunScreenPosition(SUN_DIRECTION, VIEW, PROJECTION, W, H)!;
    expect(sun.x).toBeGreaterThan(0);
    expect(sun.x).toBeLessThan(W);
    expect(sun.y).toBeGreaterThan(0);
    expect(sun.y).toBeLessThan(H);

    // The byte path: sky, scene over it, shafts, HUD, holo.
    const expected = new Uint8ClampedArray(W * H * 4);
    // A ray a pixel, as the GPU casts them (the default 8-pixel grid interpolates between rays).
    renderSkyBackground(expected, W, H, VIEW, PROJECTION, map, 1, 1, { layers: CLOUDS, time: 3 }, { direction: SUN_DIRECTION, color: SUN_COLOR });
    const skyBytes = expected.slice();
    compositeOver(expected, sceneBytes);
    const luminance = frameLuminance(expected, W, H);
    const visible = sunVisibility(expected, skyBytes, W, H, sun);
    applySunShafts(expected, skyBytes, W, H, sun, SUN_COLOR, SHAFTS);
    keyHud(expected, hud);
    compositeOver(expected, holo);

    // The GPU path, into a texture of our own (a canvas's, in the player).
    const presenter = new GpuPresenter(device, W, H);
    const target = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 }); // RENDER_ATTACHMENT | COPY_SRC
    device.pushErrorScope("validation");
    const frame: PresentFrame = {
      base: { kind: "sky", sky: sky(map) },
      scene: sceneTexture,
      shafts: { sun, color: SUN_COLOR, shafts: SHAFTS },
      hud,
      hudKey: 30,
      holo,
      measure: { luminance: true, sun },
    };
    presenter.present(frame, target, "rgba8unorm");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const got = await readTexture(target, W, H);

    const d = difference(got, expected);
    expect(d.mean).toBeLessThan(0.5);
    expect(d.over8).toBe(0);
    // The HUD bar and the holo panel land exactly.
    const at = (o: ArrayLike<number>, x: number, y: number) => Array.from({ length: 3 }, (_, c) => o[(y * W + x) * 4 + c]!);
    expect(at(got, 20, H - 3)).toEqual([240, 230, 90]);
    for (const [x, y] of [[12, 12], [30, 15], [80, 5]] as const) {
      at(got, x, y).forEach((v, c) => expect(Math.abs(v - at(expected, x, y)[c]!)).toBeLessThanOrEqual(2));
    }

    // The measurements arrive a moment later, matching the CPU's.
    for (let i = 0; i < 200 && presenter.stats.seq === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      device.tick?.();
    }
    expect(presenter.stats.seq).toBe(1);
    expect(presenter.stats.luminance!).toBeCloseTo(luminance, 2);
    expect(presenter.stats.sunVisible).toBeCloseTo(visible, 5);

    presenter.dispose();
    target.destroy();
    renderer.dispose();
  });

  it("draws the sky dome, its sun's glow and its clouds as the CPU backdrop does, ray for ray", async () => {
    const map = panorama();
    const expected = new Uint8ClampedArray(W * H * 4);
    renderSkyBackground(expected, W, H, VIEW, PROJECTION, map, 1, 1, { layers: CLOUDS, time: 3 }, { direction: SUN_DIRECTION, color: SUN_COLOR });
    const presenter = new GpuPresenter(device, W, H);
    const target = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    presenter.present({ base: { kind: "sky", sky: sky(map) }, scene: null }, target, "rgba8unorm");
    const got = await readTexture(target, W, H);
    const d = difference(got, expected);
    expect(d.max).toBeLessThanOrEqual(2);
    expect(d.mean).toBeLessThan(0.3);
    // And the clouds drift: a later clock moves them.
    presenter.present({ base: { kind: "sky", sky: { ...sky(map), time: 40 } }, scene: null }, target, "rgba8unorm");
    expect(difference(await readTexture(target, W, H), got).mean).toBeGreaterThan(0.5);
    presenter.dispose();
    target.destroy();
  });

  it("finishes the frame through the post stack when one is set", async () => {
    const map = panorama();
    const presenter = new GpuPresenter(device, W, H);
    const target = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    presenter.present({ base: { kind: "sky", sky: sky(map) }, scene: null }, target, "rgba8unorm");
    const plain = await readTexture(target, W, H);
    device.pushErrorScope("validation");
    const uniforms = uniformsFromSettings(parsePostFxSettings(LOCKOUT_FX)!);
    presenter.present({ base: { kind: "sky", sky: sky(map) }, scene: null, post: { uniforms, time: 0 } }, target, "rgba8unorm");
    const error = await settled(device.popErrorScope());
    expect(error ? String((error as any).message ?? error) : null).toBeNull();
    const graded = await readTexture(target, W, H);
    // Lockout's grade, LUT and vignette move the picture (the WebGL parity of the stack is gpu-postfx.test.ts).
    expect(difference(graded, plain).mean).toBeGreaterThan(2);
    // The vignette darkens the corners more than the centre.
    const lum = (o: ArrayLike<number>, x: number, y: number) => o[(y * W + x) * 4]! + o[(y * W + x) * 4 + 1]! + o[(y * W + x) * 4 + 2]!;
    expect(lum(plain, 1, 1) - lum(graded, 1, 1)).toBeGreaterThan(lum(plain, W / 2, H / 2) - lum(graded, W / 2, H / 2));
    presenter.dispose();
    target.destroy();
  });

  it("shows the cart's own frame beneath the scene in third person", async () => {
    const renderer = (await WebgpuSceneRenderer.create(device, W, H))!;
    const sceneTexture = renderer.renderToTexture(scene(), { width: W, height: H, view: VIEW, projection: PROJECTION });
    const sceneBytes = await readTexture(sceneTexture, W, H);
    const cart = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i += 1) cart.set([(i * 7) & 255, (i * 3) & 255, 90, 255], i * 4);
    const expected = new Uint8ClampedArray(cart);
    compositeOver(expected, sceneBytes);
    const presenter = new GpuPresenter(device, W, H);
    const target = device.createTexture({ size: { width: W, height: H }, format: "rgba8unorm", usage: 0x10 | 0x01 });
    presenter.present({ base: { kind: "frame", rgba: cart }, scene: sceneTexture }, target, "rgba8unorm");
    const got = await readTexture(target, W, H);
    expect(difference(got, expected).max).toBeLessThanOrEqual(1);
    presenter.dispose();
    target.destroy();
    renderer.dispose();
  });
});
