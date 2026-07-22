/**
 * Renders a rotatable {@link VoxelModel} to lit RGBA from any yaw/pitch.
 *
 * Orthographic projection with a z-buffer, drawing every voxel as a real cube:
 * each of its exposed faces is rotated (yaw about the vertical axis, then a
 * fixed pitch to tip the model toward the viewer), projected to screen as a
 * quad, and filled with the z-buffer keeping the nearest face per output pixel.
 * Each face is lit by *its own* normal against a *world-fixed* light, so the top,
 * front and sides of every cube read at different brightness — that per-face
 * shading is what makes the object look built from solid blocks rather than a
 * flat slab, and spinning turns each face into and out of the light.
 * Self-emissive voxels keep their glow in shadow.
 *
 * Pure and DOM-free, matching the other renderers, so the browser and the unit
 * tests drive it identically and assert on real output pixels.
 */

import type { VoxelModel } from "./voxelModel";
import { modelDiagonal } from "./voxelModel";
import { CUBE_GEOMETRY } from "./cellGeometry";
import { tileAt, type FaceTexture, type TextureAtlas } from "./faceTexture";

/** A directional light fixed in world space (not rotated with the model). */
export interface ModelLight {
  /** Unit vector from the surface toward the light (x right, y up, z to viewer). */
  readonly direction: readonly [number, number, number];
  /** Light colour, each channel 0..1. */
  readonly color: readonly [number, number, number];
  /** Direct-light strength (0 = ambient only). */
  readonly intensity: number;
  /** Minimum brightness in shadow, 0..1. */
  readonly ambient: number;
}

export const DEFAULT_MODEL_LIGHT: ModelLight = {
  direction: normalizeTriple(0.4, 0.7, 0.6),
  color: [1, 1, 1],
  intensity: 1,
  ambient: 0.32,
};

export interface RenderModelOptions {
  /** Rotation about the vertical axis, radians. Default 0. */
  readonly yaw?: number;
  /** Tip toward the viewer, radians (positive shows the top). Default 0.42. */
  readonly pitch?: number;
  /** Output pixels per voxel. Default 3. */
  readonly cell?: number;
  /** World-fixed light. Default {@link DEFAULT_MODEL_LIGHT}. */
  readonly light?: ModelLight;
  /**
   * Texture tiles the model's per-voxel `tile` indices sample from. Without it (or
   * for voxels with no tile), faces render with their flat colour.
   */
  readonly atlas?: TextureAtlas;
  /** Reuse this output buffer + z-buffer (must match the returned size). */
  readonly out?: Uint8ClampedArray;
  readonly depthBuffer?: Float32Array;
  /**
   * Explicit square output size in pixels. Defaults to {@link voxelCanvasSize},
   * which grows the canvas with the model so nothing ever clips. Pass a fixed
   * size to render into a stable viewport instead — then `cell` scales the model
   * *within* that viewport (true zoom), and the model is drawn about its centre.
   */
  readonly size?: number;
  /**
   * Optional picking outputs (size × size). When provided, each pixel records the
   * index of the voxel whose face won it (`-1` where nothing was drawn) and which
   * face (the index into the model's cell geometry — 0..5 for a cube, 0..11 for a
   * hexel; `-1` = none). Lets a 3D editor turn a cursor position into the voxel
   * and face under it.
   */
  readonly pickVoxel?: Int32Array;
  readonly pickFace?: Int8Array;
}

export interface VoxelRender {
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly width: number;
  readonly height: number;
  /** Present only when requested via {@link RenderModelOptions.pickVoxel}. */
  readonly pickVoxel?: Int32Array;
  readonly pickFace?: Int8Array;
}

