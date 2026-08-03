/**
 * Weather-tab authoring-reducer tests. The Weather tab holds no model logic; every
 * mutation goes through these pure reducers, which route their result through the
 * runtime's own parser so what the editor shows equals what a reload parses.
 *
 * The checks are about that contract: adds respect the cap and land canonical,
 * removes collapse to null on the last emitter, and updates re-clamp to the same
 * ranges the runtime enforces. Expectations come from the runtime constants, not
 * copied numbers.
 */

import { describe, expect, it } from "vitest";

import { MAX_EMITTERS, emitterPreset, parseParticles, type ParticleSpec } from "@cartbox/player";
import {
  withEmitterAdded,
  withEmitterRemoved,
  withEmitterUpdated,
} from "../apps/web/src/app/edit/[cartId]/particlesAuthoring";

/** Every reducer output must already be in the parser's canonical form. */
function expectCanonical(spec: ParticleSpec | null): void {
  expect(parseParticles(spec)).toEqual(spec);
}

describe("withEmitterAdded", () => {
  it("creates the first emitter from a null spec", () => {
    const spec = withEmitterAdded(null, "rain");
    expect(spec.emitters.length).toBe(1);
    expect(spec.emitters[0]!.kind).toBe("rain");
    expectCanonical(spec);
  });

  it("appends further emitters and stops at the cap", () => {
    let spec: ParticleSpec | null = null;
    for (let i = 0; i < MAX_EMITTERS + 3; i += 1) spec = withEmitterAdded(spec, "snow");
    expect(spec!.emitters.length).toBe(MAX_EMITTERS);
    expectCanonical(spec);
  });
});

describe("withEmitterRemoved", () => {
  it("drops the emitter at the index and stays canonical", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("rain", 1), emitterPreset("fog", 2)] };
    const after = withEmitterRemoved(spec, 0);
    expect(after!.emitters.map((e) => e.kind)).toEqual(["fog"]);
    expectCanonical(after);
  });

  it("collapses to null when the last emitter is removed", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("embers", 5)] };
    expect(withEmitterRemoved(spec, 0)).toBeNull();
  });
});

describe("withEmitterUpdated", () => {
  it("merges a patch and re-clamps to the runtime ranges", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("snow", 1)] };
    const after = withEmitterUpdated(spec, 0, { count: 999999, opacity: 9, wind: -99 });
    const emitter = after!.emitters[0]!;
    expect(emitter.count).toBe(600);
    expect(emitter.opacity).toBe(1);
    expect(emitter.wind).toBe(-6);
    expectCanonical(after);
  });

  it("is a no-op for an out-of-range index", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("rain", 1)] };
    expect(withEmitterUpdated(spec, 5, { count: 2 })).toBe(spec);
    expect(withEmitterUpdated(null, 0, { count: 2 })).toBeNull();
  });

  it("preserves the seed so an emitter's field is stable across edits", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("fog", 4242)] };
    const after = withEmitterUpdated(spec, 0, { opacity: 0.5 });
    expect(after!.emitters[0]!.seed).toBe(4242);
  });
});
