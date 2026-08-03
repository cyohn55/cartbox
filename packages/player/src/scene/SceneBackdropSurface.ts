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
import { composeParallax, prehazeLayers, type ParallaxCamera, type ParallaxLayer, type Rgb } from "./parallaxScene.js";
import { cameraAt, fillSky } from "./sceneRender.js";
import type { SceneSpec } from "./sceneModel.js";

/**
 * Per-frame animation overrides for one layer, addressed by its index in the
 * declared scene. Offsets ADD to the layer's authored placement (sway around a
 * base); opacity/emissive are absolute. Deliberately structural — the scene does
 * not depend on the anim module — and deliberately pixel-free, so the pre-hazed
 * layer cache stays valid (sprite-frame swaps, which would invalidate it, are the
 * foreground surface's job, not a scene layer's).
 */
export interface SceneLayerOverride {
  opacity?: number;
  offsetX?: number;
  offsetY?: number;
  emissive?: number;
}

export class SceneBackdropSurface implements DisplaySurface {
  private frame = 0;
  /** The cart-published camera base, added to the scene's auto-scroll each frame. */
  private cameraBase: ParallaxCamera = { x: 0, y: 0 };
  /** Per-layer animation overrides for this frame, keyed by layer index (or null). */
  private layerOverrides: Record<number, SceneLayerOverride> | null = null;
  /** Layers with aerial haze baked in once (see prehazeLayers) — the per-frame win. */
  private readonly hazedLayers: readonly ParallaxLayer[];
  /** The sky gradient, computed once (it depends only on the constant atmosphere). */
  private readonly sky: Uint8ClampedArray;
  private readonly backdrop: Uint8ClampedArray;
  private readonly composited: Uint8ClampedArray;
  // blit receives a Uint8Array; the composite output is presented as one too.
  private readonly presented: Uint8Array;

  constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    layers: readonly ParallaxLayer[],
    private readonly spec: SceneSpec,
    private readonly keyRgb: Rgb,
  ) {
    const size = width * height * 4;
    // A layer's haze and the sky are frame-invariant, so bake both once here
    // rather than per frame: the per-frame loop is then just the parallax blit.
    this.hazedLayers = prehazeLayers(layers, spec.atmosphere);
    this.sky = new Uint8ClampedArray(size);
    fillSky(this.sky, width, height, spec.atmosphere);
    this.backdrop = new Uint8ClampedArray(size);
    this.composited = new Uint8ClampedArray(size);
    this.presented = new Uint8Array(this.composited.buffer);
  }

  /**
   * Set the backdrop camera the cart published this frame (via `cartbox.camera`).
   * Added to the scene's own auto-scroll, so an auto-scroll-only cart that never
   * sets it keeps panning as before with the default (0, 0).
   */
  setCameraBase(base: ParallaxCamera): void {
    this.cameraBase = base;
  }

  /**
   * Set this frame's per-layer animation overrides (or null for none). Applied on
   * top of the pre-hazed layers without touching their baked pixels, so the
   * frame-invariant haze cache is preserved.
   */
  setLayerOverrides(overrides: Record<number, SceneLayerOverride> | null): void {
    this.layerOverrides = overrides;
  }

  /** The layers to composite this frame: the cached ones, plus any overrides. */
  private frameLayers(): readonly ParallaxLayer[] {
    const overrides = this.layerOverrides;
    if (!overrides) return this.hazedLayers;
    return this.hazedLayers.map((layer, index) => {
      const override = overrides[index];
      if (!override) return layer;
      return {
        ...layer,
        offsetX: (layer.offsetX ?? 0) + (override.offsetX ?? 0),
        offsetY: (layer.offsetY ?? 0) + (override.offsetY ?? 0),
        opacity: override.opacity ?? layer.opacity,
        emissive: override.emissive ?? layer.emissive,
      };
    });
  }

  blit(rgba: Uint8Array): void {
    // A cart frame is Uint8Array; the scene passes work in Uint8ClampedArray.
    // They share byte semantics, so wrap without copying.
    const cartFrame = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    // Start from the cached sky, then composite the pre-hazed layers at this
    // frame's camera (scene auto-scroll + the cart's published base).
    this.backdrop.set(this.sky);
    composeParallax(
      this.backdrop,
      this.width,
      this.height,
      this.frameLayers(),
      cameraAt(this.spec, this.frame, this.cameraBase),
      this.spec.atmosphere,
    );
    compositeOverBackdrop(cartFrame, this.backdrop, this.width, this.height, this.keyRgb, 0, this.composited);
    this.inner.blit(this.presented);
    this.frame += 1;
  }

  destroy(): void {
    this.inner.destroy();
  }
}
