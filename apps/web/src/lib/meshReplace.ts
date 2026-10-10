/**
 * Replacing a model in place (LOCKOUT_MULTIPLAYER_ROADMAP.md L13): a re-imported
 * or edited model takes the place of one already in the scene — and of every
 * copy of it (Lockout's seven bots share one Spartan) — keeping each object's
 * id, place, animator and material set, so a cart that finds its objects by
 * index, its bones by name and its animations by clip name keeps working.
 *
 * Before replacing, {@link assetContract} says what the new model is missing
 * that the old one offered: joints a cart may look up, clips its state machine
 * plays, material sets its objects wear.
 */

import { deserializeMeshAsset, serializeMeshAsset, type AnimatorSpec, type MeshAsset } from "@cartbox/editor";

import { type MeshSidecar, type MeshSidecarEntry } from "./meshSidecar";
import { withAutoLods } from "./meshLods";

/** What a replacement lacks that the model it replaces offered. */
export interface AssetContract {
  /** Joints of the old skeleton the new one doesn't have (by name). */
  readonly missingJoints: readonly string[];
  /** Clips the old model had, or a state machine plays, that the new one doesn't. */
  readonly missingClips: readonly string[];
  /** Material sets worn by an object that the new model doesn't have. */
  readonly missingVariants: readonly string[];
}

/** The clips a state machine plays, by name (states and blend points). */
export function animatorClips(animator: AnimatorSpec | null | undefined): string[] {
  const clips = new Set<string>();
  for (const state of animator?.states ?? []) {
    if (state.clip) clips.add(state.clip);
    for (const point of state.blend?.points ?? []) clips.add(point.clip);
  }
  return [...clips];
}

/** What `next` is missing against `old`, for objects using `animators` and wearing `variants`. */
export function assetContract(
  old: MeshAsset,
  next: MeshAsset,
  uses: { readonly animators?: readonly (AnimatorSpec | null | undefined)[]; readonly variants?: readonly string[] } = {},
): AssetContract {
  const joints = new Set((next.skin?.joints ?? []).map((j) => j.name));
  const clips = new Set((next.clips ?? []).map((c) => c.name));
  const variants = new Set((next.variants ?? []).map((v) => v.name));
  const wantedClips = new Set([...(old.clips ?? []).map((c) => c.name), ...(uses.animators ?? []).flatMap(animatorClips)]);
  return {
    missingJoints: (old.skin?.joints ?? []).map((j) => j.name).filter((n) => !joints.has(n)),
    missingClips: [...wantedClips].filter((n) => !clips.has(n)),
    missingVariants: [...new Set(uses.variants ?? [])].filter((n) => !variants.has(n)),
  };
}

/** Whether a replacement offers everything the old model did. */
export function contractKept(contract: AssetContract): boolean {
  return contract.missingJoints.length === 0 && contract.missingClips.length === 0 && contract.missingVariants.length === 0;
}

/** One line saying what a replacement is missing, or "" when nothing is. */
export function describeContract(contract: AssetContract): string {
  const parts: string[] = [];
  if (contract.missingJoints.length) parts.push(`joints ${contract.missingJoints.join(", ")}`);
  if (contract.missingClips.length) parts.push(`clips ${contract.missingClips.join(", ")}`);
  if (contract.missingVariants.length) parts.push(`material sets ${contract.missingVariants.join(", ")}`);
  return parts.length ? `Missing ${parts.join("; ")}.` : "";
}

/** Every object showing the same model as `id` (itself included). */
export function copiesOf(sidecar: MeshSidecar, id: string): MeshSidecarEntry[] {
  const entry = sidecar.meshes.find((m) => m.id === id);
  return entry ? sidecar.meshes.filter((m) => m.mesh === entry.mesh) : [];
}

/** What replacing `id`'s model with `mesh` would leave missing, across every copy of it. */
export function replacementContract(sidecar: MeshSidecar, id: string, mesh: MeshAsset): AssetContract | null {
  const copies = copiesOf(sidecar, id);
  if (copies.length === 0) return null;
  let old: MeshAsset;
  try {
    old = deserializeMeshAsset(copies[0]!.mesh);
  } catch {
    return { missingJoints: [], missingClips: [], missingVariants: [] };
  }
  return assetContract(old, mesh, { animators: copies.map((c) => c.animator), variants: copies.flatMap((c) => (c.variant ? [c.variant] : [])) });
}

/**
 * Put `mesh` in place of `id`'s model and every copy of it: each keeps its id,
 * name, place, parent, animator and props; a material set the new model lacks
 * is dropped; LODs are remade for the new geometry.
 */
export function replaceModel(sidecar: MeshSidecar, id: string, mesh: MeshAsset): { sidecar: MeshSidecar; replaced: string[] } {
  const copies = new Set(copiesOf(sidecar, id).map((c) => c.id));
  if (copies.size === 0) return { sidecar, replaced: [] };
  const serialized = serializeMeshAsset(mesh);
  const variants = new Set((mesh.variants ?? []).map((v) => v.name));
  let next: MeshSidecar = {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (!copies.has(m.id)) return m;
      const { lods: _lods, variant, ...rest } = m;
      void _lods;
      return { ...rest, mesh: serialized, ...(variant && variants.has(variant) ? { variant } : {}) };
    }),
  };
  // One copy gets LODs if the model wants them; the rest share them.
  const first = [...copies][0]!;
  next = withAutoLods(next, first);
  const lods = next.meshes.find((m) => m.id === first)?.lods;
  if (lods) next = { ...next, meshes: next.meshes.map((m) => (copies.has(m.id) ? { ...m, lods } : m)) };
  return { sidecar: next, replaced: [...copies] };
}
