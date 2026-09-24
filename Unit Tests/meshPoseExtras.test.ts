/**
 * The mesh-pose extras — animation frame, tint, and the front layer — end to end
 * where it matters (the real Xbox 360 WASM core running the injected SDK Lua,
 * then the host decoder), plus the pieces the surface builds on them: the shared
 * mesh library, tinting, and the cached static shadow map equalling a full one.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  buildSceneShadow,
  composeModelMatrix,
  defaultSceneLighting,
  packMeshLibrary,
  patchSceneLighting,
  readMeshLibrary,
  resolveMeshFrames,
  resolveMeshRef,
  serializeMeshAsset,
  type MeshAsset,
} from "@cartbox/editor";
import { CARTBOX_SDK_LUA, decodeMeshPoses, parseMeshScene } from "@cartbox/player";
import { TINT_PALETTE, tintMesh } from "../packages/player/src/mesh/MeshOverlaySurface";
import { decodeMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

function quad(name: string, color: [number, number, number, number], tintable = false): MeshAsset {
  return {
    name,
    primitives: [
      {
        positions: Float32Array.from([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
        normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
        uvs: null,
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "m", baseColorFactor: color, baseColorImage: null, ...(tintable ? { tintable: true } : {}) },
      },
    ],
  };
}

describe("cartbox.meshpose extras through the real engine", () => {
  it.skipIf(!existsSync(ENGINE))("packs frame, tint and front into the index word the host decodes", async () => {
    const code = `${CARTBOX_SDK_LUA}\nfunction TIC()\n cartbox.clearposes()\n cartbox.meshpose(3, 1, 2, 3, 0.5, 0, 0, 1)\n cartbox.meshpose(9, 0, 0, 0, 0, 0, 0, 1, 5, 12, true)\nend\n`;
    const data = new TextEncoder().encode(code);
    const tic = new Uint8Array(4 + data.length);
    tic.set([5, data.length & 0xff, (data.length >> 8) & 0xff, 0], 0);
    tic.set(data, 4);
    const factory = (await import(pathToFileURL(ENGINE).href)).default;
    const mod = await factory();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    for (let i = 0; i < 3; i += 1) mod._cbx_tick(h, 0);
    const words = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
    mod._cbx_delete(h);
    const poses = decodeMeshPoses(words);
    expect(poses).toHaveLength(2);
    expect(poses[0]).toMatchObject({ index: 3, frame: 0, tint: 0, front: false });
    expect(poses[1]).toMatchObject({ index: 9, frame: 5, tint: 12, front: true });
  });
});

describe("the shared mesh library", () => {
  const soldier = serializeMeshAsset(quad("soldier", [1, 1, 1, 1]));
  const walk = serializeMeshAsset(quad("walk", [0.5, 0.5, 0.5, 1]));
  const map = serializeMeshAsset(quad("map", [0.2, 0.2, 0.2, 1]));

  it("stores repeated meshes and frames once, and resolves them back", () => {
    const entries = [
      { id: "map", mesh: map },
      { id: "a", mesh: soldier, frames: [walk] },
      { id: "b", mesh: soldier, frames: [walk] },
    ];
    const { entries: packed, library } = packMeshLibrary(entries);
    expect(Object.keys(library)).toHaveLength(2); // soldier + walk, each once
    expect(packed[0]!.mesh).toBe(map); // a one-off stays inline
    expect(packed[1]!.mesh.startsWith("@lib:")).toBe(true);
    const lib = readMeshLibrary(JSON.parse(JSON.stringify(library)));
    expect(resolveMeshRef(packed[2]!.mesh, lib)).toBe(soldier);
    expect(resolveMeshFrames(packed[2]!.frames, lib)).toEqual([walk]);
    expect(resolveMeshRef("@lib:missing", lib)).toBeNull();
  });

  it("round-trips through the editor codec and shares MeshAssets at runtime", () => {
    const sidecar = decodeMeshSidecar(
      JSON.stringify({
        version: 2,
        meshes: [
          { id: "a", name: "a", mesh: soldier, frames: [walk], transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
          { id: "b", name: "b", mesh: soldier, frames: [walk], transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        ],
      }),
    );
    const encoded = encodeMeshSidecar(sidecar)!;
    expect(encoded.length).toBeLessThan(soldier.length * 2 + walk.length * 2); // stored once, not twice
    const back = decodeMeshSidecar(encoded);
    expect(back.meshes.map((m) => m.mesh)).toEqual([soldier, soldier]);
    expect(back.meshes[1]!.frames).toEqual([walk]);
    const scene = parseMeshScene(encoded)!;
    expect(scene.instances).toHaveLength(2);
    expect(scene.instances[0]!.mesh).toBe(scene.instances[1]!.mesh); // one shared MeshAsset
    expect(scene.instances[0]!.frames![0]).toBe(scene.instances[1]!.frames![0]);
  });
});

describe("tinting", () => {
  it("recolours only tintable materials, sharing geometry", () => {
    const mesh: MeshAsset = {
      name: "m",
      primitives: [quad("paint", [1, 1, 1, 1], true).primitives[0]!, quad("suit", [0.2, 0.2, 0.2, 1]).primitives[0]!],
    };
    const red = tintMesh(mesh, 1);
    expect(red.primitives[0]!.material.baseColorFactor.slice(0, 3)).toEqual([...TINT_PALETTE[1]!]);
    expect(red.primitives[1]!.material.baseColorFactor).toEqual([0.2, 0.2, 0.2, 1]);
    expect(red.primitives[0]!.positions).toBe(mesh.primitives[0]!.positions);
    expect(tintMesh(mesh, 0)).toBe(mesh);
  });
});

describe("cached static shadow", () => {
  it("equals a full render when the moving instances are drawn over the cached static depth", () => {
    const lighting = patchSceneLighting(defaultSceneLighting(), { shadows: true });
    const floor = { mesh: quad("floor", [1, 1, 1, 1]), model: composeModelMatrix([0, 0, 0], [0, 0, 0], [4, 1, 4]) };
    const box = { mesh: quad("box", [1, 1, 1, 1]), model: composeModelMatrix([0.5, 1.5, 0.2], [0, 0, 0], [1, 1, 1]) };
    const size = 64;
    const center: [number, number, number] = [0, 0.75, 0];
    const full = buildSceneShadow([floor, box], lighting, center, 5, { size, depth: new Float32Array(size * size) })!;
    const cached = new Float32Array(size * size);
    buildSceneShadow([floor], lighting, center, 5, { size, depth: cached });
    const layered = buildSceneShadow([box], lighting, center, 5, { size, depth: Float32Array.from(cached), clear: false })!;
    expect(Array.from(layered.depth)).toEqual(Array.from(full.depth));
    expect(layered.slopeBias).toBe(full.slopeBias);
  });
});
