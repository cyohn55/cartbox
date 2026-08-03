/**
 * Cinematic gap #6 — the weather/particle system — validated end to end on its
 * pure pieces: the sidecar parser, the stateless field, and the overlay surface.
 *
 * The field is the interesting part: because a particle's whole trajectory is a
 * closed-form function of its index and the frame, the guarantees are exact and
 * checkable without a canvas — the field is reproducible, always on-screen, and
 * moves the right way per kind. Directional checks are wrap-safe (they compare the
 * per-frame delta modulo the field height), so they hold no matter where a
 * particle sits in its wrap cycle, and expectations are derived from the emitter's
 * own speed rather than hand-copied.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_EMITTERS,
  MAX_PARTICLES_PER_EMITTER,
  ParticleOverlaySurface,
  emitterPreset,
  parseParticles,
  simulateEmitter,
  type ParticleEmitter,
  type ParticleSpec,
} from "@cartbox/player";

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/** A capturing stand-in for the inner display surface. */
class RecordingSurface {
  readonly frames: Uint8Array[] = [];
  readonly refs: Uint8Array[] = [];
  destroyed = false;
  blit(rgba: Uint8Array): void {
    this.refs.push(rgba); // identity, to prove pass-through hands the frame straight on
    this.frames.push(Uint8Array.from(rgba)); // a copy, since the surface reuses its buffer
  }
  destroy(): void {
    this.destroyed = true;
  }
}

describe("parseParticles", () => {
  it("rejects anything that is not an emitter list", () => {
    for (const value of [null, undefined, 42, "rain", {}, { emitters: 5 }, { emitters: {} }]) {
      expect(parseParticles(value)).toBeNull();
    }
  });

  it("returns null when no emitter is usable (empty clears the column)", () => {
    expect(parseParticles({ emitters: [] })).toBeNull();
    expect(parseParticles({ emitters: [{ kind: "sleet" }, { nope: true }] })).toBeNull();
  });

  it("keeps the well-formed emitters and drops the malformed ones", () => {
    const parsed = parseParticles({
      emitters: [{ kind: "rain" }, { kind: "not-a-kind" }, { kind: "snow" }],
    });
    expect(parsed?.emitters.map((e) => e.kind)).toEqual(["rain", "snow"]);
  });

  it("fills a missing field from the kind's preset and clamps out-of-range values", () => {
    const parsed = parseParticles({
      emitters: [{ kind: "embers", count: 999999, opacity: 4, size: -3, speed: 100, wind: -50 }],
    });
    const emitter = parsed!.emitters[0]!;
    const preset = emitterPreset("embers", 0);
    expect(emitter.count).toBe(MAX_PARTICLES_PER_EMITTER);
    expect(emitter.opacity).toBe(1);
    expect(emitter.size).toBe(1); // clamped up to the minimum
    expect(emitter.speed).toBe(12);
    expect(emitter.wind).toBe(-6);
    expect(emitter.color).toEqual(preset.color); // colour omitted -> preset
  });

  it("validates a colour triplet and falls back when it is malformed", () => {
    const good = parseParticles({ emitters: [{ kind: "snow", color: [10, 20, 300] }] });
    expect(good!.emitters[0]!.color).toEqual([10, 20, 255]); // channel clamped
    const bad = parseParticles({ emitters: [{ kind: "snow", color: [10, 20] }] });
    expect(bad!.emitters[0]!.color).toEqual(emitterPreset("snow", 0).color);
  });

  it("caps the emitter count", () => {
    const many = Array.from({ length: MAX_EMITTERS + 4 }, () => ({ kind: "rain" }));
    expect(parseParticles({ emitters: many })!.emitters.length).toBe(MAX_EMITTERS);
  });

  it("round-trips a preset unchanged through the parser", () => {
    const spec: ParticleSpec = { emitters: [emitterPreset("rain", 3), emitterPreset("fog", 9)] };
    expect(parseParticles(JSON.parse(JSON.stringify(spec)))).toEqual(spec);
  });
});

