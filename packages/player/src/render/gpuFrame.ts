/**
 * What the two GPU scene renderers (WebGPU and WebGL2) share: batching a
 * frame's instances into instanced draws, and presenting a frame while the GPU
 * pipeline lags one or two frames behind — compositing the newest readback, or
 * warming up on the software rasteriser before the first one lands.
 */

import { depthLinearTerms, effectActive, refracts, resolveRefraction, type DecodedTexture, type Mat4, type MeshAsset, type MeshPrimitive, type MeshSceneInstance, type SurfaceEffect } from "@cartbox/editor";

import type { SceneDraw, SoftwareSceneRenderer } from "./sceneRenderer.js";
import { resolvePbr } from "./scenePacking.js";

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
  // Opaque surfaces write alpha 255 and replace the pixel; nothing drawn reads
  // all zero and leaves the cart's pixel — the same result as the software
  // path's `background: null`. See-through surfaces (EP6) leave premultiplied
  // colour and their coverage: blended over the pixel beneath, or (an added
  // glow, coverage 0) added to it — what the software path does as it draws.
  const bytes = draw.out;
  for (let i = 0; i < count; i += 1) {
    const word = source[i]!;
    const a = word >>> 24;
    if (a === 255) out[i] = word;
    else if (word !== 0) {
      const k = (255 - a) / 255;
      const o = i * 4;
      bytes[o] = (word & 0xff) + bytes[o]! * k;
      bytes[o + 1] = ((word >>> 8) & 0xff) + bytes[o + 1]! * k;
      bytes[o + 2] = ((word >>> 16) & 0xff) + bytes[o + 2]! * k;
      bytes[o + 3] = a + bytes[o + 3]! * k;
    }
  }
}

/** An RGBA colour as one little-endian pixel word. */
export function packRgba([r, g, b, a]: readonly [number, number, number, number]): number {
  return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** The material maps a primitive's draw binds (the light map only with light-map UVs). */
export interface PrimitiveTextures {
  base: DecodedTexture | null;
  mr: DecodedTexture | null;
  /** The occlusion map, carrying the relief map in G and B when there is one (see {@link occlusionWithRelief}). */
  occ: DecodedTexture | null;
  emis: DecodedTexture | null;
  lm: DecodedTexture | null;
  /** The detail map (HALO2_STYLE_ROADMAP.md H3), or null. */
  detail: DecodedTexture | null;
  /** The blend surface's map (H4), or null. */
  blend: DecodedTexture | null;
  /** The relief map (I4), or null — bound inside {@link occ}, kept here so a draw knows it has one. */
  relief: DecodedTexture | null;
}

export function sameTextures(a: PrimitiveTextures, b: PrimitiveTextures): boolean {
  return a.base === b.base && a.mr === b.mr && a.occ === b.occ && a.emis === b.emis && a.lm === b.lm && a.detail === b.detail && a.blend === b.blend && a.relief === b.relief;
}

const NO_OCCLUSION = {};
const withRelief = new WeakMap<DecodedTexture, WeakMap<object, DecodedTexture>>();

/**
 * The occlusion map with a relief map packed beside it (I4): R = ambient
 * occlusion (white without an occlusion map), G = the relief's height, B = its
 * curvature, A = its thickness (1 − its B, the thinness a bake writes, I15). WebGL2 guarantees sixteen texture units and the scene shader
 * already binds sixteen, so the relief rides in the occlusion map's unused
 * channels rather than taking a unit of its own; WebGPU binds it the same way.
 * Made at the larger of the two maps' sizes (each sampled nearest at the
 * texel centres) and kept per pair, so it is built once per material.
 */
export function occlusionWithRelief(occ: DecodedTexture | null, relief: DecodedTexture | null): DecodedTexture | null {
  if (!relief) return occ;
  let byOcc = withRelief.get(relief);
  if (!byOcc) withRelief.set(relief, (byOcc = new WeakMap()));
  const key = occ ?? NO_OCCLUSION;
  const known = byOcc.get(key);
  if (known) return known;
  const bigger = occ && occ.width * occ.height > relief.width * relief.height ? occ : relief;
  const { width, height } = bigger;
  const data = new Uint8ClampedArray(width * height * 4);
  const texel = (t: DecodedTexture, x: number, y: number): number => {
    const tx = Math.min(t.width - 1, Math.floor(((x + 0.5) / width) * t.width));
    const ty = Math.min(t.height - 1, Math.floor(((y + 0.5) / height) * t.height));
    return (ty * t.width + tx) * 4;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const r = texel(relief, x, y);
      data[o] = occ ? occ.data[texel(occ, x, y)]! : 255;
      data[o + 1] = relief.data[r]!;
      data[o + 2] = relief.data[r + 1]!;
      data[o + 3] = 255 - relief.data[r + 2]!;
    }
  }
  const out: DecodedTexture = { width, height, data };
  byOcc.set(key, out);
  return out;
}

