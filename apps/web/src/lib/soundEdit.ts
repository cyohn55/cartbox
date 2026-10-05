/**
 * Editing the scene's audio in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP12):
 * adding sounds (an imported file, a synth preset, a spoken line), changing
 * them, renaming them (emitters follow), the mixer's buses, and emitters.
 * Every change goes back through parseSceneAudio, so what's stored is always
 * what the runtime reads. See sound.ts in @cartbox/editor.
 */

import { DEFAULT_BUSES, MAX_SOUND_FILE_BYTES, parseSceneAudio, type SceneAudio, type SceneSound, type SoundEmitter, type SynthPreset } from "@cartbox/editor";

import { setMeshAudio, type MeshSidecar } from "./meshSidecar";

const empty = (): SceneAudio => ({ sounds: [], buses: [...DEFAULT_BUSES], emitters: [] });

/** The scene's audio, or an empty one with the default buses. */
export function audioOf(sidecar: MeshSidecar): SceneAudio {
  return sidecar.audio ?? empty();
}

/** Store audio, normalised (nothing left = no audio at all). */
function store(sidecar: MeshSidecar, audio: SceneAudio): MeshSidecar {
  return setMeshAudio(sidecar, parseSceneAudio(audio));
}

/** A name not yet taken: `base`, `base 2`, `base 3`… */
export function freeSoundName(audio: SceneAudio, base: string): string {
  const taken = new Set(audio.sounds.map((s) => s.name));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k += 1) if (!taken.has(`${base} ${k}`)) return `${base} ${k}`;
}

function add(sidecar: MeshSidecar, sound: Omit<SceneSound, "name"> & { name: string }): { sidecar: MeshSidecar; name: string } {
  const audio = audioOf(sidecar);
  const name = freeSoundName(audio, sound.name);
  return { sidecar: store(sidecar, { ...audio, sounds: [...audio.sounds, { ...sound, name }] }), name };
}

/** Add a built-in synth sound (looping ones go to the ambience bus, the rest to sfx). */
export function addSynthSound(sidecar: MeshSidecar, preset: SynthPreset): { sidecar: MeshSidecar; name: string } {
  const ambient = preset === "wind";
  return add(sidecar, { name: preset, source: { kind: "synth", synth: preset }, bus: ambient ? "ambience" : "sfx", volume: 1, ...(ambient ? { loop: true } : { range: [4, 60] as [number, number] }) });
}

/** Add an imported file (its bytes as base64). Null when it's too big or not audio. */
export function addFileSound(sidecar: MeshSidecar, name: string, mime: string, base64: string): { sidecar: MeshSidecar; name: string } | null {
  if (!/^audio\//.test(mime) || (base64.length * 3) / 4 > MAX_SOUND_FILE_BYTES) return null;
  return add(sidecar, { name: name || "sound", source: { kind: "file", mime, data: base64 }, bus: "sfx", volume: 1, range: [4, 60] });
}

/** Add a line the browser reads aloud (an announcer). */
export function addSpeechSound(sidecar: MeshSidecar, text: string): { sidecar: MeshSidecar; name: string } {
  const name = text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "line";
  return add(sidecar, { name, source: { kind: "speech", text: text.trim(), pitch: 0.6, rate: 0.9 }, bus: "voice", volume: 1 });
}

/** Change a sound's settings; a new name carries its emitters along. */
export function updateSound(sidecar: MeshSidecar, name: string, patch: Partial<SceneSound>): MeshSidecar {
  const audio = audioOf(sidecar);
  const renamed = patch.name !== undefined && patch.name !== name ? freeSoundName(audio, patch.name) : name;
  const sounds = audio.sounds.map((s) => {
    if (s.name !== name) return s;
    const next = { ...s, ...patch, name: renamed } as SceneSound & { range?: unknown };
    if ("range" in patch && patch.range === undefined) delete next.range;
    return next as SceneSound;
  });
  const emitters = audio.emitters.map((e) => (e.sound === name ? { ...e, sound: renamed } : e));
  return store(sidecar, { ...audio, sounds, emitters });
}

/** Remove a sound and the emitters that played it. */
export function removeSound(sidecar: MeshSidecar, name: string): MeshSidecar {
  const audio = audioOf(sidecar);
  return store(sidecar, { ...audio, sounds: audio.sounds.filter((s) => s.name !== name), emitters: audio.emitters.filter((e) => e.sound !== name) });
}

export function setBusVolume(sidecar: MeshSidecar, bus: string, volume: number): MeshSidecar {
  const audio = audioOf(sidecar);
  return store(sidecar, { ...audio, buses: audio.buses.map((b) => (b.name === bus ? { ...b, volume } : b)) });
}

export function addEmitter(sidecar: MeshSidecar, emitter: SoundEmitter): MeshSidecar {
  const audio = audioOf(sidecar);
  return store(sidecar, { ...audio, emitters: [...audio.emitters, emitter] });
}

export function updateEmitter(sidecar: MeshSidecar, index: number, patch: Partial<SoundEmitter>): MeshSidecar {
  const audio = audioOf(sidecar);
  return store(sidecar, {
    ...audio,
    emitters: audio.emitters.map((e, i) => {
      if (i !== index) return e;
      const next = { ...e, ...patch } as SoundEmitter & { object?: string };
      if ("object" in patch && !patch.object) delete next.object;
      return next;
    }),
  });
}

export function removeEmitter(sidecar: MeshSidecar, index: number): MeshSidecar {
  const audio = audioOf(sidecar);
  return store(sidecar, { ...audio, emitters: audio.emitters.filter((_, i) => i !== index) });
}
