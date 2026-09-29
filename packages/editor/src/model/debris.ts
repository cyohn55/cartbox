/**
 * Cosmetic debris (HALO2_STYLE_ROADMAP.md, H10): ejected shell casings, a
 * dropped weapon, a kicked helmet — small props thrown into the scene that
 * bounce, tumble and settle, then fade away.
 *
 * A debris definition is a few numbers on the mesh sidecar plus the object or
 * prefab whose look it copies (a prefab is the natural home: its mesh never
 * sits in the level). The cart throws copies with `cartbox.debris`; the runtime
 * (debrisSystem.ts) simulates each one on this machine only — like a ragdoll it
 * lands on the scene's static bodies and ragdoll colliders, and never touches
 * the physics world, so online play is unaffected.
 */

export interface DebrisDef {
  readonly name: string;
  /** The scene object or prefab (by name) whose mesh each copy wears. */
  readonly source: string;
  /** Parts of that mesh left off, by material name (a first-person weapon's hands, say). */
  readonly without?: readonly string[];
  /** Seconds a copy lasts; it shrinks away over the last half second. */
  readonly life: number;
  /** How much of its speed into a surface it keeps bouncing off it (0..1). */
  readonly bounce: number;
  /** How much of its sliding it loses on a contact (0..1). */
  readonly friction: number;
  /** Copies alive at once; the oldest is recycled past this. */
  readonly max: number;
}

export const MAX_DEBRIS_DEFS = 16;
/** The most copies of one definition alive at once. */
export const MAX_DEBRIS_PER_DEF = 64;

/** Sensible starting values for a definition copying `source`. */
export function debrisDefaults(name: string, source: string): DebrisDef {
  return { name, source, life: 8, bounce: 0.3, friction: 0.4, max: 16 };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Read stored debris definitions defensively (names unique, fields clamped, a source required). */
export function parseDebrisDefs(value: unknown): DebrisDef[] {
  if (!Array.isArray(value)) return [];
  const out: DebrisDef[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    if (out.length >= MAX_DEBRIS_DEFS) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.source !== "string" || !r.source.trim()) continue;
    const source = r.source.trim().slice(0, 64);
    let name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 32) : source;
    while (names.has(name)) name = `${name}_`;
    names.add(name);
    const d = debrisDefaults(name, source);
    const without = Array.isArray(r.without)
      ? [...new Set(r.without.filter((w): w is string => typeof w === "string" && w.length > 0).map((w) => w.slice(0, 64)))].slice(0, 16)
      : [];
    out.push({
      name,
      source,
      ...(without.length > 0 ? { without } : {}),
      life: finite(r.life) ? clamp(r.life, 0.5, 120) : d.life,
      bounce: finite(r.bounce) ? clamp(r.bounce, 0, 1) : d.bounce,
      friction: finite(r.friction) ? clamp(r.friction, 0, 1) : d.friction,
      max: finite(r.max) ? clamp(Math.round(r.max), 1, MAX_DEBRIS_PER_DEF) : d.max,
    });
  }
  return out;
}
