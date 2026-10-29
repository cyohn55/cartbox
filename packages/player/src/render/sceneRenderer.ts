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

import type { CaptureOptions, ReferenceCapture } from "./pathTracer.js";
import type { ViewMode } from "./viewModes.js";
import type { SsgiFrame } from "./ssgi.js";
import type { CameraEffects } from "./cameraEffects.js";
import {
  DEFAULT_RASTER_STYLE,
  applyLods,
  cameraPositionFromView,
  cullInstances,
  occlusionCull,
  renderGeometryBuffers,
  renderMeshScene,
  type MeshSceneInstance,
  type SceneWind,
} from "@cartbox/editor";
import type { DynamicGi, MeshMaterial, Occluder, DecalTiles, EnvironmentLight, LocalShadows, Mat4, ProjectedDecal, RasterStyle, SceneFog, SceneLight, ShadowInput, ToneMap } from "@cartbox/editor";

import type { RenderCaps } from "../models.js";
import type { ReflectionCapture } from "./probeCapture.js";
import type { AtmosphereSky } from "./atmosphere.js";
import type { RenderStats } from "../debug/profiler.js";
import { applyRenderCaps, createTextureBudgetCache } from "./renderCaps.js";

/** The sun's GPU shadow cascades for a frame (F2a; see {@link SceneDraw.sunShadow}). */
export interface SunShadow {
  /** Everything that casts this frame, seen by the camera or not. */
  readonly casters: readonly MeshSceneInstance[];
  /** Toward the sun (the key light's direction). */
  readonly toLight: readonly [number, number, number];
  /** How far from the camera the cascades reach (world units). */
  readonly distance: number;
  /** Each cascade's edge in texels. */
  readonly size: number;
  /** How far beyond a cascade's slice a caster may stand toward the sun (world units). */
  readonly reach: number;
  /** How dark a shadow is, 0 (none) to 1 (default). */
  readonly strength?: number;
  /**
   * The sun's size, as the tangent of its angular diameter (F2a-2): how fast a
   * penumbra widens with the occluder's height above what it shades. Absent is
   * the real sun's 0.53°.
   */
  readonly softness?: number;
}

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
   * Smooth edges with multisampling (HALO_INFINITE_STYLE_ROADMAP.md I1), on the
   * GPU renderers: 4× MSAA, resolved before the frame is read back, so the
   * coverage it reads back also smooths silhouettes over whatever the frame is
   * composited onto. Off by default, because the GPU renderers otherwise match
   * the software rasteriser pixel for pixel; the software renderer ignores it.
   */
  readonly antialias?: boolean;
  /**
   * Temporal anti-aliasing (HALO_INFINITE_STYLE_ROADMAP.md I2), on the GPU
   * renderers: the projection jittered by a sub-pixel step each frame and the
   * frame blended into a reprojected history, then sharpened, before readback
   * (see temporal.ts). Calms the shimmer of thin detail multisampling can't
   * reach. Off by default (parity, as {@link antialias}); the software renderer
   * ignores it.
   */
  readonly temporal?: boolean;
  /**
   * Screen-space reflections (HALO_INFINITE_STYLE_ROADMAP.md I3), on the GPU
   * renderers: polished Modern-tier surfaces reflect what's on screen, keeping
   * the reflection probes' reflection where the screen has nothing (see
   * reflections.ts). Off by default (parity, as {@link antialias}); the
   * software renderer ignores it.
   */
  readonly reflections?: boolean;
  /**
   * A depth prepass (AAA_FIDELITY_ROADMAP.md F0c): the opaque surfaces' depth,
   * and the thin G-buffer of their normal, roughness and material ID, before
   * anything is shaded, so the shading pass shades each pixel once and
   * screen-space effects have the buffers to read. The WebGPU renderer only.
   */
  readonly prepass?: boolean;
  /**
   * Ground-truth ambient occlusion from the prepass (AAA_FIDELITY_ROADMAP.md
   * F3c): on by default whenever the linear-light renderer has a prepass;
   * false turns it off.
   */
  readonly ambientOcclusion?: boolean;
  /**
   * Screen-space GI from the prepass (AAA_FIDELITY_ROADMAP.md F3e-2; ssgi.ts):
   * the near field's bounce, lit by last frame's image, on the linear-light
   * renderer's temporal frames with a prepass. Absent = none.
   */
  readonly screenSpaceGi?: SsgiFrame | null;
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
  /** Shadow maps of the spot and point lights that cast (EP8c), indexed by their `shadowTile`. See {@link LocalShadows}. */
  readonly localShadows?: LocalShadows | null;
  /**
   * What casts the spot and point lights' shadows, on the linear-light (AAA)
   * WebGPU renderer, which draws their tiles itself (AAA_FIDELITY_ROADMAP.md
   * F2d) in place of {@link localShadows}; the lights that cast get tiles by
   * how much of the screen they cover. Ignored when {@link sunShadow} is given,
   * whose casters cast for them too.
   */
  readonly localShadowCasters?: readonly MeshSceneInstance[] | null;
  /**
   * What identifies the still casters among {@link localShadowCasters} (F2d-2):
   * while it holds, a tile whose light keeps its place and size keeps the map
   * it drew. Absent, every tile is drawn every frame.
   */
  readonly localShadowKey?: string | null;
  /** The casters that move this frame (F2d-2): a light any of them reaches has its tiles drawn again. */
  readonly localShadowMoved?: readonly MeshSceneInstance[] | null;
  /**
   * The reflection probes the linear-light (AAA) WebGPU renderer captures on
   * the GPU (AAA_FIDELITY_ROADMAP.md F3b), in place of the CPU's baked
   * panoramas in `environment.probes`: the probes, the still scene they see, and
   * a key that changes when either, or the light, does.
   */
  readonly reflectionCapture?: ReflectionCapture | null;
  /**
   * The projected decals the linear-light (AAA) WebGPU renderer lays over its
   * surfaces before lighting them (AAA_FIDELITY_ROADMAP.md F1f), in place of
   * the decal marks' quads: the boxes, in drawing order, and every decal's tiles.
   */
  readonly decals?: { readonly boxes: readonly ProjectedDecal[]; readonly tiles: DecalTiles } | null;
  /**
   * The sun's shadow rendered on the GPU in cascades (AAA_FIDELITY_ROADMAP.md
   * F2a), in place of the CPU-rasterised {@link shadow}: what casts (the whole
   * scene's casters, not just what the camera sees), the direction toward the
   * sun, how far from the camera it shadows, each cascade's map size, and how
   * far beyond a cascade's slice a caster may stand between it and the sun.
   * Only the linear-light (AAA) WebGPU renderer draws it; the others ignore it.
   */
  readonly sunShadow?: SunShadow | null;
  /**
   * Real-time GI (AAA_FIDELITY_ROADMAP.md F3e) on the linear-light (AAA)
   * WebGPU renderer: the still scene its probes trace (a key that changes
   * with it), and the settings. The volume it relights is the environment's
   * probe volume, which every surface then takes its diffuse light from, the
   * light-mapped ones too. The others ignore it.
   */
  readonly dynamicGi?: { readonly occluders: readonly Occluder[]; readonly key: string; readonly settings: DynamicGi } | null;
  /**
   * On the AAA tier at Epic (AAA_FIDELITY_ROADMAP.md F3f), the still scene
   * whose BVH the reflections trace where the screen has nothing to show,
   * keyed as `dynamicGi`'s (the two share one tracer when both are given).
   */
  /**
   * Virtual shadow maps for the sun (AAA_FIDELITY_ROADMAP.md F2b;
   * virtualShadows.ts) on the linear-light renderer with a prepass and its
   * cascades, at High and Epic: the physical pool's edge in texels. Absent =
   * the cascades alone.
   */
  readonly virtualShadows?: { readonly poolSize: number } | null;
  /**
   * Temporal upscaling (AAA_FIDELITY_ROADMAP.md F4b; upscaler.ts): on the
   * linear-light renderer's temporal frames with a prepass, the size the frame
   * is shown at, when larger than it renders. The frame then returns a texture
   * of that size, reconstructed over the frames. Absent = shown as rendered.
   */
  readonly upscale?: { readonly width: number; readonly height: number } | null;
  /**
   * The physical camera's depth of field and motion blur (AAA_FIDELITY_ROADMAP.md
   * F4c; cameraEffects.ts), on the linear-light renderer's frames with a
   * prepass. Absent = neither.
   */
  readonly camera?: CameraEffects | null;
  readonly reflectionTrace?: { readonly occluders: readonly Occluder[]; readonly key: string } | null;
  /**
   * A physical sky's air (AAA_FIDELITY_ROADMAP.md F5a-2): the medium and its
   * sun above the air, whose aerial perspective the linear-light (AAA) WebGPU
   * renderer lays over every surface, built for this draw's camera. The others
   * ignore it.
   */
  readonly atmosphere?: AtmosphereSky | null;
  /**
   * Distance fog for PBR (Modern-tier) materials, applied after tone mapping, or
   * omitted for none. Both backends fade by the fragment's eye depth. See
   * {@link SceneFog}.
   */
  readonly fog?: SceneFog | null;
  /** Seconds since the scene started, for animated emissive (scroll and pulse). */
  readonly time?: number;
  /**
   * What the viewport shows (AAA_FIDELITY_ROADMAP.md F10a; viewModes.ts): the lit frame (the default), or a
   * diagnostic of it, on the linear-light renderer. Every other renderer draws the lit frame.
   */
  readonly viewMode?: ViewMode;
  /** The texel density the texel-density view takes as on target, per metre (512 when omitted). */
  readonly texelDensity?: number;
  /** The scene's wind (B6): it sways primitives that carry per-vertex sway. Omitted is still air. */
  readonly wind?: SceneWind | null;
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

