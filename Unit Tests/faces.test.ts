/**
 * Faces (AAA_FIDELITY_ROADMAP.md F7b): ARKit's 52 shapes matched to a mesh's
 * targets; face animation from glTF weight channels and Live Link Face CSV;
 * lip sync from phonemes and from audio (formants by LPC); gaze by saccades
 * with blinks; and the runtime driving a face's morph weights.
 */

import { describe, expect, it } from "vitest";

import {
  ARKIT_SHAPES,
  EYE_RANGE,
  Gaze,
  VISEME_BLEND,
  analyzeSpeech,
  arkitIndex,
  deserializeMeshAsset,
  encodeGlb,
  faceRig,
  faceWeights,
  formants,
  frameViseme,
  gazeWeights,
  layerFace,
  lipSyncWeights,
  lpc,
  parseGlb,
  parseLiveLinkFaceCsv,
  parseTimecode,
  phonemeViseme,
  sampleFace,
  sampleMorphs,
  saccadeDuration,
  serializeMeshAsset,
  visemesFromAudio,
  visemesFromPhonemes,
  parseGltfText,
  type MeshAsset,
  type MeshScene,
  type MorphTarget,
} from "@cartbox/editor";
import { AnimationSession, FaceDriver } from "@cartbox/player";

import { skinnedArmGltf } from "./helpers/skinnedGltf";

const shape = (name: (typeof ARKIT_SHAPES)[number]) => ARKIT_SHAPES.indexOf(name);

/** A triangle with the named targets (each lifting one vertex). */
function face(names: string[], extra: Partial<MeshAsset> = {}): MeshAsset {
  const targets: MorphTarget[] = names.map((name, i) => {
    const positions = new Float32Array(9);
    positions[(i % 3) * 3 + 1] = 0.1;
    return { name, positions };
  });
  return {
    name: "face",
    primitives: [
      {
        positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 0, 1]),
        indices: Uint32Array.from([0, 1, 2]),
        material: { name: "skin", baseColorFactor: [1, 1, 1, 1], baseColorImage: null },
        morphTargets: targets,
      },
    ],
    ...extra,
  } as unknown as MeshAsset;
}

describe("the rig standard", () => {
  it("has ARKit's 52 shapes, and reads their usual spellings", () => {
    expect(ARKIT_SHAPES).toHaveLength(52);
    for (const name of ["eyeBlinkLeft", "eyeBlink_L", "EyeBlinkLeft", "eye_blink_left", "blendShape1.eyeBlinkLeft", "ARKit_eyeBlink_L"]) expect(arkitIndex(name)).toBe(shape("eyeBlinkLeft"));
    expect(arkitIndex("jawOpen")).toBe(shape("jawOpen"));
    expect(arkitIndex("smile")).toBe(-1);
  });

  it("matches a mesh's targets and drives them by ARKit weights, keeping the rest", () => {
    const mesh = face(["JawOpen", "custom", "mouthSmile_L"]);
    const rig = faceRig(mesh);
    expect(rig.matched).toBe(2);
    expect(rig.targets[shape("jawOpen")]).toBe(0);
    expect(rig.targets[shape("mouthSmileLeft")]).toBe(2);
    const arkit = new Float32Array(52);
    arkit[shape("jawOpen")] = 0.7;
    arkit[shape("mouthSmileLeft")] = 2;
    expect([...faceWeights(rig, arkit, [0, 0.3, 0])].map((v) => Math.round(v * 100) / 100)).toEqual([0.7, 0.3, 1]);
  });
});

describe("face animation in", () => {
  it("reads Live Link Face's CSV", () => {
    expect(parseTimecode("00:00:01:30.000", 60)).toBeCloseTo(1.5);
    expect(parseTimecode("2.25", 60)).toBe(2.25);
    expect(parseTimecode("nope", 60)).toBeNull();
    const csv = ["Timecode,BlendShapeCount,EyeBlinkLeft,JawOpen,HeadYaw", "10:00:00:00.000,61,0,0.2,0.5", "10:00:00:30.000,61,1,0.6,0.5"].join("\n");
    const clip = parseLiveLinkFaceCsv(csv, "take");
    expect(clip.duration).toBeCloseTo(0.5);
    const mid = sampleFace(clip, 0.25);
    expect(mid[shape("eyeBlinkLeft")]).toBeCloseTo(0.5);
    expect(mid[shape("jawOpen")]).toBeCloseTo(0.4);
    expect(sampleFace(clip, 9)[shape("jawOpen")]).toBeCloseTo(0.6);
  });

  it("imports glTF's morph weight channels as a clip's, and writes them back", () => {
    // Export a face with a clip of weights, then read it back.
    const morphs = { interpolation: "linear" as const, targets: 2, times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 1, 0.5]) };
    const mesh = face(["jawOpen", "eyeBlinkLeft"], { clips: [{ name: "talk", duration: 1, channels: [], morphs }] } as Partial<MeshAsset>);
    const back = parseGlb(encodeGlb(mesh), "face");
    const clip = back.clips![0]!;
    expect(clip.name).toBe("talk");
    expect([...clip.morphs!.values]).toEqual([0, 0, 1, 0.5]);
    expect([...sampleMorphs(clip, 0.5, false)]).toEqual([0.5, 0.25]);
    // And through the mesh format.
    expect([...deserializeMeshAsset(serializeMeshAsset(mesh)).clips![0]!.morphs!.times]).toEqual([0, 1]);
  });
});

