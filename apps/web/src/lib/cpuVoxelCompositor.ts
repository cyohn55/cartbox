/**
 * CPU renderer for the backdrop's 3D props: the guaranteed path that runs on
 * every device (the WebGPU path is an optional accelerator with this as its
 * fallback). Each prop is rendered per frame as a rotating voxel model to a
 * small offscreen tile, then composited — with correct alpha and its bob offset
 * — onto the transparent props overlay that sits above the lit wall.
 *
 * The tile is rendered {@link SUPERSAMPLE}× oversized and drawn back down with
 * bilinear smoothing, which anti-aliases the voxels: without it, each voxel's
 * hard integer-pixel splat snaps by a whole pixel at a slightly different yaw, so
 * as a prop spins its columns crawl one at a time and it reads as a swarm of
 * independent voxels rather than one rigid solid. Sub-pixel coverage from the
 * downscale makes the whole surface rotate coherently.
 *
 * Per-prop buffers (output, z-buffer, ImageData, offscreen canvas) are allocated
 * once and reused, so a frame is just re-lighting voxels and a handful of
 * `drawImage` blits.
 */

import { renderVoxelModel, voxelCanvasSize } from "@cartbox/editor";

import { propMotion } from "./bobSpin";
import { BACKDROP_LIGHT, type VoxelProp } from "./retroVoxels";

/**
 * Oversampling factor for the anti-aliased voxel render. Each prop tile is drawn
 * at this multiple of its final size and smoothly downscaled, giving ~N² samples
 * per output pixel. 3 removes the spin crawl cleanly while staying cheap (tiles
 * are small); the cost scales with its square.
 */
const SUPERSAMPLE = 3;

export interface CompositorOptions {
  /** Overlay resolution — must match the wall buffer for pixel-aligned upscale. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Fixed tip toward the viewer, radians. */
  readonly pitch: number;
}

interface PropTile {
  readonly prop: VoxelProp;
  /** Per-voxel pixels in the oversampled tile (prop.cell × SUPERSAMPLE). */
  readonly cellHi: number;
  /** Oversampled tile size in pixels (square). */
  readonly sizeHi: number;
  /** On-buffer footprint after the smooth downscale (sizeHi ÷ SUPERSAMPLE). */
  readonly destSize: number;
  readonly out: Uint8ClampedArray;
  readonly depth: Float32Array;
  readonly image: ImageData;
  readonly canvas: HTMLCanvasElement;
  readonly context: CanvasRenderingContext2D;
}

export class CpuVoxelCompositor {
  private readonly context: CanvasRenderingContext2D;
  private readonly tiles: PropTile[];

  constructor(
    private readonly overlay: HTMLCanvasElement,
    props: readonly VoxelProp[],
    private readonly options: CompositorOptions,
  ) {
    overlay.width = options.bufferWidth;
    overlay.height = options.bufferHeight;
    const context = overlay.getContext("2d");
    if (!context) throw new Error("2D context unavailable for the props overlay");
    this.context = context;
    // Smoothly downscale each oversized tile so voxel edges anti-alias.
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";

    this.tiles = props.map((prop) => {
      const cellHi = prop.cell * SUPERSAMPLE;
      const sizeHi = voxelCanvasSize(prop.model, cellHi);
      const canvas = document.createElement("canvas");
      canvas.width = sizeHi;
      canvas.height = sizeHi;
      const tileContext = canvas.getContext("2d");
      if (!tileContext) throw new Error("2D context unavailable for a prop tile");
      return {
        prop,
        cellHi,
        sizeHi,
        destSize: sizeHi / SUPERSAMPLE,
        out: new Uint8ClampedArray(sizeHi * sizeHi * 4),
        depth: new Float32Array(sizeHi * sizeHi),
        image: tileContext.createImageData(sizeHi, sizeHi),
        canvas,
        context: tileContext,
      };
    });
  }

  /** Draw every prop for the given time onto the (cleared) overlay. */
  render(seconds: number): void {
    const { bufferWidth, bufferHeight, pitch } = this.options;
    this.context.clearRect(0, 0, bufferWidth, bufferHeight);

    for (const tile of this.tiles) {
      const { yaw, bobY } = propMotion(seconds, tile.prop.motion);
      renderVoxelModel(tile.prop.model, {
        yaw,
        pitch,
        cell: tile.cellHi,
        light: BACKDROP_LIGHT,
        out: tile.out,
        depthBuffer: tile.depth,
      });
      tile.image.data.set(tile.out);
      tile.context.putImageData(tile.image, 0, 0);

      // Smoothly downscale the oversized tile into its on-buffer footprint,
      // centred on the prop's anchor and offset by its bob.
      const centreX = tile.prop.fx * bufferWidth;
      const centreY = tile.prop.fy * bufferHeight + bobY;
      this.context.drawImage(
        tile.canvas,
        0,
        0,
        tile.sizeHi,
        tile.sizeHi,
        centreX - tile.destSize / 2,
        centreY - tile.destSize / 2,
        tile.destSize,
        tile.destSize,
      );
    }
  }

  destroy(): void {
    this.tiles.length = 0;
  }
}
