/**
 * What the FX tab runs its shader stack over.
 *
 * The post-processing stack is authored against a *picture*, and until now the
 * only picture the tab could compose was one screen of the tile map — flat 2D
 * art, stamped from the sprite sheet. That is not what most carts look like any
 * more: a map is a {@link MapVoxelSpace} of voxels, hexels and sprite-skinned
 * planes, and judging a bloom threshold or a fog density against flat tiles says
 * nothing about how it will read over a lit 3D scene.
 *
 * So the frame the stack runs over is a choice, and this module is the whole of
 * that choice: three ways to fill one buffer of cart-resolution RGBA, behind one
 * dispatch. Each reuses the renderer the map editor already draws that view
 * with, so the FX preview shows the same picture the Map tab does — the shader
 * chain is the only thing added.
 *
 * Everything here is pure: buffers in, buffers out, no canvas and no React. The
 * component owns the camera and the settings; this owns only how a frame is made.
 */

import {
  DEFAULT_MODEL_LIGHT,
  geometryFor,
  mapSpaceToModel,
  renderMapFirstPerson,
  renderVoxelModel,
  type MapViewFocus,
  type MapVoxelSpace,
  type PaletteLookup,
  type SpriteSheet,
  type TextureAtlas,
  type TileMap,
} from "@cartbox/editor";

import { WALK_FOV, type WalkCamera } from "./walkCamera";

/** The sprite page the map stamps from; the map can only reference page 0. */
const MAP_PAGE = 0;

/**
 * Night-sky colour behind everything, in 0..255 — the ray marcher's own default,
 * repeated here because the orbit view has to composite against the same thing
 * to look like the same world.
 */
export const FX_SKY: readonly [number, number, number] = [16, 20, 34];

/** How far a ray travels before giving up, in cells. */
const VIEW_DISTANCE = 72;

/** Which picture the effect chain is previewed over. */
export const FX_SOURCE_IDS = ["screen", "orbit", "walk"] as const;
export type FxSourceId = (typeof FX_SOURCE_IDS)[number];

export interface FxSourceOption {
  readonly id: FxSourceId;
  readonly label: string;
  /** What this framing is good for judging — shown under the picker. */
  readonly hint: string;
}

/**
 * The framings, in the order they narrow: the flat art, the build seen from
 * outside, then the build seen from where a player stands.
 */
export const FX_SOURCES: readonly FxSourceOption[] = [
  {
    id: "screen",
    label: "Screen",
    hint: "One screen of the tile map, as flat 2D art.",
  },
  {
    id: "orbit",
    label: "Orbit",
    hint: "The 3D map from outside — drag to turn it, wheel to zoom.",
  },
  {
    id: "walk",
    label: "Walk",
    hint: "The 3D map from inside, at eye height. The framing a player sees.",
  },
];

/** Which screen of the tile map the flat source composes. */
export interface FxScreen {
  readonly column: number;
  readonly row: number;
}

/**
 * Half-width of the window the orbit view builds, in cells, and how far it may
 * be widened. The cost of a rebuild tracks the window, and the window is rebuilt
 * on every camera move, so the ceiling is a budget rather than a preference.
 */
export const DEFAULT_ORBIT_RADIUS = 16;
export const ORBIT_RADIUS_MIN = 4;
export const ORBIT_RADIUS_MAX = 48;

/** Zoom limits for the orbit view, as output pixels per cell. */
export const ORBIT_CELL_MIN = 1;
export const ORBIT_CELL_MAX = 32;

/** Pitch is clamped short of straight down so the horizon never inverts. */
export const ORBIT_PITCH_MIN = -0.25;
export const ORBIT_PITCH_MAX = 1.35;

export function clampOrbitCell(cell: number): number {
  return Math.max(ORBIT_CELL_MIN, Math.min(ORBIT_CELL_MAX, Math.round(cell)));
}

export function clampOrbitPitch(pitch: number): number {
  return Math.max(ORBIT_PITCH_MIN, Math.min(ORBIT_PITCH_MAX, pitch));
}

/** The camera the orbit source looks through. */
export interface FxOrbitCamera {
  /** The cell the camera circles, and the centre of the window that is built. */
  readonly focus: MapViewFocus;
  readonly yaw: number;
  readonly pitch: number;
  /** Zoom, as output pixels per cell. */
  readonly cell: number;
  /** Half-width of the built window, in cells. */
  readonly radius: number;
}

