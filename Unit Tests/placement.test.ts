/**
 * Procedural placement (EDITOR_PRO_ROADMAP.md P4): fill rules (keep-out
 * circles, curvature, patches, distance from a spline), the cliff rocks and
 * grass cards presets, and impostors — baked in the editor, stored with the
 * layer, and drawn by the player as far blocks that trade places with the
 * full ones.
 */

import { describe, expect, it } from "vitest";
import {
  bakeImpostor,
  cliffRockMesh,
  fillCopies,
  foliagePreset,
  grassCardMesh,
  meshBounds,
  newTerrain,
  pineMesh,
  readFoliage,
  serializeFoliage,
  serializeMeshAsset,
  terrainCurvature,
  type FoliageFill,
  type Spline,
  type Terrain,
} from "@cartbox/editor";
import { parseMeshScene } from "@cartbox/player";

import { addFoliage, foliageOn, replaceFoliage } from "@/lib/foliageEdit";
import { emptyMeshSidecar, encodeMeshSidecar } from "@/lib/meshSidecar";
import { addTerrain } from "@/lib/terrainEdit";
import { decodeRgbaPng } from "./helpers/pngDecode";

/** A flat 64 m terrain centred on the origin, hard layer edges. */
function flat(): Terrain {
  const t = newTerrain("t", { size: 64, samples: 65 });
  const { blend: _blend, ...rest } = t;
  void _blend;
  return rest;
}

const layer = { density: 20, scale: [1, 1] as [number, number] };
const fill = (rules: Omit<FoliageFill, "seed">): FoliageFill => ({ seed: 9, ...rules });

describe("fill rules", () => {
  it("keep every keep-out circle clear", () => {
    const t = flat();
    const all = fillCopies(t, layer, fill({}));
    const clear = fillCopies(t, layer, fill({ keepOut: [[16, 16, 6], [48, 40, 10]] }));
    expect(clear.length).toBeLessThan(all.length);
    for (const c of clear) {
      expect(Math.hypot(c.x - 16, c.z - 16)).toBeGreaterThanOrEqual(6);
      expect(Math.hypot(c.x - 48, c.z - 40)).toBeGreaterThanOrEqual(10);
    }
  });

  it("grow only in hollows (or on crests) when asked", () => {
    const t = flat();
    const heights = new Float32Array(65 * 65);
    // A trough along z = 32 (terrain space), a ridge along z = 16.
    for (let j = 0; j < 65; j += 1) for (let i = 0; i < 65; i += 1) heights[j * 65 + i] = 0.2 * (j - 32) ** 2 * (Math.abs(j - 32) < 6 ? 1 : 0) - 0.2 * (j - 16) ** 2 * (Math.abs(j - 16) < 6 ? 1 : 0) + (Math.abs(j - 16) < 6 ? 7.2 : 0);
    const shaped = { ...t, heights };
    const hollows = fillCopies(shaped, layer, fill({ curvature: [0.02, 1000] }));
    expect(hollows.length).toBeGreaterThan(10);
    for (const c of hollows) expect(terrainCurvature(shaped, Math.round(c.x), Math.round(c.z))).toBeGreaterThanOrEqual(0.02);
    const crests = fillCopies(shaped, layer, fill({ curvature: [-1000, -0.02] }));
    expect(crests.length).toBeGreaterThan(10);
    for (const c of crests) expect(terrainCurvature(shaped, Math.round(c.x), Math.round(c.z))).toBeLessThanOrEqual(-0.02);
  });

  it("grow in patches covering about the share asked, the same every time", () => {
    const t = flat();
    const all = fillCopies(t, layer, fill({})).length;
    const third = fillCopies(t, layer, fill({ patches: { scale: 8, cover: 0.33 } }));
    const most = fillCopies(t, layer, fill({ patches: { scale: 8, cover: 0.8 } }));
    expect(third.length).toBeGreaterThan(all * 0.1);
    expect(third.length).toBeLessThan(all * 0.6);
    expect(most.length).toBeGreaterThan(third.length);
    expect(fillCopies(t, layer, fill({ patches: { scale: 8, cover: 0.33 } }))).toEqual(third);
  });

  it("stand within a distance of a spline's edge", () => {
    const t = flat();
    const creek: Spline = { id: "creek", name: "Creek", kind: "river", points: [{ p: [-40, 0, 0], width: 4 }, { p: [40, 0, 0], width: 4 }] };
    const reeds = fillCopies(t, layer, fill({ near: { splines: ["creek"], within: [0, 3] } }), undefined, { splines: [creek] });
    expect(reeds.length).toBeGreaterThan(20);
    // Terrain space z = 32 is world z = 0: the water's edge is 2 m off it, the reeds 0..3 m beyond.
    for (const c of reeds) {
      const d = Math.abs(c.z - 32) - 2;
      expect(d).toBeGreaterThanOrEqual(-0.2);
      expect(d).toBeLessThanOrEqual(3.2);
    }
    // Without the splines the rule can't be judged, and is ignored.
    expect(fillCopies(t, layer, fill({ near: { splines: ["creek"], within: [0, 3] } })).length).toBeGreaterThan(reeds.length);
  });

  it("store every rule and read it back", () => {
    const t = flat();
    const rules = fill({ keepOut: [[1, 2, 3]], curvature: [0.02, 1000], patches: { scale: 12, cover: 0.4 }, near: { splines: ["creek"], within: [0, 3] } });
    const stored = serializeFoliage(t, { id: "f", name: "reeds", terrain: "t", density: 3, scale: [1, 2], align: 0.5, sink: 0, cull: 50, copies: [], fill: rules, impostor: { distance: 60, mesh: "x" } }, "mesh");
    const back = readFoliage(JSON.parse(JSON.stringify(stored)), [t])!;
    expect(back.layer.fill).toEqual(rules);
    expect(back.layer.impostor).toEqual({ distance: 60, mesh: "x" });
  });
});

