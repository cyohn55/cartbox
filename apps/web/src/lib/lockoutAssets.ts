/**
 * Lockout's assets from the editor (LOCKOUT_MULTIPLAYER_ROADMAP.md L13): the
 * demo plays a saved Lockout cart's Spartans, viewmodels and pickups in place
 * of the ones it builds in code, so a model edited (or re-imported from
 * Blender) and saved in the editor plays in /lockout.
 *
 * The assets travel each only when it keeps the contract the cart relies on
 * (the same joints, clips and material sets; see meshReplace.ts). An object
 * whose replacement breaks it keeps the demo's model, and says why. The
 * arena's model, lighting and sounds stay the demo's own; its markup (spawns,
 * pads, teleporters, collision) travels too, when it was edited (EP25:
 * {@link lockoutMarkup}).
 */

import { arenaMap, arenaMapCodeFor, deserializeMeshAsset, sameArenaCollision, sameArenaMap } from "@cartbox/editor";

import { arenaSceneCentre, checkArenaMap, rebuildArenaNavigation, relayArenaPickups } from "./arenaBuild";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshArena, setMeshNavMesh, type MeshSidecar } from "./meshSidecar";
import { assetContract, contractKept, describeContract } from "./meshReplace";

/** Lockout's editable assets, by object id: its bots, first-person viewmodels (each hand's), pickups and Holograms' bodies. */
export function isLockoutAsset(id: string): boolean {
  return /^(bot-\d+|viewmodel-[a-z]+(-left)?|pickup-\d+|hologram-\d+)$/.test(id);
}

/**
 * What a saved cart's asset stands in for one it doesn't have (it was saved
 * before the demo had it): a Hologram wears its first bot's Spartan; a left
 * hand's gun, its right hand's.
 */
function standIn(id: string): string | null {
  if (id.startsWith("hologram-")) return "bot-1";
  if (id.endsWith("-left")) return id.slice(0, -"-left".length);
  return null;
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
    const stand = standIn(entry.id);
    const theirs = isLockoutAsset(entry.id) ? (byId.get(entry.id) ?? (stand ? byId.get(stand) : undefined)) : undefined;
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

/**
 * A saved cart's map markup in the demo (ENGINE_PARITY_ROADMAP.md EP25, B4):
 * when the cart saved in the editor carries markup for this map that differs
 * from the shipped map's -- a spawn moved, a pad's weapons changed, a
 * teleporter added -- the demo plays it: its Pickups laid out for its pads,
 * its bots on a navmesh for its collision, and the arena code written for it.
 */
export interface LockoutMarkup {
  /** The scene to play, with the markup's Pickups (and navmesh, when its collision changed). */
  readonly json: string;
  /** The cart's code, on the edited markup. */
  readonly code: string;
  /** Problems Map Check finds with it (it still plays). */
  readonly issues: readonly string[];
}

/** The demo's map `mapId` with `saved`'s markup, or null when the saved cart has none for this map or it is the shipped map's. */
export function lockoutMarkup(mapId: string, sceneJson: string, saved: MeshSidecar | null): LockoutMarkup | null {
  const entry = arenaMap(mapId);
  const markup = saved?.arena;
  if (!markup || markup.id !== entry.id || sameArenaMap(markup, entry.scene.map)) return null;
  let scene = setMeshArena(decodeMeshSidecar(sceneJson), markup);
  if (!sameArenaCollision(markup, entry.scene.map)) {
    // The editor's own navmesh when it was rebuilt there, else one baked now.
    scene = saved.navmesh ? setMeshNavMesh(scene, saved.navmesh) : rebuildArenaNavigation(scene);
  }
  scene = relayArenaPickups(scene, markup).sidecar;
  const centre = arenaSceneCentre(scene);
  const json = encodeMeshSidecar(scene);
  if (!centre || !json) return null;
  return { json, code: arenaMapCodeFor(entry.id, markup, centre), issues: checkArenaMap(scene).map((i) => i.message) };
}
