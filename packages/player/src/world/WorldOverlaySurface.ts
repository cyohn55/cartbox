/**
 * WorldOverlaySurface — draws a cart's declared HD-2D {@link WorldScene} over the
 * frame: a height-mapped 3D terrain with the cart's 2D character sprites standing
 * in it as camera-facing billboards, all sharing one depth buffer so terrain and
 * characters occlude each other correctly.
 *
 * Like {@link MeshOverlaySurface} it decorates a {@link DisplaySurface}, so its
 * output flows through the lighting and post-FX stack. The terrain geometry is
 * built once (it is static); billboards are rebuilt each frame from the camera
 * basis (so they always face the viewer) at positions the cart supplies.
 *
 * To avoid a new engine mailbox channel, the world reuses the generic 3D-scene
 * channels the mesh feature already ships: the camera rides `cartbox.meshcam`
 * (exposed to carts as `cartbox.worldcam`) and each billboard's position rides a
 * `cartbox.meshpose` slot (exposed as `cartbox.billboard`). The player decodes
 * both and hands them here via {@link setCameraOverride} / {@link setBillboards}.
 *
 * Textures come from the cart's own sprite sheet through a {@link TextureLookup}
 * (built over `createCartSpriteSource`), decoded once per sprite and cached.
 */

import { renderMeshScene, type DecodedTexture, type MeshSceneInstance } from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import type { MailboxMeshCamera, MailboxMeshPose } from "../mailbox.js";
import {
  buildBillboardInstance,
  buildShadowInstance,
  buildTerrainInstances,
  buildWorldCamera,
  defaultCameraSpec,
  makeShadowTexture,
  CELL_WORLD,
  HEIGHT_WORLD,
  type TextureLookup,
  type WorldCameraSpec,
  type WorldScene,
} from "./worldScene.js";

/** A billboard the cart placed this frame: which slot, and where its feet stand. */
export interface WorldBillboardPose {
  /** Index into the scene's declared billboard slots. */
  readonly index: number;
  /** World position of the billboard's feet (grid units in x/z, height units in y). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Uniform scale on the slot's authored size (1 = as authored, 0 = hidden). */
  readonly scale: number;
}

export class WorldOverlaySurface implements DisplaySurface {
  private cartCamera: MailboxMeshCamera | null = null;
  private billboards: readonly WorldBillboardPose[] = [];
  /** The cart's key light direction (points toward the sun), for terrain shading. */
  private sunDirection: readonly [number, number, number] | null = null;
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;
  private readonly depth: Float32Array;
  private readonly terrain: MeshSceneInstance[];
  /** Per-slot billboard texture, index-aligned to `scene.billboards`. */
  private readonly billboardTextures: (DecodedTexture | null)[];
  /** Per-prop texture, index-aligned to `scene.props`. */
  private readonly propTextures: (DecodedTexture | null)[];
  /** Shared soft contact-shadow texture, drawn under characters and props. */
  private readonly shadowTexture: DecodedTexture = makeShadowTexture();

  constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly scene: WorldScene,
    textureFor: TextureLookup,
  ) {
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
    this.depth = new Float32Array(width * height);
    // Terrain is static: build it once. Textures are cached by the lookup.
    this.terrain = buildTerrainInstances(scene, textureFor);
    this.billboardTextures = scene.billboards.map((slot) => textureFor(slot.sprite));
    this.propTextures = scene.props.map((prop) => textureFor(prop.sprite));
  }

  /** Set the cart-driven camera for the next frame(s), or null to auto-frame. */
  setCameraOverride(camera: MailboxMeshCamera | null): void {
    this.cartCamera = camera;
  }

  /**
   * Set the key-light direction the terrain is shaded by (the cart's `cartbox.sun`,
   * pointing toward the light), or null to fall back to a default top-down key.
   * Colour is left to the post-FX grade, so this only steers the directional
   * light/shadow that makes the 3D blocks read as solid geometry.
   */
  setSun(direction: readonly [number, number, number] | null): void {
    this.sunDirection = direction;
  }

  /**
   * Set the billboard positions the cart published this frame. Reuses the mesh-pose
   * mailbox: each pose's index selects a billboard slot and its position places the
   * billboard's feet; a hidden or zero-scale pose drops the billboard.
   */
  setBillboards(poses: readonly MailboxMeshPose[]): void {
    this.billboards = poses
      .filter((pose) => !pose.hidden && pose.index < this.scene.billboards.length)
      .map((pose) => ({
        index: pose.index,
        x: pose.position[0],
        y: pose.position[1],
        z: pose.position[2],
        scale: pose.scale,
      }));
  }

  blit(rgba: Uint8Array): void {
    this.output.set(rgba);
    const spec = this.cameraSpec();
    const camera = buildWorldCamera(this.scene, spec, this.width / this.height);

    // A contact shadow on the ground under each character and prop, so they feel
    // planted in the scene rather than floating. Drawn before the sprites, all in
    // the one shared-depth pass below.
    const shadowInstances: MeshSceneInstance[] = [];

    // Static scenery props: camera-facing billboards at fixed positions, rebuilt
    // each frame from the current camera basis so they always face the viewer.
    const propInstances: MeshSceneInstance[] = [];
    for (let i = 0; i < this.scene.props.length; i += 1) {
      const prop = this.scene.props[i]!;
      const foot: [number, number, number] = [prop.x * CELL_WORLD, prop.y * HEIGHT_WORLD, prop.z * CELL_WORLD];
      shadowInstances.push(buildShadowInstance(foot, prop.width * 0.42, this.shadowTexture));
      propInstances.push(
        buildBillboardInstance(foot, prop.width, prop.height, camera.right, camera.up, this.propTextures[i] ?? null),
      );
    }

    // Billboards, rebuilt each frame to face the camera, at the cart's positions.
    const billboardInstances: MeshSceneInstance[] = [];
    for (const pose of this.billboards) {
      if (pose.scale <= 0) continue;
      const slot = this.scene.billboards[pose.index]!;
      const texture = this.billboardTextures[pose.index] ?? null;
      const foot: [number, number, number] = [
        pose.x * CELL_WORLD,
        pose.y * HEIGHT_WORLD,
        pose.z * CELL_WORLD,
      ];
      shadowInstances.push(buildShadowInstance(foot, slot.width * pose.scale * 0.42, this.shadowTexture));
      billboardInstances.push(
        buildBillboardInstance(foot, slot.width * pose.scale, slot.height * pose.scale, camera.right, camera.up, texture),
      );
    }

    // One shared depth buffer over terrain + shadows + billboards → correct HD-2D
    // occlusion. background null composites the world over the cart's 2D frame
    // (sky / HUD). A cart-driven sun gives the terrain directional light with more
    // contrast so raised blocks read as solid 3D; with no sun a soft top-down key.
    const lit = this.sunDirection !== null;
    renderMeshScene([...this.terrain, ...shadowInstances, ...propInstances, ...billboardInstances], {
      width: this.width,
      height: this.height,
      out: this.output,
      depth: this.depth,
      view: camera.view,
      projection: camera.projection,
      background: null,
      lightDirection: this.sunDirection ?? undefined,
      ambient: lit ? 0.45 : 0.62,
    });
    this.inner.blit(this.presented);
  }

  private cameraSpec(): WorldCameraSpec {
    const base = defaultCameraSpec(this.scene);
    const cart = this.cartCamera;
    if (!cart) return base;
    // A cart camera overrides yaw/pitch/distance/fov; 0 fields fall back to the
    // authored/default framing, matching the mesh camera's "0 = default" contract.
    const cartDistance = cart.distance ?? 0;
    const cartFov = cart.fov ?? 0;
    // A non-zero target (e.g. the player's position) makes the camera follow it;
    // all-zero means the cart set none, so we frame the whole terrain. (A cart
    // wanting the world origin can nudge the target by a hair.)
    const t = cart.target;
    const hasTarget = Boolean(t && (t[0] !== 0 || t[1] !== 0 || t[2] !== 0));
    return {
      yaw: cart.yaw,
      pitch: cart.pitch,
      distance: cartDistance > 0 ? cartDistance : base.distance,
      fov: cartFov > 0 ? cartFov : base.fov,
      target: hasTarget ? t : null,
    };
  }

  destroy(): void {
    this.inner.destroy();
  }
}
