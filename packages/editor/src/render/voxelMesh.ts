/**
 * Turning a {@link VoxelModel} into triangles.
 *
 * The CPU renderers walk the model every frame, projecting and filling each
 * exposed face by hand. A GPU wants the opposite deal: hand it the surface once
 * as vertices, then draw it as many times as you like for nearly nothing. That
 * trade is the whole reason a map you can walk through stops being a slideshow —
 * the work moves from "per pixel, per frame, in JavaScript" to "per face, per
 * edit, in JavaScript", and a map only changes when someone changes it.
 *
 * What is emitted is exactly what the CPU path draws, so the two agree:
 *
 * - only faces the model's own mask marks exposed;
 * - a plane voxel collapsed onto its central quad, from the cube face table,
 *   whatever lattice the rest of the model uses;
 * - face-local `(u, v)` matching {@link renderMapFirstPerson}'s pick coordinates,
 *   so a texel painted in one view is the texel seen in the other;
 * - the material's layer chosen by the face's upward component, the same
 *   top/side/bottom split {@link faceTile} makes.
 *
 * Each vertex also carries a tangent frame, because a surface with normals
 * painted on it is only meaningful relative to the face it sits on. Handedness
 * is resolved here rather than in the shader: a rhombic hexel face has
 * non-perpendicular edges, so which way "v" runs is a property of the geometry,
 * not something a cross product can be assumed to recover.
 *
 * Pure and DOM-free.
 */

import { CUBE_GEOMETRY, type CellGeometry } from "./cellGeometry";
import { faceGroupOf } from "./tileAtlasTexture";
import type { VoxelModel } from "./voxelModel";

/**
 * Floats per vertex. Grouped into five `vec4`s so the buffer needs no padding
 * and every attribute starts on a 16-byte boundary:
 *
 * `0..3` position + atlas layer, `4..7` normal + emissive, `8..11` tangent +
 * handedness, `12..15` tint + unused, `16..19` uv + unused.
 */
export const VOXEL_MESH_STRIDE = 20;

