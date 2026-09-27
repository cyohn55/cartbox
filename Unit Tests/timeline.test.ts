/**
 * Timelines (ENGINE_ROADMAP.md, Phase 3): camera, object, animation and event
 * tracks, sampled with easing; the runtime plays one (autoplay, loop, hold or
 * release), starts clips and states on cue, reports events, and hands the
 * player a camera and object placements — all driven from Lua.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { crossedMarks, parseGltfText, readTimelines, sampleCamera, sampleObjects, serializeMeshAsset, type SceneTimeline } from "@cartbox/editor";
import {
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  buildOrbitCamera,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneObjectsSdkLua,
  type MeshScene,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshTimelines } from "../apps/web/src/lib/meshSidecar";
import { skinnedArmGltf } from "./helpers/skinnedGltf";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A 2 s flyover: the camera from (0,2,10) to (10,2,0) looking at the origin, the arm rising 3 m, a "bend" cue at 0.5 s, events at 1 s and 2 s. */
const INTRO = {
  name: "intro",
  duration: 2,
  tracks: [
    {
      kind: "camera",
      keys: [
        { time: 0, eye: [0, 2, 10], target: [0, 0, 0], fov: 40, ease: "linear" },
        { time: 2, eye: [10, 2, 0], target: [0, 1, 0], fov: 60, ease: "linear" },
      ],
    },
    {
      kind: "object",
      object: "arm",
      keys: [
        { time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], ease: "linear" },
        { time: 2, position: [0, 3, 0], rotation: [0, 90, 0], scale: [1, 1, 1], ease: "linear" },
      ],
    },
    { kind: "animation", object: "arm", cues: [{ time: 0.5, clip: "bend", fade: 0 }] },
    { kind: "events", events: [{ time: 1, name: "line1" }, { time: 2, name: "done" }] },
  ],
};