export function normalizeTriple(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

/**
 * The per-frame camera and buffer state shared by single-model rendering and the
 * multi-model scene compositor (sceneRenderer.ts). It holds the resolved trig,
 * the normalized light, the shared colour/depth buffers and optional pick
 * buffers, so every placed model draws into the *same* image and z-buffer under
 * one camera — the property that lets voxels, hexels and pixel layers composite
 * by true depth rather than by draw order.
 */
export interface DrawContext {
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;
  /** Square edge length of the buffers, in pixels. */
  readonly size: number;
  /** Screen-space point the world origin projects to (usually `size / 2`). */
  readonly centre: number;
  /** Output pixels per world unit (zoom). */
  readonly cell: number;
  readonly cosYaw: number;
  readonly sinYaw: number;
  readonly cosPitch: number;
  readonly sinPitch: number;
  /** Pre-normalized light direction, split for the hot loop. */
  readonly lx: number;
  readonly ly: number;
  readonly lz: number;
  readonly light: ModelLight;
  readonly pickVoxel?: Int32Array;
  readonly pickFace?: Int8Array;
}

/**
 * Build a {@link DrawContext} for a camera looking at the world with the given
 * yaw/pitch/zoom, into buffers of `size` pixels. Shared so the single-model and
 * scene paths resolve the camera identically.
 */
export function makeDrawContext(params: {
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly size: number;
  readonly cell: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly light: ModelLight;
  readonly centre?: number;
  readonly pickVoxel?: Int32Array;
  readonly pickFace?: Int8Array;
}): DrawContext {
  const [lx, ly, lz] = normalizeTriple(
    params.light.direction[0],
    params.light.direction[1],
    params.light.direction[2],
  );
  return {
    data: params.data,
    depth: params.depth,
    size: params.size,
    centre: params.centre ?? params.size / 2,
    cell: params.cell,
    cosYaw: Math.cos(params.yaw),
    sinYaw: Math.sin(params.yaw),
    cosPitch: Math.cos(params.pitch),
    sinPitch: Math.sin(params.pitch),
    lx,
    ly,
    lz,
    light: params.light,
    pickVoxel: params.pickVoxel,
    pickFace: params.pickFace,
  };
}

/**
 * Draw one model into the context's shared buffers, translated by `offset` in
 * world space (the model's centred coordinates plus the offset give its world
 * position minus the camera origin). Buffers are **not** cleared here, so many
 * models accumulate into one image and z-buffer.
 *
 * `pickId` is what the pick buffers record for pixels this model wins: pass a
 * per-instance id when compositing a scene, or leave it undefined to record each
 * voxel's own index (what a single-model editor pick needs).
 */
export function drawModelInto(
  ctx: DrawContext,
  model: VoxelModel,
  offset: readonly [number, number, number],
  pickId?: number,
  atlas?: TextureAtlas,
): void {
  const { data, depth, size, centre, cell, light, pickVoxel, pickFace } = ctx;
  const { cosYaw, sinYaw, cosPitch, sinPitch, lx, ly, lz } = ctx;
  const [ox, oy, oz] = offset;
  const tiles = model.tile;

  // Rotate one world point (model point + offset) to screen (x,y) + camera depth.
  const project = (px: number, py: number, pz: number): [number, number, number] => {
    const wx = px + ox;
    const wy = py + oy;
    const wz = pz + oz;
    const yawX = wx * cosYaw + wz * sinYaw;
    const yawZ = -wx * sinYaw + wz * cosYaw;
    const camY = wy * cosPitch - yawZ * sinPitch;
    const camZ = wy * sinPitch + yawZ * cosPitch;
    return [centre + yawX * cell, centre - camY * cell, camZ];
  };

  // Reused per-face corner buffer to avoid per-face allocation.
  const corners: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  // Draw whichever cell the model was built from (cubes for older models).
  const faces = (model.geometry ?? CUBE_GEOMETRY).faces;

  for (let v = 0; v < model.count; v += 1) {
    const vx = model.x[v]!;
    const vy = model.y[v]!;
    const vz = model.z[v]!;
    const mask = model.faces[v]!;
    const emissive = model.emissive[v]!;
    const id = pickId ?? v;
    // Which tile (if any) skins this voxel's faces; undefined = flat colour.
    const tex = tiles ? tileAt(atlas, tiles[v]!) : undefined;

    for (let f = 0; f < faces.length; f += 1) {
      const face = faces[f]!;
      if ((mask & face.bit) === 0) continue; // face is inside the object

      // Rotate the face normal and cull it if it turns away from the viewer.
      const [fnx, fny, fnz] = face.normal;
      const nYawX = fnx * cosYaw + fnz * sinYaw;
      const nYawZ = -fnx * sinYaw + fnz * cosYaw;
      const worldNy = fny * cosPitch - nYawZ * sinPitch;
      const worldNz = fny * sinPitch + nYawZ * cosPitch;
      if (worldNz <= 0.0001) continue;
      const worldNx = nYawX;

      const diffuse = Math.max(0, worldNx * lx + worldNy * ly + worldNz * lz);
      const shade = light.ambient + (1 - light.ambient) * diffuse * light.intensity;

      for (let c = 0; c < 4; c += 1) {
        const off = face.corners[c]!;
        corners[c] = project(vx + off[0], vy + off[1], vz + off[2]);
      }

      if (tex) {
        // Textured: sample each texel, tint it by the voxel's colour, and light it
        // by the face's shade. Tinting lets one grey "detail" tile serve many
        // colours (each handheld's body, each screen's hue) while the tile supplies
        // the grain; a white voxel shows the tile as authored.
        fillTexturedQuad(
          data, depth, size, corners, tex,
          model.r[v]!, model.g[v]!, model.b[v]!,
          shade, light.color, emissive, pickVoxel, pickFace, id, f,
        );
      } else {
        const r = litChannel(model.r[v]!, shade, light.color[0], emissive);
        const g = litChannel(model.g[v]!, shade, light.color[1], emissive);
        const b = litChannel(model.b[v]!, shade, light.color[2], emissive);
        fillQuad(data, depth, size, corners, r, g, b, pickVoxel, pickFace, id, f);
      }
    }
  }
}

/**
 * The square output size that holds the model at any rotation: the bounding
 * diagonal (so no corner clips as it spins) scaled by the cell size, plus a
 * one-voxel margin for the oversized splats.
 */
export function voxelCanvasSize(model: VoxelModel, cell: number): number {
  return Math.ceil(modelDiagonal(model) * cell) + cell * 2;
}

/**
 * Render `model` at the given rotation and light. Returns square RGBA (alpha 0
 * where nothing was drawn, so it composites cleanly over a background) plus the
 * z-buffer used, both sized by {@link voxelCanvasSize}.
 */
export function renderVoxelModel(model: VoxelModel, options: RenderModelOptions = {}): VoxelRender {
  const cell = Math.max(1, options.cell ?? 3);
  const light = options.light ?? DEFAULT_MODEL_LIGHT;
  const size = Math.max(1, Math.floor(options.size ?? voxelCanvasSize(model, cell)));

  const data = options.out ?? new Uint8ClampedArray(size * size * 4);
  const depth = options.depthBuffer ?? new Float32Array(size * size);
  const pickVoxel = options.pickVoxel;
  const pickFace = options.pickFace;
  data.fill(0);
  depth.fill(-Infinity);
  pickVoxel?.fill(-1);
  pickFace?.fill(-1);

  const ctx = makeDrawContext({
    data,
    depth,
    size,
    cell,
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? 0.42,
    light,
    pickVoxel,
    pickFace,
  });
  // A single model sits at the world origin; leaving pickId undefined records
  // each voxel's own index, which the editor's pick relies on.
  drawModelInto(ctx, model, [0, 0, 0], undefined, options.atlas);

  return { data, depth, width: size, height: size, pickVoxel, pickFace };
}

/**
 * Fill the projected cube face (an affine parallelogram) with a flat colour,
 * z-testing each pixel against the buffer so nearer faces win. The face's depth
 * is interpolated across it, since a tipped face spans a range of depths.
 */
function fillQuad(
  data: Uint8ClampedArray,
  depth: Float32Array,
  size: number,
  p: readonly [number, number, number][],
  r: number,
  g: number,
  b: number,
  pickVoxel: Int32Array | undefined,
  pickFace: Int8Array | undefined,
  voxelIndex: number,
  faceIndex: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(p[0]![0], p[1]![0], p[2]![0], p[3]![0])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(p[0]![0], p[1]![0], p[2]![0], p[3]![0])));
  const minY = Math.max(0, Math.floor(Math.min(p[0]![1], p[1]![1], p[2]![1], p[3]![1])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(p[0]![1], p[1]![1], p[2]![1], p[3]![1])));

  // Basis from corner 0 along the two edges; a pixel is inside when both
  // parametric coordinates land in [0,1]. Depth is affine in that basis.
  const ax = p[0]![0];
  const ay = p[0]![1];
  const ex = p[1]![0] - ax;
  const ey = p[1]![1] - ay;
  const gx = p[3]![0] - ax;
  const gy = p[3]![1] - ay;
  const det = ex * gy - ey * gx;
  if (Math.abs(det) < 1e-6) return; // face seen edge-on: no area to fill
  const z0 = p[0]![2];
  const zu = p[1]![2] - z0;
  const zv = p[3]![2] - z0;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const rx = px + 0.5 - ax;
      const ry = py + 0.5 - ay;
      const u = (rx * gy - ry * gx) / det;
      const w = (ex * ry - ey * rx) / det;
      if (u < 0 || u > 1 || w < 0 || w > 1) continue;
      const z = z0 + u * zu + w * zv;
      const di = py * size + px;
      if (z <= depth[di]!) continue;
      depth[di] = z;
      const o = di * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 255;
      if (pickVoxel) pickVoxel[di] = voxelIndex;
      if (pickFace) pickFace[di] = faceIndex;
    }
  }
}

