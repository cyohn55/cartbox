/**
 * Renders the Minecraft-style island as a slowly rotating world behind the
 * onboarding UI: a bird's-eye camera turns steadily around the island while a
 * fixed sun rakes across it, so its grass, cliffs and trees drift past like the
 * panorama on a game's title screen.
 *
 * The island is a static {@link VoxelModel} (voxelWorld.ts). Each frame it is
 * drawn once at the current yaw into a square tile that is then blitted 1:1 onto
 * the backdrop canvas over a sky gradient. Everything is rendered at the canvas's
 * actual display resolution and composited without smoothing, so the cube faces
 * keep hard, crisp edges — the blocky Minecraft look — instead of the soft, shimmery
 * edges that a low-resolution buffer upscaled to the screen would produce. Buffers
 * are allocated once and reused, so a frame is just re-projecting the visible shell
 * and one straight blit.
 */

import { renderScene, type ModelLight, type PlacedModel, type VoxelModel } from "@cartbox/editor";

import {
  HANDHELD_ANCHOR,
  SCENE_PITCH,
  WORLD_ANCHOR,
  WORLD_ROTATION_PERIOD_SECONDS,
  publishSceneLayout,
  viewDepth,
} from "./scene3d";

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

/** Where the island's rotation axis sits vertically, as a fraction of the canvas
 *  height — low enough that the island's top surface sits just *below* the
 *  handhelds' feet, so they float centred a little above the world rather than
 *  standing in front of (and occluding) it. This is screen framing for the terrain
 *  art; the shared camera (scene3d.ts) still projects the world origin to the
 *  viewport centre, which is where the handhelds' `[0,0,0]` anchor lands. */
const WORLD_CENTER_Y = 0.8;
/** The camera-depth plane the handhelds occupy: the depth of {@link HANDHELD_ANCHOR}
 *  under the shared camera. Voxels nearer than this are drawn over the handhelds,
 *  so trees on the near side of the island pass in front of them and they sit
 *  *amongst* the world rather than in front of all of it. Moving the handheld
 *  anchor's z moves this occlusion plane with it. */
const HANDHELD_DEPTH = viewDepth(HANDHELD_ANCHOR);
/** The island tile's size relative to the canvas height. Large enough that no
 *  corner clips as it spins, and that the surface reads as a broad ground.
 *  6× the original 1.34 to render the world at 6× scale. */
const WORLD_SCALE = 8.04;

export interface WorldRenderOptions {
  /** Backdrop resolution in device pixels — the canvas's true render size. */
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
  /** The layer drawn *over* the handhelds: only the voxels nearer than the
   *  handhelds' plane, so trees on the near side pass in front of them. */
  private readonly frontContext: CanvasRenderingContext2D;
  private readonly tileCanvas: HTMLCanvasElement;
  private readonly tileContext: CanvasRenderingContext2D;
  private readonly tileImage: ImageData;
  private readonly out: Uint8ClampedArray;
  private readonly depth: Float32Array;
  /** Square tile side, in device pixels — equal to {@link destSize} (blitted 1:1). */
  private readonly tileSize: number;
  /** Output pixels per voxel inside the tile. */
  private readonly cell: number;
  /** On-canvas square the island is drawn into, and where it sits. */
  private readonly destSize: number;
  private readonly destX: number;
  private readonly destY: number;
  /** The placed island, reused each frame (only its yaw changes). */
  private readonly placed: PlacedModel;
  /** Current sky gradient (mutable so a chassis-colour change retints in place). */
  private skyTop: string;
  private skyHorizon: string;

