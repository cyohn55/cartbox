/**
 * Animation state machines (ENGINE_ROADMAP.md, Phase 3): parameters drive
 * transitions between states (with exit times and crossfades), blend states mix
 * clips by a parameter, triggers are used up by the transition they start, clip
 * events fire as the playhead passes them — and the cart drives it all from Lua.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { parseGltfText, readAnimatorSpec, serializeMeshAsset, type AnimatorSpec } from "@cartbox/editor";
import {
  AnimationSession,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type MeshScene,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { createPrefab } from "../apps/web/src/lib/meshPrefabs";
import { decodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const DT = 1 / 60;

/** idle (rest) ⇄ move (bend↔wave by speed); any → shoot (wave, once) on a trigger, back to idle when done; a footstep at 0.5 s of bend. */
const MACHINE: AnimatorSpec = {
  params: [
    { name: "speed", kind: "number", initial: 0 },
    { name: "shoot", kind: "trigger", initial: 0 },
  ],
  states: [
    { name: "idle", clip: null, speed: 1, loop: true },
    { name: "move", clip: null, speed: 1, loop: true, blend: { param: "speed", points: [{ clip: "bend", at: 1 }, { clip: "wave", at: 3 }] } },
    { name: "shoot", clip: "wave", speed: 1, loop: false },
  ],
  transitions: [
    { from: "idle", to: "move", when: [{ param: "speed", op: ">", value: 0.5 }], fade: 0.1 },
    { from: "move", to: "idle", when: [{ param: "speed", op: "<=", value: 0.5 }], fade: 0.1 },
    { from: "*", to: "shoot", when: [{ param: "shoot", op: "set", value: 0 }], fade: 0 },
    { from: "shoot", to: "idle", when: [], fade: 0.1, exitTime: 1 },
  ],
  events: [{ clip: "bend", time: 0.5, name: "step" }],
};

function scene(animator: unknown = MACHINE): MeshScene {
  const arm = serializeMeshAsset(parseGltfText(skinnedArmGltf(1), "arm"));
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: [{ id: "arm", name: "arm", mesh: arm, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, animator }],
    }),
  )!;
}

const now = (s: AnimationSession) => s.state()[0]!;

describe("animator specs", () => {
  it("keep only what makes sense: known params, fitting tests, existing states, unique names", () => {
    const spec = readAnimatorSpec({
      params: [
        { name: "speed", kind: "number", initial: 2 },
        { name: "speed", kind: "bool" }, // duplicate
        { name: "on", kind: "bool", initial: true },
        { name: "go", kind: "trigger" },
      ],
      states: [{ name: "a", clip: "bend" }, { name: "a" }, { name: "b", clip: null, loop: false, blend: { param: "on", points: [{ clip: "x", at: 0 }] } }],
      transitions: [
        { from: "a", to: "b", when: [{ param: "speed", op: ">", value: 1 }, { param: "nope", op: ">", value: 1 }, { param: "go", op: ">" }, { param: "on", op: "true" }] },
        { from: "a", to: "missing", when: [] },
        { from: "*", to: "a", when: [{ param: "go", op: "set" }], exitTime: 0.5, fade: 99 },
      ],
      events: [{ clip: "bend", time: 0.25, name: "step" }, { clip: "", name: "x" }],
    })!;
    expect(spec.params.map((p) => [p.name, p.kind, p.initial])).toEqual([
      ["speed", "number", 2],
      ["on", "bool", 1],
      ["go", "trigger", 0],
    ]);
    expect(spec.states.map((s) => s.name)).toEqual(["a", "b"]);
    expect(spec.states[1]!.blend).toBeUndefined(); // a blend needs a number parameter
    expect(spec.transitions).toHaveLength(2);
    expect(spec.transitions[0]!.when.map((c) => c.param)).toEqual(["speed", "on"]);
    expect(spec.transitions[1]).toMatchObject({ from: "*", exitTime: 0.5, fade: 10 });
    expect(spec.events).toEqual([{ clip: "bend", time: 0.25, name: "step" }]);
    expect(readAnimatorSpec({ states: [] })).toBeNull();
  });

  it("travel with the scene object into prefabs", () => {
    const arm = serializeMeshAsset(parseGltfText(skinnedArmGltf(1), "arm"));
    const sidecar = decodeMeshSidecar(
      JSON.stringify({ version: 2, lighting: null, meshes: [{ id: "a", name: "arm", mesh: arm, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, animator: MACHINE }] }),
    );
    expect(sidecar.meshes[0]!.animator!.states).toHaveLength(3);
    const { sidecar: withPrefab } = createPrefab(sidecar, "a", "Arm");
    expect(withPrefab.prefabs![0]!.nodes[0]!.animator!.transitions).toHaveLength(4);
  });
});

