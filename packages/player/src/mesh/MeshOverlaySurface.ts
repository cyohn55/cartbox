/**
 * MeshOverlaySurface — a display surface that rasterises a cart's declared 3D
 * mesh scene over each presented frame, then hands off to an inner surface. This
 * is Phase 2 of the mesh asset feature: the runtime has no GPU triangle path, so
 * the same pure software rasteriser the editor previews with (`renderMeshScene`
 * in `@cartbox/editor`) draws the meshes straight into the framebuffer here.
 *
 * It decorates any {@link DisplaySurface}, compositing the meshes *over* the cart
 * frame with a shared depth buffer so the instances occlude each other correctly.
 * Because it is a decorator, its output flows through the lighting and post-FX
 * stack that wrap the base surface — the meshes are graded and bloomed with the
 * rest of the scene rather than pasted on flat.
 *
 * The scene auto-orbits at a gentle rate by default, so a declared mesh is
 * visibly rendered even with no cart code. A cart can take over the camera each
 * frame via `cartbox.meshcam(...)`: the player decodes that from the mailbox and
 * feeds it to {@link setCameraOverride}, which wins for that frame; clearing the
 * override drops back to the auto-orbit.
 *
 * Textures are decoded once, asynchronously, at construction (the browser owns
 * image decoding), which is why the surface is built through a static async
 * `create`, mirroring `LitCanvasSurface.create`.
 */

import {
  bakeReflectionProbesAsync,
  ParticleSystem,
  DecalSystem,
  DebrisSystem,
  applySunShafts,
  sunScreenPosition,
  sunVisibility,
  type ShaftScratch,
  bakeSkyPanorama,
  bakeVistas,
  buildSceneShadow,
  TrailSystem,
  LOCAL_SHADOW_BIAS,
  LOCAL_SHADOW_SLOPE_BIAS,
  assignLocalShadowTiles,
  renderLocalShadow,
  childIndices,
  computeEnvironmentAverage,
  createLiveSkinnedMesh,
  downsamplePanorama,
  isSkinned,
  renderSkyBackground,
  shieldEffect,
  composeModelMatrix,
  multiplyMat4,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  vistaBounds,
  sceneLightingTonemap,
  withDescendants,
  type DecodedTexture,
  type EncodedImage,
  type EnvironmentLight,
  type LiveSkinnedMesh,
  type LodChain,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
  type RagdollBox,
  type SurfaceEffect,
  bakeCloudLayer,
  base64ToBytes,
  decodeRadianceHdr,
  hdrToTexture,
  isRadiance,
  panoramaWithClouds,
  type BakedCloudLayer,
  type ProceduralSky,
} from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import type { ScreenSun } from "../fx/PostFxSurface.js";
import { SoftwareSceneRenderer, type SceneRenderer } from "../render/sceneRenderer.js";
import type { MailboxMeshCamera, MailboxMeshPose, WorldLight } from "../mailbox.js";
import type { LocalShadowTile, LocalShadows, ShadowCascade, ShadowInput, SceneLight, SceneLighting, VistaLayer } from "@cartbox/editor";
import type { MeshInstance, MeshScene, SceneVista } from "./meshScene.js";
import { QUALITY_PRESETS, type QualitySettings } from "../quality.js";
import { buildOrbitCamera, orbitPitchAboveTerrain } from "./meshScene.js";
import { sceneColliders } from "./sceneColliders.js";
import { estimateSceneBytes, type Profiler, type RenderStats } from "../debug/profiler.js";

const RAD_TO_DEG = 180 / Math.PI;
/** How far the sun's reported visibility moves toward this frame's each frame. */
const SUN_EASE = 0.35;

/** Near clip plane for first-person (HUD) views, world units. */
const FIRST_PERSON_NEAR = 0.05;

/** Edge length of the directional shadow map — a fixed, self-contained cost. */
const SHADOW_MAP_SIZE = 1024; // the high preset's; see setQuality

/**
 * The sky backdrop is shaded on a grid this many pixels across, then expanded:
 * the panorama holds ~3 screen pixels per texel at 720p anyway, so a coarser
 * grid costs nothing visible and saves most of the per-frame work.
 */
const SKY_BACKDROP_SCALE = 3;

/**
 * Render scales the software rasteriser steps through for a large first-person
 * view (a 720p arena costs it seconds per frame at full size — a device without
 * WebGPU gets a softer image rather than a slideshow). The HUD stays full size.
 */
const SOFTWARE_SCALES = [1, 0.75, 0.5, 0.35, 0.25] as const;
/** Frame time (ms, smoothed) above which the scale steps down, and below which it steps back up. */
const SLOW_FRAME_MS = 40;
const FAST_FRAME_MS = 15;

/** Options for {@link MeshOverlaySurface.create}. */
export interface MeshOverlayOptions {
  /**
   * Let a software-rendered first-person view drop its 3D resolution to keep
   * the frame rate up (default true). Off renders every frame at full size.
   */
  readonly adaptiveResolution?: boolean;
  /**
   * Loads a decoder for KTX2 (Basis Universal) textures, which browsers can't
   * decode natively. Called only when the scene has one; without it such
   * textures render as their flat base colour.
   */
  readonly ktx2?: Ktx2DecoderLoader;
  /**
   * The model's anti-aliasing render cap (`antialias`, I1): the GPU
   * renderers multisample the scene and the held weapon's outline is smoothed,
   * when the graphics quality allows it too. Off by default.
   */
  readonly antialias?: boolean;
  /** The model's temporal anti-aliasing cap (`temporal`, I2), likewise gated by the quality. Off by default. */
  readonly temporal?: boolean;
  /** The model's screen-space reflections cap (`reflections`, I3), likewise gated by the quality. Off by default. */
  readonly reflections?: boolean;
}

/** Loads a KTX2 → RGBA decoder (see {@link MeshOverlayOptions.ktx2}). */
export type Ktx2DecoderLoader = () => Promise<(bytes: Uint8Array) => DecodedTexture | null>;

/** A rectangle of shadow-map texels. */
interface TexelRect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number;
}

/**
 * In HUD mode a cart 2D pixel this dark (channel sum ≤ this) is the transparent
 * "world" and the 3D shows through; anything brighter is HUD and draws on top.
 * The default void colour (index 0) sums well under this; HUD elements are drawn
 * brighter, so the split is clean.
 */
const HUD_TRANSPARENT_SUM = 30;

/** Flat sky the 3D scene is rendered over in HUD mode (a cool Forerunner tone). */
const HUD_SKY: readonly [number, number, number, number] = [70, 104, 152, 255];

/**
 * Composite a cart's 2D frame as a HUD *over* an already-rendered 3D scene: every
 * cart pixel brighter than {@link HUD_TRANSPARENT_SUM} overwrites the scene, the
 * near-black rest lets the 3D show through. Pure and in-place on `scene`, so it is
 * unit-testable without a surface. `count` is the pixel count (width × height).
 */
export function compositeHudOverScene(
  scene: Uint8ClampedArray,
  hud: Uint8Array | Uint8ClampedArray,
  count: number,
): void {
  if (scene.byteOffset % 4 === 0 && hud.byteOffset % 4 === 0) {
    // Whole pixels as words: most of a HUD frame is the black void, which one
    // test skips.
    const out = new Uint32Array(scene.buffer, scene.byteOffset, count);
    const src = new Uint32Array(hud.buffer, hud.byteOffset, count);
    for (let i = 0; i < count; i += 1) {
      const word = src[i]!;
      if ((word & 0xffffff) === 0) continue;
      if ((word & 0xff) + ((word >>> 8) & 0xff) + ((word >>> 16) & 0xff) > HUD_TRANSPARENT_SUM) out[i] = (word | 0xff000000) >>> 0;
    }
    return;
  }
  for (let i = 0; i < count; i += 1) {
    const o = i * 4;
    const r = hud[o]!;
    const g = hud[o + 1]!;
    const b = hud[o + 2]!;
    if (r + g + b > HUD_TRANSPARENT_SUM) {
      scene[o] = r;
      scene[o + 1] = g;
      scene[o + 2] = b;
      scene[o + 3] = 255;
    }
  }
}

/**
 * Size of the baked sky-dome panorama. Wide enough that a 720p first-person view
 * shows ~3 screen pixels per texel (bilinear keeps that smooth), small enough to
 * bake in well under a second at load.
 */
const SKY_PANORAMA_WIDTH = 1536;
const SKY_PANORAMA_HEIGHT = 768;
/** The image-based-light copy is this much smaller — reflections are blurry anyway. */
const SKY_IBL_DOWNSAMPLE = 8;

/**
 * A cart pose's local transform. The SDK's rotation is (yaw, pitch, roll): yaw
 * turns about Y, pitch about X, roll about Z. composeModelMatrix takes (x, y, z)
 * degrees and applies X, then Y, then Z — i.e. pitch, then yaw, then roll — so
 * the angles are reordered here. (Passing them straight through made "yaw" tip
 * an object over about X.)
 */
export function poseLocalMatrix(pose: MailboxMeshPose): Mat4 {
  return composeModelMatrix(
    pose.position,
    [pose.rotation[1] * RAD_TO_DEG, pose.rotation[0] * RAD_TO_DEG, pose.rotation[2] * RAD_TO_DEG],
    [pose.scale, pose.scale, pose.scale],
  );
}

/** Radians of yaw per presented frame — one full turn every ~12s at 60Hz. */
const AUTO_ORBIT_YAW_PER_FRAME = (2 * Math.PI) / 720;
/**
 * One sun shadow map (see MeshOverlaySurface.buildShadow): the cached depth of
 * everything still, what it was drawn for, its light matrix, this frame's
 * copy with the movers drawn in, and the rects they covered.
 */
interface ShadowLayer {
  staticDepth: Float32Array | null;
  key: string;
  lighting: SceneLighting | null;
  matrix: Mat4 | null;
  depth: Float32Array | null;
  rects: TexelRect[];
}
const newShadowLayer = (): ShadowLayer => ({ staticDepth: null, key: "", lighting: null, matrix: null, depth: null, rects: [] });

/** The near shadow cascade's half-size (EP8b): this share of the scene's radius, within these bounds (world units). */
const NEAR_CASCADE_SHARE = 0.3;
const NEAR_CASCADE_MIN = 4;
const NEAR_CASCADE_MAX = 24;

/** Fixed downward tilt so the scene reads as a 3D object, not a flat silhouette. */
const AUTO_ORBIT_PITCH = 0.35;

