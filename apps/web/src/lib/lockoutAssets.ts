/**
 * Lockout's assets from the editor (LOCKOUT_MULTIPLAYER_ROADMAP.md L13): the
 * demo plays a saved Lockout cart's Spartans, viewmodels and pickups in place
 * of the ones it builds in code, so a model edited (or re-imported from
 * Blender) and saved in the editor plays in /lockout.
 *
 * Only the assets travel — the arena, lighting, sounds and code stay the
 * demo's own — and each only when it keeps the contract the cart relies on
 * (the same joints, clips and material sets; see meshReplace.ts). An object
 * whose replacement breaks it keeps the demo's model, and says why.
 */

import { deserializeMeshAsset } from "@cartbox/editor";

import { decodeMeshSidecar, encodeMeshSidecar, type MeshSidecar } from "./meshSidecar";
import { assetContract, contractKept, describeContract } from "./meshReplace";

/** Lockout's editable assets, by object id: its bots, first-person viewmodels and pickups. */
export function isLockoutAsset(id: string): boolean {
  return /^(bot-\d+|viewmodel-[a-z]+|pickup-\d+)$/.test(id);
}

/** Whether a sidecar is a Lockout cart's (it has Lockout's assets), so the editor can offer to play it in the demo. */
export function isLockoutSidecar(sidecar: MeshSidecar): boolean {
  return sidecar.meshes.some((m) => m.id === "bot-1") && sidecar.meshes.some((m) => m.id.startsWith("viewmodel-"));
}

export interface LockoutAssetOverlay {
  readonly sidecar: MeshSidecar;
  /** Objects that now show the saved cart's model (or animator, or material set). */
  readonly replaced: readonly string[];
  /** Objects that kept the demo's model, and why. */
  readonly refused: readonly { readonly id: string; readonly reason: string }[];
}

/** The demo's scene with `saved`'s versions of its assets, where they keep the contract. */
export function overlayLockoutAssets(base: MeshSidecar, saved: MeshSidecar): LockoutAssetOverlay {
  const byId = new Map(saved.meshes.map((m) => [m.id, m]));
  const replaced: string[] = [];
  const refused: { id: string; reason: string }[] = [];
  const meshes = base.meshes.map((entry) => {
    const theirs = isLockoutAsset(entry.id) ? byId.get(entry.id) : undefined;
    if (!theirs) return entry;
    const sameMesh = theirs.mesh === entry.mesh;
    const sameLook = theirs.variant === entry.variant && JSON.stringify(theirs.animator ?? null) === JSON.stringify(entry.animator ?? null);
    if (sameMesh && sameLook) return entry;
    try {
      const contract = assetContract(deserializeMeshAsset(entry.mesh), deserializeMeshAsset(theirs.mesh), {
        animators: [entry.animator, theirs.animator],
        variants: entry.variant ? [entry.variant] : [],
      });
      if (!contractKept(contract)) {
        refused.push({ id: entry.id, reason: describeContract(contract) });
        return entry;
      }
    } catch {
      refused.push({ id: entry.id, reason: "Its saved model doesn't decode." });
      return entry;
    }
    replaced.push(entry.id);
    const { lods: _lods, variant: _variant, animator: _animator, ...rest } = entry;
    void _lods;
    void _variant;
    void _animator;
    return {
      ...rest,
      mesh: theirs.mesh,
      ...(theirs.lods ? { lods: theirs.lods } : {}),
      ...(theirs.variant ? { variant: theirs.variant } : {}),
      ...(theirs.animator ? { animator: theirs.animator } : {}),
    };
  });
  return { sidecar: { ...base, meshes }, replaced, refused };
}

/** The demo's sidecar JSON with a saved cart's assets laid in (unchanged when there are none, or nothing to lay in). */
export function lockoutSidecarWithAssets(baseJson: string, savedJson: string | null | undefined): { json: string; overlay: LockoutAssetOverlay | null } {
  if (!savedJson) return { json: baseJson, overlay: null };
  const overlay = overlayLockoutAssets(decodeMeshSidecar(baseJson), decodeMeshSidecar(savedJson));
  if (overlay.replaced.length === 0) return { json: baseJson, overlay };
  return { json: encodeMeshSidecar(overlay.sidecar) ?? baseJson, overlay };
}
