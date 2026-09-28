/**
 * Terrain (ENGINE_ROADMAP.md, Phase 7): a heightfield stored compactly on the
 * mesh sidecar and built into geometry when the scene loads — layered by slope
 * and height, with holes below a floor — and how the runtime treats it: it
 * doesn't frame the camera or cast into the shadow map, the far plane reaches
 * it, the auto-orbit stays above it, and it can ride on a parent object.
 */

import { describe, expect, it } from "vitest";

import {
  readTerrain,
  readTerrains,
  serializeMeshAsset,
  serializeTerrain,
  terrainHeight,
  terrainMesh,
  type MeshAsset,
  type MeshMaterial,
  type Terrain,
} from "@cartbox/editor";
import { buildOrbitCamera, orbitPitchAboveTerrain, parseMeshScene } from "@cartbox/player";
import { decodeMeshSidecar, encodeMeshSidecar } from "@/lib/meshSidecar";

const mat = (name: string): MeshMaterial => ({ name, baseColorFactor: [1, 1, 1, 1], baseColorImage: null });

/** A 9×9 grid over 16×16 units: flat at 0 on the west half, a steep wall rising east. */
function sample(extra: Partial<Terrain> = {}): Terrain {
  const n = 9;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights[j * n + i] = i < 5 ? 0 : (i - 4) * 6;
  return {
    id: "t",
    name: "Hills",
    origin: [-8, 0, -8],
    size: [16, 16],
    samples: n,
    heights,
    layers: [{ material: mat("flat"), up: [0.8, 1] }, { material: mat("steep") }],
    ...extra,
  };
}

const triangles = (mesh: MeshAsset) => mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0);

describe("terrain model", () => {
  it("reads its height anywhere on the grid (bilinear), and nothing off it", () => {
    const t = sample();
    expect(terrainHeight(t, -8, -8)).toBe(0);
    expect(terrainHeight(t, 4, 0)).toBeCloseTo(12); // sample i = 6
    expect(terrainHeight(t, 5, 0)).toBeCloseTo(15); // halfway between 12 and 18
    expect(terrainHeight(t, 9, 0)).toBeNull();
    expect(terrainHeight(t, 0, -8.5)).toBeNull();
  });

  it("builds two triangles per cell, split into layers by slope", () => {
    const t = sample();
    const mesh = terrainMesh(t);
    expect(triangles(mesh)).toBe(2 * 8 * 8);
    const [flat, steep] = mesh.primitives;
    expect(flat!.material.name).toBe("flat");
    expect(steep!.material.name).toBe("steep");
    // The flat half is 4 cells wide, the wall 4: each layer took its own half.
    expect(flat!.indices.length / 3).toBe(2 * 4 * 8);
    expect(steep!.indices.length / 3).toBe(2 * 4 * 8);
    // Faces point up (counter-clockwise from above), and normals follow the ground.
    const p = flat!.positions;
    const [a, b, c] = [flat!.indices[0]!, flat!.indices[1]!, flat!.indices[2]!];
    const ux = p[b * 3]! - p[a * 3]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    expect(uz * vx - ux * vz).toBeGreaterThan(0);
    expect(flat!.normals![1]).toBeCloseTo(1);
    // UVs are world-planar at the tile size.
    expect(flat!.uvs![0]).toBeCloseTo(-8 / 8);
  });

  it("leaves out cells below the floor, and builds coarser at a stride", () => {
    const holed = sample({ floor: 1 });
    expect(triangles(terrainMesh(holed))).toBe(2 * 4 * 8); // the flat half (all at 0) is gone
    expect(triangles(terrainMesh(sample(), 2))).toBe(2 * 4 * 4);
    expect(triangles(terrainMesh(sample(), 1, [0, 0, 4, 4]))).toBe(2 * 4 * 4);
  });

  it("layers by height too, and the last layer takes the rest", () => {
    const t = sample({ layers: [{ material: mat("high"), height: [20, 100] }, { material: mat("low") }] });
    const names = terrainMesh(t).primitives.map((p) => p.material.name);
    expect(names).toEqual(["high", "low"]);
  });

  it("round-trips through storage to its height precision", () => {
    const t = sample({ floor: -3, tile: 12, parent: "map" });
    const stored = JSON.parse(JSON.stringify(serializeTerrain(t)));
    const back = readTerrain(stored)!;
    expect(back.samples).toBe(9);
    expect(back.floor).toBe(-3);
    expect(back.tile).toBe(12);
    expect(back.parent).toBe("map");
    expect(back.layers.map((l) => l.material.name)).toEqual(["flat", "steep"]);
    expect(back.layers[0]!.up).toEqual([0.8, 1]);
    for (let i = 0; i < t.heights.length; i += 1) expect(Math.abs(back.heights[i]! - t.heights[i]!)).toBeLessThanOrEqual(0.025);
  });

  it("drops a malformed terrain", () => {
    const good = serializeTerrain(sample());
    expect(readTerrain({ ...good, samples: 1 })).toBeNull();
    expect(readTerrain({ ...good, samples: 999 })).toBeNull();
    expect(readTerrain({ ...good, samples: 10 })).toBeNull(); // heights no longer fit
    expect(readTerrain({ ...good, size: [0, 4] })).toBeNull();
    expect(readTerrain({ ...good, layers: [] })).toBeNull();
    expect(readTerrain({ ...good, heights: 7 })).toBeNull();
    expect(readTerrains([good, { junk: true }, null])).toHaveLength(1);
  });
});

