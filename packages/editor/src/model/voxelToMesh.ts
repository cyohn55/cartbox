/**
 * Convert a {@link VoxelGrid} sculpt into a true triangle {@link MeshAsset}, so a
 * creator can model in voxels and then use the result as a first-class mesh —
 * placed, transformed, and rasterised like any imported OBJ/glTF (see
 * [[mesh-asset-3d-feature]]). This is the editor bridge between the two 3D asset
 * kinds: voxels stay voxels, but they can now *become* a mesh on demand.
 *
 * The mesher is a **greedy surface mesher**: it emits only the faces between a
 * solid cell and empty space (interior faces are never seen, so they are culled),
 * and then merges coplanar, same-colour faces into the largest possible
 * rectangles — a flat 8×8 wall becomes two triangles, not 128. That keeps the
 * triangle count to the sculpt's *shape* rather than its surface-cell count, which
 * matters because the runtime rasteriser is a CPU renderer whose cost scales with
 * triangles. Faces are grouped by colour into one {@link MeshPrimitive} per
 * distinct colour — the mesh format carries colour per material, not per vertex —
 * and each gets a flat axis-aligned normal, so the mesh lights correctly.
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

/** Accumulates one colour's quads into growable position/normal/index streams. */
interface ColorGroup {
  readonly rgb: number; // packed 0xRRGGBB
  readonly positions: number[];
  readonly normals: number[];
  readonly indices: number[];
}

/** A surface quad's mask cell: the colour showing and which way its face points. */
interface MaskCell {
  readonly rgb: number;
  readonly dir: 1 | -1;
}

/**
 * Convert a voxel grid into a mesh. Empty grids (no filled cells) produce a mesh
 * with no primitives — a valid, if empty, {@link MeshAsset}.
 */
export function voxelGridToMeshAsset(grid: VoxelGrid, options: VoxelToMeshOptions = {}): MeshAsset {
  const scale = options.scale ?? 1;
  const center = options.center ?? true;
  const dims: [number, number, number] = [grid.sizeX, grid.sizeY, grid.sizeZ];
  const offset: [number, number, number] = center ? [-dims[0] / 2, -dims[1] / 2, -dims[2] / 2] : [0, 0, 0];

  const groups = new Map<number, ColorGroup>();
  const groupFor = (rgb: number): ColorGroup => {
    let group = groups.get(rgb);
    if (!group) {
      group = { rgb, positions: [], normals: [], indices: [] };
      groups.set(rgb, group);
    }
    return group;
  };

  /** Packed colour of the cell, or -1 when empty / out of bounds. */
  const colorAt = (x: number, y: number, z: number): number => {
    const cell = grid.get(x, y, z);
    return cell ? (cell.r << 16) | (cell.g << 8) | cell.b : -1;
  };

  // One greedy sweep per axis. `d` is the slice axis; `u`,`v` span the slice plane.
  for (let d = 0; d < 3; d += 1) {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;
    const du = dims[u]!;
    const dv = dims[v]!;
    const dd = dims[d]!;

    const coord: [number, number, number] = [0, 0, 0];
    const next: [number, number, number] = [0, 0, 0];
    const mask: (MaskCell | null)[] = new Array(du * dv).fill(null);

    // Slices sit *between* cells: at each boundary `s` (the plane at coord d = s+1),
    // a face shows where exactly one of the two cells it separates is solid.
    for (let s = -1; s < dd; s += 1) {
      let n = 0;
      for (let jv = 0; jv < dv; jv += 1) {
        for (let iu = 0; iu < du; iu += 1) {
          coord[d] = s;
          coord[u] = iu;
          coord[v] = jv;
          next[d] = s + 1;
          next[u] = iu;
          next[v] = jv;
          const a = s >= 0 ? colorAt(coord[0], coord[1], coord[2]) : -1;
          const b = s < dd - 1 ? colorAt(next[0], next[1], next[2]) : -1;
          if (a >= 0 && b < 0) mask[n] = { rgb: a, dir: 1 };
          else if (b >= 0 && a < 0) mask[n] = { rgb: b, dir: -1 };
          else mask[n] = null;
          n += 1;
        }
      }

      // Greedily merge the mask into maximal same-cell rectangles.
      n = 0;
      for (let jv = 0; jv < dv; jv += 1) {
        for (let iu = 0; iu < du; ) {
          const cell = mask[n];
          if (!cell) {
            iu += 1;
            n += 1;
            continue;
          }
          // Grow the run along u, then along v while every row matches.
          let w = 1;
          while (iu + w < du && sameCell(mask[n + w], cell)) w += 1;
          let h = 1;
          let done = false;
          while (jv + h < dv && !done) {
            for (let k = 0; k < w; k += 1) {
              if (!sameCell(mask[n + k + h * du], cell)) {
                done = true;
                break;
              }
            }
            if (!done) h += 1;
          }

          emitQuad(groupFor(cell.rgb), d, u, v, s + 1, iu, jv, w, h, cell.dir, offset, scale);

          // Consume the rectangle so it isn't emitted again.
          for (let l = 0; l < h; l += 1) {
            for (let k = 0; k < w; k += 1) mask[n + k + l * du] = null;
          }
          iu += w;
          n += w;
        }
      }
    }
  }

  const primitives: MeshPrimitive[] = [];
  for (const group of groups.values()) {
    primitives.push({
      positions: Float32Array.from(group.positions),
      normals: Float32Array.from(group.normals),
      uvs: null,
      indices: Uint32Array.from(group.indices),
      material: {
        ...defaultMaterial("voxel"),
        baseColorFactor: [((group.rgb >> 16) & 0xff) / 255, ((group.rgb >> 8) & 0xff) / 255, (group.rgb & 0xff) / 255, 1],
      },
    });
  }

  return { name: options.name ?? "voxel-mesh", primitives };
}

/** Two mask cells merge only when the same colour faces the same way. */
function sameCell(a: MaskCell | null, b: MaskCell): boolean {
  return a !== null && a.rgb === b.rgb && a.dir === b.dir;
}

/**
 * Append one merged quad (a `w × h` rectangle in the slice plane at `plane`) to a
 * colour group as two triangles. `dir` sets the winding so the face's normal
 * points outward (±the slice axis).
 */
function emitQuad(
  group: ColorGroup,
  d: number,
  u: number,
  v: number,
  plane: number,
  iu: number,
  jv: number,
  w: number,
  h: number,
  dir: 1 | -1,
  offset: readonly [number, number, number],
  scale: number,
): void {
  const corner = (su: number, sv: number): [number, number, number] => {
    const p: [number, number, number] = [0, 0, 0];
    p[d] = plane;
    p[u] = iu + su;
    p[v] = jv + sv;
    return [(p[0] + offset[0]) * scale, (p[1] + offset[1]) * scale, (p[2] + offset[2]) * scale];
  };

  // CCW winding for an outward normal: (0,0)->(w,0)->(w,h)->(0,h) when dir>0, and
  // reversed when the face points the other way.
  const quad = dir > 0 ? [corner(0, 0), corner(w, 0), corner(w, h), corner(0, h)] : [corner(0, 0), corner(0, h), corner(w, h), corner(w, 0)];

  const normal: [number, number, number] = [0, 0, 0];
  normal[d] = dir;

  const baseVertex = group.positions.length / 3;
  for (const [px, py, pz] of quad) {
    group.positions.push(px, py, pz);
    group.normals.push(normal[0], normal[1], normal[2]);
  }
  group.indices.push(baseVertex, baseVertex + 1, baseVertex + 2, baseVertex, baseVertex + 2, baseVertex + 3);
}
