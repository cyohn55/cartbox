/**
 * The geometry of a single grid cell, abstracted so the voxel pipeline can build
 * and render either **cubes** or **hexels** (rhombic-dodecahedron cells on a
 * face-centred-cubic lattice — the true 3D analogue of a hexagon) from the same
 * {@link VoxelGrid} storage, model builder, and renderer.
 *
 * A cube tiles the integer lattice with six axis-aligned square faces. A hexel
 * tiles the FCC lattice — the integer sites whose coordinates sum to an even
 * number — with twelve rhombic faces, one per nearest neighbour. Because both
 * lattices are subsets of the same integer grid, the only things that change
 * between them are (1) which sites are valid, (2) each cell's face table (the
 * neighbour to test for occupancy, the outward normal to shade by, and the
 * polygon to draw), and (3) the neighbour set used for connectivity. Capturing
 * all of that in one {@link CellGeometry} value lets {@link voxelGridToModel} and
 * {@link renderVoxelModel} stay cell-shape-agnostic.
 *
 * Pure and DOM-free: the same geometry drives the editor, the renderers, and the
 * unit tests, which assert on its derived structure rather than on literals.
 */

import { CUBE_FACES } from "./voxelModel";

/** The two authored cell shapes. */
export type CellShape = "cube" | "hexel";

/** A single face of a cell. */
export interface CellFace {
  /**
   * Integer offset to the neighbour that shares this face. Testing that cell for
   * occupancy decides whether the face is exposed, and — for the Add tool — where
   * a new cell placed against this face lands.
   */
  readonly offset: readonly [number, number, number];
  /** Unit outward normal, used for shading and back-face culling. */
  readonly normal: readonly [number, number, number];
  /**
   * The face polygon's corners in cell-local space (cell centre at the origin),
   * as a parallelogram wound in order so `corner[2] === corner[1] + corner[3] -
   * corner[0]` — the form the renderer's affine quad fill expects.
   */
  readonly corners: ReadonlyArray<readonly [number, number, number]>;
  /** This face's bit within a cell's exposed-face mask (`1 << index`). */
  readonly bit: number;
}

/** Everything the pipeline needs to build and draw one cell shape. */
export interface CellGeometry {
  readonly shape: CellShape;
  /** The cell's faces, indexed 0..n-1 (the index a pick returns). */
  readonly faces: readonly CellFace[];
  /**
   * Whether only sites with an even coordinate sum are valid. Cubes fill every
   * integer site (`false`); hexels fill the FCC lattice (`true`), so every edit
   * must keep `(x + y + z)` even for the rhombic cells to tile without overlap.
   */
  readonly evenParity: boolean;
  /**
   * Integer neighbour offsets for connectivity (the flood used by the Wand and
   * Paint Bucket). Identical to the faces' offsets, surfaced separately so the
   * flood need not know about faces.
   */
  readonly neighbors: readonly (readonly [number, number, number])[];
}

function unit(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

/**
 * Cube geometry: the six axis-aligned faces of the unit cube, derived from the
 * shared {@link CUBE_FACES} so the two never drift. A cube's neighbour offset
 * equals its face normal, and every integer site is valid.
 */
export const CUBE_GEOMETRY: CellGeometry = {
  shape: "cube",
  faces: CUBE_FACES.map((face) => ({
    offset: face.normal,
    normal: face.normal,
    corners: face.corners,
    bit: face.bit,
  })),
  evenParity: false,
  neighbors: CUBE_FACES.map((face) => face.normal),
};

/**
 * The twelve nearest-neighbour directions on the FCC lattice: every permutation
 * of `(±1, ±1, 0)`. Each is the offset to a hexel that shares one rhombic face,
 * and — since two coordinates change by ±1 — each preserves the even coordinate
 * sum, so the lattice stays closed under them.
 */
function hexelDirections(): [number, number, number][] {
  const directions: [number, number, number][] = [];
  // The axis left at zero, and the two axes carrying ±1.
  for (let zeroAxis = 0; zeroAxis < 3; zeroAxis += 1) {
    const axisA = (zeroAxis + 1) % 3;
    const axisB = (zeroAxis + 2) % 3;
    for (const signA of [-1, 1]) {
      for (const signB of [-1, 1]) {
        const direction: [number, number, number] = [0, 0, 0];
        direction[axisA] = signA;
        direction[axisB] = signB;
        directions.push(direction);
      }
    }
  }
  return directions;
}

/**
 * The rhombic face shared with the neighbour at `direction`. A rhombic
 * dodecahedron centred on the origin has two kinds of vertex: six "octahedral"
 * vertices at `(±1, 0, 0)` and permutations, and eight "cube" vertices at
 * `(±½, ±½, ±½)`. The face toward a neighbour whose direction has one zero
 * component is the rhombus joining the two octahedral vertices on that
 * direction's non-zero axes with the two cube vertices that sit at `±½` on the
 * remaining (zero) axis. Listing them alternately (octahedral, cube, octahedral,
 * cube) yields the parallelogram winding the renderer's quad fill needs.
 */
function rhombicFace(direction: readonly [number, number, number], bit: number): CellFace {
  const zeroAxis = direction.findIndex((component) => component === 0);
  const axisA = (zeroAxis + 1) % 3;
  const axisB = (zeroAxis + 2) % 3;
  const signA = direction[axisA]!;
  const signB = direction[axisB]!;

  const octA: [number, number, number] = [0, 0, 0];
  octA[axisA] = signA;
  const octB: [number, number, number] = [0, 0, 0];
  octB[axisB] = signB;
  const cubePlus: [number, number, number] = [0, 0, 0];
  cubePlus[axisA] = signA / 2;
  cubePlus[axisB] = signB / 2;
  cubePlus[zeroAxis] = 0.5;
  const cubeMinus: [number, number, number] = [0, 0, 0];
  cubeMinus[axisA] = signA / 2;
  cubeMinus[axisB] = signB / 2;
  cubeMinus[zeroAxis] = -0.5;

  return {
    offset: [direction[0]!, direction[1]!, direction[2]!],
    normal: unit(direction[0]!, direction[1]!, direction[2]!),
    corners: [octA, cubePlus, octB, cubeMinus],
    bit,
  };
}

/**
 * Hexel geometry: the twelve rhombic faces of a rhombic dodecahedron, one per
 * FCC nearest neighbour, on the even-parity lattice. This is the 3D counterpart
 * of a hexagonal pixel — a space-filling cell with more, gentler facets than a
 * cube, so sculpts read as rounded, close-packed volumes.
 */
export const HEXEL_GEOMETRY: CellGeometry = (() => {
  const directions = hexelDirections();
  const faces = directions.map((direction, index) => rhombicFace(direction, 1 << index));
  return {
    shape: "hexel",
    faces,
    evenParity: true,
    neighbors: directions,
  };
})();

/** The geometry for a cell shape. */
export function geometryFor(shape: CellShape): CellGeometry {
  return shape === "hexel" ? HEXEL_GEOMETRY : CUBE_GEOMETRY;
}

/** Whether `(x, y, z)` is a valid site for `geometry` (parity, if it applies). */
export function isValidSite(geometry: CellGeometry, x: number, y: number, z: number): boolean {
  return !geometry.evenParity || (((x + y + z) % 2) + 2) % 2 === 0;
}
