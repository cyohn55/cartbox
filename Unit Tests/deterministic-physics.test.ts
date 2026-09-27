/**
 * Deterministic physics (ENGINE_ROADMAP.md, Phase 2): a scene set to it runs on
 * Rapier's cross-platform deterministic build, and every number the host computes
 * reaches the engine rounded onto a fixed grid — so browsers whose Math.sin / cos
 * / hypot differ in the last bits still simulate bit-identical worlds. Checked by
 * nudging every input the way two browsers might and comparing the state digest
 * tick by tick; plus the setting's round trip and the digest reaching Lua.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-deterministic-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { readPhysicsWorld, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  PhysicsSession,
  RAM_LAYOUTS,
  codeChunks,
  deterministicBackend,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  physicsSdkLua,
  physicsStateHash,
  sceneObjectsSdkLua,
  type MeshScene,
  type PhysicsBackend,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshPhysicsWorld } from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): string {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const mesh: MeshAsset = {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: Float32Array.from(p.map((v) => v * 2)),
        uvs: null,
        indices: Uint32Array.from(idx),
        material: { name: "m", baseColorFactor: [0.6, 0.6, 0.6, 1], baseColorImage: null },
      },
    ],
  };
  return serializeMeshAsset(mesh);
}

/** A floor, a leaning tower of ten turned crates, and a ball to knock it over: chaotic on purpose. */
function towerJson(deterministic: boolean): string {
  const mesh = cube();
  const meshes: object[] = [
    { id: "floor", name: "floor", mesh, transform: { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [30, 1, 30] }, physics: { body: "static", shape: "box" } },
    {
      id: "ball", name: "ball", mesh, transform: { position: [-6, 1.3, 0.1], rotation: [0, 0, 0], scale: [0.8, 0.8, 0.8] },
      physics: { body: "dynamic", shape: "sphere", mass: 4 },
    },
  ];
  for (let i = 0; i < 10; i += 1) {
    meshes.push({
      id: `crate${i}`,
      name: `crate${i}`,
      mesh,
      transform: { position: [0.03 * i, 0.5 + i * 1.001, -0.02 * i], rotation: [1.7 * i, 13 * i, 0.9 * i], scale: [1, 1, 1] },
      physics: { body: "dynamic", shape: "box", mass: 1, bounce: 0.1 },
    });
  }
  return JSON.stringify({ version: 2, meshes, ...(deterministic ? { physicsWorld: { deterministic: true } } : {}) });
}

/**
 * The same scene as another browser might compute it: every matrix entry off by up
 * to 3 × `ulps` × machine epsilon (relative).
 */
function nudged(scene: MeshScene, ulps = 1): MeshScene {
  let n = 0;
  return {
    ...scene,
    instances: scene.instances.map((inst) => ({
      ...inst,
      model: inst.model.map((v) => {
        n += 1;
        return v * (1 + ((n % 7) - 3) * Number.EPSILON * ulps);
      }) as typeof inst.model,
    })),
  };
}

/** Run a scene for `ticks`, knocking the ball into the tower; the state digest after every step. */
function digests(scene: MeshScene, deterministic: boolean, ticks = 300): number[] {
  const session = new PhysicsSession(scene, createRapierBackend(RAPIER), { deterministic });
  const out: number[] = [];
  for (let t = 0; t < ticks; t += 1) {
    session.run(t === 20 ? [{ op: 1, a: 1, v: [60, 3, 0.75, 0, 0, 0] }] : []);
    out.push(session.hash());
  }
  session.destroy();
  return out;
}

describe("deterministic physics setting", () => {
  it("round-trips through the sidecar and reaches the runtime scene", () => {
    expect(readPhysicsWorld({ deterministic: "yes" })).toBeNull();
    const raw = towerJson(false);
    const on = setMeshPhysicsWorld(decodeMeshSidecar(raw), { deterministic: true });
    const encoded = encodeMeshSidecar(on)!;
    expect(decodeMeshSidecar(encoded).physicsWorld).toEqual({ deterministic: true });
    expect(parseMeshScene(encoded)!.physicsWorld).toEqual({ deterministic: true });
    // Off stores nothing, and a scene without it isn't deterministic.
    expect(encodeMeshSidecar(setMeshPhysicsWorld(on, null))).not.toContain("physicsWorld");
    expect(parseMeshScene(raw)!.physicsWorld).toBeUndefined();
  });

  it("rounds what reaches the engine, so last-bit differences vanish", () => {
    const seen: unknown[] = [];
    const spy = { teleport: (_h: number, p: unknown) => seen.push(p) } as unknown as PhysicsBackend;
    const wrapped = deterministicBackend(spy);
    wrapped.teleport(0, [1.1, -2.5, Math.sin(0.7)]);
    wrapped.teleport(0, [1.1 * (1 + Number.EPSILON), -2.5, Math.sin(0.7) * (1 - 2 * Number.EPSILON)]);
    expect(seen[0]).toEqual(seen[1]);
    // The digest sees any difference in state at all.
    const state = { position: [1, 2, 3] as const, rotation: [0, 0, 0, 1] as const, velocity: [0, 0, 0] as const };
    expect(physicsStateHash([state])).toBe(physicsStateHash([{ ...state }]));
    expect(physicsStateHash([state])).not.toBe(physicsStateHash([{ ...state, velocity: [0, 1e-6, 0] as const }]));
  });
});

describe("the deterministic Rapier build", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("simulates bit for bit the same world from inputs a few ulps apart", () => {
    const scene = parseMeshScene(towerJson(true))!;
    const a = digests(scene, true);
    const b = digests(nudged(scene), true);
    expect(new Set(a).size).toBeGreaterThan(200); // the world really changes every tick
    expect(b).toEqual(a);
    // And runs repeat exactly.
    expect(digests(scene, true)).toEqual(a);
  }, 60_000);

  it("absorbs differences that would otherwise diverge (errors built up through matrix chains)", () => {
    // Relative errors around 1e-8 — what several chained sin/cos/multiplies can
    // accumulate — survive the engine's own 32-bit rounding and send a chaotic
    // scene elsewhere; rounded onto the grid first, they vanish.
    const scene = parseMeshScene(towerJson(true))!;
    const off = nudged(scene, 1e8);
    expect(digests(off, false)).not.toEqual(digests(scene, false));
    expect(digests(off, true)).toEqual(digests(scene, true));
  }, 60_000);

  it.skipIf(!existsSync(ENGINE))("hands the digest to Lua through cartbox.physicshash", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(towerJson(true))!;
    let tic = codeChunks(new TextEncoder().encode(`t = 0
function TIC()
  t = t + 1
  if t == 21 then cartbox.impulse("ball", 60, 3, 0.75) end -- applied in step 20, as digests() does
  pmem(100, cartbox.physicshash())
end`));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = prependLuaCode(tic, physicsSdkLua(sc, layout));
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const session = new PhysicsSession(sc, createRapierBackend(RAPIER));
    expect(session.deterministic).toBe(true); // from the scene's setting
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    for (let i = 0; i < 60; i += 1) {
      session.beforeTick(block());
      mod._cbx_tick(h, 0);
      session.afterTick(block());
    }
    // What the cart read on its last tick is the digest after the step before it.
    const read = new Int32Array(mod.HEAPU8.buffer, base, 256)[100]!;
    expect(read).not.toBe(0);
    expect(read).toBe(digests(sc, true, 60)[58]);
    session.destroy();
  }, 60_000);
});
