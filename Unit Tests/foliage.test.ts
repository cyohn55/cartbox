/**
 * Foliage (ENGINE_PARITY_ROADMAP.md EP11): filling a terrain by rules (the
 * same every time, never clumped, kept off steep ground, out of a clear area
 * and off the chasm floor), painting and erasing with a brush, each copy set
 * on the ground (tilted to the slope as far as asked, and following the
 * ground when it's sculpted), merged into blocks to draw, culled by distance
 * in the overlay, stored in six bytes a copy, and Lockout's boulders and drifts.
 */

import { describe, expect, it } from "vitest";

import {
  LOCKOUT_FOLIAGE,
  copyMatrix,
  eraseFoliage,
  fillCopies,
  foliageBlocks,
  foliagePreset,
  layerCopies,
  lockoutMeshSidecar,
  lockoutTerrain,
  newTerrain,
  packFoliageCopies,
  paintFoliage,
  readFoliage,
  sculptTerrain,
  serializeFoliage,
  terrainHeight,
  unpackFoliageCopies,
  type FoliageLayer,
  type Terrain,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneRenderer } from "@cartbox/player";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { addTerrain, removeTerrain, replaceTerrain, findTerrain } from "../apps/web/src/lib/terrainEdit";
import { addFoliage, findFoliage, foliageOn, replaceFoliage } from "../apps/web/src/lib/foliageEdit";

const ground = (t: Terrain, x: number, z: number) => terrainHeight({ ...t, origin: [0, 0, 0] }, x, z)!;

/** A 64 m terrain: flat on the west half, a steep ramp up the east half. */
function hillside(): Terrain {
  const t = newTerrain("t", { size: 64, samples: 33 });
  const heights = Float32Array.from(t.heights, (_, k) => {
    const i = k % 33;
    return i > 16 ? (i - 16) * 4 : 0; // 2 m cells: a 2-in-1 slope on the east
  });
  return { ...t, heights };
}

const layer = (over: Partial<FoliageLayer> = {}): FoliageLayer => ({ id: "f", name: "rocks", terrain: "t", density: 10, scale: [1, 2], align: 1, sink: 0, cull: 100, copies: [], ...over });

describe("filling", () => {
  it("scatters the same copies for the same seed, evenly, only where the rules allow", () => {
    const t = hillside();
    const fill = { seed: 5, up: [0.9, 1] as [number, number] };
    const a = fillCopies(t, layer(), fill);
    expect(a).toEqual(fillCopies(t, layer(), fill));
    expect(fillCopies(t, layer(), { ...fill, seed: 6 })).not.toEqual(a);
    // Only on the flat west half.
    expect(a.length).toBeGreaterThan(100);
    expect(a.every((c) => c.x < 34)).toBe(true);
    // About the density: 10 per 100 m² over the flat half (~32 × 64 m).
    expect(a.length).toBeGreaterThan(150);
    expect(a.length).toBeLessThan(260);
    // Never clumped: one per grid cell, so no two closer than nothing at all.
    const sizes = a.map((c) => c.scale);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(2);
  });

  it("keeps a clear circle clear, and stays off ground below the terrain's floor and over holes", () => {
    const t = { ...hillside(), floor: 1 };
    const copies = fillCopies(t, layer(), { seed: 1, clear: [50, 32, 10] });
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.every((c) => Math.hypot(c.x - 50, c.z - 32) >= 10)).toBe(true);
    expect(copies.every((c) => ground(t, c.x, c.z) >= 1)).toBe(true); // the flat half is below the floor
  });
});

describe("painting", () => {
  it("adds copies under the brush without piling up, and erases them", () => {
    const t = hillside();
    let l = layer();
    l = paintFoliage(t, l, { x: 16, z: 32, radius: 6, strength: 1 }, 1);
    const first = l.copies.length;
    expect(first).toBeGreaterThan(5);
    expect(l.copies.every((c) => Math.hypot(c.x - 16, c.z - 32) <= 6.001)).toBe(true);
    // Dabbing the same spot again and again fills in but doesn't pile up past the density.
    for (let k = 2; k < 20; k += 1) l = paintFoliage(t, l, { x: 16, z: 32, radius: 6, strength: 1 }, k);
    expect(l.copies.length).toBeLessThan(Math.PI * 36 * 0.1 * 2.5);
    const erased = eraseFoliage(l, { x: 16, z: 32, radius: 3, strength: 1 }, 9);
    expect(erased.copies.every((c) => Math.hypot(c.x - 16, c.z - 32) > 3)).toBe(true);
    expect(erased.copies.length).toBeLessThan(l.copies.length);
  });
});