/** The map and the art it is skinned with — everything both 3D sources need. */
export interface FxSpaceView {
  readonly space: MapVoxelSpace;
  /** World materials plus every tiles-page sprite; see `lib/mapAtlas`. */
  readonly atlas: TextureAtlas;
  /** How the space's palette indices become RGB. */
  readonly palette: PaletteLookup;
}

/** One frame's worth of work, fully described. */
export type FxFrameRequest =
  | { readonly source: "screen"; readonly sheet: SpriteSheet; readonly map: TileMap; readonly screen: FxScreen }
  | { readonly source: "orbit"; readonly view: FxSpaceView; readonly camera: FxOrbitCamera }
  | { readonly source: "walk"; readonly view: FxSpaceView; readonly camera: WalkCamera };

/**
 * Scratch space for composing frames, allocated once per preview size.
 *
 * The orbit view is the reason this is not just one buffer: the shared voxel
 * rasteriser only renders squares, so that path draws into a square as wide as
 * the frame's longer edge and the middle of it is cropped out. Reallocating a
 * quarter-megabyte on every slider drag would be the most expensive thing the
 * tab does, so the caller holds these and passes them back in.
 */
export interface FxFrameBuffers {
  readonly width: number;
  readonly height: number;
  /** The composed frame, `width * height * 4` bytes of opaque RGBA. */
  readonly frame: Uint8ClampedArray;
  /** Edge of the square the orbit rasteriser draws into. */
  readonly squareSize: number;
  readonly square: Uint8ClampedArray;
  readonly depth: Float32Array;
}

export function createFxFrameBuffers(width: number, height: number): FxFrameBuffers {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));
  const squareSize = Math.max(safeWidth, safeHeight);
  return {
    width: safeWidth,
    height: safeHeight,
    frame: new Uint8ClampedArray(safeWidth * safeHeight * 4),
    squareSize,
    square: new Uint8ClampedArray(squareSize * squareSize * 4),
    depth: new Float32Array(squareSize * squareSize),
  };
}

/**
 * Compose the frame a request describes, into the caller's buffers.
 *
 * Returns `buffers.frame` rather than a fresh array: the frame is handed
 * straight to the shader pass as a texture source and is never retained, so one
 * buffer reused across every render is both correct and the point.
 */
export function renderFxFrame(request: FxFrameRequest, buffers: FxFrameBuffers): Uint8ClampedArray {
  switch (request.source) {
    case "screen":
      return composeMapScreen(request.sheet, request.map, request.screen, buffers);
    case "orbit":
      return composeOrbit(request.view, request.camera, buffers);
    case "walk":
      return composeWalk(request.view, request.camera, buffers);
  }
}

/**
 * Rasterise one screen of the tile map — `screenWidth × screenHeight` tiles
 * stamped from the sheet, which is exactly the region the map editor draws its
 * screen guides around.
 *
 * Writes are clipped to the buffer rather than assumed to fit: the buffer is
 * sized from the cart's screen and the map's is the same size today, but a
 * mismatch should letterbox, not corrupt neighbouring rows.
 */
function composeMapScreen(
  sheet: SpriteSheet,
  map: TileMap,
  screen: FxScreen,
  buffers: FxFrameBuffers,
): Uint8ClampedArray {
  const { width, height, frame } = buffers;
  const edge = sheet.tileSize;
  frame.fill(0);
  for (let cellY = 0; cellY < map.screenHeight; cellY += 1) {
    const top = cellY * edge;
    if (top >= height) break;
    for (let cellX = 0; cellX < map.screenWidth; cellX += 1) {
      const left = cellX * edge;
      const span = Math.min(edge, width - left);
      if (span <= 0) break;
      const tile = map.getCell(screen.column * map.screenWidth + cellX, screen.row * map.screenHeight + cellY);
      const rgba = sheet.renderTileRgba(MAP_PAGE, tile);
      for (let y = 0; y < edge && top + y < height; y += 1) {
        const sourceRow = y * edge * 4;
        frame.set(rgba.subarray(sourceRow, sourceRow + span * 4), ((top + y) * width + left) * 4);
      }
    }
  }
  // The tile stamps are opaque, but a map screen larger than the frame leaves the
  // clipped margin at alpha 0, which the shader chain would read as black rather
  // than as nothing. Sky is the honest colour for "no world here".
  return opaqueOverSky(frame, width * height);
}

