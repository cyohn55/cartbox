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
  bakeSkyPanorama,
  buildSceneShadow,
  computeEnvironmentAverage,
  downsamplePanorama,
  renderSkyBackground,
  composeModelMatrix,
  multiplyMat4,
  sceneLightingEnvironment,
  sceneLightingKeyDirection,
  sceneLightingTonemap,
  type DecodedTexture,
  type EncodedImage,
  type EnvironmentLight,
  type Mat4,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import { SoftwareSceneRenderer, type SceneRenderer } from "../render/sceneRenderer.js";
import type { MailboxMeshCamera, MailboxMeshPose, WorldLight } from "../mailbox.js";
import type { ShadowInput, SceneLight, SceneLighting } from "@cartbox/editor";
import type { MeshScene } from "./meshScene.js";
import { buildOrbitCamera } from "./meshScene.js";

const RAD_TO_DEG = 180 / Math.PI;

/** Near clip plane for first-person (HUD) views, world units. */
const FIRST_PERSON_NEAR = 0.05;

/** Edge length of the directional shadow map — a fixed, self-contained cost. */
const SHADOW_MAP_SIZE = 1024;

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
}

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
/** Fixed downward tilt so the scene reads as a 3D object, not a flat silhouette. */
const AUTO_ORBIT_PITCH = 0.35;

export class MeshOverlaySurface implements DisplaySurface {
  private frame = 0;
  private cartCamera: MailboxMeshCamera | null = null;
  private poses: readonly MailboxMeshPose[] = [];
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;
  private readonly depth: Float32Array;
  /** Shadow-map depth scratch, allocated once the first shadowed frame needs it. */
  private shadowDepth: Float32Array | null = null;
  /** Cached shadow depth of everything not posed (see buildShadow), and what it was built for. */
  private staticShadow: Float32Array | null = null;
  private staticShadowKey = "";
  private staticShadowLighting: SceneLighting | null = null;
  /** The light's world→clip matrix of the cached static map (movers' footprints are projected with it). */
  private staticShadowMatrix: Mat4 | null = null;
  /** Shadow-map rects last frame's movers drew into (restored from the static map next frame). */
  private shadowRects: TexelRect[] = [];
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
  /** The cart's world lights this frame (cartbox.light3d), added to the rig's in first person. */
  private cartLights: readonly SceneLight[] = [];
  /** Tinted mesh copies, per source mesh and tint index. */
  private readonly tintCache = new Map<MeshAsset, Map<number, MeshAsset>>();
  /** Draws the front layer (a held weapon) over the finished scene. */
  private readonly frontRenderer = new SoftwareSceneRenderer();
  /** First-person mode: draw the meshes first, then the cart's 2D frame as a HUD on top. */
  private hud = false;
  /** Copy of the cart frame kept as the HUD layer while the 3D renders into `output`. */
  private hudFrame: Uint8ClampedArray | null = null;

