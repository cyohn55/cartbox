/**
 * Hexel-terrain generator tests — the full-3D FCC volume that forms the world's
 * ground. These drive the real dependency-free generator and assert on structural
 * properties of the produced cells rather than on literal coordinates: that every
 * cell lands on a valid even-parity lattice site, that the surface actually
 * undulates, that being a true volume it carves caves below the crust while never
 * opening the protected crust, that crystals only glow against open cave, and that
 * generation is deterministic per seed. No internal noise state is inspected.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERRAIN_PARAMS,
  generateTerrain,
  type TerrainParams,
} from "../apps/web/src/lib/hexelTerrainSpecs";

/** Set membership key for a lattice site. */
function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

describe("generateTerrain", () => {
  it("places every cell on a valid even-parity FCC site", () => {
    const volume = generateTerrain();
    for (const cell of volume.cells) {
      expect((cell.x + cell.y + cell.z) % 2).toBe(0);
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(volume.sizeX);
      expect(cell.z).toBeLessThan(volume.sizeZ);
      expect(cell.y).toBeLessThan(volume.sizeY);
    }
  });

  it("produces an undulating surface, not a flat slab", () => {
    const volume = generateTerrain();
    // Highest filled cell in each column; the spread proves real relief.
    const columnTop = new Map<string, number>();
    for (const cell of volume.cells) {
      const col = `${cell.x},${cell.z}`;
      columnTop.set(col, Math.max(columnTop.get(col) ?? -1, cell.y));
    }
    const tops = [...columnTop.values()];
    expect(Math.max(...tops)).toBeGreaterThan(Math.min(...tops));
  });

  it("carves caves below the crust while keeping the crust solid", () => {
    // A carving threshold guarantees hollows; a huge crust would suppress them.
    const params: TerrainParams = { ...DEFAULT_TERRAIN_PARAMS, caveThreshold: 0.5, crust: 2 };
    const volume = generateTerrain(params);
    const filled = new Set(volume.cells.map((c) => key(c.x, c.y, c.z)));

    // Column surface heights, to reason about depth below the surface.
    const columnTop = new Map<string, number>();
    for (const cell of volume.cells) {
      const col = `${cell.x},${cell.z}`;
      columnTop.set(col, Math.max(columnTop.get(col) ?? -1, cell.y));
    }

    let caveSites = 0;
    let crustBreaches = 0;
    for (const [col, top] of columnTop) {
      const [xs, zs] = col.split(",");
      const x = Number(xs);
      const z = Number(zs);
      for (let y = 0; y <= top; y += 1) {
        if ((x + y + z) % 2 !== 0) continue; // only even-parity sites are eligible
        const depthBelowSurface = top - y;
        const solid = filled.has(key(x, y, z));
        if (!solid && depthBelowSurface >= params.crust) caveSites += 1;
        if (!solid && depthBelowSurface < params.crust && depthBelowSurface >= 0) crustBreaches += 1;
      }
    }
    expect(caveSites).toBeGreaterThan(0); // the volume really is hollowed
    expect(crustBreaches).toBe(0); // ...but never through the protected crust
  });

  it("only makes glowing cells where solid rock borders open cave above", () => {
    const volume = generateTerrain();
    const filled = new Set(volume.cells.map((c) => key(c.x, c.y, c.z)));
    for (const cell of volume.cells) {
      if (cell.emissive <= 0) continue;
      // A crystal must have open space directly above it (the cave it lines).
      expect(filled.has(key(cell.x, cell.y + 1, cell.z))).toBe(false);
    }
  });

  it("floods low ground to the water table over a sand bed", () => {
    const params: TerrainParams = { ...DEFAULT_TERRAIN_PARAMS, seaLevel: 9 };
    const volume = generateTerrain(params);
    const water = volume.cells.filter((cell) => cell.material === "water");
    expect(water.length).toBeGreaterThan(0);

    // Water never rises above the table, and every water cell sits over ground
    // whose exposed top was laid as sand (the lakebed), not grass.
    const groundTop = new Map<string, number>();
    const materialAt = new Map<string, string>();
    for (const cell of volume.cells) {
      materialAt.set(key(cell.x, cell.y, cell.z), cell.material);
      if (cell.material === "water") continue;
      const col = `${cell.x},${cell.z}`;
      groundTop.set(col, Math.max(groundTop.get(col) ?? -1, cell.y));
    }
    for (const cell of water) {
      expect(cell.y).toBeLessThanOrEqual(params.seaLevel);
      const top = groundTop.get(`${cell.x},${cell.z}`)!;
      expect(cell.y).toBeGreaterThan(top);
      expect(materialAt.get(key(cell.x, top, cell.z))).toBe("sand");
    }
  });

  it("puts a sand beach on the columns that crest just above the water", () => {
    const volume = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, seaLevel: 9 });
    const materials = new Set(volume.cells.map((cell) => cell.material));
    expect(materials.has("sand")).toBe(true);
    expect(materials.has("grass")).toBe(true); // dry land is still grassy
  });

  it("leaves the world dry when the water table is disabled", () => {
    const volume = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, seaLevel: 0 });
    expect(volume.cells.some((cell) => cell.material === "water")).toBe(false);
    expect(volume.cells.some((cell) => cell.material === "grass")).toBe(true);
  });

  it("is deterministic for a given seed and varies with it", () => {
    const a = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, seed: 42 });
    const b = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, seed: 42 });
    const c = generateTerrain({ ...DEFAULT_TERRAIN_PARAMS, seed: 43 });
    expect(a.cells.length).toBe(b.cells.length);
    expect(a.cells.map((cell) => key(cell.x, cell.y, cell.z))).toEqual(
      b.cells.map((cell) => key(cell.x, cell.y, cell.z)),
    );
    // A different seed reshapes the terrain (extremely unlikely to match).
    const sameCount = a.cells.length === c.cells.length;
    const sameCells =
      sameCount &&
      a.cells.every((cell, i) => key(cell.x, cell.y, cell.z) === key(c.cells[i]!.x, c.cells[i]!.y, c.cells[i]!.z));
    expect(sameCells).toBe(false);
  });
});