describe("placing", () => {
  it("sets each copy on the ground, tilted to the slope as far as asked", () => {
    const t = hillside();
    const c = { x: 48, z: 32, yaw: 0.3, scale: 2 };
    const upright = copyMatrix(t, { align: 0, sink: 0 }, c)!;
    const tilted = copyMatrix(t, { align: 1, sink: 0 }, c)!;
    expect(upright[13]).toBeCloseTo(ground(t, 48, 32), 3);
    // Upright: its up axis (column 1) is straight up, at the copy's scale.
    expect(upright[5]).toBeCloseTo(2, 5);
    // Aligned: its up axis leans with the slope (east, so toward −X).
    expect(tilted[4]!).toBeLessThan(-0.5);
    // Sunk: lowered along its up axis by sink × scale.
    const sunk = copyMatrix(t, { align: 0, sink: 0.25 }, c)!;
    expect(sunk[13]).toBeCloseTo(ground(t, 48, 32) - 0.5, 3);
  });

  it("follows the ground when it's sculpted afterwards (copies store no height)", () => {
    const t = newTerrain("t", { size: 32, samples: 33 });
    const l = layer({ copies: [{ x: 16, z: 16, yaw: 0, scale: 1 }] });
    const before = copyMatrix(t, l, l.copies[0]!)![13]!;
    const raised = sculptTerrain(t, "raise", { x: 16, z: 16, radius: 6, strength: 1 });
    expect(copyMatrix(raised, l, l.copies[0]!)![13]!).toBeCloseTo(before + 1.2, 3);
  });

  it("merges copies into blocks: every copy's triangles, a few draws", () => {
    const t = hillside();
    const { mesh } = foliagePreset("boulder");
    const l = layer({ fill: { seed: 3 } });
    const copies = layerCopies(t, l);
    const blocks = foliageBlocks(t, l, mesh, copies);
    const tris = (m: { primitives: readonly { indices: Uint32Array }[] }) => m.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
    expect(blocks.reduce((n, b) => n + b.copies, 0)).toBe(copies.length);
    expect(blocks.reduce((n, b) => n + tris(b.mesh), 0)).toBe(copies.length * tris(mesh));
    expect(blocks.length).toBeLessThanOrEqual(4); // 64 m in 48 m blocks
    expect(blocks.every((b) => b.radius > 0)).toBe(true);
  });
});

describe("storage", () => {
  it("packs painted copies in six bytes each, close to where they were", () => {
    const t = newTerrain("t", { size: 100, samples: 9 });
    const l = layer({ scale: [0.5, 3], copies: [{ x: 12.34, z: 87.6, yaw: 4, scale: 1.7 }] });
    const packed = packFoliageCopies(t, l);
    expect(atob(packed).length).toBe(6);
    const [c] = unpackFoliageCopies(t, l.scale, packed)!;
    expect(c!.x).toBeCloseTo(12.34, 2);
    expect(c!.z).toBeCloseTo(87.6, 2);
    expect(c!.yaw).toBeCloseTo(4, 1);
    expect(c!.scale).toBeCloseTo(1.7, 1);
    expect(unpackFoliageCopies(t, l.scale, "AAA=")).toBeNull();
  });

  it("reads layers defensively: a layer on a missing terrain is dropped, settings clamped", () => {
    const t = newTerrain("t", { size: 32, samples: 9 });
    const stored = serializeFoliage(t, layer({ fill: { seed: 2, up: [0.8, 1], clear: [1, 2, 3] } }), "mesh");
    expect(readFoliage(stored, [])).toBeNull();
    const back = readFoliage({ ...stored, density: 1e9, align: 7 }, [t])!;
    expect(back.layer.density).toBe(1000);
    expect(back.layer.align).toBe(1);
    expect(back.layer.fill).toEqual({ seed: 2, up: [0.8, 1], clear: [1, 2, 3] });
  });
});

