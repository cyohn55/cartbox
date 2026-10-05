/**
 * Animation authoring (ENGINE_PARITY_ROADMAP.md EP17): per-key easing curves,
 * value tracks (a named number keyed over time, read by the cart and, for
 * `bus:` names, setting a mixer bus), and clip editing (trim, speed, reverse,
 * rename, duplicate, delete). Covers the maths, defensive reading, the
 * runtime in the real engine, the visual-script node, and Lockout's intro.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_INTRO,
  addMeshClip,
  compileScriptGraph,
  easeCurve,
  readTimelines,
  renameMeshClip,
  retimeClip,
  reverseClip,
  sampleCamera,
  sampleValues,
  serializeMeshAsset,
  setMeshClip,
  timelineValueNames,
  trimClip,
  type AnimationClip,
  type MeshAsset,
  type SceneTimeline,
} from "@cartbox/editor";
import { NET_WORDS, PHYS_BLOCK_BYTES, RAM_LAYOUTS, RuntimeChannel, codeChunks, injectSdk, parseMeshScene, physicsBlockAddress, runtimeSdkLua, sceneObjectsSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

describe("easing curves", () => {
  it("run from (0,0) to (1,1); a straight curve is linear; ease-in starts slow and ease-out fast; overshoot passes 1", () => {
    for (const c of [[0.42, 0, 0.58, 1], [0.34, 1.56, 0.64, 1]] as const) {
      expect(easeCurve(c, 0)).toBeCloseTo(0, 5);
      expect(easeCurve(c, 1)).toBeCloseTo(1, 5);
    }
    for (const u of [0.1, 0.37, 0.8]) expect(easeCurve([0.25, 0.25, 0.75, 0.75], u)).toBeCloseTo(u, 3);
    expect(easeCurve([0.42, 0, 1, 1], 0.3)).toBeLessThan(0.3);
    expect(easeCurve([0, 0, 0.58, 1], 0.3)).toBeGreaterThan(0.3);
    expect(Math.max(...[0.5, 0.6, 0.7, 0.8].map((u) => easeCurve([0.34, 1.56, 0.64, 1], u)))).toBeGreaterThan(1);
  });

  it("ease a camera key between keys", () => {
    const [tl] = readTimelines([
      {
        name: "c",
        duration: 2,
        tracks: [{ kind: "camera", keys: [{ time: 0, eye: [0, 0, 0], target: [0, 0, 0], fov: 50, ease: "curve", curve: [0.42, 0, 1, 1] }, { time: 2, eye: [10, 0, 0], target: [0, 0, 0], fov: 50, ease: "linear" }] }],
      },
    ]);
    const x = sampleCamera(tl!, 1)!.eye[0];
    expect(x).toBeCloseTo(10 * easeCurve([0.42, 0, 1, 1], 0.5), 3);
  });
});

const VALUES: SceneTimeline = {
  name: "v",
  duration: 4,
  loop: false,
  autoplay: false,
  hold: false,
  tracks: [
    { kind: "value", name: "fade", keys: [{ time: 0, value: 0, ease: "linear" }, { time: 2, value: 1, ease: "step" }, { time: 3, value: 5, ease: "linear" }] },
    { kind: "value", name: "bus:music", keys: [{ time: 0, value: 1, ease: "linear" }, { time: 4, value: 0, ease: "linear" }] },
  ],
};

describe("value tracks", () => {
  it("read defensively: names that fit, values clamped, curve handles kept in range", () => {
    const [tl] = readTimelines([
      {
        name: "x",
        duration: 1,
        tracks: [
          { kind: "value", name: "ok", keys: [{ time: 0.5, value: 1e9, ease: "curve", curve: [2, -5, -1, 9] }, { time: 0.2, value: 1, ease: "nope" }] },
          { kind: "value", name: "bad name!", keys: [] },
          { kind: "value", name: "bus:sfx", keys: [] },
        ],
      },
    ]);
    expect(tl!.tracks.map((t) => (t.kind === "value" ? t.name : t.kind))).toEqual(["ok", "bus:sfx"]);
    const keys = (tl!.tracks[0] as Extract<SceneTimeline["tracks"][number], { kind: "value" }>).keys;
    expect(keys[0]).toEqual({ time: 0.2, value: 1, ease: "smooth" });
    expect(keys[1]).toEqual({ time: 0.5, value: 1e6, ease: "curve", curve: [1, -1, 0, 2] });
  });

  it("sample between keys (linear, held by step), and name every track across timelines", () => {
    expect(sampleValues(VALUES, 1).get("fade")).toBeCloseTo(0.5);
    expect(sampleValues(VALUES, 2.5).get("fade")).toBeCloseTo(1);
    expect(sampleValues(VALUES, 3.5).get("fade")).toBeCloseTo(5);
    expect(sampleValues(VALUES, 1).get("bus:music")).toBeCloseTo(0.75);
    expect(timelineValueNames([VALUES, LOCKOUT_INTRO])).toEqual(["bus:ambience", "bus:music", "fade", "letterbox"]);
  });
});

describe.skipIf(!existsSync(ENGINE))("value tracks from Lua (real engine)", () => {
  it("reads a playing timeline's values, nil for an unknown name or when none plays, and hands the host bus values", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const tf = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
    const box: MeshAsset = { name: "b", primitives: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: Uint32Array.from([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
    const sc = parseMeshScene(JSON.stringify({ version: 2, lighting: null, meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(box), transform: tf }], timelines: [VALUES] }))!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 1 then pmem(100, cartbox.timelinevalue("fade") == nil and 1 or 0) cartbox.playtimeline("v") end
  if t == 62 then pmem(101, math.floor((cartbox.timelinevalue("fade") or -1) * 1000)) pmem(102, cartbox.timelinevalue("nope") == nil and 1 or 0) end
end`;
    let tic = codeChunks(new TextEncoder().encode(code));
    tic = prependLuaCode(tic, sceneObjectsSdkLua(sc));
    tic = injectSdk(prependLuaCode(tic, runtimeSdkLua(sc, layout, { physics: false })));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const channel = new RuntimeChannel(sc, null);
    const base = mod._cbx_mailbox_ptr(h) - NET_WORDS * 4;
    const block = () => new DataView(mod.HEAPU8.buffer, base + physicsBlockAddress(layout) - layout.pmemAddress, PHYS_BLOCK_BYTES);
    for (let i = 0; i < 64; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
    }
    const w = (i: number) => new Int32Array(mod.HEAPU8.buffer, base, 256)[i]!;
    expect(w(100)).toBe(1);
    expect(w(101) / 1000).toBeCloseTo(0.5, 1); // about 1 s in
    expect(w(102)).toBe(1);
    expect(channel.timelineValues().get("bus:music")).toBeCloseTo(0.74, 1);
    channel.destroy();
  });
});

/** A one-joint clip: translation x from 0 to 4 over 4 s (keys each second). */
const CLIP: AnimationClip = {
  name: "walk",
  duration: 4,
  channels: [{ joint: 0, path: "translation", interpolation: "linear", times: Float32Array.from([0, 1, 2, 3, 4]), values: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0, 4, 0, 0]) }],
};
const xs = (c: AnimationClip) => Array.from(c.channels[0]!.values).filter((_, i) => i % 3 === 0).map((v) => Math.round(v * 100) / 100);

