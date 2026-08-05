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
 * Camera control is deliberately minimal for Phase 2: the scene auto-orbits at a
 * gentle rate so a declared mesh is visibly rendered in the runtime. The Phase 3
 * draw mailbox will let a cart drive the camera itself; nothing here needs to
 * change when it does — only the camera source.
 *
 * Textures are decoded once, asynchronously, at construction (the browser owns
 * image decoding), which is why the surface is built through a static async
 * `create`, mirroring `LitCanvasSurface.create`.
 */

import { renderMeshScene, type DecodedTexture, type MeshSceneInstance } from "@cartbox/editor";
import type { DisplaySurface } from "../display.js";
import type { MeshScene } from "./meshScene.js";
import { buildOrbitCamera } from "./meshScene.js";

/** Radians of yaw per presented frame — one full turn every ~12s at 60Hz. */
const AUTO_ORBIT_YAW_PER_FRAME = (2 * Math.PI) / 720;
/** Fixed downward tilt so the scene reads as a 3D object, not a flat silhouette. */
const AUTO_ORBIT_PITCH = 0.35;

export class MeshOverlaySurface implements DisplaySurface {
  private frame = 0;
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;
  private readonly depth: Float32Array;

  private constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly scene: MeshScene,
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

  blit(rgba: Uint8Array): void {
    // Copy the cart frame in, then composite the meshes on top (background: null
    // leaves untouched pixels showing the cart). The depth buffer is reset inside
    // renderMeshScene, so the instances form one consistent 3D layer each frame.
    this.output.set(rgba);
    const yaw = this.frame * AUTO_ORBIT_YAW_PER_FRAME;
    const camera = buildOrbitCamera(this.scene.bounds, yaw, AUTO_ORBIT_PITCH, this.width / this.height);
    renderMeshScene(this.instances, {
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
