/**
 * Spatial loading (ENGINE_ROADMAP.md, Phase 4 — streaming within one map):
 * with streaming on, objects load by distance from the focus (the camera, or
 * where the cart puts it), with their children, a margin before unloading,
 * and their textures fetched ahead as the focus nears them. Objects in levels,
 * reserve copies, terrain and ones marked always loaded aren't spatially loaded.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { SpatialLoader, boxDistance, readStreaming, serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
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
  streamGroups,
  type SceneDraw,
  type SceneRenderer,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshAlwaysLoaded, setMeshStreaming } from "../apps/web/src/lib/meshSidecar";
import { meshTextureObjects } from "../apps/web/src/lib/meshTextureAssets";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function cube(): MeshAsset {
  const p = [-0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return {
    name: "cube",
    primitives: [{ positions: Float32Array.from(p), normals: null, uvs: null, indices: Uint32Array.from(idx), material: { name: "m", baseColorFactor: [0.5, 0.5, 0.5, 1], baseColorImage: null } }],
  };
}

const T = (x: number, sx = 1) => ({ position: [x, 0, 0], rotation: [0, 0, 0], scale: [sx, 1, 1] });

/**
 * Along a road: the player (always loaded), a long floor under everything, a
 * house at 50 with a lamp on it, a far tower at 200, a cave bat in a level.
 */
function sidecar(streaming: unknown = { range: 40 }, mesh = serializeMeshAsset(cube())) {
  return JSON.stringify({
    version: 2,
    levels: [{ id: "L1", name: "overworld" }],
    meshes: [
      { id: "player", name: "player", mesh, transform: T(0), alwaysLoaded: true },
      { id: "floor", name: "floor", mesh, transform: T(100, 400) },
      { id: "house", name: "house", mesh, transform: T(50) },
      { id: "lamp", name: "lamp", mesh, transform: T(1), parent: "house" },
      { id: "tower", name: "tower", mesh, transform: T(200) },
      { id: "bat", name: "bat", mesh, transform: T(60), level: "L1" },
    ],
    ...(streaming ? { streaming } : {}),
  });
}

describe("streaming settings", () => {
  it("reads the range defensively (off when absent or malformed)", () => {
    expect(readStreaming({ range: 80 })).toEqual({ range: 80 });
    expect(readStreaming({ range: 1 })).toEqual({ range: 5 });
    expect(readStreaming({ range: "far" })).toBeNull();
    expect(readStreaming(null)).toBeNull();
  });

  it("measures distance to a box, zero inside", () => {
    const box = [0, 0, 0, 10, 2, 10] as const;
    expect(boxDistance([5, 1, 5], box)).toBe(0);
    expect(boxDistance([13, 1, 14], box)).toBe(5);
  });
});

describe("spatially loaded groups", () => {
  it("groups each root with its children, leaving out levels and always-loaded objects", () => {
    const scene = parseMeshScene(sidecar())!;
    expect(scene.streaming).toEqual({ range: 40 });
    const groups = streamGroups(scene);
    const names = groups.map((g) => g.members.map((m) => scene.instances[m]!.name));
    expect(names).toEqual([["floor"], ["house", "lamp"], ["tower"]]);
    // The floor's box spans the road; the house's takes in its lamp.
    expect(groups[0]!.box[0]).toBeCloseTo(-100);
    expect(groups[0]!.box[3]).toBeCloseTo(300);
    expect(groups[1]!.box[3]).toBeCloseTo(51.5);
  });

  it("loads what's in range, keeps it a little past, and asks for assets once, ahead", () => {
    const scene = parseMeshScene(sidecar())!;
    const loader = new SpatialLoader(streamGroups(scene), scene.streaming!);
    const at = (x: number) => loader.update([x, 0, 0]);
    let step = at(0);
    expect(step.changed).toBe(true);
    // The house is 49.5 away (out of 40, but inside the 60 prefetch), the tower 199.5.
    expect(loader.isLoaded(0)).toBe(true);
    expect(loader.isLoaded(1)).toBe(false);
    expect(step.approached).toEqual([0, 1]);
    expect([...loader.unloaded()].map((i) => scene.instances[i]!.name).sort()).toEqual(["house", "lamp", "tower"]);
    step = at(10); // house now 39.5 away: in
    expect(step.changed).toBe(true);
    expect(loader.isLoaded(1)).toBe(true);
    expect(step.approached).toEqual([]);
    step = at(5); // 44.5: past 40 but within the unload margin (46)
    expect(step.changed).toBe(false);
    expect(loader.isLoaded(1)).toBe(true);
    step = at(0); // 49.5: out
    expect(step.changed).toBe(true);
    expect(loader.isLoaded(1)).toBe(false);
    expect(at(150).approached).toEqual([2]); // the tower, 49.5 away: fetch its assets
  });

  it("measures a moving object where it is now", async () => {
    const scene = parseMeshScene(sidecar())!;
    const loader = new SpatialLoader(streamGroups(scene), scene.streaming!);
    loader.update([0, 0, 0]);
    expect(loader.isLoaded(2)).toBe(false); // the tower, placed at 200
    // The cart walks the tower over to x = 20 (a pose moves it 180 back).
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, { backend: "software", render: () => {}, dispose: () => {} } as SceneRenderer);
    const tower = scene.instances.findIndex((i) => i.name === "tower");
    expect(surface.movedModel(tower)).toBeNull();
    surface.setPoseOverrides([{ index: tower, hidden: false, position: [-180, 0, 0], rotation: [0, 0, 0], scale: 1 }]);
    const now = surface.movedModel(tower)!;
    expect(now[12]).toBeCloseTo(20);
    loader.update([0, 0, 0], (g) => (g === 2 ? [now[12]! - 200, 0, 0] : null));
    expect(loader.isLoaded(2)).toBe(true);
  });

  it("hides unloaded objects in the renderer", async () => {
    const scene = parseMeshScene(sidecar())!;
    const loader = new SpatialLoader(streamGroups(scene), scene.streaming!);
    loader.update([0, 0, 0]);
    const drawn: number[] = [];
    const renderer: SceneRenderer = { backend: "software", render: (instances, _d: SceneDraw) => void drawn.push(instances.length), dispose: () => {} };
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, scene, renderer);
    // The level's bat is out too (the start level is the only one, so it's in).
    surface.setInactive(loader.unloaded());
    surface.blit(new Uint8Array(16 * 16 * 4));
    expect(drawn.at(-1)).toBe(3); // player, floor, bat
    expect(surface.eyePosition()).not.toBeNull();
  });

  it("switches on the runtime (for cartbox.streamfocus) only when streaming", () => {
    expect(sceneNeedsRuntime(parseMeshScene(sidecar())!, { physics: false })).toBe(true);
    expect(runtimeSdkLua(parseMeshScene(sidecar())!, RAM_LAYOUTS.xbox360, { physics: false })).toContain("cartbox.streamfocus");
    const plain = parseMeshScene(sidecar(null))!;
    expect(plain.streaming).toBeUndefined();
    expect(streamGroups(plain).length).toBeGreaterThan(0); // groups exist; the player only uses them when streaming
  });
});

