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

import { composeModelMatrix, multiplyMat4, renderMeshScene, type DecodedTexture, type MeshSceneInstance } from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import type { MailboxMeshCamera, MailboxMeshPose } from "../mailbox.js";
import type { MeshScene } from "./meshScene.js";
import { buildOrbitCamera } from "./meshScene.js";

const RAD_TO_DEG = 180 / Math.PI;

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

  private constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly scene: MeshScene,
    /** The authored instances (baked placement); per-frame poses compose on top. */
    private readonly instances: readonly MeshSceneInstance[],
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
  static async create(inner: DisplaySurface, width: number, height: number, scene: MeshScene): Promise<MeshOverlaySurface> {
    const instances: MeshSceneInstance[] = [];
    for (const instance of scene.instances) {
      const textures = await Promise.all(
        instance.mesh.primitives.map((primitive) =>
          primitive.material.baseColorImage
            ? decodeTexture(primitive.material.baseColorImage.mime, primitive.material.baseColorImage.bytes)
            : Promise.resolve(null),
        ),
      );
      instances.push({ mesh: instance.mesh, model: instance.model, textures });
    }
    return new MeshOverlaySurface(inner, width, height, scene, instances);
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
   * Set the per-instance poses a cart published this frame (empty to leave every
   * instance at its authored transform). The player calls this each frame from the
   * decoded mesh-pose mailbox; a pose composes on top of the instance's authored
   * placement, and a hidden pose drops the instance from the frame.
   */
  setPoseOverrides(poses: readonly MailboxMeshPose[]): void {
    this.poses = poses;
  }

  blit(rgba: Uint8Array): void {
    // Copy the cart frame in, then composite the meshes on top (background: null
    // leaves untouched pixels showing the cart). The depth buffer is reset inside
    // renderMeshScene, so the instances form one consistent 3D layer each frame.
    this.output.set(rgba);
    // A cart-driven camera wins for this frame; otherwise the scene auto-orbits.
    const cart = this.cartCamera;
    const camera = cart
      ? buildOrbitCamera(this.scene.bounds, cart.yaw, cart.pitch, this.width / this.height, {
          fov: cart.fov ?? undefined,
          distance: cart.distance,
          targetOffset: cart.target,
        })
      : buildOrbitCamera(this.scene.bounds, this.frame * AUTO_ORBIT_YAW_PER_FRAME, AUTO_ORBIT_PITCH, this.width / this.height);
    renderMeshScene(this.posedInstances(), {
      width: this.width,
      height: this.height,
      out: this.output,
      depth: this.depth,
      view: camera.view,
      projection: camera.projection,
      background: null,
    });
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
      const local = composeModelMatrix(
        pose.position,
        [pose.rotation[0] * RAD_TO_DEG, pose.rotation[1] * RAD_TO_DEG, pose.rotation[2] * RAD_TO_DEG],
        [pose.scale, pose.scale, pose.scale],
      );
      result.push({ mesh: authored.mesh, model: multiplyMat4(authored.model, local), textures: authored.textures });
    }
    return result;
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
