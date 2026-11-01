/**
 * Cinematics (AAA_FIDELITY_ROADMAP.md F10d): the film camera a timeline's
 * camera track becomes — focal lengths, the thin lens and focus pulls, shake,
 * rails and roll — the frames of an offline render, the WebM they're muxed
 * into, and, on a real device (Dawn), the path tracer's depth of field.
 */

import { describe, expect, it } from "vitest";

import { apertureRadius, cameraShake, composeModelMatrix, focalLengthToFov, projectionMatrix, railPoint, readTimelines, sampleCamera, sampleShot, sequenceTimes, shotMatrices, viewMatrix, type MeshAsset, type MeshSceneInstance, type SceneTimeline } from "@cartbox/editor";

import { captureReference } from "../packages/player/src/render/pathTracer";
import { muxWebm, readEbml } from "../apps/web/src/lib/webmMuxer";

function film(track: Record<string, unknown>, duration = 4): SceneTimeline {
  return readTimelines([{ name: "shot", duration, tracks: [{ kind: "camera", ...track }] }])[0]!;
}

describe("the lens", () => {
  it("turns a focal length into a field of view on a full-frame sensor, and an f-stop into an aperture", () => {
    expect(focalLengthToFov(24)).toBeCloseTo((2 * Math.atan(0.5) * 180) / Math.PI, 6);
    expect(focalLengthToFov(50)).toBeCloseTo(26.99, 2);
    expect(focalLengthToFov(200)).toBeLessThan(focalLengthToFov(50));
    expect(apertureRadius(50, 2)).toBeCloseTo(0.0125, 9);
    expect(apertureRadius(50, 16)).toBeLessThan(apertureRadius(50, 1.4));
  });
});

describe("shake", () => {
  it("is still at no amplitude, bounded by it, smooth, and centred", () => {
    expect(cameraShake(1.3, 0, 6)).toEqual([0, 0, 0]);
    let worst = 0;
    let step = 0;
    const mean = [0, 0, 0];
    const n = 4000;
    for (let i = 0; i < n; i += 1) {
      const t = i / 100;
      const s = cameraShake(t, 2, 5);
      const next = cameraShake(t + 0.001, 2, 5);
      for (let a = 0; a < 3; a += 1) {
        worst = Math.max(worst, Math.abs(s[a]!));
        step = Math.max(step, Math.abs(next[a]! - s[a]!));
        mean[a]! += s[a]! / n;
      }
    }
    expect(worst).toBeLessThanOrEqual(2 + 1e-9);
    expect(worst).toBeGreaterThan(0.5);
    // A millisecond moves it a few hundredths of a degree at most: no jumps.
    expect(step).toBeLessThan(0.2);
    for (const m of mean) expect(Math.abs(m)).toBeLessThan(0.2);
  });
});

describe("rails", () => {
  it("pass through every point, and stay between them", () => {
    const points = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 4],
      [8, 2, 4],
    ];
    for (let k = 0; k < points.length; k += 1) {
      const p = railPoint(points, k / (points.length - 1));
      for (let a = 0; a < 3; a += 1) expect(p[a]).toBeCloseTo(points[k]![a]!, 9);
    }
    const mid = railPoint(points, 0.5);
    expect(mid[0]).toBeGreaterThan(3);
    expect(mid[2]).toBeGreaterThan(1);
    expect(railPoint(points, -1)).toEqual(railPoint(points, 0));
  });
});

