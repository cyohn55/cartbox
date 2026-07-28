/**
 * Lighting-conditions tests — the pure model behind the voxel preview's
 * "different lighting conditions". These assert on observable outputs: the
 * presets are well-formed and the azimuth/elevation → direction conversion
 * lands on the expected unit vectors (overhead, and the compass extremes).
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIGHTING_PRESET_ID,
  LIGHTING_PRESETS,
  directionFromConditions,
  lightingPresetConditions,
} from "@cartbox/editor";

const magnitude = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);

describe("lighting presets", () => {
  it("exposes a non-empty set including the default", () => {
    expect(LIGHTING_PRESETS.length).toBeGreaterThan(0);
    expect(LIGHTING_PRESETS.some((preset) => preset.id === DEFAULT_LIGHTING_PRESET_ID)).toBe(true);
  });

  it("keeps every preset within its documented ranges", () => {
    for (const { conditions } of LIGHTING_PRESETS) {
      expect(conditions.elevation).toBeGreaterThanOrEqual(-90);
      expect(conditions.elevation).toBeLessThanOrEqual(90);
      expect(conditions.intensity).toBeGreaterThanOrEqual(0);
      expect(conditions.ambient).toBeGreaterThanOrEqual(0);
      expect(conditions.ambient).toBeLessThanOrEqual(1);
      for (const channel of conditions.color) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it("falls back to the default preset for an unknown id", () => {
    expect(lightingPresetConditions("does-not-exist")).toEqual(lightingPresetConditions(DEFAULT_LIGHTING_PRESET_ID));
  });
});

describe("directionFromConditions", () => {
  const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);

  it("always returns a unit vector", () => {
    for (const azimuth of [0, 45, 90, 200, 359]) {
      for (const elevation of [-90, -10, 0, 30, 90]) {
        const dir = directionFromConditions({ azimuth, elevation, intensity: 1, ambient: 0.2, color: [1, 1, 1] });
        expect(magnitude(dir)).toBeCloseTo(1, 5);
      }
    }
  });

  it("points straight at the viewer when overhead", () => {
    const [x, y, z] = directionFromConditions({ azimuth: 123, elevation: 90, intensity: 1, ambient: 0, color: [1, 1, 1] });
    near(x, 0);
    near(y, 0);
    near(z, 1);
  });

  it("maps compass azimuths to screen axes at the horizon", () => {
    const north = directionFromConditions({ azimuth: 0, elevation: 0, intensity: 1, ambient: 0, color: [1, 1, 1] });
    near(north[0], 0);
    near(north[1], -1); // North points up-screen (−y)

    const east = directionFromConditions({ azimuth: 90, elevation: 0, intensity: 1, ambient: 0, color: [1, 1, 1] });
    near(east[0], 1); // East points right (+x)
    near(east[1], 0);
  });

  it("drops below the plane for negative elevation (under-lighting)", () => {
    const [, , z] = directionFromConditions({ azimuth: 0, elevation: -30, intensity: 1, ambient: 0, color: [1, 1, 1] });
    expect(z).toBeLessThan(0);
  });
});
