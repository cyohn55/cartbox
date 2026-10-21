/**
 * Physical light units (AAA_FIDELITY_ROADMAP.md F0b): the fixed calibration
 * between the renderer's units and lux, candela, nits and EV100, the
 * inverse-square falloff that gives a candela its meaning, and that a rig
 * keeps both through a save.
 */

import { describe, expect, it } from "vitest";

import {
  defaultSceneLighting,
  distanceFalloff,
  ev100ToExposure,
  exposureToEv100,
  formatPhysical,
  INVERSE_SQUARE_MIN_DISTANCE,
  lightUnit,
  LUX_PER_UNIT,
  luxToUnits,
  NITS_PER_UNIT,
  nitsToUnits,
  parseSceneLighting,
  REFERENCE_EV100,
  setSceneUnits,
  unitsToLux,
  unitsToNits,
  withLightFalloff,
  type SceneLight,
} from "@cartbox/editor";
import { LIGHT_FLOATS, packLights } from "@cartbox/player";

describe("the calibration", () => {
  it("puts exposure 1 at EV100 15, a sunny day, where 1.2 · 2^15 nits just saturates", () => {
    expect(REFERENCE_EV100).toBe(15);
    expect(NITS_PER_UNIT).toBeCloseTo(39321.6, 6);
    expect(ev100ToExposure(15)).toBe(1);
    // One stop brighter needs half the exposure; an interior at EV 8 needs 2^7.
    expect(ev100ToExposure(16)).toBe(0.5);
    expect(ev100ToExposure(8)).toBe(128);
    for (const ev of [-2, 3.5, 8, 15, 19.9]) expect(exposureToEv100(ev100ToExposure(ev))).toBeCloseTo(ev, 10);
  });

  it("makes a unit sun about 123 klx (a white surface under E lux shows E/π nits)", () => {
    expect(LUX_PER_UNIT).toBeCloseTo(Math.PI * NITS_PER_UNIT, 6);
    expect(unitsToLux(1)).toBeCloseTo(123_532.45, 1);
    // A 100 klx noon sun on a white surface: 100000/π nits, which is this many units of luminance.
    expect(luxToUnits(100_000)).toBeCloseTo(nitsToUnits(100_000 / Math.PI), 12);
  });

  it("converts both ways without loss, so editing in physical units changes nothing stored", () => {
    for (const v of [0, 1e-4, 0.35, 1, 2.6, 40]) {
      expect(nitsToUnits(unitsToNits(v))).toBeCloseTo(v, 12);
      expect(luxToUnits(unitsToLux(v))).toBeCloseTo(v, 12);
    }
  });

  it("reads a sun and a fading light in lux, an inverse-square light in candela", () => {
    expect(lightUnit({ kind: "directional" })).toBe("lx");
    expect(lightUnit({ kind: "point" })).toBe("lx");
    expect(lightUnit({ kind: "spot", falloff: "inverseSquare" })).toBe("cd");
    // A sun's falloff field means nothing.
    expect(lightUnit({ kind: "directional", falloff: "inverseSquare" })).toBe("lx");
  });

  it("formats to three figures with an SI prefix", () => {
    expect(formatPhysical(123_533, "lx")).toBe("124 klx");
    expect(formatPhysical(1_200_000, "cd")).toBe("1.20 Mcd");
    expect(formatPhysical(39_321.6, "nt")).toBe("39.3 knt");
    expect(formatPhysical(0.35, "nt")).toBe("0.35 nt");
    expect(formatPhysical(0, "lx")).toBe("0 lx");
  });
});