describe("a film camera track", () => {
  it("reads lens, roll, rail and shake fields, clamped, and leaves out what isn't given", () => {
    const t = film({
      rail: [
        [0, 1, 0],
        [5, 1, 0],
      ],
      shakeAmplitude: 99,
      shakeFrequency: 4,
      keys: [
        { time: 0, eye: [0, 1, 5], target: [0, 1, 0], focalLength: 35, fStop: 0.1, focus: 4, roll: 400, along: 2, shake: 0.5 },
        { time: 2, eye: [0, 1, 5], target: [0, 1, 0], focusOn: "hero" },
      ],
    });
    const track = t.tracks[0] as Extract<SceneTimeline["tracks"][number], { kind: "camera" }>;
    expect(track.rail).toHaveLength(2);
    expect(track.shakeAmplitude).toBe(30);
    expect(track.shakeFrequency).toBe(4);
    expect(track.keys[0]).toMatchObject({ focalLength: 35, fStop: 0.7, focus: 4, roll: 180, along: 1, shake: 0.5 });
    expect(track.keys[1]!.focusOn).toBe("hero");
    expect("focalLength" in track.keys[1]!).toBe(false);
    // A rail needs two points.
    const lone = film({ rail: [[0, 0, 0]], keys: [{ time: 0, eye: [0, 0, 5], target: [0, 0, 0] }] });
    expect("rail" in lone.tracks[0]!).toBe(false);
  });

  it("samples a shot: focal length to field of view, a focus pull, focus on an object, the eye on its rail", () => {
    const t = film({
      rail: [
        [0, 1, 6],
        [6, 1, 6],
      ],
      keys: [
        { time: 0, eye: [0, 1, 6], target: [0, 1, 0], ease: "linear", focalLength: 24, fStop: 2, focus: 2, along: 0 },
        { time: 2, eye: [6, 1, 6], target: [0, 1, 0], ease: "linear", focalLength: 85, fStop: 2, focus: 10, along: 1 },
        { time: 4, eye: [6, 1, 6], target: [0, 1, 0], ease: "linear", fStop: 2, focusOn: "hero", along: 1 },
      ],
    });
    const start = sampleShot(t, 0)!;
    expect(start.fov).toBeCloseTo(focalLengthToFov(24), 6);
    // Live playback takes the same field of view.
    expect(sampleCamera(t, 0)!.fov).toBeCloseTo(focalLengthToFov(24), 6);
    expect(start.lens!.focus).toBeCloseTo(2, 6);
    expect(start.lens!.aperture).toBeCloseTo(apertureRadius(24, 2), 9);
    // Halfway: the focus pulled halfway, the eye halfway along the rail.
    const mid = sampleShot(t, 1)!;
    expect(mid.lens!.focus).toBeCloseTo(6, 6);
    expect(mid.eye[0]).toBeCloseTo(3, 6);
    // A key focusing on an object focuses at its distance from the eye.
    const end = sampleShot(t, 4, (id) => (id === "hero" ? [6, 1, 2] : null))!;
    expect(end.lens!.focus).toBeCloseTo(4, 6);
    // Without a lens on the keys, a pinhole at the key's own field of view.
    const plain = film({ keys: [{ time: 0, eye: [0, 0, 5], target: [0, 0, 0], fov: 40 }] });
    expect(sampleShot(plain, 0)).toMatchObject({ fov: 40, lens: null });
    expect(sampleShot(film({ keys: [] }), 0)).toBeNull();
  });

  it("rolls the camera about its view, and shakes it about the eye", () => {
    const t = film({ shakeAmplitude: 3, shakeFrequency: 5, keys: [{ time: 0, eye: [0, 0, 5], target: [0, 0, 0], roll: 90, shake: 0 }] });
    const rolled = sampleShot(t, 1)!;
    // Up turned a quarter about −z: it points along ∓x.
    expect(Math.abs(rolled.up[0])).toBeCloseTo(1, 6);
    expect(rolled.target).toEqual([0, 0, 0]);
    const shaken = sampleShot(film({ shakeAmplitude: 3, shakeFrequency: 5, keys: [{ time: 0, eye: [0, 0, 5], target: [0, 0, 0], shake: 1 }] }), 1.234)!;
    expect(shaken.eye).toEqual([0, 0, 5]);
    expect(Math.hypot(shaken.target[0], shaken.target[1])).toBeGreaterThan(1e-3);
    // Still 5 away: the view turned, not moved.
    expect(Math.hypot(shaken.target[0], shaken.target[1], shaken.target[2] - 5)).toBeCloseTo(5, 6);
  });

  it("makes the view and projection, the roll inside the view", () => {
    const shot = { eye: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], up: [0, 1, 0] as [number, number, number], fov: 50, lens: null };
    const plain = shotMatrices(shot, 16 / 9);
    const view = viewMatrix(shot.eye, shot.target);
    for (let i = 0; i < 16; i += 1) expect(plain.view[i]).toBeCloseTo(view[i]!, 9);
    const projection = projectionMatrix((50 * Math.PI) / 180, 16 / 9, 0.05, 2000);
    for (let i = 0; i < 16; i += 1) expect(plain.projection[i]).toBeCloseTo(projection[i]!, 9);
    // Rolled so up is +x: a point above the target lands to the side in view space.
    const rolled = shotMatrices({ ...shot, up: [1, 0, 0] }, 1).view;
    const p = [0, 1, 0, 1];
    const v = [0, 1, 2].map((r) => rolled[r]! * p[0]! + rolled[4 + r]! * p[1]! + rolled[8 + r]! * p[2]! + rolled[12 + r]! * p[3]!);
    expect(Math.abs(v[0]!)).toBeCloseTo(1, 6);
    expect(v[1]).toBeCloseTo(0, 6);
  });

  it("takes the frames of an offline render at its frame rate, the last included", () => {
    const times = sequenceTimes({ duration: 2 }, 24);
    expect(times).toHaveLength(49);
    expect(times[0]).toBe(0);
    expect(times[48]).toBeCloseTo(2, 9);
    expect(sequenceTimes({ duration: 0.01 }, 24)).toEqual([0]);
  });
});

