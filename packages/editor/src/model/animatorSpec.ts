/**
 * An animation state machine for a skinned scene object (ENGINE_ROADMAP.md,
 * Phase 3), stored on its mesh sidecar entry as `animator`.
 *
 * - **Parameters** are the cart's inputs: numbers (speed), bools (grounded) and
 *   triggers (fire — set once, used up by the transition that takes them).
 *   Lua sets them with cartbox.set / cartbox.trigger.
 * - **States** each play a clip (or the rest pose), or a 1D **blend** between
 *   clips driven by a number parameter — walk ↔ run by speed, the clips kept in
 *   step by playing at the same fraction of their length.
 * - **Transitions** move between states when all their conditions hold (and,
 *   with an exit time, once the current state is that far through its clip),
 *   crossfading over `fade` seconds. `from: "*"` means from any state.
 * - **Events** name moments of a clip (a footstep at 0.4 s); the cart reads the
 *   ones that passed each tick with cartbox.events.
 *
 * The first state is where the machine starts. States and events refer to clips
 * by name, so a spec survives re-importing the model; a missing clip plays the
 * rest pose. Everything is validated on the way in (the sidecar is untrusted).
 */

export type AnimatorParamKind = "number" | "bool" | "trigger";

export interface AnimatorParam {
  readonly name: string;
  readonly kind: AnimatorParamKind;
  /** Starting value (numbers; bools use 0/1; triggers start unset). */
  readonly initial: number;
}

export interface AnimatorBlend {
  /** The number parameter that picks the mix. */
  readonly param: string;
  /** Clips placed along the parameter, ascending by `at`. */
  readonly points: readonly { readonly clip: string; readonly at: number }[];
}

export interface AnimatorState {
  readonly name: string;
  /** The clip to play, or null for the rest pose (ignored when `blend` is set). */
  readonly clip: string | null;
  /** Playback speed multiplier (default 1). */
  readonly speed: number;
  /** Loop the clip (default true) or hold its last frame. */
  readonly loop: boolean;
  readonly blend?: AnimatorBlend;
}

export type AnimatorOp = ">" | "<" | ">=" | "<=" | "==" | "!=" | "true" | "false" | "set";
export const ANIMATOR_OPS: readonly AnimatorOp[] = [">", "<", ">=", "<=", "==", "!=", "true", "false", "set"];

export interface AnimatorCondition {
  readonly param: string;
  /** Comparisons for numbers, true/false for bools, set for triggers. */
  readonly op: AnimatorOp;
  readonly value: number;
}

export interface AnimatorTransition {
  /** A state name, or "*" for any state. */
  readonly from: string;
  readonly to: string;
  readonly when: readonly AnimatorCondition[];
  /** Crossfade seconds (default 0.2). */
  readonly fade: number;
  /** Only once the current state is this far through its clip (0..1 of its length; loops count on). Absent = any time. */
  readonly exitTime?: number;
}

export interface AnimatorEvent {
  readonly clip: string;
  /** Seconds into the clip. */
  readonly time: number;
  readonly name: string;
}

export interface AnimatorSpec {
  readonly params: readonly AnimatorParam[];
  readonly states: readonly AnimatorState[];
  readonly transitions: readonly AnimatorTransition[];
  readonly events: readonly AnimatorEvent[];
}

export const ANIMATOR_LIMITS = { params: 32, states: 32, transitions: 64, conditions: 8, events: 64, blendPoints: 8 } as const;
export const DEFAULT_ANIMATOR_FADE = 0.2;

const NAME_MAX = 32;
const name = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, NAME_MAX);
  return s.length > 0 ? s : null;
};
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);

/**
 * Read a stored state machine, or null when absent or it has no states. Unknown
 * parameter references drop the condition (or blend) that makes them; transitions
 * to states that don't exist are dropped; names are unique (later duplicates go).
 */
