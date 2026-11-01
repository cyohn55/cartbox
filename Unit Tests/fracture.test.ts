/**
 * Destruction (AAA_FIDELITY_ROADMAP.md F8c): Voronoi pre-fracture (pieces
 * that fill the mesh, capped and closed), chunks thrown and settling, the
 * pieces through the mesh format, and the cart's `cartbox.shatter` reaching
 * the overlay.
 */

import { describe, expect, it } from "vitest";

import {
  breakApart,
  chunkMatrix,
  deserializeMeshAsset,
  fractureMesh,
  meshBox,
  meshVolume,
  serializeMeshAsset,
  stepChunks,
  voronoiSeeds,
  type MeshAsset,
} from "@cartbox/editor";
import { MeshOverlaySurface, RAM_LAYOUTS, parseMeshScene, runtimeSdkLua, type SceneDraw, type SceneRenderer } from "@cartbox/player";

import { PHYS_OP_SHATTER } from "../packages/player/src/physics/protocol";

/** A box `w × h × d` centred on the origin: 6 faces, outward. */
function box(w = 2, h = 1, d = 0.4): MeshAsset {
  const x = w / 2, y = h / 2, z = d / 2;
  const faces: [number[], number[]][] = [
    [[1, 0, 0], [x, -y, -z, x, y, -z, x, y, z, x, -y, z]],
    [[-1, 0, 0], [-x, -y, z, -x, y, z, -x, y, -z, -x, -y, -z]],
    [[0, 1, 0], [-x, y, -z, -x, y, z, x, y, z, x, y, -z]],
    [[0, -1, 0], [-x, -y, z, -x, -y, -z, x, -y, -z, x, -y, z]],
    [[0, 0, 1], [-x, -y, z, x, -y, z, x, y, z, -x, y, z]],
    [[0, 0, -1], [x, -y, -z, -x, -y, -z, -x, y, -z, x, y, -z]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, p], f) => {
    positions.push(...p);
    for (let k = 0; k < 4; k += 1) normals.push(...n);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return {
    name: "wall",
    primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material: { name: "stone", baseColorFactor: [0.8, 0.8, 0.8, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 } }],
  } as unknown as MeshAsset;
}

describe("Voronoi fracture", () => {
  it("scatters seeds in the bounds, denser toward an impact", () => {
    const b = { min: [-1, -1, -1], max: [1, 1, 1] };
    const even = voronoiSeeds(b, 40, 3);
    expect(even.every((s) => s.every((v) => v >= -1 && v <= 1))).toBe(true);
    const hit = voronoiSeeds(b, 40, 3, [1, 1, 1]);
    const near = (seeds: number[][]) => seeds.filter((s) => Math.hypot(s[0]! - 1, s[1]! - 1, s[2]! - 1) < 0.8).length;
    expect(near(hit)).toBeGreaterThan(near(even) + 5);
  });

  it("cuts a wall into closed pieces that fill it", () => {
    const wall = box();
    expect(meshVolume(wall.primitives)).toBeCloseTo(0.8, 6);
    const pieces = fractureMesh(wall, voronoiSeeds(meshBox(wall), 12, 7));
    expect(pieces.length).toBeGreaterThan(6);
    // Each piece closed (positive volume, outer faces and a cap), and together they fill the wall.
    let total = 0;
    for (const p of pieces) {
      expect(p.volume).toBeGreaterThan(0);
      expect(p.primitives.at(-1)!.material.name).toBe("stone:interior");
      total += p.volume;
    }
    expect(total).toBeCloseTo(0.8, 3);
    // Within the wall, about their centres.
    for (const p of pieces) for (let k = 0; k < 3; k += 1) expect(Math.abs(p.centre[k]!)).toBeLessThanOrEqual([1, 0.5, 0.2][k]! + 1e-6);
  });
});

