/**
 * Distant vistas (HALO_INFINITE_STYLE_ROADMAP.md I7): far terrain drawn once
 * into the sky panorama — the stored flag, the haze, the bake itself, the
 * scene loader routing vistas (and the foliage on them) out of the instances,
 * the player drawing them into its sky, and Lockout's far range.
 */

import { describe, expect, it } from "vitest";
import {
  LOCKOUT_VISTA_FOREST,
  MAX_VISTA_HAZE,
  VISTA_HAZE_DISTANCE,
  bakeVistas,
  defaultSceneLighting,
  lockoutMeshSidecar,
  lockoutVista,
  newTerrain,
  readTerrain,
  serializeFoliage,
  serializeMeshAsset,
  serializeTerrain,
  terrainHole,
  vistaBounds,
  vistaHaze,
  type DecodedTexture,
  type MeshAsset,
  type MeshSceneInstance,
  type Terrain,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene } from "@cartbox/player";

const identity = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** A flat-coloured upright square facing the origin, `distance` out along +X, `half` units each way. */
function wall(distance: number, half: number, color: [number, number, number]): MeshSceneInstance {
  const mesh: MeshAsset = {
    name: "wall",
    primitives: [
      {
        positions: Float32Array.from([distance, -half, -half, distance, -half, half, distance, half, half, distance, half, -half]),
        normals: Float32Array.from([-1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2]),
        material: { name: "m", baseColorFactor: [...color, 1], baseColorImage: null },
      },
    ],
  };
  return { mesh, model: identity };
}

/** A plain grey-blue sky panorama. */
function sky(w = 128, h = 64): DecodedTexture {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i += 1) data.set([120, 150, 200, 255], i * 4);
  return { width: w, height: h, data };
}

/** The panorama texel looking along (dx, dy, dz) — the sky bake's mapping. */
function texel(map: DecodedTexture, dx: number, dy: number, dz: number): number[] {
  const len = Math.hypot(dx, dy, dz);
  const u = Math.atan2(dz / len, dx / len) / (2 * Math.PI) + 0.5;
  const v = Math.acos(dy / len) / Math.PI;
  const x = Math.min(map.width - 1, Math.floor(u * map.width));
  const y = Math.min(map.height - 1, Math.floor(v * map.height));
  const o = (y * map.width + x) * 4;
  return Array.from(map.data.subarray(o, o + 3));
}

describe("haze", () => {
  it("is none at the eye, the stored share at a kilometre, and grows with distance short of all", () => {
    expect(vistaHaze(0.4, 0)).toBe(0);
    expect(vistaHaze(0.4, VISTA_HAZE_DISTANCE)).toBeCloseTo(0.4, 9);
    expect(vistaHaze(0.4, 2000)).toBeGreaterThan(vistaHaze(0.4, 1000));
    expect(vistaHaze(5, VISTA_HAZE_DISTANCE)).toBeCloseTo(MAX_VISTA_HAZE, 9);
    expect(vistaHaze(0, 5000)).toBe(0);
  });
});

describe("stored vistas", () => {
  it("survive a save and load, clamped, and stay absent when unset", () => {
    const t = newTerrain("far", { size: 64, samples: 5 });
    expect(readTerrain(serializeTerrain(t))!.vista).toBeUndefined();
    expect(readTerrain(serializeTerrain({ ...t, vista: { haze: 0.3 } }))!.vista).toEqual({ haze: 0.3 });
    expect(readTerrain({ ...serializeTerrain(t), vista: { haze: 9 } })!.vista).toEqual({ haze: MAX_VISTA_HAZE });
    expect(readTerrain({ ...serializeTerrain(t), vista: {} })!.vista).toEqual({ haze: 0 });
  });
});

