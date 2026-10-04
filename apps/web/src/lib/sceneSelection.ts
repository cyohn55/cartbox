/**
 * Selection and object operations for the Mesh tab (ENGINE_PARITY_ROADMAP.md
 * EP3), as pure functions over the sidecar: which selected objects are roots
 * (an object whose ancestor is also selected moves with it, not on its own),
 * duplicate, copy and paste (through the clipboard, also between carts),
 * delete, and the box select's hit test.
 *
 * Every operation works on whole subtrees: an object comes with everything
 * under it, as it does in Unity and Unreal.
 */

import { composeModelMatrix, decomposeModelMatrix, parentIndices, worldMatrices } from "@cartbox/editor";

import { MESH_SIDECAR_VERSION, decodeMeshSidecar, newMeshId, type MeshSidecar, type MeshSidecarEntry } from "./meshSidecar";

/** What the clipboard holds: a marker, and the copied entries (roots placed in the world). */
export const CLIPBOARD_KIND = "cartbox/scene-objects";

/** The selected ids whose ancestors aren't selected, in scene order. */
export function selectionRoots(sidecar: MeshSidecar, ids: readonly string[]): string[] {
  const selected = new Set(ids);
  const byId = new Map(sidecar.meshes.map((m) => [m.id, m]));
  const covered = (entry: MeshSidecarEntry): boolean => {
    for (let p = entry.parent ? byId.get(entry.parent) : undefined, guard = 0; p && guard < 1024; p = p.parent ? byId.get(p.parent) : undefined, guard += 1) {
      if (selected.has(p.id)) return true;
    }
    return false;
  };
  return sidecar.meshes.filter((m) => selected.has(m.id) && !covered(m)).map((m) => m.id);
}

/** The ids `ids` and everything under them, in scene order. */
export function withSubtrees(sidecar: MeshSidecar, ids: readonly string[]): string[] {
  const keep = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of sidecar.meshes) {
      if (m.parent && keep.has(m.parent) && !keep.has(m.id)) {
        keep.add(m.id);
        grew = true;
      }
    }
  }
  return sidecar.meshes.filter((m) => keep.has(m.id)).map((m) => m.id);
}

/** "Crate" → "Crate (1)", "Crate (1)" → "Crate (2)", skipping names already taken. */
export function nextName(name: string, taken: ReadonlySet<string>): string {
  const match = /^(.*) \((\d+)\)$/.exec(name);
  const base = match ? match[1]! : name;
  let n = match ? Number(match[2]) + 1 : 1;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
}

/**
 * Copies of `entries` with new ids, their parent links remapped inside the set
 * (a root keeps `rootParent`, or none) and roots renamed so they read as
 * copies. A prefab link survives only when its whole placed copy came along.
 */
function cloneEntries(sidecar: MeshSidecar, entries: readonly MeshSidecarEntry[], rootParent: (entry: MeshSidecarEntry) => string | null): { entries: MeshSidecarEntry[]; roots: string[] } {
  const ids = new Map(entries.map((e) => [e.id, newMeshId()]));
  const taken = new Set(sidecar.meshes.map((m) => m.name));
  const roots: string[] = [];
  const out = entries.map((e) => {
    const { parent: _parent, prefab, ...rest } = e;
    const isRoot = !e.parent || !ids.has(e.parent);
    const parent = isRoot ? rootParent(e) : ids.get(e.parent!)!;
    const name = isRoot ? nextName(e.name, taken) : e.name;
    if (isRoot) {
      taken.add(name);
      roots.push(ids.get(e.id)!);
    }
    const instance = prefab ? ids.get(prefab.instance) : undefined;
    return {
      ...rest,
      id: ids.get(e.id)!,
      name,
      ...(parent ? { parent } : {}),
      ...(prefab && instance ? { prefab: { ...prefab, instance } } : {}),
    } as MeshSidecarEntry;
  });
  return { entries: out, roots };
}

/** Duplicate the selection (with what's under it) in place, beside the originals. The new roots come back to be selected. */
export function duplicateEntries(sidecar: MeshSidecar, ids: readonly string[]): { sidecar: MeshSidecar; ids: string[] } {
  const roots = selectionRoots(sidecar, ids);
  if (roots.length === 0) return { sidecar, ids: [] };
  const set = new Set(withSubtrees(sidecar, roots));
  const source = sidecar.meshes.filter((m) => set.has(m.id));
  const { entries, roots: copies } = cloneEntries(sidecar, source, (e) => e.parent ?? null);
  return { sidecar: { ...sidecar, version: MESH_SIDECAR_VERSION, meshes: [...sidecar.meshes, ...entries] }, ids: copies };
}

