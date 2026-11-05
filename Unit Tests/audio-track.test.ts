/**
 * The audio track (AAA_PRODUCTION_ROADMAP.md U1–U5): reverb zones, occlusion,
 * a mixer with routing, ducking, snapshots and a limiter, music layered on the
 * beat with stingers, and sound variation; the pure parts, the sound system on
 * a stand-in Web Audio context, and the cart's calls through the real engine.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  audioSwitches,
  blendSnapshot,
  chooseVariant,
  duckGain,
  nextBeat,
  occlusionFilter,
  parseSceneAudio,
  reverbImpulse,
  reverbSends,
  sabineDecay,
  seededRandom,
  serializeMeshAsset,
  zoneWeight,
  type MeshAsset,
  type ReverbZone,
  type SceneAudio,
} from "@cartbox/editor";
import { NET_WORDS, PHYS_BLOCK_BYTES, RAM_LAYOUTS, RuntimeChannel, SoundSystem, codeChunks, injectSdk, parseMeshScene, physicsBlockAddress, runtimeSdkLua, sceneObjectsSdkLua, type SoundContext } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

// --- A stand-in for Web Audio, with the track's nodes ---------------------------------------

class Param {
  value = 0;
}
class Node_ {
  readonly out = new Set<Node_>();
  connect(n: Node_) {
    this.out.add(n);
    return n;
  }
  disconnect() {
    this.out.clear();
  }
}
class Gain extends Node_ {
  readonly kind: string = "gain";
  readonly gain = new Param();
  constructor() {
    super();
    this.gain.value = 1;
  }
}
class Panner extends Node_ {
  readonly kind = "panner";
  panningModel = "";
  distanceModel = "";
  refDistance = 0;
  maxDistance = 0;
  rolloffFactor = 0;
  readonly positionX = new Param();
  readonly positionY = new Param();
  readonly positionZ = new Param();
}
class Source extends Node_ {
  readonly kind = "source";
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new Param();
  when = -1;
  onended: (() => void) | null = null;
  start(t: number) {
    this.when = t;
  }
  stop() {}
}
class Filter extends Node_ {
  readonly kind = "filter";
  type = "";
  readonly frequency = new Param();
}
class Convolver extends Node_ {
  readonly kind = "convolver";
  buffer: unknown = null;
}
class Compressor extends Node_ {
  readonly kind = "limiter";
  readonly threshold = new Param();
  readonly knee = new Param();
  readonly ratio = new Param();
  readonly attack = new Param();
  readonly release = new Param();
}
function context() {
  const sources: Source[] = [];
  const convolvers: Convolver[] = [];
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    listener: Object.fromEntries(["positionX", "positionY", "positionZ", "forwardX", "forwardY", "forwardZ", "upX", "upY", "upZ"].map((k) => [k, new Param()])),
    createGain: () => new Gain(),
    createPanner: () => new Panner(),
    createBufferSource: () => {
      const s = new Source();
      sources.push(s);
      return s;
    },
    createBuffer: (_c: number, length: number) => ({ length, copyToChannel() {} }),
    decodeAudioData: async () => {
      throw new Error("no codec");
    },
    createBiquadFilter: () => new Filter(),
    createConvolver: () => {
      const c = new Convolver();
      convolvers.push(c);
      return c;
    },
    createDynamicsCompressor: () => new Compressor(),
  };
  return { ctx, sound: ctx as unknown as SoundContext, sources, convolvers };
}
const kinds = (n: Node_): string[] => {
  const out: string[] = [];
  for (let at: Node_ | undefined = n; at; at = [...at.out][0]) out.push((at as { kind?: string }).kind ?? "out");
  return out;
};

const HALL: ReverbZone = { name: "hall", min: [0, 0, 0], max: [20, 10, 20], decay: 2, damping: 0.4, wet: 0.5, fade: 2 };

const AUDIO: SceneAudio = parseSceneAudio({
  buses: [
    { name: "master_fx", volume: 1 },
    { name: "sfx", volume: 0.8, parent: "master_fx" },
    { name: "voice", volume: 1 },
    { name: "music", volume: 0.7, duck: { by: "voice", amount: 0.3, attack: 0.1, release: 0.5 } },
  ],
  sounds: [
    { name: "step", source: { kind: "synth", synth: "click" }, bus: "sfx", volume: 1, range: [2, 30], variation: { variants: ["step2", "step3", "ghost"], choose: "random", pitch: 0.1, volume: 0.2 } },
    { name: "step2", source: { kind: "synth", synth: "click" }, bus: "sfx", volume: 1, range: [2, 30] },
    { name: "step3", source: { kind: "synth", synth: "click" }, bus: "sfx", volume: 1, range: [2, 30] },
    { name: "foot", source: { kind: "synth", synth: "click" }, bus: "sfx", volume: 1, variation: { choose: "switch", switchName: "surface", cases: { metal: "step2", grass: "step3" } } },
    { name: "line", source: { kind: "synth", synth: "click" }, bus: "voice", volume: 1 },
    { name: "drums", source: { kind: "synth", synth: "click" }, bus: "music", volume: 1, loop: true },
    { name: "bass", source: { kind: "synth", synth: "click" }, bus: "music", volume: 0.8, loop: true },
    { name: "hit", source: { kind: "synth", synth: "click" }, bus: "music", volume: 1 },
  ],
  snapshots: [{ name: "combat", buses: { music: 1, sfx: 1 } }, { name: "bad", buses: { nope: 1 } }],
  reverbZones: [HALL],
  occlusion: { strength: 1, smoothing: 0 },
  music: [{ name: "battle", bpm: 120, beats: 4, layers: ["drums", "bass", "missing"] }],
  limiter: -3,
})!;

describe("reading the audio track (U1–U5)", () => {
  it("keeps routing, ducking, snapshots, zones, occlusion, music and variation, and drops what names nothing", () => {
    expect(AUDIO.buses.map((b) => [b.name, b.parent ?? null, b.duck?.by ?? null])).toEqual([["master_fx", null, null], ["sfx", "master_fx", null], ["voice", null, null], ["music", null, "voice"]]);
    expect(AUDIO.snapshots).toEqual([{ name: "combat", buses: { music: 1, sfx: 1 } }, { name: "bad", buses: {} }]);
    expect(AUDIO.reverbZones).toEqual([HALL]);
    expect(AUDIO.music![0]!.layers).toEqual(["drums", "bass"]);
    expect(AUDIO.sounds[0]!.variation!.variants).toEqual(["step2", "step3"]); // "ghost" isn't a sound
    expect(audioSwitches(AUDIO)).toEqual([{ name: "surface", values: ["grass", "metal"] }]);
    expect(AUDIO.limiter).toBe(-3);
    // A loop of parents is cut.
    const loop = parseSceneAudio({ buses: [{ name: "a", volume: 1, parent: "b" }, { name: "b", volume: 1, parent: "a" }], sounds: [{ name: "s", source: { kind: "synth", synth: "click" }, bus: "a", volume: 1 }] })!;
    expect(loop.buses.some((b) => b.parent)).toBe(false);
  });
});

describe("the pure parts", () => {
  it("U1: decays as Sabine says, rings to -60 dB at its decay, and blends zones at their edges", () => {
    expect(sabineDecay([20, 10, 20], 0.05)).toBeGreaterThan(sabineDecay([4, 3, 4], 0.05)); // a hall rings longer than a room
    expect(sabineDecay([20, 10, 20], 0.05)).toBeGreaterThan(sabineDecay([20, 10, 20], 0.6)); // stone longer than curtains
    const [l, r] = reverbImpulse(8000, 1, 0.5, 3);
    expect(l.length).toBe(8000);
    const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(a.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));
    expect(20 * Math.log10(rms(l, 7600, 8000) / rms(l, 0, 400))).toBeLessThan(-40);
    expect(Array.from(l.slice(0, 50))).not.toEqual(Array.from(r.slice(0, 50))); // a channel each, for width
    expect(Array.from(reverbImpulse(8000, 1, 0.5, 3)[0].slice(0, 20))).toEqual(Array.from(l.slice(0, 20))); // seeded
    expect(zoneWeight(HALL, [10, 5, 10])).toBe(1);
    expect(zoneWeight(HALL, [1, 5, 10])).toBeCloseTo(0.5);
    expect(zoneWeight(HALL, [-1, 5, 10])).toBe(0);
    const cave: ReverbZone = { ...HALL, name: "cave", min: [10, 0, 0], max: [40, 10, 20], wet: 0.8 };
    const both = reverbSends([HALL, cave], [15, 5, 10]);
    expect(both[0]! / HALL.wet + both[1]! / cave.wet).toBeCloseTo(1); // overlapping zones crossfade
  });

  it("U2: muffles and quietens as walls come between, easing toward it", () => {
    expect(occlusionFilter(0)).toEqual({ cutoff: 20000, gain: 1 });
    const behind = occlusionFilter(1);
    expect(behind.cutoff).toBeCloseTo(500);
    expect(20 * Math.log10(behind.gain)).toBeCloseTo(-12);
  });

  it("U3: ducks in over its attack and out over its release; snapshots blend only the buses they name", () => {
    const duck = { by: "voice", amount: 0.3, attack: 0.1, release: 0.5 };
    let g = 1;
    for (let i = 0; i < 30; i += 1) g = duckGain(g, duck, true, 1 / 60);
    expect(g).toBeCloseTo(0.3, 1);
    for (let i = 0; i < 6; i += 1) g = duckGain(g, duck, false, 1 / 60);
    expect(g).toBeLessThan(0.5); // releasing slowly
    const blended = blendSnapshot({ music: 0.2, sfx: 0.5, voice: 1 }, { name: "c", buses: { music: 1 } }, 0.5);
    expect(blended.music).toBeCloseTo(0.6);
    expect([blended.sfx, blended.voice]).toEqual([0.5, 1]);
  });

  it("U4: lands a change on the next beat or bar", () => {
    expect(nextBeat(0.1, 0, 120)).toBeCloseTo(0.5);
    expect(nextBeat(0.1, 0, 120, 4)).toBeCloseTo(2);
    expect(nextBeat(2, 0, 120, 4)).toBeCloseTo(2);
  });

  it("U5: picks variants without repeats, in sequence, or by switch, with seeded spread", () => {
    const random = seededRandom(9);
    const state = { last: new Map<string, number>(), switches: new Map<string, string>() };
    const v = { variants: ["b", "c"], choose: "random" as const, pitch: 0.1, volume: 0 };
    const picks = Array.from({ length: 30 }, () => chooseVariant("a", v, state, random));
    for (let i = 1; i < picks.length; i += 1) expect(picks[i]!.sound).not.toBe(picks[i - 1]!.sound);
    expect(new Set(picks.map((p) => p.sound))).toEqual(new Set(["a", "b", "c"]));
    expect(picks.every((p) => p.pitch >= 0.9 && p.pitch <= 1.1 && p.volume === 1)).toBe(true);
    const seq = { ...v, choose: "sequence" as const };
    expect(Array.from({ length: 4 }, () => chooseVariant("x", seq, state, random).sound)).toEqual(["x", "b", "c", "x"]);
    const sw = { variants: [], choose: "switch" as const, switchName: "surface", cases: { metal: "m" }, pitch: 0, volume: 0 };
    expect(chooseVariant("f", sw, state, random).sound).toBe("f");
    state.switches.set("surface", "metal");
    expect(chooseVariant("f", sw, state, random).sound).toBe("m");
  });
});

describe("the sound system with the track (U1–U5)", () => {
  async function make() {
    const c = context();
    const output = new Gain();
    const system = await SoundSystem.create(c.sound, AUDIO, output as unknown as AudioNode, () => -1, null);
    return { ...c, system, output };
  }

  it("routes buses into their parents, through a limiter, and sends to the hall's reverb by where the listener is", async () => {
    const { system, sources, convolvers, ctx } = await make();
    system.play(4); // "line", on voice
    expect(kinds(sources[sources.length - 1]!)).toEqual(["source", "gain", "gain", "gain", "limiter", "gain"]);
    system.play(2); // "step3" on sfx, into master_fx
    expect(kinds(sources[sources.length - 1]!).slice(0, 5)).toEqual(["source", "gain", "gain", "gain", "gain"]);
    expect(convolvers).toHaveLength(1);
    system.listen([10, 5, 10], [0, 0, -1], [0, 1, 0]);
    system.update(1 / 60);
    const zoneLevel = (system as unknown as { zoneSends: Gain[] }).zoneSends[0]!;
    expect(zoneLevel.gain.value).toBeCloseTo(0.5);
    system.listen([100, 5, 10], [0, 0, -1], [0, 1, 0]);
    system.update(1 / 60);
    expect(zoneLevel.gain.value).toBe(0);
    expect(ctx.sampleRate).toBe(8000);
  });

  it("ducks the music while a line plays, and blends to a snapshot over its time", async () => {
    const { system } = await make();
    const music = 3;
    system.play(4); // a line on voice
    for (let i = 0; i < 30; i += 1) system.update(1 / 60);
    expect(system.duckLevel(music)).toBeCloseTo(0.3, 1);
    expect(system.busVolume(music)).toBeCloseTo(0.7 * system.duckLevel(music), 5);
    system.snapshot(0, 1);
    for (let i = 0; i < 30; i += 1) system.update(1 / 60);
    const mid = (system as unknown as { levels: number[] }).levels[music]!;
    expect(mid).toBeGreaterThan(0.75);
    expect(mid).toBeLessThan(0.95);
    for (let i = 0; i < 40; i += 1) system.update(1 / 60);
    expect((system as unknown as { levels: number[] }).levels[music]).toBe(1);
  });

  it("muffles a positional sound behind a wall", async () => {
    const { system, sources } = await make();
    system.setOccluder((_from, to) => (to[0] > 5 ? 1 : 0));
    system.play(1, 1, 1, [10, 0, 0]); // "step2", behind the wall
    const filter = [...sources[sources.length - 1]!.out][0]!.out;
    const node = [...filter][0] as Filter;
    expect(node.kind).toBe("filter");
    system.update(1 / 60);
    expect(node.frequency.value).toBeCloseTo(500);
    system.play(1, 1, 1, [2, 0, 0]); // in the open
    const open = [...[...sources[sources.length - 1]!.out][0]!.out][0] as Filter;
    system.update(1 / 60);
    expect(open.frequency.value).toBe(20000);
  });

  it("plays a sound's variants (never the same twice running) and the switch's case", async () => {
    const { system, sources } = await make();
    const played = (n: number) => {
      const before = sources.length;
      system.play(n, 1, 1, [0, 0, 0]);
      return sources[before]!;
    };
    const buffers = Array.from({ length: 12 }, () => played(0).buffer);
    for (let i = 1; i < buffers.length; i += 1) expect(buffers[i]).not.toBe(buffers[i - 1]);
    system.setSwitch("surface", "grass");
    const grass = played(3).buffer;
    system.setSwitch("surface", "metal");
    expect(played(3).buffer).not.toBe(grass);
  });

  it("starts a music track's layers together, brings one in on the next bar, and lands a stinger on the beat", async () => {
    const { system, sources, ctx } = await make();
    ctx.currentTime = 10;
    system.playMusic(0, true);
    const layers = sources.slice(-2);
    expect(layers.map((s) => s.when)).toEqual([10, 10]);
    const bassGain = [...layers[1]!.out][0] as Gain;
    expect(bassGain.gain.value).toBe(0);
    ctx.currentTime = 10.3;
    system.musicLayer(0, 1, true);
    system.update(1 / 60);
    expect(bassGain.gain.value).toBe(0); // waiting for the bar (at 12 s: 4 beats at 120 bpm)
    ctx.currentTime = 12;
    system.update(1 / 60);
    expect(bassGain.gain.value).toBeCloseTo(0.8);
    ctx.currentTime = 12.1;
    system.stinger(7);
    expect(sources[sources.length - 1]!.when).toBeCloseTo(12.5);
  });
});

describe.skipIf(!existsSync(ENGINE))("from Lua (U1–U5)", () => {
  it("sends snapshots, music, layers, stingers and switches through the real engine", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const box: MeshAsset = { name: "box", primitives: [{ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: new Uint32Array([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
    const sc = parseMeshScene(JSON.stringify({ version: 2, meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(box), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], audio: AUDIO }))!;
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.snapshot("combat", 1.5) cartbox.music("battle") cartbox.layer("battle", 2, true) cartbox.stinger("hit") cartbox.switch("surface", "metal") cartbox.switch("surface", "lava") end
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
    const seen: ReturnType<RuntimeChannel["takeSounds"]>[] = [];
    for (let i = 1; i <= 3; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push(channel.takeSounds());
    }
    const audio = seen[1]!.map((c) => (c.kind === "audio" ? [c.what, c.index, ...c.v.map((v) => +v.toFixed(2))] : null));
    expect(audio).toEqual([
      [1, 0, 1.5, 0], // snapshot "combat" over 1.5 s
      [2, 0, 1, 0], // music "battle" on
      [3, 0, 1, 1], // its second layer in
      [4, 7, 0, 0], // stinger "hit"
      [5, 0, 1, 0], // switch "surface" = "metal" (values sorted: grass, metal); "lava" is no case
    ]);
    channel.destroy();
  });
});
