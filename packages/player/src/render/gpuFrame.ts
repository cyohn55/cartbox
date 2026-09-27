/**
 * What the two GPU scene renderers (WebGPU and WebGL2) share: batching a
 * frame's instances into instanced draws, and presenting a frame while the GPU
 * pipeline lags one or two frames behind — compositing the newest readback, or
 * warming up on the software rasteriser before the first one lands.
 */

import type { DecodedTexture, Mat4, MeshAsset, MeshPrimitive, MeshSceneInstance } from "@cartbox/editor";

import type { SceneDraw, SoftwareSceneRenderer } from "./sceneRenderer.js";

/**
 * The largest job the software rasteriser takes on while the GPU pipeline
 * fills. Warming up avoids pop-in on small scenes, but a lit arena at 720p costs
 * the CPU seconds per frame (it is fill-bound as much as triangle-bound) — a
 * freeze on a tablet — so past either limit the opening frame or two simply
 * show what is behind the scene (the sky, or the cart's own frame).
 */
export const SOFTWARE_WARMUP_TRIANGLES = 20000;
export const SOFTWARE_WARMUP_PIXELS = 640 * 360;

/** Triangles per mesh, counted once. */
const triangleCounts = new WeakMap<MeshAsset, number>();
export function trianglesIn(instances: readonly MeshSceneInstance[]): number {
  let total = 0;
  for (const instance of instances) {
    let count = triangleCounts.get(instance.mesh);
    if (count === undefined) {
      count = instance.mesh.primitives.reduce((n, primitive) => n + primitive.indices.length / 3, 0);
      triangleCounts.set(instance.mesh, count);
    }
    total += count;
  }
  return total;
}

/**
 * Put a correct frame in `draw.out` now: the newest GPU frame when there is one,
 * else the software rasteriser's (for a job small enough), else just the
 * background.
 */
export function presentFrame(
  latest: Uint8Array | null,
  visible: readonly MeshSceneInstance[],
  draw: SceneDraw,
  software: SoftwareSceneRenderer,
): void {
  if (latest) {
    compositeFrame(latest, draw);
  } else if (draw.width * draw.height <= SOFTWARE_WARMUP_PIXELS && trianglesIn(visible) <= SOFTWARE_WARMUP_TRIANGLES) {
    software.render(visible, draw);
  } else if (draw.background !== null) {
    new Uint32Array(draw.out.buffer, draw.out.byteOffset, draw.width * draw.height).fill(packRgba(draw.background));
  }
}

/** Paint a completed GPU frame over the cart's own pixels. */
export function compositeFrame(latest: Uint8Array, draw: SceneDraw): void {
  const count = draw.width * draw.height;
  // Whole pixels as little-endian RGBA words: a quarter of the work of
  // copying channels, which matters at 720p every frame.
  const source = new Uint32Array(latest.buffer, latest.byteOffset, count);
  const out = new Uint32Array(draw.out.buffer, draw.out.byteOffset, count);
  if (draw.background !== null) out.fill(packRgba(draw.background));
  // The shader discards anything below the alpha threshold, so a zero alpha
  // means "nothing drawn here" and the cart's pixel survives — the same result
  // as the software path's `background: null`.
  for (let i = 0; i < count; i += 1) {
    const word = source[i]!;
    if (word >>> 24 !== 0) out[i] = word;
  }
}

/** An RGBA colour as one little-endian pixel word. */
export function packRgba([r, g, b, a]: readonly [number, number, number, number]): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** The four material maps a primitive's draw binds. */
export interface PrimitiveTextures {
  base: DecodedTexture | null;
  mr: DecodedTexture | null;
  occ: DecodedTexture | null;
  emis: DecodedTexture | null;
}

export function sameTextures(a: PrimitiveTextures, b: PrimitiveTextures): boolean {
  return a.base === b.base && a.mr === b.mr && a.occ === b.occ && a.emis === b.emis;
}

/** The copies of one primitive drawn together: one instanced draw. */
export interface DrawBatch<G> {
  primitive: MeshPrimitive;
  geometry: G;
  textures: PrimitiveTextures;
  models: Mat4[];
  /** Index of the batch's first copy in the instance data (set by the renderer). */
  first: number;
}

/**
 * Group a frame's instances into batches: every copy of a primitive that binds
 * the same textures, in the order each batch first appears. `geometryOf` uploads
 * (or finds) a mesh's per-primitive GPU geometry; a null or empty one is skipped.
 */
export function batchInstances<G extends { indexCount: number }>(
  instances: readonly MeshSceneInstance[],
  geometryOf: (mesh: MeshAsset) => readonly (G | undefined)[],
): { batches: DrawBatch<G>[]; instanceCount: number } {
  const batches: DrawBatch<G>[] = [];
  const byPrimitive = new Map<MeshPrimitive, DrawBatch<G>[]>();
  let instanceCount = 0;
  for (const instance of instances) {
    const geometries = geometryOf(instance.mesh);
    instance.mesh.primitives.forEach((primitive, index) => {
      const geometry = geometries[index];
      if (!geometry || geometry.indexCount === 0) return;
      const textures: PrimitiveTextures = {
        base: instance.textures?.[index] ?? null,
        mr: instance.mrTextures?.[index] ?? null,
        occ: instance.occlusionTextures?.[index] ?? null,
        emis: instance.emissiveTextures?.[index] ?? null,
      };
      let list = byPrimitive.get(primitive);
      if (!list) byPrimitive.set(primitive, (list = []));
      let batch = list.find((b) => sameTextures(b.textures, textures));
      if (!batch) {
        batch = { primitive, geometry, textures, models: [], first: 0 };
        list.push(batch);
        batches.push(batch);
      }
      batch.models.push(instance.model);
      instanceCount += 1;
    });
  }
  return { batches, instanceCount };
}