/** A built surface, ready to upload. */
export interface VoxelMesh {
  /** Interleaved vertex attributes, {@link VOXEL_MESH_STRIDE} floats each. */
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  /** How many vertices and triangles were emitted. */
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** Axis-aligned bounds of the emitted geometry, in model space. */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface VoxelMeshOptions {
  /**
   * The material → layer table from {@link packAtlasTexture}, indexed
   * `material * 3 + group`. Without it every face is drawn flat in its tint.
   */
  readonly faceLayer?: Int32Array;
  /** Geometry override; defaults to the model's own (cubes for older models). */
  readonly geometry?: CellGeometry;
}

const EMPTY_MESH: VoxelMesh = {
  vertices: new Float32Array(0),
  indices: new Uint32Array(0),
  vertexCount: 0,
  triangleCount: 0,
  min: [0, 0, 0],
  max: [0, 0, 0],
};

/**
 * Count the exposed faces first so the buffers are allocated once at their exact
 * size. Growing typed arrays by reallocation dominates the cost of a rebuild, and
 * a rebuild happens on every edit.
 */
function countFaces(model: VoxelModel, geometry: CellGeometry): number {
  const planes = model.plane;
  let faces = 0;
  for (let v = 0; v < model.count; v += 1) {
    const mask = model.faces[v]!;
    const table = (planes?.[v] ?? -1) >= 0 ? CUBE_GEOMETRY.faces : geometry.faces;
    for (let f = 0; f < table.length; f += 1) {
      if ((mask & table[f]!.bit) !== 0) faces += 1;
    }
  }
  return faces;
}

/** Build the drawable surface of a model. */
export function voxelModelToMesh(model: VoxelModel, options: VoxelMeshOptions = {}): VoxelMesh {
  const geometry = options.geometry ?? model.geometry ?? CUBE_GEOMETRY;
  if (model.count === 0) return EMPTY_MESH;

  const faceCount = countFaces(model, geometry);
  if (faceCount === 0) return EMPTY_MESH;

  const vertices = new Float32Array(faceCount * 4 * VOXEL_MESH_STRIDE);
  const indices = new Uint32Array(faceCount * 6);
  const tiles = model.tile;
  const planes = model.plane;
  const faceLayer = options.faceLayer;

  let vertex = 0;
  let index = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let v = 0; v < model.count; v += 1) {
    const mask = model.faces[v]!;
    if (mask === 0) continue;

    const vx = model.x[v]!;
    const vy = model.y[v]!;
    const vz = model.z[v]!;
    const tint = [model.r[v]! / 255, model.g[v]! / 255, model.b[v]! / 255] as const;
    const emissive = model.emissive[v]!;
    const material = tiles ? tiles[v]! : -1;
    const planeAxis = planes ? planes[v]! : -1;
    const table = planeAxis >= 0 ? CUBE_GEOMETRY.faces : geometry.faces;

    for (let f = 0; f < table.length; f += 1) {
      const face = table[f]!;
      if ((mask & face.bit) === 0) continue;

      const layer =
        faceLayer && material >= 0 ? (faceLayer[material * 3 + faceGroupOf(face.normal[1])] ?? -1) : -1;

      const corners = face.corners;
      const origin = corners[0]!;
      const alongU = corners[1]!;
      const alongV = corners[3]!;
      // The plane collapse: both faces on the axis land on one central quad.
      const flatten = (offset: readonly [number, number, number]): [number, number, number] => [
        planeAxis === 0 ? 0 : offset[0]!,
        planeAxis === 1 ? 0 : offset[1]!,
        planeAxis === 2 ? 0 : offset[2]!,
      ];
      const flatOrigin = flatten(origin);
      const flatU = flatten(alongU);
      const flatV = flatten(alongV);

      const edgeU: [number, number, number] = [
        flatU[0] - flatOrigin[0],
        flatU[1] - flatOrigin[1],
        flatU[2] - flatOrigin[2],
      ];
      const edgeV: [number, number, number] = [
        flatV[0] - flatOrigin[0],
        flatV[1] - flatOrigin[1],
        flatV[2] - flatOrigin[2],
      ];
      const uLength = Math.hypot(edgeU[0], edgeU[1], edgeU[2]) || 1;
      const tangent: [number, number, number] = [
        edgeU[0] / uLength,
        edgeU[1] / uLength,
        edgeU[2] / uLength,
      ];
      // Which way v runs, expressed as the sign the shader multiplies
      // `cross(normal, tangent)` by.
      const nx = face.normal[0];
      const ny = face.normal[1];
      const nz = face.normal[2];
      const crossX = ny * tangent[2] - nz * tangent[1];
      const crossY = nz * tangent[0] - nx * tangent[2];
      const crossZ = nx * tangent[1] - ny * tangent[0];
      const handedness =
        crossX * edgeV[0] + crossY * edgeV[1] + crossZ * edgeV[2] >= 0 ? 1 : -1;

      const first = vertex;
      // Corner order matches the face's winding, so `(u, v)` runs
      // (0,0) → (1,0) → (1,1) → (0,1) — the coordinates a pick reports.
      const uvs: readonly (readonly [number, number])[] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      for (let c = 0; c < 4; c += 1) {
        const offset = flatten(corners[c]!);
        const px = vx + offset[0];
        const py = vy + offset[1];
        const pz = vz + offset[2];
        if (px < min[0]) min[0] = px;
        if (py < min[1]) min[1] = py;
        if (pz < min[2]) min[2] = pz;
        if (px > max[0]) max[0] = px;
        if (py > max[1]) max[1] = py;
        if (pz > max[2]) max[2] = pz;

        const at = vertex * VOXEL_MESH_STRIDE;
        vertices[at] = px;
        vertices[at + 1] = py;
        vertices[at + 2] = pz;
        vertices[at + 3] = layer;
        vertices[at + 4] = nx;
        vertices[at + 5] = ny;
        vertices[at + 6] = nz;
        vertices[at + 7] = emissive;
        vertices[at + 8] = tangent[0];
        vertices[at + 9] = tangent[1];
        vertices[at + 10] = tangent[2];
        vertices[at + 11] = handedness;
        vertices[at + 12] = tint[0];
        vertices[at + 13] = tint[1];
        vertices[at + 14] = tint[2];
        vertices[at + 15] = 0;
        vertices[at + 16] = uvs[c]![0];
        vertices[at + 17] = uvs[c]![1];
        vertices[at + 18] = 0;
        vertices[at + 19] = 0;
        vertex += 1;
      }

      indices[index] = first;
      indices[index + 1] = first + 1;
      indices[index + 2] = first + 2;
      indices[index + 3] = first;
      indices[index + 4] = first + 2;
      indices[index + 5] = first + 3;
      index += 6;
    }
  }

  return {
    vertices,
    indices,
    vertexCount: vertex,
    triangleCount: index / 3,
    min,
    max,
  };
}