  private constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly scene: MeshScene,
    /** The authored instances (baked placement); per-frame poses compose on top. */
    private readonly instances: readonly MeshSceneInstance[],
    /** Each instance's animation frames (textured), or null when it has none. */
    private readonly frames: readonly (readonly TexturedMesh[] | null)[],
    /**
     * What actually draws the triangles. Owned by whoever passed it — a renderer
     * is typically shared with the world overlay, so destroying this surface must
     * not dispose it. The default software renderer holds no resources.
     */
    private readonly renderer: SceneRenderer,
    /** The baked sky-dome panorama drawn behind a first-person view, or null. */
    private readonly skyMap: DecodedTexture | null,
    /** The environment the PBR shading samples (with the dome as its map), or null. */
    private readonly environment: EnvironmentLight | null,
    private readonly options: MeshOverlayOptions = {},
  ) {
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
    this.depth = new Float32Array(width * height);
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
    const texture = (mesh: MeshAsset): Promise<TexturedMesh> => {
      let entry = decoded.get(mesh);
      if (!entry) {
        entry = decodeMeshTextures(mesh);
        decoded.set(mesh, entry);
      }
      return entry;
    };
    const instances: MeshSceneInstance[] = [];
    const frames: (readonly TexturedMesh[] | null)[] = [];
    for (const instance of scene.instances) {
      instances.push({ ...(await texture(instance.mesh)), model: instance.model });
      frames.push(instance.frames && instance.frames.length > 0 ? await Promise.all(instance.frames.map(texture)) : null);
    }
    // Bake the procedural sky dome once, if the rig authors one: the full map is
    // the backdrop, a small copy is the image-based light metals reflect.
    const lighting = scene.lighting;
    let skyMap: DecodedTexture | null = null;
    let environment: EnvironmentLight | null = lighting ? sceneLightingEnvironment(lighting) : null;
    if (lighting?.sky && environment) {
      skyMap = bakeSkyPanorama(lighting.sky, SKY_PANORAMA_WIDTH, SKY_PANORAMA_HEIGHT);
      const ibl = downsamplePanorama(skyMap, SKY_IBL_DOWNSAMPLE);
      environment = { ...environment, map: ibl, average: computeEnvironmentAverage(ibl) };
    }
    return new MeshOverlaySurface(inner, width, height, scene, instances, frames, renderer, skyMap, environment, options);
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
   * The world-space point lights the cart published this frame (`cartbox.light3d`
   * — an objective's glow, a muzzle flash). They light a first-person view on
   * top of the authored rig's lights.
   */
  setCartLights(lights: readonly WorldLight[]): void {
    this.cartLights = lights.map((light) => ({ kind: "point", position: light.position, color: light.color, intensity: 1, range: light.range }));
  }

  blit(rgba: Uint8Array): void {
    const started = performance.now();
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
        })
      : buildOrbitCamera(this.scene.bounds, this.frame * AUTO_ORBIT_YAW_PER_FRAME, AUTO_ORBIT_PITCH, this.width / this.height);
    const { main: instances, front, moved } = this.posedInstances();
    // Apply the authored Modern-tier lighting rig, if any. Absent (every cart
    // that never opted in) leaves these omitted, so the draw is exactly as before
    // and the fantasy tiers render byte-identically.
    const lighting = this.scene.lighting;
    const shadow = lighting ? this.buildShadow(instances, moved, lighting) : null;
    const lights = this.hud && this.cartLights.length > 0 ? [...(lighting?.lights ?? []), ...this.cartLights] : lighting?.lights;
    // First-person with a sky dome: paint the panorama through the camera, then
    // composite the meshes over it (background null) — backend-agnostic, since
    // both renderers leave untouched pixels alone.
    const skyBackdrop = this.hud && this.skyMap !== null;
    if (skyBackdrop) this.paintSky(out, width, height, camera.view, camera.projection, target ? 1 : SKY_BACKDROP_SCALE);
    this.renderer.render(instances, {
      width,
      height,
      out,
      depth,
      view: camera.view,
      projection: camera.projection,
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
            shadow,
            fog: lighting.fog ?? null,
          }
        : {}),
    });
    // The front layer (a held weapon): drawn after the scene with a fresh depth
    // buffer, so it sits over everything and never clips into a wall. It is a
    // handful of triangles, so the software rasteriser draws it on any backend.
    if (front.length > 0) {
      this.frontRenderer.render(front, {
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
      });
    }
    if (target) expandNearest(target.out, target.width, target.height, this.output, this.width, this.height);
    // Lay the cart's 2D frame over the rendered scene as a HUD (first-person).
    if (this.hud && this.hudFrame) compositeHudOverScene(this.output, this.hudFrame, this.width * this.height);
    this.frame += 1; // advance in lockstep with the run loop's present cadence
    this.inner.blit(this.presented);
    this.pace(performance.now() - started);
  }

  /** Paint the sky backdrop, or copy it from last frame when the view direction hasn't changed. */
  private paintSky(out: Uint8ClampedArray, width: number, height: number, view: Mat4, projection: Mat4, scale: number): void {
    const key = [width, height, scale, view[0], view[1], view[2], view[4], view[5], view[6], view[8], view[9], view[10], projection[0], projection[5]]
      .map((n) => Math.round(n! * 1e5))
      .join(",");
    const cache = this.skyCache;
    if (cache && cache.key === key && cache.pixels.length === width * height * 4) {
      out.set(cache.pixels);
      return;
    }
    renderSkyBackground(out, width, height, view, projection, this.skyMap!, 8, scale);
    const pixels = cache && cache.pixels.length === width * height * 4 ? cache.pixels : new Uint8ClampedArray(width * height * 4);
    pixels.set(out.subarray(0, width * height * 4));
    this.skyCache = { key, pixels };
  }

  /** The 3D render scale this frame: 1, unless the software governor has stepped down. */
  private renderScale(): number {
    if (!this.governed()) return 1;
    return SOFTWARE_SCALES[this.scaleStep]!;
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
    if (this.poses.length === 0) return { main: this.instances, front: [], moved: [] };
    const main: MeshSceneInstance[] = [];
    const front: MeshSceneInstance[] = [];
    const moved: MeshSceneInstance[] = [];
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i]!;
      const pose = this.poses.find((p) => p.index === i);
      if (!pose) {
        main.push(authored);
        continue;
      }
      if (pose.hidden) continue; // dropped from the frame this tick
      const frames = this.frames[i];
      const frame = pose.frame ?? 0;
      const source: TexturedMesh = frame > 0 && frames && frames.length > 0 ? frames[(frame - 1) % frames.length]! : authored;
      const instance: MeshSceneInstance = {
        ...source,
        mesh: pose.tint ? this.tinted(source.mesh, pose.tint) : source.mesh,
        model: multiplyMat4(authored.model, poseLocalMatrix(pose)),
      };
      if (pose.front) {
        front.push(instance);
      } else {
        main.push(instance);
        moved.push(instance);
      }
    }
    return { main, front, moved };
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
      out = tintMesh(mesh, tint);
      byTint.set(tint, out);
    }
    return out;
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
    if (!lighting.shadows) return null;
    const size = SHADOW_MAP_SIZE;
    const { center, radius } = this.scene.bounds;
    // The static map holds every instance the cart never poses. It depends only
    // on *which* instances are posed (not whether a posed one is hidden this
    // frame — a character dying must not re-render the whole arena's shadow),
    // and a held weapon never casts, so anything ever posed in front is out too.
    for (const pose of this.poses) if (pose.front) this.everFront.add(pose.index);
    const key = `${this.poses
      .filter((p) => !p.front)
      .map((p) => p.index)
      .sort((a, b) => a - b)
      .join(",")}|${[...this.everFront].sort((a, b) => a - b).join(",")}`;
    let full = false;
    if (!this.staticShadow || this.staticShadowKey !== key || this.staticShadowLighting !== lighting) {
      this.staticShadow ??= new Float32Array(size * size);
      const posed = new Set(this.poses.map((p) => p.index));
      const still = this.instances.filter((_, i) => !posed.has(i) && !this.everFront.has(i));
      const built = buildSceneShadow(still, lighting, center, radius, { size, depth: this.staticShadow });
      if (!built) return null;
      this.staticShadowMatrix = built.lightViewProj;
      this.staticShadowKey = key;
      this.staticShadowLighting = lighting;
      full = true;
    }
    const base = this.staticShadow;
    if (full || !this.shadowDepth) {
      this.shadowDepth ??= new Float32Array(size * size);
      this.shadowDepth.set(base);
      full = true;
    } else {
      // Undo last frame's movers: restore just their rects from the static map.
      for (const r of this.shadowRects) {
        for (let y = r.y0; y < r.y1; y += 1) this.shadowDepth.set(base.subarray(y * size + r.x0, y * size + r.x1), y * size + r.x0);
      }
    }
    const rects = moved.map((instance) => this.shadowFootprint(instance, size)).filter((r): r is TexelRect => r !== null);
    const result = buildSceneShadow(moved, lighting, center, radius, { size, depth: this.shadowDepth, clear: false });
    if (!result) return null;
    let dirty: ShadowInput["dirty"] = null;
    if (!full) {
      const all = [...this.shadowRects, ...rects];
      if (all.length === 0) dirty = { x: 0, y: 0, width: 0, height: 0 };
      else {
        const x0 = Math.min(...all.map((r) => r.x0));
        const y0 = Math.min(...all.map((r) => r.y0));
        dirty = { x: x0, y: y0, width: Math.max(...all.map((r) => r.x1)) - x0, height: Math.max(...all.map((r) => r.y1)) - y0 };
      }
    }
    this.shadowRects = rects;
    return { ...result, dirty };
  }

  /**
   * The shadow-map texels an instance can cover: its bounding box through the
   * light's (orthographic) projection, padded for filtering and rounding.
   */
  private shadowFootprint(instance: MeshSceneInstance, size: number): TexelRect | null {
    const m = this.staticShadowMatrix;
    if (!m) return null;
    let b = this.meshBounds.get(instance.mesh);
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
      this.meshBounds.set(instance.mesh, b);
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
    this.inner.destroy();
  }
}