describe("the bake", () => {
  const map = sky();

  it("hands back the sky itself with nothing to draw", () => {
    expect(bakeVistas(map, [], [0, 0, 0])).toBe(map);
    expect(bakeVistas(map, [{ haze: 0.5, instances: [] }], [0, 0, 0])).toBe(map);
  });

  it("draws a vista where it stands and leaves the rest of the sky (and the sky passed in) alone", () => {
    const before = Array.from(map.data);
    const baked = bakeVistas(map, [{ haze: 0, instances: [wall(500, 200, [1, 0.1, 0.1])] }], [0, 0, 0]);
    expect(Array.from(map.data)).toEqual(before);
    const ahead = texel(baked, 1, 0, 0);
    expect(ahead[0]!).toBeGreaterThan(ahead[2]! + 40); // the red wall
    expect(texel(baked, -1, 0, 0)).toEqual([120, 150, 200]); // behind: sky
    expect(texel(baked, 0, 1, 0)).toEqual([120, 150, 200]); // overhead: sky
    expect(texel(baked, 1, 0, 1)).toEqual([120, 150, 200]); // 45° aside: past the wall's edge
  });

  it("softens its outline: texels on the edge mix the vista with the sky", () => {
    const baked = bakeVistas(map, [{ haze: 0, instances: [wall(500, 200, [1, 0.1, 0.1])] }], [0, 0, 0]);
    let partial = 0;
    for (let i = 0; i < baked.width * baked.height; i += 1) {
      const r = baked.data[i * 4]!;
      if (r > 125 && r < 200 && baked.data[i * 4 + 2]! < 195) partial += 1;
    }
    expect(partial).toBeGreaterThan(0);
  });

  it("fades into the sky with haze, more the farther it stands", () => {
    const at = (distance: number, haze: number) => texel(bakeVistas(map, [{ haze, instances: [wall(distance, distance * 0.4, [1, 0.1, 0.1])] }], [0, 0, 0]), 1, 0, 0);
    const clear = at(1000, 0);
    const hazy = at(1000, 0.6);
    const farther = at(3000, 0.6);
    // Toward the sky's blue: less red, more blue, step by step.
    expect(hazy[0]!).toBeLessThan(clear[0]!);
    expect(hazy[2]!).toBeGreaterThan(clear[2]!);
    expect(farther[2]!).toBeGreaterThan(hazy[2]!);
    // At a kilometre, 60% of the way to the sky.
    expect(hazy[2]!).toBeCloseTo(clear[2]! + (200 - clear[2]!) * 0.6, -1);
  });

  it("hazes toward the air it is given, not what stands in the sky behind", () => {
    // A green ring painted in the sky behind the wall; the air is the plain sky.
    const ringed = sky();
    for (let i = 0; i < ringed.width * ringed.height; i += 1) ringed.data.set([0, 255, 0, 255], i * 4);
    const instances = [wall(1000, 400, [1, 0.1, 0.1])];
    const throughRing = texel(bakeVistas(ringed, [{ haze: 0.6, instances }], [0, 0, 0]), 1, 0, 0);
    const throughAir = texel(bakeVistas(ringed, [{ haze: 0.6, instances }], [0, 0, 0], {}, undefined, sky(32, 16)), 1, 0, 0);
    expect(throughRing[1]!).toBeGreaterThan(150);
    expect(throughAir).toEqual(texel(bakeVistas(map, [{ haze: 0.6, instances }], [0, 0, 0]), 1, 0, 0));
  });

  it("shows the nearer of two overlapping vistas", () => {
    const near = { haze: 0, instances: [wall(400, 160, [0.1, 1, 0.1])] };
    const far = { haze: 0, instances: [wall(900, 400, [1, 0.1, 0.1])] };
    for (const order of [[near, far], [far, near]]) {
      const [r, g] = texel(bakeVistas(map, order, [0, 0, 0]), 1, 0, 0);
      expect(g!).toBeGreaterThan(r! + 40);
    }
  });

  it("sees from the eye it is given", () => {
    // From 600 units along +X the wall at 500 lies behind (−X), not ahead.
    const baked = bakeVistas(map, [{ haze: 0, instances: [wall(500, 200, [1, 0.1, 0.1])] }], [600, 0, 0]);
    expect(texel(baked, 1, 0, 0)).toEqual([120, 150, 200]);
    const behind = texel(baked, -1, 0, 0);
    expect(behind[0]!).toBeGreaterThan(behind[2]! + 40);
  });

  it("bounds every vista's geometry", () => {
    const b = vistaBounds([{ haze: 0, instances: [wall(500, 200, [1, 1, 1])] }, { haze: 0, instances: [wall(-300, 100, [1, 1, 1])] }])!;
    expect(b.center[0]).toBeCloseTo(100, 6);
    expect(b.radius).toBeGreaterThan(400);
    expect(vistaBounds([])).toBeNull();
  });
});

