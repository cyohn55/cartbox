/**
 * The dedicated Modern core in the player (ENGINE_PARITY_ROADMAP.md EP20b part
 * 2): wrapped as a console, it runs the player's own Lua SDK and preludes
 * unchanged — the event mailbox, the mesh camera, the runtime block the host
 * writes before each tick — while the runtime's commands travel as direct calls,
 * past every cap. Plus: which carts choose it, and errors.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { serializeMeshAsset, type MeshAsset } from "@cartbox/editor";
import {
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  createDirectConsole,
  decodeMailbox,
  decodeMeshCamera,
  directCoreModel,
  getModel,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

const box: MeshAsset = { name: "b", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
const SCENE = JSON.stringify({
  version: 2,
  core: "direct",
  meshes: [{ id: "a", name: "crate", mesh: serializeMeshAsset(box), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
  timelines: [{ name: "t", duration: 1, tracks: [] }],
});

describe("which carts run on it", () => {
  it("a Modern-tier scene that asks for it; the other models never", () => {
    expect(parseMeshScene(SCENE)!.core).toBe("direct");
    expect(parseMeshScene(SCENE.replace('"core":"direct",', ""))!.core).toBeUndefined();
    expect(parseMeshScene(SCENE.replace('"direct"', '"bogus"'))!.core).toBeUndefined();
    expect(directCoreModel(getModel("modern"))).toBe(true);
    expect(directCoreModel(getModel("xbox360"))).toBe(true);
    for (const id of ["classic", "pro", "ps1", "n64"] as const) expect(directCoreModel(getModel(id))).toBe(false);
  });
});

describe.skipIf(!existsSync(CORE))("the dedicated core as a console", () => {
  async function boot(code: string, preludes: (scene: ReturnType<typeof parseMeshScene>) => string[]) {
    const scene = parseMeshScene(SCENE)!;
    const model = getModel("xbox360");
    const layout = RAM_LAYOUTS.xbox360;
    let tic = codeChunks(new TextEncoder().encode(code));
    for (const p of preludes(scene)) if (p) tic = prependLuaCode(tic, p);
    tic = injectSdk(tic);
    const mod = await (await import(pathToFileURL(CORE).href)).default();
    const console = createDirectConsole(mod, model);
    return { console, scene, layout, loaded: console.loadCartridge(tic) };
  }

  it("runs the SDK unchanged: events reach the mailbox, the mesh camera its words", async () => {
    const { console, loaded } = await boot(
      `
t = 0
function TIC()
  t = t + 1
  if t == 1 then cartbox.score(42) cartbox.unlock("first") end
  cartbox.meshcam(30, 10, 5, 60)
  cls(0)
  print("HUD", 4, 4, 12)
end`,
      () => [],
    );
    expect(loaded).toBe(true);
    console.tick(0);
    const read = decodeMailbox(console.readMailbox(), 0);
    expect(read.events.map((e) => [e.kind, e.value])).toEqual([
      ["score", 42],
      ["achievement", 0],
    ]);
    const cam = decodeMeshCamera(console.readMailbox());
    expect(cam?.yaw).toBeCloseTo(30, 2);
    expect(cam?.distance).toBeCloseTo(5, 2);
    // The frame is RGBA at the model's size, the HUD text drawn into it. A cart
    // with no palette chunk gets TIC-80's DB16 palette, as on the HD core.
    const frame = console.readFramebuffer();
    expect(frame.length).toBe(1280 * 720 * 4);
    expect(Array.from(frame.slice(0, 4))).toEqual([0x14, 0x0c, 0x1c, 255]);
  });

  it("sends the runtime's commands as calls: 6,000 placements in one tick, past even the overflow ring's 4,159", async () => {
    const { console, scene, layout } = await boot(
      `
function TIC()
  local ok = 0
  for i = 1, 6000 do if cartbox.place("crate", i, 2, 3, 0, 0, 0, 1) then ok = ok + 1 end end
  pmem(100, ok)
end`,
      (sc) => [sceneObjectsSdkLua(sc), runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false })],
    );
    const channel = new RuntimeChannel(scene, null);
    const block = () => {
      const bytes = console.ramView(physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES)!;
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    channel.beforeTick(block());
    console.tick(0);
    const direct = console.takeCommands();
    channel.afterTick(block(), null, direct);
    expect(direct.length).toBe(6000);
    expect(console.netWords()![100]).toBe(6000);
    const m = channel.placements().get(0)!;
    expect([m[12], m[13], m[14]]).toEqual([6000, 2, 3]);
    expect(console.takeCommands()).toEqual([]);
    channel.destroy();
  });

  it("reports a runtime error with a fresh sequence number, and keeps going", async () => {
    const { console } = await boot(`t = 0 function TIC() t = t + 1 if t == 2 then error("oops") end end`, () => []);
    expect(console.readError()).toEqual({ seq: 0, message: "" });
    console.tick(0);
    console.tick(0);
    expect(console.readError()!.seq).toBe(1);
    expect(console.readError()!.message).toContain("oops");
    console.tick(0);
    expect(console.readError()!.seq).toBe(1);
  });

  it("refuses a cart with no Lua code", async () => {
    const mod = await (await import(pathToFileURL(CORE).href)).default();
    const console = createDirectConsole(mod, getModel("xbox360"));
    expect(console.loadCartridge(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});
