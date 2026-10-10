/**
 * Weight painting (LOCKOUT_MULTIPLAYER_ROADMAP.md L16): how much each bone
 * carries of each vertex, brushed onto a skinned mesh — and shown as a heat
 * map, blue where a bone carries nothing through green to red where it
 * carries everything.
 *
 * A brush is a sphere in the mesh's own (bind) space. Within it, each vertex
 * is touched by the brush's strength, fading smoothly to nothing at its edge:
 *
 * - **add** moves the bone's weight that share of the way to 1;
 * - **subtract** takes that share of it away;
 * - **smooth** blends the vertex's weights toward the average of the
 *   vertices it shares an edge with (every bone's, not just one);
 * - **normalise** rescales its weights to sum to 1 and drops slivers.
 *
 * Whatever the bone gains or loses, the vertex's other bones give up or take
 * up in proportion, so every vertex's weights always sum to 1. (A bone
 * subtracted from a vertex it carries alone hands it to its parent bone.)
 * A vertex keeps its four strongest bones. Every split copy of a vertex
 * takes the same weights, so a seam never tears when it bends. Pure and
 * DOM-free.
 */

import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import { primitiveTopology } from "./meshModel";

export type WeightPaintMode = "add" | "subtract" | "smooth" | "normalise";
export const WEIGHT_PAINT_MODES: readonly WeightPaintMode[] = ["add", "subtract", "smooth", "normalise"];

export interface WeightBrush {
  /** The brush's centre, in the mesh's space (where the pointer meets the surface). */
  readonly center: readonly [number, number, number];
  /** Its radius, in the mesh's units. */
  readonly radius: number;
  /** How much one dab does at its centre, 0..1. */
  readonly strength: number;
  readonly mode: WeightPaintMode;
}

/** Weights below this are dropped as slivers by normalise. */
const SLIVER = 0.005;

/** The weight `joint` has on vertex `v`. */
export function vertexWeight(p: MeshPrimitive, v: number, joint: number): number {
  if (!p.joints || !p.weights) return 0;
  let w = 0;
  for (let k = 0; k < 4; k += 1) if (p.joints[v * 4 + k] === joint) w += p.weights[v * 4 + k]!;
  return w;
}

/** Every vertex's weight on `joint` (what the heat map shows). */
export function jointWeights(p: MeshPrimitive, joint: number): Float32Array {
  const out = new Float32Array(p.positions.length / 3);
  for (let v = 0; v < out.length; v += 1) out[v] = vertexWeight(p, v, joint);
  return out;
}

/** The heat map's colour for a weight (0..1): blue, cyan, green, yellow, red. RGB bytes. */
export function weightHeat(weight: number): [number, number, number] {
  const w = Math.max(0, Math.min(1, weight));
  const stops: [number, number, number][] = [
    [24, 40, 220],
    [0, 200, 230],
    [40, 210, 60],
    [240, 220, 30],
    [230, 40, 30],
  ];
  const x = w * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i]!, b = stops[i + 1]!;
  return [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f), Math.round(a[2] + (b[2] - a[2]) * f)];
}

type Influence = Map<number, number>;

function influenceOf(p: MeshPrimitive, v: number): Influence {
  const out: Influence = new Map();
  for (let k = 0; k < 4; k += 1) {
    const w = p.weights![v * 4 + k]!;
    if (w > 0) out.set(p.joints![v * 4 + k]!, (out.get(p.joints![v * 4 + k]!) ?? 0) + w);
  }
  return out;
}

/** The four strongest, summing to 1 (exactly, in float32: any rounding goes on the strongest). */
function finish(influence: Influence, fallback: number): { joints: number[]; weights: number[] } {
  let top = [...influence].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
  if (top.length === 0) top = [[fallback, 1]];
  const total = top.reduce((s, [, w]) => s + w, 0);
  const joints = [0, 0, 0, 0], weights = [0, 0, 0, 0];
  top.forEach(([j, w], k) => {
    joints[k] = j;
    weights[k] = Math.fround(w / total);
  });
  const sum = weights.reduce((s, w) => Math.fround(s + w), 0);
  weights[0] = Math.fround(weights[0]! + (1 - sum));
  return { joints, weights };
}

/** Set one joint's share to `target`, the others taking up the rest in proportion (or the parent, when there are none). */
function setShare(influence: Influence, joint: number, target: number, parent: number): Influence {
  const t = Math.max(0, Math.min(1, target));
  const others = [...influence].filter(([j]) => j !== joint);
  const rest = others.reduce((s, [, w]) => s + w, 0);
  const out: Influence = new Map();
  if (t > 0) out.set(joint, t);
  if (rest > 0) for (const [j, w] of others) out.set(j, (w / rest) * (1 - t));
  else if (t < 1) {
    // Nothing else carries it: what the joint gives up goes to its parent (or it keeps it, at a root).
    if (parent >= 0) out.set(parent, 1 - t);
    else out.set(joint, 1);
  }
  return out;
}

