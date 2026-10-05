/**
 * Terrain tools (ENGINE_PARITY_ROADMAP.md EP10): a new terrain, the sculpt
 * brushes (raise, lower, smooth, flatten, noise), painting layers into a
 * splat map that the mesh then follows, holes cut through the ground (and
 * filled back), picking the ground with a ray, and all of it surviving storage.
 */

import { describe, expect, it } from "vitest";

import {
  bakeTerrainPaint,
  brushFalloff,
  cutTerrainHoles,
  newTerrain,
  paintTerrain,
  paintedWeights,
  raycastTerrain,
  readTerrain,
  sculptTerrain,
  serializeTerrain,
  terrainHeight,
  terrainMesh,
  type Terrain,
} from "@cartbox/editor";

/** Height at a terrain-space point (the terrain's origin set aside). */
const at = (t: Terrain, x: number, z: number) => terrainHeight({ ...t, origin: [0, 0, 0] }, x, z);
const tris = (t: Terrain) => terrainMesh(t).primitives.reduce((n, p) => n + p.indices.length / 3, 0);

describe("a new terrain", () => {
  it("is flat, centred, and starts with rock, snow, dirt (painted only) and grass", () => {
    const t = newTerrain("t1", { size: 32, samples: 33 });
    expect(t.origin).toEqual([-16, 0, -16]);
    expect(t.heights.every((h) => h === 0)).toBe(true);
    expect(t.layers.map((l) => l.material.name)).toEqual(["rock", "snow", "dirt", "grass"]);
    // Flat and low: all grass, none of the paint-only dirt.
    const mesh = terrainMesh(t);
    expect(mesh.primitives.map((p) => p.material.name)).toEqual(["grass"]);
  });
});

describe("sculpting", () => {
  const base = () => newTerrain("t", { size: 32, samples: 33 });
  const brush = { x: 16, z: 16, radius: 6, strength: 1 };

  it("raises most at the centre, easing to nothing at the rim, and lowers the same way", () => {
    expect(brushFalloff(0, 6)).toBe(1);
    expect(brushFalloff(6, 6)).toBe(0);
    const up = sculptTerrain(base(), "raise", brush);
    expect(at(up, 16, 16)!).toBeCloseTo(1.2, 5); // a fifth of the radius at full strength
    expect(at(up, 19, 16)!).toBeGreaterThan(0);
    expect(at(up, 19, 16)!).toBeLessThan(at(up, 16, 16)!);
    expect(at(up, 23, 16)).toBe(0);
    expect(at(sculptTerrain(base(), "lower", brush), 16, 16)!).toBeCloseTo(-1.2, 5);
    // The original is untouched (each dab can be undone).
    const t = base();
    sculptTerrain(t, "raise", brush);
    expect(t.heights.every((h) => h === 0)).toBe(true);
  });

  it("smooths a spike toward its neighbours and flattens toward a level", () => {
    let t = base();
    const heights = Float32Array.from(t.heights);
    heights[16 * 33 + 16] = 10;
    t = { ...t, heights };
    const smooth = sculptTerrain(t, "smooth", { ...brush, radius: 3 });
    expect(at(smooth, 16, 16)!).toBeLessThan(5);
    expect(at(smooth, 17, 16)!).toBeGreaterThan(0);
    const hill = sculptTerrain(sculptTerrain(base(), "raise", brush), "raise", brush);
    const flat = sculptTerrain(hill, "flatten", { ...brush, radius: 4 }, 0.2);
    expect(at(flat, 16, 16)!).toBeCloseTo(0.2, 5);
    // Flatten with no level holds the height under the brush's centre.
    const held = sculptTerrain(hill, "flatten", { ...brush, x: 13 });
    expect(at(held, 13, 16)!).toBeCloseTo(at(hill, 13, 16)!, 5);
  });

  it("roughens with noise inside the brush only", () => {
    const rough = sculptTerrain(base(), "noise", brush);
    const inside = [14, 15, 16, 17, 18].map((x) => at(rough, x, 16)!);
    expect(new Set(inside.map((v) => v.toFixed(4))).size).toBeGreaterThan(2);
    expect(at(rough, 2, 2)).toBe(0);
  });
});

