/**
 * The deterministic particle field — cinematic gap #6. Turns one
 * {@link ParticleEmitter} into the set of particles visible at a given frame,
 * with zero retained state: a particle's whole trajectory is a closed-form
 * function of its index and the frame counter, so the same frame always yields
 * the same field (matching the editor preview to playback and to a replay) and
 * there is nothing to advance or reset. This is the classic stateless
 * screen-wrapping particle field, and being pure it can be unit-tested headlessly
 * the way the scene and anim models are.
 *
 * The per-kind character lives here, not in the sidecar: rain streaks and slants,
 * snow drifts and sways, embers rise and flicker and fade as they climb, fog
 * crawls sideways in large soft blobs. An emitter only supplies the handful of
 * knobs those share (count/colour/opacity/size/speed/wind).
 */

import type { ParticleEmitter, ParticleKind } from "./particleModel.js";

const TAU = Math.PI * 2;

/** One drawable particle at a moment in time. */
export interface Particle {
  /** Column in framebuffer pixels. */
  x: number;
  /** Row in framebuffer pixels. */
  y: number;
  /** Footprint size in pixels. */
  size: number;
  /** Composite alpha, 0..1. */
  alpha: number;
  /** Colour, each channel 0..255. */
  color: readonly [number, number, number];
  /** Vertical streak length in pixels (rain); 0 draws a dot. */
  streak: number;
}

/**
 * A stable 0..1 hash of three integers — an integer bit-mix (xorshift/multiply)
 * rather than a sin-based hash, so it is bit-identical across platforms and gives
 * each particle its own fixed spawn point, phase, and jitter.
 */
function hash01(seed: number, index: number, salt: number): number {
  let h = (Math.imul(seed, 374761393) + Math.imul(index, 668265263) + Math.imul(salt, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Positive modulo, so a leftward wind or an upward rise still wraps into range. */
function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * The particles an emitter shows at `frame`, wrapped into a `width`×`height` field.
 *
 * Every particle is placed from its hashed spawn point and advanced by the frame
 * clock along its kind's motion; screen-wrapping keeps the field full forever
 * without spawning or retiring anything. Positions are always inside the field.
 */
export function simulateEmitter(
  emitter: ParticleEmitter,
  frame: number,
  width: number,
  height: number,
): Particle[] {
  const particles: Particle[] = [];
  const kind: ParticleKind = emitter.kind;

  for (let index = 0; index < emitter.count; index += 1) {
    const spawnX = hash01(emitter.seed, index, 1);
    const spawnY = hash01(emitter.seed, index, 2);
    const phase = hash01(emitter.seed, index, 3) * TAU;
    const jitter = hash01(emitter.seed, index, 4);

    let x = spawnX * width + emitter.wind * frame;
    let y: number;
    let streak = 0;
    let alpha = emitter.opacity;
    let size = emitter.size;

    if (kind === "rain") {
      y = spawnY * height + emitter.speed * frame;
      // A streak proportional to speed reads as motion blur on a fast drop.
      streak = 2 + emitter.speed * 0.6;
    } else if (kind === "snow") {
      y = spawnY * height + emitter.speed * frame;
      x += Math.sin(frame * 0.05 + phase) * 6; // lateral sway
      size = emitter.size * (0.7 + 0.6 * jitter);
    } else if (kind === "embers") {
      y = spawnY * height - emitter.speed * frame; // rise
      x += Math.sin(frame * 0.08 + phase) * 4;
      // Flicker, and dim as the ember climbs (bright near the source, faint aloft).
      const climb = wrap(y, height) / height; // 1 near the bottom, 0 near the top
      const flicker = 0.55 + 0.45 * Math.sin(frame * 0.3 + phase * 5);
      alpha = emitter.opacity * flicker * (0.3 + 0.7 * climb);
    } else {
      // fog: slow sideways crawl in large soft blobs; barely falls.
      y = spawnY * height + emitter.speed * frame * 0.3;
      size = emitter.size * (0.8 + 0.5 * jitter);
    }

    particles.push({
      x: wrap(x, width),
      y: wrap(y, height),
      size: Math.max(1, size),
      alpha: clamp01(alpha),
      color: emitter.color,
      streak,
    });
  }

  return particles;
}