/** The 3D map seen from outside, on the shared software voxel rasteriser. */
function composeOrbit(
  view: FxSpaceView,
  camera: FxOrbitCamera,
  buffers: FxFrameBuffers,
): Uint8ClampedArray {
  const model = mapSpaceToModel(view.space, {
    palette: view.palette,
    focus: camera.focus,
    radius: camera.radius,
    geometry: geometryFor(view.space.shape),
  });
  renderVoxelModel(model, {
    yaw: camera.yaw,
    pitch: camera.pitch,
    cell: camera.cell,
    size: buffers.squareSize,
    light: DEFAULT_MODEL_LIGHT,
    atlas: view.atlas,
    out: buffers.square,
    depthBuffer: buffers.depth,
  });
  return cropSquareOntoSky(buffers);
}

/** The 3D map seen from inside, on the shared ray marcher. */
function composeWalk(
  view: FxSpaceView,
  camera: WalkCamera,
  buffers: FxFrameBuffers,
): Uint8ClampedArray {
  renderMapFirstPerson(view.space, {
    camera: { eye: [camera.x, camera.y, camera.z], yaw: camera.yaw, pitch: camera.pitch, fov: WALK_FOV },
    palette: view.palette,
    atlas: view.atlas,
    light: DEFAULT_MODEL_LIGHT,
    width: buffers.width,
    height: buffers.height,
    maxDistance: VIEW_DISTANCE,
    sky: FX_SKY,
    out: buffers.frame,
  });
  return buffers.frame;
}

/**
 * Crop the centre of the square render into the frame, over the sky.
 *
 * The rasteriser leaves alpha 0 wherever nothing was drawn so a model can be
 * composited; the shader chain wants a finished picture, so this is where the
 * background stops being "transparent" and becomes a colour. Cropping from the
 * centre is what makes the frame a letterboxed window on the same view — the
 * rasteriser draws the model about the square's centre.
 */
function cropSquareOntoSky(buffers: FxFrameBuffers): Uint8ClampedArray {
  const { width, height, frame, square, squareSize } = buffers;
  const offsetX = (squareSize - width) >> 1;
  const offsetY = (squareSize - height) >> 1;
  const [skyRed, skyGreen, skyBlue] = FX_SKY;
  for (let y = 0; y < height; y += 1) {
    let source = ((y + offsetY) * squareSize + offsetX) * 4;
    let target = y * width * 4;
    for (let x = 0; x < width; x += 1, source += 4, target += 4) {
      const alpha = square[source + 3]! / 255;
      frame[target] = skyRed + (square[source]! - skyRed) * alpha;
      frame[target + 1] = skyGreen + (square[source + 1]! - skyGreen) * alpha;
      frame[target + 2] = skyBlue + (square[source + 2]! - skyBlue) * alpha;
      frame[target + 3] = 255;
    }
  }
  return frame;
}

/** Replace every transparent pixel with the sky and make the frame opaque. */
function opaqueOverSky(frame: Uint8ClampedArray, pixels: number): Uint8ClampedArray {
  const [skyRed, skyGreen, skyBlue] = FX_SKY;
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = pixel * 4;
    if (frame[at + 3] !== 255) {
      frame[at] = skyRed;
      frame[at + 1] = skyGreen;
      frame[at + 2] = skyBlue;
      frame[at + 3] = 255;
    }
  }
  return frame;
}

/**
 * Where the orbit camera should open on a map: circling the middle of everything
 * built, at a zoom that fits that build in the frame.
 *
 * An empty map has no content to centre on, so it falls back to the middle of
 * the map's footprint — the view is empty sky either way, and the camera should
 * at least be somewhere sensible for the first cell placed.
 */
export function orbitCameraOnContent(space: MapVoxelSpace, frameWidth: number): FxOrbitCamera {
  const centre = space.contentCentre();
  const focus: MapViewFocus = centre ?? {
    x: Math.floor(space.width / 2),
    y: 0,
    z: Math.floor(space.depth / 2),
  };
  const radius = DEFAULT_ORBIT_RADIUS;
  return {
    focus,
    yaw: 0.6,
    pitch: 0.5,
    // Fit the built window across the frame's width, within the zoom's own range.
    cell: clampOrbitCell(Math.round(frameWidth / (radius * 2 + 1))),
    radius,
  };
}
