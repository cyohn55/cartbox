/**
 * Audio at run time (ENGINE_PARITY_ROADMAP.md EP12): the sound system on a
 * stand-in Web Audio context (sounds through their buses into the master,
 * positional ones through a panner, loops held in slots, the mixer, emitters
 * following their objects, speech spoken, the voice cap), cartbox.sound /
 * loop / mix from Lua through the real engine, the editor's audio, and
 * Lockout's sound.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_AUDIO, LOCKOUT_CODE, lockoutMeshSidecar, parseSceneAudio, serializeMeshAsset, type MeshAsset, type SceneAudio } from "@cartbox/editor";
import {
  MAX_VOICES,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  SoundSystem,
  codeChunks,
  injectSdk,
  parseMeshScene,
  physicsBlockAddress,
  runtimeSdkLua,
  sceneNeedsRuntime,
  sceneObjectsSdkLua,
  type SoundContext,
} from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar } from "../apps/web/src/lib/meshSidecar";
import { addEmitter, addFileSound, addSpeechSound, addSynthSound, audioOf, removeSound, setBusVolume, updateSound } from "../apps/web/src/lib/soundEdit";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

// --- A stand-in for the slice of Web Audio the sound system uses ---------------

class FakeParam {
  value = 0;
}
class FakeNode {
  readonly out = new Set<FakeNode>();
  connect(n: FakeNode) {
    this.out.add(n);
    return n;
  }
  disconnect() {
    this.out.clear();
  }
}
class FakeGain extends FakeNode {
  readonly kind = "gain";
  readonly gain = new FakeParam();
  constructor() {
    super();
    this.gain.value = 1;
  }
}
class FakePanner extends FakeNode {
  readonly kind = "panner";
  panningModel = "";
  distanceModel = "";
  refDistance = 0;
  maxDistance = 0;
  rolloffFactor = 0;
  readonly positionX = new FakeParam();
  readonly positionY = new FakeParam();
  readonly positionZ = new FakeParam();
}
class FakeSource extends FakeNode {
  readonly kind = "source";
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeParam();
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
function fakeContext() {
  const sources: FakeSource[] = [];
  const listener = { positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam(), forwardX: new FakeParam(), forwardY: new FakeParam(), forwardZ: new FakeParam(), upX: new FakeParam(), upY: new FakeParam(), upZ: new FakeParam() };
  const ctx = {
    currentTime: 0,
    sampleRate: 22050,
    listener,
    createGain: () => new FakeGain(),
    createPanner: () => new FakePanner(),
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
    createBuffer: (_c: number, length: number) => ({ length, copyToChannel() {} }),
    decodeAudioData: async () => {
      throw new Error("no codec in tests");
    },
  };
  return { ctx: ctx as unknown as SoundContext, sources, listener };
}
/** Follow a node's connections to the end: the chain of node kinds. */
function chain(n: FakeNode): string[] {
  const out: string[] = [];
  let at: FakeNode | undefined = n;
  while (at) {
    out.push((at as { kind?: string }).kind ?? "out");
    at = [...at.out][0];
  }
  return out;
}

const AUDIO: SceneAudio = parseSceneAudio({
  buses: [{ name: "sfx", volume: 0.8 }, { name: "ambience", volume: 0.5 }],
  sounds: [
    { name: "shot", source: { kind: "synth", synth: "rifle" }, bus: "sfx", volume: 0.9, range: [5, 50] },
    { name: "click", source: { kind: "synth", synth: "click" }, bus: "sfx", volume: 1 },
    { name: "wind", source: { kind: "synth", synth: "wind" }, bus: "ambience", volume: 1, loop: true, range: [10, 80] },
    { name: "hello", source: { kind: "speech", text: "Hello" }, bus: "sfx", volume: 0.5 },
    { name: "song", source: { kind: "file", mime: "audio/ogg", data: "T2dnUw==" }, bus: "sfx", volume: 1 },
  ],
  emitters: [{ sound: "wind", object: "tower", volume: 0.7 }, { sound: "click", volume: 1 }],
})!;

