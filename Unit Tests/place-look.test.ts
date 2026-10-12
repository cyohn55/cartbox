/**
 * Placing an object mirrored, and how a placed object looks
 * (LOCKOUT_EQUIPMENT_ROADMAP.md E3/E5): cartbox.place takes a negative scale
 * (the object mirrored through its middle), and cartbox.look gives a placed
 * object the tint and front layer a pose would -- poses are eight a frame;
 * placements and looks have no cap. On the real engine, through the command
 * block to the runtime channel.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import { NET_WORDS, PHYS_BLOCK_BYTES, RAM_LAYOUTS, RuntimeChannel, codeChunks, injectSdk, parseMeshScene, physicsBlockAddress, runtimeSdkLua, sceneObjectsSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const HD = RAM_LAYOUTS.xbox360;

describe.skipIf(!existsSync(ENGINE))("a placed object", () => {
  const tri: MeshAsset = { name: "t", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
  const tf = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  // (a timeline gives the scene its runtime, and so cartbox.place)
  const scene = parseMeshScene(
    JSON.stringify({ version: 2, lighting: null, meshes: [{ id: "a", name: "gun", mesh: serializeMeshAsset(tri), transform: tf }], timelines: [{ name: "t", duration: 1, tracks: [] }] }),
  )!;

  async function run(code: string, ticks: number) {
    let tic = codeChunks(new TextEncoder().encode(code));
    for (const prelude of [runtimeSdkLua(scene, HD, { physics: false }), sceneObjectsSdkLua(scene)]) tic = prependLuaCode(tic, prelude);
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(HD) - HD.pmemAddress, PHYS_BLOCK_BYTES);
    const channel = new RuntimeChannel(scene, null);
    const seen: { placed: Float64Array | Float32Array | number[] | undefined; look: unknown }[] = [];
    for (let t = 0; t < ticks; t += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push({ placed: channel.placements().get(0) as never, look: channel.looks().get(0) ?? null });
    }
    channel.destroy();
    return seen;
  }

  it("can be mirrored through its middle by a negative scale, and keeps its size", async () => {
    const [mirrored] = await run(`function TIC() cartbox.place("gun", 1, 2, 3, 0, 0, 0, -2) end`, 1);
    const m = mirrored!.placed!;
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
    expect(det).toBeCloseTo(-8, 6); // a mirror, twice the size
    expect([m[12], m[13], m[14]]).toEqual([1, 2, 3]);
  });

  it("takes a tint and the front layer from cartbox.look, which stand until changed or cleared", async () => {
    const seen = await run(
      `local t = 0
function TIC()
  t = t + 1
  if t == 1 then cartbox.place("gun", 0, 0, 0, 0, 0, 0, 1); cartbox.look("gun", 5, true) end
  if t == 3 then cartbox.look("gun", 2, false) end
  if t == 5 then cartbox.look("gun", 0, false) end
end`,
      6,
    );
    expect(seen.map((s) => s.look)).toEqual([
      { tint: 5, front: true },
      { tint: 5, front: true },
      { tint: 2, front: false },
      { tint: 2, front: false },
      null,
      null,
    ]);
  });
});
