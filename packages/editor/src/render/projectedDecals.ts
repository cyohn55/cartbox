/**
 * Projected decals (AAA_FIDELITY_ROADMAP.md F1f): a mark as a box laid on a
 * surface, which the AAA tier's shader projects onto whatever lies inside it,
 * D-buffer style. It changes the surface's base colour, normal, roughness and
 * AO before it is lit, rather than drawing a quad over it.
 *
 * - **The tiles** are every decal's pattern ({@link coverageOf}) drawn once, a
 *   {@link DECAL_TILE}² tile apiece, in two planes:
 *   - *colour*: its tint by brightness, and coverage in alpha (soft at the edge,
 *     not dithered);
 *   - *surface*: the normal its relief bends (x, y, encoded 0..1), its
 *     roughness and its occlusion.
 *   Each is RGBA8, a tile per decal stacked down the atlas.
 * - **A box** is a mark's centre and three half-axes: across, along (turned by
 *   its spin) and out of the surface, {@link DECAL_DEPTH} of its size each way.
 *   A box carries its tile, the share of it left as it fades over the last third
 *   of a cart-laid mark's life, and its glow.
 * - **Sorting.** Permanent marks come first, then cart-laid ones oldest first,
 *   so a fresh mark lies over an old one.
 */

import type { DecalDef, DecalPreset } from "../model/decals";
import { coverageOf, type DecalSystem } from "./decalSystem";

type V3 = readonly [number, number, number];

/** A decal tile's side, texels. */
export const DECAL_TILE = 64;
/** How far a box reaches out of and into its surface, as a share of the mark's size, each way. */
export const DECAL_DEPTH = 0.25;

/** One mark as a projected box. */
export interface ProjectedDecal {
  readonly center: V3;
  /** Half-axes: across the mark, along it, and out of the surface. */
  readonly axes: readonly [V3, V3, V3];
  /** Its decal's tile in the {@link DecalTiles}. */
  readonly tile: number;
  /** How much of it is left (1 fresh, falling to 0 as a cart-laid mark fades). */
  readonly alpha: number;
  /** Its emission (the decal's glow), times its colour. */
  readonly glow: number;
}

/** Every decal's tile, colour and surface, stacked: {@link DECAL_TILE} wide, a tile tall each. */
export interface DecalTiles {
  readonly size: number;
  readonly count: number;
  readonly colour: Uint8ClampedArray;
  readonly surface: Uint8ClampedArray;
}

/** How a pattern's relief stands (a crater sinks, a glyph is cut in), its roughness and its occlusion where it covers. */
const SURFACE: Record<DecalPreset, { relief: number; roughness: number; occlusion: number }> = {
  pock: { relief: -1.2, roughness: 0.85, occlusion: 0.55 },
  scorch: { relief: 0, roughness: 0.45, occlusion: 0.9 },
  burn: { relief: 0, roughness: 0.95, occlusion: 0.8 },
  glyph: { relief: -0.6, roughness: 0.3, occlusion: 0.85 },
  frost: { relief: 0.3, roughness: 0.15, occlusion: 1 },
};

/** Draw every decal's tile. */
export function decalTiles(defs: readonly DecalDef[]): DecalTiles {
  const n = DECAL_TILE;
  const colour = new Uint8ClampedArray(n * n * defs.length * 4);
  const surface = new Uint8ClampedArray(n * n * defs.length * 4);
  defs.forEach((def, t) => {
    // Coverage at 2× and averaged, so the edge is soft, and its relief from it.
    const cover = new Float32Array(n * n);
    const bright = new Float32Array(n * n);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        let c = 0;
        let b = 0;
        for (let s = 0; s < 4; s += 1) {
          const u = ((x + 0.25 + 0.5 * (s & 1)) / n) * 2 - 1;
          const v = ((y + 0.25 + 0.5 * (s >> 1)) / n) * 2 - 1;
          const [cv, bv] = coverageOf(def.pattern, u, v, (x * 32) / n, (y * 32) / n);
          const edge = Math.max(Math.abs(u), Math.abs(v)) > 0.97 ? 0 : cv;
          c += edge / 4;
          b += (edge > 0 ? bv : 0) / 4;
        }
        cover[y * n + x] = c;
        bright[y * n + x] = c > 0 ? b / c : 0;
      }
    }
    const look = SURFACE[def.pattern];
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        const i = y * n + x;
        const o = (t * n * n + i) * 4;
        colour[o] = def.color[0] * bright[i]! * 255;
        colour[o + 1] = def.color[1] * bright[i]! * 255;
        colour[o + 2] = def.color[2] * bright[i]! * 255;
        colour[o + 3] = cover[i]! * 255;
        // The relief's slope: the height is the coverage, the normal leaning down it, along x and y of the tile.
        const h = (xx: number, yy: number) => cover[Math.min(n - 1, Math.max(0, yy)) * n + Math.min(n - 1, Math.max(0, xx))]!;
        const dx = ((h(x + 1, y) - h(x - 1, y)) / 2) * look.relief;
        const dy = ((h(x, y + 1) - h(x, y - 1)) / 2) * look.relief;
        const l = Math.hypot(dx, dy, 1);
        surface[o] = ((-dx / l) * 0.5 + 0.5) * 255;
        surface[o + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
        surface[o + 2] = look.roughness * 255;
        surface[o + 3] = look.occlusion * 255;
      }
    }
  });
  return { size: n, count: defs.length, colour, surface };
}

/** A mark's box: on a surface facing `normal` at `at`, `size` across, turned `spin` degrees. */
export function decalBox(at: V3, normal: V3, size: number, spin: number, tile: number, alpha: number, glow: number): ProjectedDecal {
  const l = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  const nz: V3 = [normal[0] / l, normal[1] / l, normal[2] / l];
  const helper: V3 = Math.abs(nz[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const t0 = cross(helper, nz);
  const tl = Math.hypot(t0[0], t0[1], t0[2]);
  const t: V3 = [t0[0] / tl, t0[1] / tl, t0[2] / tl];
  const b = cross(nz, t);
  const rad = (spin * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const h = size / 2;
  const d = size * DECAL_DEPTH;
  return {
    center: [at[0], at[1], at[2]],
    axes: [
      [(t[0] * c + b[0] * s) * h, (t[1] * c + b[1] * s) * h, (t[2] * c + b[2] * s) * h],
      [(b[0] * c - t[0] * s) * h, (b[1] * c - t[1] * s) * h, (b[2] * c - t[2] * s) * h],
      [nz[0] * d, nz[1] * d, nz[2] * d],
    ],
    tile,
    alpha,
    glow,
  };
}

/** A decal system's marks as boxes (in its order), each on its decal's tile. */
export function projectDecals(system: DecalSystem): ProjectedDecal[] {
  const defs = system.defs;
  return system.liveMarks().map((m) => decalBox(m.at, m.normal, m.size, m.spin, m.decal, m.alpha, defs[m.decal]!.glow));
}

function cross(a: V3, b: V3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