describe("the placement kit", () => {
  it("makes cliff rocks: slabs, mapped by the rock generator projected triplanar, filled onto steep ground", () => {
    const rock = cliffRockMesh();
    const b = meshBounds(rock)!;
    const [dx, dy, dz] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
    expect(dx).toBeGreaterThan(dz);
    expect(dz).toBeGreaterThan(dy);
    const m = rock.primitives[0]!.material;
    expect(m.generator?.kind).toBe("rock");
    expect(m.triplanar).toBeGreaterThan(0);
    expect(m.baseColorImage).not.toBeNull();
    const preset = foliagePreset("cliffRocks");
    expect(preset.fill?.up?.[1]).toBeLessThan(0.9);
    const made = addFoliage(addTerrain(emptyMeshSidecar()).sidecar, "terrain-1", { preset: "cliffRocks" })!;
    expect(foliageOn(made.sidecar, "terrain-1")[0]!.layer.fill?.up).toEqual(preset.fill!.up);
  });

  it("makes grass cards: crossed, two-faced quads cut out by a blade texture", () => {
    const cards = grassCardMesh().primitives[0]!;
    expect(cards.material.alphaMode).toBe("mask");
    expect(cards.indices.length).toBe(3 * 2 * 6);
    const tex = decodeRgbaPng(cards.material.baseColorImage!.bytes);
    let opaque = 0;
    let clear = 0;
    for (let i = 3; i < tex.data.length; i += 4) {
      if (tex.data[i]! > 200) opaque += 1;
      if (tex.data[i] === 0) clear += 1;
    }
    expect(opaque).toBeGreaterThan(100);
    expect(clear).toBeGreaterThan(opaque);
  });
});

describe("impostors", () => {
  it("bake a tree into four unlit views on crossed cards, cut out where the tree isn't", () => {
    const pine = pineMesh();
    const baked = bakeImpostor(pine, [], 48)!;
    expect(baked.height).toBe(48);
    const p = baked.mesh.primitives[0]!;
    expect(p.positions.length / 3).toBe(16);
    expect(p.indices.length).toBe(24);
    expect(Array.from(p.uvs!).every((u) => u >= 0 && u <= 1)).toBe(true);
    // The cards span the tree.
    const tree = meshBounds(pine)!;
    const cards = meshBounds(baked.mesh)!;
    expect(cards.min[1]).toBeCloseTo(tree.min[1], 5);
    expect(cards.max[1]).toBeCloseTo(tree.max[1], 5);
    // The atlas: opaque where the tree is, in its own (unlit) colours; clear around it.
    const atlas = decodeRgbaPng(p.material.baseColorImage!.bytes);
    expect(atlas.width).toBe(baked.width);
    let opaque = 0;
    let greenest = 0;
    for (let i = 0; i < atlas.data.length; i += 4) {
      if (atlas.data[i + 3]! < 128) continue;
      opaque += 1;
      greenest = Math.max(greenest, atlas.data[i + 1]! - atlas.data[i]!);
    }
    expect(opaque).toBeGreaterThan(atlas.width * atlas.height * 0.1);
    expect(opaque).toBeLessThan(atlas.width * atlas.height * 0.8);
    expect(greenest).toBeGreaterThan(20);
    expect(p.material.alphaMode).toBe("mask");
  });

  it("draw as far blocks that trade places with the full ones in the player", () => {
    let sidecar = addTerrain(emptyMeshSidecar(), { size: 96, samples: 49 }).sidecar;
    const made = addFoliage(sidecar, "terrain-1", { preset: "pine" })!;
    sidecar = made.sidecar;
    const found = foliageOn(sidecar, "terrain-1")[0]!;
    const cards = serializeMeshAsset(bakeImpostor(pineMesh(), [], 32)!.mesh);
    const layerWithCards = { ...found.layer, fill: { seed: 3 }, impostor: { distance: 70, mesh: cards } };
    sidecar = replaceFoliage(sidecar, layerWithCards, found.mesh);
    const scene = parseMeshScene(encodeMeshSidecar(sidecar))!;
    const near = scene.instances.filter((i) => i.foliage && !i.id.includes(":far:"));
    const far = scene.instances.filter((i) => i.id.includes(":far:"));
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBe(near.length);
    expect(near.every((i) => i.foliage!.swap?.far === false && i.foliage!.swap.distance === 70)).toBe(true);
    expect(far.every((i) => i.foliage!.swap?.far === true)).toBe(true);
    // A card block is a handful of triangles a tree; the full block far more.
    const tris = (list: typeof near) => list.reduce((n, i) => n + i.mesh.primitives.reduce((m, p) => m + p.indices.length / 3, 0), 0);
    expect(tris(far)).toBeLessThan(tris(near) / 4);
  });
});
