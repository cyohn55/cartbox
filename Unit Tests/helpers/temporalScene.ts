/**
 * Temporal anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I2) on a real GPU,
 * shared by the WebGPU suite (Dawn in Node) and the WebGL2 one (a browser
 * page): thin bars, under a pixel wide, over a backdrop — the trim that
 * crawls without it — measured against a 4×-supersampled software frame.
 */

import { composeModelMatrix, projectionMatrix, viewMatrix, type DecodedTexture, type MeshAsset, type MeshSceneInstance } from "@cartbox/editor";

import type { SceneDraw } from "../../packages/player/src/render/sceneRenderer";

/** What the measurement needs of a GPU scene renderer. */
export interface GpuRenderer {
  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
  settle(draw: SceneDraw): string;
  dispose(): void;
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

/** A one-texel checkerboard, 48×12: drawn about a texel and a half to a pixel, it aliases however the edges are smoothed. */
function checker(): DecodedTexture {
  const width = 48;
  const height = 12;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = (x + y) % 2 ? 230 : 40;
      data.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/**
 * Six bars a little over half a pixel wide, at several angles, over a dark
 * backdrop, and below them a checkerboard too fine for the pixels (the
 * texture shimmer multisampling can't reach).
 */
export function barsScene(): MeshSceneInstance[] {
  const bars: MeshSceneInstance[] = [{ mesh: quad([0.15, 0.2, 0.3, 1]), model: composeModelMatrix([0, 0, -0.5], [0, 0, 0], [4, 3, 1]) }];
  const colours: [number, number, number, number][] = [[1, 0.9, 0.6, 1], [0.6, 1, 0.9, 1], [1, 0.6, 0.6, 1]];
  [4, 17, 31, 48, 66, 83].forEach((angle, i) => {
    bars.push({ mesh: quad(colours[i % 3]!), model: composeModelMatrix([(i - 2.5) * 0.25, (i % 2) * 0.3 - 0.15, 0], [0, 0, angle], [1.6, 0.03, 1]) });
  });
  bars.push({ mesh: quad([1, 1, 1, 1]), model: composeModelMatrix([0, -1.5, -0.2], [0, 0, 0], [1.6, 0.4, 1]), textures: [checker()] });
  return bars;
}

/** The frame: `width × height`, the camera `pan` units to the right. */
export function barsDraw(width: number, height: number, pan: number): SceneDraw {
  return {
    width,
    height,
    out: new Uint8ClampedArray(width * height * 4),
    depth: new Float32Array(width * height),
    view: viewMatrix([pan, 0, 4], [pan, 0, 0]),
    projection: projectionMatrix((60 * Math.PI) / 180, width / height, 0.1, 100),
    background: [0, 0, 0, 255],
  };
}

/** A `k`× frame averaged down to `width × height`. */
export function downsample(big: Uint8ClampedArray, width: number, height: number, k: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 4; c += 1) {
        let sum = 0;
        for (let dy = 0; dy < k; dy += 1) for (let dx = 0; dx < k; dx += 1) sum += big[((y * k + dy) * width * k + x * k + dx) * 4 + c]!;
        out[(y * width + x) * 4 + c] = sum / (k * k);
      }
    }
  }
  return out;
}

/** Mean absolute difference per colour channel. */
export function meanError(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c += 1) sum += Math.abs(a[i + c]! - b[i + c]!);
    n += 3;
  }
  return sum / n;
}

/**
 * How much a frame changed from the last that the scene didn't: the change
 * between two frames minus the change between their supersampled truths,
 * per colour channel. Crawling edges and shimmering texels score; real motion
 * doesn't.
 */
export function crawl(previous: Uint8ClampedArray, frame: Uint8ClampedArray, previousTruth: Uint8ClampedArray, truth: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frame.length; i += 4) {
    for (let c = 0; c < 3; c += 1) sum += Math.abs(frame[i + c]! - previous[i + c]! - (truth[i + c]! - previousTruth[i + c]!));
    n += 3;
  }
  return sum / n;
}

/** Draw a frame and wait until the GPU has finished exactly that one; its image. */
async function shown(renderer: GpuRenderer, instances: readonly MeshSceneInstance[], draw: SceneDraw, tick: () => void): Promise<Uint8ClampedArray> {
  renderer.render(instances, draw);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const view = { ...draw, out: new Uint8ClampedArray(draw.out.length) };
    if (renderer.settle(view) === "current") return view.out;
    await new Promise((resolve) => setTimeout(resolve, 10));
    tick();
  }
  throw new Error("the GPU frame never arrived");
}

