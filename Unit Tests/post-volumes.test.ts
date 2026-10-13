/**
 * Post volumes and eye adaptation (EDITOR_PRO_ROADMAP.md P6): a volume's
 * weight is 1 inside and fades smoothly to 0 over its blend distance;
 * overlapping volumes resolve by priority; the eye adapts toward mid-grey at
 * its own speeds and within its limits; the rig stores both; and the player
 * folds the blended look into the cart's post-FX stack.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_EXPOSURE,
  adaptExposure,
  blendPostVolumes,
  defaultSceneLighting,
  frameLuminance,
  parseSceneLighting,
  postVolumeReach,
  readAutoExposure,
  readPostVolumes,
  setSceneAutoExposure,
  setScenePostVolumes,
  volumeWeight,
  type PostVolume,
} from "@cartbox/editor";

import { applyPostVolumes } from "../packages/player/src/fx/postVolumeFx";
import { defaultPostFxSettings } from "../packages/player/src/fx/postfx";

const room: PostVolume = { id: "a", name: "base", center: [0, 2, 0], size: [10, 4, 10], blend: 4, exposure: -1, saturation: 0.6, fog: 0.8 };

describe("post volume weight", () => {
  it("is 1 inside, 0 beyond the blend and eases smoothly between", () => {
    expect(volumeWeight(room, [0, 2, 0])).toBe(1);
    expect(volumeWeight(room, [5, 2, 0])).toBe(1); // on the face
    expect(volumeWeight(room, [9.5, 2, 0])).toBe(0);
    const half = volumeWeight(room, [7, 2, 0]);
    expect(half).toBeCloseTo(0.5, 6);
    // Monotone falling outward.
    let last = 1;
    for (let x = 5; x <= 9; x += 0.25) {
      const w = volumeWeight(room, [x, 2, 0]);
      expect(w).toBeLessThanOrEqual(last + 1e-12);
      last = w;
    }
  });

  it("has a hard edge with no blend", () => {
    const hard = { ...room, blend: 0 };
    expect(volumeWeight(hard, [4.99, 2, 0])).toBe(1);
    expect(volumeWeight(hard, [5.01, 2, 0])).toBe(0);
  });
});

describe("blending volumes", () => {
  it("is neutral away from every volume", () => {
    expect(blendPostVolumes([room], [50, 2, 0])).toEqual({ exposure: 0 });
    expect(blendPostVolumes(undefined, [0, 0, 0])).toEqual({ exposure: 0 });
  });

  it("applies a volume fully inside and partly at its fringe", () => {
    const inside = blendPostVolumes([room], [0, 2, 0]);
    expect(inside.exposure).toBe(-1);
    expect(inside.saturation).toBeCloseTo(0.6, 9);
    expect(inside.brightness).toBeUndefined();
    const fringe = blendPostVolumes([room], [7, 2, 0]);
    expect(fringe.exposure).toBeCloseTo(-0.5, 6);
    expect(fringe.saturation).toBeCloseTo(0.8, 6); // halfway from neutral 1
    expect(postVolumeReach([room], [7, 2, 0], "fog")).toBeCloseTo(0.5, 6);
    expect(postVolumeReach([room], [7, 2, 0], "bloom")).toBe(0); // the room sets no bloom
  });

  it("lets the higher priority win where volumes overlap, whatever their order", () => {
    const inner: PostVolume = { id: "b", name: "vault", center: [0, 2, 0], size: [4, 4, 4], blend: 0, priority: 5, exposure: 1 };
    expect(blendPostVolumes([room, inner], [0, 2, 0]).exposure).toBe(1);
    expect(blendPostVolumes([inner, room], [0, 2, 0]).exposure).toBe(1);
    // Outside the vault, in the room: the room's.
    expect(blendPostVolumes([inner, room], [4, 2, 0]).exposure).toBe(-1);
  });
});

describe("eye adaptation", () => {
  const ae = DEFAULT_AUTO_EXPOSURE;

  it("measures the log-average luminance, skipping undrawn pixels", () => {
    const w = 8, h = 8;
    const grey = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) grey.set([188, 188, 188, 255], i * 4);
    // sRGB 188 is about linear 0.5.
    expect(frameLuminance(grey, w, h)).toBeCloseTo(0.5, 2);
    const holes = grey.slice();
    for (let i = 0; i < w * h; i += 2) holes.set([0, 0, 0, 0], i * 4);
    expect(frameLuminance(holes, w, h)).toBeCloseTo(0.5, 2);
  });

  it("converges on the exposure that brings the scene to mid-grey", () => {
    // A dark interior: 1/16 of mid-grey unexposed, so 4 stops up.
    const scene = ae.key / 16;
    let stops = 0;
    for (let i = 0; i < 600; i += 1) stops = adaptExposure(stops, scene * 2 ** stops, { ...ae, max: 6 }, 1 / 60);
    expect(stops).toBeCloseTo(4, 6);
  });

  it("brightens at its up speed and darkens at its down speed", () => {
    const dt = 0.1;
    const up = adaptExposure(0, ae.key / 16, ae, dt);
    expect(up).toBeCloseTo(ae.up * dt, 9);
    const down = adaptExposure(0, ae.key * 16, ae, dt);
    expect(down).toBeCloseTo(-ae.down * dt, 9);
  });

  it("stays within its limits", () => {
    let stops = 0;
    for (let i = 0; i < 2000; i += 1) stops = adaptExposure(stops, 1e-6 * 2 ** stops, ae, 1 / 60);
    expect(stops).toBeCloseTo(ae.max, 9);
    for (let i = 0; i < 2000; i += 1) stops = adaptExposure(stops, 50 * 2 ** stops, ae, 1 / 60);
    expect(stops).toBeCloseTo(ae.min, 9);
  });
});

describe("storage", () => {
  it("reads volumes defensively", () => {
    const read = readPostVolumes([room, { id: 3 }, { id: "x", center: [0, 0], size: [1, 1, 1] }, { id: "c", center: [1, 2, 3], size: [0, 2, 2], exposure: 9, saturation: -1 }]);
    expect(read).toHaveLength(2);
    expect(read[0]).toEqual(room);
    expect(read[1]).toMatchObject({ size: [0.1, 2, 2], exposure: 4, saturation: 0, blend: 2 });
    expect(readPostVolumes("nope")).toEqual([]);
    expect(readAutoExposure(null)).toBeNull();
    expect(readAutoExposure({ min: 3, key: 9 })).toMatchObject({ min: 0, key: 0.5, up: DEFAULT_AUTO_EXPOSURE.up });
  });

  it("round-trips through the lighting rig, and is absent when unset", () => {
    const base = { ...defaultSceneLighting(), tonemap: true };
    const rig = setSceneAutoExposure(setScenePostVolumes(base, [room]), DEFAULT_AUTO_EXPOSURE);
    const back = parseSceneLighting(JSON.parse(JSON.stringify(rig)));
    expect(back?.postVolumes).toEqual([room]);
    expect(back?.autoExposure).toEqual(DEFAULT_AUTO_EXPOSURE);
    const plain = parseSceneLighting(JSON.parse(JSON.stringify(base)))!;
    expect("postVolumes" in plain).toBe(false);
    expect("autoExposure" in plain).toBe(false);
    expect("postVolumes" in setScenePostVolumes(rig, [])).toBe(false);
    expect("autoExposure" in setSceneAutoExposure(rig, null)).toBe(false);
  });
});

describe("the player's post-FX with volumes", () => {
  it("leaves the cart's settings alone with no volume about", () => {
    const base = defaultPostFxSettings();
    expect(applyPostVolumes(base, null)).toBe(base);
    expect(applyPostVolumes(base, { bloomReach: 0, fogReach: 0 })).toBe(base);
  });

  it("multiplies the cart's grade and mixes bloom and fog by reach", () => {
    const base = defaultPostFxSettings();
    base.enabled.grade = true;
    base.values["grade.saturation"] = 1.2;
    base.enabled.bloom = true;
    base.values["bloom.strength"] = 0.4;
    const shown = applyPostVolumes(base, { saturation: 0.5, bloom: 0.5, bloomReach: 0.5, fogReach: 0 });
    expect(shown.values["grade.saturation"]).toBeCloseTo(0.6, 9);
    expect(shown.values["bloom.strength"]).toBeCloseTo(0.4 * 0.5 + 0.5, 9);
    expect(shown.enabled.fog).toBe(false);
    // An effect the cart leaves off starts from nothing when a volume turns it on.
    const fogged = applyPostVolumes(base, { fog: 0.3, fogReach: 1, bloomReach: 0 });
    expect(fogged.enabled.fog).toBe(true);
    expect(fogged.values["fog.density"]).toBeCloseTo(0.3, 9);
    // The cart's own settings aren't touched.
    expect(base.values["grade.saturation"]).toBe(1.2);
  });
});
