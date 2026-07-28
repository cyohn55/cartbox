/**
 * Building the renderable model for the map's 3D view.
 *
 * This is the counterpart to {@link voxelGridToModel}: same output shape, same
 * picking contract, but read from the map's sparse {@link MapVoxelSpace} rather
 * than a dense {@link VoxelGrid}. A dense grid is the wrong tool here — a Pro map
 * is 640x360 cells over 64 levels, so allocating the volume would cost tens of
 * megabytes per rebuild, and rebuilds happen on every edit.
 *
 * Two things follow from the map being big:
 *
 * - **The model is windowed.** Only cells within `radius` of the camera's focus
 *   are built, so the cost of a rebuild tracks what is on screen rather than what
 *   the author has ever built. Occlusion still consults the *whole* space, so the
 *   window's edge reads as a clean slice through solid ground instead of a hollow
 *   shell with its inside showing.
 * - **The model is centred on the focus, not on the content.** Panning the focus
 *   is what moves you through the world; the camera then orbits about the point
 *   you are standing at.
 *
 * Plane cells (grass, wires, banners — see {@link MapCellKind}) become a single
 * flat quad standing in the middle of their site, which the renderer draws by
 * collapsing the cell along one axis. A plane's quad is always square, so it is
 * built from cube faces even on a hexel map; {@link VoxelModel.plane} is what
 * tells the renderer to read it that way.
 *
 * Pure and DOM-free.
 */

import { geometryFor, type CellGeometry } from "../render/cellGeometry";
import { CUBE_FACES, type VoxelModel } from "../render/voxelModel";
import type { GridVoxelModel } from "./VoxelGrid";
import {
  COLUMN_MATERIAL_NONE,
  type PaletteLookup,
} from "./MapVoxelLayer";
import { planeAxisOf, type MapCellKind, type MapVoxelSpace } from "./MapVoxelSpace";

/** Albedo for a skinned cell, so the renderer reproduces its tile art faithfully. */
const TEXTURED_ALBEDO: readonly [number, number, number] = [255, 255, 255];

/** The three axes, for deriving per-axis face tables from the cube's own. */
const AXES = [0, 1, 2] as const;

/**
 * The cube faces whose normals run along each axis — the two a plane on that axis
 * draws. Derived from the face table rather than written out, so the bits and the
 * indices a pick returns cannot drift from the geometry they describe.
 */
const AXIS_FACES = AXES.map((axis) =>
  CUBE_FACES.map((face, index) => ({ face, index })).filter(({ face }) => face.normal[axis] !== 0),
);

/** Face bits of the two cube faces whose normals run along an axis. */
const AXIS_FACE_BITS = AXIS_FACES.map((faces) => faces.reduce((mask, { face }) => mask | face.bit, 0));

/** The plane axes a `cross` cell stands its two quads on: one across x, one across z. */
const CROSS_AXES = [0, 2] as const;

/** Where the 3D view is looking, in map-space cell coordinates. */
export interface MapViewFocus {
  /** Map column. */
  readonly x: number;
  /** Height above the ground. */
  readonly y: number;
  /** Map row. */
  readonly z: number;
}

export interface MapSpaceModelOptions {
  /** How the space's palette indices become RGB. */
  readonly palette: PaletteLookup;
  /** The cell the camera orbits about, and the centre of the built window. */
  readonly focus: MapViewFocus;
  /**
   * Half-width of the window, in map cells. Cells further than this from the focus
   * on either horizontal axis are not built — the bound that keeps a rebuild cheap
   * however large the map is.
   */
  readonly radius: number;
  /**
   * Cell geometry for solid cells. Defaults to the space's own shape, which is
   * the only value that can be right — a hexel map built with cube faces would
   * render cells that do not tile.
   */
  readonly geometry?: CellGeometry;
}

/**
 * Build the renderable window of a map space.
 *
 * Solid cells keep only the faces a neighbouring solid does not cover, exactly as
 * {@link voxelGridToModel} does — a plane neighbour never covers anything, since
 * it does not fill its site. `gridIndex` carries each rendered voxel's flat site
 * index, so a pick resolves straight back to the cell that was clicked; a `cross`
 * cell emits two quads that both carry the same index, so clicking either half
 * edits the one cell.
 */
