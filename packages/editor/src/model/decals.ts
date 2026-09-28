/**
 * Decals (HALO2_STYLE_ROADMAP.md, H6): marks laid flat on a surface — bullet
 * pocks, plasma scorch, grenade burns that fade after a while, and authored
 * glyphs and frost streaks that stay. A decal is a few numbers on the mesh
 * sidecar; the cart lays marks with `cartbox.decal`, and a scene can carry
 * permanent marks placed in the editor. The runtime (decalSystem.ts) draws
 * them as quads just off the surface, so they're depth-tested with the scene
 * on every backend.
 */

type Rgb = readonly [number, number, number];
type V3 = readonly [number, number, number];

export type DecalPreset = "pock" | "scorch" | "burn" | "glyph" | "frost";
export const DECAL_PRESETS: readonly DecalPreset[] = ["pock", "scorch", "burn", "glyph", "frost"];

export interface DecalDef {
  readonly name: string;
  /** The pattern its sprite is drawn from. */
  readonly pattern: DecalPreset;
  /** Width of a mark, world units (a cart's size argument scales it). */
  readonly size: number;
  /** Seconds a cart-laid mark lasts before it has faded (0 = until it's recycled). */
  readonly life: number;
  /** Tint (0..1). */
  readonly color: Rgb;
  /** Glow: above 0 the mark emits light (a fresh plasma scorch, a Forerunner glyph). */
  readonly glow: number;
}

/** A permanent mark placed in the editor. */
export interface DecalMark {
  /** The decal's name. */
  readonly decal: string;
  readonly position: V3;
  /** The surface's outward normal. */
  readonly normal: V3;
  /** Width, world units (0 = the decal's own size). */
  readonly size: number;
  /** Turn about the normal, degrees. */
  readonly spin: number;
}

export const MAX_DECAL_DEFS = 16;
export const MAX_DECAL_MARKS = 128;
/** Cart-laid marks alive at once per decal; the oldest is recycled past this. */
export const MAX_MARKS_PER_DECAL = 96;

export function decalPreset(pattern: DecalPreset, name: string = pattern): DecalDef {
  switch (pattern) {
    case "pock":
      return { name, pattern, size: 0.16, life: 20, color: [0.16, 0.17, 0.2], glow: 0 };
    case "scorch":
      return { name, pattern, size: 0.35, life: 14, color: [0.3, 0.75, 1], glow: 1.2 };
    case "burn":
      return { name, pattern, size: 1.8, life: 30, color: [0.1, 0.1, 0.11], glow: 0 };
    case "glyph":
      return { name, pattern, size: 0.8, life: 0, color: [0.4, 0.95, 1], glow: 1.6 };
    case "frost":
      return { name, pattern, size: 1.4, life: 0, color: [0.9, 0.95, 1], glow: 0 };
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const triple = (v: unknown): [number, number, number] | null =>
  Array.isArray(v) && v.length === 3 && v.every(finite) ? [v[0] as number, v[1] as number, v[2] as number] : null;

/** Read stored decal definitions defensively (names unique, fields clamped). */
export function parseDecalDefs(value: unknown): DecalDef[] {
  if (!Array.isArray(value)) return [];
  const out: DecalDef[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_DECAL_DEFS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const pattern = DECAL_PRESETS.includes(r.pattern as DecalPreset) ? (r.pattern as DecalPreset) : "pock";
    let name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 32) : pattern;
    while (names.has(name)) name = `${name}_`;
    names.add(name);
    const d = decalPreset(pattern, name);
    const color = triple(r.color);
    out.push({
      name,
      pattern,
      size: finite(r.size) ? clamp(r.size, 0.02, 20) : d.size,
      life: finite(r.life) ? clamp(r.life, 0, 600) : d.life,
      color: color ? [clamp(color[0], 0, 1), clamp(color[1], 0, 1), clamp(color[2], 0, 1)] : d.color,
      glow: finite(r.glow) ? clamp(r.glow, 0, 10) : d.glow,
    });
  }
  return out;
}

/** Read stored permanent marks defensively, keeping only ones naming a known decal. */
export function parseDecalMarks(value: unknown, defs: readonly DecalDef[]): DecalMark[] {
  if (!Array.isArray(value)) return [];
  const known = new Set(defs.map((d) => d.name));
  const out: DecalMark[] = [];
  for (const raw of value) {
    if (out.length >= MAX_DECAL_MARKS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const position = triple(r.position);
    const normal = triple(r.normal);
    if (typeof r.decal !== "string" || !known.has(r.decal) || !position || !normal) continue;
    const len = Math.hypot(normal[0], normal[1], normal[2]);
    if (len < 1e-6) continue;
    out.push({
      decal: r.decal,
      position,
      normal: [normal[0] / len, normal[1] / len, normal[2] / len],
      size: finite(r.size) ? clamp(r.size, 0, 20) : 0,
      spin: finite(r.spin) ? ((r.spin % 360) + 360) % 360 : 0,
    });
  }
  return out;
}