/**
 * A frame drawn to stay on the GPU (AAA_FIDELITY_ROADMAP.md F0a): a
 * {@link SceneDraw} without the CPU framebuffer, depth scratch or background,
 * which the GPU compositor supplies instead.
 */
export type GpuSceneDraw = Omit<SceneDraw, "out" | "depth" | "background">;

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
/**
 * Where a renderer's newest frame stands (see {@link SceneRenderer.settle}):
 * on screen ("current"), its readback still in flight ("pending"), or submitted
 * without a readback, so it needs rendering again to be seen ("stale").
 */
export type FrameState = "current" | "pending" | "stale";

export interface SceneRenderer {
  /** Human-readable backend name, for diagnostics and tests. */
  readonly backend: "software" | "webgpu" | "webgl2";
  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void;
  /**
   * Show the newest finished frame in `draw.out` without submitting another, and
   * say whether the newest frame submitted is the one now shown. An editor that
   * draws only when something changes calls this until it reads "current" (and
   * renders again on "stale"), so a slow GPU's late readback still reaches the
   * screen. A renderer that draws synchronously has nothing to settle.
   */
  settle?(draw: SceneDraw): FrameState;
  /** False while a GPU renderer has no finished frame to show yet (just built); absent for one that always has. */
  readonly ready?: boolean;
  /**
   * WebGPU only (AAA_FIDELITY_ROADMAP.md F0a): draw the frame and leave it on
   * the GPU, returning the texture that holds it — premultiplied RGBA8, alpha 0
   * wherever nothing drew, as the readback would have composited — with no
   * readback. Valid until the next render; null when the frame could not be
   * drawn. Absent on the renderers that have no GPU texture to give.
   */
  renderToTexture?(instances: readonly MeshSceneInstance[], draw: GpuSceneDraw): unknown;
  /**
   * Render at a new size from the next frame on (AAA_FIDELITY_ROADMAP.md F0d):
   * the frame's own targets are remade, its meshes and pipelines kept. Only the
   * renderers whose frames stay on the GPU have it.
   */
  resize?(width: number, height: number): void;
  /** The GPU device a {@link renderToTexture} texture belongs to, so a compositor can share it. */
  readonly gpuDevice?: unknown;
  /**
   * The linear-light WebGPU renderer only (AAA_FIDELITY_ROADMAP.md F10b): the
   * path-traced reference of a frame at any size up to 8K, and the samples its
   * viewport reference holds.
   */
  captureReference?(instances: readonly MeshSceneInstance[], draw: GpuSceneDraw, options: CaptureOptions): Promise<ReferenceCapture>;
  /**
   * The WebGPU renderer only (AAA_FIDELITY_ROADMAP.md F1e): compile the shader
   * permutations these materials' graphs need in the background, drawing them
   * as plain materials until each is ready.
   */
  prepareMaterials?(materials: Iterable<MeshMaterial>, options?: { readonly samples?: number; readonly reflect?: boolean; readonly prepass?: boolean }): Promise<void>;
  readonly referenceSamples?: number;
  /**
   * True when it draws the sun's shadow itself from {@link SceneDraw.sunShadow}
   * (F2a: the AAA tier's GPU cascades) and ignores a CPU {@link SceneDraw.shadow}.
   */
  readonly sunCascades?: boolean;
  /**
   * The block-compressed formats this renderer uploads a texture's
   * {@link DecodedTexture.gpu} chain in, preferred first (AAA_FIDELITY_ROADMAP.md
   * F1a): what a KTX2 texture should transcode to for it. Empty or absent, it
   * samples RGBA only.
   */
  readonly textureFormats?: readonly string[];
  dispose(): void;
  /** What the last frame drew, for the profiler (see debug/profiler.ts). */
  readonly lastFrameStats?: RenderStats;
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