export interface TemporalReport {
  /** Error of a plain frame against the supersampled one, with the camera still. */
  plain: number;
  /** The same after 24 temporal frames. */
  still: number;
  /** A plain frame after the camera pans about three pixels. */
  plainPanned: number;
  /** The first temporal frame after that pan (the history reprojected). */
  firstAfterPan: number;
  /** After 23 more temporal frames at the new position. */
  panned: number;
  /** The largest change between consecutive temporal frames over the last eight at the new position: the jitter's shimmer once settled. */
  settledChange: number;
  /** The mean {@link crawl} of plain frames as the camera then drifts a third of a pixel a frame, for twelve frames. */
  plainCrawl: number;
  /** The same for temporal frames. */
  temporalCrawl: number;
}

/**
 * Measure temporal anti-aliasing: a still camera, then a pan. `make` builds
 * the GPU renderer at a size, `reference` renders a frame on the software
 * rasteriser, `extra` adds to every draw (multisampling, say), `tick` lets the
 * GPU make progress while waiting.
 */
export async function temporalReport(
  make: (width: number, height: number) => Promise<GpuRenderer>,
  reference: (instances: readonly MeshSceneInstance[], draw: SceneDraw) => void,
  tick: () => void,
  width: number,
  height: number,
  extra: Partial<SceneDraw> = {},
): Promise<TemporalReport> {
  const instances = barsScene();
  const truth = (pan: number) => {
    const big = barsDraw(width * 4, height * 4, pan);
    reference(instances, big);
    return downsample(big.out, width, height, 4);
  };
  const truthA = truth(0);
  const truthB = truth(0.3);

  const plainRenderer = await make(width, height);
  const plainA = await shown(plainRenderer, instances, { ...barsDraw(width, height, 0), ...extra }, tick);
  const plainB = await shown(plainRenderer, instances, { ...barsDraw(width, height, 0.3), ...extra }, tick);
  // The drift: from 0.3 to the right, 0.03 a frame (about a third of a pixel at the bars).
  const drift = Array.from({ length: 13 }, (_, k) => 0.3 + 0.03 * k);
  const driftTruth = drift.map(truth);
  const meanCrawl = (frames: Uint8ClampedArray[]) => frames.slice(1).reduce((sum, f, k) => sum + crawl(frames[k]!, f, driftTruth[k]!, driftTruth[k + 1]!), 0) / (frames.length - 1);
  const plainDrift: Uint8ClampedArray[] = [];
  for (const pan of drift) plainDrift.push(await shown(plainRenderer, instances, { ...barsDraw(width, height, pan), ...extra }, tick));
  plainRenderer.dispose();

  const renderer = await make(width, height);
  const frame = (pan: number) => shown(renderer, instances, { ...barsDraw(width, height, pan), ...extra, temporal: true }, tick);
  let still = new Uint8ClampedArray(0);
  for (let i = 0; i < 24; i += 1) still = await frame(0);
  const firstAfterPan = await frame(0.3);
  let panned = firstAfterPan;
  let settledChange = 0;
  for (let i = 0; i < 23; i += 1) {
    const next = await frame(0.3);
    if (i >= 15) settledChange = Math.max(settledChange, meanError(next, panned));
    panned = next;
  }
  const temporalDrift = [panned];
  for (const pan of drift.slice(1)) temporalDrift.push(await frame(pan));
  renderer.dispose();
  return {
    plain: meanError(plainA, truthA),
    still: meanError(still, truthA),
    plainPanned: meanError(plainB, truthB),
    firstAfterPan: meanError(firstAfterPan, truthB),
    panned: meanError(panned, truthB),
    settledChange,
    plainCrawl: meanCrawl(plainDrift),
    temporalCrawl: meanCrawl(temporalDrift),
  };
}

/** What temporal anti-aliasing must achieve on the bars (the same on both GPU paths). */
export function expectTemporal(report: TemporalReport): void {
  const fail = (what: string) => {
    throw new Error(`temporal anti-aliasing: ${what} (${JSON.stringify(report)})`);
  };
  // Sub-pixel bars and a too-fine checkerboard: far nearer the supersampled frame than one sample per pixel gets.
  if (!(report.still < report.plain * 0.6)) fail("a still camera doesn't converge");
  // Reprojected through the pan: the very next frame keeps the history.
  if (!(report.firstAfterPan < report.plainPanned * 0.6)) fail("the history is lost in a pan");
  if (!(report.panned < report.plainPanned * 0.6)) fail("it doesn't converge after a pan");
  // Settled: the jitter barely moves the image.
  if (!(report.settledChange < 2)) fail("a still image shimmers");
  // A drifting camera: edges and texels stop crawling.
  if (!(report.temporalCrawl < report.plainCrawl * 0.5)) fail("a moving camera still crawls");
}
