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

import { DEFAULT_RASTER_STYLE, renderMeshScene, type MeshSceneInstance } from "@cartbox/editor";
import type { Mat4, RasterStyle } from "@cartbox/editor";

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
}

/** Draws placed 3D instances into a framebuffer. */
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
    renderMeshScene(instances, {
      width: draw.width,
      height: draw.height,
      out: draw.out,
      depth: draw.depth,
      view: draw.view,
      projection: draw.projection,
      background: draw.background,
      lightDirection: draw.lightDirection,
      ambient: draw.ambient,
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