describe("WebM", () => {
  it("writes the EBML header, Info, one video track, and a Cluster at each key frame", () => {
    const frames = Array.from({ length: 6 }, (_, i) => ({ data: Uint8Array.from([i, i, i]), timestamp: i * 40, key: i % 3 === 0 }));
    const bytes = muxWebm({ width: 64, height: 32, codec: "V_VP9", duration: 240 }, frames);
    const top = readEbml(bytes);
    expect(top.map((e) => e.id)).toEqual([0x1a45dfa3, 0x18538067]);
    expect(top[1]!.start + top[1]!.size).toBe(bytes.length);
    const header = readEbml(bytes, top[0]!.start, top[0]!.start + top[0]!.size);
    const docType = header.find((e) => e.id === 0x4282)!;
    expect(new TextDecoder().decode(bytes.subarray(docType.start, docType.start + docType.size))).toBe("webm");
    const segment = readEbml(bytes, top[1]!.start, top[1]!.start + top[1]!.size);
    expect(segment.map((e) => e.id)).toEqual([0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1f43b675]);
    // The track: VP9 at 64 × 32.
    const tracks = segment[1]!;
    const entry = readEbml(bytes, tracks.start, tracks.start + tracks.size)[0]!;
    const fields = readEbml(bytes, entry.start, entry.start + entry.size);
    const codec = fields.find((e) => e.id === 0x86)!;
    expect(new TextDecoder().decode(bytes.subarray(codec.start, codec.start + codec.size))).toBe("V_VP9");
    const video = fields.find((e) => e.id === 0xe0)!;
    const size = readEbml(bytes, video.start, video.start + video.size).map((e) => bytes[e.start + e.size - 1]);
    expect(size).toEqual([64, 32]);
    // The second Cluster starts at 120 ms; its blocks sit 0 and 40 ms after, the first a key frame.
    const second = segment[3]!;
    const inside = readEbml(bytes, second.start, second.start + second.size);
    expect(bytes[inside[0]!.start]).toBe(120);
    const blocks = inside.slice(1);
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => (bytes[b.start + 1]! << 8) | bytes[b.start + 2]!)).toEqual([0, 40, 80]);
    expect(blocks.map((b) => bytes[b.start + 3])).toEqual([0x80, 0, 0]);
    expect(Array.from(bytes.subarray(blocks[1]!.start + 4, blocks[1]!.start + 7))).toEqual([4, 4, 4]);
  });

  it("opens a new Cluster before a block's offset would overflow", () => {
    const frames = [0, 20000, 40000].map((timestamp, i) => ({ data: Uint8Array.from([1]), timestamp, key: i === 0 }));
    const bytes = muxWebm({ width: 2, height: 2, codec: "V_VP8", duration: 40000 }, frames);
    const segment = readEbml(bytes, readEbml(bytes)[1]!.start);
    expect(segment.filter((e) => e.id === 0x1f43b675)).toHaveLength(2);
  });
});

async function realDevice(): Promise<any | null> {
  try {
    const module = (await import(/* @vite-ignore */ "@kmamal/gpu")) as any;
    const instance = (module.default ?? module).create([]);
    const adapter = await instance.requestAdapter();
    return adapter ? await adapter.requestDevice() : null;
  } catch {
    return null;
  }
}
const device = await realDevice();

async function settled<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 4000 && !done; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    device.tick?.();
  }
  return promise;
}

describe.skipIf(!device)("depth of field on a real device", { timeout: 300_000 }, () => {
  const glow: MeshAsset = {
    name: "glow",
    primitives: [
      {
        positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
        normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
        uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
        indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
        material: { name: "glow", baseColorFactor: [0, 0, 0, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1, emissiveFactor: [1, 1, 1] },
      },
    ],
  } as unknown as MeshAsset;
  const instances = [{ mesh: glow, model: composeModelMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]) }] as unknown as MeshSceneInstance[];
  const camera = { view: viewMatrix([0, 0, 3], [0, 0, 0]), projection: projectionMatrix(Math.PI / 3, 1, 0.1, 50), ambient: 0 };

  /** How many pixels of the middle row sit between dark and lit: the edges' blur. */
  async function edgeWidth(lens: { aperture: number; focus: number } | null): Promise<number> {
    const shot = await settled(captureReference(device, instances, { ...camera, lens }, { width: 48, height: 48, samples: 96, hdr: true }));
    const row = Array.from({ length: 48 }, (_, x) => shot.hdr![(24 * 48 + x) * 4]!);
    const peak = Math.max(...row);
    return row.filter((v) => v > peak * 0.12 && v < peak * 0.88).length;
  }

  it("keeps a pinhole sharp, blurs what's out of focus, and sharpens it again when focused on", async () => {
    const pinhole = await edgeWidth(null);
    const far = await edgeWidth({ aperture: 0.3, focus: 30 });
    const on = await edgeWidth({ aperture: 0.3, focus: 3 });
    expect(pinhole).toBeLessThanOrEqual(2);
    expect(far).toBeGreaterThanOrEqual(7);
    expect(on).toBeLessThanOrEqual(3);
  });
});
