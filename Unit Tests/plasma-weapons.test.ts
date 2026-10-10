/**
 * Plasma weapons (HALO_INFINITE_STYLE_ROADMAP.md I10): swing trails (a ribbon
 * a mesh's segment sweeps), the plasma material, and Lockout's plasma sword
 * and plasma grenade.
 */

import { describe, expect, it } from "vitest";
import {
  LOCKOUT_CODE,
  LOCKOUT_EFFECTS,
  PLASMA_BLADE,
  TrailSystem,
  defaultSceneLighting,
  deserializeMeshAsset,
  lockoutMeshSidecar,
  plasmaMaterial,
  projectionMatrix,
  readMeshLibrary,
  readMeshTrails,
  renderMeshScene,
  resolveMeshRef,
  serializeMeshAsset,
  trailFade,
  trailStrength,
  viewMatrix,
  type MeshAsset,
  type MeshTrail,
} from "@cartbox/editor";
import { MeshOverlaySurface, parseMeshScene, type SceneDraw, type SceneRenderer } from "@cartbox/player";

const at = (x: number, y = 0, z = 0) => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const TRAIL: MeshTrail = { from: [0, 0, 0], to: [0, 1, 0], life: 0.2, color: [0.3, 0.6, 1], intensity: 2, minSpeed: 1 };

describe("stored trails", () => {
  it("are read clamped, malformed ones dropped, a joint kept only when the skeleton has it", () => {
    const read = readMeshTrails([{ ...TRAIL, life: 9, color: [2, -1, 0.5], joint: 1 }, { from: [0, 0], to: [0, 1, 0], life: 1 }, { ...TRAIL, joint: 5 }], 2);
    expect(read).toHaveLength(2);
    expect(read[0]).toMatchObject({ life: 2, color: [1, 0, 0.5], joint: 1 });
    expect(read[1]!.joint).toBeUndefined();
    expect(readMeshTrails("nope")).toEqual([]);
  });

  it("survive a save and load on their mesh", () => {
    const mesh: MeshAsset = {
      name: "m",
      primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
      trails: [TRAIL],
    };
    expect(deserializeMeshAsset(serializeMeshAsset(mesh)).trails).toEqual([TRAIL]);
  });
});

describe("a trail", () => {
  it("lights only above its speed, fully at twice it, and fades with age toward its `from` end", () => {
    expect(trailStrength(0.5, 1)).toBe(0);
    expect(trailStrength(1.5, 1)).toBeCloseTo(0.5, 9);
    expect(trailStrength(5, 1)).toBe(1);
    expect(trailStrength(0, 0)).toBe(1);
    expect(trailFade(0, 1)).toBe(1);
    expect(trailFade(0.5, 1)).toBeLessThan(trailFade(0, 1));
    expect(trailFade(0, 0)).toBeLessThan(trailFade(0, 1));
    expect(trailFade(1, 1)).toBe(0);
  });

  it("leaves nothing held still, a ribbon swung, and nothing once it has faded", () => {
    const trails = new TrailSystem();
    for (let f = 0; f < 10; f += 1) trails.record(0, [TRAIL], at(0), null, f / 60, false);
    expect(trails.instances(10 / 60).main).toBeNull();
    for (let f = 10; f < 20; f += 1) trails.record(0, [TRAIL], at((f - 10) * 0.1), null, f / 60, false); // 6 units/s
    const ribbon = trails.instances(19 / 60).main!;
    expect(ribbon.mesh.primitives).toHaveLength(1);
    expect(ribbon.mesh.primitives[0]!.material.alphaMode).toBe("additive");
    // It reaches up the swept segment: the newest stretch spans from y 0 to y 1.
    const ys = ribbon.mesh.primitives[0]!.positions.filter((_, i) => i % 3 === 1);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
    expect(trails.instances(2).main).toBeNull();
  });

  it("stops where an object leaves sight", () => {
    const trails = new TrailSystem();
    trails.record(0, [TRAIL], at(0), null, 0, false);
    trails.cut(0);
    trails.record(0, [TRAIL], at(5), null, 1 / 60, false); // no speed across the cut: nothing swept
    expect(trails.instances(1 / 60).main).toBeNull();
  });

  it("on the front layer, is kept in the camera's space: carried along, it sweeps nothing; swung, it does", () => {
    const trails = new TrailSystem();
    // The camera and the held object move together along X.
    for (let f = 0; f < 10; f += 1) {
      const view = viewMatrix([f * 0.2, 0, -2], [f * 0.2, 0, 0]);
      trails.record(0, [TRAIL], at(f * 0.2), null, f / 60, true, view);
    }
    const still = viewMatrix([1.8, 0, -2], [1.8, 0, 0]);
    expect(trails.instances(9 / 60, still).front).toBeNull();
    for (let f = 10; f < 16; f += 1) trails.record(0, [TRAIL], at(1.8 + (f - 9) * 0.1), null, f / 60, true, still);
    const r = trails.instances(15 / 60, still);
    expect(r.main).toBeNull();
    expect(r.front).not.toBeNull();
  });
});

