/**
 * Sun glare and lens flare (HALO2_STYLE_ROADMAP.md, H8): the maths the
 * post-process shader's flare is a port of, DOM-free so it is unit-tested
 * headlessly — the pattern bloomModel.ts and lensModel.ts set.
 *
 * Two parts, both additive light keyed to one bright source on screen:
 *
 * - Glare: a soft glow round the source with a six-pointed starburst, the
 *   aperture's diffraction spikes — how a camera sees the sun.
 * - Ghosts: reflections between the lens elements, strung along the line from
 *   the source through the frame centre and out the other side, each a soft
 *   disc with its own tint.
 *
 * `visible` (0..1) scales the whole flare: the 3D scene reports how much of the
 * sun is unblocked, so a flare fades out as a tower slides across the sun
 * rather than shining through it. UVs have a top-left origin, as in the shader.
 */

/** One lens ghost: where it sits on the source→centre axis and how it looks. */
export interface FlareGhost {
  /** Position along the axis: 1 = on the source, 0 = frame centre, negative = past it. */
  readonly along: number;
  /** Radius in screen-height units. */
  readonly radius: number;
  /** Tint, times its brightness. */
  readonly tint: readonly [number, number, number];
}

/** The ghosts, spread across the axis with cool Halo-era tints and one warm one. */
export const FLARE_GHOSTS: readonly FlareGhost[] = [
  { along: 0.55, radius: 0.035, tint: [0.35, 0.6, 1.0] },
  { along: 0.2, radius: 0.06, tint: [0.25, 0.5, 0.9] },
  { along: -0.3, radius: 0.045, tint: [0.9, 0.6, 0.3] },
  { along: -0.6, radius: 0.1, tint: [0.3, 0.45, 0.8] },
  { along: -1.1, radius: 0.16, tint: [0.2, 0.35, 0.7] },
];

/** Brightness of each ghost at ghost strength 1. */
export const FLARE_GHOST_GAIN = 0.45;

/** Tightness of the starburst spikes: |cos 3θ|^power. */
export const FLARE_SPIKE_POWER = 48;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export interface FlareParams {
  /** Glare strength (0 = none). */
  readonly glare: number;
  /** Ghost strength (0 = none). */
  readonly ghosts: number;
  /** Glare radius in screen-height units. */
  readonly size: number;
  /** 0 (hidden) .. 1 (fully unblocked). */
  readonly visible: number;
}

/**
 * The flare's light at `uv` for a source at `origin` (both 0..1, y down), in
 * a frame `aspect` wide per unit high. The shader multiplies by the tint colour.
 */
export function lensFlareAt(
  uv: readonly [number, number],
  origin: readonly [number, number],
  aspect: number,
  params: FlareParams,
): [number, number, number] {
  if (params.visible <= 0 || (params.glare <= 0 && params.ghosts <= 0)) return [0, 0, 0];
  // Aspect-corrected, so the glare is round and ghosts keep their shape.
  const dx = (uv[0] - origin[0]) * aspect;
  const dy = uv[1] - origin[1];
  const r = Math.hypot(dx, dy);
  const size = Math.max(0.01, params.size);
  const glow = Math.exp(-(r * r) / (size * size));
  const angle = Math.atan2(dy, dx);
  const spikes = Math.pow(Math.abs(Math.cos(angle * 3)), FLARE_SPIKE_POWER) * Math.exp(-r / (size * 2.5));
  const g = params.glare * (glow + spikes * 0.6);
  let red = g;
  let green = g;
  let blue = g;
  if (params.ghosts > 0) {
    for (const ghost of FLARE_GHOSTS) {
      // The ghost's centre: centre + (origin − centre) · along.
      const gx = (0.5 + (origin[0] - 0.5) * ghost.along - uv[0]) * aspect;
      const gy = 0.5 + (origin[1] - 0.5) * ghost.along - uv[1];
      const disc = smoothstep(ghost.radius, ghost.radius * 0.6, Math.hypot(gx, gy));
      const k = disc * params.ghosts * FLARE_GHOST_GAIN;
      red += ghost.tint[0] * k;
      green += ghost.tint[1] * k;
      blue += ghost.tint[2] * k;
    }
  }
  const v = Math.min(1, params.visible);
  return [red * v, green * v, blue * v];
}
