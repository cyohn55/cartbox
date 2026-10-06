/**
 * Blend weights (ENGINE_PARITY_ROADMAP.md EP17b): how much of each clip a
 * blend state plays for its parameters' values.
 *
 * - **1D** (one parameter): the two neighbouring clips along the line, mixed
 *   linearly; past either end, that end's clip alone.
 * - **2D** (a blend space): gradient band interpolation (Johansen, "Automated
 *   Semi-Procedural Animation"): each clip's influence falls off across the
 *   band towards every other clip, the minimum over them taken, then all
 *   normalised. At a clip's own point it plays alone; between clips the mix
 *   eases smoothly; outside the set, the nearest clips carry it.
 *
 * Pure: points in, one weight per point out (summing to 1).
 */

export interface BlendPoint {
  readonly at: number;
  readonly at2?: number;
}

/** 1D: linear between the neighbours (points need not be sorted). */
function weights1d(points: readonly BlendPoint[], v: number): number[] {
  const out = points.map(() => 0);
  if (points.length === 0) return out;
  const order = points.map((p, i) => i).sort((a, b) => points[a]!.at - points[b]!.at);
  const first = order[0]!;
  const last = order[order.length - 1]!;
  if (v <= points[first]!.at) {
    out[first] = 1;
    return out;
  }
  if (v >= points[last]!.at) {
    out[last] = 1;
    return out;
  }
  for (let k = 0; k < order.length - 1; k += 1) {
    const i = order[k]!;
    const j = order[k + 1]!;
    const a = points[i]!.at;
    const b = points[j]!.at;
    if (v >= a && v <= b) {
      const w = b > a ? (v - a) / (b - a) : 1;
      out[i] = 1 - w;
      out[j] = out[j]! + w;
      return out;
    }
  }
  return out;
}

/** 2D: gradient band interpolation. */
function weights2d(points: readonly BlendPoint[], x: number, y: number): number[] {
  const n = points.length;
  const raw = points.map((pi, i) => {
    const xi = pi.at;
    const yi = pi.at2 ?? 0;
    let w = 1;
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      const pj = points[j]!;
      const dx = pj.at - xi;
      const dy = (pj.at2 ?? 0) - yi;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) continue; // two clips on one spot share it
      const h = 1 - ((x - xi) * dx + (y - yi) * dy) / len2;
      w = Math.min(w, Math.max(0, Math.min(1, h)));
    }
    return w;
  });
  const total = raw.reduce((a, b) => a + b, 0);
  if (total > 1e-9) return raw.map((w) => w / total);
  // Nothing claims the spot (far outside the set): the nearest clip does.
  let best = 0;
  let bestD = Infinity;
  points.forEach((p, i) => {
    const d = (p.at - x) ** 2 + ((p.at2 ?? 0) - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return points.map((_, i) => (i === best ? 1 : 0));
}

/** Each point's weight for the parameters' values: 2D when `v2` is given, else 1D. */
export function blendWeights(points: readonly BlendPoint[], v: number, v2?: number): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [1];
  return v2 === undefined ? weights1d(points, v) : weights2d(points, v, v2);
}