describe("chunks", () => {
  it("fly from the hit, tumble, and settle on the floor", () => {
    const wall = box();
    const pieces = fractureMesh(wall, voronoiSeeds(meshBox(wall), 10, 2));
    const model = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1];
    const chunks = breakApart(pieces, model, [0, 1, 0.5], 6);
    // Thrown away from the impact (behind the wall: −z).
    expect(chunks.filter((c) => c.v[2] < 0).length).toBeGreaterThan(chunks.length / 2);
    const floor = [{ center: [0, -0.5, 0] as [number, number, number], half: [20, 0.5, 20] as [number, number, number] }];
    for (let i = 0; i < 600; i += 1) stepChunks(chunks, 1 / 60, floor);
    expect(chunks.every((c) => c.asleep)).toBe(true);
    for (const c of chunks) {
      expect(c.p[1]).toBeGreaterThan(-0.01);
      // Resting on its bounding sphere's core.
      expect(c.p[1]).toBeLessThanOrEqual(c.radius * 0.6 + 0.01);
    }
    // A chunk's matrix carries its rotation (orthonormal) and its place.
    const m = chunkMatrix(chunks[0]!);
    expect(Math.hypot(m[0]!, m[1]!, m[2]!)).toBeCloseTo(1, 6);
    expect([m[12], m[13], m[14]]).toEqual(chunks[0]!.p);
  });
});

describe("pieces in files and carts", () => {
  it("keeps a mesh's fracture through the mesh format", () => {
    const wall = box();
    const pieces = fractureMesh(wall, voronoiSeeds(meshBox(wall), 6, 4));
    const back = deserializeMeshAsset(serializeMeshAsset({ ...wall, fracture: { pieces } }));
    expect(back.fracture!.pieces).toHaveLength(pieces.length);
    expect(back.fracture!.pieces[0]!.volume).toBeCloseTo(pieces[0]!.volume, 6);
    expect([...back.fracture!.pieces[0]!.primitives[0]!.positions]).toEqual([...pieces[0]!.primitives[0]!.positions]);
  });

  it("gives carts cartbox.shatter when the scene has something to break", () => {
    const wall = box();
    const fractured = { ...wall, fracture: { pieces: fractureMesh(wall, voronoiSeeds(meshBox(wall), 4, 1)) } };
    const scene = (mesh: MeshAsset) => ({ instances: [{ name: "wall", mesh, model: new Float64Array(16) }] }) as any;
    const lua = runtimeSdkLua(scene(fractured), RAM_LAYOUTS.xbox360, { physics: false });
    expect(lua).toContain("cartbox.shatter");
    expect(lua).toContain(`_cmd(${PHYS_OP_SHATTER}`);
    expect(runtimeSdkLua(scene(wall), RAM_LAYOUTS.xbox360, { physics: false })).not.toContain("cartbox.shatter");
  });

  it("breaks in the overlay: the wall goes, its chunks draw and fall", async () => {
    const wall = box();
    const fractured = { ...wall, fracture: { pieces: fractureMesh(wall, voronoiSeeds(meshBox(wall), 6, 5)) } };
    const sc = parseMeshScene(JSON.stringify({ version: 2, meshes: [{ id: "w", name: "wall", mesh: serializeMeshAsset(fractured), transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] }))!;
    const drawn: { mesh: MeshAsset; model: ArrayLike<number> }[][] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances.map((i) => ({ mesh: i.mesh, model: i.model }))), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc, renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)!.map((d) => d.mesh.name)).toEqual(["wall"]);
    // The live GI traces the still scene (F3e): the wall, until it breaks.
    const still = () => (surface as unknown as { stillOccluders(): unknown[] }).stillOccluders();
    expect(still()).toHaveLength(1);
    surface.shatter(0, [0, 2, 0.3], 4);
    expect(still()).toHaveLength(0);
    surface.blit(new Uint8Array(16 * 16 * 4));
    const first = drawn.at(-1)!;
    expect(first.some((d) => d.mesh.name === "wall")).toBe(false);
    expect(first.filter((d) => d.mesh.name.startsWith("wall:piece")).length).toBe(fractured.fracture.pieces.length);
    for (let i = 0; i < 30; i += 1) surface.blit(new Uint8Array(16 * 16 * 4));
    const later = drawn.at(-1)!;
    // Half a second on, the chunks have fallen (no floor in this scene).
    const meanY = (frame: typeof later) => frame.reduce((s, d) => s + d.model[13]!, 0) / frame.length;
    expect(meanY(later)).toBeLessThan(meanY(first) - 0.5);
    // Breaking it again does nothing.
    surface.shatter(0, [0, 2, 0], 4);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)!.length).toBe(later.length);
  });
});
