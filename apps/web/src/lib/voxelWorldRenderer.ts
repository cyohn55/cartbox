/**
 * Renders the Minecraft-style island as a slowly rotating world behind the
 * onboarding UI: a bird's-eye camera turns steadily around the island while a
 * fixed sun rakes across it, so its grass, cliffs and trees drift past like the
 * panorama on a game's title screen.
 *
 * The island is a static {@link VoxelModel} (voxelWorld.ts). Each frame it is
 * drawn once at the current yaw into an oversampled square tile, then that tile is
 * smoothly scaled down onto the wide backdrop canvas over a sky gradient — the
 * downscale anti-aliases the cube edges so the slow rotation stays crisp instead
 * of crawling pixel by pixel. Buffers are allocated once and reused, so a frame is
 * just re-projecting the visible shell and one composite blit.
 */

import { renderVoxelModel, type ModelLight, type VoxelModel } from "@cartbox/editor";

/** Oversampling for the anti-aliased island tile (≈N² samples per output pixel). */
const SUPERSAMPLE = 2;

/**
 * The fixed sun: a warm key light from the upper-front with a high ambient floor,
 * so the island reads as a bright, fully-lit day scene while the strong key still
 * models every cliff and cube. As the world turns, faces rotate into and out of
 * this world-fixed light, which is what gives the rotation its life.
 */
const WORLD_LIGHT: ModelLight = {
  direction: normalize([0.5, 0.72, 0.48]),
  color: [1, 0.98, 0.9],
  intensity: 1.05,
  ambient: 0.5,
};

/** A full turn of the island takes this many seconds — a calm, unhurried drift. */
const ROTATION_PERIOD_SECONDS = 80;
/** Bird's-eye tip toward the viewer (radians): shows the tops and two cliff sides. */
const CAMERA_PITCH = 0.62;

export interface WorldRenderOptions {
  /** Backdrop resolution — the wide, low-res buffer CSS upscales. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Initial sky gradient endpoints (top of sky → horizon), each `#rrggbb`. */
  readonly skyTop: string;
  readonly skyHorizon: string;
}

function normalize(v: readonly [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** The longest straight span across the model's bounding box, in voxels. */
function modelDiagonal(model: VoxelModel): number {
  return Math.hypot(model.sizeX, model.sizeY, model.sizeZ);
}

export class VoxelWorldRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly tileCanvas: HTMLCanvasElement;
  private readonly tileContext: CanvasRenderingContext2D;
  private readonly tileImage: ImageData;
  private readonly out: Uint8ClampedArray;
  private readonly depth: Float32Array;
  /** Oversampled square tile side, in pixels. */
  private readonly tileSize: number;
  /** Output pixels per voxel inside the tile. */
  private readonly cell: number;
  /** On-canvas square the island is drawn into, and where it sits. */
  private readonly destSize: number;
  private readonly destX: number;
  private readonly destY: number;
  /** Current sky gradient (mutable so a chassis-colour change retints in place). */
  private skyTop: string;
  private skyHorizon: string;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly model: VoxelModel,
    private readonly options: WorldRenderOptions,
  ) {
    canvas.width = options.bufferWidth;
    canvas.height = options.bufferHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("2D context unavailable for the world backdrop");
    this.context = context;
    this.context.imageSmoothingEnabled = true;
    this.context.imageSmoothingQuality = "high";
    this.skyTop = options.skyTop;
    this.skyHorizon = options.skyHorizon;

    // Size the island to fill most of the backdrop's height, then oversample the
    // tile it renders into. The tile holds the model at any yaw (sized by the
    // bounding diagonal so no corner clips as it spins).
    this.destSize = Math.round(options.bufferHeight * 1.34);
    this.destX = Math.round((options.bufferWidth - this.destSize) / 2);
    // Nudged down so the island sits a touch below centre, leaving the calmer sky
    // above for the picker's heading.
    this.destY = Math.round(options.bufferHeight * 0.5 - this.destSize * 0.46);

    this.tileSize = this.destSize * SUPERSAMPLE;
    this.cell = Math.max(1, this.tileSize / (modelDiagonal(model) + 2));

    this.tileCanvas = document.createElement("canvas");
    this.tileCanvas.width = this.tileSize;
    this.tileCanvas.height = this.tileSize;
    const tileContext = this.tileCanvas.getContext("2d");
    if (!tileContext) throw new Error("2D context unavailable for the world tile");
    this.tileContext = tileContext;
    this.tileImage = tileContext.createImageData(this.tileSize, this.tileSize);
    this.out = new Uint8ClampedArray(this.tileSize * this.tileSize * 4);
    this.depth = new Float32Array(this.tileSize * this.tileSize);
  }

  /** Retint the sky (e.g. when the selected chassis colour changes). */
  setSky(top: string, horizon: string): void {
    this.skyTop = top;
    this.skyHorizon = horizon;
  }

  /** Paint the sky and the island at the given time onto the backdrop canvas. */
  render(seconds: number): void {
    const { bufferWidth, bufferHeight } = this.options;

    const sky = this.context.createLinearGradient(0, 0, 0, bufferHeight);
    sky.addColorStop(0, this.skyTop);
    sky.addColorStop(1, this.skyHorizon);
    this.context.fillStyle = sky;
    this.context.fillRect(0, 0, bufferWidth, bufferHeight);

    const yaw = (seconds / ROTATION_PERIOD_SECONDS) * Math.PI * 2;
    renderVoxelModel(this.model, {
      yaw,
      pitch: CAMERA_PITCH,
      cell: this.cell,
      size: this.tileSize,
      light: WORLD_LIGHT,
      out: this.out,
      depthBuffer: this.depth,
    });
    this.tileImage.data.set(this.out);
    this.tileContext.putImageData(this.tileImage, 0, 0);

    // Smoothly downscale the oversized island tile onto the sky (its transparent
    // corners let the sky show through around the island).
    this.context.drawImage(
      this.tileCanvas,
      0,
      0,
      this.tileSize,
      this.tileSize,
      this.destX,
      this.destY,
      this.destSize,
      this.destSize,
    );
  }

  destroy(): void {
    this.tileCanvas.width = 0;
    this.tileCanvas.height = 0;
  }
}
