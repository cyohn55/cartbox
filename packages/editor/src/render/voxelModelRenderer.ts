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

function normalizeTriple(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
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
  const yaw = options.yaw ?? 0;
  const pitch = options.pitch ?? 0.42;
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

  const [lx, ly, lz] = normalizeTriple(light.direction[0], light.direction[1], light.direction[2]);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const centre = size / 2;

  // Rotate one model point to screen (x,y) plus camera depth (larger = nearer).
  const project = (px: number, py: number, pz: number): [number, number, number] => {
    const yawX = px * cosY + pz * sinY;
    const yawZ = -px * sinY + pz * cosY;
    const camY = py * cosP - yawZ * sinP;
    const camZ = py * sinP + yawZ * cosP;
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

    for (let f = 0; f < faces.length; f += 1) {
      const face = faces[f]!;
      if ((mask & face.bit) === 0) continue; // face is inside the object

      // Rotate the face normal and cull it if it turns away from the viewer.
      const [fnx, fny, fnz] = face.normal;
      const nYawX = fnx * cosY + fnz * sinY;
      const nYawZ = -fnx * sinY + fnz * cosY;
      const worldNy = fny * cosP - nYawZ * sinP;
      const worldNz = fny * sinP + nYawZ * cosP;
      if (worldNz <= 0.0001) continue;
      const worldNx = nYawX;

      const diffuse = Math.max(0, worldNx * lx + worldNy * ly + worldNz * lz);
      const shade = light.ambient + (1 - light.ambient) * diffuse * light.intensity;
      const r = litChannel(model.r[v]!, shade, light.color[0], emissive);
      const g = litChannel(model.g[v]!, shade, light.color[1], emissive);
      const b = litChannel(model.b[v]!, shade, light.color[2], emissive);

      for (let c = 0; c < 4; c += 1) {
        const off = face.corners[c]!;
        corners[c] = project(vx + off[0], vy + off[1], vz + off[2]);
      }
      fillQuad(data, depth, size, corners, r, g, b, pickVoxel, pickFace, v, f);
    }
  }

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
