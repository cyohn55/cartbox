/**
 * @cartbox/player particles — a host-played weather/atmosphere overlay
 * (rain/snow/embers/fog) a cart declares as a sidecar. Cinematic gap #6.
 *
 * A cart carries a {@link ParticleSpec}; the player composites the declared
 * emitters over each frame via {@link ParticleOverlaySurface}, driven by the pure,
 * stateless {@link simulateEmitter} field. No cart code is involved — the same
 * sidecar model as scene/anim.
 */

export {
  MAX_EMITTERS,
  MAX_PARTICLES_PER_EMITTER,
  PARTICLE_KINDS,
  emitterPreset,
  parseParticles,
} from "./particleModel.js";
export type { ParticleEmitter, ParticleKind, ParticleSpec } from "./particleModel.js";
export { simulateEmitter } from "./particleField.js";
export type { Particle } from "./particleField.js";
export { ParticleOverlaySurface } from "./ParticleOverlaySurface.js";