export class MeshOverlaySurface implements DisplaySurface {
  private frame = 0;
  private cartCamera: MailboxMeshCamera | null = null;
  private poses: readonly MailboxMeshPose[] = [];
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;
  private readonly depth: Float32Array;
  /** The sun's shadow maps (see buildShadow): the whole scene, and the near cascade round the camera (EP8b). */
  private farShadow: ShadowLayer = newShadowLayer();
  private nearShadow: ShadowLayer = newShadowLayer();
  /** Each casting spot/point light's cached still tiles and this frame's copies (EP8c), in tile order. */
  private localShadowCache: { key: string; statics: Float32Array[]; frames: Float32Array[] }[] = [];
  /** Instances ever posed on the front layer (a held weapon): never part of the static shadow. */
  private readonly everFront = new Set<number>();
  /** Each mesh's local bounding box, for projecting shadow footprints. */
  private readonly meshBounds = new WeakMap<MeshAsset, readonly [number, number, number, number, number, number]>();
  /** Software-path resolution governor (see SOFTWARE_SCALES): current step and smoothed frame ms. */
  private scaleStep = 2;
  private frameMs = 0;
  private framesAtStep = 0;
  private low: { width: number; height: number; out: Uint8ClampedArray; depth: Float32Array } | null = null;
  /** The last sky backdrop and the view it was painted for (it depends only on
   *  where the camera points, so walking without turning reuses it). */
  private skyCache: { key: string; pixels: Uint8ClampedArray } | null = null;
  /** The sky's drifting cloud layers (I6), drawn over the backdrop each frame. */
  private skyClouds: BakedCloudLayer[] = [];
  /** The scene's distant vistas, textured: re-drawn into the sky whenever it is re-baked. */
  private vistas: VistaLayer[] = [];
  /**
   * Told each frame where the sky dome's sun is on screen and how much of it is
   * unblocked, for the post-FX glare and lens flare (H8); null without a sky dome.
   */
  onSun: ((sun: ScreenSun | null) => void) | null = null;
  /** The sun's eased visibility and last place on screen (0..1). */
  private sunSeen = 0;
  private sunAt: { x: number; y: number } = { x: 0.5, y: 0.5 };
  /** Reused buffers for the sun-shaft pass. */
  private shaftScratch: ShaftScratch | null = null;
  /** A copy of the frame for smoothing the held weapon's outline (I1). */
  private edgeScratch: Uint8ClampedArray | null = null;
  /** The cart's world lights this frame (cartbox.light3d), added to the rig's in first person. */
  private cartLights: readonly SceneLight[] = [];
  /** Tinted mesh copies, per source mesh and tint index. */
  private readonly tintCache = new Map<MeshAsset, Map<number, MeshAsset>>();
  /** Draws the front layer (a held weapon) over the finished scene. */
  private readonly frontRenderer = new SoftwareSceneRenderer();
  /** First-person mode: draw the meshes first, then the cart's 2D frame as a HUD on top. */
  private hud = false;
  /**
   * The scene-object hierarchy: each instance's parent index (-1 for a root), its
   * children, and its authored local transform. Null when no instance has a parent,
   * which keeps the flat scene on its original code path.
   */
  private readonly hierarchy: {
    readonly parents: readonly number[];
    readonly children: readonly (readonly number[])[];
    readonly locals: readonly Mat4[];
  } | null;
  /** The same shape for a flat scene, built on first use when physics bodies move it. */
  private flat: NonNullable<MeshOverlaySurface["hierarchy"]> | null = null;
  /** World matrices of the objects physics moved this frame (see setBodyOverrides). */
  private bodies: ReadonlyMap<number, Mat4> = new Map();
  /** Shield effects (H11): object index → the surface effect it and everything under it wear (see setShields). */
  private effects: ReadonlyMap<number, SurfaceEffect> = new Map();
  private readonly shieldCache = new Map<number, { flare: number; shimmer: number; camo: number; effect: SurfaceEffect | null }>();
  /** Spawned prefab copies: root object index → the root's world matrix (see setSpawned). */
  private spawned: ReadonlyMap<number, Mat4> = new Map();
  /** Graphics quality (see quality.ts): shadows on/off and their map size, the first-person scale cap. */
  private quality: QualitySettings = QUALITY_PRESETS.high;
  /** Skinned instances' live meshes (their buffers are rewritten for each pose). */
  private readonly live = new Map<number, LiveSkinnedMesh>();
  /** The skinning matrices each live mesh was last posed with (skip re-skinning the same pose). */
  private readonly lastSkin = new Map<number, Float32Array>();
  /** Instances animated this frame: they move for the shadow cache. */
  private animated: ReadonlySet<number> = new Set();
  /** Each object's reserve-copy root (-1 when it isn't part of a prefab reserve). */
  private readonly pooledRoot: readonly number[];
  /** The authored instances without the reserve copies (drawn when nothing moves). */
  private unpooled: readonly MeshSceneInstance[];
  /** Objects in a level that isn't the current one: not drawn, not in the static shadow (see setInactive). */
  private inactive: ReadonlySet<number> = new Set();
  private inactiveKey = "";
  /** Each object's world matrix as last drawn (null = hidden), or null when nothing moved. */
  private lastPlacement: (Mat4 | null)[] | null = null;
  /** Which objects drew on the front layer last frame (where their trails go). */
  private lastFront: boolean[] = [];
  /** Swing trails (I10): the objects whose meshes leave them, and the ribbons they've swept. */
  private trailed: number[] = [];
  private trails: TrailSystem | null = null;
  /** Copy of the cart frame kept as the HUD layer while the 3D renders into `output`. */
  private hudFrame: Uint8ClampedArray | null = null;
  /** The playtest profiler, when it's on: shadow, sky and scene time go to it. */
  private profiler: Profiler | null = null;

