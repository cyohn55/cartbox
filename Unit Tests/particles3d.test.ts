/**
 * 3D particles (HALO2_STYLE_ROADMAP.md, H5): effects on the sidecar, the
 * simulation and its billboards, cartbox.burst through the runtime block (in
 * the real engine), the overlay drawing them with the scene, the editor's
 * sidecar round trip, and Lockout's effects.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_EFFECTS,
  MAX_PARTICLE_EFFECTS,
  PARTICLE_FRAMES,
  PARTICLE_PRESETS,
  ParticleSystem,
  composeModelMatrix,
  lockoutMeshSidecar,
  parseParticleEffects,
  particleAtlas,
  particlePreset,
  projectionMatrix,
  renderMeshScene,
  serializeMeshAsset,
  viewMatrix,
  type MeshAsset,
} from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneNeedsRuntime,
  sceneObjectsSdkLua,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshEffects } from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null } }],
  };
}

function sidecar(effects: unknown = [particlePreset("sparks", "spark"), particlePreset("trail", "slash")]) {
  return JSON.stringify({
    version: 2,
    meshes: [{ id: "box", name: "box", mesh: serializeMeshAsset(cube()), transform: { position: [0, 0, -3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    effects,
  });
}

describe("effect model", () => {
  it("has a preset for each kind, and reads stored effects defensively", () => {
    for (const p of PARTICLE_PRESETS) expect(particlePreset(p).name).toBe(p);
    const [a, b] = parseParticleEffects([
      { name: "boom", count: 9999, life: -1, color: [2, 0.5, 0.5], shape: "trail" },
      { name: "boom" },
      "junk",
    ]);
    expect(a).toMatchObject({ name: "boom", count: 128, life: 0.02, color: [1, 0.5, 0.5], shape: "trail" });
    expect(b!.name).toBe("boom_"); // names stay unique
    expect(parseParticleEffects(Array.from({ length: 40 }, () => ({})))).toHaveLength(MAX_PARTICLE_EFFECTS);
    expect(parseParticleEffects(null)).toEqual([]);
  });

  it("bakes an atlas of round frames across the effect's life, thinning as it dies", () => {
    const atlas = particleAtlas(particlePreset("sparks"));
    expect(atlas.width).toBe(PARTICLE_FRAMES * atlas.height);
    const opaque = (frame: number) => {
      let n = 0;
      for (let y = 0; y < atlas.height; y += 1)
        for (let x = 0; x < atlas.height; x += 1) if (atlas.data[(y * atlas.width + frame * atlas.height + x) * 4 + 3] === 255) n += 1;
      return n;
    };
    expect(opaque(0)).toBeGreaterThan(opaque(PARTICLE_FRAMES - 1) * 2);
    expect(atlas.data[3]).toBe(0); // the corner is outside the disc
  });
});

describe("particle system", () => {
  it("bursts, moves under gravity and drag, and lets the dead go", () => {
    const sys = new ParticleSystem([particlePreset("sparks")]);
    expect(sys.instanceFor([0, 0, -1])).toBeNull();
    sys.burst(0, [0, 1, 0], [0, 1, 0]);
    expect(sys.alive).toBe(14);
    sys.step(0.1);
    expect(sys.alive).toBe(14);
    for (let i = 0; i < 60; i += 1) sys.step(1 / 60);
    expect(sys.alive).toBe(0); // sparks live ~0.35 s
  });

  it("recycles the oldest when a burst overfills the pool, and scales count", () => {
    const sys = new ParticleSystem([{ ...particlePreset("smoke"), count: 10 }]);
    for (let i = 0; i < 20; i += 1) sys.burst(0, [0, 0, 0]);
    expect(sys.alive).toBe(60); // capacity = count × 6
    const scaled = new ParticleSystem([{ ...particlePreset("smoke"), count: 10 }]);
    scaled.burst(0, [0, 0, 0], [0, 1, 0], 2);
    expect(scaled.alive).toBe(20);
    scaled.burst(-1, [0, 0, 0]); // no such effect: nothing
    expect(scaled.alive).toBe(20);
  });

  it("lays a trail along its segment", () => {
    const sys = new ParticleSystem([{ ...particlePreset("trail"), speed: 0 }]);
    sys.burst(0, [0, 0, 0], [10, 0, 0]);
    const inst = sys.instanceFor([0, 0, -1])!;
    const xs = Array.from(inst.mesh.primitives[0]!.positions).filter((_, i) => i % 3 === 0);
    expect(Math.max(...xs)).toBeGreaterThan(6);
    expect(Math.min(...xs)).toBeLessThan(4);
  });

  it("writes camera-facing billboards the rasteriser draws, glowing ones emissive", () => {
    const sys = new ParticleSystem([{ ...particlePreset("plasma"), count: 40, size: 0.6, sizeEnd: 0.6, speed: 0.2 }]);
    sys.burst(0, [0, 0, 0]);
    const inst = sys.instanceFor([0, 0, -1])!;
    const prim = inst.mesh.primitives[0]!;
    expect(prim.dynamic!.revision).toBe(1);
    expect(prim.material.emissiveFactor![0]).toBeGreaterThan(1);
    // Every live quad faces the camera (normal = −forward).
    expect(Array.from(prim.normals!.subarray(0, 3))).toEqual([-0, -0, 1]);
    const out = new Uint8ClampedArray(32 * 32 * 4);
    renderMeshScene([inst], {
      width: 32,
      height: 32,
      out,
      depth: new Float32Array(32 * 32),
      view: viewMatrix([0, 0, 3], [0, 0, 0]),
      projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50),
      background: [0, 0, 0, 255],
    });
    let lit = 0;
    for (let i = 0; i < out.length; i += 4) if (out[i + 2]! > 100) lit += 1;
    expect(lit).toBeGreaterThan(10);
  });

  it("is deterministic for a seed", () => {
    const run = () => {
      const sys = new ParticleSystem([particlePreset("explosion")], 42);
      sys.burst(0, [0, 0, 0]);
      sys.step(0.1);
      return Array.from(sys.instanceFor([0, 0, -1])!.mesh.primitives[0]!.positions.subarray(0, 60));
    };
    expect(run()).toEqual(run());
  });
});

describe("runtime", () => {
  it("gives a scene with effects the runtime block and cartbox.burst", () => {
    const sc = parseMeshScene(sidecar())!;
    expect(sc.effects?.map((e) => e.name)).toEqual(["spark", "slash"]);
    expect(sceneNeedsRuntime(sc, { physics: false })).toBe(true);
    expect(runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false })).toContain("cartbox.burst");
    const plain = parseMeshScene(sidecar([]))!;
    expect(plain.effects).toBeUndefined();
    expect(sceneNeedsRuntime(plain, { physics: false })).toBe(false);
  });

  it("the overlay simulates bursts and draws them with the scene", async () => {
    const draws: { instances: number; particles: boolean }[] = [];
    const renderer: SceneRenderer = {
      backend: "software",
      render: (instances, _draw: SceneDraw) => void draws.push({ instances: instances.length, particles: instances.some((i) => i.mesh.name === "particles") }),
      dispose: () => {},
    };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, parseMeshScene(sidecar())!, renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(draws.at(-1)!.particles).toBe(false);
    surface.burst(0, [0, 0, 0], [0, 1, 0], 1);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(draws.at(-1)!.particles).toBe(true);
    for (let i = 0; i < 60; i += 1) surface.blit(new Uint8Array(16 * 16 * 4));
    expect(draws.at(-1)!.particles).toBe(false); // burnt out
  });
});

describe.skipIf(!existsSync(ENGINE))("cartbox.burst from Lua (real engine)", () => {
  it("queues bursts with their effect, place, direction and scale", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.burst("spark", 1, 2, 3, 0, 1, 0) end
  if t == 3 then cartbox.burst(2, -1, 0, 0, 4, 0, 0, 2) cartbox.burst("nope", 0, 0, 0) end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false }));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const seen: ReturnType<RuntimeChannel["takeBursts"]>[] = [];
    for (let i = 1; i <= 4; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push(channel.takeBursts());
    }
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toHaveLength(1);
    expect(seen[1]![0]!.effect).toBe(0);
    expect(seen[1]![0]!.at.map((v) => +v.toFixed(3))).toEqual([1, 2, 3]);
    expect(seen[1]![0]!.dir.map((v) => +v.toFixed(3))).toEqual([0, 1, 0]);
    expect(seen[1]![0]!.scale).toBe(1);
    expect(seen[2]).toHaveLength(1); // the unknown name fires nothing
    expect(seen[2]![0]).toMatchObject({ effect: 1, scale: 2 });
    channel.destroy();
  });
});

describe("editor sidecar", () => {
  it("stores effects and cleans them on the way in", () => {
    let sc = addMesh(emptyMeshSidecar(), cube(), "box").sidecar;
    sc = setMeshEffects(sc, [particlePreset("sparks", "a"), { ...particlePreset("smoke", "a"), count: 999 }]);
    expect(sc.effects!.map((e) => e.name)).toEqual(["a", "a_"]);
    expect(sc.effects![1]!.count).toBe(128);
    const back = decodeMeshSidecar(encodeMeshSidecar(sc)!);
    expect(back.effects).toEqual(sc.effects);
    expect("effects" in setMeshEffects(sc, [])).toBe(false);
  });
});

describe("Lockout", () => {
  it("ships its effects and fires them from the cart", () => {
    const names = LOCKOUT_EFFECTS.map((e) => e.name);
    // The plasma grenade's burst joined them (I10).
    expect(names).toEqual(["spark", "shield", "blast", "smoke", "slash", "drift", "plasmablast"]);
    expect(parseMeshScene(lockoutMeshSidecar())!.effects!.map((e) => e.name)).toEqual(names);
    for (const n of names) expect(LOCKOUT_CODE).toContain(`"${n}"`);
    expect(LOCKOUT_CODE).toContain("cartbox.burst(");
    expect(LOCKOUT_EFFECTS.find((e) => e.name === "slash")!.shape).toBe("trail");
  });
});

// Keep the identity helper referenced (used implicitly through the scene's transforms).
void composeModelMatrix;
