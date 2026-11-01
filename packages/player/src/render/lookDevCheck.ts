/**
 * The look-dev stage's check (AAA_FIDELITY_ROADMAP.md F10c): the stage drawn by
 * the linear-light renderer and by the path-traced reference (F10b) at the same
 * size, and what each makes of the props whose answers are known.
 *
 * - **The grey ball** is an 18% card made round: its mean light, raster and
 *   reference, says whether the rig's level reads as it should.
 * - **The chrome ball** shows what the surroundings reflect.
 * - **The frame**: the mean relative difference in luminance between the two
 *   images, where both drew something, and the share of those pixels more
 *   than 10% apart. An asset that passes under every rig is lit by the
 *   renderer as the reference lights it.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { multiplyMat4, type Mat4, type MeshSceneInstance } from "@cartbox/editor";

import { PathTracer } from "./pathTracer.js";
import type { GpuSceneDraw } from "./sceneRenderer.js";
import type { LookDevStage } from "./lookDev.js";
import { MODELS } from "../models.js";
import { rasterStyleFor } from "./renderCaps.js";
import { WebgpuSceneRenderer } from "./WebgpuSceneRenderer.js";

/** A frame's pixels as linear RGBA floats, top row first. */
export interface LinearImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** What the check found; light in linear units, before exposure. */
export interface LookDevCheck {
  readonly greyBall: { readonly raster: number; readonly reference: number } | null;
  readonly chromeBall: { readonly raster: number; readonly reference: number } | null;
  /** The mean of |raster − reference| / reference in luminance over the pixels both drew. */
  readonly frameError: number;
  /** The share of those pixels more than 10% apart. */
  readonly outliers: number;
  readonly raster: LinearImage;
  readonly reference: LinearImage;
}

const luminance = (d: Float32Array, i: number) => 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

/** Read an rgba16float texture back as floats. `wait` settles a GPU promise (a test's device must be ticked). */
export async function readLinearTexture(device: any, texture: any, width: number, height: number, wait: <T>(p: Promise<T>) => Promise<T> = (p) => p): Promise<LinearImage> {
  const bytesPerRow = Math.ceil((width * 8) / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x01 | 0x08 });
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, { width, height });
  device.queue.submit([encoder.finish()]);
  await wait(buffer.mapAsync(0x01));
  const halves = new Uint16Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  buffer.destroy();
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width * 4; x += 1) data[y * width * 4 + x] = half(halves[(y * bytesPerRow) / 2 + x]!);
  return { width, height, data };
}

/** The draw a stage is seen through at `width × height`: its lights, sky and camera, the sun's cascades and the local lights' shadows. */
export function lookDevDraw(stage: LookDevStage, width: number, height: number): GpuSceneDraw {
  const sun = stage.lights.find((l) => l.kind === "directional" && l.intensity > 0);
  return {
    width,
    height,
    view: stage.view,
    projection: stage.projection,
    ambient: stage.ambient,
    lightDirection: sun?.direction ?? [0, 1, 0],
    environment: stage.environment,
    lights: stage.lights,
    prepass: true,
    localShadowCasters: stage.instances,
    ...(sun?.direction ? { sunShadow: { casters: stage.instances, toLight: sun.direction, distance: 60, size: 2048, reach: 60, strength: 1 } } : {}),
  } as GpuSceneDraw;
}

/** The mean luminance inside the middle 60% of a ball's disc on screen, or null where it is off screen. */
function ballLight(image: LinearImage, viewProj: Mat4, ball: { readonly centre: readonly [number, number, number]; readonly radius: number }, view: Mat4): number | null {
  const project = ([x, y, z]: readonly number[]) => {
    const m = viewProj;
    const w = m[3]! * x! + m[7]! * y! + m[11]! * z! + m[15]!;
    return [((m[0]! * x! + m[4]! * y! + m[8]! * z! + m[12]!) / w + 1) * 0.5 * image.width, (1 - (m[1]! * x! + m[5]! * y! + m[9]! * z! + m[13]!) / w) * 0.5 * image.height] as const;
  };
  const [cx, cy] = project(ball.centre);
  // The camera's up in world space (the view's second row), so the disc's radius on screen is measured square on.
  const up = [view[1]!, view[5]!, view[9]!];
  const [, ey] = project([ball.centre[0] + up[0]! * ball.radius, ball.centre[1] + up[1]! * ball.radius, ball.centre[2] + up[2]! * ball.radius]);
  const r = Math.abs(cy - ey) * 0.6;
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height || (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue;
      sum += luminance(image.data, (y * image.width + x) * 4);
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Draw `stage` both ways at `width × height` (the reference with `samples` a
 * pixel) and compare them; see the module comment.
 */
export async function checkLookDev(device: any, stage: LookDevStage, width: number, height: number, samples = 256, wait: <T>(p: Promise<T>) => Promise<T> = (p) => p): Promise<LookDevCheck> {
  const draw = lookDevDraw(stage, width, height);
  // As the AAA tier makes it: textures filtered, with mips (F1a).
  const renderer = await WebgpuSceneRenderer.create(device, width, height, rasterStyleFor(MODELS.aaa.renderCaps), { hdr: true, mips: true });
  if (!renderer) throw new Error("The look-dev check needs the linear-light WebGPU renderer.");
  const tracer = PathTracer.create(device);
  try {
    // A few frames, so what the raster carries from frame to frame (probes, shadows' caches) settles.
    let texture: any = null;
    for (let i = 0; i < 3; i += 1) texture = renderer.renderToTexture(stage.instances as MeshSceneInstance[], draw);
    const raster = await readLinearTexture(device, texture, width, height, wait);
    let traced: any = null;
    const perFrame = Math.max(1, Math.min(samples, Math.floor((1 << 20) / (width * height))));
    while (tracer.samples < samples) {
      traced = tracer.render(stage.instances, draw, width, height, { samplesPerFrame: Math.min(perFrame, samples - tracer.samples) });
      await wait(device.queue.onSubmittedWorkDone());
    }
    const reference = await readLinearTexture(device, traced, width, height, wait);
    const viewProj = multiplyMat4(stage.projection, stage.view);
    const balls = (ball: LookDevStage["greyBall"]) => {
      if (!ball) return null;
      const a = ballLight(raster, viewProj, ball, stage.view);
      const b = ballLight(reference, viewProj, ball, stage.view);
      return a === null || b === null ? null : { raster: a, reference: b };
    };
    let error = 0;
    let outliers = 0;
    let n = 0;
    for (let i = 0; i < width * height * 4; i += 4) {
      if (raster.data[i + 3]! < 0.5 || reference.data[i + 3]! < 0.5) continue;
      const a = luminance(raster.data, i);
      const b = luminance(reference.data, i);
      const e = Math.abs(a - b) / Math.max(b, 1e-3);
      error += e;
      if (e > 0.1) outliers += 1;
      n += 1;
    }
    return { greyBall: balls(stage.greyBall), chromeBall: balls(stage.chromeBall), frameError: n > 0 ? error / n : 0, outliers: n > 0 ? outliers / n : 0, raster, reference };
  } finally {
    tracer.destroy();
    renderer.dispose();
  }
}