  private constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private scene: MeshScene,
    /** The authored instances (baked placement); per-frame poses compose on top. */
    private readonly instances: MeshSceneInstance[],
    /** Each instance's animation frames (textured), or null when it has none. */
    private readonly frames: (readonly TexturedMesh[] | null)[],
    /**
     * What actually draws the triangles. Owned by whoever passed it — a renderer
     * is typically shared with the world overlay, so destroying this surface must
     * not dispose it. The default software renderer holds no resources.
     */
    private readonly renderer: SceneRenderer,
    /** The baked sky-dome panorama drawn behind a first-person view, or null. */
    private skyMap: DecodedTexture | null,
    /** The environment the PBR shading samples (with the dome as its map), or null. */
    private environment: EnvironmentLight | null,
    private readonly options: MeshOverlayOptions = {},
  ) {
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
    this.depth = new Float32Array(width * height);
    this.pooledRoot = scene.instances.map((instance) => instance.pooled?.root ?? -1);
    this.unpooled = this.pooledRoot.some((r) => r >= 0) ? instances.filter((_, i) => this.pooledRoot[i]! < 0) : instances;
    const parents = scene.instances.map((instance) => instance.parent ?? -1);
    this.hierarchy = parents.some((p) => p >= 0)
      ? {
          parents,
          children: childIndices(parents),
          locals: scene.instances.map((instance) => instance.local ?? instance.model),
        }
      : null;
  }

  /**
   * Set the world matrices of the objects physics moves (object index → matrix),
   * replacing their authored placement; their children follow, and a cart pose
   * still composes on top. The player calls this each frame from the physics session.
   */
  setBodyOverrides(bodies: ReadonlyMap<number, Mat4>): void {
    this.bodies = bodies;
  }

  /**
   * Set the prefab copies the cart has spawned (root object index → world matrix).
   * Reserve copies not in the map stay hidden; a spawned copy's children follow
   * its root, and its physics bodies (if any) take over from there.
   */
  setSpawned(spawned: ReadonlyMap<number, Mat4>): void {
    this.spawned = spawned;
  }

  /**
   * Set the shield effects the cart has standing (cartbox.shield: object →
   * flare, shimmer, camo). Each is drawn on the object and everything under it,
   * as a surface effect over its PBR materials (see shieldEffect).
   */
  setShields(shields: ReadonlyMap<number, { readonly flare: number; readonly shimmer: number; readonly camo: number }>): void {
    if (shields.size === 0 && this.effects.size === 0) return;
    const effects = new Map<number, SurfaceEffect>();
    for (const [object, { flare, shimmer, camo }] of shields) {
      let cached = this.shieldCache.get(object);
      // The same state keeps the same effect object, so its batches stay together.
      if (!cached || cached.flare !== flare || cached.shimmer !== shimmer || cached.camo !== camo) {
        cached = { flare, shimmer, camo, effect: shieldEffect(flare, shimmer, camo) };
        this.shieldCache.set(object, cached);
      }
      if (cached.effect) effects.set(object, cached.effect);
    }
    for (const object of this.shieldCache.keys()) if (!shields.has(object)) this.shieldCache.delete(object);
    this.effects = effects;
  }

  /**
   * Pose the skinned objects (object index → skinning matrices, see
   * AnimationSession). Each listed object's live mesh is re-skinned when its
   * matrices changed, and it counts as moving this frame for the shadow cache.
   */
  setSkinning(skinning: ReadonlyMap<number, Float32Array>): void {
    for (const [i, matrices] of skinning) {
      const live = this.live.get(i);
      if (!live || this.lastSkin.get(i) === matrices) continue;
      live.update(matrices);
      this.lastSkin.set(i, matrices);
    }
    this.animated = new Set([...skinning.keys()].filter((i) => this.live.has(i)));
  }

  /**
   * Apply an editor's edits to the running scene (ENGINE_PARITY_ROADMAP.md EP5):
   * objects' placements, their meshes and materials, and the lighting rig, shown
   * from the next frame without restarting the cart. `next` must be the same
   * scene structure — the same objects, parents and prefab reserves in the same
   * order — or nothing changes and this answers false (the editor then says the
   * change applies on the next run). Physics bodies keep simulating where they are.
   */
  async applySceneEdits(next: MeshScene): Promise<boolean> {
    const before = this.scene;
    if (next.instances.length !== before.instances.length) return false;
    for (let i = 0; i < next.instances.length; i += 1) {
      const a = before.instances[i]!;
      const b = next.instances[i]!;
      if ((a.parent ?? -1) !== (b.parent ?? -1) || (a.pooled?.root ?? -1) !== (b.pooled?.root ?? -1) || !!a.terrain !== !!b.terrain) return false;
    }
    let moved = false;
    for (let i = 0; i < next.instances.length; i += 1) {
      const a = before.instances[i]!;
      const b = next.instances[i]!;
      const local = b.local ?? b.model;
      if (!sameMatrix(a.model, b.model) || !sameMatrix(a.local ?? a.model, local)) {
        this.instances[i] = { ...this.instances[i]!, model: b.model };
        if (this.hierarchy) (this.hierarchy.locals as Mat4[])[i] = local;
        this.blockBounds.delete(i);
        moved = true;
      }
      if (meshSignature(a.mesh) !== meshSignature(b.mesh)) {
        // New geometry or materials: decode its textures and draw it from the next frame.
        const textured = await decodeMeshTextures(b.mesh, this.decodeKtx2 ?? undefined);
        const skinned = isSkinned(b.mesh) ? createLiveSkinnedMesh(b.mesh) : null;
        if (skinned) this.live.set(i, skinned);
        else this.live.delete(i);
        this.lastSkin.delete(i);
        const lod = liveLod(b.lod, skinned);
        this.instances[i] = { ...textured, ...(skinned ? { mesh: skinned.mesh } : {}), ...(lod ? { lod } : {}), model: this.instances[i]!.model };
        moved = true;
      } else if (lodSignature(a.lod) !== lodSignature(b.lod)) {
        // Same mesh, new levels (generated or cleared in the editor).
        const { lod: _old, ...rest } = this.instances[i]!;
        void _old;
        const lod = liveLod(b.lod, this.live.get(i) ?? null);
        this.instances[i] = { ...rest, ...(lod ? { lod } : {}) };
        moved = true;
      }
    }
    const vistasChanged = vistaSignature(before.vistas) !== vistaSignature(next.vistas);
    if (vistasChanged) this.vistas = await texturedVistas(next.vistas, (mesh) => decodeMeshTextures(mesh, this.decodeKtx2 ?? (() => Promise.resolve(null))));
    if (vistasChanged || JSON.stringify(before.lighting ?? null) !== JSON.stringify(next.lighting ?? null)) {
      // The rig (or a vista) changed: re-bake the sky dome and the light the PBR shading samples.
      const lighting = next.lighting;
      let environment: EnvironmentLight | null = lighting ? sceneLightingEnvironment(lighting) : null;
      let skyMap: DecodedTexture | null = null;
      let clouds: BakedCloudLayer[] = [];
      if (lighting?.sky && environment) {
        const baked = await bakeSceneSky(lighting.sky, lighting, environment, this.vistas, next.bounds.center);
        skyMap = baked.map;
        clouds = baked.clouds;
        environment = { ...environment, map: baked.reflections, average: computeEnvironmentAverage(baked.reflections) };
      }
      this.environment = environment;
      this.skyMap = skyMap;
      this.skyClouds = clouds;
      this.skyCache = null;
      // The rig's armour colours (I8) may have changed: tint afresh.
      if (JSON.stringify(before.lighting?.tints ?? null) !== JSON.stringify(next.lighting?.tints ?? null)) this.tintCache.clear();
    }
    this.scene = next;
    if (moved) {
      this.unpooled = this.pooledRoot.some((r) => r >= 0) ? this.instances.filter((_, i) => this.pooledRoot[i]! < 0) : this.instances;
      this.flat = null;
      // The still objects' shadow was drawn where they stood: draw it again.
      this.farShadow.key = "";
      this.nearShadow.key = "";
      this.localShadowCache = [];
    }
    return true;
  }

  /** Apply a graphics quality preset (takes effect on the next frame). */
  setQuality(quality: QualitySettings): void {
    if (quality.shadowMapSize !== this.quality.shadowMapSize) {
      // A new map size: the cached maps are rebuilt at it.
      this.farShadow = newShadowLayer();
      this.nearShadow = newShadowLayer();
      this.localShadowCache = [];
    }
    this.quality = quality;
  }

  /**
   * The objects of levels that aren't loaded (see levels.ts in @cartbox/editor):
   * they're hidden, and left out of the shadow, until the set changes again.
   */
  setInactive(objects: ReadonlySet<number>): void {
    this.inactive = objects;
    this.inactiveKey = [...objects].sort((a, b) => a - b).join(",");
    // Nothing hidden and nothing pooled keeps the fast path (the full list, by identity).
    this.unpooled =
      objects.size === 0 && !this.pooledRoot.some((r) => r >= 0) ? this.instances : this.instances.filter((_, i) => this.pooledRoot[i]! < 0 && !objects.has(i));
    this.lastPlacement = null;
  }

  /** Posed instances plus, in a hierarchy, everything below them: what moves this frame. */
  private withChildren(indices: Iterable<number>): Set<number> {
    return this.hierarchy ? withDescendants(indices, this.hierarchy.children) : new Set(indices);
  }

  /**
   * Decode every instance's base-colour textures, then build the surface. Any
   * texture that fails to decode falls back to null (flat base colour), so a
   * bad image never blocks the cart — the mesh still renders, just untextured.
   */
  static async create(
    inner: DisplaySurface,
    width: number,
    height: number,
    scene: MeshScene,
    renderer: SceneRenderer = new SoftwareSceneRenderer(),
    options: MeshOverlayOptions = {},
  ): Promise<MeshOverlaySurface> {
    // Decode each distinct mesh's textures once: instances (and animation
    // frames) that share a model share its MeshAsset, so they share its maps.
    const decoded = new Map<MeshAsset, Promise<TexturedMesh>>();
    // The KTX2 decoder is fetched at most once, and only if some texture needs it.
    let ktx2: Promise<((bytes: Uint8Array) => DecodedTexture | null) | null> | null = null;
    const decodeKtx2 = (bytes: Uint8Array) => {
      ktx2 ??= options.ktx2 ? options.ktx2().catch(() => null) : Promise.resolve(null);
      return ktx2.then((decode) => (decode ? decode(bytes) : null));
    };
    const images = new Map<EncodedImage, Promise<DecodedTexture | null>>();
    const texture = (mesh: MeshAsset): Promise<TexturedMesh> => {
      let entry = decoded.get(mesh);
      if (!entry) {
        entry = decodeMeshTextures(mesh, decodeKtx2, images);
        decoded.set(mesh, entry);
      }
      return entry;
    };
    const instances: MeshSceneInstance[] = [];
    const frames: (readonly TexturedMesh[] | null)[] = [];
    const live = new Map<number, LiveSkinnedMesh>();
    for (const [i, instance] of scene.instances.entries()) {
      const textured = await texture(instance.mesh);
      // A skinned object draws its own live copy of the mesh (same textures), posed each frame.
      const skinned = isSkinned(instance.mesh) ? createLiveSkinnedMesh(instance.mesh) : null;
      if (skinned) live.set(i, skinned);
      const lod = liveLod(instance.lod, skinned);
      instances.push({ ...textured, ...(skinned ? { mesh: skinned.mesh } : {}), ...(lod ? { lod } : {}), model: instance.model });
      frames.push(instance.frames && instance.frames.length > 0 ? await Promise.all(instance.frames.map(texture)) : null);
    }
    // Bake the procedural sky dome once, if the rig authors one: the full map is
    // the backdrop, a small copy is the image-based light metals reflect.
    const lighting = scene.lighting;
    let skyMap: DecodedTexture | null = null;
    let clouds: BakedCloudLayer[] = [];
    let environment: EnvironmentLight | null = lighting ? sceneLightingEnvironment(lighting) : null;
    // Distant vistas (I7) are drawn into that panorama, textured as the frame would draw them.
    const vistas = await texturedVistas(scene.vistas, texture);
    if (lighting?.sky && environment) {
      const baked = await bakeSceneSky(lighting.sky, lighting, environment, vistas, scene.bounds.center);
      skyMap = baked.map;
      clouds = baked.clouds;
      environment = { ...environment, map: baked.reflections, average: computeEnvironmentAverage(baked.reflections) };
    }
    const surface = new MeshOverlaySurface(inner, width, height, scene, instances, frames, renderer, skyMap, environment, options);
    surface.skyClouds = clouds;
    surface.vistas = vistas;
    surface.trailed = scene.instances.flatMap((instance, i) => (instance.mesh.trails && instance.mesh.trails.length > 0 ? [i] : []));
    if (surface.trailed.length > 0) surface.trails = new TrailSystem();
    for (const [i, mesh] of live) surface.live.set(i, mesh);
    scene.instances.forEach((instance, i) => {
      if (instance.foliage) surface.foliage.set(instances[i]!.mesh, instance.foliage);
    });
    surface.decodeKtx2 = decodeKtx2;
    // 3D particle effects the cart fires with cartbox.burst.
    if (scene.effects && scene.effects.length > 0) surface.particles = new ParticleSystem(scene.effects);
    // Decals: the cart's marks and the scene's permanent ones.
    if (scene.decals && scene.decals.length > 0) surface.decals = new DecalSystem(scene.decals, scene.decalMarks ?? []);
    // Debris the cart throws (casings, dropped weapons): simulated here, on the
    // scene's colliders, each copy wearing its source's (textured) mesh.
    if (scene.debris && scene.debrisMeshes && scene.debris.length > 0) {
      surface.debris = new DebrisSystem(scene.debris, scene.debrisMeshes);
      surface.debrisBoxes = sceneColliders(scene);
      for (const [k, mesh] of scene.debrisMeshes.entries()) {
        const lod = scene.debrisLods?.[k];
        surface.debrisLooks.set(mesh, { ...(await texture(mesh)), ...(lod ? { lod } : {}) });
      }
    }
    // Reflection probes: each captures the scene's still objects from its point
    // and shiny surfaces in its box reflect that instead of the sky. Baked after
    // the scene is up, a probe per tick, so loading isn't held back; until then
    // everything reflects the sky.
    if (lighting?.probes && lighting.probes.length > 0 && environment) {
      const sky = environment;
      const still = scene.instances.flatMap((inst, i) => {
        const body = inst.physics?.body;
        const moves = body === "dynamic" || body === "kinematic" || body === "character";
        return inst.pooled || isSkinned(inst.mesh) || moves ? [] : [instances[i]!];
      });
      surface.probesReady = bakeReflectionProbesAsync(lighting.probes, still, {
        lightDirection: sceneLightingKeyDirection(lighting),
        ambient: lighting.ambient,
        environment: sky,
        lights: lighting.lights,
      })
        .then((probes) => {
          if (probes && !surface.destroyed) surface.environment = { ...sky, probes };
        })
        .catch(() => undefined);
    }
    return surface;
  }

  /** Decodes a KTX2 texture (loading the decoder on first use); set by create. */
  private decodeKtx2: (bytes: Uint8Array) => Promise<DecodedTexture | null> = async () => null;

  /**
   * Swap streamed textures in (see sceneStreaming.ts in @cartbox/editor): every
   * texture placeholder whose `ref` is in `images` is decoded and takes the
   * place of the flat colour it stood in for, from the next frame. Returns how
   * many objects changed.
   */
  async supplyImages(images: ReadonlyMap<string, EncodedImage>): Promise<number> {
    const resolved = new Map<MeshAsset, MeshAsset>();
    const resolve = (mesh: MeshAsset): MeshAsset => {
      let hit = resolved.get(mesh);
      if (!hit) {
        hit = fillPlaceholders(mesh, images);
        resolved.set(mesh, hit);
      }
      return hit;
    };
    const decoded = new Map<MeshAsset, Promise<TexturedMesh>>();
    const texture = (mesh: MeshAsset): Promise<TexturedMesh> => {
      let entry = decoded.get(mesh);
      if (!entry) {
        entry = decodeMeshTextures(mesh, this.decodeKtx2);
        decoded.set(mesh, entry);
      }
      return entry;
    };
    let changed = 0;
    for (const [i, instance] of this.scene.instances.entries()) {
      const mesh = resolve(instance.mesh);
      const frames = instance.frames?.map(resolve);
      const framesChanged = frames?.some((f, k) => f !== instance.frames![k]) ?? false;
      if (mesh === instance.mesh && !framesChanged) continue;
      if (mesh !== instance.mesh) {
        const { mesh: _decodedMesh, ...maps } = await texture(mesh);
        void _decodedMesh;
        // Keep what the instance draws (its live skinned copy, if any); only the maps change.
        this.instances[i] = { ...this.instances[i]!, ...maps };
      }
      if (frames && framesChanged) this.frames[i] = await Promise.all(frames.map(texture));
      changed += 1;
    }
    return changed;
  }

  /**
   * Set the cart-driven camera for the next frame(s), or null to auto-orbit. The
   * player calls this each frame from the decoded mesh-camera mailbox, so a cart
   * that stops publishing (null) smoothly hands the camera back to the auto-orbit.
   */
  setCameraOverride(camera: MailboxMeshCamera | null): void {
    this.cartCamera = camera;
  }

  /**
   * First-person mode: when true, the cart's 2D frame is composited as a HUD over
   * the 3D scene instead of the meshes being drawn over the 2D. The player sets it
   * each frame from the decoded mesh-camera HUD flag.
   */
  setHudMode(on: boolean): void {
    this.hud = on;
  }

  /**
   * Set the per-instance poses a cart published this frame (empty to leave every
   * instance at its authored transform). The player calls this each frame from the
   * decoded mesh-pose mailbox; a pose composes on top of the instance's authored
   * placement, and a hidden pose drops the instance from the frame.
   */
  setPoseOverrides(poses: readonly MailboxMeshPose[]): void {
    this.poses = poses;
  }

  /**
   * Where a top-level object has been moved to this frame — by its physics
   * body, by being spawned, or by the cart posing it — whether or not it's
   * drawn; null when it's where it was placed (or its pose hides it).
   * Spatial loading measures a moving object here rather than where it began.
   */
  movedModel(i: number): Mat4 | null {
    const body = this.bodies.get(i);
    if (body) return body;
    const spawnAt = this.pooledRoot[i] === i ? this.spawned.get(i) : undefined;
    const pose = this.poses.find((p) => p.index === i);
    if (pose?.hidden) return spawnAt ?? null;
    const base = spawnAt ?? this.instances[i]?.model;
    if (!base) return null;
    return pose ? multiplyMat4(base, poseLocalMatrix(pose)) : (spawnAt ?? null);
  }

  /**
   * The world-space point lights the cart published this frame (`cartbox.light3d`
   * — an objective's glow, a muzzle flash). They light a first-person view on
   * top of the authored rig's lights.
   */
  setCartLights(lights: readonly WorldLight[]): void {
    this.cartLights = lights.map((light) => ({ kind: "point", position: light.position, color: light.color, intensity: 1, range: light.range }));
  }

  /** Report per-pass times to `profiler` (null: stop). */
  setProfiler(profiler: Profiler | null): void {
    this.profiler = profiler;
  }

  /** What the renderer drew last frame. */
  renderStats(): RenderStats | null {
    return this.renderer.lastFrameStats ?? null;
  }

  /** Bytes the scene keeps for drawing (geometry, textures, targets), estimated. */
  sceneBytes(): number {
    return estimateSceneBytes(this.instances, this.width, this.height);
  }

  blit(rgba: Uint8Array): void {
    const started = performance.now();
    const profiler = this.profiler;
    // Default (third-person): copy the cart frame in, then composite the meshes on
    // top (background null shows the cart where no mesh drew). HUD mode inverts it:
    // render the 3D over an opaque sky, then lay the cart's 2D frame on top as a HUD.
    if (this.hud) {
      if (!this.hudFrame) this.hudFrame = new Uint8ClampedArray(this.width * this.height * 4);
      this.hudFrame.set(rgba);
    } else {
      this.output.set(rgba);
    }
    // A first-person view on the software rasteriser may render its 3D smaller
    // (see SOFTWARE_SCALES) and be expanded under the full-size HUD.
    const scale = this.renderScale();
    const target = scale === 1 ? null : this.lowTarget(scale);
    const width = target ? target.width : this.width;
    const height = target ? target.height : this.height;
    const out = target ? target.out : this.output;
    const depth = target ? target.depth : this.depth;
    // A cart-driven camera wins for this frame; otherwise the scene auto-orbits.
    const cart = this.cartCamera;
    const camera = cart
      ? buildOrbitCamera(this.scene.bounds, cart.yaw, cart.pitch, this.width / this.height, {
          fov: cart.fov ?? undefined,
          distance: cart.distance,
          targetOffset: cart.target,
          // First-person (HUD) views put the eye inside the scene: a tight near
          // plane keeps the held weapon and adjacent walls from being clipped.
          near: this.hud ? FIRST_PERSON_NEAR : undefined,
          extent: this.scene.extent,
        })
      : this.autoOrbitCamera();
    // The eye, from the view matrix (eye = −Rᵀt): terrain detail follows it.
    const v = camera.view;
    this.lastView = v;
    this.eye = [-(v[0]! * v[12]! + v[1]! * v[13]! + v[2]! * v[14]!), -(v[4]! * v[12]! + v[5]! * v[13]! + v[6]! * v[14]!), -(v[8]! * v[12]! + v[9]! * v[13]! + v[10]! * v[14]!)];
    const { main: instances, front, moved } = this.posedInstances();
    // Apply the authored Modern-tier lighting rig, if any. Absent (every cart
    // that never opted in) leaves these omitted, so the draw is exactly as before
    // and the fantasy tiers render byte-identically.
    const lighting = this.scene.lighting;
    let mark = profiler ? performance.now() : 0;
    const shadow = lighting ? this.buildShadow(instances, moved, lighting) : null;
    if (profiler) {
      const now = performance.now();
      profiler.add("shadow", now - mark);
      mark = now;
    }
    const rig = this.hud && this.cartLights.length > 0 ? [...(lighting?.lights ?? []), ...this.cartLights] : lighting?.lights;
    // Spot and point lights that cast get their own maps (EP8c), and their tiles.
    const local = lighting?.shadows && this.quality.shadows && rig ? this.buildLocalShadows(rig, moved) : null;
    const lights = local ? local.lights : rig;
    // First-person with a sky dome: paint the panorama through the camera, then
    // composite the meshes over it (background null) — backend-agnostic, since
    // both renderers leave untouched pixels alone.
    const skyBackdrop = this.hud && this.skyMap !== null;
    if (skyBackdrop) this.paintSky(out, width, height, camera.view, camera.projection, target ? 1 : SKY_BACKDROP_SCALE);
    if (profiler) {
      const now = performance.now();
      profiler.add("sky", now - mark);
      mark = now;
    }
    // Particles: stepped on the frame clock and drawn as billboards facing this camera.
    // Foliage blocks past their layer's cull distance aren't drawn (EP11).
    let drawn: readonly MeshSceneInstance[] = this.foliage.size > 0 ? instances.filter((i) => this.foliageInReach(i)) : instances;
    // Swing trails (I10): where each trailing object is now, then the ribbons it has swept.
    let frontDrawn: readonly MeshSceneInstance[] = front;
    if (this.trails) {
      const placed = this.placements();
      const now = this.frame / 60;
      for (const i of this.trailed) {
        const model = placed[i];
        if (!model) this.trails.cut(i);
        else this.trails.record(i, this.scene.instances[i]!.mesh.trails!, model, this.lastSkin.get(i) ?? null, now, this.lastFront[i] ?? false, camera.view);
      }
      const ribbons = this.trails.instances(now, camera.view);
      if (ribbons.main) drawn = [...drawn, ribbons.main];
      if (ribbons.front) frontDrawn = [...front, ribbons.front];
    }
    if (this.decals) {
      this.decals.step(1 / 60);
      const marks = this.decals.sceneInstance();
      if (marks) drawn = [...drawn, marks];
    }
    if (this.debris) {
      this.debris.step(1 / 60, this.debrisBoxes);
      const pieces = this.debris.instances();
      if (pieces.length > 0) drawn = [...drawn, ...pieces.map((p) => ({ ...(this.debrisLooks.get(p.mesh) ?? {}), ...p }))];
    }
    if (this.particles) {
      this.particles.step(1 / 60);
      const particles = this.particles.instanceFor([-v[2]!, -v[6]!, -v[10]!], [v[1]!, v[5]!, v[9]!]);
      if (particles) drawn = [...drawn, particles];
    }
    // Anti-aliasing (I1): the model's cap and the graphics quality must both allow it.
    const antialias = this.options.antialias === true && this.quality.antialias === true;
    this.renderer.render(drawn, {
      width,
      height,
      out,
      depth,
      view: camera.view,
      projection: camera.projection,
      // Objects with LOD levels (EP9b) draw the one their distance calls for.
      lod: true,
      antialias,
      temporal: this.options.temporal === true && this.quality.temporal === true,
      reflections: this.options.reflections === true && this.quality.reflections === true,
      // HUD mode fills the frame with a sky so the 3D scene is opaque before the
      // HUD lands on top; third-person keeps the cart frame behind the meshes.
      background: this.hud && !skyBackdrop ? HUD_SKY : null,
      ...(lighting
        ? {
            ambient: lighting.ambient,
            lightDirection: sceneLightingKeyDirection(lighting),
            environment: this.environment,
            tonemap: sceneLightingTonemap(lighting),
            lights,
            localShadows: local?.shadows ?? null,
            shadow,
            fog: lighting.fog ?? null,
          }
        : {}),
      // Animated emissive runs on the frame clock (60 per second), so it
      // steps with the game rather than the wall clock.
      time: this.frame / 60,
    });
    // Where the sun is and how much of it shows, for the glare and lens flare —
    // measured before the shafts brighten the sky round it.
    if (this.onSun) this.reportSun(out, width, height, camera.view, camera.projection, skyBackdrop ? lighting?.sky ?? null : null);
    // Sun shafts: open sky near the sun streaks through the gaps in the scene.
    // Drawn before the held weapon, which sits in front of the light.
    if (skyBackdrop && lighting?.shafts && lighting.sky && this.skyCache) {
      const sun = sunScreenPosition(lighting.sky.sunDirection, camera.view, camera.projection, width, height);
      if (sun) {
        this.shaftScratch ??= { mask: new Float32Array(0), light: new Float32Array(0) };
        applySunShafts(out, this.skyCache.pixels, width, height, sun, lighting.sky.sunColor, lighting.shafts, this.shaftScratch);
      }
    }
    // The front layer (a held weapon): drawn after the scene with a fresh depth
    // buffer, so it sits over everything and never clips into a wall. It is a
    // handful of triangles, so the software rasteriser draws it on any backend.
    if (frontDrawn.length > 0) {
      this.frontRenderer.render(frontDrawn, {
        width,
        height,
        out,
        depth,
        view: camera.view,
        projection: camera.projection,
        background: null,
        ...(lighting
          ? {
              ambient: lighting.ambient,
              lightDirection: sceneLightingKeyDirection(lighting),
              environment: this.environment,
              tonemap: sceneLightingTonemap(lighting),
              lights,
            }
          : {}),
        time: this.frame / 60,
      });
      // The software rasteriser doesn't multisample, so smooth the weapon's outline instead.
      if (antialias) {
        if (this.edgeScratch?.length !== out.length) this.edgeScratch = new Uint8ClampedArray(out.length);
        smoothFrontEdges(out, depth, width, height, this.edgeScratch);
      }
    }
    if (profiler) profiler.add("scene", performance.now() - mark);
    if (target) expandNearest(target.out, target.width, target.height, this.output, this.width, this.height);
    // Lay the cart's 2D frame over the rendered scene as a HUD (first-person).
    if (this.hud && this.hudFrame) compositeHudOverScene(this.output, this.hudFrame, this.width * this.height);
    this.frame += 1; // advance in lockstep with the run loop's present cadence
    this.inner.blit(this.presented);
    this.pace(performance.now() - started);
  }

  /** Report the sun to {@link onSun}: its place on screen and its eased visibility. */
  private reportSun(out: Uint8ClampedArray, width: number, height: number, view: Mat4, projection: Mat4, sky: { sunDirection: readonly [number, number, number] } | null): void {
    const backdrop = this.skyCache?.pixels ?? null;
    if (!sky || !backdrop) {
      this.sunSeen = 0;
      this.onSun?.(null);
      return;
    }
    const sun = sunScreenPosition(sky.sunDirection, view, projection, width, height);
    const target = sun ? sunVisibility(out, backdrop, width, height, sun) : 0;
    if (sun) this.sunAt = { x: sun.x / width, y: sun.y / height };
    // Eased, so the flare fades as a tower slides across the sun rather than popping.
    this.sunSeen += (target - this.sunSeen) * SUN_EASE;
    if (this.sunSeen < 1e-3) this.sunSeen = 0;
    this.onSun?.({ x: this.sunAt.x, y: this.sunAt.y, visible: this.sunSeen });
  }

  /** Paint the sky backdrop, or copy it from last frame when the view direction hasn't changed. */
  private paintSky(out: Uint8ClampedArray, width: number, height: number, view: Mat4, projection: Mat4, scale: number): void {
    const key = [width, height, scale, view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10], projection[0], projection[5]]
      .map((n) => Math.round(n! * 1e5))
      .join(",");
    const cache = this.skyCache;
    // Drifting clouds (I6) move every frame, so a sky with them is painted every
    // frame (and the copy the sun shafts read is refreshed with it).
    const drifting = this.skyClouds.length > 0;
    if (!drifting && cache && cache.key === key && cache.pixels.length === width * height * 4) {
      out.set(cache.pixels);
      return;
    }
    renderSkyBackground(out, width, height, view, projection, this.skyMap!, 8, scale, drifting ? { layers: this.skyClouds, time: this.frame / 60 } : null);
    const pixels = cache && cache.pixels.length === width * height * 4 ? cache.pixels : new Uint8ClampedArray(width * height * 4);
    pixels.set(out.subarray(0, width * height * 4));
    this.skyCache = { key, pixels };
  }

  /** The 3D render scale this frame: 1, unless the software governor has stepped down. */
  private renderScale(): number {
    if (!this.governed()) return 1;
    return Math.min(SOFTWARE_SCALES[this.scaleStep]!, this.quality.maxRenderScale);
  }

  /** Whether the resolution governor applies: a large first-person view on the CPU rasteriser. */
  private governed(): boolean {
    return (
      this.options.adaptiveResolution !== false &&
      this.hud &&
      this.renderer.backend === "software" &&
      this.width * this.height >= 640 * 360
    );
  }

  /** Step the software render scale by how long frames are taking. */
  private pace(ms: number): void {
    if (!this.governed()) return;
    this.frameMs = this.framesAtStep === 0 ? ms : this.frameMs * 0.9 + ms * 0.1;
    this.framesAtStep += 1;
    if (this.frameMs > SLOW_FRAME_MS && this.framesAtStep >= 4 && this.scaleStep < SOFTWARE_SCALES.length - 1) {
      this.scaleStep += 1;
      this.framesAtStep = 0;
    } else if (this.frameMs < FAST_FRAME_MS && this.framesAtStep >= 120 && this.scaleStep > 0) {
      this.scaleStep -= 1;
      this.framesAtStep = 0;
    }
  }

  /** Scratch buffers for a reduced-size render. */
  private lowTarget(scale: number): { width: number; height: number; out: Uint8ClampedArray; depth: Float32Array } {
    const width = Math.max(1, Math.round(this.width * scale));
    const height = Math.max(1, Math.round(this.height * scale));
    if (!this.low || this.low.width !== width || this.low.height !== height) {
      this.low = { width, height, out: new Uint8ClampedArray(width * height * 4), depth: new Float32Array(width * height) };
    }
    return this.low;
  }

  /**
   * The instances to draw this frame. With no poses, the authored set (the fast,
   * allocation-free path). Otherwise each authored instance with any matching
   * pose composed on top — a hidden pose drops it; a pose's `frame` swaps in one
   * of its animation frames, `tint` recolours its tintable materials, and `front`
   * moves it to the front layer. A pose's transform is applied in the instance's
   * LOCAL space (authored · pose), so a cart moves an object relative to where
   * the editor placed it. `moved` lists the posed main-layer instances — the
   * only part of the shadow map that has to be redrawn each frame.
   */
  private posedInstances(): {
    main: readonly MeshSceneInstance[];
    front: readonly MeshSceneInstance[];
    moved: readonly MeshSceneInstance[];
  } {
    if (this.poses.length === 0 && this.bodies.size === 0 && this.spawned.size === 0 && this.animated.size === 0 && this.effects.size === 0) {
      this.lastPlacement = null;
      this.lastFront = [];
      return { main: this.unpooled, front: [], moved: [] };
    }
    if (this.hierarchy) return this.posedHierarchy(this.hierarchy);
    if (this.bodies.size > 0 || this.spawned.size > 0 || this.animated.size > 0 || this.effects.size > 0 || this.unpooled !== this.instances) {
      this.flat ??= {
        parents: this.instances.map(() => -1),
        children: this.instances.map(() => []),
        locals: this.instances.map((instance) => instance.model),
      };
      return this.posedHierarchy(this.flat);
    }
    const main: MeshSceneInstance[] = [];
    const front: MeshSceneInstance[] = [];
    const moved: MeshSceneInstance[] = [];
    const placement: (Mat4 | null)[] = new Array(this.instances.length);
    this.lastFront = new Array(this.instances.length).fill(false);
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i]!;
      const pose = this.poses.find((p) => p.index === i);
      placement[i] = authored.model;
      if (!pose) {
        main.push(this.atDetail(i, authored));
        continue;
      }
      placement[i] = null;
      if (pose.hidden) continue; // dropped from the frame this tick
      const frames = this.frames[i];
      const frame = pose.frame ?? 0;
      const source: TexturedMesh = frame > 0 && frames && frames.length > 0 ? frames[(frame - 1) % frames.length]! : authored;
      const instance: MeshSceneInstance = {
        ...source,
        ...(pose.tint ? this.tintedLook(source, pose.tint) : {}),
        model: multiplyMat4(authored.model, poseLocalMatrix(pose)),
      };
      placement[i] = instance.model;
      this.lastFront[i] = Boolean(pose.front);
      if (pose.front) {
        front.push(instance);
      } else {
        main.push(instance);
        if (!this.scene.instances[i]?.terrain) moved.push(instance); // terrain casts nothing
      }
    }
    this.lastPlacement = placement;
    return { main, front, moved };
  }

  /**
   * {@link posedInstances} for a scene with parents. A child follows its parent:
   * its world matrix is the parent's (posed) world matrix times its own local
   * transform, then its own pose. Hiding a parent hides its children and putting
   * it on the front layer brings them along; anything under a posed object counts
   * as moved for the shadow cache. Unposed objects under unposed parents keep
   * their baked world matrix.
   */
  private posedHierarchy(h: NonNullable<MeshOverlaySurface["hierarchy"]>): {
    main: readonly MeshSceneInstance[];
    front: readonly MeshSceneInstance[];
    moved: readonly MeshSceneInstance[];
  } {
    const byIndex = new Map<number, MailboxMeshPose>();
    for (const pose of this.poses) if (!byIndex.has(pose.index)) byIndex.set(pose.index, pose);
    type State = { model: Mat4; hidden: boolean; front: boolean; moved: boolean; effect: SurfaceEffect | null };
    const states: (State | undefined)[] = new Array(this.instances.length);
    const state = (i: number): State => {
      const done = states[i];
      if (done) return done;
      const p = h.parents[i] ?? -1;
      const up = p >= 0 ? state(p) : null;
      const pose = byIndex.get(i);
      const body = this.bodies.get(i);
      // A reserve prefab copy is hidden until spawned, then placed where it was spawned.
      const poolRoot = this.pooledRoot[i] ?? -1;
      const reserved = poolRoot >= 0 && !this.spawned.has(poolRoot);
      const spawnAt = poolRoot === i ? this.spawned.get(i) : undefined;
      const moved = Boolean(pose) || Boolean(up?.moved) || Boolean(body) || Boolean(spawnAt) || this.animated.has(i);
      let model = this.instances[i]!.model;
      if (moved) {
        // A physics body is placed in world space; a spawned root where it was
        // spawned; otherwise follow the parent.
        const base = body ?? spawnAt ?? (up ? multiplyMat4(up.model, h.locals[i]!) : h.locals[i]!);
        model = pose ? multiplyMat4(base, poseLocalMatrix(pose)) : base;
      }
      const out = {
        model,
        moved,
        hidden: reserved || this.inactive.has(i) || Boolean(pose?.hidden) || Boolean(up?.hidden),
        front: Boolean(pose?.front) || Boolean(up?.front),
        // A shield effect covers the object and everything under it (its weapon, say).
        effect: this.effects.get(i) ?? up?.effect ?? null,
      };
      states[i] = out;
      return out;
    };
    const main: MeshSceneInstance[] = [];
    const front: MeshSceneInstance[] = [];
    const moved: MeshSceneInstance[] = [];
    const placement: (Mat4 | null)[] = new Array(this.instances.length);
    this.lastFront = new Array(this.instances.length).fill(false);
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i]!;
      const s = state(i);
      placement[i] = s.hidden ? null : s.model;
      this.lastFront[i] = s.front;
      if (s.hidden) continue;
      if (!s.moved) {
        main.push(s.effect ? { ...this.atDetail(i, authored), effect: s.effect } : this.atDetail(i, authored));
        continue;
      }
      const pose = byIndex.get(i);
      const frames = this.frames[i];
      const frame = pose?.frame ?? 0;
      const source: TexturedMesh = frame > 0 && frames && frames.length > 0 ? frames[(frame - 1) % frames.length]! : this.atDetail(i, authored);
      const instance: MeshSceneInstance = {
        ...source,
        ...(pose?.tint ? this.tintedLook(source, pose.tint) : {}),
        model: s.model,
        ...(s.effect ? { effect: s.effect } : {}),
      };
      if (s.front) front.push(instance);
      else {
        main.push(instance);
        if (!this.scene.instances[i]?.terrain) moved.push(instance); // terrain casts nothing
      }
    }
    this.lastPlacement = placement;
    return { main, front, moved };
  }

  /**
   * Each object's world matrix as last drawn, null where it was hidden (live
   * inspection). Before anything has moved, the authored placement.
   */
  /**
   * Each object's world matrix for the poses, bodies and spawns set so far this
   * frame (null = hidden), worked out now rather than read from the last draw —
   * what inverse kinematics aims with before the frame is skinned.
   */
  currentPlacements(): readonly (Mat4 | null)[] {
    this.posedInstances();
    return this.placements();
  }

  placements(): readonly (Mat4 | null)[] {
    return this.lastPlacement ?? this.instances.map((instance, i) => (this.pooledRoot[i]! >= 0 || this.inactive.has(i) ? null : instance.model));
  }

  /** A tinted instance's mesh and LOD levels (each level tinted alike). */
  private tintedLook(source: Pick<MeshSceneInstance, "mesh" | "lod">, tint: number): { mesh: MeshAsset; lod?: LodChain } {
    const mesh = this.tinted(source.mesh, tint);
    const lod = source.lod;
    if (!lod) return { mesh };
    return { mesh, lod: { distances: lod.distances, meshes: lod.meshes.map((m) => this.tinted(m, tint)) } };
  }

  /** A tinted copy of `mesh`, cached so its identity (and any GPU upload) is stable. */
  private tinted(mesh: MeshAsset, tint: number): MeshAsset {
    let byTint = this.tintCache.get(mesh);
    if (!byTint) {
      byTint = new Map();
      this.tintCache.set(mesh, byTint);
    }
    let out = byTint.get(tint);
    if (!out) {
      out = tintMesh(mesh, tint, this.scene.lighting?.tints);
      byTint.set(tint, out);
    }
    return out;
  }

  /** The camera's eye this frame (terrain blocks pick their detail by distance from it). */
  private eye: readonly [number, number, number] | null = null;

  /** The last frame's view matrix (null before the first frame). */
  private lastView: Mat4 | null = null;

  /** Where the camera was last drawn from and which way it looked: what the scene's sound hears from (EP12). */
  listenerPose(): { eye: readonly [number, number, number]; forward: readonly [number, number, number]; up: readonly [number, number, number] } | null {
    const v = this.lastView;
    if (!v || !this.eye) return null;
    // The view's rows: right, up, back (forward is −back).
    return { eye: this.eye, forward: [-v[2]!, -v[6]!, -v[10]!], up: [v[1]!, v[5]!, v[9]!] };
  }

  /** Where the camera was last drawn from (null before the first frame). */
  eyePosition(): readonly [number, number, number] | null {
    return this.eye;
  }
  /** Foliage blocks by mesh (EP11): their cull distance and bounds. */
  private readonly foliage = new Map<MeshAsset, NonNullable<MeshInstance["foliage"]>>();

  /** Whether an instance is in reach of the eye: anything but a foliage block is; a block is within its cull distance. */
  private foliageInReach(instance: MeshSceneInstance): boolean {
    const f = this.foliage.get(instance.mesh);
    if (!f || !this.eye) return true;
    const m = instance.model;
    const [x, y, z] = f.center;
    const cx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
    const cy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
    const cz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    return Math.hypot(cx - this.eye[0], cy - this.eye[1], cz - this.eye[2]) - f.radius < f.cull * this.quality.terrainDetail;
  }

  /** Each terrain block's world bounds, measured on first use. */
  private readonly blockBounds = new Map<number, readonly number[]>();

  /**
   * A terrain block at the detail its distance from the eye calls for: full
   * within its `detail` range, half out to twice that, quarter beyond. Anything
   * else is returned as it is.
   */
  private atDetail(i: number, authored: MeshSceneInstance): MeshSceneInstance {
    const detail = this.scene.instances[i]?.detail;
    const lods = this.frames[i];
    if (!detail || !lods || lods.length === 0 || !this.eye) return authored;
    let b = this.blockBounds.get(i);
    if (!b) {
      const m = authored.model;
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const primitive of authored.mesh.primitives) {
        const p = primitive.positions;
        for (let k = 0; k < p.length; k += 3) {
          const x = m[0]! * p[k]! + m[4]! * p[k + 1]! + m[8]! * p[k + 2]! + m[12]!;
          const y = m[1]! * p[k]! + m[5]! * p[k + 1]! + m[9]! * p[k + 2]! + m[13]!;
          const z = m[2]! * p[k]! + m[6]! * p[k + 1]! + m[10]! * p[k + 2]! + m[14]!;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
        }
      }
      b = [x0, y0, z0, x1, y1, z1];
      this.blockBounds.set(i, b);
    }
    const [ex, ey, ez] = this.eye;
    const d = Math.hypot(Math.max(b[0]! - ex, 0, ex - b[3]!), Math.max(b[1]! - ey, 0, ey - b[4]!), Math.max(b[2]! - ez, 0, ez - b[5]!));
    // Lower quality presets drop to coarser blocks sooner.
    const reach = detail * this.quality.terrainDetail;
    const level = d < reach ? 0 : d < reach * 2 ? 1 : 2;
    if (level === 0) return authored;
    return { ...lods[Math.min(level, lods.length) - 1]!, model: authored.model };
  }

  /** The engine's gentle auto-orbit round the scene, kept above any terrain. */
  private autoOrbitCamera(): ReturnType<typeof buildOrbitCamera> {
    const yaw = this.frame * AUTO_ORBIT_YAW_PER_FRAME;
    const pitch = orbitPitchAboveTerrain(this.scene, yaw, AUTO_ORBIT_PITCH);
    return buildOrbitCamera(this.scene.bounds, yaw, pitch, this.width / this.height, { extent: this.scene.extent });
  }

  /**
   * Render the scene's directional shadow map for this frame, or null when the
   * rig has shadows off / no directional light.
   *
   * Everything the cart did not pose this frame is static, so its depth is
   * rendered once and cached; each frame copies that cache and rasterises only
   * the posed (`moved`) instances over it. The cache is rebuilt when the set of
   * posed instances changes. For an arena whose map never moves, this turns a
   * full-scene shadow pass per frame into a memcpy plus a few characters.
   */
  private buildShadow(
    instances: readonly MeshSceneInstance[],
    moved: readonly MeshSceneInstance[],
    lighting: SceneLighting,
  ): ShadowInput | null {
    if (!lighting.shadows || !this.quality.shadows) return null;
    const size = this.quality.shadowMapSize || SHADOW_MAP_SIZE;
    const { center, radius } = this.scene.bounds;
    // The static map holds every instance the cart never poses. It depends only
    // on *which* instances are posed (not whether a posed one is hidden this
    // frame — a character dying must not re-render the whole arena's shadow),
    // and a held weapon never casts, so anything ever posed in front is out too.
    const key = this.staticShadowKey();
    // What never moves, gathered only when a layer must redraw its static map.
    const still = (): MeshSceneInstance[] => this.stillCasters();
    const extent = this.scene.extent;
    const reach = extent && this.scene.instances.some((inst) => inst.casts) ? Math.max(0, extent.radius * 2 - radius * 2) : 0;
    const far = this.renderShadowLayer(this.farShadow, key, still, moved, lighting, center, radius, size, reach);
    if (!far) return null;
    // The near cascade (EP8b): the same size of map over a box round the camera,
    // three or more times sharper. Its centre snaps to a grid half its size, so it
    // redraws only as the camera crosses a cell, not every frame it moves.
    let near: ShadowCascade | null = null;
    const nearRadius = Math.min(NEAR_CASCADE_MAX, Math.max(NEAR_CASCADE_MIN, radius * NEAR_CASCADE_SHARE));
    if (this.quality.shadowCascades && this.eye && nearRadius < radius * 0.7) {
      const step = nearRadius / 2;
      const c: [number, number, number] = [Math.round(this.eye[0] / step) * step, Math.round(this.eye[1] / step) * step, Math.round(this.eye[2] / step) * step];
      // Back the light off past the whole scene, so a far tower still shades the near box.
      const built = this.renderShadowLayer(this.nearShadow, `${key}|${c.join(",")}`, still, moved, lighting, c, nearRadius, size, Math.max(reach, radius * 2));
      if (built) near = { lightViewProj: built.lightViewProj, depth: built.depth, bias: built.bias ?? 0.003, slopeBias: built.slopeBias ?? 0, dirty: built.dirty };
    }
    return { ...far, near };
  }

  /**
   * What the static shadow maps depend on: *which* instances are posed (not
   * whether a posed one is hidden this frame — a character dying must not
   * re-render the whole arena's shadow); a held weapon never casts, so
   * anything ever posed in front is out too.
   */
  private staticShadowKey(): string {
    for (const i of this.withChildren(this.poses.filter((p) => p.front).map((p) => p.index))) this.everFront.add(i);
    return `${this.poses
      .filter((p) => !p.front)
      .map((p) => p.index)
      .sort((a, b) => a - b)
      .join(",")}|${[...this.everFront].sort((a, b) => a - b).join(",")}|${[...this.bodies.keys()].join(",")}|${[...this.live.keys()].join(",")}|${this.inactiveKey}`;
  }

  /** Everything that casts and never moves: what the static shadow maps hold. */
  private stillCasters(): MeshSceneInstance[] {
    // Skinned objects are never still: their shape changes as they animate.
    const posed = this.withChildren([...this.poses.map((p) => p.index), ...this.bodies.keys(), ...this.live.keys()]);
    // Reserve prefab copies are never part of the static shadow (hidden, or moving once spawned).
    this.pooledRoot.forEach((root, i) => {
      if (root >= 0) posed.add(i);
    });
    // Terrain frames nothing (the map is sized to the play space) and casts
    // only when its terrain says so — its cliffs shading the deck at a low sun.
    const casts = (i: number) => !this.scene.instances[i]?.terrain || this.scene.instances[i]?.casts === true;
    return this.instances.filter((_, i) => !posed.has(i) && !this.everFront.has(i) && !this.inactive.has(i) && casts(i));
  }

  /**
   * Shadows from the spot and point lights that cast (EP8c): each light's
   * tiles of everything still, cached until the light or the still set
   * changes, copied each frame with the movers drawn over them. Returns the
   * lights with their tiles assigned, or null when none casts.
   */
  private buildLocalShadows(lights: readonly SceneLight[], moved: readonly MeshSceneInstance[]): { lights: readonly SceneLight[]; shadows: LocalShadows } | null {
    const assigned = assignLocalShadowTiles(lights);
    if (assigned.tiles === 0) return null;
    const statics = this.staticShadowKey();
    const tiles: LocalShadowTile[] = [];
    let slot = 0;
    for (const light of assigned.lights) {
      if (light.shadowTile === undefined) continue;
      const key = `${JSON.stringify([light.kind, light.position, light.direction, light.range, light.innerAngle, light.outerAngle])}|${statics}`;
      let cache = this.localShadowCache[slot];
      if (!cache || cache.key !== key) {
        const built = renderLocalShadow(light, this.stillCasters());
        cache = { key, statics: built.map((t) => t.depth), frames: built.map((t) => new Float32Array(t.depth.length)) };
        this.localShadowCache[slot] = cache;
      }
      cache.frames.forEach((frame, i) => frame.set(cache!.statics[i]!));
      tiles.push(...renderLocalShadow(light, moved, cache.frames, false));
      slot += 1;
    }
    this.localShadowCache.length = slot;
    return { lights: assigned.lights, shadows: { tiles, bias: LOCAL_SHADOW_BIAS, slopeBias: LOCAL_SHADOW_SLOPE_BIAS } };
  }

  /**
   * One shadow map for this frame: the layer's cached static depth (redrawn
   * when `key` or the rig changes), copied, with this frame's movers drawn over
   * it — and the texels that changed since last frame, for a GPU's partial upload.
   */
  private renderShadowLayer(
    layer: ShadowLayer,
    key: string,
    still: () => MeshSceneInstance[],
    moved: readonly MeshSceneInstance[],
    lighting: SceneLighting,
    center: readonly [number, number, number],
    radius: number,
    size: number,
    reach: number,
  ): ShadowInput | null {
    let full = false;
    if (!layer.staticDepth || layer.key !== key || layer.lighting !== lighting) {
      layer.staticDepth ??= new Float32Array(size * size);
      const built = buildSceneShadow(still(), lighting, center, radius, { size, depth: layer.staticDepth, reach });
      if (!built) return null;
      layer.matrix = built.lightViewProj;
      layer.key = key;
      layer.lighting = lighting;
      full = true;
    }
    const base = layer.staticDepth;
    if (full || !layer.depth) {
      layer.depth ??= new Float32Array(size * size);
      layer.depth.set(base);
      full = true;
    } else {
      // Undo last frame's movers: restore just their rects from the static map.
      for (const r of layer.rects) {
        for (let y = r.y0; y < r.y1; y += 1) layer.depth.set(base.subarray(y * size + r.x0, y * size + r.x1), y * size + r.x0);
      }
    }
    const rects = moved.map((instance) => this.shadowFootprint(instance, size, layer.matrix)).filter((r): r is TexelRect => r !== null);
    const result = buildSceneShadow(moved, lighting, center, radius, { size, depth: layer.depth, clear: false, reach });
    if (!result) return null;
    let dirty: ShadowInput["dirty"] = null;
    if (!full) {
      const all = [...layer.rects, ...rects];
      if (all.length === 0) dirty = { x: 0, y: 0, width: 0, height: 0 };
      else {
        const x0 = Math.min(...all.map((r) => r.x0));
        const y0 = Math.min(...all.map((r) => r.y0));
        dirty = { x: x0, y: y0, width: Math.max(...all.map((r) => r.x1)) - x0, height: Math.max(...all.map((r) => r.y1)) - y0 };
      }
    }
    layer.rects = rects;
    return { ...result, dirty };
  }

  /**
   * The shadow-map texels an instance can cover: its bounding box through the
   * light's (orthographic) projection, padded for filtering and rounding.
   */
  private shadowFootprint(instance: MeshSceneInstance, size: number, m: Mat4 | null): TexelRect | null {
    if (!m) return null;
    // A live skinned mesh changes shape every frame: measure it afresh.
    let b = instance.mesh.primitives.some((p) => p.dynamic) ? undefined : this.meshBounds.get(instance.mesh);
    if (!b) {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const primitive of instance.mesh.primitives) {
        const p = primitive.positions;
        for (let i = 0; i < p.length; i += 3) {
          x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!);
          y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!);
          z0 = Math.min(z0, p[i + 2]!); z1 = Math.max(z1, p[i + 2]!);
        }
      }
      b = [x0, y0, z0, x1, y1, z1];
      if (!instance.mesh.primitives.some((p) => p.dynamic)) this.meshBounds.set(instance.mesh, b);
    }
    if (!Number.isFinite(b[0])) return null;
    const mm = multiplyMat4(m, instance.model);
    let sx0 = Infinity, sy0 = Infinity, sx1 = -Infinity, sy1 = -Infinity;
    for (let c = 0; c < 8; c += 1) {
      const x = c & 1 ? b[3] : b[0];
      const y = c & 2 ? b[4] : b[1];
      const z = c & 4 ? b[5] : b[2];
      const w = mm[3]! * x + mm[7]! * y + mm[11]! * z + mm[15]!;
      const nx = (mm[0]! * x + mm[4]! * y + mm[8]! * z + mm[12]!) / w;
      const ny = (mm[1]! * x + mm[5]! * y + mm[9]! * z + mm[13]!) / w;
      const tx = (nx * 0.5 + 0.5) * size;
      const ty = (1 - (ny * 0.5 + 0.5)) * size;
      sx0 = Math.min(sx0, tx); sx1 = Math.max(sx1, tx);
      sy0 = Math.min(sy0, ty); sy1 = Math.max(sy1, ty);
    }
    const pad = 2;
    const rect = {
      x0: Math.max(0, Math.floor(sx0) - pad),
      y0: Math.max(0, Math.floor(sy0) - pad),
      x1: Math.min(size, Math.ceil(sx1) + pad),
      y1: Math.min(size, Math.ceil(sy1) + pad),
    };
    return rect.x1 > rect.x0 && rect.y1 > rect.y0 ? rect : null;
  }

  destroy(): void {
    this.destroyed = true;
    this.inner.destroy();
  }

  private destroyed = false;
  /** The scene's 3D particle effects in flight, or null when it defines none. */
  private particles: ParticleSystem | null = null;
  /** The scene's decals on its surfaces, or null when it defines none. */
  private decals: DecalSystem | null = null;
  /** Debris in flight and at rest (H10), what it lands on, and each source mesh with its textures. */
  private debris: DebrisSystem | null = null;
  private debrisBoxes: RagdollBox[] = [];
  private readonly debrisLooks = new Map<MeshAsset, TexturedMesh & { readonly lod?: LodChain | null }>();

  /** Throw a copy of debris `debris` (see cartbox.debris). */
  throwDebris(debris: number, at: readonly [number, number, number], velocity: readonly [number, number, number], scale: number): void {
    this.debris?.throw(debris, at, velocity, scale);
  }

  /** Lay decal `decal` on a surface (see cartbox.decal). */
  decal(decal: number, at: readonly [number, number, number], normal: readonly [number, number, number], scale: number): void {
    this.decals?.lay(decal, at, normal, scale);
  }

  /** Fire particle effect `effect` (see cartbox.burst). */
  burst(effect: number, at: readonly [number, number, number], dir: readonly [number, number, number], scale: number): void {
    this.particles?.burst(effect, at, dir, scale);
  }
  /** Settles once the scene's reflection probes are baked and in use (tests await it). */
  probesReady: Promise<void> = Promise.resolve();
}