describe("clip editing", () => {
  it("trims a span into a clip of its own, with the ends exactly where the motion was", () => {
    const cut = trimClip(CLIP, 1.5, 3.25, "cut");
    expect(cut.name).toBe("cut");
    expect(cut.duration).toBeCloseTo(1.75);
    expect(Array.from(cut.channels[0]!.times).map((t) => Math.round(t * 100) / 100)).toEqual([0, 0.5, 1.5, 1.75]);
    expect(xs(cut)).toEqual([1.5, 2, 3, 3.25]);
  });

  it("changes speed, plays backwards, and renames, duplicates and deletes on the mesh (names kept unique)", () => {
    const fast = retimeClip(CLIP, 2);
    expect(fast.duration).toBe(2);
    expect(Array.from(fast.channels[0]!.times)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(xs(reverseClip(CLIP))).toEqual([4, 3, 2, 1, 0]);
    expect(Array.from(reverseClip(CLIP).channels[0]!.times)).toEqual([0, 1, 2, 3, 4]);
    let mesh: MeshAsset = { name: "m", primitives: [], clips: [CLIP, { ...CLIP, name: "run" }] };
    mesh = addMeshClip(mesh, { ...CLIP });
    expect(mesh.clips!.map((c) => c.name)).toEqual(["walk", "run", "walk 2"]);
    mesh = renameMeshClip(mesh, 2, "run");
    expect(mesh.clips![2]!.name).toBe("run 2");
    mesh = setMeshClip(mesh, 0, null);
    expect(mesh.clips!.map((c) => c.name)).toEqual(["run", "run 2"]);
    // Nothing shared: editing a copy leaves the original's keys alone.
    retimeClip(CLIP, 3).channels[0]!.values[0] = 99;
    expect(CLIP.channels[0]!.values[0]).toBe(0);
  });
});

describe("visual scripting", () => {
  it("reads a timeline value with a node", () => {
    const lua = compileScriptGraph({
      variables: [{ name: "v", type: "number", value: 0 }],
      nodes: [
        { id: "t", kind: "onTick", x: 0, y: 0 },
        { id: "s", kind: "setVar", x: 0, y: 0, param: "v" },
        { id: "g", kind: "timelineValue", x: 0, y: 0, param: "fade" },
      ],
      wires: [{ from: "t", fromPin: "then", to: "s", toPin: "in" }, { from: "g", fromPin: "value", to: "s", toPin: "value" }],
    });
    expect(lua).toContain('self.v = (cartbox.timelinevalue("fade") or 0)');
  });
});

describe("Lockout", () => {
  it("slides the intro's letterbox in and out from a value track, and fades the wind up on the ambience bus", () => {
    const tracks = LOCKOUT_INTRO.tracks.flatMap((t) => (t.kind === "value" ? [t.name] : []));
    expect(tracks).toEqual(["letterbox", "bus:ambience"]);
    expect(sampleValues(LOCKOUT_INTRO, 0).get("letterbox")).toBe(0);
    expect(sampleValues(LOCKOUT_INTRO, 0.4).get("letterbox")!).toBeGreaterThan(0.8); // eased out: quick, then settling
    expect(sampleValues(LOCKOUT_INTRO, 4).get("letterbox")).toBe(1);
    expect(sampleValues(LOCKOUT_INTRO, 7.5).get("letterbox")).toBe(0);
    expect(sampleValues(LOCKOUT_INTRO, 3).get("bus:ambience")).toBeCloseTo(0.5);
    expect(LOCKOUT_CODE).toContain('cartbox.timelinevalue("letterbox")');
  });
});
