/**
 * Levels (ENGINE_ROADMAP.md, Phase 4 — streaming): named levels in the mesh
 * sidecar, one loaded at a time. Only the current level's objects (plus the
 * always-loaded ones) draw and simulate; `cartbox.level` switches, and a
 * published cart streams the level's textures first.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";

import { effectiveLevels, readLevels, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  MeshOverlaySurface,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  PhysicsSession,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createRapierBackend } from "../apps/web/src/lib/physicsRapier";
import { addLevel, addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, removeLevel, renameLevel, setMeshLevel, setStartLevel } from "../apps/web/src/lib/meshSidecar";
import { meshTextureLevels } from "../apps/web/src/lib/meshTextureAssets";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [
      {
        positions: Float32Array.from(p),
        normals: null,
        uvs: null,
        indices: Uint32Array.from(idx),
        material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null },
      },
    ],
  };
}

const T = (x: number, y = 0) => ({ position: [x, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });

/** Player (always loaded), a meadow tree and rock (the rock a child of the tree), a cave bat. */
function sidecar(extra: Record<string, unknown> = {}) {
  const mesh = serializeMeshAsset(cube());
  return JSON.stringify({
    version: 2,
    levels: [
      { id: "L1", name: "meadow" },
      { id: "L2", name: "cave" },
    ],
    meshes: [
      { id: "player", name: "player", mesh, transform: T(0) },
      { id: "tree", name: "tree", mesh, transform: T(3), level: "L1" },
      { id: "rock", name: "rock", mesh, transform: T(1), parent: "tree" },
      { id: "bat", name: "bat", mesh, transform: T(30, 5), level: "L2" },
    ],
    ...extra,
  });
}

describe("level data", () => {
  it("reads levels defensively and resolves each object's level through its parents", () => {
    expect(readLevels([{ id: "a", name: " One " }, { id: "a", name: "dupe" }, { name: "no id" }, { id: "b" }])).toEqual([
      { id: "a", name: "One" },
      { id: "b", name: "Level 2" },
    ]);
    const levels = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
    // 0: none, 1: in b, 2: child of 1 → b, 3: unknown level → none, 4: child of 0 → none
    expect(effectiveLevels([undefined, "b", undefined, "zzz", undefined], [-1, -1, 1, -1, 0], levels)).toEqual([-1, 1, 1, -1, -1]);
  });

  it("edits levels in the sidecar and keeps them through a save", () => {
    let sc = emptyMeshSidecar();
    const a = addMesh(sc, cube(), "a");
    sc = a.sidecar;
    const meadow = addLevel(sc, "meadow");
    sc = meadow.sidecar;
    const cave = addLevel(sc);
    sc = cave.sidecar;
    expect(sc.levels!.map((l) => l.name)).toEqual(["meadow", "Level 2"]);
    sc = renameLevel(sc, cave.id, "cave");
    sc = setMeshLevel(sc, a.id, cave.id);
    sc = setStartLevel(sc, cave.id);
    const round = decodeMeshSidecar(encodeMeshSidecar(sc));
    expect(round.levels!.map((l) => l.name)).toEqual(["cave", "meadow"]);
    expect(round.meshes[0]!.level).toBe(cave.id);
    // Removing a level leaves its objects always loaded; an unknown level is dropped on read.
    const removed = removeLevel(round, cave.id);
    expect(removed.meshes[0]!.level).toBeUndefined();
    expect(setMeshLevel(round, a.id, "nope").meshes[0]!.level).toBe(cave.id);
  });
});

describe("the runtime scene", () => {
  it("knows each object's level, inherits it down the hierarchy, and frames the start level", () => {
    const scene = parseMeshScene(sidecar())!;
    expect(scene.levels!.map((l) => l.name)).toEqual(["meadow", "cave"]);
    expect(scene.instances.map((i) => i.level)).toEqual([undefined, 0, 0, 1]);
    // The cave bat (x 30) isn't in the framing bounds; the meadow is.
    expect(scene.bounds.max[0]).toBeLessThan(10);
  });

  it("hides the other levels' objects in the renderer, and brings them back", async () => {
    const scene = parseMeshScene(sidecar())!;
    const drawn: number[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances.length), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)).toBe(4);
    surface.setInactive(new Set([3])); // in the meadow: no bat
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)).toBe(3);
    expect(surface.placements()[3]).toBeNull();
    surface.setInactive(new Set([1, 2])); // in the cave: no tree, no rock
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)).toBe(2);
  });
});