describe("inverse-square falloff", () => {
  it("is 1/d², floored at 1 cm, and windowed to nothing at its range", () => {
    const free = { falloff: "inverseSquare" as const, range: 0 };
    expect(distanceFalloff(free, 1)).toBe(1);
    expect(distanceFalloff(free, 2)).toBe(0.25);
    expect(distanceFalloff(free, 10)).toBeCloseTo(0.01, 12);
    expect(distanceFalloff(free, 0)).toBe(1 / INVERSE_SQUARE_MIN_DISTANCE ** 2);
    const ranged = { falloff: "inverseSquare" as const, range: 10 };
    expect(distanceFalloff(ranged, 10)).toBe(0);
    expect(distanceFalloff(ranged, 12)).toBe(0);
    // Close in, the window barely bites: within 0.2% of 1/d² at a tenth of the range.
    expect(distanceFalloff(ranged, 1) / distanceFalloff(free, 1)).toBeGreaterThan(0.998);
  });

  it("leaves the default fade as it was", () => {
    expect(distanceFalloff({ range: 10 }, 5)).toBe(0.25);
    expect(distanceFalloff({ range: 0 }, 50)).toBe(1);
  });

  it("switches a light's falloff keeping it as bright halfway to its range, and back", () => {
    const fade: SceneLight = { kind: "point", position: [0, 2, 0], color: [1, 0.8, 0.6], intensity: 3, range: 12 };
    const square = withLightFalloff(fade, true);
    expect(square.falloff).toBe("inverseSquare");
    expect(square.intensity * distanceFalloff(square, 6)).toBeCloseTo(fade.intensity * distanceFalloff(fade, 6), 10);
    const back = withLightFalloff(square, false);
    expect(back.falloff).toBeUndefined();
    expect(back.intensity).toBeCloseTo(3, 10);
    // A sun, or a switch to what it already is, returns the light untouched.
    const sun: SceneLight = { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1 };
    expect(withLightFalloff(sun, true)).toBe(sun);
    expect(withLightFalloff(fade, false)).toBe(fade);
  });

  it("packs the flag for the GPU loops only on a light that has it", () => {
    const packed = packLights([
      { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4 },
      { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, range: 4, falloff: "inverseSquare" },
      { kind: "spot", position: [0, 1, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 1, range: 4, falloff: "inverseSquare" },
    ]);
    // Bit 0 of d3.w; the lights' channels (F2e, the first) sit above it.
    expect(packed[LIGHT_FLOATS - 1]).toBe(2);
    expect(packed[2 * LIGHT_FLOATS - 1]).toBe(3);
    expect(packed[3 * LIGHT_FLOATS - 1]).toBe(3);
  });
});

describe("a rig in physical units", () => {
  it("keeps its units and each light's falloff through a save", () => {
    const rig = setSceneUnits(
      {
        ...defaultSceneLighting(),
        lights: [
          { kind: "directional", direction: [0.4, 0.8, 0.6], color: [1, 1, 1], intensity: luxToUnits(100_000) },
          { kind: "point", position: [0, 2, 0], color: [1, 0.9, 0.7], intensity: luxToUnits(800), range: 10, falloff: "inverseSquare" },
          { kind: "spot", position: [0, 3, 0], direction: [0, -1, 0], color: [1, 1, 1], intensity: 1, range: 12, innerAngle: 20, outerAngle: 30, falloff: "inverseSquare" },
        ],
      },
      true,
    );
    const saved = parseSceneLighting(JSON.parse(JSON.stringify(rig)));
    expect(saved).toEqual(rig);
    expect(saved!.units).toBe("physical");
  });

  it("is only a display choice: switching units back and forth changes nothing else", () => {
    const rig = defaultSceneLighting();
    const physical = setSceneUnits(rig, true);
    expect({ ...physical, units: undefined }).toEqual({ ...rig, units: undefined });
    expect(setSceneUnits(physical, false)).toEqual(rig);
    // An existing rig, saved before units existed, reads back exactly as it was.
    expect(parseSceneLighting(JSON.parse(JSON.stringify(rig)))).toEqual(rig);
  });

  it("drops a falloff it doesn't know, and one on a sun", () => {
    const saved = parseSceneLighting({
      lights: [
        { kind: "point", position: [0, 1, 0], color: [1, 1, 1], intensity: 1, falloff: "cubic" },
        { kind: "directional", direction: [0, 1, 0], color: [1, 1, 1], intensity: 1, falloff: "inverseSquare" },
      ],
      units: "metric",
    })!;
    expect(saved.lights[0]!.falloff).toBeUndefined();
    expect(saved.lights[1]!.falloff).toBeUndefined();
    expect(saved.units).toBeUndefined();
  });
});