export function readAnimatorSpec(value: unknown): AnimatorSpec | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;

  const params: AnimatorParam[] = [];
  for (const item of list(raw.params, ANIMATOR_LIMITS.params)) {
    const p = item as Record<string, unknown>;
    const n = name(p?.name);
    const kind: AnimatorParamKind | null = p?.kind === "number" || p?.kind === "bool" || p?.kind === "trigger" ? p.kind : null;
    if (!n || !kind || params.some((q) => q.name === n)) continue;
    const initial = kind === "number" ? num(p.initial, -1e6, 1e6, 0) : kind === "bool" ? (p.initial === 1 || p.initial === true ? 1 : 0) : 0;
    params.push({ name: n, kind, initial });
  }
  const param = (n: string | null) => (n ? params.find((p) => p.name === n) : undefined);

  const states: AnimatorState[] = [];
  for (const item of list(raw.states, ANIMATOR_LIMITS.states)) {
    const s = item as Record<string, unknown>;
    const n = name(s?.name);
    if (!n || n === "*" || states.some((q) => q.name === n)) continue;
    let blend: AnimatorBlend | undefined;
    const b = s.blend as Record<string, unknown> | undefined;
    const bp = param(name(b?.param));
    if (b && bp?.kind === "number") {
      const points = list(b.points, ANIMATOR_LIMITS.blendPoints)
        .map((pt) => ({ clip: name((pt as Record<string, unknown>)?.clip), at: num((pt as Record<string, unknown>)?.at, -1e6, 1e6, NaN) }))
        .filter((pt): pt is { clip: string; at: number } => pt.clip !== null && Number.isFinite(pt.at))
        .sort((x, y) => x.at - y.at);
      if (points.length > 0) blend = { param: bp.name, points };
    }
    states.push({
      name: n,
      clip: name(s.clip),
      speed: num(s.speed, -10, 10, 1),
      loop: s.loop !== false,
      ...(blend ? { blend } : {}),
    });
  }
  if (states.length === 0) return null;
  const isState = (n: string | null) => n !== null && states.some((s) => s.name === n);

  const transitions: AnimatorTransition[] = [];
  for (const item of list(raw.transitions, ANIMATOR_LIMITS.transitions)) {
    const t = item as Record<string, unknown>;
    const from = t?.from === "*" ? "*" : name(t?.from);
    const to = name(t?.to);
    if (!from || (from !== "*" && !isState(from)) || !isState(to)) continue;
    const when: AnimatorCondition[] = [];
    for (const c of list(t.when, ANIMATOR_LIMITS.conditions)) {
      const cond = c as Record<string, unknown>;
      const p = param(name(cond?.param));
      const op = ANIMATOR_OPS.includes(cond?.op as AnimatorOp) ? (cond.op as AnimatorOp) : null;
      if (!p || !op) continue;
      // Each kind of parameter takes its own kind of test.
      const fits = p.kind === "trigger" ? op === "set" : p.kind === "bool" ? op === "true" || op === "false" : op !== "set" && op !== "true" && op !== "false";
      if (fits) when.push({ param: p.name, op, value: num(cond.value, -1e6, 1e6, 0) });
    }
    const exit = typeof t.exitTime === "number" && Number.isFinite(t.exitTime) ? Math.max(0, Math.min(100, t.exitTime)) : undefined;
    transitions.push({
      from,
      to: to!,
      when,
      fade: num(t.fade, 0, 10, DEFAULT_ANIMATOR_FADE),
      ...(exit !== undefined ? { exitTime: exit } : {}),
    });
  }

  const events: AnimatorEvent[] = [];
  for (const item of list(raw.events, ANIMATOR_LIMITS.events)) {
    const e = item as Record<string, unknown>;
    const clip = name(e?.clip);
    const n = name(e?.name);
    if (!clip || !n) continue;
    events.push({ clip, name: n, time: num(e.time, 0, 1e4, 0) });
  }
  return { params, states, transitions, events };
}

/** A starting machine for a mesh's clips: one state per clip, the first looping. */
export function defaultAnimator(clipNames: readonly string[]): AnimatorSpec {
  const states = (clipNames.length > 0 ? clipNames : ["rest"]).slice(0, ANIMATOR_LIMITS.states).map((clip, i) => ({
    name: clipNames.length > 0 ? uniqueName(clip, i) : "rest",
    clip: clipNames.length > 0 ? clip : null,
    speed: 1,
    loop: true,
  }));
  return { params: [], states, transitions: [], events: [] };
}

function uniqueName(clip: string, i: number): string {
  return clip.trim().slice(0, NAME_MAX) || `state ${i + 1}`;
}

/** Whether a condition holds for a parameter's current value (triggers: set = non-zero). */
export function conditionHolds(op: AnimatorOp, value: number, target: number): boolean {
  switch (op) {
    case ">":
      return value > target;
    case "<":
      return value < target;
    case ">=":
      return value >= target;
    case "<=":
      return value <= target;
    case "==":
      return value === target;
    case "!=":
      return value !== target;
    case "true":
    case "set":
      return value !== 0;
    case "false":
      return value === 0;
  }
}