/**
 * The clipboard text for the selection: its roots (with world transforms, so a
 * paste lands where they were) and everything under them.
 */
export function copyPayload(sidecar: MeshSidecar, ids: readonly string[]): string | null {
  const roots = selectionRoots(sidecar, ids);
  if (roots.length === 0) return null;
  const set = new Set(withSubtrees(sidecar, roots));
  const world = worldMatrices(
    sidecar.meshes.map(({ transform: t }) => composeModelMatrix(t.position, t.rotation, t.scale)),
    parentIndices(sidecar.meshes),
  );
  const rootSet = new Set(roots);
  const entries = sidecar.meshes.flatMap((m, i) => {
    if (!set.has(m.id)) return [];
    if (!rootSet.has(m.id)) return [m];
    const { parent: _parent, ...rest } = m;
    return [{ ...rest, transform: decomposeModelMatrix(world[i]!) }];
  });
  return JSON.stringify({ kind: CLIPBOARD_KIND, version: MESH_SIDECAR_VERSION, meshes: entries });
}

/**
 * Paste clipboard text into the scene (at the top level, where the copies
 * were in the world). The text is checked as strictly as a stored sidecar — it
 * may come from anywhere — and anything that isn't Cartbox scene objects is
 * refused (the sidecar comes back unchanged, with no new ids).
 */
export function pasteEntries(sidecar: MeshSidecar, text: string): { sidecar: MeshSidecar; ids: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { sidecar, ids: [] };
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { kind?: unknown }).kind !== CLIPBOARD_KIND) return { sidecar, ids: [] };
  const decoded = decodeMeshSidecar(JSON.stringify({ version: MESH_SIDECAR_VERSION, meshes: (parsed as { meshes?: unknown }).meshes }));
  if (decoded.meshes.length === 0) return { sidecar, ids: [] };
  const { entries, roots } = cloneEntries(sidecar, decoded.meshes, () => null);
  return { sidecar: { ...sidecar, version: MESH_SIDECAR_VERSION, meshes: [...sidecar.meshes, ...entries] }, ids: roots };
}

/** Delete the selection and everything under it. */
export function removeEntries(sidecar: MeshSidecar, ids: readonly string[]): MeshSidecar {
  const gone = new Set(withSubtrees(sidecar, ids));
  if (gone.size === 0) return sidecar;
  return { ...sidecar, version: MESH_SIDECAR_VERSION, meshes: sidecar.meshes.filter((m) => !gone.has(m.id)) };
}

/** A screen rectangle from two corners (any order). */
export interface ScreenRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * The objects a box select takes: those whose world box's projected centre is
 * inside the rectangle (`project` gives screen pixels, or null behind the
 * camera).
 */
export function boxSelect(
  objects: readonly { readonly id: string; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] }[],
  rect: ScreenRect,
  project: (p: readonly [number, number, number]) => readonly [number, number] | null,
): string[] {
  const left = Math.min(rect.x0, rect.x1);
  const right = Math.max(rect.x0, rect.x1);
  const top = Math.min(rect.y0, rect.y1);
  const bottom = Math.max(rect.y0, rect.y1);
  return objects
    .filter((o) => {
      const p = project([(o.min[0] + o.max[0]) / 2, (o.min[1] + o.max[1]) / 2, (o.min[2] + o.max[2]) / 2]);
      return !!p && p[0] >= left && p[0] <= right && p[1] >= top && p[1] <= bottom;
    })
    .map((o) => o.id);
}

/**
 * The next selection after clicking `id`: alone (a plain click), added or
 * removed (Ctrl/Cmd toggles, Shift adds), with the clicked one last — the
 * primary the inspector and gizmo follow. Clicking nothing clears a plain
 * selection and leaves a modified one alone.
 */
export function clickSelection(current: readonly string[], id: string | null, mods: { readonly toggle?: boolean; readonly add?: boolean }): string[] {
  if (id === null) return mods.toggle || mods.add ? [...current] : [];
  if (mods.toggle && current.includes(id)) return current.filter((x) => x !== id);
  if (mods.toggle || mods.add) return [...current.filter((x) => x !== id), id];
  return [id];
}
