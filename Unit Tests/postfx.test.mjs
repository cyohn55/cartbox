/**
 * Unit tests for the shared post-processing model (packages/player/src/fx/
 * postfx.ts): default settings cover every declared effect/param,
 * uniformsFromSettings folds disabled effects to neutral values while enabled
 * effects pass through, anyPostFxEnabled gates the runtime wrap, and
 * parsePostFxSettings validates/clamps untrusted wire JSON.
 *
 * Run:  node --experimental-transform-types --import "./Unit Tests/registerLightingHooks.mjs" "Unit Tests/postfx.test.mjs"
 */

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(here, "../packages/player/src/fx/postfx.ts");
const {
  POST_FX_EFFECTS,
  anyPostFxEnabled,
  defaultPostFxSettings,
  paramKey,
  parsePostFxSettings,
  uniformsFromSettings,
  hexToRgb01,
} = await import(pathToFileURL(modulePath).href);

let passed = 0;

// 1. Defaults: every effect starts disabled with every param at its declared default.
{
  const settings = defaultPostFxSettings();
  for (const effect of POST_FX_EFFECTS) {
    assert.equal(settings.enabled[effect.id], false);
    for (const param of effect.params) {
      assert.equal(settings.values[paramKey(effect.id, param.id)], param.defaultValue);
    }
  }
  assert.equal(anyPostFxEnabled(settings), false);
  passed += 1;
}

// 2. All effects disabled folds to the identity/neutral uniform block.
{
  const uniforms = uniformsFromSettings(defaultPostFxSettings());
  assert.equal(uniforms.brightness, 1);
  assert.equal(uniforms.contrast, 1);
  assert.equal(uniforms.saturation, 1);
  assert.equal(uniforms.fogDensity, 0);
  assert.equal(uniforms.bloomStrength, 0);
  assert.equal(uniforms.curvature, 0);
  assert.equal(uniforms.scanlines, 0);
  assert.equal(uniforms.aberration, 0);
  assert.equal(uniforms.vignette, 0);
  assert.equal(uniforms.posterize, 0);
  passed += 1;
}

// 3. Enabling an effect passes its configured (non-default) values through and
//    flips anyPostFxEnabled.
{
  const settings = defaultPostFxSettings();
  settings.enabled.fog = true;
  settings.values[paramKey("fog", "density")] = 0.8;
  settings.fogColor = "#ff8040";
  const uniforms = uniformsFromSettings(settings);
  assert.equal(uniforms.fogDensity, 0.8);
  assert.deepEqual(uniforms.fogColor, hexToRgb01("#ff8040"));
  assert.equal(anyPostFxEnabled(settings), true);
  passed += 1;
}

// 4. Effects are independent: enabling one leaves the others neutral.
{
  const settings = defaultPostFxSettings();
  settings.enabled.crt = true;
  settings.values[paramKey("crt", "scanlines")] = 0.9;
  const uniforms = uniformsFromSettings(settings);
  assert.equal(uniforms.scanlines, 0.9);
  assert.equal(uniforms.fogDensity, 0);
  assert.equal(uniforms.bloomStrength, 0);
  assert.equal(uniforms.brightness, 1);
  passed += 1;
}

// 5. Posterize maps enabled → its level count, disabled → 0 (the shader's off value).
{
  const settings = defaultPostFxSettings();
  settings.enabled.posterize = true;
  settings.values[paramKey("posterize", "levels")] = 6;
  assert.equal(uniformsFromSettings(settings).posterize, 6);
  settings.enabled.posterize = false;
  assert.equal(uniformsFromSettings(settings).posterize, 0);
  passed += 1;
}

// 6. hexToRgb01 round-trips channel bytes to 0..1 within quantisation error.
{
  for (const [hex, rgb] of [
    ["#000000", [0, 0, 0]],
    ["#ffffff", [1, 1, 1]],
    ["#ff8000", [1, 128 / 255, 0]],
  ]) {
    assert.deepEqual(hexToRgb01(hex), rgb);
  }
  passed += 1;
}

// 7. parsePostFxSettings round-trips its own settings verbatim.
{
  const settings = defaultPostFxSettings();
  settings.enabled.bloom = true;
  settings.values[paramKey("bloom", "strength")] = 1.2;
  settings.fogColor = "#123abc";
  assert.deepEqual(parsePostFxSettings(JSON.parse(JSON.stringify(settings))), settings);
  passed += 1;
}

// 8. Malformed wire shapes are rejected outright.
{
  for (const bad of [null, 7, "fx", [], {}, { enabled: {} }, { values: {} }, { enabled: 3, values: {} }]) {
    assert.equal(parsePostFxSettings(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  passed += 1;
}

// 9. Out-of-range values clamp to each param's declared bounds; junk values and
//    unknown keys are ignored (defaults win), and bad colours are dropped.
{
  const wire = {
    enabled: { fog: true, nonsense: true },
    values: {
      [paramKey("fog", "density")]: 99, // clamps to max
      [paramKey("fog", "horizon")]: -5, // clamps to min
      [paramKey("grade", "brightness")]: "loud", // wrong type → default kept
      "unknown.param": 1, // dropped
    },
    fogColor: "not-a-colour",
  };
  const parsed = parsePostFxSettings(wire);
  assert.ok(parsed);
  const fogDensity = POST_FX_EFFECTS.find((effect) => effect.id === "fog").params.find(
    (param) => param.id === "density",
  );
  const fogHorizon = POST_FX_EFFECTS.find((effect) => effect.id === "fog").params.find(
    (param) => param.id === "horizon",
  );
  assert.equal(parsed.enabled.fog, true);
  assert.equal(parsed.values[paramKey("fog", "density")], fogDensity.max);
  assert.equal(parsed.values[paramKey("fog", "horizon")], fogHorizon.min);
  assert.equal(parsed.values[paramKey("grade", "brightness")], 1);
  assert.equal("unknown.param" in parsed.values, false);
  assert.equal(parsed.fogColor, defaultPostFxSettings().fogColor);
  assert.equal("nonsense" in parsed.enabled, false);
  passed += 1;
}

console.log(`postfx: ${passed} checks passed`);
