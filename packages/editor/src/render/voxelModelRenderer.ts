/**
 * Renders a rotatable {@link VoxelModel} to lit RGBA from any yaw/pitch.
 *
 * Orthographic projection with a z-buffer: every surface voxel is rotated (yaw
 * about the vertical axis, then a fixed pitch to tip the model toward the
 * viewer), projected to screen, and splatted as a small square, the z-buffer
 * keeping the nearest one per output pixel. Each voxel's model-space normal is
 * rotated the same way and lit against a *world-fixed* light, so as the model
 * spins its faces turn into and out of the light — the shading is what sells the
 * 3D. Self-emissive voxels keep their glow in shadow.
 *
 * Pure and DOM-free, matching the other renderers, so the browser and the unit
 * tests drive it identically and assert on real output pixels.
 */

import type { VoxelModel } from "./voxelModel";
import { modelDiagonal } from "./voxelModel";

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
}

export interface VoxelRender {
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly width: number;
  readonly height: number;
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

  const size = voxelCanvasSize(model, cell);
  const data = options.out ?? new Uint8ClampedArray(size * size * 4);
  const depth = options.depthBuffer ?? new Float32Array(size * size);
  data.fill(0);
  depth.fill(-Infinity);

  const [lx, ly, lz] = normalizeTriple(light.direction[0], light.direction[1], light.direction[2]);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const centre = size / 2;
  // Splat one output pixel wider than a cell so rotated voxels leave no seams.
  const half = cell / 2 + 0.5;

  for (let v = 0; v < model.count; v += 1) {
    // Rotate the voxel centre: yaw about Y, then pitch about X.
    const vx = model.x[v]!;
    const vy = model.y[v]!;
    const vz = model.z[v]!;
    const yawX = vx * cosY + vz * sinY;
    const yawZ = -vx * sinY + vz * cosY;
    const camY = vy * cosP - yawZ * sinP;
    const camZ = vy * sinP + yawZ * cosP; // larger = nearer the viewer

    const screenX = centre + yawX * cell;
    const screenY = centre - camY * cell; // y up -> screen down

    // Rotate the normal the same way and light it against the world light.
    const nx = model.nx[v]!;
    const ny = model.ny[v]!;
    const nz = model.nz[v]!;
    const nYawX = nx * cosY + nz * sinY;
    const nYawZ = -nx * sinY + nz * cosY;
    const worldNy = ny * cosP - nYawZ * sinP;
    const worldNz = ny * sinP + nYawZ * cosP;
    const worldNx = nYawX;

    const diffuse = Math.max(0, worldNx * lx + worldNy * ly + worldNz * lz);
    const shade = light.ambient + (1 - light.ambient) * diffuse * light.intensity;
    const emissive = model.emissive[v]!;
    const r = litChannel(model.r[v]!, shade, light.color[0], emissive);
    const g = litChannel(model.g[v]!, shade, light.color[1], emissive);
    const b = litChannel(model.b[v]!, shade, light.color[2], emissive);

    const x0 = Math.max(0, Math.floor(screenX - half));
    const x1 = Math.min(size - 1, Math.ceil(screenX + half));
    const y0 = Math.max(0, Math.floor(screenY - half));
    const y1 = Math.min(size - 1, Math.ceil(screenY + half));
    for (let py = y0; py <= y1; py += 1) {
      for (let px = x0; px <= x1; px += 1) {
        const di = py * size + px;
        if (camZ <= depth[di]!) continue; // something nearer already here
        depth[di] = camZ;
        const o = di * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
  }

  return { data, depth, width: size, height: size };
}

/** Albedo scaled by the light, floored by its own emissive glow. */
function litChannel(albedo: number, shade: number, lightColor: number, emissive: number): number {
  return Math.max(albedo * shade * lightColor, albedo * emissive);
}