describe("the sound system", () => {
  it("plays a sound through its bus into the master; a positional one through a panner placed where asked", async () => {
    const { ctx, sources } = fakeContext();
    const output = new FakeGain();
    const spoken: string[] = [];
    const system = await SoundSystem.create(ctx, AUDIO, output as unknown as AudioNode, (id) => (id === "tower" ? 3 : -1), (text) => void spoken.push(text));
    const before = sources.length;
    system.play(1); // click: everywhere alike
    const click = sources[before]!;
    expect(click.started).toBe(true);
    expect(chain(click)).toEqual(["source", "gain", "gain", "gain", "gain"]); // voice gain → bus → master → output
    system.play(0, 1, 1.2, [10, 0, 5]); // shot, positional
    const shot = sources[before + 1]!;
    expect(chain(shot)).toEqual(["source", "gain", "panner", "gain", "gain", "gain"]);
    const panner = [...[...shot.out][0]!.out][0] as FakePanner;
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([10, 0, 5]);
    expect([panner.refDistance, panner.maxDistance, panner.distanceModel]).toEqual([5, 50, "linear"]);
    expect(shot.playbackRate.value).toBeCloseTo(1.2);
    // A positional sound with no position plays everywhere alike (no panner).
    system.play(0);
    expect(chain(sources.at(-1)!)).not.toContain("panner");
    // Speech goes to the browser's voice; a file that won't decode is silent (no source made).
    const count = sources.length;
    system.play(3);
    system.play(4);
    expect(spoken).toEqual(["Hello"]);
    expect(sources.length).toBe(count);
    system.dispose();
  });

  it("starts emitters looping, following their objects", async () => {
    const { ctx, sources } = fakeContext();
    const system = await SoundSystem.create(ctx, AUDIO, new FakeGain() as unknown as AudioNode, (id) => (id === "tower" ? 1 : -1), null);
    const wind = sources.find((s) => s.loop)!;
    expect(wind.started).toBe(true);
    const panner = [...[...wind.out][0]!.out][0] as FakePanner;
    expect(panner.kind).toBe("panner");
    const m = new Float32Array(16);
    m[12] = 4; m[13] = 5; m[14] = 6;
    system.follow([null, m]);
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([4, 5, 6]);
    // The emitter with no object loops everywhere alike.
    expect(sources.filter((s) => s.started).length).toBe(2);
    system.dispose();
    expect(wind.stopped).toBe(true);
  });

  it("holds loops in slots (same sound: moved and faded; another: swapped; none: stopped), sets buses, caps voices", async () => {
    const { ctx, sources } = fakeContext();
    const system = await SoundSystem.create(ctx, { ...AUDIO, emitters: [] }, new FakeGain() as unknown as AudioNode, () => -1, null);
    system.loop(2, 2, 0.5, [1, 2, 3]);
    const first = sources.at(-1)!;
    expect(first.loop).toBe(true);
    system.loop(2, 2, 0.8, [7, 2, 3]); // same: no new source
    expect(sources.at(-1)).toBe(first);
    expect(system.loopingSlots().get(2)).toBe(2);
    system.loop(2, 0, 1); // another sound: the old one stops
    expect(first.stopped).toBe(true);
    system.loop(2, -1);
    expect(system.loopingSlots().size).toBe(0);
    system.mix(1, 0.25);
    expect(system.busVolume(1)).toBe(0.25);
    system.mix(1, 9);
    expect(system.busVolume(1)).toBe(2);
    for (let i = 0; i < MAX_VOICES + 5; i += 1) system.play(1);
    expect(system.playing()).toBe(MAX_VOICES);
    expect(sources.filter((s) => s.stopped).length).toBeGreaterThanOrEqual(5);
    system.dispose();
  });

  it("hears from the camera", async () => {
    const { ctx, listener } = fakeContext();
    const system = await SoundSystem.create(ctx, AUDIO, new FakeGain() as unknown as AudioNode, () => -1, null);
    system.listen([1, 2, 3], [0, 0, -1], [0, 1, 0]);
    expect([listener.positionX.value, listener.positionY.value, listener.positionZ.value, listener.forwardZ.value, listener.upY.value]).toEqual([1, 2, 3, -1, 1]);
    system.dispose();
  });
});

/** A one-object sidecar carrying audio, as the runtime reads it. */
function scene() {
  const box: MeshAsset = { name: "box", primitives: [{ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: null, uvs: null, indices: new Uint32Array([0, 1, 2]), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null } }] };
  return parseMeshScene(JSON.stringify({ version: 2, meshes: [{ id: "a", name: "a", mesh: serializeMeshAsset(box), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }], audio: AUDIO }))!;
}