  lastFrameStats: RenderStats = { drawCalls: 0, instances: 0, triangles: 0, gpuMs: null };

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    const visible = applyScenePasses(instances, draw);
    let triangles = 0;
    let drawCalls = 0;
    for (const instance of visible) {
      drawCalls += instance.mesh.primitives.length;
      for (const primitive of instance.mesh.primitives) triangles += primitive.indices.length / 3;
    }
    this.lastFrameStats = { drawCalls, instances: visible.length, triangles, gpuMs: null };
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
      localShadows: draw.localShadows,
      fog: draw.fog,
      time: draw.time,
      wind: draw.wind,
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

  get lastFrameStats(): RenderStats | undefined {
    return this.inner.lastFrameStats;
  }

  render(instances: readonly MeshSceneInstance[], draw: SceneDraw): void {
    this.inner.render(applyRenderCaps(instances, this.caps, this.cache), draw);
  }

  settle(draw: SceneDraw): FrameState {
    return this.inner.settle?.(draw) ?? "current";
  }

  get ready(): boolean | undefined {
    return this.inner.ready;
  }

  get gpuDevice(): unknown {
    return this.inner.gpuDevice;
  }

  get textureFormats(): readonly string[] | undefined {
    return this.inner.textureFormats;
  }

  get sunCascades(): boolean | undefined {
    return this.inner.sunCascades;
  }

