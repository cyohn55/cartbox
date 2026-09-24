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
  type EnvironmentLight,
  type Mat4,
  type MeshSceneInstance,
} from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import { SoftwareSceneRenderer, type SceneRenderer } from "../render/sceneRenderer.js";
import type { MailboxMeshCamera, MailboxMeshPose } from "../mailbox.js";
import type { ShadowInput, SceneLighting } from "@cartbox/editor";
import type { MeshScene } from "./meshScene.js";
import { buildOrbitCamera } from "./meshScene.js";

const RAD_TO_DEG = 180 / Math.PI;

/** Near clip plane for first-person (HUD) views, world units. */
const FIRST_PERSON_NEAR = 0.05;

/** Edge length of the directional shadow map — a fixed, self-contained cost. */
const SHADOW_MAP_SIZE = 1024;

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
  ): Promise<MeshOverlaySurface> {
    const instances: MeshSceneInstance[] = [];
    for (const instance of scene.instances) {
      const textures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.baseColorImage
            ? decodeTexture(primitive.material.baseColorImage.mime, primitive.material.baseColorImage.bytes)
            : Promise.resolve(null),
        ),
      );
      // Decode any authored normal map too, so the rasteriser can light the
      // surface per-pixel (option 2). A failed decode falls back to null (flat).
      const normalTextures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.normalImage
            ? decodeTexture(primitive.material.normalImage.mime, primitive.material.normalImage.bytes)
            : Promise.resolve(null),
        ),
      );
      // And the packed material map (specular/roughness/emissive), for the
      // view-dependent highlight + emissive floor (option 2, slice 5).
      const materialTextures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.materialImage
            ? decodeTexture(primitive.material.materialImage.mime, primitive.material.materialImage.bytes)
            : Promise.resolve(null),
        ),
      );
      // PBR (metallic-roughness) maps for the Modern tier: packed
      // metallic-roughness, ambient occlusion, and emissive. Absent on fantasy
      // materials, so the rasteriser stays byte-identical there. A failed decode
      // falls back to null, and the BRDF uses the material's scalar factors.
      const mrTextures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.metallicRoughnessImage
            ? decodeTexture(primitive.material.metallicRoughnessImage.mime, primitive.material.metallicRoughnessImage.bytes)
            : Promise.resolve(null),
        ),
      );
      const occlusionTextures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.occlusionImage
            ? decodeTexture(primitive.material.occlusionImage.mime, primitive.material.occlusionImage.bytes)
            : Promise.resolve(null),
        ),
      );
      const emissiveTextures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.emissiveImage
            ? decodeTexture(primitive.material.emissiveImage.mime, primitive.material.emissiveImage.bytes)
            : Promise.resolve(null),
        ),
      );
      instances.push({
        mesh: instance.mesh,
        model: instance.model,
        textures,
        normalTextures,
        materialTextures,
        mrTextures,
        occlusionTextures,
        emissiveTextures,
      });
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
    return new MeshOverlaySurface(inner, width, height, scene, instances, renderer, skyMap, environment);
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

  blit(rgba: Uint8Array): void {
    // Default (third-person): copy the cart frame in, then composite the meshes on
    // top (background null shows the cart where no mesh drew). HUD mode inverts it:
    // render the 3D over an opaque sky, then lay the cart's 2D frame on top as a HUD.
    if (this.hud) {
      if (!this.hudFrame) this.hudFrame = new Uint8ClampedArray(this.width * this.height * 4);
      this.hudFrame.set(rgba);
    } else {
      this.output.set(rgba);
    }
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
    const instances = this.posedInstances();
    // Apply the authored Modern-tier lighting rig, if any. Absent (every cart
    // that never opted in) leaves these omitted, so the draw is exactly as before
    // and the fantasy tiers render byte-identically.
    const lighting = this.scene.lighting;
    const shadow = lighting ? this.buildShadow(instances, lighting) : null;
    // First-person with a sky dome: paint the panorama through the camera, then
    // composite the meshes over it (background null) — backend-agnostic, since
    // both renderers leave untouched pixels alone.
    const skyBackdrop = this.hud && this.skyMap !== null;
    if (skyBackdrop) renderSkyBackground(this.output, this.width, this.height, camera.view, camera.projection, this.skyMap!);
    this.renderer.render(instances, {
      width: this.width,
      height: this.height,
      out: this.output,
      depth: this.depth,
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
            lights: lighting.lights,
            shadow,
            fog: lighting.fog ?? null,
          }
        : {}),
    });
    // Lay the cart's 2D frame over the rendered scene as a HUD (first-person).
    if (this.hud && this.hudFrame) compositeHudOverScene(this.output, this.hudFrame, this.width * this.height);
    this.frame += 1; // advance in lockstep with the run loop's present cadence
    this.inner.blit(this.presented);
  }

  /**
   * The instances to draw this frame: the authored set when the cart posed none
   * (the fast, allocation-free path), otherwise each authored instance with any
   * matching pose composed on top — a hidden pose drops the instance entirely.
   * A pose's transform is applied in the instance's LOCAL space (authored · pose),
   * so a cart spins/moves an object relative to where the editor placed it.
   */
  private posedInstances(): readonly MeshSceneInstance[] {
    if (this.poses.length === 0) return this.instances;
    const result: MeshSceneInstance[] = [];
    for (let i = 0; i < this.instances.length; i += 1) {
      const authored = this.instances[i]!;
      const pose = this.poses.find((p) => p.index === i);
      if (!pose) {
        result.push(authored);
        continue;
      }
      if (pose.hidden) continue; // dropped from the frame this tick
      const local = poseLocalMatrix(pose);
      result.push({
        mesh: authored.mesh,
        model: multiplyMat4(authored.model, local),
        textures: authored.textures,
        normalTextures: authored.normalTextures,
        materialTextures: authored.materialTextures,
        mrTextures: authored.mrTextures,
        occlusionTextures: authored.occlusionTextures,
        emissiveTextures: authored.emissiveTextures,
      });
    }
    return result;
  }

  /**
   * Render the scene's directional shadow map for this frame, or null when the
   * rig has shadows off / no directional light. The depth scratch is allocated
   * once and reused, since the map size is fixed.
   */
  private buildShadow(instances: readonly MeshSceneInstance[], lighting: SceneLighting): ShadowInput | null {
    if (!lighting.shadows) return null;
    if (!this.shadowDepth) this.shadowDepth = new Float32Array(SHADOW_MAP_SIZE * SHADOW_MAP_SIZE);
    const { center, radius } = this.scene.bounds;
    return buildSceneShadow(instances, lighting, center, radius, { size: SHADOW_MAP_SIZE, depth: this.shadowDepth });
  }

  destroy(): void {
    this.inner.destroy();
  }
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