describe("from Lua", () => {
  it("is in the runtime when the scene has sounds, with the calls the cart uses", () => {
    const sc = scene();
    expect(sc.audio!.sounds).toHaveLength(5);
    expect(sceneNeedsRuntime(sc, { physics: false })).toBe(true);
    const lua = runtimeSdkLua(sc, RAM_LAYOUTS.xbox360, { physics: false });
    for (const call of ["cartbox.sound", "cartbox.loop", "cartbox.mix", "cartbox.sounds"]) expect(lua).toContain(call);
  });

  it.skipIf(!existsSync(ENGINE))("queues plays, loops (changes only) and mixes through the real engine", async () => {
    const layout = RAM_LAYOUTS.xbox360;
    const sc = scene();
    const code = `
t = 0
function TIC()
  t = t + 1
  if t == 2 then cartbox.sound("shot", 1, 2, 3, 0.5, 1.5) cartbox.sound(2) cartbox.sound("nope") end
  if t >= 3 and t <= 4 then cartbox.loop(3, "wind", 0.5, 4, 5, 6) end
  if t == 5 then cartbox.loop(3, nil) cartbox.mix("ambience", 0.25) pmem(100, #cartbox.sounds()) end
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
    for (let i = 1; i <= 6; i += 1) {
      channel.beforeTick(block());
      mod._cbx_tick(h, 0);
      channel.afterTick(block());
      seen.push(channel.takeSounds());
    }
    expect(seen[1]).toHaveLength(2);
    expect(seen[1]![0]).toMatchObject({ kind: "play", sound: 0, volume: 0.5 });
    const play = seen[1]![0]! as { pitch: number; at: number[] };
    expect(play.pitch).toBeCloseTo(1.5);
    expect(play.at.map((v) => +v.toFixed(3))).toEqual([1, 2, 3]);
    expect(seen[1]![1]).toMatchObject({ kind: "play", sound: 1, at: null });
    // The loop is sent once (the second tick's call is the same), then stopped.
    expect(seen[2]).toEqual([expect.objectContaining({ kind: "loop", slot: 2, sound: 2 })]);
    expect(seen[3]).toEqual([]);
    expect(seen[4]).toEqual([expect.objectContaining({ kind: "loop", slot: 2, sound: -1 }), expect.objectContaining({ kind: "mix", bus: 1 })]);
    expect(new Int32Array(mod.HEAPU8.buffer, base, 256)[100]).toBe(5);
    channel.destroy();
  });
});

describe("the editor", () => {
  it("adds synth, file and spoken sounds, renames them (emitters follow), mixes, and stores it all", () => {
    let sc = addMesh(emptyMeshSidecar(), { name: "x", primitives: [] }, "x").sidecar;
    sc = addSynthSound(sc, "rifle").sidecar;
    sc = addSynthSound(sc, "rifle").sidecar; // a second gets its own name
    sc = addSynthSound(sc, "wind").sidecar;
    sc = addSpeechSound(sc, "Double Kill!").sidecar;
    sc = addFileSound(sc, "theme", "audio/ogg", "T2dnUw==")!.sidecar;
    expect(addFileSound(sc, "notes", "text/plain", "AA==")).toBeNull();
    expect(audioOf(sc).sounds.map((s) => s.name)).toEqual(["rifle", "rifle 2", "wind", "double_kill", "theme"]);
    expect(audioOf(sc).sounds[2]).toMatchObject({ bus: "ambience", loop: true });
    sc = addEmitter(sc, { sound: "wind", volume: 0.5 });
    sc = updateSound(sc, "wind", { name: "gusts", volume: 0.4 });
    expect(audioOf(sc).emitters[0]!.sound).toBe("gusts");
    sc = setBusVolume(sc, "sfx", 0.3);
    const back = decodeMeshSidecar(encodeMeshSidecar(sc)!);
    expect(back.audio).toEqual(sc.audio);
    // Removing a sound takes its emitters; removing the last leaves no audio at all.
    sc = removeSound(sc, "gusts");
    expect(audioOf(sc).emitters).toHaveLength(0);
    for (const s of audioOf(sc).sounds) sc = removeSound(sc, s.name);
    expect(sc.audio).toBeUndefined();
  });
});

describe("Lockout", () => {
  it("ships its weapons, blasts, wind and announcer, and the code that plays them", () => {
    const stored = JSON.parse(lockoutMeshSidecar());
    expect(parseSceneAudio(stored.audio)).toEqual(LOCKOUT_AUDIO);
    for (const id of ["br", "smg", "shotgun", "sniper", "magnum", "sword"]) expect(LOCKOUT_AUDIO.sounds.some((s) => s.name === `fire_${id}`)).toBe(true);
    expect(LOCKOUT_AUDIO.emitters).toEqual([{ sound: "wind", volume: 1 }]);
    expect(LOCKOUT_CODE).toContain('cartbox.sound("fire_"..wid');
    expect(LOCKOUT_CODE).toContain('cartbox.sound("blast"');
    expect(LOCKOUT_CODE).toContain("cartbox.sound(VOX[txt])");
    // Every announcer line the code names is a sound.
    const vox = [...LOCKOUT_CODE.matchAll(/="(v\d|s\d+|jug)"/g)].map((m) => m[1]);
    for (const name of vox) expect(LOCKOUT_AUDIO.sounds.some((s) => s.name === name)).toBe(true);
  });
});