describe("the editor and the runtime", () => {
  it("adds layers (built-in or a scene object's mesh), stores them once, and drops them with their terrain", () => {
    let sc = addMesh(emptyMeshSidecar(), foliagePreset("pine").mesh, "tree").sidecar;
    const made = addTerrain(sc, { size: 64, samples: 17 });
    sc = made.sidecar;
    const a = addFoliage(sc, made.id, { preset: "boulder" })!;
    const b = addFoliage(a.sidecar, made.id, { from: sc.meshes[0]!.id })!;
    sc = b.sidecar;
    expect(foliageOn(sc, made.id).map((f) => f.layer.name)).toEqual(["boulder", "tree"]);
    // Paint a few copies, store, read back.
    const found = findFoliage(sc, a.id)!;
    const painted = paintFoliage(findTerrain(sc, made.id)!, found.layer, { x: 32, z: 32, radius: 8, strength: 1 }, 4);
    sc = replaceFoliage(sc, painted, found.mesh);
    const raw = encodeMeshSidecar(sc)!;
    // The tree's mesh is shared by the object and the layer: stored once, in the library.
    const stored = JSON.parse(raw);
    expect(stored.foliage[1].mesh).toMatch(/^@lib:/);
    const back = decodeMeshSidecar(raw);
    expect(findFoliage(back, a.id)!.layer.copies.length).toBe(painted.copies.length);
    expect(removeTerrain(back, made.id).foliage).toBeUndefined();
    // Sculpting the terrain keeps the layer.
    expect(replaceTerrain(back, findTerrain(back, made.id)!).foliage).toHaveLength(2);
  });

  it("builds blocks at run time and the overlay culls those past their distance", async () => {
    let sc = addTerrain(emptyMeshSidecar(), { size: 400, samples: 33 }).sidecar;
    const id = sc.terrains![0]!.id;
    sc = addFoliage(sc, id, { preset: "boulder" })!.sidecar;
    const found = foliageOn(sc, id)[0]!;
    sc = replaceFoliage(sc, { ...found.layer, density: 0.5, cull: 60, fill: { seed: 1 } }, found.mesh);
    const scene = parseMeshScene(encodeMeshSidecar(sc))!;
    const blocks = scene.instances.filter((i) => i.foliage);
    expect(blocks.length).toBeGreaterThan(20);
    expect(blocks.every((b) => b.terrain && b.foliage!.cull === 60)).toBe(true);
    const drawn: number[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances) => void drawn.push(instances.length), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    surface.setCameraOverride({ yaw: 0, pitch: 0.3, distance: 5, target: [0, 0, 0], fov: null, hud: false });
    surface.blit(new Uint8Array(16 * 16 * 4));
    // The terrain's blocks are drawn; of the foliage, only what's within 60 m.
    const terrainBlocks = scene.instances.filter((i) => i.terrain && !i.foliage).length;
    expect(drawn.at(-1)!).toBeLessThan(terrainBlocks + blocks.length);
    expect(drawn.at(-1)!).toBeGreaterThan(terrainBlocks);
  });
});

describe("Lockout", () => {
  it("strews boulders and drifts over the range, clear of the gorge, at no cost per copy", () => {
    const t = lockoutTerrain();
    const stored = JSON.parse(lockoutMeshSidecar());
    // Pines on the far range too, drawn into the sky with it (I7; see vistas.test.ts).
    expect(stored.foliage.map((f: { name: string }) => f.name)).toEqual(["Boulders", "Snow drifts", "Far pines"]);
    expect(stored.foliage.every((f: { copies?: string }) => f.copies === undefined)).toBe(true); // filled by rules
    for (const l of LOCKOUT_FOLIAGE) {
      const copies = layerCopies(t, l);
      expect(copies.length).toBeGreaterThan(50);
      // None in the gorge: all beyond the clear circle and above the chasm floor.
      expect(copies.every((c) => Math.hypot(c.x - 160, c.z - 160) >= 48)).toBe(true);
      expect(copies.every((c) => t.origin[1] + ground(t, c.x, c.z) > t.floor!)).toBe(true);
    }
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    expect(scene.instances.filter((i) => i.foliage).length).toBeGreaterThan(10);
  });
});