/** The mesh with each placeholder image whose ref is in `images` filled in (the same mesh when none is). */
function fillPlaceholders(mesh: MeshAsset, images: ReadonlyMap<string, EncodedImage>): MeshAsset {
  const slots = ["baseColorImage", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "detailImage", "blendImage", "reliefImage"] as const;
  let touched = false;
  const primitives = mesh.primitives.map((primitive) => {
    let material = primitive.material;
    for (const slot of slots) {
      const image = material[slot];
      const supplied = image?.ref ? images.get(image.ref) : undefined;
      if (supplied) {
        material = { ...material, [slot]: supplied };
        touched = true;
      }
    }
    return material === primitive.material ? primitive : { ...primitive, material };
  });
  return touched ? { ...mesh, primitives } : mesh;
}

/** Shadow map edge for a vista bake: one map over the whole far range, drawn once. */
const VISTA_SHADOW_SIZE = 2048;
/** The haze's sky is soft anyway: a small bake of it does. */
const VISTA_AIR_WIDTH = 192;

/** A scene's vistas with their meshes' maps decoded (the frame's own decode, so shared images decode once). */
async function texturedVistas(vistas: readonly SceneVista[] | undefined, texture: (mesh: MeshAsset) => Promise<TexturedMesh>): Promise<VistaLayer[]> {
  return Promise.all(
    (vistas ?? []).map(async (v) => ({ haze: v.haze, instances: await Promise.all(v.parts.map(async (p) => ({ ...(await texture(p.mesh)), model: p.model }))) })),
  );
}

