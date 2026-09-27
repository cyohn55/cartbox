/**
 * Skeletal animation at run time (ENGINE_ROADMAP.md, Phase 3): a skinned scene
 * object plays its first clip on its own, the cart switches clips with
 * cartbox.play (crossfading) and reads them back with cartbox.anim, and the
 * renderer draws the posed mesh. Runs through the real Xbox 360 engine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { parseGltfText, serializeMeshAsset } from "@cartbox/editor";
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
  type MeshScene,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** One placed arm (and a still box) in a scene. */
function scene(): MeshScene {
  const arm = serializeMeshAsset(parseGltfText(skinnedArmGltf(1), "arm"));
  const T = (position: number[]) => ({ position, rotation: [0, 0, 0], scale: [1, 1, 1] });
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: [
        { id: "arm", name: "arm", mesh: arm, transform: T([0, 0, 0]) },
        { id: "arm2", name: "arm2", mesh: arm, transform: T([5, 0, 0]) },
      ],
    }),
  )!;
}

describe("animated scenes", () => {
  it("need the runtime block even without physics or prefabs", () => {
    expect(sceneNeedsRuntime(scene(), { physics: false })).toBe(true);
  });
});

describe.skipIf(!existsSync(ENGINE))("skeletal animation through the real engine", () => {
  it("autoplays, switches clips with a crossfade, reports playback and draws the pose", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene();
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 30 then
    local name, time = cartbox.anim("arm")
    pmem(100, name == "bend" and 1 or 0) pmem(101, math.floor(time * 1000))
    local c = cartbox.clips("arm") pmem(102, #c)
  end
  if t == 61 then cartbox.play("arm", "wave", 0.25, 1, false) end
  if t == 61 then cartbox.play("arm2", nil) end
  if t == 150 then
    local name, time, done = cartbox.anim("arm")
    pmem(103, name == "wave" and 1 or 0) pmem(104, math.floor(time * 1000)) pmem(105, done and 1 or 0)
    local rest = cartbox.anim("arm2") pmem(106, rest == nil and 1 or 0)
  end
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
    const surface = await MeshOverlaySurface.create({ blit() {}, destroy() {} }, 16, 16, sc);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    const drawnTop = () => {
      // The arm's strip, as the surface will draw it this frame: its top-right corner.
      surface.setSkinning(channel.skinning());
      const main = (surface as unknown as { posedInstances(): { main: { mesh: { primitives: { positions: Float32Array }[] } }[] } }).posedInstances().main;
      const p = main[0]!.mesh.primitives[0]!.positions;
      return [p[27]!, p[28]!];
    };
    const run = (n: number) => {
      for (let i = 0; i < n; i += 1) {
        channel.beforeTick(block());
        mod._cbx_tick(h, 0);
        channel.afterTick(block());
      }
    };

    run(30); // the first clip plays by itself: "bend", 29 ticks in when the cart read it
    expect(w(100)).toBe(1);
    expect(w(101) / 1000).toBeCloseTo(29 / 60, 2);
    expect(w(102)).toBe(2);
    // And the renderer draws it bent part way: the top corner has swung left of x = 0.1.
    const [x30] = drawnTop();
    expect(x30).toBeLessThan(0);

    run(31); // tick 61: switch to "wave" (not looping) with a quarter-second crossfade
    const fading = channel.skinning().get(0)!;
    run(1);
    // Mid-fade, the pose is neither the old clip nor the new one yet.
    expect(channel.skinning().get(0)).not.toBe(fading);

    run(88); // tick 150: a second and a half in, the one-second clip is held at its end
    expect(w(103)).toBe(1);
    expect(w(104) / 1000).toBeCloseTo(1, 3);
    expect(w(105)).toBe(1);
    expect(w(106)).toBe(1); // arm2 was sent back to its rest pose
    // "wave" ends where it began, straight up: the corner is back at (0.1, 2).
    const [x, y] = drawnTop();
    expect(x).toBeCloseTo(0.1, 3);
    expect(y).toBeCloseTo(2, 3);
    channel.destroy();
  }, 120_000);
});
