/**
 * Composites many primitives into one image under one camera — the foundation of
 * the explorable world.
 *
 * {@link renderVoxelModel} draws a single model into buffers it clears each call,
 * which is right for a spinning prop but cannot show a *world*: buildings made of
 * cubes, terrain made of hexels, and atmosphere made of pixels all have to share
 * one depth buffer so nearer things hide farther ones regardless of which layer
 * they belong to or what order they were drawn. This module owns that shared
 * frame. It clears the buffers once, then draws every {@link PlacedModel} and
 * every {@link Particle} into them through the same {@link DrawContext}, so a
 * voxel building correctly occludes the hexel hill behind it and a snowflake
 * correctly disappears behind both.
 *
 * The camera's {@link SceneCamera.origin} is the world point that lands at the
 * centre of the screen — i.e. what the viewer is looking at. Moving it is how the
 * player later walks the world; here it simply frames the scene. Everything is
 * translated by `position - origin` before the shared rotation, so one camera
 * drives all layers.
 *
 * Pure and DOM-free, matching the other renderers, so the browser and the unit
 * tests drive it identically and assert on real composited pixels.
 */

import type { VoxelModel } from "./voxelModel";
import type { TextureAtlas } from "./faceTexture";
import {
  DEFAULT_MODEL_LIGHT,
  drawModelInto,
  makeDrawContext,
  type DrawContext,
  type ModelLight,
} from "./voxelModelRenderer";

/** A model placed at a world position. Scale is global (see {@link SceneCamera.cell}). */
export interface PlacedModel {
  readonly model: VoxelModel;
  /** World position of the model's centre. Default the world origin. */
  readonly position?: readonly [number, number, number];
  /**
   * Texture tiles this model's per-voxel `tile` indices sample from. Each placed
   * model may carry its own atlas; without one it renders flat.
   */
  readonly atlas?: TextureAtlas;
}

/**
 * A pixel-art atmosphere point — a single billboarded splat (rain drop, snow
 * flake, spark, dust mote). It occupies a world position so it sorts against the
 * solid geometry, but always faces the camera as a flat square of pixels.
 */
export interface Particle {
  readonly position: readonly [number, number, number];
  /** Colour, each channel 0..255. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  /** Self-emissive strength 0..1; a glowing particle keeps its colour unlit. */
  readonly emissive?: number;
  /** Half-extent of the splat in output pixels. Default 1 (a 2×2 fleck). */
  readonly radius?: number;
}

/** The camera and lighting that frame the scene. */
export interface SceneCamera {
  /** Rotation about the vertical axis, radians. Default 0. */
  readonly yaw?: number;
  /** Tip toward the viewer, radians (positive shows the tops). Default 0.42. */
  readonly pitch?: number;
  /** Output pixels per world unit (zoom). Default 3. */
  readonly cell?: number;
  /** The world point drawn at the screen centre — what the camera looks at. */
  readonly origin?: readonly [number, number, number];
  /** World-fixed light. Default {@link DEFAULT_MODEL_LIGHT}. */
  readonly light?: ModelLight;
}

export interface RenderSceneOptions extends SceneCamera {
  /** Square output edge in pixels. Required — a world has no natural size. */
  readonly size: number;
  /** Pixel atmosphere drawn into the same depth buffer. Default none. */
  readonly particles?: readonly Particle[];
  /** Reuse these buffers across frames (must be `size * size`). */
  readonly out?: Uint8ClampedArray;
  readonly depthBuffer?: Float32Array;
  /**
   * Optional picking outputs (size × size). `pickInstance` records the index into
   * `models` whose face won each pixel (`-1` where nothing solid was drawn);
   * `pickFace` records that model's cell-face index. Lets the world turn a cursor
   * into the object under it.
   */
  readonly pickInstance?: Int32Array;
  readonly pickFace?: Int8Array;
}

export interface SceneRender {
  readonly data: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly pickInstance?: Int32Array;
  readonly pickFace?: Int8Array;
}

/**
 * Render the placed models and particles into one shared frame under `camera`.
 * Returns square RGBA (alpha 0 where nothing was drawn, so the sky composites
 * behind it) plus the z-buffer used.
 */
export function renderScene(
  models: readonly PlacedModel[],
  options: RenderSceneOptions,
): SceneRender {
  const size = Math.max(1, Math.floor(options.size));
  const cell = Math.max(1, options.cell ?? 3);
  const light = options.light ?? DEFAULT_MODEL_LIGHT;
  const [originX, originY, originZ] = options.origin ?? [0, 0, 0];

  const data = options.out ?? new Uint8ClampedArray(size * size * 4);
  const depth = options.depthBuffer ?? new Float32Array(size * size);
  const pickInstance = options.pickInstance;
  const pickFace = options.pickFace;
  data.fill(0);
  depth.fill(-Infinity);
  pickInstance?.fill(-1);
  pickFace?.fill(-1);

  const ctx = makeDrawContext({
    data,
    depth,
    size,
    cell,
    yaw: options.yaw ?? 0,
    pitch: options.pitch ?? 0.42,
    light,
    pickVoxel: pickInstance,
    pickFace,
  });

  // Each model is translated so its world position lands relative to the camera
  // origin; the pick id is the model's index, so a hit names the whole instance.
  for (let instance = 0; instance < models.length; instance += 1) {
    const placed = models[instance]!;
    const [px, py, pz] = placed.position ?? [0, 0, 0];
    drawModelInto(
      ctx,
      placed.model,
      [px - originX, py - originY, pz - originZ],
      instance,
      placed.atlas,
    );
  }

  if (options.particles && options.particles.length > 0) {
    drawParticlesInto(ctx, options.particles, [originX, originY, originZ]);
  }

  return { data, depth, width: size, height: size, pickInstance, pickFace };
}

/**
 * Draw pixel-atmosphere splats into the context's shared buffers, z-tested so a
 * particle behind solid geometry is hidden by it. Each particle projects to a
 * screen point and depth through the same camera as the models, then fills a
 * small square about that point. Unlit unless emissive (weather rarely catches
 * the key light the way a surface does).
 */
export function drawParticlesInto(
  ctx: DrawContext,
  particles: readonly Particle[],
  origin: readonly [number, number, number],
): void {
  const { data, depth, size, centre, cell } = ctx;
  const { cosYaw, sinYaw, cosPitch, sinPitch } = ctx;
  const [ox, oy, oz] = origin;

  for (const particle of particles) {
    const wx = particle.position[0] - ox;
    const wy = particle.position[1] - oy;
    const wz = particle.position[2] - oz;
    const yawX = wx * cosYaw + wz * sinYaw;
    const yawZ = -wx * sinYaw + wz * cosYaw;
    const camY = wy * cosPitch - yawZ * sinPitch;
    const camZ = wy * sinPitch + yawZ * cosPitch;

    const sx = centre + yawX * cell;
    const sy = centre - camY * cell;
    const radius = Math.max(0, Math.floor(particle.radius ?? 1));

    const minX = Math.max(0, Math.floor(sx - radius));
    const maxX = Math.min(size - 1, Math.ceil(sx + radius));
    const minY = Math.max(0, Math.floor(sy - radius));
    const maxY = Math.min(size - 1, Math.ceil(sy + radius));

    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const di = py * size + px;
        if (camZ <= depth[di]!) continue; // behind solid geometry (or a nearer flake)
        depth[di] = camZ;
        const o = di * 4;
        data[o] = particle.r;
        data[o + 1] = particle.g;
        data[o + 2] = particle.b;
        data[o + 3] = 255;
      }
    }
  }
}