/** The brush's touch on a point: its strength, fading smoothly to 0 at its radius. */
function touch(brush: WeightBrush, p: readonly number[]): number {
  const d = Math.hypot(p[0]! - brush.center[0], p[1]! - brush.center[1], p[2]! - brush.center[2]);
  if (d >= brush.radius) return 0;
  const x = 1 - d / Math.max(1e-9, brush.radius);
  return Math.max(0, Math.min(1, brush.strength)) * x * x * (3 - 2 * x);
}

/**
 * One dab of the brush on every skinned primitive (or only `primitive`):
 * the mesh with the touched vertices' weights changed, still summing to 1.
 */
export function paintWeights(mesh: MeshAsset, joint: number, brush: WeightBrush, primitive?: number): MeshAsset {
  const skin = mesh.skin;
  if (!skin || joint < 0 || joint >= skin.joints.length) return mesh;
  const parent = skin.joints[joint]!.parent;
  let changed = false;
  const primitives = mesh.primitives.map((p, i) => {
    if (!p.joints || !p.weights || (primitive !== undefined && i !== primitive)) return p;
    const topo = primitiveTopology(p);
    const welds = topo.weldVertices.length;
    const strength = new Float32Array(welds);
    let any = false;
    for (let w = 0; w < welds; w += 1) {
      strength[w] = touch(brush, [topo.weldPositions[w * 3]!, topo.weldPositions[w * 3 + 1]!, topo.weldPositions[w * 3 + 2]!]);
      if (strength[w]! > 0) any = true;
    }
    if (!any) return p;
    const before = topo.weldVertices.map((vs) => influenceOf(p, vs[0]!));
    // Smoothing reads each weld's neighbours (welds it shares a triangle edge with).
    let neighbours: Set<number>[] | null = null;
    if (brush.mode === "smooth") {
      neighbours = before.map(() => new Set<number>());
      for (let t = 0; t < p.indices.length; t += 3) {
        const w = [0, 1, 2].map((c) => topo.weldOf[p.indices[t + c]!]!);
        for (let c = 0; c < 3; c += 1) {
          const a = w[c]!, b = w[(c + 1) % 3]!;
          if (a !== b) {
            neighbours[a]!.add(b);
            neighbours[b]!.add(a);
          }
        }
      }
    }
    const joints = p.joints.slice();
    const weights = p.weights.slice();
    for (let w = 0; w < welds; w += 1) {
      const s = strength[w]!;
      if (s <= 0) continue;
      const was = before[w]!;
      const share = was.get(joint) ?? 0;
      let next: Influence;
      if (brush.mode === "add") next = setShare(was, joint, share + s * (1 - share), parent);
      else if (brush.mode === "subtract") next = setShare(was, joint, share * (1 - s), parent);
      else if (brush.mode === "smooth") {
        const around = [...neighbours![w]!];
        if (around.length === 0) continue;
        const average: Influence = new Map();
        for (const n of around) for (const [j, v] of before[n]!) average.set(j, (average.get(j) ?? 0) + v / around.length);
        next = new Map();
        for (const j of new Set([...was.keys(), ...average.keys()])) next.set(j, (was.get(j) ?? 0) * (1 - s) + (average.get(j) ?? 0) * s);
      } else {
        const total = [...was.values()].reduce((a, b) => a + b, 0) || 1;
        next = new Map([...was].map(([j, v]) => [j, v / total] as const).filter(([, v]) => v >= SLIVER));
      }
      const done = finish(next, joint);
      for (const v of topo.weldVertices[w]!) {
        joints.set(done.joints, v * 4);
        weights.set(done.weights, v * 4);
      }
      changed = true;
    }
    return { ...p, joints, weights };
  });
  return changed ? { ...mesh, primitives } : mesh;
}

/**
 * Every vertex's weights rescaled to sum to 1, slivers dropped and split
 * copies made to agree: what an imported mesh's loose weights become.
 */
export function normaliseWeights(mesh: MeshAsset): MeshAsset {
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      if (!p.joints || !p.weights) return p;
      const topo = primitiveTopology(p);
      const joints = p.joints.slice();
      const weights = p.weights.slice();
      for (const vs of topo.weldVertices) {
        const was = influenceOf(p, vs[0]!);
        const total = [...was.values()].reduce((a, b) => a + b, 0) || 1;
        const done = finish(new Map([...was].map(([j, v]) => [j, v / total] as const).filter(([, v]) => v >= SLIVER)), p.joints[vs[0]! * 4]!);
        for (const v of vs) {
          joints.set(done.joints, v * 4);
          weights.set(done.weights, v * 4);
        }
      }
      return { ...p, joints, weights };
    }),
  };
}
