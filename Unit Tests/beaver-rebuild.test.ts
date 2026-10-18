/**
 * Beaver Creek rebuilt with the editor (EDITOR_PRO_ROADMAP.md P9): every
 * capability used, and the layout and gameplay exactly as before — the play
 * space's ground is the cart's to the centimetre; the walls are sculpted and
 * eroded rock beyond it; the creek is a river spline; the bases are CSG
 * stone shells with kit dressing in instanced materials; the rims are
 * forested with impostors; each base has a post volume and the eye adapts;
 * and the map fits the iPhone's budget.
 */

import { describe, expect, it } from "vitest";

import {
  BEAVER_CREEK_SPLINE,
  BEAVER_GROUND,
  BEAVER_LIGHTING,
  BEAVER_MAP,
  arenaMap,
  beaverFoliage,
  beaverMapLayout,
  beaverTerrain,
  groundHeight,
  overBudget,
  readSplines,
  terrainHeight,
  validateArenaMap,
  beaverNavMesh,
} from "@cartbox/editor";

import { decodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { sceneLoadOf } from "../apps/web/src/lib/sceneBudget";

describe("the canyon, sculpted and eroded (P2)", () => {
  const t = beaverTerrain();

  it("is the cart's ground everywhere play goes", () => {
    let worst = 0;
    for (let x = -32; x <= 32; x += 0.5) {
      for (let z = -15; z <= 15; z += 0.5) {
        worst = Math.max(worst, Math.abs(terrainHeight(t, x, z)! - groundHeight(BEAVER_GROUND, x, z)!));
      }
    }
    expect(worst).toBeLessThan(0.03); // (heights are stored to 5 cm)
  });

  it("rises in walls of rock to rims well above the ledges, irregular rather than one slab", () => {
    const rims: number[] = [];
    // (Clear of the creek's gorge, which falls away round x = 0.)
    for (let x = -40; x <= 40; x += 2) if (Math.abs(x) >= 16) rims.push(terrainHeight(t, x, 26)!, terrainHeight(t, x, -26)!);
    expect(Math.min(...rims)).toBeGreaterThan(10);
    const spread = Math.max(...rims) - Math.min(...rims);
    expect(spread).toBeGreaterThan(1.5);
    // The gorge: lower than the rims either side of it, but still above the ledges.
    for (const z of [26, -26]) {
      expect(terrainHeight(t, 0, z)!).toBeLessThan(Math.min(...rims));
      expect(terrainHeight(t, 0, z)!).toBeGreaterThan(3);
    }
    // Past the ends too, behind the bases.
    expect(terrainHeight(t, 42, 0)!).toBeGreaterThan(10);
    expect(terrainHeight(t, -42, 0)!).toBeGreaterThan(10);
  });

  it("still validates: the map plays as it did", () => {
    expect(validateArenaMap(BEAVER_MAP, { navmesh: beaverNavMesh() })).toEqual([]);
  });
});

describe("the map's pieces (P3, P5, P1b)", () => {
  const sidecar = JSON.parse(arenaMap("beaver").sidecar()) as { splines?: unknown; materials?: { id: string }[]; meshes: unknown[] };

  it("runs the creek as a river spline down its bed, its water at the cart's water line", () => {
    const [spline] = readSplines(sidecar.splines);
    expect(spline).toEqual(BEAVER_CREEK_SPLINE);
    for (const point of BEAVER_CREEK_SPLINE.points) {
      expect(point.p[1]).toBeCloseTo(-0.45, 6);
      expect(Math.abs(point.p[0])).toBeLessThan(1);
    }
    const names = beaverMapLayout().mesh.primitives.map((p) => p.material.name);
    expect(names).toContain("river-water");
    expect(names).toContain("river-foam");
  });

  it("dresses the bases in kit materials, instances of the scene's library", () => {
    expect(sidecar.materials?.map((m) => m.id)).toEqual(["beaver-stone", "beaver-metal", "beaver-rock", "beaver-light"]);
    const prims = beaverMapLayout().mesh.primitives;
    const byName = new Map(prims.map((p) => [p.material.name, p.material]));
    expect(byName.get("base-stone")?.instance?.of).toBe("beaver-stone");
    expect(byName.get("arch-rock")?.instance).toEqual({ of: "beaver-rock", overrides: ["macro"] });
    expect(byName.get("blue-light")?.instance?.overrides).toEqual(["baseColorFactor", "emissiveFactor"]);
    expect(byName.get("red-light")?.instance?.of).toBe("beaver-light");
    // Blue's lights and red's are the same strips, turned.
    expect(byName.get("blue-light")?.emissiveFactor).not.toEqual(byName.get("red-light")?.emissiveFactor);
  });

  it("keeps everything solid where the cart's boxes are, and nothing solid in the doors", () => {
    // The stone shell's walls stand where the cart's walls are: none of it inside a doorway.
    const stone = beaverMapLayout().mesh.primitives.find((p) => p.material.name === "base-stone")!;
    for (let i = 0; i < stone.positions.length; i += 3) {
      const x = stone.positions[i]!, y = stone.positions[i + 1]!, z = stone.positions[i + 2]!;
      const inFrontDoor = x > -19.45 && x < -19.05 && Math.abs(z) < 1.95 && y > 0.05 && y < 2.35;
      expect(inFrontDoor, `stone in blue's front door at ${x}, ${y}, ${z}`).toBe(false);
    }
  });
});

describe("the plants (P4)", () => {
  const layers = Object.fromEntries(beaverFoliage().map(({ layer }) => [layer.id, layer]));

  it("forests the rims with trees drawn as impostors far off", () => {
    for (const id of ["beaver-trees", "beaver-pines"]) {
      expect(layers[id]!.impostor?.distance).toBe(32);
      expect(layers[id]!.fill?.patches?.cover).toBeGreaterThan(0);
    }
  });

  it("breaks the walls up with cliff rocks on the steep faces only", () => {
    expect(layers["beaver-cliff-rocks"]!.fill?.up).toEqual([0.08, 0.8]);
  });
});

describe("the light (P6)", () => {
  it("gives each base a post volume, and the eye adapts", () => {
    const volumes = BEAVER_LIGHTING.postVolumes ?? [];
    expect(volumes.map((v) => v.id)).toEqual(["blue-base", "red-base", "creek"]);
    expect(volumes[0]!.center).toEqual([-25, 1.7, 0]);
    expect(volumes[1]!.center).toEqual([25, 1.7, 0]);
    expect(BEAVER_LIGHTING.autoExposure).toBeTruthy();
  });
});

describe("the profiler pass (P8)", () => {
  it("fits the iPhone's budget as stored, as Lockout does", () => {
    for (const id of ["beaver", "lockout"]) {
      const load = sceneLoadOf(decodeMeshSidecar(arenaMap(id).sidecar()));
      expect(overBudget(load, "iphone"), id).toEqual([]);
    }
  });
});
