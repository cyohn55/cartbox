/**
 * Post-processing effect-model tests, covering the stack after it grew from the
 * console's own signal path to include the ported screen-space looks.
 *
 * The whole design rests on one property: a disabled effect folds to a neutral
 * uniform, so the single compiled shader never branches on which effects are on.
 * That property is what these check — generically, over every effect in the
 * registry, so an effect added later is covered the day it is added rather than
 * the day somebody remembers to write a test for it.
 */

import { describe, expect, it } from "vitest";
import {
  POST_FX_EFFECTS,
  anyPostFxEnabled,
  defaultPostFxSettings,
  hexToRgb01,
  paramKey,
  parsePostFxSettings,
  uniformsFromSettings,
  type PostFxEffectId,
  type PostFxSettings,
  type PostFxUniforms,
} from "@cartbox/player";

/** Uniforms that must read zero when nothing is switched on. */
const ZEROED: Array<keyof PostFxUniforms> = [
  "fogDensity",
  "bloomStrength",
  "curvature",
  "scanlines",
  "aberration",
  "vignette",
  "posterize",
  "ditherAmount",
  "halftoneStrength",
  "godrayStrength",
  "streakStrength",
  "splitStrength",
  "reflectionStrength",
  "tiltStrength",
  "kaleidoSegments",
  "grainAmount",
];

/** Uniforms whose neutral value is 1 (an identity multiply), not 0. */
const IDENTITY: Array<keyof PostFxUniforms> = ["brightness", "contrast", "saturation"];

function withEverythingEnabled(): PostFxSettings {
  const settings = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) settings.enabled[effect.id] = true;
  return settings;
}