/** Albedo scaled by the light, floored by its own emissive glow. */
function litChannel(albedo: number, shade: number, lightColor: number, emissive: number): number {
  return Math.max(albedo * shade * lightColor, albedo * emissive);
}

/**
 * Fill the projected face by sampling a {@link FaceTexture} across it. The face's
 * two edges from corner 0 form the UV basis, so the same parametric coordinates
 * `(u, w)` that test whether a pixel is inside the parallelogram also index the
 * tile — no extra per-pixel projection. Each texel is lit by the face's `shade`
 * (albedo varies across the face, unlike the flat fill) and floored by its
 * emissive, and fully transparent texels are skipped so the face shows through.
 */
function fillTexturedQuad(
  data: Uint8ClampedArray,
  depth: Float32Array,
  size: number,
  p: readonly [number, number, number][],
  tile: FaceTexture,
  tintR: number,
  tintG: number,
  tintB: number,
  shade: number,
  lightColor: readonly [number, number, number],
  voxelEmissive: number,
  pickVoxel: Int32Array | undefined,
  pickFace: Int8Array | undefined,
  voxelIndex: number,
  faceIndex: number,
): void {
  const minX = Math.max(0, Math.floor(Math.min(p[0]![0], p[1]![0], p[2]![0], p[3]![0])));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(p[0]![0], p[1]![0], p[2]![0], p[3]![0])));
  const minY = Math.max(0, Math.floor(Math.min(p[0]![1], p[1]![1], p[2]![1], p[3]![1])));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(p[0]![1], p[1]![1], p[2]![1], p[3]![1])));

  const ax = p[0]![0];
  const ay = p[0]![1];
  const ex = p[1]![0] - ax;
  const ey = p[1]![1] - ay;
  const gx = p[3]![0] - ax;
  const gy = p[3]![1] - ay;
  const det = ex * gy - ey * gx;
  if (Math.abs(det) < 1e-6) return; // face seen edge-on: no area to fill
  const z0 = p[0]![2];
  const zu = p[1]![2] - z0;
  const zv = p[3]![2] - z0;

  const tileSize = tile.size;
  const texels = tile.data;
  const texEmissive = tile.emissive;

  for (let py = minY; py <= maxY; py += 1) {
    for (let px = minX; px <= maxX; px += 1) {
      const rx = px + 0.5 - ax;
      const ry = py + 0.5 - ay;
      const u = (rx * gy - ry * gx) / det;
      const w = (ex * ry - ey * rx) / det;
      if (u < 0 || u > 1 || w < 0 || w > 1) continue;
      const z = z0 + u * zu + w * zv;
      const di = py * size + px;
      if (z <= depth[di]!) continue;

      // Sample the tile with u,w as UVs (clamped so the far edge stays in range).
      const tx = Math.min(tileSize - 1, (u * tileSize) | 0);
      const ty = Math.min(tileSize - 1, (w * tileSize) | 0);
      const ti = (ty * tileSize + tx) * 4;
      if (texels[ti + 3]! === 0) continue; // transparent texel: face shows through

      const glow = texEmissive ? Math.max(voxelEmissive, texEmissive[ty * tileSize + tx]! / 255) : voxelEmissive;
      depth[di] = z;
      const o = di * 4;
      // Tint the texel by the voxel colour (0..255 → scale by /255) before lighting.
      data[o] = litChannel((texels[ti]! * tintR) / 255, shade, lightColor[0], glow);
      data[o + 1] = litChannel((texels[ti + 1]! * tintG) / 255, shade, lightColor[1], glow);
      data[o + 2] = litChannel((texels[ti + 2]! * tintB) / 255, shade, lightColor[2], glow);
      data[o + 3] = 255;
      if (pickVoxel) pickVoxel[di] = voxelIndex;
      if (pickFace) pickFace[di] = faceIndex;
    }
  }
}
