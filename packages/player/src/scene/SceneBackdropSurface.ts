/**
 * SceneBackdropSurface — a display surface that draws a parallax scene backdrop
 * behind the cart's live frame, then presents the result through an inner surface.
 *
 * It decorates any {@link DisplaySurface} (plain 2D, lit, or the FX chain's base):
 * each frame it renders the declared backdrop (parallax layers + aerial-perspective
 * atmosphere) at the scene camera, chroma-keys the cart's own frame over it (the
 * cart's background colour shows the backdrop, its foreground is kept), and blits
 * the composite to the inner surface. Because it runs on the RAW frame before the
 * inner surface, any lighting / post-FX the inner surface applies finishes the
 * backdrop and foreground together.
 *
 * The layers are resolved once (their pixels are static); only the camera advances
 * per frame, so per-frame cost is one composite pass.
 */

import type { DisplaySurface } from "../display.js";
import { compositeOverBackdrop } from "./sceneComposite.js";
import type { Rgb } from "./parallaxScene.js";
import type { ParallaxLayer } from "./parallaxScene.js";
import { renderSceneBackdrop } from "./sceneRender.js";
import type { SceneSpec } from "./sceneModel.js";

export class SceneBackdropSurface implements DisplaySurface {
  private frame = 0;
  private readonly backdrop: Uint8ClampedArray;
  private readonly composited: Uint8ClampedArray;
  // blit receives a Uint8Array; the composite output is presented as one too.
  private readonly presented: Uint8Array;

  constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly layers: readonly ParallaxLayer[],
    private readonly spec: SceneSpec,
    private readonly keyRgb: Rgb,
  ) {
    const size = width * height * 4;
    this.backdrop = new Uint8ClampedArray(size);
    this.composited = new Uint8ClampedArray(size);
    this.presented = new Uint8Array(this.composited.buffer);
  }

  blit(rgba: Uint8Array): void {
    // A cart frame is Uint8Array; the scene passes work in Uint8ClampedArray.
    // They share byte semantics, so wrap without copying.
    const cartFrame = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    renderSceneBackdrop(this.backdrop, this.width, this.height, this.layers, this.spec, this.frame);
    compositeOverBackdrop(cartFrame, this.backdrop, this.width, this.height, this.keyRgb, 0, this.composited);
    this.inner.blit(this.presented);
    this.frame += 1;
  }

  destroy(): void {
    this.inner.destroy();
  }
}