describe("simulateEmitter", () => {
  const width = 160;
  const height = 120;

  it("produces exactly one particle per declared count", () => {
    const emitter = { ...emitterPreset("snow", 1), count: 37 };
    expect(simulateEmitter(emitter, 0, width, height).length).toBe(37);
  });

  it("keeps every particle inside the field", () => {
    const emitter = { ...emitterPreset("rain", 2), count: 200, wind: -5 };
    for (const frame of [0, 1, 50, 999]) {
      for (const p of simulateEmitter(emitter, frame, width, height)) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThan(width);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(height);
        expect(p.alpha).toBeGreaterThanOrEqual(0);
        expect(p.alpha).toBeLessThanOrEqual(1);
        expect(p.size).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("is reproducible — the same frame yields the identical field", () => {
    const emitter = emitterPreset("embers", 42);
    expect(simulateEmitter(emitter, 123, width, height)).toEqual(
      simulateEmitter(emitter, 123, width, height),
    );
  });

  it("falls for rain — each frame advances a particle downward by its speed", () => {
    const emitter: ParticleEmitter = { ...emitterPreset("rain", 5), count: 1, speed: 3, wind: 0 };
    const a = simulateEmitter(emitter, 0, width, height)[0]!;
    const b = simulateEmitter(emitter, 1, width, height)[0]!;
    // Wrap-safe: the downward delta modulo the field height is exactly the speed.
    expect(wrap(b.y - a.y, height)).toBeCloseTo(3, 6);
  });

  it("rises for embers — each frame advances a particle upward by its speed", () => {
    const emitter: ParticleEmitter = { ...emitterPreset("embers", 5), count: 1, speed: 2, wind: 0 };
    const a = simulateEmitter(emitter, 0, width, height)[0]!;
    const b = simulateEmitter(emitter, 1, width, height)[0]!;
    // Upward delta (previous minus current) modulo height equals the speed.
    expect(wrap(a.y - b.y, height)).toBeCloseTo(2, 6);
  });

  it("gives rain a streak and dot kinds none", () => {
    expect(simulateEmitter(emitterPreset("rain", 1), 0, width, height)[0]!.streak).toBeGreaterThan(0);
    expect(simulateEmitter(emitterPreset("snow", 1), 0, width, height)[0]!.streak).toBe(0);
  });
});

describe("ParticleOverlaySurface", () => {
  const width = 40;
  const height = 30;
  const blankFrame = () => new Uint8Array(width * height * 4);

  it("passes the frame straight through when no emitter is declared", () => {
    const inner = new RecordingSurface();
    const surface = new ParticleOverlaySurface(inner, width, height, { emitters: [] });
    const frame = blankFrame();
    surface.blit(frame);
    expect(inner.refs[0]).toBe(frame); // same reference — no copy, no draw
  });

  it("draws the weather onto the frame it forwards", () => {
    const inner = new RecordingSurface();
    const emitter: ParticleEmitter = {
      ...emitterPreset("snow", 7),
      count: 300,
      color: [255, 0, 0],
      opacity: 1,
    };
    const surface = new ParticleOverlaySurface(inner, width, height, { emitters: [emitter] });
    surface.blit(blankFrame());

    const drawn = inner.frames[0]!;
    let redPixels = 0;
    for (let i = 0; i < drawn.length; i += 4) if (drawn[i]! > 0) redPixels += 1;
    expect(redPixels).toBeGreaterThan(0); // particles landed
    expect(inner.refs[0]).not.toBe(undefined);
  });

  it("advances the field so consecutive frames differ", () => {
    const inner = new RecordingSurface();
    const emitter: ParticleEmitter = { ...emitterPreset("rain", 1), count: 200, opacity: 1 };
    const surface = new ParticleOverlaySurface(inner, width, height, { emitters: [emitter] });
    surface.blit(blankFrame());
    surface.blit(blankFrame());
    expect(inner.frames[0]).not.toEqual(inner.frames[1]);
  });

  it("cascades destroy to the inner surface", () => {
    const inner = new RecordingSurface();
    new ParticleOverlaySurface(inner, width, height, { emitters: [] }).destroy();
    expect(inner.destroyed).toBe(true);
  });
});
