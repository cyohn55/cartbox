/**
 * Particle-sidecar save decision tests. `PUT /api/carts/:id/particles` delegates
 * the one non-plumbing choice it makes — what to write to the `particles` column
 * for a given request body — to the pure `resolveParticlesUpdate`. These exercise
 * that decision through real bodies and assert the contract the play route and the
 * schema depend on, rather than snapshotting a stored shape:
 *   - an explicit null clears the column (author removed their weather)
 *   - a well-formed spec is accepted and comes back as the runtime's own canonical,
 *     clamped ParticleSpec (same parser the player consumes)
 *   - a body the parser can't use — including an emitter-less spec — is a 400,
 *     never a silently-stored empty weather system
 */

import { describe, expect, it } from "vitest";

import { parseParticles } from "@cartbox/player";
import { resolveParticlesUpdate } from "../apps/web/src/lib/particles";

/** A minimal but valid weather body, as the editor would PUT it. */
function sampleParticlesBody(): unknown {
  return {
    emitters: [
      { kind: "rain", count: 200, color: [180, 205, 235], opacity: 0.35, size: 1, speed: 9, wind: -1.2, seed: 1 },
      { kind: "fog", seed: 2 },
    ],
  };
}

describe("resolveParticlesUpdate", () => {
  it("clears the column when the body is an explicit null", () => {
    expect(resolveParticlesUpdate(null)).toEqual({ particles: null });
  });

  it("accepts a well-formed spec and stores the parser's canonical form", () => {
    const body = sampleParticlesBody();
    const update = resolveParticlesUpdate(body);

    expect("error" in update).toBe(false);
    if ("error" in update) return; // narrow for the type checker
    // The stored value is exactly what the runtime would parse from the same body,
    // so the play route reads back what the player will composite.
    expect(update.particles).toEqual(parseParticles(body));
    expect(update.particles?.emitters.length).toBe(2);
  });

  it("stores a spec the parser has clamped rather than the raw out-of-range body", () => {
    const body = { emitters: [{ kind: "snow", count: 999999, opacity: 8, wind: -99 }] };

    const update = resolveParticlesUpdate(body);
    if ("error" in update) throw new Error("expected the clamped spec to be accepted");

    const emitter = update.particles!.emitters[0]!;
    expect(emitter.count).toBeLessThanOrEqual(600);
    expect(emitter.opacity).toBeLessThanOrEqual(1);
    expect(emitter.wind).toBeGreaterThanOrEqual(-6);
  });

  const rejected: Array<[string, unknown]> = [
    ["a non-object body", "not-weather"],
    ["an emitter-less spec", { emitters: [] }],
    ["a spec whose only emitter has an unknown kind", { emitters: [{ kind: "sleet" }] }],
    ["a spec whose emitters are all malformed", { emitters: [{ nope: true }, 5] }],
  ];
  for (const [label, body] of rejected) {
    it(`rejects ${label} with a client error rather than storing it`, () => {
      expect("error" in resolveParticlesUpdate(body)).toBe(true);
    });
  }
});