describe("the runtime channel", () => {
  it("starts in the first level, takes a switch request, and reports loading", () => {
    const scene = parseMeshScene(sidecar())!;
    const channel = new RuntimeChannel(scene, null);
    expect(channel.currentLevel()).toBe(0);
    expect(channel.takeLevelRequest()).toBe(-1);
    channel.setLevelLoading(1, 0.25);
    channel.setLevel(1);
    expect(channel.currentLevel()).toBe(1);
    channel.destroy();
  });
});

describe("physics in levels", () => {
  beforeAll(async () => {
    await RAPIER.init();
  });

  it("keeps an unloaded level's bodies out of the world", () => {
    const mesh = serializeMeshAsset(cube());
    const body = { body: "dynamic", shape: "box", mass: 1 };
    const scene = parseMeshScene(
      JSON.stringify({
        version: 2,
        levels: [{ id: "L1", name: "a" }, { id: "L2", name: "b" }],
        meshes: [
          { id: "x", name: "x", mesh, transform: T(0, 10), level: "L1", physics: body },
          { id: "y", name: "y", mesh, transform: T(5, 10), level: "L2", physics: body },
        ],
      }),
    )!;
    const physics = new PhysicsSession(scene, createRapierBackend(RAPIER));
    physics.setInactive(new Set([1]));
    for (let i = 0; i < 30; i += 1) physics.run([]);
    const y = (object: number) => physics.overrides().get(object)?.[13] ?? 10;
    expect(y(0)).toBeLessThan(9.5); // level a's box falls
    expect(y(1)).toBeCloseTo(10, 3); // level b's box stays put, out of the world
    physics.setInactive(new Set([0]));
    const heldX = y(0);
    for (let i = 0; i < 30; i += 1) physics.run([]);
    expect(y(1)).toBeLessThan(9.5);
    expect(y(0)).toBeCloseTo(heldX, 3);
    physics.destroy();
  });
});

describe("streaming a level's textures", () => {
  it("fetches at start what the start level and always-loaded objects need, the rest with their levels", () => {
    const withTexture = (asset: string) => {
      const mesh = JSON.parse(serializeMeshAsset(cube()));
      mesh.primitives[0].material.image = { mime: "image/png", asset };
      return JSON.stringify(mesh);
    };
    const raw = JSON.stringify({
      version: 2,
      levels: [{ id: "L1", name: "meadow" }, { id: "L2", name: "cave" }, { id: "L3", name: "peak" }],
      meshes: [
        { id: "player", name: "p", mesh: withTexture("hp"), transform: T(0) },
        { id: "tree", name: "t", mesh: withTexture("ht"), transform: T(0), level: "L1" },
        { id: "bat", name: "b", mesh: withTexture("hb"), transform: T(0), level: "L2" },
        { id: "wing", name: "w", mesh: withTexture("hw"), transform: T(0), parent: "bat" },
        { id: "ice", name: "i", mesh: withTexture("hw"), transform: T(0), level: "L3" },
      ],
    });
    const needs = meshTextureLevels(raw);
    expect(needs.get("hp")).toBeNull();
    expect(needs.get("ht")).toBeNull(); // the start level
    expect(needs.get("hb")).toEqual(["L2"]);
    expect(needs.get("hw")).toEqual(["L2", "L3"]); // a child in the cave, and the peak
  });
});

describe.skipIf(!existsSync(ENGINE))("levels from Lua (real engine)", () => {
  it("reads the current level, asks for a switch and sees it loading, then in", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then
    local now, loading = cartbox.level()
    pmem(100, now == "meadow" and loading == nil and 1 or 0)
    pmem(101, #cartbox.levels())
    pmem(102, cartbox.level("cave") and 1 or 0)
    pmem(103, cartbox.level("nowhere") and 1 or 0)
  end
  if t == 4 then
    local now, loading, p = cartbox.level()
    pmem(104, now == "meadow" and loading == "cave" and 1 or 0)
    pmem(105, math.floor(p * 100))
  end
  if t == 6 then pmem(106, cartbox.level() == "cave" and 1 or 0) end
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
    let requested = -1;
    for (let i = 1; i <= 7; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      const r = channel.takeLevelRequest();
      if (r >= 0) {
        requested = r;
        channel.setLevelLoading(r, 0.4); // what the player does while the host loads
      }
      if (i === 4 && requested >= 0) channel.setLevel(requested); // loaded
    }
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    expect(requested).toBe(1);
    expect(w(100)).toBe(1);
    expect(w(101)).toBe(2);
    expect(w(102)).toBe(1);
    expect(w(103)).toBe(0);
    expect(w(104)).toBe(1);
    expect(w(105)).toBe(40);
    expect(w(106)).toBe(1);
    channel.destroy();
  }, 120_000);
});
