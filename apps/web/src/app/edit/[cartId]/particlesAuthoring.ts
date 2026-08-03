/**
 * Pure, immutable reducers for authoring a cart's weather/particle sidecar in the
 * editor — the Weather tab's whole model layer, so the component holds no editing
 * logic of its own (mirrors sceneAuthoring / animAuthoring).
 *
 * Every reducer routes its result back through the runtime's own `parseParticles`,
 * so what the editor previews is byte-for-byte what a reload will parse: the same
 * clamping, the same emitter cap, and the same null-on-empty collapse the save
 * route relies on. That keeps the preview honest and removes any chance of the
 * editor and runtime disagreeing about ranges.
 */

import {
  MAX_EMITTERS,
  emitterPreset,
  parseParticles,
  type ParticleEmitter,
  type ParticleKind,
  type ParticleSpec,
} from "@cartbox/player";

export { MAX_EMITTERS };

/** Canonicalise a working emitter list through the runtime parser (clamps + caps). */
function canonical(emitters: ParticleEmitter[]): ParticleSpec | null {
  return parseParticles({ emitters });
}

/** A fresh integer seed so a new emitter's field is stable across reloads. */
function freshSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}

/**
 * Add an emitter of `kind` at its preset. Capped at {@link MAX_EMITTERS}; the
 * result always has at least this emitter, so it is never null.
 */
export function withEmitterAdded(spec: ParticleSpec | null, kind: ParticleKind): ParticleSpec {
  const emitters = [...(spec?.emitters ?? []), emitterPreset(kind, freshSeed())].slice(0, MAX_EMITTERS);
  return canonical(emitters)!;
}

/** Remove the emitter at `index`; collapses to null when it was the last one. */
export function withEmitterRemoved(spec: ParticleSpec | null, index: number): ParticleSpec | null {
  if (!spec) return null;
  return canonical(spec.emitters.filter((_, i) => i !== index));
}

/**
 * Merge a patch into the emitter at `index`, re-clamped to the runtime's ranges.
 * A no-op (returns the spec unchanged) when there is no spec or the index is out
 * of range.
 */
export function withEmitterUpdated(
  spec: ParticleSpec | null,
  index: number,
  patch: Partial<ParticleEmitter>,
): ParticleSpec | null {
  if (!spec || index < 0 || index >= spec.emitters.length) return spec;
  const emitters = spec.emitters.map((emitter, i) => (i === index ? { ...emitter, ...patch } : emitter));
  return canonical(emitters) ?? spec;
}
