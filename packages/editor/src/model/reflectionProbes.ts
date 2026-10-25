/**
 * Reflection probes (HALO2_STYLE_ROADMAP.md, H2): authored points a scene's
 * reflections are captured from. Each probe is a capture point and a box — the
 * room it stands for. The runtime bakes a small panorama of the scene from the
 * capture point when the scene loads (see probeBake.ts), and shiny surfaces
 * inside the box reflect it, box-projected so the reflection lines up with the
 * room's walls, instead of the sky (see probeSampling.ts).
 *
 * Probes are parameters, not pixels: they live on the scene's lighting rig as
 * a few numbers each, and are never stale.
 */

type V3 = readonly [number, number, number];

/** One authored probe. */
export interface ReflectionProbe {
  /** Shown in the editor; not used at runtime. */
  readonly name: string;
  /** Where the panorama is captured from (kept inside the box). */
  readonly position: V3;
  /** The box the probe stands for: its corners, world units (a sphere probe's, its sphere's bounds). */
  readonly min: V3;
  readonly max: V3;
  /**
   * The shape it stands for (F3b): a box (absent), or a sphere of `radius`
   * round its capture point, which suits an open space. The AAA tier
   * projects the reflection onto it and fades it in from its edge; the others
   * take the sphere's bounding box.
   */
  readonly shape?: "sphere";
  readonly radius?: number;
  /** Which wins where probes overlap (F3b): higher first, then the smaller. On the AAA tier they blend in that order. */
  readonly priority?: number;
}

/** Most probes a scene may carry (the shaders loop over them). */
export const MAX_REFLECTION_PROBES = 8;

const finiteTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Read stored probes defensively: malformed entries are dropped, corners are
 * put in order, a box is at least 0.1 units on every side, the capture point is
 * clamped inside it, and at most {@link MAX_REFLECTION_PROBES} are kept.
 */
export function parseReflectionProbes(value: unknown): ReflectionProbe[] {
  if (!Array.isArray(value)) return [];
  const out: ReflectionProbe[] = [];
  for (const raw of value) {
    if (out.length >= MAX_REFLECTION_PROBES) break;
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (!finiteTriple(r.min) || !finiteTriple(r.max)) continue;
    const min: [number, number, number] = [0, 0, 0];
    const max: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a += 1) {
      const lo = Math.min(r.min[a]!, r.max[a]!);
      const hi = Math.max(r.min[a]!, r.max[a]!);
      const grow = Math.max(0, 0.1 - (hi - lo)) / 2;
      min[a] = lo - grow;
      max[a] = hi + grow;
    }
    const at = finiteTriple(r.position) ? r.position : [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const position: V3 = [0, 1, 2].map((a) => Math.min(max[a]!, Math.max(min[a]!, at[a]!))) as unknown as V3;
    const name = typeof r.name === "string" ? r.name.slice(0, 64) : `probe ${out.length + 1}`;
    const priority = typeof r.priority === "number" && Number.isFinite(r.priority) && r.priority !== 0 ? { priority: Math.round(Math.min(100, Math.max(-100, r.priority))) } : {};
    if (r.shape === "sphere") {
      // A sphere round the capture point: its radius (at least 0.1), and its bounds as the box.
      const radius = typeof r.radius === "number" && Number.isFinite(r.radius) ? Math.max(0.1, r.radius) : Math.max(0.1, Math.min(...[0, 1, 2].map((a) => (max[a]! - min[a]!) / 2)));
      const bound = (s: number): V3 => [position[0] + s * radius, position[1] + s * radius, position[2] + s * radius];
      out.push({ name, position, min: bound(-1), max: bound(1), shape: "sphere", radius, ...priority });
      continue;
    }
    out.push({ name, position, min, max, ...priority });
  }
  return out;
}

/** A new probe: a box of `size` around `position`, captured from its centre. */
export function reflectionProbeAt(position: V3, size: V3 = [8, 4, 8], name = "probe"): ReflectionProbe {
  return {
    name,
    position: [position[0], position[1], position[2]],
    min: [position[0] - size[0] / 2, position[1] - size[1] / 2, position[2] - size[2] / 2],
    max: [position[0] + size[0] / 2, position[1] + size[1] / 2, position[2] + size[2] / 2],
  };
}