/** A mesh with every material map decoded — what an instance (or a frame) draws with. */
type TexturedMesh = Omit<MeshSceneInstance, "model">;

/** Decode all of one mesh's material maps; a failed decode falls back to null (flat). */
async function decodeMeshTextures(mesh: MeshAsset): Promise<TexturedMesh> {
  const each = (pick: (m: MeshAsset["primitives"][number]["material"]) => EncodedImage | null | undefined) =>
    Promise.all(
      mesh.primitives.map((primitive) => {
        const image = pick(primitive.material);
        return image ? decodeTexture(image.mime, image.bytes) : Promise.resolve(null);
      }),
    );
  const [textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures] = await Promise.all([
    each((m) => m.baseColorImage), // base colour
    each((m) => m.normalImage), // per-pixel normals (option 2)
    each((m) => m.materialImage), // packed specular/roughness/emissive (option 2, slice 5)
    // PBR maps for the Modern tier — absent on fantasy materials, so the
    // rasteriser stays byte-identical there.
    each((m) => m.metallicRoughnessImage),
    each((m) => m.occlusionImage),
    each((m) => m.emissiveImage),
  ]);
  return { mesh, textures, normalTextures, materialTextures, mrTextures, occlusionTextures, emissiveTextures };
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
export function tintMesh(mesh: MeshAsset, tint: number): MeshAsset {
  const color = TINT_PALETTE[tint];
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