describe("the editor's sidecar", () => {
  it("turns streaming on and off, marks objects always loaded, and keeps both through a save", () => {
    let s = addMesh(emptyMeshSidecar(), cube(), "rock").sidecar;
    const id = s.meshes[0]!.id;
    s = setMeshStreaming(s, { range: 120 });
    s = setMeshAlwaysLoaded(s, id, true);
    const back = decodeMeshSidecar(encodeMeshSidecar(s));
    expect(back.streaming).toEqual({ range: 120 });
    expect(back.meshes[0]!.alwaysLoaded).toBe(true);
    const off = decodeMeshSidecar(encodeMeshSidecar(setMeshAlwaysLoaded(setMeshStreaming(back, null), id, false)));
    expect(off.streaming).toBeUndefined();
    expect(off.meshes[0]!.alwaysLoaded).toBeUndefined();
  });
});

describe("streaming spatially loaded textures", () => {
  it("attributes each texture to the spatially loaded objects that use it, or to the start", () => {
    const withTexture = (asset: string) => {
      const mesh = JSON.parse(serializeMeshAsset(cube()));
      mesh.primitives[0].material.image = { mime: "image/png", asset };
      return JSON.stringify(mesh);
    };
    const raw = JSON.stringify({
      version: 2,
      streaming: { range: 40 },
      levels: [{ id: "L1", name: "cave" }],
      meshes: [
        { id: "player", name: "p", mesh: withTexture("hp"), transform: T(0), alwaysLoaded: true },
        { id: "house", name: "h", mesh: withTexture("hh"), transform: T(50) },
        { id: "lamp", name: "l", mesh: withTexture("hl"), transform: T(1), parent: "house" },
        { id: "tower", name: "t", mesh: withTexture("hh"), transform: T(200) },
        { id: "bat", name: "b", mesh: withTexture("hb"), transform: T(0), level: "L1" },
        { id: "shared", name: "s", mesh: withTexture("hp"), transform: T(90) },
      ],
    });
    const needs = meshTextureObjects(raw);
    expect(needs.get("hp")).toBeNull(); // the always-loaded player uses it
    expect(needs.get("hh")).toEqual(["house", "tower"]);
    expect(needs.get("hl")).toEqual(["house"]); // the lamp loads with its house
    expect(needs.get("hb")).toBeNull(); // the level streams it
    expect(meshTextureObjects(raw.replace('"streaming":{"range":40},', "")).size).toBe(0);
  });
});

describe.skipIf(!existsSync(ENGINE))("the streaming focus from Lua (real engine)", () => {
  it("cartbox.streamfocus moves the focus to a point, and back to the camera", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = parseMeshScene(sidecar())!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.streamfocus(120, 1, -4) end
  if t == 4 then cartbox.streamfocus() end
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
    const focus: (readonly number[] | null)[] = [];
    for (let i = 1; i <= 5; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      focus.push(channel.streamFocus());
    }
    expect(focus[0]).toBeNull();
    expect(focus[1]![0]).toBeCloseTo(120, 2);
    expect(focus[1]![2]).toBeCloseTo(-4, 2);
    expect(focus[2]).not.toBeNull();
    expect(focus[3]).toBeNull();
    channel.destroy();
  });
});