/** What a vista bake depends on, so an edit that leaves the vistas alone doesn't redraw them. */
function vistaSignature(vistas: readonly SceneVista[] | undefined): string {
  return JSON.stringify((vistas ?? []).map((v) => [v.id, v.haze, v.parts.map((p) => [meshSignature(p.mesh), Array.from(p.model)])]));
}

/**
 * Bake a scene's sky (I6): its imported panorama decoded (a Radiance HDR by
 * our own decoder, exposed into 8 bits; anything else by the browser), the
 * dome baked with its objects, its distant vistas drawn over it from the play
 * space's centre `eye` (I7: lit by the rig, the sky's own light and a shadow
 * of their own), its cloud layers baked, and the reflections' copy —
 * downsampled, with the clouds laid over it at rest. A panorama that fails to
 * decode falls back to the procedural sky.
 */
async function bakeSceneSky(
  sky: ProceduralSky,
  lighting: SceneLighting,
  environment: EnvironmentLight,
  vistas: readonly VistaLayer[],
  eye: readonly [number, number, number],
): Promise<{ map: DecodedTexture; reflections: DecodedTexture; clouds: BakedCloudLayer[] }> {
  let imported: DecodedTexture | null = null;
  if (sky.panorama) {
    try {
      const bytes = base64ToBytes(sky.panorama.data);
      if (isRadiance(sky.panorama.mime)) {
        const hdr = decodeRadianceHdr(bytes);
        imported = hdr ? hdrToTexture(hdr, sky.panorama.exposure) : null;
      } else {
        imported = await decodeTexture(sky.panorama.mime, bytes);
      }
    } catch {
      imported = null;
    }
  }
  let map = bakeSkyPanorama(sky, SKY_PANORAMA_WIDTH, SKY_PANORAMA_HEIGHT, imported);
  const bounds = vistas.length > 0 ? vistaBounds(vistas) : null;
  if (bounds) {
    // The vistas are lit as the frame lights the near ground: the rig, the
    // sky's light (before they stand in it) and the fog, with their own shadow.
    const light = downsamplePanorama(map, SKY_IBL_DOWNSAMPLE);
    const shadow = buildSceneShadow(
      vistas.flatMap((v) => v.instances),
      lighting,
      bounds.center,
      bounds.radius,
      { size: VISTA_SHADOW_SIZE, depth: new Float32Array(VISTA_SHADOW_SIZE * VISTA_SHADOW_SIZE) },
    );
    // The haze is air: the sky without its ring and planets, which the vistas stand in front of.
    const air = sky.objects && sky.objects.length > 0 ? bakeSkyPanorama({ ...sky, objects: [] }, VISTA_AIR_WIDTH, VISTA_AIR_WIDTH / 2, imported) : null;
    map = bakeVistas(map, vistas, eye, {
      ambient: lighting.ambient,
      lightDirection: sceneLightingKeyDirection(lighting),
      lights: lighting.lights,
      // The sky's light alone: the play space's light probes don't reach out there.
      environment: { ...environment, lightProbes: undefined, map: light, average: computeEnvironmentAverage(light) },
      tonemap: sceneLightingTonemap(lighting),
      // Fog boxes sit in the play space, not out where the vistas are.
      fog: lighting.fog ? { ...lighting.fog, volumes: [] } : null,
      shadow,
    }, undefined, air);
  }
  const clouds = (sky.cloudLayers ?? []).map(bakeCloudLayer);
  const reflections = panoramaWithClouds(downsamplePanorama(map, SKY_IBL_DOWNSAMPLE), clouds, 0);
  return { map, reflections, clouds };
}

