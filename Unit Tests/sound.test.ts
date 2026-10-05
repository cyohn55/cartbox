/**
 * Audio (ENGINE_PARITY_ROADMAP.md EP12): the synthesiser (deterministic, the
 * envelope and filter doing what they say, loops without a seam), the presets,
 * and reading a scene's sounds, buses and emitters defensively.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_BUSES, SYNTH_PRESETS, parseSceneAudio, resolveSynth, synthesizeSound, type SynthSound } from "@cartbox/editor";

const RATE = 22050;
const rms = (s: Float32Array, from = 0, to = s.length) => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += s[i]! * s[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};
/** How often the signal crosses zero per second: a rough measure of brightness / pitch. */
const crossings = (s: Float32Array, from: number, to: number) => {
  let n = 0;
  for (let i = from + 1; i < to; i += 1) if ((s[i - 1]! < 0) !== (s[i]! < 0)) n += 1;
  return (n / (to - from)) * RATE;
};

describe("the synthesiser", () => {
  it("renders the same samples for the same recipe, within ±1, at the asked length", () => {
    const a = synthesizeSound(SYNTH_PRESETS.rifle, RATE);
    expect(Array.from(a.slice(0, 500))).toEqual(Array.from(synthesizeSound(SYNTH_PRESETS.rifle, RATE).slice(0, 500)));
    expect(a.length).toBe(Math.round(0.45 * RATE));
    expect(a.every((v) => Math.abs(v) <= 1)).toBe(true);
    expect(rms(a)).toBeGreaterThan(0.02);
  });

  it("follows its envelope: loud at the start of a shot, gone by the end", () => {
    const s = synthesizeSound(SYNTH_PRESETS.shotgun, RATE);
    expect(rms(s, 0, RATE * 0.05)).toBeGreaterThan(rms(s, RATE * 0.6, RATE * 0.8) * 10);
    // A delayed voice is silent before its delay.
    const delayed: SynthSound = { duration: 0.5, voices: [{ wave: "sine", freq: [440, 440], attack: 0.001, delay: 0.25, volume: 0.5 }] };
    const d = synthesizeSound(delayed, RATE);
    expect(rms(d, 0, RATE * 0.24)).toBe(0);
    expect(rms(d, RATE * 0.3, RATE * 0.45)).toBeGreaterThan(0.2);
  });

  it("sweeps pitch and filter: a laser falls, a swing brightens", () => {
    const laser = synthesizeSound({ duration: 0.4, voices: [{ wave: "sine", freq: [2000, 200], attack: 0.001, volume: 0.5 }] }, RATE);
    expect(crossings(laser, 0, RATE * 0.05)).toBeGreaterThan(crossings(laser, RATE * 0.33, RATE * 0.38) * 3);
    const swing = synthesizeSound({ duration: 0.4, voices: [{ wave: "noise", cutoff: [300, 6000], attack: 0.001, volume: 0.5 }] }, RATE);
    expect(crossings(swing, RATE * 0.3, RATE * 0.38)).toBeGreaterThan(crossings(swing, 0, RATE * 0.08) * 2);
  });

  it("makes a loop with no seam: its end runs into its start", () => {
    const wind = synthesizeSound(SYNTH_PRESETS.wind, RATE);
    expect(wind.length).toBeLessThan(SYNTH_PRESETS.wind.duration * RATE); // the crossfaded tail folded in
    const jump = Math.abs(wind[wind.length - 1]! - wind[0]!);
    // No bigger than a typical step between neighbouring samples.
    let step = 0;
    for (let i = 1; i < 2000; i += 1) step = Math.max(step, Math.abs(wind[i]! - wind[i - 1]!));
    expect(jump).toBeLessThanOrEqual(step * 1.5);
    expect(rms(wind)).toBeGreaterThan(0.02);
  });

  it("renders every preset", () => {
    for (const [name, recipe] of Object.entries(SYNTH_PRESETS)) {
      const s = synthesizeSound(recipe, RATE);
      expect(rms(s), name).toBeGreaterThan(0.005);
      expect(resolveSynth(name)).toBe(recipe);
    }
    expect(resolveSynth("kazoo")).toBeNull();
  });
});

describe("reading a scene's audio", () => {
  it("keeps valid sounds, buses and emitters and drops the rest", () => {
    const audio = parseSceneAudio({
      buses: [{ name: "sfx", volume: 0.8 }, { name: "sfx" }, { name: "voice", volume: 9 }],
      sounds: [
        { name: "shot", source: { kind: "synth", synth: "rifle" }, bus: "sfx", volume: 1, range: [40, 2] },
        { name: "shot", source: { kind: "synth", synth: "rifle" } }, // duplicate name
        { name: "boom", source: { kind: "synth", synth: "kazoo" } }, // unknown preset
        { name: "hi", source: { kind: "speech", text: "Double kill" }, bus: "nope" },
        { name: "song", source: { kind: "file", mime: "audio/ogg", data: "T2dnUw==" }, bus: "voice", loop: true },
        { name: "bad", source: { kind: "file", mime: "text/plain", data: "AA==" } },
      ],
      emitters: [{ sound: "song", object: "map", volume: 0.5 }, { sound: "missing" }],
    })!;
    expect(audio.buses).toEqual([{ name: "sfx", volume: 0.8 }, { name: "voice", volume: 2 }]);
    expect(audio.sounds.map((s) => s.name)).toEqual(["shot", "hi", "song"]);
    expect(audio.sounds[0]!.range).toEqual([2, 40]); // ordered
    expect(audio.sounds[1]!.bus).toBe("sfx"); // an unknown bus falls back to the first
    expect(audio.emitters).toEqual([{ sound: "song", object: "map", volume: 0.5 }]);
  });

  it("gives a scene with no buses the defaults, and a scene with no sounds nothing", () => {
    expect(parseSceneAudio({ sounds: [{ name: "a", source: { kind: "synth", synth: "click" } }] })!.buses).toEqual(DEFAULT_BUSES);
    expect(parseSceneAudio({ sounds: [] })).toBeNull();
    expect(parseSceneAudio(null)).toBeNull();
  });
});
