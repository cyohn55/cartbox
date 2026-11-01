/**
 * Lockout and Beaver Creek re-lit in physical units on the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F11a-11). Nothing in the re-light is tuned by eye,
 * so these hold it to the physics it claims: the sun above the air, the sky's
 * own light in the shade, and a sunny day's exposure under which an 18% grey
 * card in the open shows as middle grey and sunlit snow doesn't clip.
 */

import { describe, expect, it } from "vitest";

import {
  BEAVER_LIGHTING,
  BEAVER_SCENE,
  LOCKOUT_LIGHTING,
  LOCKOUT_SCENE,
  SUN_ABOVE_AIR,
  aaaLighting,
  atmosphereLuts,
  atmospherePanorama,
  groundSun,
  lightColor,
  luxToUnits,
  parseSceneLighting,
  resolveAtmosphere,
  type SceneLighting,
} from "@cartbox/editor";

const maps = [
  { name: "Lockout", rig: LOCKOUT_LIGHTING, parts: () => LOCKOUT_SCENE.parts() },
  { name: "Beaver Creek", rig: BEAVER_LIGHTING, parts: () => BEAVER_SCENE.parts() },
] as const;

const toLinear = (c: number) => (c <= 0.04045 ? Math.max(0, c) / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const luminance = (c: readonly number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;

/** A level surface's light (in the renderer's units, its diffuse without 1/π): the sun through the air on it, and the sky's irradiance over π. */
function levelLight(relit: SceneLighting): number[] {
  const key = relit.lights.find((l) => l.kind === "directional")!;
  const d = key.direction!;
  const l = Math.hypot(d[0], d[1], d[2]);
  const settings = relit.sky!.atmosphere!;
  const sun = groundSun(settings, d).map((v) => v * Math.max(0, d[1] / l));
  const pano = atmospherePanorama(atmosphereLuts(resolveAtmosphere(settings)), [d[0] / l, d[1] / l, d[2] / l], [key.intensity, key.intensity, key.intensity], 64, 32);
  const sky = [0, 0, 0];
  for (let y = 0; y < pano.height / 2; y += 1) {
    const theta = (Math.PI * (y + 0.5)) / pano.height;
    const w = (Math.cos(theta) * Math.sin(theta) * (Math.PI / pano.height) * ((2 * Math.PI) / pano.width)) / Math.PI;
    for (let x = 0; x < pano.width; x += 1) for (let c = 0; c < 3; c += 1) sky[c]! += pano.data[(y * pano.width + x) * 3 + c]! * w;
  }
  return sun.map((v, c) => v + sky[c]!);
}

/** How a surface of `albedo` under `light` shows at the rig's exposure, through the physical curve (encoded, 0..1). */
const shown = (albedo: number, light: readonly number[], exposure: number) => encode(aces(albedo * luminance(light) * exposure));

describe.each(maps)("$name, re-lit", ({ rig, parts }) => {
  const shipped = parseSceneLighting(JSON.parse(JSON.stringify(parts().lighting)))!;
  const relit = aaaLighting(shipped);

  it("ships the re-light for the AAA tier, leaving every other tier's rig as it was tuned", () => {
    expect(shipped.aaa).toBeTruthy();
    const { aaa: _aaa, lightProbes: _probes, ...authored } = shipped;
    const { lightProbes: _p, ...tuned } = rig;
    expect(JSON.parse(JSON.stringify(authored))).toEqual(JSON.parse(JSON.stringify(parseSceneLighting(tuned))));
  });

  it("stores only its physical parameters, and derives the rest from the rig, so it follows the rig's edits", () => {
    expect(Object.keys(shipped.aaa!)).toEqual(["physical"]);
    expect(JSON.stringify(shipped.aaa).length).toBeLessThan(600);
    // A lamp turned up on the rig is turned up in the re-light in proportion.
    const index = shipped.lights.findIndex((l) => l.kind !== "directional");
    const brighter = { ...shipped, lights: shipped.lights.map((l, i) => (i === index ? { ...l, intensity: l.intensity * 2 } : l)) };
    const lamp = (r: SceneLighting) => r.lights.filter((l) => l.kind !== "directional")[0]!.intensity;
    expect(lamp(aaaLighting(brighter)) / lamp(relit)).toBeCloseTo(2, 9);
  });

  it("lights by the sun above the air and the physical sky, with the painted landscape kept in front of it", () => {
    const keys = relit.lights.filter((l) => l.kind === "directional");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.intensity).toBeCloseTo(luxToUnits(128_000), 9);
    expect(keys[0]!.color).toEqual([1, 1, 1]);
    expect(SUN_ABOVE_AIR).toBe(luxToUnits(128_000));
    expect(relit.sky?.atmosphere?.landscape).toBe(true);
    expect(relit.sky?.atmosphere?.clouds).toBeTruthy();
    expect(relit.sky?.objects).toEqual(rig.sky?.objects);
    expect(relit.environment.intensity).toBe(1);
    expect(relit.units).toBe("physical");
    // Real-time GI in place of what was baked under the byte rig; volumetric air in place of the shafts.
    expect(relit.dynamicGi).toBeTruthy();
    expect(relit.lightProbes).toBeUndefined();
    expect(relit.fog?.volumetric).toBeTruthy();
    expect(relit.shafts).toBeUndefined();
  });

  it("keeps each local light's ratio to the key light, now against the sun as it reaches the ground", () => {
    const key = rig.lights.find((l) => l.kind === "directional")!;
    const authoredKey = luminance(lightColor(key).map(toLinear)) * key.intensity;
    const sun = luminance(groundSun(relit.sky!.atmosphere!, key.direction!));
    const before = rig.lights.filter((l) => l.kind !== "directional");
    const after = relit.lights.filter((l) => l.kind !== "directional");
    expect(after).toHaveLength(before.length);
    after.forEach((l, i) => expect(l.intensity / sun).toBeCloseTo(before[i]!.intensity / authoredKey, 9));
    // The noon sun reaches the ground at about 100–120 klx.
    expect(sun * 123_532).toBeGreaterThan(95_000);
    expect(sun * 123_532).toBeLessThan(125_000);
  });

  it("shows an 18% grey card in the open as middle grey, and sunlit snow below white, at EV100 15", () => {
    expect(relit.exposure).toBe(1);
    const light = levelLight(relit);
    // Middle grey: 18% reflectance shows at about 46% of the encoded range (118 of 255).
    const grey = shown(0.18, light, relit.exposure);
    expect(grey).toBeGreaterThan(0.4);
    expect(grey).toBeLessThan(0.56);
    // Fresh snow (85%) holds detail: under white.
    expect(shown(0.85, light, relit.exposure)).toBeLessThan(0.97);
    // And the sky fills the shade, blue: a clear sky's diffuse light is 6–25% of the direct beam (atmosphere.test.ts).
    const key = relit.lights.find((l) => l.kind === "directional")!;
    const d = key.direction!;
    const direct = groundSun(relit.sky!.atmosphere!, d).map((v) => v * Math.max(0, d[1] / Math.hypot(d[0], d[1], d[2])));
    const shade = light.map((v, c) => v - direct[c]!);
    expect(luminance(shade) / luminance(direct)).toBeGreaterThan(0.05);
    expect(luminance(shade) / luminance(direct)).toBeLessThan(0.25);
    expect(shade[2]! / shade[0]!).toBeGreaterThan(1.2);
  });
});

describe("the sun through the air", () => {
  it("is the LUT's transmittance, integrated along the one ray", async () => {
    const { sunTransmittance } = await import("@cartbox/editor");
    for (const altitude of [0, 600, 3000]) {
      const settings = { altitude };
      const d = [0.42, 0.8, -0.46];
      const lut = sunTransmittance(atmosphereLuts(resolveAtmosphere(settings)), d);
      groundSun(settings, d).forEach((v, c) => expect(v / SUN_ABOVE_AIR / lut[c]!).toBeCloseTo(1, 2));
    }
  });
});
