/**
 * Wind (BEAVER_CREEK_ROADMAP.md B6): one wind for a scene — a direction, a
 * strength and how gusty it is — that sways grass and tree crowns. A
 * primitive's per-vertex {@link MeshPrimitive.sway} says how far each vertex
 * bends (zero at the root, more toward the tip); the wind says which way and
 * when. The vertex moves sideways only, in the mesh's own space, downwind and
 * back, with a slower gust over it.
 *
 * The software rasteriser moves vertices by {@link windOffset}; both GPU
 * scene shaders run `windOffset` in their vertex stage from the same
 * {@link windUniform}, so all three agree. Shadow maps are drawn on the CPU
 * from still geometry, so shadows don't sway.
 */

/** A scene's wind. */
export interface SceneWind {
  /** The way it blows, radians about +Y from +X. */
  readonly direction: number;
  /** How hard, 0..2 (a sway's metres at its full bend). */
  readonly strength: number;
  /** How much the gusts add on top, 0..1. */
  readonly gust: number;
}

/** The wind's cycle, in seconds: every sway and gust repeats exactly over it, so its phase wraps without a jump. */
export const WIND_PERIOD = 16;

/** A sensible breeze for a new scene. */
export const DEFAULT_WIND: SceneWind = { direction: 0.6, strength: 0.4, gust: 0.5 };

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Read a stored wind; null when absent or malformed. */
export function parseWind(raw: unknown): SceneWind | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.direction) || !finite(r.strength)) return null;
  return {
    direction: Math.max(-Math.PI, Math.min(Math.PI, r.direction)),
    strength: Math.max(0, Math.min(2, r.strength)),
    gust: finite(r.gust) ? Math.max(0, Math.min(1, r.gust)) : 0,
  };
}

/**
 * The wind's uniform at `time` seconds: [x, z] of its direction × strength,
 * the phase through its {@link WIND_PERIOD} (0..1, wrapped here so a GPU's
 * float32 never sees a large time), and its gust. Zeros for no wind.
 */
export function windUniform(wind: SceneWind | null | undefined, time: number): [number, number, number, number] {
  if (!wind || !(wind.strength > 0)) return [0, 0, 0, 0];
  const t = time / WIND_PERIOD;
  return [Math.cos(wind.direction) * wind.strength, Math.sin(wind.direction) * wind.strength, t - Math.floor(t), wind.gust];
}

const TAU = Math.PI * 2;

/**
 * How far a vertex at (x, z) in its mesh's space, bending `sway` metres per
 * unit of wind, moves along X and Z this frame: downwind and back twice a
 * second with a quicker flutter over it, varying across the ground, and up to
 * (1 + gust) times further in a gust every {@link WIND_PERIOD} seconds. The
 * scene shaders' `windOffset` is this, term for term.
 */
export function windOffset(uniform: readonly [number, number, number, number], x: number, z: number, sway: number): [number, number] {
  const [wx, wz, t, gust] = uniform;
  if (!(sway > 0) || (wx === 0 && wz === 0)) return [0, 0];
  const s = 0.5 + 0.35 * Math.sin(TAU * 8 * t + 0.7 * (x + z)) + 0.15 * Math.sin(TAU * 24 * t + 1.9 * x - 1.3 * z);
  const g = 1 + gust * (0.5 + 0.5 * Math.sin(TAU * t + 0.05 * (x + z)));
  const k = sway * s * g;
  return [wx * k, wz * k];
}

/**
 * How far a vertex `height` metres above its plant's root bends (metres per
 * unit of wind) for a plant of flexibility `flex` (0 = stiff): nothing at the
 * root, a little low down, and growing toward the tip.
 */
export function foliageSway(height: number, flex: number): number {
  if (!(flex > 0) || !(height > 0)) return 0;
  return (flex * 0.25 * height * height) / (height + 1);
}
