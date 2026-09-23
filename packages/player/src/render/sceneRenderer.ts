/**
 * Scene rendering: the seam between "what to draw" and "what draws it".
 *
 * Both 3D overlays — {@link MeshOverlaySurface} and {@link WorldOverlaySurface} —
 * called `renderMeshScene` from `@cartbox/editor` directly, which is a pure
 * software rasteriser running on the main thread. That was Phase 2 of the mesh
 * feature and it is why the player has had no GPU triangle path: the renderer
 * was not a dependency the surfaces could swap, it was a function they called.
 *
 * This makes it a dependency. Both overlays now draw through a `SceneRenderer`,
 * of which there are two: the software one (the existing rasteriser, unchanged)
 * and a WebGPU one. `createSceneRenderer` probes for a device and returns the
 * GPU renderer when it can, the software renderer when it cannot — the same
 * probe-and-fall-back shape `createLightingLayer` uses for lighting, for the
 * same reason: a missing or failed device must degrade, never blank the screen.
 *
 * Why an era roadmap needs this: a PS1-era console model is defined by *how* it
 * rasterises (no depth buffer, affine texture mapping), not by its resolution.
 * That is a renderer that honours a `RenderCaps` block — impossible while the
 * rasteriser is a hardcoded call. See ERA_MODELS.md §5.1.
 */

import {
  DEFAULT_RASTER_STYLE,
  applyLods,
  cameraPositionFromView,
  cullInstances,
  occlusionCull,
  renderGeometryBuffers,
  renderMeshScene,
  type MeshSceneInstance,
} from "@cartbox/editor";
import type { EnvironmentLight, Mat4, RasterStyle, SceneFog, SceneLight, ShadowInput, ToneMap } from "@cartbox/editor";

import type { RenderCaps } from "../models.js";
import { applyRenderCaps, createTextureBudgetCache } from "./renderCaps.js";

/** One frame's worth of drawing parameters — mirrors `renderMeshScene`'s options. */
export interface SceneDraw {
  readonly width: number;
  readonly height: number;
  /** The framebuffer to composite into, RGBA8, `width * height * 4`. */
  readonly out: Uint8ClampedArray;
  /**
   * Depth scratch, `width * height`.
   *
   * Owned by the renderer for the duration of the call and meaningless outside
   * it: the software renderer fills it, the GPU renderer keeps depth on the GPU
   * and never touches this array. No caller reads it back, and none may start —
   * a renderer is free to ignore it entirely.
   */
  readonly depth: Float32Array;
  readonly view: Mat4;
  readonly projection: Mat4;
  /**
   * Clear colour, or null to composite over whatever `out` already holds (the
   * cart's own frame). Null is what makes these surfaces overlays.
   */
  readonly background: readonly [number, number, number, number] | null;
  /**
   * Key light direction, or omitted for the rasteriser's default. The world
   * overlay publishes a cart-driven sun here, so it changes per frame.
   */
  readonly lightDirection?: readonly [number, number, number];
  /** Ambient floor, or omitted for the rasteriser's default (0.35). */
  readonly ambient?: number;
  /**
   * Image-based lighting environment for PBR (Modern-tier) materials, or omitted
   * for the flat ambient stand-in. When present it replaces the flat ambient with
   * directional irradiance + a specular reflection. See {@link EnvironmentLight}.
   */
  readonly environment?: EnvironmentLight | null;
  /**
   * Directional shadow map for PBR (Modern-tier) materials, or omitted for no
   * shadows. The caller fills it with `renderShadowMap` before this call; the
   * renderer samples it to occlude the direct light. See {@link ShadowInput}.
   */
  readonly shadow?: ShadowInput | null;
  /**
   * HDR tone mapping for PBR (Modern-tier) materials, or omitted to write the
   * shaded colour straight to the framebuffer. See {@link ToneMap}.
   */
  readonly tonemap?: ToneMap | null;
  /**
   * Screen-space ambient-occlusion buffer (`width×height`, 0..1), or omitted. The
   * caller builds it from a geometry pre-pass; the renderer multiplies the PBR
   * ambient term by it. The GPU path uploads it and samples per fragment.
   */
  readonly ssao?: Float32Array | null;
  /**
   * Multiple lights for PBR (Modern-tier) materials, replacing the single
   * `lightDirection`. Decoupled from the full 6-slot 2D mailbox. See
   * {@link SceneLight}.
   */
  readonly lights?: readonly SceneLight[] | null;
  /**
   * Distance fog for PBR (Modern-tier) materials, applied after tone mapping, or
   * omitted for none. Both backends fade by the fragment's eye depth. See
   * {@link SceneFog}.
   */
  readonly fog?: SceneFog | null;
  /**
   * Skip instances whose world AABB is entirely outside the camera frustum. A
   * correct cull is output-identical, so it is a pure perf win; default off.
   */
  readonly cull?: boolean;
  /** Swap LOD-carrying instances to the mesh their camera distance selects. */
  readonly lod?: boolean;
  /**
   * Drop instances hidden behind nearer geometry. Costs a CPU depth pre-pass, so
   * it is opt-in; conservative, so it never removes visible geometry.
   */
  readonly occlude?: boolean;
}

