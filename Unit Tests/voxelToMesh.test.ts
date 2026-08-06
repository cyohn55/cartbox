/**
 * Unit tests for voxel→mesh conversion (`voxelGridToMeshAsset`): the editor
 * bridge that turns a voxel sculpt into a true triangle mesh. These verify the
 * surface-mesher's core promises — interior faces are culled, colours split into
 * primitives, geometry is well-formed, and it renders — using real VoxelGrids
 * built through the grid's own API (no hand-rolled vertex data).
 */

import { describe, expect, it } from "vitest";

import {
  VoxelGrid,
  voxelGridToMeshAsset,
  meshTriangleCount,
  meshBounds,
  renderMesh,
  type MeshAsset,
} from "@cartbox/editor";

/** Count triangles across all primitives. */
const triCount = (mesh: MeshAsset): number => meshTriangleCount(mesh);

describe("voxelGridToMeshAsset", () => {
  it("emits a single cube's six faces (12 triangles) and no interior faces", () => {
    const grid = new VoxelGrid(1, 1, 1);
    grid.set(0, 0, 0, 200, 100, 50);
    const mesh = voxelGridToMeshAsset(grid);
    expect(mesh.primitives).toHaveLength(1); // one colour
    expect(triCount(mesh)).toBe(12); // 6 faces × 2 triangles
  });

  it("greedily merges two adjacent same-colour voxels into one box (6 quads)", () => {
    const grid = new VoxelGrid(2, 1, 1);
    grid.set(0, 0, 0, 10, 20, 30);
    grid.set(1, 0, 0, 10, 20, 30);
    const mesh = voxelGridToMeshAsset(grid);
    // Per-face culling alone gives 20 tris; greedy merges each of the 6 planar
    // faces of the 2×1×1 box into a single quad → 6 quads = 12 tris.
    expect(triCount(mesh)).toBe(12);
    expect(mesh.primitives).toHaveLength(1); // same colour → one primitive
  });

  it("greedily merges a flat same-colour slab far below its surface-face count", () => {
    const grid = new VoxelGrid(4, 4, 1);
    for (let x = 0; x < 4; x += 1) for (let y = 0; y < 4; y += 1) grid.set(x, y, 0, 90, 90, 90);
    const mesh = voxelGridToMeshAsset(grid);
    // The 4×4×1 slab has 2*(16+4+4)=48 surface faces (96 tris) per-face; greedy
    // collapses each planar face to one quad: top + bottom + 4 sides = 6 quads.
    expect(triCount(mesh)).toBe(12);
  });

  it("splits distinct colours into separate primitives", () => {
    const grid = new VoxelGrid(2, 1, 1);
    grid.set(0, 0, 0, 255, 0, 0); // red
    grid.set(1, 0, 0, 0, 0, 255); // blue
    const mesh = voxelGridToMeshAsset(grid);
    expect(mesh.primitives).toHaveLength(2);
    // Each cube shows 5 faces (the touching face is culled) = 10 tris apiece.
    expect(triCount(mesh)).toBe(20);
    const factors = mesh.primitives.map((p) => p.material.baseColorFactor);
    expect(factors).toContainEqual([1, 0, 0, 1]);
    expect(factors).toContainEqual([0, 0, 1, 1]);
  });

  it("produces well-formed streams: normals per vertex, indices in range", () => {
    const grid = new VoxelGrid(2, 2, 2);
    grid.set(0, 0, 0, 100, 100, 100);
    grid.set(1, 1, 1, 100, 100, 100);
    const mesh = voxelGridToMeshAsset(grid);
    for (const prim of mesh.primitives) {
      const vertexCount = prim.positions.length / 3;
      expect(prim.normals).not.toBeNull();
      expect(prim.normals!.length).toBe(vertexCount * 3);
      for (const index of prim.indices) {
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThan(vertexCount);
      }
      // Every face normal is a unit axis vector.
      for (let i = 0; i < prim.normals!.length; i += 3) {
        const len = Math.hypot(prim.normals![i]!, prim.normals![i + 1]!, prim.normals![i + 2]!);
        expect(len).toBeCloseTo(1, 5);
      }
    }
  });

  it("centers on the origin and scales the voxel edge", () => {
    const grid = new VoxelGrid(2, 2, 2);
    grid.forEachFilled(() => {}); // no-op; fill below
    grid.set(0, 0, 0, 1, 1, 1);
    grid.set(1, 1, 1, 1, 1, 1);
    const mesh = voxelGridToMeshAsset(grid, { scale: 2 });
    const bounds = meshBounds(mesh)!;
    // Grid spans 0..2 voxels → centered ±1 voxel → ×2 scale → ±2 world units.
    expect(bounds.min).toEqual([-2, -2, -2]);
    expect(bounds.max).toEqual([2, 2, 2]);
  });

  it("returns an empty mesh for an empty grid", () => {
    const mesh = voxelGridToMeshAsset(new VoxelGrid(4, 4, 4));
    expect(mesh.primitives).toHaveLength(0);
    expect(meshBounds(mesh)).toBeNull();
  });

  it("renders the converted mesh to visible pixels", () => {
    const grid = new VoxelGrid(1, 1, 1);
    grid.set(0, 0, 0, 0, 255, 0);
    const mesh = voxelGridToMeshAsset(grid);
    const size = 32;
    const out = new Uint8ClampedArray(size * size * 4);
    const depth = new Float32Array(size * size);
    renderMesh(mesh, { camera: { yaw: 0.6, pitch: 0.5 }, size, out, depth, ambient: 1 });
    const center = ((size >> 1) * size + (size >> 1)) * 4;
    expect(out[center + 3]).toBe(255); // the cube covers the centre
    expect(out[center + 1]).toBeGreaterThan(0); // green present
  });
});