  get referenceSamples(): number | undefined {
    return this.inner.referenceSamples;
  }

  get prepareMaterials(): SceneRenderer["prepareMaterials"] {
    const inner = this.inner;
    return inner.prepareMaterials ? (materials, options) => inner.prepareMaterials!(materials, options) : undefined;
  }

  get captureReference(): SceneRenderer["captureReference"] {
    const inner = this.inner;
    // A reference is the whole scene, uncapped.
    return inner.captureReference ? (instances, draw, options) => inner.captureReference!(instances, draw, options) : undefined;
  }

  get renderToTexture(): SceneRenderer["renderToTexture"] {
    const inner = this.inner;
    if (!inner.renderToTexture) return undefined;
    // The sun's casters go through as they are: depth alone, and a budget cut would drop shadows off-screen at random.
    return (instances, draw) => inner.renderToTexture!(applyRenderCaps(instances, this.caps, this.cache), draw);
  }

  get resize(): SceneRenderer["resize"] {
    const inner = this.inner;
    return inner.resize ? (width, height) => inner.resize!(width, height) : undefined;
  }

  dispose(): void {
    this.inner.dispose();
  }
}

/** True when a model's caps constrain the scene, so wrapping would do something. */
export function capsConstrainScene(caps: RenderCaps): boolean {
  return caps.polyBudget > 0 || caps.textureCacheBytes > 0;
}