/** Draws placed 3D instances into a framebuffer. */

/** Apply the scene-level selection passes a draw requests (LOD, cull, occlusion). */
export function applyScenePasses(
  instances: readonly MeshSceneInstance[],
  draw: {
    readonly view: Mat4;
    readonly projection: Mat4;
    readonly width: number;
    readonly height: number;
    readonly cull?: boolean;
    readonly lod?: boolean;
    readonly occlude?: boolean;
  },
): readonly MeshSceneInstance[] {
  let out = instances;
  if (draw.lod) {
    const [cx, cy, cz] = cameraPositionFromView(draw.view);
    out = applyLods(out, cx, cy, cz);
  }
  if (draw.cull) out = cullInstances(out, draw.view, draw.projection);
  // Occlusion is last (most expensive) and on the smallest set: a CPU depth
  // pre-pass of the survivors, then drop the ones it fully hides.
  if (draw.occlude && out.length > 1) {
    const geo = renderGeometryBuffers(out, { width: draw.width, height: draw.height, view: draw.view, projection: draw.projection });
    out = occlusionCull(out, { view: draw.view, projection: draw.projection, depth: geo.depth, width: draw.width, height: draw.height });
  }
  return out;
}
export interface SceneRenderer {
  /** Human-readable backend name, for diagnostics and tests. */
  readonly backend: "software" | "webgpu";
  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
  dispose(): void;
}

/**
 * The existing pure rasteriser, behind the interface. Nothing about it changes:
 * it stays the reference implementation the GPU path is checked against, and
 * the fallback whenever WebGPU is absent.
 */
export class SoftwareSceneRenderer implements SceneRenderer {
  readonly backend = "software" as const;

  /**
   * @param style How to rasterise — the era behaviour a console model asks for.
   *   Defaults to the modern one, so an editor preview or a test that passes
   *   nothing renders exactly as it always has.
   */
  constructor(private readonly style: RasterStyle = DEFAULT_RASTER_STYLE) {}

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    const visible = applyScenePasses(instances, draw);
    renderMeshScene(visible, {
      width: draw.width,
      height: draw.height,
      out: draw.out,
      depth: draw.depth,
      view: draw.view,
      projection: draw.projection,
      background: draw.background,
      lightDirection: draw.lightDirection,
      ambient: draw.ambient,
      environment: draw.environment,
      shadow: draw.shadow,
      tonemap: draw.tonemap,
      ssao: draw.ssao,
      lights: draw.lights,
      fog: draw.fog,
      style: this.style,
    });
  }

  dispose(): void {
    // Nothing to release: the rasteriser holds no resources.
  }
}

/**
 * Applies a model's scene-level {@link RenderCaps} before delegating.
 *
 * A decorator rather than a branch inside each backend, so the software
 * rasteriser and the GPU enforce a model's limits *identically*. An era model's
 * constraints are part of the model, not of the viewer's graphics stack: a cart
 * that overruns a poly budget must overrun it the same way on both.
 */
export class CappedSceneRenderer implements SceneRenderer {
  private readonly cache = createTextureBudgetCache();

  constructor(
    private readonly inner: SceneRenderer,
    private readonly caps: RenderCaps,
  ) {}

  get backend(): SceneRenderer["backend"] {
    return this.inner.backend;
  }

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    this.inner.render(applyRenderCaps(instances, this.caps, this.cache), draw);
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/** True when a model's caps constrain the scene, so wrapping would do something. */
export function capsConstrainScene(caps: RenderCaps): boolean {
  return caps.polyBudget > 0 || caps.textureCacheBytes > 0;
}
