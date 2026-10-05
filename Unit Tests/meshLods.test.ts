/**
 * LODs on scene objects (ENGINE_PARITY_ROADMAP.md EP9b): stored on sidecar
 * entries (deduplicated through the library), read by the runtime into each
 * instance's chain, swapped by distance in the mesh's own units, drawn by the
 * overlay over a skinned object's live buffers and in its tint, carried onto
 * debris, generated and cleared from the editor, made on import, and Lockout's
 * soldiers and dropped weapons shipping theirs.
 */

import { describe, expect, it } from "vitest";

import {
  applyLods,
  composeModelMatrix,
  deserializeMeshAsset,
  encodeLods,
  generateLods,
  lockoutMeshSidecar,
  resolveMeshRef,
  serializeMeshAsset,
  triangleCountOf,
  type LodChain,
  type MeshAsset,
  type MeshSceneInstance,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshAsset, setMeshDebris } from "../apps/web/src/lib/meshSidecar";
import { AUTO_LOD_TRIANGLES, clearEntryLods, generateEntryLods, lodSummary, withAutoLods } from "../apps/web/src/lib/meshLods";

/** A UV sphere with two materials (top and bottom halves). */
function sphere(segments = 32, rings = 16): MeshAsset {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  for (let r = 0; r <= rings; r += 1) {
    const v = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s += 1) {
      const u = (s / segments) * Math.PI * 2;
      const p = [Math.sin(v) * Math.cos(u), Math.cos(v), Math.sin(v) * Math.sin(u)];
      positions.push(...p);
      normals.push(...p);
      uvs.push(s / segments, r / rings);
    }
  }
  const half = (from: number, to: number) => {
    const indices: number[] = [];
    for (let r = from; r < to; r += 1) {
      for (let s = 0; s < segments; s += 1) {
        const a = r * (segments + 1) + s;
        indices.push(a, a + segments + 1, a + 1, a + 1, a + segments + 1, a + segments + 2);
      }
    }
    return Uint32Array.from(indices);
  };
  const prim = (name: string, indices: Uint32Array) => ({ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices, material: { name, baseColorFactor: [0.7, 0.7, 0.7, 1] as [number, number, number, number], baseColorImage: null } });
  return { name: "ball", primitives: [prim("top", half(0, rings / 2)), prim("bottom", half(rings / 2, rings))] };
}