function box(): MeshAsset {
  // A 2-unit cube's worth of bounds: two triangles spanning (-1,-1,-1)..(1,1,1).
  return {
    name: "box",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, -1, 1, -1, 1, 1, 1, 1]),
        normals: null,
        uvs: null,
        indices: Uint32Array.from([0, 1, 2]),
        material: mat("m"),
      },
    ],
  };
}

function sidecar(terrain: Terrain | null, transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }): string {
  return JSON.stringify({
    version: 2,
    meshes: [{ id: "map", name: "Map", mesh: serializeMeshAsset(box()), transform }],
    lighting: null,
    ...(terrain ? { terrains: [serializeTerrain(terrain)] } : {}),
  });
}

describe("terrain in the runtime scene", () => {
  it("adds the terrain as an instance that doesn't frame the camera but extends how far it sees", () => {
    const plain = parseMeshScene(sidecar(null))!;
    const scene = parseMeshScene(sidecar(sample({ origin: [-100, 0, -100], size: [200, 200] })))!;
    expect(scene.instances).toHaveLength(2);
    const terrain = scene.instances[1]!;
    expect(terrain.terrain).toBe(true);
    expect(terrain.name).toBe("Hills");
    expect(scene.bounds).toEqual(plain.bounds);
    expect(scene.extent!.radius).toBeGreaterThan(100);
    // The far plane reaches the far edge of the terrain.
    const far = (camera: ReturnType<typeof buildOrbitCamera>) => {
      const [a, b] = [camera.projection[10]!, camera.projection[14]!];
      return b / (a + 1);
    };
    const near = buildOrbitCamera(scene.bounds, 0, 0.3, 1, { near: 0.05 });
    const reach = buildOrbitCamera(scene.bounds, 0, 0.3, 1, { near: 0.05, extent: scene.extent });
    expect(far(reach)).toBeGreaterThan(far(near));
    expect(far(reach)).toBeGreaterThan(140);
  });

  it("rides on its parent object", () => {
    const moved = { position: [5, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const scene = parseMeshScene(sidecar(sample({ parent: "map" }), moved))!;
    const terrain = scene.instances[1]!;
    expect(terrain.parent).toBe(0);
    expect(terrain.model[12]).toBeCloseTo(5);
    expect(terrain.model[13]).toBeCloseTo(2);
    // A parent that doesn't exist leaves it a root.
    expect(parseMeshScene(sidecar(sample({ parent: "nope" })))!.instances[1]!.parent).toBe(-1);
  });

  it("raises the auto-orbit above terrain that would bury the camera", () => {
    const n = 5;
    const wall = sample({ origin: [-200, 0, -200], size: [400, 400], samples: n, heights: new Float32Array(n * n).fill(60) });
    const scene = parseMeshScene(sidecar(wall))!;
    const pitch = orbitPitchAboveTerrain(scene, 0, 0.35);
    expect(pitch).toBeGreaterThan(0.35);
    const plain = parseMeshScene(sidecar(null))!;
    expect(orbitPitchAboveTerrain(plain, 0, 0.35)).toBe(0.35);
  });

  it("is kept by the editor's sidecar codec", () => {
    const raw = sidecar(sample());
    const decoded = decodeMeshSidecar(raw);
    expect(decoded.terrains).toHaveLength(1);
    const again = decodeMeshSidecar(encodeMeshSidecar(decoded));
    expect(again.terrains![0]!.name).toBe("Hills");
    const junk = JSON.parse(raw);
    junk.terrains.push({ samples: 3 });
    expect(decodeMeshSidecar(JSON.stringify(junk)).terrains).toHaveLength(1);
  });
});