/** The copies of one primitive drawn together: one instanced draw. */
export interface DrawBatch<G> {
  primitive: MeshPrimitive;
  geometry: G;
  textures: PrimitiveTextures;
  models: Mat4[];
  /** The surface effect its copies carry (H11) — copies with an effect batch only with copies of the same one. */
  effect: SurfaceEffect | null;
  /**
   * The material's transparency (EP6): 0 opaque, 1 cut out, 2 blended, 3 added.
   * Blended and added copies are each a batch of their own, drawn after every
   * opaque batch, farthest first, without writing depth.
   */
  alpha: number;
  /**
   * The copies bend what's behind them (I5; refraction.ts): drawn after the
   * opaque scene, farthest first, reading a copy of it — whatever their alpha.
   */
  refract: boolean;
  /** Index of the batch's first copy in the instance data (set by the renderer). */
  first: number;
}

/** Whether a batch refracts (I5): a PBR draw whose material or surface effect bends what's behind it. */
export function batchRefracts(primitive: MeshPrimitive, textures: PrimitiveTextures, effect: SurfaceEffect | null): boolean {
  const material = primitive.material;
  if (!resolvePbr(material, textures.mr !== null, textures.occ !== null, textures.emis !== null).isPbr) return false;
  return refracts(resolveRefraction(material, effectActive(effect) ? effect : null));
}

/**
 * Group a frame's instances into batches: every copy of a primitive that binds
 * the same textures, in the order each batch first appears. `geometryOf` uploads
 * (or finds) a mesh's per-primitive GPU geometry; a null or empty one is skipped.
 */
export function batchInstances<G extends { indexCount: number }>(
  instances: readonly MeshSceneInstance[],
  geometryOf: (mesh: MeshAsset) => readonly (G | undefined)[],
  /** The camera's world position, to draw see-through copies farthest first. */
  eye: readonly [number, number, number] = [0, 0, 0],
): { batches: DrawBatch<G>[]; instanceCount: number } {
  const batches: DrawBatch<G>[] = [];
  const seeThrough: { batch: DrawBatch<G>; distance: number }[] = [];
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
        occ: occlusionWithRelief(instance.occlusionTextures?.[index] ?? null, instance.reliefTextures?.[index] ?? null),
        emis: instance.emissiveTextures?.[index] ?? null,
        lm: primitive.uvs2 ? (instance.lightmapTextures?.[index] ?? null) : null,
        detail: instance.detailTextures?.[index] ?? null,
        blend: primitive.blend ? (instance.blendTextures?.[index] ?? null) : null,
        relief: instance.reliefTextures?.[index] ?? null,
      };
      const effect = instance.effect ?? null;
      const alpha = alphaCode(primitive.material.alphaMode);
      const refract = batchRefracts(primitive, textures, effect);
      if (alpha >= 2 || refract) {
        const c = primitiveCentre(primitive);
        const m = instance.model;
        const x = m[0]! * c[0] + m[4]! * c[1] + m[8]! * c[2] + m[12]! - eye[0];
        const y = m[1]! * c[0] + m[5]! * c[1] + m[9]! * c[2] + m[13]! - eye[1];
        const z = m[2]! * c[0] + m[6]! * c[1] + m[10]! * c[2] + m[14]! - eye[2];
        seeThrough.push({ batch: { primitive, geometry, textures, models: [instance.model], effect, alpha, refract, first: 0 }, distance: x * x + y * y + z * z });
        instanceCount += 1;
        return;
      }
      let list = byPrimitive.get(primitive);
      if (!list) byPrimitive.set(primitive, (list = []));
      let batch = list.find((b) => b.effect === effect && sameTextures(b.textures, textures));
      if (!batch) {
        batch = { primitive, geometry, textures, models: [], effect, alpha, refract, first: 0 };
        list.push(batch);
        batches.push(batch);
      }
      batch.models.push(instance.model);
      instanceCount += 1;
    });
  }
  // See-through copies after the opaque scene, farthest first.
  seeThrough.sort((a, b) => b.distance - a.distance);
  for (const { batch } of seeThrough) batches.push(batch);
  return { batches, instanceCount };
}

/** A material's alpha mode as the shaders' code: 0 opaque, 1 cut out, 2 blended, 3 added. */
export function alphaCode(mode: MeshPrimitive["material"]["alphaMode"]): number {
  return mode === "mask" ? 1 : mode === "blend" ? 2 : mode === "additive" ? 3 : 0;
}

/**
 * A batch's soft edges (EP6b): the distance a see-through surface fades over
 * as it meets the opaque scene, with the projection terms that read depth back
 * as distance — or undefined for a hard edge (opaque, unsoftened, or an
 * orthographic view, where the software path keeps hard edges too).
 */
export function softEdges(material: MeshPrimitive["material"], alpha: number, projection: Mat4): { distance: number; linear: readonly [number, number] } | undefined {
  const distance = alpha >= 2 ? material.softDepth ?? 0 : 0;
  if (!(distance > 0) || projection[15] !== 0) return undefined;
  return { distance, linear: depthLinearTerms(projection) };
}

const centres = new WeakMap<MeshPrimitive, [number, number, number]>();
/** The centre of a primitive's bounding box (cached per primitive). */
function primitiveCentre(primitive: MeshPrimitive): [number, number, number] {
  let c = centres.get(primitive);
  if (!c) {
    const p = primitive.positions;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!);
      z0 = Math.min(z0, p[i + 2]!); z1 = Math.max(z1, p[i + 2]!);
    }
    c = Number.isFinite(x0) ? [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] : [0, 0, 0];
    centres.set(primitive, c);
  }
  return c;
}