/** A sidecar with a near terrain and a vista with pines on it. */
function sidecar(vista: Terrain["vista"] | undefined, extra: Record<string, unknown> = {}): string {
  const near = newTerrain("near", { size: 32, samples: 9 });
  const far = { ...newTerrain("far", { size: 2000, samples: 17, name: "Far" }), ...(vista ? { vista } : {}) };
  const pine: MeshAsset = wall(1, 1, [0.1, 0.3, 0.1]).mesh;
  return JSON.stringify({
    version: 2,
    meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(wall(1, 1, [1, 1, 1]).mesh), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    terrains: [serializeTerrain(near), serializeTerrain(far)],
    foliage: [serializeFoliage(far, { id: "pines", name: "Pines", terrain: "far", density: 0.05, scale: [1, 1], align: 0, sink: 0, cull: 3000, copies: [], fill: { seed: 3, clear: [1000, 1000, 200] } }, serializeMeshAsset(pine))],
    ...extra,
  });
}

describe("the scene loader", () => {
  it("keeps a vista (and its foliage) out of the instances and the gameplay terrains", () => {
    const scene = parseMeshScene(sidecar({ haze: 0.3 }))!;
    expect(scene.terrains!.map((t) => t.id)).toEqual(["near"]);
    expect(scene.instances.some((i) => i.id.startsWith("terrain:far") || i.id.startsWith("foliage:pines"))).toBe(false);
    expect(scene.vistas).toHaveLength(1);
    const [v] = scene.vistas!;
    expect(v!.id).toBe("far");
    expect(v!.haze).toBe(0.3);
    // The ground in blocks, plus the pines' blocks.
    const ground = v!.parts.filter((p) => p.mesh.primitives.some((q) => q.material.name !== "m"));
    expect(ground.length).toBeGreaterThan(0);
    expect(v!.parts.length).toBeGreaterThan(ground.length);
  });

  it("draws a terrain that isn't a vista as before", () => {
    const scene = parseMeshScene(sidecar(undefined))!;
    expect(scene.vistas).toBeUndefined();
    expect(scene.terrains!.map((t) => t.id)).toEqual(["near", "far"]);
    expect(scene.instances.some((i) => i.id.startsWith("terrain:far"))).toBe(true);
  });
});

describe("the player", () => {
  const skyMap = (s: MeshOverlaySurface): DecodedTexture => (s as unknown as { skyMap: DecodedTexture }).skyMap;
  const lit = { lighting: { ...defaultSceneLighting(), sky: { sunDirection: [0.3, 0.8, 0.2] } } };
  const make = (text: string) => MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, parseMeshScene(text)!);

  it("draws the vistas into its sky, and re-draws them when they change", async () => {
    const plain = await make(sidecar(undefined, lit));
    const surface = await make(sidecar({ haze: 0 }, lit));
    const before = skyMap(plain).data;
    const withVista = skyMap(surface).data;
    let changed = 0;
    for (let i = 0; i < before.length; i += 4) if (before[i] !== withVista[i] || before[i + 1] !== withVista[i + 1]) changed += 1;
    expect(changed).toBeGreaterThan(100);
    // Hazier: the same vista, nearer the sky.
    expect(await surface.applySceneEdits(parseMeshScene(sidecar({ haze: 0.9 }, lit))!)).toBe(true);
    expect(skyMap(surface).data).not.toEqual(withVista);
  });
});

describe("Lockout", () => {
  it("rings the gorge with a far range drawn into the sky, its middle cut away", () => {
    const t = lockoutVista();
    expect(t.vista!.haze).toBeGreaterThan(0);
    expect(t.size[0]).toBeGreaterThan(2000);
    // The cell under the arena is cut; one far out is not.
    const mid = (t.samples - 1) / 2;
    expect(terrainHole(t, mid, mid)).toBe(true);
    expect(terrainHole(t, 2, 2)).toBe(false);
    expect(t.layers.map((l) => l.material.name)).toEqual(["vista-snow", "vista-forest", "vista-rock"]);
    expect(LOCKOUT_VISTA_FOREST.terrain).toBe(t.id);
  });

  it("loads it as a vista with its forest, apart from the near mountains", () => {
    const scene = parseMeshScene(lockoutMeshSidecar())!;
    expect(scene.terrains!.map((x) => x.id)).toEqual(["lockout-range"]);
    const [v] = scene.vistas!;
    expect(v!.id).toBe("lockout-vista");
    const pines = v!.parts.filter((p) => p.mesh.primitives.some((q) => q.material.name === "needles"));
    expect(pines.length).toBeGreaterThan(10);
  });
});