/** A mesh with every material map decoded — what an instance (or a frame) draws with. */
type TexturedMesh = Omit<MeshSceneInstance, "model">;

/** Decode all of one mesh's material maps; a failed decode falls back to null (flat). */
async function decodeMeshTextures(
  mesh: MeshAsset,
  decodeKtx2: (bytes: Uint8Array) => Promise<DecodedTexture | null>,
  cache?: Map<EncodedImage, Promise<DecodedTexture | null>>,
): Promise<TexturedMesh> {
  const decode = (image: EncodedImage) => (image.mime === "image/ktx2" ? decodeKtx2(image.bytes) : decodeTexture(image.mime, image.bytes));
  const each = (pick: (m: MeshAsset["primitives"][number]["material"]) => EncodedImage | null | undefined) =>
    Promise.all(
      mesh.primitives.map((primitive) => {
        const image = pick(primitive.material);
        // No image, or a streamed placeholder whose bytes haven't arrived: flat colour for now.
        if (!image || image.bytes.length === 0) return Promise.resolve(null);
        // Meshes that share an image (a terrain's blocks) share one decode.
        if (!cache) return decode(image);
        let entry = cache.get(image);
        if (!entry) {
          entry = decode(image);
          cache.set(image, entry);
        }
        return entry;
      }),
    );
  const [textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures, lightmapTextures, detailTextures, blendTextures, reliefTextures] = await Promise.all([
    each((m) => m.baseColorImage), // base colour
    each((m) => m.normalImage), // per-pixel normals (option 2)
    each((m) => m.materialImage), // packed specular/roughness/emissive (option 2, slice 5)
    // PBR maps for the Modern tier — absent on fantasy materials, so the
    // rasteriser stays byte-identical there.
    each((m) => m.metallicRoughnessImage),
    each((m) => m.occlusionImage),
    each((m) => m.emissiveImage),
    // A baked light map (sampled with the second UV set).
    each((m) => m.lightmapImage),
    // A finely tiled detail map (materialEffects.ts).
    each((m) => m.detailImage),
    // The blend surface of a blended primitive (terrain snow over rock).
    each((m) => m.blendImage),
    // The relief map: parallax height and wear curvature (materialLayers.ts).
    each((m) => m.reliefImage),
  ]);
  return {
    mesh,
    textures,
    normalTextures,
    materialTextures,
    mrTextures,
    occlusionTextures,
    emissiveTextures,
    ...(lightmapTextures.some((t) => t !== null) ? { lightmapTextures } : {}),
    ...(detailTextures.some((t) => t !== null) ? { detailTextures } : {}),
    ...(blendTextures.some((t) => t !== null) ? { blendTextures } : {}),
    ...(reliefTextures.some((t) => t !== null) ? { reliefTextures } : {}),
  };
}