describe("the state machine", () => {
  it("starts in its first state and moves with its parameters, blending by speed", () => {
    const s = new AnimationSession(scene());
    expect(now(s)).toMatchObject({ state: 0, clip: -1 }); // idle: the rest pose
    s.step(DT);
    expect(now(s).state).toBe(0);
    s.setParam(0, 0, 1.5); // speed 1.5: a quarter of the way from bend to wave
    s.step(DT);
    expect(now(s)).toMatchObject({ state: 1, clip: 0 }); // move, showing mostly "bend"
    s.setParam(0, 0, 2.6);
    s.step(DT);
    expect(now(s).clip).toBe(1); // mostly "wave" now
    s.setParam(0, 0, 0);
    s.step(DT);
    expect(now(s).state).toBe(0); // back to idle
  });

  it("fires a clip's events once per pass", () => {
    const s = new AnimationSession(scene());
    s.setParam(0, 0, 1); // pure "bend" (1 s long, looping)
    const fired: number[] = [];
    for (let t = 1; t <= 150; t += 1) {
      s.step(DT);
      if (s.events().length > 0) fired.push(t);
    }
    // The footstep at 0.5 s into each loop: ~0.5 s and ~1.5 s after the move began.
    expect(fired).toHaveLength(2);
    expect(fired[1]! - fired[0]!).toBeGreaterThanOrEqual(59);
    expect(fired[1]! - fired[0]!).toBeLessThanOrEqual(61);
    expect(s.events()).toEqual([]); // only on the tick they happen
  });

  it("takes a trigger once, and leaves a one-shot state when its clip is done", () => {
    const s = new AnimationSession(scene());
    s.setParam(0, 1, 1); // shoot!
    s.step(DT);
    expect(now(s).state).toBe(2);
    // The trigger was used up: it doesn't restart "shoot" next tick.
    for (let t = 0; t < 30; t += 1) s.step(DT);
    expect(now(s).state).toBe(2);
    expect(now(s).time).toBeCloseTo(31 / 60 - DT, 1);
    for (let t = 0; t < 32; t += 1) s.step(DT);
    expect(now(s).state).toBe(0); // the 1 s clip played out, and exit time 1 sent it back to idle
  });

  it("gives way to cartbox.play, and takes back over on setstate", () => {
    const s = new AnimationSession(scene());
    s.play(0, 1, 0, 1, true);
    s.setParam(0, 0, 2);
    s.step(DT);
    expect(now(s)).toMatchObject({ state: -1, clip: 1 }); // the machine is paused
    s.goto(0, 0, 0);
    s.step(DT);
    expect(now(s).state).toBe(1); // idle, then straight on to move (speed is still 2)
  });

  it("crossfades between states over their fade time", () => {
    const s = new AnimationSession(scene());
    const rest = s.matrices().get(0)!;
    s.setParam(0, 0, 1);
    s.step(DT); // into "move" with a 0.1 s fade
    for (let t = 0; t < 2; t += 1) s.step(DT);
    const mid = s.matrices().get(0)!;
    for (let t = 0; t < 10; t += 1) s.step(DT);
    const done = s.matrices().get(0)!;
    // The elbow joint's matrix: part way between rest and the clip mid-fade.
    const angle = (m: Float32Array) => Math.atan2(m[16 + 1]!, m[16]!);
    expect(Math.abs(angle(mid))).toBeGreaterThan(Math.abs(angle(rest)));
    expect(Math.abs(angle(mid))).toBeLessThan(Math.abs(angle(done)));
  });
});

describe.skipIf(!existsSync(ENGINE))("state machines driven from Lua (real engine)", () => {
  it("sets parameters, fires triggers, reads the state and hears clip events", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene();
    const code = `
t = 0
steps = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.set("arm", "speed", 1) end
  if t == 5 then pmem(100, cartbox.state("arm") == "move" and 1 or 0) end
  for _, e in ipairs(cartbox.events("arm")) do if e == "step" then steps = steps + 1 end end
  if t == 100 then pmem(101, steps) cartbox.trigger("arm", "shoot") cartbox.set("arm", "speed", 0) end
  if t == 102 then pmem(102, cartbox.state("arm") == "shoot" and 1 or 0) end
  if t == 200 then pmem(103, cartbox.state("arm") == "idle" and 1 or 0) end
  if t == 201 then cartbox.play("arm", "bend") end
  if t == 203 then pmem(104, cartbox.state("arm") == nil and 1 or 0) end
  if t == 204 then cartbox.setstate("arm", "shoot", 0) end
  if t == 206 then pmem(105, cartbox.state("arm") == "shoot" and 1 or 0) end
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
    for (let i = 0; i < 210; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
    }
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    expect(w(100)).toBe(1);
    expect(w(101)).toBe(2); // ~1.6 s of "bend": footsteps at 0.5 s and 1.5 s
    expect(w(102)).toBe(1);
    expect(w(103)).toBe(1);
    expect(w(104)).toBe(1);
    expect(w(105)).toBe(1);
    channel.destroy();
  }, 120_000);
});
