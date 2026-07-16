/**
 * CPU renderer for the backdrop's 3D props: the guaranteed path that runs on
 * every device (the WebGPU path is an optional accelerator with this as its
 * fallback). Each prop is rendered per frame as a rotating voxel model to a
 * small offscreen tile, then composited — with correct alpha and its bob offset
 * — onto the transparent props overlay that sits above the lit wall.
 *
 * Per-prop buffers (output, z-buffer, ImageData, offscreen canvas) are allocated
 * once and reused, so a frame is just re-lighting voxels and a handful of
 * `drawImage` blits.
 */

import { renderVoxelModel, voxelCanvasSize } from "@cartbox/editor";

import { propMotion } from "./bobSpin";
import { BACKDROP_LIGHT, type VoxelProp } from "./retroVoxels";

export interface CompositorOptions {
  /** Overlay resolution — must match the wall buffer for pixel-aligned upscale. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Fixed tip toward the viewer, radians. */
  readonly pitch: number;
}

interface PropTile {
  readonly prop: VoxelProp;
  readonly size: number;
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

    this.tiles = props.map((prop) => {
      const size = voxelCanvasSize(prop.model, prop.cell);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const tileContext = canvas.getContext("2d");
      if (!tileContext) throw new Error("2D context unavailable for a prop tile");
      return {
        prop,
        size,
        out: new Uint8ClampedArray(size * size * 4),
        depth: new Float32Array(size * size),
        image: tileContext.createImageData(size, size),
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
        cell: tile.prop.cell,
        light: BACKDROP_LIGHT,
        out: tile.out,
        depthBuffer: tile.depth,
      });
      tile.image.data.set(tile.out);
      tile.context.putImageData(tile.image, 0, 0);

      const centreX = tile.prop.fx * bufferWidth;
      const centreY = tile.prop.fy * bufferHeight + bobY;
      this.context.drawImage(
        tile.canvas,
        Math.round(centreX - tile.size / 2),
        Math.round(centreY - tile.size / 2),
      );
    }
  }

  destroy(): void {
    this.tiles.length = 0;
  }
}