/**
 * The 15 armour colours a pose's `tint` picks from (index 0 = no tint). Applied
 * to a mesh's `tintable` materials only, replacing their base colour's RGB.
 */
export const TINT_PALETTE: readonly (readonly [number, number, number])[] = [
  [1, 1, 1], // 0: unused (no tint)
  [0.62, 0.15, 0.13], // 1 red
  [0.2, 0.33, 0.62], // 2 blue
  [0.26, 0.45, 0.2], // 3 green
  [0.8, 0.42, 0.12], // 4 orange
  [0.42, 0.22, 0.58], // 5 purple
  [0.78, 0.62, 0.2], // 6 gold
  [0.4, 0.27, 0.16], // 7 brown
  [0.85, 0.45, 0.6], // 8 pink
  [0.85, 0.86, 0.88], // 9 white
  [0.14, 0.14, 0.15], // 10 black
  [0.45, 0.5, 0.56], // 11 steel
  [0.15, 0.5, 0.52], // 12 teal
  [0.38, 0.4, 0.2], // 13 olive
  [0.45, 0.06, 0.1], // 14 crimson
  [0.5, 0.6, 0.45], // 15 sage
];

/** A copy of `mesh` with its tintable materials recoloured (geometry arrays shared). */
/**
 * An instance's LOD chain as it draws: a skinned object's levels ride its live
 * copy's vertex buffers (posed each frame), with each level's triangle lists.
 */