describe("storage", () => {
  it("keeps an entry's LODs through the editor's codec, storing a shared model's levels once", () => {
    const ball = sphere();
    let sc = addMesh(emptyMeshSidecar(), ball, "a").sidecar;
    sc = addMesh(sc, ball, "b").sidecar;
    const made = generateEntryLods(sc, sc.meshes[0]!.id);
    expect(made.made).toBe(true);
    // Both copies of the model get the levels.
    expect(made.sidecar.meshes.every((m) => m.lods)).toBe(true);
    const raw = encodeMeshSidecar(made.sidecar)!;
    const stored = JSON.parse(raw);
    // Each level string sits in the library once, referenced from both entries.
    expect(stored.meshes[0].lods.levels[0]).toMatch(/^@lib:/);
    expect(stored.meshes[1].lods.levels[0]).toBe(stored.meshes[0].lods.levels[0]);
    const back = decodeMeshSidecar(raw);
    expect(back.meshes[0]!.lods).toEqual(made.sidecar.meshes[0]!.lods);
    expect(lodSummary(back.meshes[0]!)!.triangles[0]).toBe(triangleCountOf(ball));
    expect(lodSummary(back.meshes[0]!)!.stale).toBe(false);
  });

  it("reads them at run time into each instance's chain, shared between copies", () => {
    const ball = sphere();
    let sc = addMesh(emptyMeshSidecar(), ball, "a").sidecar;
    sc = addMesh(sc, ball, "b").sidecar;
    sc = generateEntryLods(sc, sc.meshes[0]!.id).sidecar;
    const scene = parseMeshScene(encodeMeshSidecar(sc))!;
    const [a, b] = scene.instances;
    expect(a!.lod!.meshes[0]).toBe(a!.mesh); // the full mesh first
    expect(a!.lod!.meshes).toHaveLength(3);
    expect(a!.lod).toBe(b!.lod); // decoded once
    expect(a!.lod!.meshes[1]!.primitives[0]!.positions).toBe(a!.mesh.primitives[0]!.positions);
  });

  it("refuses levels left from geometry since changed, and says so in the editor", () => {
    const ball = sphere();
    let sc = addMesh(emptyMeshSidecar(), ball, "a").sidecar;
    sc = generateEntryLods(sc, sc.meshes[0]!.id).sidecar;
    const dented = sphere();
    dented.primitives[0]!.positions[50] = 0.2;
    dented.primitives[1]!.positions[50] = 0.2;
    sc = setMeshAsset(sc, sc.meshes[0]!.id, dented);
    expect(lodSummary(sc.meshes[0]!)!.stale).toBe(true);
    expect(parseMeshScene(encodeMeshSidecar(sc))!.instances[0]!.lod).toBeUndefined();
    // Cleared, nothing is left.
    expect(clearEntryLods(sc, sc.meshes[0]!.id).meshes[0]!.lods).toBeUndefined();
  });

  it("makes LODs on import only for a model heavy enough to want them", () => {
    const light = addMesh(emptyMeshSidecar(), sphere(), "light");
    expect(withAutoLods(light.sidecar, light.id).meshes[0]!.lods).toBeUndefined();
    const big = sphere(64, 40);
    expect(triangleCountOf(big)).toBeGreaterThanOrEqual(AUTO_LOD_TRIANGLES);
    const heavy = addMesh(emptyMeshSidecar(), big, "heavy");
    expect(withAutoLods(heavy.sidecar, heavy.id).meshes[0]!.lods).toBeTruthy();
  });

  it("dresses debris in its source's levels, minus the parts it leaves off", () => {
    let sc = addMesh(emptyMeshSidecar(), sphere(), "gun").sidecar;
    sc = generateEntryLods(sc, sc.meshes[0]!.id).sidecar;
    sc = setMeshDebris(sc, [{ name: "dropped", source: "gun", without: ["bottom"], life: 5, bounce: 0.2, friction: 0.5, max: 4 }]);
    const scene = parseMeshScene(encodeMeshSidecar(sc))!;
    const chain = scene.debrisLods![0]!;
    expect(chain.meshes[0]).toBe(scene.debrisMeshes![0]);
    expect(chain.meshes.every((m) => m.primitives.length === 1 && m.primitives[0]!.material.name === "top")).toBe(true);
  });
});

describe("selection", () => {
  const chain = (): LodChain => {
    const ball = sphere();
    const lods = generateLods(ball)!;
    return { meshes: [ball, ...lods.meshes], distances: lods.distances };
  };

  it("switches by distance in the mesh's own units: a model at a tenth the size drops detail ten times sooner", () => {
    const lod = chain();
    const at = (x: number, s: number): MeshSceneInstance => ({ mesh: lod.meshes[0]!, model: composeModelMatrix([x, 0, 0], [0, 0, 0], [s, s, s]), lod });
    const d = (lod.distances[0]! + lod.distances[1]!) / 2; // between the switch points
    expect(applyLods([at(d, 1)], 0, 0, 0)[0]!.mesh).toBe(lod.meshes[1]);
    expect(applyLods([at(d / 10, 0.1)], 0, 0, 0)[0]!.mesh).toBe(lod.meshes[1]);
    expect(applyLods([at(d / 10, 1)], 0, 0, 0)[0]!.mesh).toBe(lod.meshes[0]);
  });
});