describe("painting", () => {
  it("bakes the rules into a splat map, then paints a layer in where the brush goes", () => {
    const t = newTerrain("t", { size: 32, samples: 33 });
    const baked = bakeTerrainPaint(t);
    expect(baked.length).toBe(33 * 33 * 4);
    expect(Array.from(baked.slice(0, 4))).toEqual([0, 0, 0, 255]); // grass
    const painted = paintTerrain(t, 2, { x: 16, z: 16, radius: 5, strength: 1 });
    const w = paintedWeights(painted, 16, 16)!;
    expect(w[2]).toBeCloseTo(1);
    expect(paintedWeights(painted, 2, 2)![3]).toBeCloseTo(1); // untouched: still grass
    // Each sample's bytes sum to 255.
    for (let k = 0; k < 33 * 33; k += 1) expect(painted.paint![k * 4]! + painted.paint![k * 4 + 1]! + painted.paint![k * 4 + 2]! + painted.paint![k * 4 + 3]!).toBe(255);
    // The mesh follows the paint: dirt shows (blended with grass at its edge).
    const names = terrainMesh(painted).primitives.map((p) => p.material.name);
    expect(names.some((n) => n.includes("dirt"))).toBe(true);
    // A half-strength dab paints half way.
    const half = paintTerrain(t, 0, { x: 16, z: 16, radius: 5, strength: 0.5 });
    expect(paintedWeights(half, 16, 16)![0]).toBeCloseTo(0.5, 1);
  });
});

describe("holes", () => {
  it("cuts the ground away under the brush (no triangles, no height), and fills it back", () => {
    const t = newTerrain("t", { size: 32, samples: 33 });
    const cut = cutTerrainHoles(t, { x: 16, z: 16, radius: 3, strength: 1 });
    expect(at(cut, 16, 16)).toBeNull();
    expect(at(cut, 2, 2)).toBe(0);
    expect(tris(cut)).toBeLessThan(tris(t));
    // Coarser detail keeps the hole open.
    const count = (m: ReturnType<typeof terrainMesh>) => m.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(count(terrainMesh(cut, 4))).toBeLessThan(count(terrainMesh(t, 4)));
    const filled = cutTerrainHoles(cut, { x: 16, z: 16, radius: 3, strength: 1 }, true);
    expect(filled.holes).toBeUndefined();
    expect(tris(filled)).toBe(tris(t));
  });
});

describe("picking and storage", () => {
  it("finds where a ray meets the ground, and passes through a hole", () => {
    const t = sculptTerrain(newTerrain("t", { size: 32, samples: 33 }), "raise", { x: 16, z: 16, radius: 8, strength: 1 });
    const hit = raycastTerrain(t, [16, 20, 16], [0, -1, 0])!;
    expect(hit[1]).toBeCloseTo(at(t, 16, 16)!, 3);
    const slanted = raycastTerrain(t, [0, 10, 0], [1, -0.7, 1])!;
    expect(slanted[1]).toBeCloseTo(at(t, slanted[0], slanted[2])!, 2);
    expect(raycastTerrain(t, [16, 20, 16], [0, 1, 0])).toBeNull();
    const cut = cutTerrainHoles(t, { x: 16, z: 16, radius: 2, strength: 1 });
    expect(raycastTerrain(cut, [16, 20, 16], [0, -1, 0])).toBeNull();
  });

  it("keeps heights, paint, holes and paint-only layers through storage", () => {
    let t = newTerrain("t", { size: 32, samples: 33 });
    t = sculptTerrain(t, "raise", { x: 10, z: 10, radius: 5, strength: 1 });
    t = paintTerrain(t, 2, { x: 20, z: 20, radius: 4, strength: 1 });
    t = cutTerrainHoles(t, { x: 5, z: 25, radius: 2, strength: 1 });
    const back = readTerrain(JSON.parse(JSON.stringify(serializeTerrain(t))))!;
    expect(Array.from(back.paint!)).toEqual(Array.from(t.paint!));
    expect(Array.from(back.holes!)).toEqual(Array.from(t.holes!));
    expect(back.layers[2]!.paintOnly).toBe(true);
    expect(at(back, 10, 10)!).toBeCloseTo(at(t, 10, 10)!, 1);
    // A splat map of the wrong size is dropped, not misread.
    expect(readTerrain({ ...serializeTerrain(t), paint: "AAAA" })!.paint).toBeUndefined();
  });
});