function liveLod(lod: LodChain | null | undefined, live: LiveSkinnedMesh | null): LodChain | null {
  if (!lod || lod.meshes.length < 2) return null;
  if (!live) return lod;
  const levels = lod.meshes.slice(1).map((level) => ({ ...level, primitives: level.primitives.map((p, k) => ({ ...live.mesh.primitives[k]!, indices: p.indices })) }));
  return { distances: lod.distances, meshes: [live.mesh, ...levels] };
}

/** What tells two LOD chains apart (their switch distances and each level's size). */
function lodSignature(lod: LodChain | null | undefined): string {
  return lod ? `${lod.distances.join(",")}|${lod.meshes.map((m) => m.primitives.map((p) => p.indices.length).join(".")).join(",")}` : "";
}

export function tintMesh(mesh: MeshAsset, tint: number, overrides?: SceneLighting["tints"]): MeshAsset {
  // A scene's own armour colours (I8) stand in for the palette's.
  const color = overrides?.[tint] ?? TINT_PALETTE[tint];
  if (!color || tint === 0) return mesh;
  return {
    name: mesh.name,
    primitives: mesh.primitives.map((primitive) =>
      primitive.material.tintable
        ? {
            ...primitive,
            material: {
              ...primitive.material,
              baseColorFactor: [color[0], color[1], color[2], primitive.material.baseColorFactor[3]],
            },
          }
        : primitive,
    ),
  };
}

/**
 * Decode encoded image bytes into a tightly-packed RGBA {@link DecodedTexture}
 * using the browser's own image pipeline, off the DOM (OffscreenCanvas). Returns
 * null on any failure or in an environment without the decode APIs — the mesh
 * then renders with its flat base colour.
 */
async function decodeTexture(mime: string, bytes: Uint8Array): Promise<DecodedTexture | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  try {
    // The cast is safe: these are ordinary image bytes; TS only flags the
    // theoretical SharedArrayBuffer backing that a typed array's type admits.
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    bitmap.close();
    return { width: image.width, height: image.height, data: image.data };
  } catch {
    return null;
  }
}

/**
 * Smooth the outline of the front layer (I1). The front render starts from a
 * cleared depth buffer, so its pixels are the ones with a finite depth; each
 * pixel on either side of that boundary is blended with its four neighbours
 * (itself counting twice), a one-pixel feather standing in for the coverage
 * multisampling gives the GPU-drawn scene. `scratch` is the frame's size.
 */
export function smoothFrontEdges(out: Uint8ClampedArray, depth: Float32Array, width: number, height: number, scratch: Uint8ClampedArray): void {
  scratch.set(out);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const front = depth[i]! !== Infinity;
      const l = x > 0 ? i - 1 : i;
      const r = x < width - 1 ? i + 1 : i;
      const u = y > 0 ? i - width : i;
      const d = y < height - 1 ? i + width : i;
      if ((depth[l]! !== Infinity) === front && (depth[r]! !== Infinity) === front && (depth[u]! !== Infinity) === front && (depth[d]! !== Infinity) === front) continue;
      for (let c = 0; c < 3; c += 1) {
        out[i * 4 + c] = (2 * scratch[i * 4 + c]! + scratch[l * 4 + c]! + scratch[r * 4 + c]! + scratch[u * 4 + c]! + scratch[d * 4 + c]!) / 6;
      }
    }
  }
}

/** Expand a small RGBA frame to a larger one, nearest-neighbour, a word per pixel. */
function expandNearest(src: Uint8ClampedArray, sw: number, sh: number, dst: Uint8ClampedArray, dw: number, dh: number): void {
  const from = new Uint32Array(src.buffer, src.byteOffset, sw * sh);
  const to = new Uint32Array(dst.buffer, dst.byteOffset, dw * dh);
  const xs = new Int32Array(dw);
  for (let x = 0; x < dw; x += 1) xs[x] = Math.min(sw - 1, Math.floor((x * sw) / dw));
  let lastRow = -1;
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    const row = y * dw;
    if (sy === lastRow) {
      to.copyWithin(row, row - dw, row);
      continue;
    }
    const srow = sy * sw;
    for (let x = 0; x < dw; x += 1) to[row + x] = from[srow + xs[x]!]!;
    lastRow = sy;
  }
}

/** Whether two matrices are the same to within float noise. */
function sameMatrix(a: Mat4, b: Mat4): boolean {
  for (let i = 0; i < 16; i += 1) if (Math.abs(a[i]! - b[i]!) > 1e-9) return false;
  return true;
}

/** A cheap fingerprint of a mesh's geometry and materials (what an editor edit can change); images count by size. */
function meshSignature(mesh: MeshAsset): string {
  return mesh.primitives
    .map((p) => {
      const scalars: Record<string, unknown> = {};
      const images: number[] = [];
      for (const [key, value] of Object.entries(p.material)) {
        if (key.endsWith("Image")) images.push(value ? ((value as EncodedImage).bytes?.length ?? 0) : 0);
        else scalars[key] = value;
      }
      return `${p.positions.length}:${p.indices.length}:${JSON.stringify(scalars)}:${images.join(",")}`;
    })
    .join("|");
}