describe("the overlay", () => {
  /** Lockout's soldier alone, as a one-object scene. */
  function soldierScene(): string {
    const lockout = JSON.parse(lockoutMeshSidecar());
    return JSON.stringify({ version: 2, meshes: [lockout.meshes[1]], library: lockout.library, lighting: null });
  }

  it("asks for LODs, and a skinned object's levels ride its live (posed) buffers", async () => {
    const scene = parseMeshScene(soldierScene())!;
    expect(scene.instances[0]!.lod!.meshes).toHaveLength(3);
    const seen: { instances: readonly MeshSceneInstance[]; draw: SceneDraw }[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, draw) => void seen.push({ instances, draw }), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    const { instances, draw } = seen.at(-1)!;
    expect(draw.lod).toBe(true);
    const drawn = instances[0]!;
    const lod = drawn.lod!;
    expect(lod.meshes[0]).toBe(drawn.mesh);
    // The live copy, not the bind pose: a level shares the positions the skinning rewrites.
    expect(drawn.mesh.primitives[0]!.positions).not.toBe(scene.instances[0]!.mesh.primitives[0]!.positions);
    for (const level of lod.meshes.slice(1)) {
      level.primitives.forEach((p, k) => expect(p.positions).toBe(drawn.mesh.primitives[k]!.positions));
    }
    expect(lod.meshes[2]!.primitives.reduce((n, p) => n + p.indices.length, 0)).toBeLessThan(drawn.mesh.primitives.reduce((n, p) => n + p.indices.length, 0));
  });

  it("tints each level as it tints the object", async () => {
    const scene = parseMeshScene(soldierScene())!;
    const seen: (readonly MeshSceneInstance[])[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances) => void seen.push(instances), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    surface.setPoseOverrides([{ index: 0, hidden: false, position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, tint: 2 }]);
    surface.blit(new Uint8Array(16 * 16 * 4));
    const drawn = seen.at(-1)![0]!;
    const paint = (m: MeshAsset) => m.primitives.find((p) => p.material.tintable)!.material.baseColorFactor;
    expect(drawn.lod!.meshes[0]).toBe(drawn.mesh);
    for (const level of drawn.lod!.meshes) expect(paint(level)).toEqual(paint(drawn.mesh));
  });
});

describe("Lockout", () => {
  it("ships LODs for its soldiers (stored once for all seven) and its dropped weapons", () => {
    const raw = lockoutMeshSidecar();
    const stored = JSON.parse(raw);
    const bots = stored.meshes.filter((m: { id: string }) => m.id.startsWith("bot-"));
    expect(bots).toHaveLength(7);
    expect(new Set(bots.map((b: { lods: { levels: string[] } }) => b.lods.levels.join("|"))).size).toBe(1);
    expect(bots[0].lods.levels[0]).toMatch(/^@lib:/);
    const scene = parseMeshScene(raw)!;
    const soldier = scene.instances[1]!;
    expect(soldier.lod!.meshes).toHaveLength(3);
    const counts = soldier.lod!.meshes.map(triangleCountOf);
    expect(counts[2]!).toBeLessThan(counts[0]! * 0.7);
    // Each dropped weapon falls back to lighter levels far off.
    const drops = scene.debris!.map((d, i) => [d.name, scene.debrisLods?.[i]] as const).filter(([name]) => name.startsWith("drop_"));
    expect(drops.length).toBeGreaterThan(0);
    for (const [, lod] of drops) expect(lod!.meshes.length).toBeGreaterThan(1);
  });

  it("stores levels that still fit the soldier after its round trip through storage", () => {
    const stored = JSON.parse(lockoutMeshSidecar());
    const mesh = deserializeMeshAsset(resolveMeshRef(stored.meshes[1].mesh, stored.library)!);
    expect(encodeLods(mesh, generateLods(mesh)!).base).toBe(stored.meshes[1].lods.base);
    // And a reserialised soldier is byte-identical, so the fingerprint is stable.
    expect(serializeMeshAsset(mesh)).toBe(resolveMeshRef(stored.meshes[1].mesh, stored.library));
  });
});