export function mapSpaceToModel(space: MapVoxelSpace, options: MapSpaceModelOptions): GridVoxelModel {
  const geometry = options.geometry ?? geometryFor(space.shape);
  const { focus, palette } = options;
  const radius = Math.max(0, Math.floor(options.radius));

  const minX = Math.max(0, Math.floor(focus.x) - radius);
  const maxX = Math.min(space.width - 1, Math.floor(focus.x) + radius);
  const minZ = Math.max(0, Math.floor(focus.z) - radius);
  const maxZ = Math.min(space.depth - 1, Math.floor(focus.z) + radius);

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const es: number[] = [];
  const nxs: number[] = [];
  const nys: number[] = [];
  const nzs: number[] = [];
  const faceMasks: number[] = [];
  const planes: number[] = [];
  const tiles: number[] = [];
  const siteIndices: number[] = [];

  /** Whether a neighbouring site blocks a face — only a solid cell can. */
  const blocks = (x: number, y: number, z: number): boolean =>
    space.cellAt(x, y, z)?.kind === "solid";

  const push = (
    x: number,
    y: number,
    z: number,
    colour: readonly [number, number, number],
    material: number,
    mask: number,
    normal: readonly [number, number, number],
    planeAxis: number,
  ): void => {
    xs.push(x - focus.x);
    ys.push(y - focus.y);
    zs.push(z - focus.z);
    rs.push(colour[0]);
    gs.push(colour[1]);
    bs.push(colour[2]);
    es.push(0);
    nxs.push(normal[0]);
    nys.push(normal[1]);
    nzs.push(normal[2]);
    faceMasks.push(mask);
    planes.push(planeAxis);
    tiles.push(material);
    siteIndices.push(space.index(x, y, z));
  };

  space.forEachCell((x, y, z, cell) => {
    if (x < minX || x > maxX || z < minZ || z > maxZ) return;

    const textured = cell.material >= 0;
    const colour = textured ? TEXTURED_ALBEDO : palette(cell.colorIndex);
    const material = textured ? cell.material : COLUMN_MATERIAL_NONE;

    if (cell.kind !== "solid") {
      for (const axis of planeAxesOf(cell.kind)) {
        const normal: [number, number, number] = [0, 0, 0];
        normal[axis] = 1;
        push(x, y, z, colour, material, AXIS_FACE_BITS[axis]!, normal, axis);
      }
      return;
    }

    let mask = 0;
    let vnx = 0;
    let vny = 0;
    let vnz = 0;
    for (const face of geometry.faces) {
      const [dx, dy, dz] = face.offset;
      if (blocks(x + dx, y + dy, z + dz)) continue;
      mask |= face.bit;
      vnx += face.normal[0];
      vny += face.normal[1];
      vnz += face.normal[2];
    }
    if (mask === 0) return; // fully enclosed — never visible

    const length = Math.hypot(vnx, vny, vnz) || 1;
    push(x, y, z, colour, material, mask, [vnx / length, vny / length, vnz / length], -1);
  });

  return {
    sizeX: maxX - minX + 1,
    sizeY: space.maxHeight,
    sizeZ: maxZ - minZ + 1,
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    z: Float32Array.from(zs),
    r: Uint8ClampedArray.from(rs),
    g: Uint8ClampedArray.from(gs),
    b: Uint8ClampedArray.from(bs),
    emissive: Float32Array.from(es),
    nx: Float32Array.from(nxs),
    ny: Float32Array.from(nys),
    nz: Float32Array.from(nzs),
    faces: Uint16Array.from(faceMasks),
    geometry,
    tile: Int16Array.from(tiles),
    plane: Int8Array.from(planes),
    // Picking and the cursor highlight both project through these, so the model's
    // origin is stated in the space's own coordinates rather than implied.
    gridIndex: Int32Array.from(siteIndices),
    originX: focus.x,
    originY: focus.y,
    originZ: focus.z,
  };
}

/** The axes a plane kind stands quads on: one for a plane, two for a cross. */
function planeAxesOf(kind: MapCellKind): readonly number[] {
  if (kind === "cross") return CROSS_AXES;
  const axis = planeAxisOf(kind);
  return axis < 0 ? [] : [axis];
}

/**
 * The face indices of the two cube faces a plane on `axis` draws, in
 * {@link CUBE_FACES} order — what a pick on a plane voxel returns. Surfaced so an
 * editor can tell "the near side of this quad" from "the far side" without
 * duplicating the face table's layout.
 */
export function planeFaceIndices(axis: number): readonly number[] {
  return (AXIS_FACES[axis] ?? []).map(({ index }) => index);
}

/**
 * Whether a rendered voxel is one of a plane cell's quads, given the model built
 * by {@link mapSpaceToModel}. A caller needs this to read a pick correctly: a
 * plane's faces are cube faces regardless of the model's own geometry.
 */
export function isPlaneVoxel(model: VoxelModel, voxel: number): boolean {
  return (model.plane?.[voxel] ?? -1) >= 0;
}