function scene(timelines: unknown[]): MeshScene {
  const arm = serializeMeshAsset(parseGltfText(skinnedArmGltf(1), "arm"));
  return parseMeshScene(
    JSON.stringify({
      version: 2,
      meshes: [
        { id: "floor", name: "floor", mesh: arm, transform: { position: [0, -1, 0], rotation: [0, 0, 0], scale: [8, 0.1, 8] } },
        { id: "arm", name: "arm", mesh: arm, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
      timelines,
    }),
  )!;
}

describe("timeline data", () => {
  it("validates tracks, keys and names, and sorts keys by time", () => {
    const [t, u] = readTimelines([
      { name: "a", duration: 3, loop: true, tracks: [{ kind: "camera", keys: [{ time: 2 }, { time: 9 }, { time: 1, ease: "step" }] }, { kind: "bogus" }, { kind: "object" }] },
      { name: "a" }, // duplicate name
      { name: "b", duration: -1 },
    ]);
    expect(t!.tracks).toHaveLength(1);
    expect(t!.tracks[0]!.kind === "camera" && t!.tracks[0]!.keys.map((k) => [k.time, k.ease])).toEqual([
      [1, "step"],
      [2, "smooth"],
      [3, "smooth"], // clamped to the duration
    ]);
    expect(u).toMatchObject({ name: "b", duration: 0.05 });
    // Stored and loaded with the sidecar.
    const withTl = setMeshTimelines(decodeMeshSidecar(null), [INTRO as unknown as SceneTimeline]);
    expect(decodeMeshSidecar(encodeMeshSidecar(withTl)).timelines![0]!.tracks).toHaveLength(4);
    expect(encodeMeshSidecar(setMeshTimelines(withTl, []))).toBeNull();
  });

  it("samples keys with linear, smooth and step easing", () => {
    const [tl] = readTimelines([INTRO]);
    const mid = sampleCamera(tl!, 1)!;
    expect(mid.eye).toEqual([5, 2, 5]);
    expect(mid.fov).toBeCloseTo(50);
    expect(sampleObjects(tl!, 1).get("arm")!.position).toEqual([0, 1.5, 0]);
    // Before the first key and after the last, the ends hold.
    expect(sampleCamera(tl!, -1)!.eye).toEqual([0, 2, 10]);
    expect(sampleCamera(tl!, 5)!.eye).toEqual([10, 2, 0]);
    const step = readTimelines([{ ...INTRO, tracks: [{ kind: "camera", keys: [{ ...INTRO.tracks[0]!.keys![0], ease: "step" }, INTRO.tracks[0]!.keys![1]] }] }])[0]!;
    expect(sampleCamera(step, 1.9)!.eye).toEqual([0, 2, 10]);
    // Smooth passes through its keys, easing in: slower than linear near the start.
    const smooth = readTimelines([{ ...INTRO, tracks: [{ kind: "camera", keys: INTRO.tracks[0]!.keys!.map((k) => ({ ...k, ease: "smooth" })) }] }])[0]!;
    expect(sampleCamera(smooth, 0.2)!.eye[0]).toBeLessThan(1);
    expect(sampleCamera(smooth, 2)!.eye).toEqual([10, 2, 0]);
    expect(crossedMarks(tl!, 0.4, 1)).toEqual({ cues: [{ object: "arm", cue: { time: 0.5, clip: "bend", fade: 0, loop: true } }], events: ["line1"] });
  });
});

describe("the timeline player", () => {
  const run = (channel: RuntimeChannel, ticks: number) => {
    const block = new DataView(new ArrayBuffer(PHYS_BLOCK_BYTES));
    const events: string[] = [];
    for (let i = 0; i < ticks; i += 1) {
      channel.beforeTick(block);
      channel.afterTick(block);
      for (const e of channel.timeline!.events()) events.push(String(e));
    }
    return events;
  };

  it("autoplays, moves the camera and objects, cues clips, and lets go at the end", () => {
    const channel = new RuntimeChannel(scene([{ ...INTRO, autoplay: true }]), null);
    expect(channel.timeline!.state()).toMatchObject({ index: 0, playing: true });
    run(channel, 60);
    // One second in: the arm is half way up and the camera half way round.
    expect(channel.timelinePlacements().get(1)![13]).toBeCloseTo(1.5, 1);
    const cam = channel.timelineCamera()!;
    const built = buildOrbitCamera(scene([]).bounds, cam.yaw, cam.pitch, 1, { distance: cam.distance, targetOffset: cam.target });
    // The orbit camera it becomes looks from the keyed eye: the view matrix maps the eye to the origin.
    const v = built.view;
    const eye = [5, 2, 5];
    expect(v[0]! * eye[0]! + v[4]! * eye[1]! + v[8]! * eye[2]! + v[12]!).toBeCloseTo(0, 1);
    expect(v[2]! * eye[0]! + v[6]! * eye[1]! + v[10]! * eye[2]! + v[14]!).toBeCloseTo(0, 1);
    // The cue at 0.5 s started "bend" on the arm.
    expect(channel.animation!.state().find((p) => p.object === 1)!.clip).toBe(0);
    run(channel, 61);
    // Ended, not holding: no camera or placements, nothing playing.
    expect(channel.timelineCamera()).toBeNull();
    expect(channel.timelinePlacements().size).toBe(0);
    expect(channel.timeline!.state().index).toBe(-1);
  });

  it("holds its last frame, or loops, when asked", () => {
    const held = new RuntimeChannel(scene([{ ...INTRO, autoplay: true, hold: true }]), null);
    run(held, 200);
    expect(held.timeline!.state()).toMatchObject({ index: 0, playing: false });
    expect(held.timelinePlacements().get(1)![13]).toBeCloseTo(3, 3);
    const looped = new RuntimeChannel(scene([{ ...INTRO, autoplay: true, loop: true }]), null);
    const fired = run(looped, 250); // just over two loops
    expect(fired.filter((e) => e === "0")).toHaveLength(2); // line1 at 1 s and 3 s (4.2 s in)
    expect(looped.timeline!.state().playing).toBe(true);
  });
});

describe.skipIf(!existsSync(ENGINE))("timelines driven from Lua (real engine)", () => {
  it("plays, reports, hears events and stops", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene([INTRO]);
    const code = `
t = 0
heard = ""
function TIC()
  t = t + 1
  if t == 1 then pmem(100, cartbox.timeline() == nil and 1 or 0) cartbox.playtimeline("intro") end
  for _, e in ipairs(cartbox.timelineevents()) do heard = heard .. e .. ";" end
  if t == 62 then
    local name, time, playing = cartbox.timeline()
    pmem(101, name == "intro" and 1 or 0) pmem(102, math.floor(time * 1000)) pmem(103, playing and 1 or 0)
    pmem(104, heard == "line1;" and 1 or 0)
  end
  if t == 70 then cartbox.stoptimeline() end
  if t == 72 then pmem(105, cartbox.timeline() == nil and 1 or 0) end
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
    for (let i = 0; i < 75; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
    }
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    expect(w(100)).toBe(1);
    expect(w(101)).toBe(1);
    expect(w(102) / 1000).toBeCloseTo(1, 1); // 60 steps after starting
    expect(w(103)).toBe(1);
    expect(w(104)).toBe(1);
    expect(w(105)).toBe(1);
    channel.destroy();
  }, 120_000);
});
