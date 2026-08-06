/**
 * Convert a {@link VoxelGrid} sculpt into a true triangle {@link MeshAsset}, so a
 * creator can model in voxels and then use the result as a first-class mesh —
 * placed, transformed, and rasterised like any imported OBJ/glTF (see
 * [[mesh-asset-3d-feature]]). This is the editor bridge between the two 3D asset
 * kinds: voxels stay voxels, but they can now *become* a mesh on demand.
 *
 * The conversion is a surface mesher: it emits only the faces between a solid
 * cell and empty space (interior faces are never seen, so they are culled), which
 * keeps the triangle count to the sculpt's surface area rather than its volume.
 * Faces are grouped by colour into one {@link MeshPrimitive} per distinct colour —
 * the mesh format carries colour per material, not per vertex, so this is how a
 * multi-coloured sculpt keeps its palette without a texture. Each face gets a flat
 * axis-aligned normal, so the mesh lights correctly.
 *
 * Pure and DOM-free: geometry only, unit-testable, no rendering.
 */

import { defaultMaterial, type MeshAsset, type MeshPrimitive } from "./MeshAsset";
import { VoxelGrid } from "./VoxelGrid";

export interface VoxelToMeshOptions {
  /** World units per voxel edge (default 1). */
  readonly scale?: number;
  /** Name for the produced mesh (default "voxel-mesh"). */
  readonly name?: string;
  /**
   * Centre the mesh on the origin by subtracting the grid's half-extent (default
   * true), so the sculpt orbits around its middle rather than a corner.
   */
  readonly center?: boolean;
}

/** One cube face: the neighbour direction that must be empty for it to show, its
 * outward normal, and its four corner offsets in CCW winding (viewed from outside). */
interface Face {
  readonly neighbor: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly corners: readonly (readonly [number, number, number])[];
}

// The six cube faces. Corner windings are CCW when viewed from outside, so the
// cross product of the first two edges points along `normal` — correct front
// faces for any renderer that culls, and harmless for the two-sided rasteriser.
const FACES: readonly Face[] = [
  { neighbor: [1, 0, 0], normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { neighbor: [-1, 0, 0], normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { neighbor: [0, 1, 0], normal: [0, 1, 0], corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { neighbor: [0, -1, 0], normal: [0, -1, 0], corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { neighbor: [0, 0, 1], normal: [0, 0, 1], corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { neighbor: [0, 0, -1], normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

/** Accumulates one colour's faces into growable position/normal/index streams. */
interface ColorGroup {
  readonly rgb: readonly [number, number, number];
  readonly positions: number[];
  readonly normals: number[];
  readonly indices: number[];
}

/**
 * Convert a voxel grid into a mesh. Empty grids (no filled cells) produce a mesh
 * with no primitives — a valid, if empty, {@link MeshAsset}.
 */
export function voxelGridToMeshAsset(grid: VoxelGrid, options: VoxelToMeshOptions = {}): MeshAsset {
  const scale = options.scale ?? 1;
  const center = options.center ?? true;
  const offsetX = center ? -grid.sizeX / 2 : 0;
  const offsetY = center ? -grid.sizeY / 2 : 0;
  const offsetZ = center ? -grid.sizeZ / 2 : 0;

  // Group faces by packed colour so each distinct colour becomes one primitive.
  const groups = new Map<number, ColorGroup>();
  const groupFor = (r: number, g: number, b: number): ColorGroup => {
    const key = (r << 16) | (g << 8) | b;
    let group = groups.get(key);
    if (!group) {
      group = { rgb: [r, g, b], positions: [], normals: [], indices: [] };
      groups.set(key, group);
    }
    return group;
  };

  grid.forEachFilled((x, y, z, cell) => {
    for (const face of FACES) {
      // Skip the face if a solid neighbour hides it (interior face → culled).
      if (grid.isFilled(x + face.neighbor[0], y + face.neighbor[1], z + face.neighbor[2])) continue;

      const group = groupFor(cell.r, cell.g, cell.b);
      const baseVertex = group.positions.length / 3;
      for (const corner of face.corners) {
        group.positions.push((x + corner[0] + offsetX) * scale, (y + corner[1] + offsetY) * scale, (z + corner[2] + offsetZ) * scale);
        group.normals.push(face.normal[0], face.normal[1], face.normal[2]);
      }
      // Two triangles fan the quad: (0,1,2) and (0,2,3).
      group.indices.push(baseVertex, baseVertex + 1, baseVertex + 2, baseVertex, baseVertex + 2, baseVertex + 3);
    }
  });

  const primitives: MeshPrimitive[] = [];
  for (const group of groups.values()) {
    primitives.push({
      positions: Float32Array.from(group.positions),
      normals: Float32Array.from(group.normals),
      uvs: null,
      indices: Uint32Array.from(group.indices),
      material: {
        ...defaultMaterial("voxel"),
        baseColorFactor: [group.rgb[0] / 255, group.rgb[1] / 255, group.rgb[2] / 255, 1],
      },
    });
  }

  return { name: options.name ?? "voxel-mesh", primitives };
}