describe("lip sync", () => {
  it("turns phonemes into visemes, merging repeats", () => {
    expect(phonemeViseme("AA1")).toBe("aa");
    expect(phonemeViseme("m")).toBe("PP");
    expect(phonemeViseme("zz")).toBe("sil");
    const track = visemesFromPhonemes([
      { phoneme: "HH", start: 0, end: 0.1 },
      { phoneme: "EH1", start: 0.1, end: 0.2 },
      { phoneme: "L", start: 0.2, end: 0.25 },
      { phoneme: "N", start: 0.25, end: 0.3 },
      { phoneme: "OW1", start: 0.3, end: 0.5 },
    ]);
    expect(track.map((s) => s.viseme)).toEqual(["kk", "E", "nn", "oh"]);
    expect(track[2]!.end).toBe(0.3);
  });

  it("eases visemes in and out across their neighbours", () => {
    const track = visemesFromPhonemes([
      { phoneme: "AA", start: 0, end: 0.2 },
      { phoneme: "M", start: 0.2, end: 0.3 },
    ]);
    const jaw = shape("jawOpen");
    expect(lipSyncWeights(track, 0.1)[jaw]).toBeCloseTo(0.6);
    // Halfway through the blend after the vowel, the jaw is half its way; the lips already half closed.
    const after = lipSyncWeights(track, 0.2 + VISEME_BLEND / 2);
    expect(after[jaw]).toBeCloseTo(0.3);
    expect(after[shape("mouthClose")]).toBeCloseTo(0.6);
    expect(lipSyncWeights(track, 1)[jaw]).toBe(0);
  });

  const rate = 16000;
  /** A voiced vowel: a 120 Hz pulse train through two resonators at its formants. */
  function vowel(f1: number, f2: number, seconds = 0.2): Float32Array {
    const n = Math.round(seconds * rate);
    const out = new Float32Array(n);
    const resonate = (input: Float32Array, f: number, bw: number) => {
      const r = Math.exp((-Math.PI * bw) / rate);
      const c = 2 * r * Math.cos((2 * Math.PI * f) / rate);
      const y = new Float32Array(input.length);
      for (let i = 0; i < input.length; i += 1) y[i] = input[i]! + c * (y[i - 1] ?? 0) - r * r * (y[i - 2] ?? 0);
      return y;
    };
    const pulses = new Float32Array(n);
    for (let i = 0; i < n; i += Math.round(rate / 120)) pulses[i] = 1;
    const shaped = resonate(resonate(pulses, f1, 80), f2, 100);
    const peak = shaped.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    for (let i = 0; i < n; i += 1) out[i] = (shaped[i]! / peak) * 0.5;
    return out;
  }
  function noise(seconds = 0.2): Float32Array {
    let s = 7;
    return Float32Array.from({ length: Math.round(seconds * rate) }, () => {
      s = (s * 1103515245 + 12345) >>> 0;
      return ((s / 2 ** 32) * 2 - 1) * 0.3;
    });
  }

  it("finds a vowel's formants by linear prediction", () => {
    const x = Float64Array.from(vowel(700, 1200).subarray(800, 800 + 320), (v, i) => v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / 319)));
    const peaks = formants(lpc(x, 12), rate);
    expect(Math.abs(peaks[0]! - 700)).toBeLessThan(120);
    expect(Math.abs(peaks[1]! - 1200)).toBeLessThan(150);
  });

  it("classifies speech frames: silence, a fricative, and vowels by their formants", () => {
    const loud = 0.3;
    expect(frameViseme({ time: 0, rms: 0.001, hiss: 0, f1: 0, f2: 0 }, loud)).toBe("sil");
    const hiss = analyzeSpeech(noise(), rate);
    expect(frameViseme(hiss[3]!, loud)).toBe("SS");
    const pick = (f1: number, f2: number) => {
      const frames = analyzeSpeech(vowel(f1, f2), rate);
      return frameViseme(frames[4]!, frames[4]!.rms);
    };
    expect(pick(750, 1200)).toBe("aa");
    expect(pick(300, 2300)).toBe("ih");
    expect(pick(500, 2000)).toBe("E");
    expect(pick(320, 800)).toBe("ou");
    expect(pick(500, 900)).toBe("oh");
  });

  it("turns audio into a viseme track in order", () => {
    const parts = [vowel(750, 1200), new Float32Array(3200), vowel(320, 800)];
    const audio = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      audio.set(p, at);
      at += p.length;
    }
    const track = visemesFromAudio(audio, rate);
    const main = track.filter((s) => s.end - s.start >= 0.06).map((s) => s.viseme);
    expect(main).toEqual(["aa", "ou"]);
    expect(track[0]!.start).toBeLessThan(0.03);
    expect(track[track.length - 1]!.start).toBeGreaterThan(0.38);
  });
});