describe("the effect registry", () => {
  it("gives every effect a unique id, a description, and at least one parameter", () => {
    const ids = POST_FX_EFFECTS.map((effect) => effect.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const effect of POST_FX_EFFECTS) {
      expect(effect.params.length, effect.id).toBeGreaterThan(0);
      expect(effect.description.length, effect.id).toBeGreaterThan(0);
    }
  });

  it("declares every parameter's default inside its own range", () => {
    for (const effect of POST_FX_EFFECTS) {
      for (const param of effect.params) {
        expect(param.min, `${effect.id}.${param.id}`).toBeLessThan(param.max);
        expect(param.defaultValue).toBeGreaterThanOrEqual(param.min);
        expect(param.defaultValue).toBeLessThanOrEqual(param.max);
      }
    }
  });

  it("declares every colour as a valid hex triplet", () => {
    for (const effect of POST_FX_EFFECTS) {
      for (const color of effect.colors ?? []) {
        expect(color.defaultValue, `${effect.id}.${color.id}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });
});

describe("defaultPostFxSettings", () => {
  it("starts with everything off and every declared value present", () => {
    const settings = defaultPostFxSettings();

    expect(anyPostFxEnabled(settings)).toBe(false);
    for (const effect of POST_FX_EFFECTS) {
      expect(settings.enabled[effect.id], effect.id).toBe(false);
      for (const param of effect.params) {
        expect(settings.values[paramKey(effect.id, param.id)]).toBe(param.defaultValue);
      }
      for (const color of effect.colors ?? []) {
        expect(settings.colors[paramKey(effect.id, color.id)]).toBe(color.defaultValue);
      }
    }
  });

  it("reports the stack as live as soon as any one effect is on", () => {
    for (const effect of POST_FX_EFFECTS) {
      const settings = defaultPostFxSettings();
      settings.enabled[effect.id] = true;
      expect(anyPostFxEnabled(settings), effect.id).toBe(true);
    }
  });
});

describe("uniformsFromSettings", () => {
  it("folds an all-off stack to neutral, so the shader is a pass-through", () => {
    const uniforms = uniformsFromSettings(defaultPostFxSettings());

    for (const key of ZEROED) expect(uniforms[key], key).toBe(0);
    for (const key of IDENTITY) expect(uniforms[key], key).toBe(1);
  });

  it("gives each effect its own uniforms, so one can never disturb another", () => {
    // The ownership is derived, not written down: turn one effect on, push its
    // parameters to their extremes, and see which uniforms move. Two effects
    // whose sets overlapped would mean one could silently override the other.
    const baseline = uniformsFromSettings(defaultPostFxSettings());
    const keys = Object.keys(baseline) as Array<keyof PostFxUniforms>;

    const movedBy = (id: PostFxEffectId): Set<string> => {
      const effect = POST_FX_EFFECTS.find((entry) => entry.id === id)!;
      const settings = defaultPostFxSettings();
      settings.enabled[id] = true;
      for (const param of effect.params) settings.values[paramKey(id, param.id)] = param.max;
      const uniforms = uniformsFromSettings(settings);
      return new Set(
        keys.filter((key) => JSON.stringify(uniforms[key]) !== JSON.stringify(baseline[key])),
      );
    };

    const owned = new Map(POST_FX_EFFECTS.map((effect) => [effect.id, movedBy(effect.id)] as const));

    for (const [id, set] of owned) {
      // Every effect has to actually reach the shader, or enabling it does nothing.
      expect(set.size, `${id} moves no uniform`).toBeGreaterThan(0);
      for (const [otherId, otherSet] of owned) {
        if (otherId === id) continue;
        const shared = [...set].filter((key) => otherSet.has(key));
        expect(shared, `${id} and ${otherId} share ${shared.join(", ")}`).toEqual([]);
      }
    }
  });

  it("surfaces a parameter's value once its effect is enabled", () => {
    const settings = defaultPostFxSettings();
    settings.enabled.godrays = true;
    settings.values[paramKey("godrays", "strength")] = 1.25;

    expect(uniformsFromSettings(settings).godrayStrength).toBe(1.25);
  });

  it("reads shape parameters whether or not their effect is on", () => {
    // A position or a threshold says *where* an effect happens; clamping it to a
    // neutral would be meaningless, and it must survive the effect being off.
    const settings = defaultPostFxSettings();
    settings.values[paramKey("godrays", "x")] = 0.2;
    settings.values[paramKey("godrays", "y")] = 0.9;
    settings.values[paramKey("fog", "horizon")] = 0.75;

    const off = uniformsFromSettings(settings);
    expect(off.godrayOrigin).toEqual([0.2, 0.9]);
    expect(off.fogHorizon).toBe(0.75);
    // …and the strength is still neutral, so nothing is drawn there.
    expect(off.godrayStrength).toBe(0);
  });

  it("converts declared degrees into the radians the shader wants", () => {
    const settings = withEverythingEnabled();
    settings.values[paramKey("halftone", "angle")] = 90;
    settings.values[paramKey("kaleidoscope", "angle")] = 180;

    const uniforms = uniformsFromSettings(settings);
    expect(uniforms.halftoneAngle).toBeCloseTo(Math.PI / 2, 10);
    expect(uniforms.kaleidoAngle).toBeCloseTo(Math.PI, 10);
  });

  it("resolves every declared colour into a 0..1 triplet", () => {
    const settings = defaultPostFxSettings();
    settings.colors[paramKey("splittone", "shadows")] = "#ff8000";

    const uniforms = uniformsFromSettings(settings);
    expect(uniforms.splitShadows).toEqual(hexToRgb01("#ff8000"));
    // A colour left at its default still resolves rather than yielding NaN.
    for (const channel of uniforms.splitHighlights) expect(Number.isFinite(channel)).toBe(true);
  });

  it("falls back to a declared default when a colour is missing entirely", () => {
    const settings = defaultPostFxSettings();
    settings.colors = {};
    for (const channel of uniformsFromSettings(settings).fogColor) {
      expect(Number.isFinite(channel)).toBe(true);
    }
  });
});

describe("parsePostFxSettings", () => {
  it("rejects anything that is not an effect stack", () => {
    for (const value of [null, undefined, 42, "grade", [], {}, { enabled: 1, values: {} }]) {
      expect(parsePostFxSettings(value)).toBeNull();
    }
  });

  it("round-trips a full stack unchanged", () => {
    const settings = withEverythingEnabled();
    expect(parsePostFxSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings);
  });

  it("clamps every out-of-range value into its declared bounds", () => {
    const settings = defaultPostFxSettings();
    for (const effect of POST_FX_EFFECTS) {
      for (const param of effect.params) {
        settings.values[paramKey(effect.id, param.id)] = param.max * 1000 + 1000;
      }
    }

    const parsed = parsePostFxSettings(JSON.parse(JSON.stringify(settings)))!;
    for (const effect of POST_FX_EFFECTS) {
      for (const param of effect.params) {
        expect(parsed.values[paramKey(effect.id, param.id)], `${effect.id}.${param.id}`).toBe(param.max);
      }
    }
  });

  it("defaults anything omitted rather than failing", () => {
    const parsed = parsePostFxSettings({ enabled: {}, values: {} })!;
    expect(parsed).toEqual(defaultPostFxSettings());
  });

  it("drops an unknown effect and a malformed colour", () => {
    const parsed = parsePostFxSettings({
      enabled: { grade: true, "not-an-effect": true },
      values: { "not-an-effect.amount": 5, "grade.brightness": 1.2 },
      colors: { "fog.tint": "not a colour" },
    })!;

    expect((parsed.enabled as Record<string, unknown>)["not-an-effect"]).toBeUndefined();
    expect(parsed.values["not-an-effect.amount"]).toBeUndefined();
    expect(parsed.values[paramKey("grade", "brightness")]).toBe(1.2);
    expect(parsed.colors[paramKey("fog", "tint")]).toBe(defaultPostFxSettings().colors[paramKey("fog", "tint")]);
  });

  it("honours a fog colour written before effects declared their own colours", () => {
    // The shape rows in the database still carry.
    const legacy = { enabled: { fog: true }, values: { "fog.density": 0.5 }, fogColor: "#123456" };
    const parsed = parsePostFxSettings(legacy)!;

    expect(parsed.colors[paramKey("fog", "tint")]).toBe("#123456");
    expect(uniformsFromSettings(parsed).fogColor).toEqual(hexToRgb01("#123456"));
  });

  it("prefers an explicit colour over the legacy field when both are present", () => {
    const parsed = parsePostFxSettings({
      enabled: {},
      values: {},
      colors: { "fog.tint": "#abcdef" },
      fogColor: "#123456",
    })!;

    expect(parsed.colors[paramKey("fog", "tint")]).toBe("#abcdef");
  });

  it("keeps every effect's enabled flag independent", () => {
    for (const effect of POST_FX_EFFECTS) {
      const parsed = parsePostFxSettings({ enabled: { [effect.id]: true }, values: {} })!;
      const on = POST_FX_EFFECTS.filter((entry) => parsed.enabled[entry.id]).map((entry) => entry.id);
      expect(on).toEqual([effect.id as PostFxEffectId]);
    }
  });
});