  constructor(
    canvas: HTMLCanvasElement,
    frontCanvas: HTMLCanvasElement,
    private readonly model: VoxelModel,
    private readonly options: WorldRenderOptions,
  ) {
    canvas.width = options.bufferWidth;
    canvas.height = options.bufferHeight;
    frontCanvas.width = options.bufferWidth;
    frontCanvas.height = options.bufferHeight;
    const context = canvas.getContext("2d");
    const frontContext = frontCanvas.getContext("2d");
    if (!context || !frontContext) throw new Error("2D context unavailable for the world backdrop");
    this.context = context;
    this.frontContext = frontContext;
    // No smoothing anywhere: the tile is blitted 1:1, so a nearest copy keeps the
    // cube faces hard-edged rather than softening them into a blur.
    this.context.imageSmoothingEnabled = false;
    this.frontContext.imageSmoothingEnabled = false;
    this.skyTop = options.skyTop;
    this.skyHorizon = options.skyHorizon;

    // Size the island to fill most of the backdrop's height. The tile holds the
    // model at any yaw (sized by the bounding diagonal so no corner clips as it
    // spins) and, rendered at the canvas's true resolution, is drawn 1:1 — there
    // is no down- or up-scale to blur or alias the edges.
    this.destSize = Math.round(options.bufferHeight * WORLD_SCALE);
    this.destX = Math.round((options.bufferWidth - this.destSize) / 2);
    // Sit the island low so its surface rises to just under the handhelds' feet:
    // they stand on the world and float only slightly above it, and it turns
    // beneath them.
    this.destY = Math.round(options.bufferHeight * WORLD_CENTER_Y - this.destSize * 0.5);

    this.tileSize = this.destSize;
    this.cell = Math.max(1, this.tileSize / (modelDiagonal(model) + 2));

    // The island sits at its shared-scene anchor; the world is the orbiting layer,
    // so keeping the anchor at the origin spins it in place about the view centre.
    this.placed = { model, position: WORLD_ANCHOR };

    // Publish the camera zoom so the DOM billboards (handhelds, tagline) project
    // through this exact camera. `cell` is device pixels per world unit; scaling by
    // the buffer→CSS ratio gives CSS pixels per unit, the shared on-screen zoom.
    const deviceToCss = window.innerHeight / options.bufferHeight;
    publishSceneLayout({
      pixelsPerUnit: this.cell * deviceToCss,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });

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

    const yaw = (seconds / WORLD_ROTATION_PERIOD_SECONDS) * Math.PI * 2;
    // Rendered through the shared scene camera (scene3d.ts) so the island, the
    // handhelds and the tagline all sort against one depth axis.
    renderScene([this.placed], {
      yaw,
      pitch: SCENE_PITCH,
      cell: this.cell,
      size: this.tileSize,
      origin: [0, 0, 0],
      light: WORLD_LIGHT,
      out: this.out,
      depthBuffer: this.depth,
    });
    this.tileImage.data.set(this.out);
    this.tileContext.putImageData(this.tileImage, 0, 0);

    // Back layer (below the handhelds): the whole island, 1:1 over the sky (its
    // transparent corners let the sky show through). Source and destination sizes
    // are equal, so this is an exact copy with no resampling.
    this.context.drawImage(
      this.tileCanvas, 0, 0, this.tileSize, this.tileSize, this.destX, this.destY, this.destSize, this.destSize,
    );

    // Front layer (above the handhelds): keep only the voxels nearer than the
    // handhelds' plane by zeroing the alpha of everything at or behind it, then
    // blit what remains over the (otherwise transparent) foreground canvas — so
    // near-side trees pass in front of the handhelds and they sit amongst them.
    const data = this.tileImage.data;
    for (let i = 0; i < this.depth.length; i += 1) {
      if (this.depth[i]! <= HANDHELD_DEPTH) data[i * 4 + 3] = 0;
    }
    this.tileContext.putImageData(this.tileImage, 0, 0);
    this.frontContext.clearRect(0, 0, bufferWidth, bufferHeight);
    this.frontContext.drawImage(
      this.tileCanvas, 0, 0, this.tileSize, this.tileSize, this.destX, this.destY, this.destSize, this.destSize,
    );
  }

  destroy(): void {
    this.tileCanvas.width = 0;
    this.tileCanvas.height = 0;
  }
}