describe("gaze", () => {
  it("turns toward a target within the eyes' range", () => {
    expect(Gaze.anglesTo([0, 0, 1])).toEqual([0, 0]);
    expect(Gaze.anglesTo([0.5, 0, 1])[0]).toBeCloseTo(Math.atan(0.5));
    expect(Gaze.anglesTo([1, 0, 0])[0]).toBeCloseTo(EYE_RANGE.yaw);
    expect(Gaze.anglesTo([0, -1, 0.1])[1]).toBeCloseTo(-EYE_RANGE.down);
  });

  it("jumps by saccades, as long as the main sequence says, then dwells with micro-saccades", () => {
    expect(saccadeDuration((10 * Math.PI) / 180)).toBeCloseTo(0.043, 3);
    const gaze = new Gaze(3);
    const dt = 1 / 240;
    const target = [Math.sin(0.3), 0, Math.cos(0.3)];
    let t = 0;
    let state = gaze.update(dt, target);
    expect(state.moving).toBe(true);
    while (state.moving) {
      t += dt;
      state = gaze.update(dt, target);
    }
    // 17° takes about 59 ms.
    expect(t).toBeGreaterThan(0.04);
    expect(t).toBeLessThan(0.08);
    expect(state.yaw).toBeCloseTo(0.3, 3);
    // Held on the target over two seconds, it moves only by micro-saccades, within half a degree, and blinks.
    let drift = 0;
    let saccades = 0;
    let blinked = false;
    let was = false;
    for (let i = 0; i < 240 * 8; i += 1) {
      state = gaze.update(dt, target);
      drift = Math.max(drift, Math.hypot(state.yaw - 0.3, state.pitch));
      if (state.moving && !was) saccades += 1;
      was = state.moving;
      blinked ||= state.blink > 0.9;
    }
    expect(drift).toBeLessThan(Math.PI / 360 + 1e-6);
    expect(saccades).toBeGreaterThan(8);
    expect(blinked).toBe(true);
    // Seeded: another gaze with the same seed does the same.
    const a = new Gaze(9);
    const b = new Gaze(9);
    for (let i = 0; i < 500; i += 1) expect(a.update(dt, target)).toEqual(b.update(dt, target));
  });

  it("drives ARKit's eye shapes, and layers over the mouth", () => {
    const w = gazeWeights({ yaw: EYE_RANGE.yaw / 2, pitch: -EYE_RANGE.down, blink: 1, moving: false });
    expect(w[shape("eyeLookOutLeft")]).toBeCloseTo(0.5);
    expect(w[shape("eyeLookInRight")]).toBeCloseTo(0.5);
    expect(w[shape("eyeLookInLeft")]).toBe(0);
    expect(w[shape("eyeLookDownLeft")]).toBeCloseTo(1);
    expect(w[shape("eyeBlinkRight")]).toBe(1);
    const mouth = new Float32Array(52);
    mouth[shape("jawOpen")] = 0.4;
    const both = layerFace(mouth, w);
    expect(both[shape("jawOpen")]).toBeCloseTo(0.4);
    expect(both[shape("eyeBlinkLeft")]).toBe(1);
  });
});

describe("a face at runtime", () => {
  it("speaks, looks and plays its clip's weights into the mesh's targets", () => {
    const mesh = face(["jawOpen", "eyeLookOutLeft", "eyeBlinkLeft", "brow"], { morphWeights: [0, 0, 0, 0.5] } as Partial<MeshAsset>);
    const driver = new FaceDriver(mesh, 1);
    driver.speak(visemesFromPhonemes([{ phoneme: "AA", start: 0, end: 0.3 }]), 0);
    driver.lookAt([1, 0, 1]);
    let weights = driver.update(0.1);
    expect(weights[0]).toBeCloseTo(0.6);
    expect(weights[3]).toBe(0.5); // a target ARKit doesn't name keeps the mesh's weight
    for (let i = 0; i < 30; i += 1) weights = driver.update(1 / 60);
    expect(weights[1]).toBeGreaterThan(0.5); // looking to its left
    // The speech over, the jaw closes.
    for (let i = 0; i < 30; i += 1) weights = driver.update(1 / 60);
    expect(weights[0]).toBe(0);
  });

  it("plays a skinned character's clip of morph weights alongside its joints", () => {
    const arm = parseGltfText(skinnedArmGltf(1), "arm");
    const strip = arm.primitives[0]!;
    const target: MorphTarget = { name: "jawOpen", positions: new Float32Array(strip.positions.length) };
    const morphs = { interpolation: "linear" as const, targets: 1, times: Float32Array.from([0, 1]), values: Float32Array.from([0, 1]) };
    const mesh: MeshAsset = { ...arm, primitives: [{ ...strip, morphTargets: [target] }, ...arm.primitives.slice(1)], clips: [{ ...arm.clips![0]!, morphs }] };
    const session = new AnimationSession({ instances: [{ mesh, model: new Float32Array(16) }] } as unknown as MeshScene);
    session.step(0.5);
    expect([...session.morphs().get(0)!]).toEqual([0.5]);
  });
});
