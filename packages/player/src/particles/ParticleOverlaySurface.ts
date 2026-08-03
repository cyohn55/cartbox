/**
 * ParticleOverlaySurface — a display surface that composites a declared weather
 * system (rain/snow/embers/fog) over each presented frame, then hands off to an
 * inner surface. Cinematic gap #6.
 *
 * It decorates any {@link DisplaySurface} and is placed as the INNERMOST decorator
 * (wrapping the base terminal surface, inside the animated foreground and scene
 * backdrop): the weather is drawn last into the framebuffer, so it lands in front
 * of the cart, its parallax backdrop, and any foreground set-dressing — and when a
 * post-FX stack is active it wraps the whole base, so the weather is graded and
 * bloomed with the scene rather than pasted on flat.
 *
 * The field is stateless ({@link simulateEmitter}): each blit advances a frame
 * counter — kept in lockstep with the run loop, one tick per present — and redraws
 * the particles that frame implies, with no simulation to retain. A spec with no
 * emitters is a straight pass-through.
 */

import type { DisplaySurface } from "../display.js";
import { simulateEmitter, type Particle } from "./particleField.js";
import type { ParticleSpec } from "./particleModel.js";

export class ParticleOverlaySurface implements DisplaySurface {
  private frame = 0;
  private readonly output: Uint8ClampedArray;
  private readonly presented: Uint8Array;

  constructor(
    private readonly inner: DisplaySurface,
    private readonly width: number,
    private readonly height: number,
    private readonly spec: ParticleSpec,
  ) {
    this.output = new Uint8ClampedArray(width * height * 4);
    this.presented = new Uint8Array(this.output.buffer);
  }

  blit(rgba: Uint8Array): void {
    if (this.spec.emitters.length === 0) {
      this.inner.blit(rgba); // no weather declared — pass the frame straight through
      return;
    }
    this.output.set(rgba);
    for (const emitter of this.spec.emitters) {
      for (const particle of simulateEmitter(emitter, this.frame, this.width, this.height)) {
        this.draw(particle);
      }
    }
    this.frame += 1; // advance in lockstep with the run loop's present cadence
    this.inner.blit(this.presented);
  }

  destroy(): void {
    this.inner.destroy();
  }

  /** Straight-alpha composite one particle: a vertical streak, or a square dot. */
  private draw(particle: Particle): void {
    if (particle.alpha <= 0) return;
    const half = Math.max(0, Math.floor(particle.size / 2));
    const originX = Math.round(particle.x);

    if (particle.streak > 0) {
      // A thin vertical bar from the head down its streak length.
      const top = Math.round(particle.y);
      const bottom = top + Math.round(particle.streak);
      for (let y = top; y <= bottom; y += 1) {
        for (let dx = -half; dx <= half; dx += 1) {
          this.blend(originX + dx, y, particle);
        }
      }
      return;
    }

    // A filled square centred on the particle.
    const originY = Math.round(particle.y);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        this.blend(originX + dx, originY + dy, particle);
      }
    }
  }

  /** Alpha-blend a particle's colour onto one framebuffer pixel (bounds-checked). */
  private blend(x: number, y: number, particle: Particle): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const index = (y * this.width + x) * 4;
    const alpha = particle.alpha;
    this.output[index] = lerp(this.output[index]!, particle.color[0], alpha);
    this.output[index + 1] = lerp(this.output[index + 1]!, particle.color[1], alpha);
    this.output[index + 2] = lerp(this.output[index + 2]!, particle.color[2], alpha);
    this.output[index + 3] = 255;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