describe("plasma", () => {
  it("glows white-hot face on, cools to blue and thins toward its silhouette", () => {
    // A sphere of plasma over a red backdrop, seen from the front.
    const rings = 16, segs = 24, positions: number[] = [], normals: number[] = [], indices: number[] = [];
    for (let i = 0; i <= rings; i += 1) {
      for (let j = 0; j <= segs; j += 1) {
        const th = (i / rings) * Math.PI, ph = (j / segs) * Math.PI * 2;
        const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
        positions.push(...n);
        normals.push(...n);
      }
    }
    for (let i = 0; i < rings; i += 1) for (let j = 0; j < segs; j += 1) {
      const a = i * (segs + 1) + j, b = a + segs + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const mesh: MeshAsset = { name: "orb", primitives: [{ positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: null, indices: Uint32Array.from(indices), material: plasmaMaterial("plasma", { ...PLASMA_BLADE, boil: 0 }) }] };
    const W = 96, H = 96;
    const render = (background: [number, number, number, number]) => {
      const out = new Uint8ClampedArray(W * H * 4);
      renderMeshScene([{ mesh, model: at(0) }], { width: W, height: H, out, depth: new Float32Array(W * H), view: viewMatrix([0, 0, -3.2], [0, 0, 0]), projection: projectionMatrix(0.8, 1, 0.1, 10), background, tonemap: { exposure: 1 } });
      return (x: number) => Array.from(out.subarray((48 * W + x) * 4, (48 * W + x) * 4 + 3));
    };
    const onBlack = render([0, 0, 0, 255]);
    const onRed = render([200, 0, 0, 255]);
    // The silhouette along the row through the centre: the last pixel the orb covers.
    let edge = 48;
    while (edge < W - 1 && onBlack(edge + 1).some((v) => v > 0)) edge += 1;
    const centre = onBlack(48);
    expect(Math.min(...centre)).toBeGreaterThan(200); // near white
    expect(onBlack(edge)[2]! - onBlack(edge)[0]!).toBeGreaterThan(30); // blue at the edge
    // What's behind shows through the edge far more than the heart.
    const through = (x: number) => onRed(x)[0]! - onBlack(x)[0]!;
    expect(through(edge)).toBeGreaterThan(through(48) + 30);
  });
});

describe("Lockout", () => {
  const sidecar = JSON.parse(lockoutMeshSidecar());
  const library = readMeshLibrary(sidecar.library);
  const sword = deserializeMeshAsset(resolveMeshRef(sidecar.meshes.find((m: { id: string }) => m.id === "viewmodel-sword").mesh, library)!);

  it("has a plasma sword that leaves an arc of light from emitter to tips as it swings", () => {
    const blade = sword.primitives.find((p) => p.material.name === "plasma")!;
    expect(blade.material.alphaMode).toBe("blend");
    expect(blade.material.graph?.outputs.alpha).toBeDefined();
    expect(sword.trails).toHaveLength(1);
    expect(sword.trails![0]!.joint).toBe(1); // the weapon bone: it follows every clip
    expect(sword.trails![0]!.minSpeed).toBeGreaterThan(0.5); // a sway leaves nothing
  });

  it("throws plasma grenades: four in reserve, glowing, trailing, sticking, lighting their way, going off in plasma", () => {
    const prefab = sidecar.prefabs.find((p: { name: string }) => p.name === "plasma grenade");
    expect(prefab.pool).toBe(4);
    const nade = deserializeMeshAsset(prefab.nodes[0].mesh);
    expect(nade.primitives.some((p) => p.material.name === "plasma" && p.material.graph)).toBe(true);
    expect(nade.trails).toHaveLength(1);
    expect(LOCKOUT_EFFECTS.some((e) => e.name === "plasmablast")).toBe(true);
    for (const call of ['cartbox.spawn("plasma grenade"', "cartbox.place(g.obj", "cartbox.despawn(g.obj)", "g.stuck = o", 'cartbox.burst("plasmablast"', "cartbox.light3d(g.x, g.y, g.z"]) {
      expect(LOCKOUT_CODE, call).toContain(call);
    }
  });
});

describe("the player", () => {
  it("draws a moving object's trail, and on its layer", async () => {
    const mesh: MeshAsset = {
      name: "blade",
      primitives: [{ positions: Float32Array.from([0, 0, 0, 0.1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }],
      trails: [TRAIL],
    };
    const text = JSON.stringify({ version: 2, lighting: defaultSceneLighting(), meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(mesh), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] });
    const drawn: string[][] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances.map((i) => i.mesh.name)), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 32, 24, parseMeshScene(text)!, renderer);
    for (let f = 0; f < 8; f += 1) {
      surface.setPoseOverrides([{ index: 0, hidden: false, position: [f * 0.15, 0, 0], rotation: [0, 0, 0], scale: 1 }]);
      surface.blit(new Uint8Array(32 * 24 * 4));
    }
    expect(drawn[0]).not.toContain("trails"); // nothing swept yet
    expect(drawn.at(-1)).toContain("trails");
  });
});