describe("the editor", () => {
  it("adds, edits and removes terrains on the sidecar", async () => {
    const { emptyMeshSidecar, encodeMeshSidecar, decodeMeshSidecar } = await import("../apps/web/src/lib/meshSidecar");
    const { addTerrain, findTerrain, removeTerrain, replaceTerrain } = await import("../apps/web/src/lib/terrainEdit");
    const a = addTerrain(emptyMeshSidecar(), { size: 32, samples: 17 });
    const b = addTerrain(a.sidecar);
    expect([a.id, b.id]).toEqual(["terrain-1", "terrain-2"]);
    const t = findTerrain(b.sidecar, a.id)!;
    expect(t.samples).toBe(17);
    const raised = sculptTerrain(t, "raise", { x: 16, z: 16, radius: 6, strength: 1 });
    const edited = replaceTerrain(b.sidecar, raised);
    // Through the sidecar's own storage and back.
    const back = decodeMeshSidecar(encodeMeshSidecar(edited));
    expect(at(findTerrain(back, a.id)!, 16, 16)!).toBeCloseTo(1.2, 1);
    expect(removeTerrain(removeTerrain(edited, a.id), b.id).terrains).toBeUndefined();
  });

  it("spaces a stroke's dabs a quarter of the brush apart, however fast the cursor moves", async () => {
    const { DAB_SPACING, strokeDabs } = await import("../apps/web/src/lib/terrainEdit");
    expect(strokeDabs(null, [3, 4], 4).dabs).toEqual([[3, 4]]);
    const fast = strokeDabs([0, 0], [10, 0], 4);
    expect(fast.dabs).toHaveLength(10);
    expect(fast.dabs[0]![0]).toBeCloseTo(4 * DAB_SPACING);
    expect(fast.last).toEqual(fast.dabs[9]);
    // Too short a move lays nothing and keeps the last dab as the start.
    expect(strokeDabs([0, 0], [0.5, 0], 4)).toEqual({ dabs: [], last: [0, 0] });
  });

  it("hits the ground through a placed terrain's world matrix, and rings the brush on it", async () => {
    const { brushRing, terrainRayHit } = await import("../apps/web/src/lib/terrainEdit");
    const { composeModelMatrix } = await import("@cartbox/editor");
    const t = newTerrain("t", { size: 32, samples: 33 }); // corner at (−16, 0, −16)
    const model = composeModelMatrix([100, 5, 0], [0, 0, 0], [1, 1, 1]);
    const hit = terrainRayHit(t, model, { origin: [100, 50, 0], dir: [0, -1, 0] })!;
    expect(hit.local[0]).toBeCloseTo(16);
    expect(hit.local[2]).toBeCloseTo(16);
    expect(hit.world[1]).toBeCloseTo(5);
    expect(terrainRayHit(t, model, { origin: [0, 50, 0], dir: [0, -1, 0] })).toBeNull(); // off the terrain
    const ring = brushRing(t, model, 16, 16, 3, 8);
    expect(ring).toHaveLength(9);
    expect(Math.hypot(ring[0]![0] - 100, ring[0]![2])).toBeCloseTo(3);
  });
});
