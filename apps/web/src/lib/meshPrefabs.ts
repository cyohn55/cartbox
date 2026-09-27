/**
 * Prefabs (ENGINE_ROADMAP.md, Phase 1): save an object and everything under it
 * as a reusable group, place copies of it, and push edits to every copy.
 *
 * A prefab is a template of nodes (a root and its descendants: name, mesh,
 * animation frames, transform relative to the parent, tags, properties). Placing
 * it adds ordinary sidecar entries, each linked back to its node, so the runtime
 * never needs to know prefabs exist. Each copy keeps its own root placement.
 *
 * Overrides work like Unity's without any bookkeeping: a field on a copy that
 * differs from the prefab is that copy's override. "Apply" makes one copy the new
 * prefab; every other copy takes the new value of each field it had left
 * matching the old prefab, and keeps the fields it had changed. "Revert" drops a
 * copy's overrides. A copy's root keeps its own placement and name.
 */

import {
  defaultMeshTransform,
  type MeshPrefab,
  type MeshSidecar,
  type MeshSidecarEntry,
  type MeshTransform,
  type PrefabNode,
} from "./meshSidecar";
import { parentIndices } from "@cartbox/editor";

const VERSION_FIELDS = ["name", "mesh", "frames", "tags", "props", "physics", "transform"] as const;
type Field = (typeof VERSION_FIELDS)[number];

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}

/** Stable JSON for comparing field values (object keys sorted). */
function stable(value: unknown): string {
  if (value === undefined) return "u";
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

const fieldOf = (x: Partial<Record<Field, unknown>>, f: Field): unknown => {
  const v = x[f];
  // Empty frames / tags / props are the same as none.
  if (Array.isArray(v) && v.length === 0) return undefined;
  if (v && typeof v === "object" && !Array.isArray(v) && f === "props" && Object.keys(v).length === 0) return undefined;
  return v;
};
const same = (a: Partial<Record<Field, unknown>>, b: Partial<Record<Field, unknown>>, f: Field) =>
  stable(fieldOf(a, f)) === stable(fieldOf(b, f));

/** `root` and every entry under it, in Hierarchy order (parents before children). */
function subtree(sidecar: MeshSidecar, rootId: string): MeshSidecarEntry[] {
  const parents = parentIndices(sidecar.meshes);
  const start = sidecar.meshes.findIndex((m) => m.id === rootId);
  if (start < 0) return [];
  const out: number[] = [start];
  for (let i = 0; i < out.length; i += 1) {
    parents.forEach((p, c) => {
      if (p === out[i]) out.push(c);
    });
  }
  return out.map((i) => sidecar.meshes[i]!);
}

/** `base`, or `base 2`, `base 3`… — the first name no entry has yet (so cartbox.find can tell copies apart). */
function uniqueName(sidecar: MeshSidecar, base: string): string {
  const taken = new Set(sidecar.meshes.map((m) => m.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/ \d+$/, "");
  for (let n = 2; ; n += 1) if (!taken.has(`${stem} ${n}`)) return `${stem} ${n}`;
}

/** The prefab `id`, or undefined. */
export function findPrefab(sidecar: MeshSidecar, id: string): MeshPrefab | undefined {
  return (sidecar.prefabs ?? []).find((p) => p.id === id);
}

/** The root entry ids of every placed copy of prefab `id`. */
export function prefabInstances(sidecar: MeshSidecar, id: string): string[] {
  return sidecar.meshes.filter((m) => m.prefab?.id === id && m.prefab.instance === m.id).map((m) => m.id);
}

/** Copy one field from a node onto an entry (removing it when the node has none). */
function assign(entry: MeshSidecarEntry, node: PrefabNode, f: Field): MeshSidecarEntry {
  const next = { ...entry } as Record<string, unknown>;
  const value = fieldOf(node, f);
  if (value === undefined) delete next[f];
  else next[f] = value;
  return next as unknown as MeshSidecarEntry;
}

/** The node an entry becomes when captured into a prefab. */
function nodeFrom(entry: MeshSidecarEntry, key: string, parent: string | undefined, isRoot: boolean): PrefabNode {
  return {
    key,
    name: entry.name,
    mesh: entry.mesh,
    transform: isRoot ? defaultMeshTransform() : entry.transform,
    ...(entry.frames && entry.frames.length > 0 ? { frames: entry.frames } : {}),
    ...(parent ? { parent } : {}),
    ...(entry.tags && entry.tags.length > 0 ? { tags: entry.tags } : {}),
    ...(entry.props && Object.keys(entry.props).length > 0 ? { props: entry.props } : {}),
    ...(entry.physics ? { physics: entry.physics } : {}),
  };
}

/**
 * Capture `rootId` and everything under it as a new prefab named `name`, and link
 * those entries to it (they become its first copy). An entry that was part of
 * another prefab's copy is re-linked to the new one.
 */
export function createPrefab(sidecar: MeshSidecar, rootId: string, name: string): { sidecar: MeshSidecar; prefabId: string } {
  const members = subtree(sidecar, rootId);
  if (members.length === 0) return { sidecar, prefabId: "" };
  const prefabId = newId("prefab");
  const keyOf = new Map(members.map((m, i) => [m.id, `n${i}`]));
  const nodes = members.map((m, i) => nodeFrom(m, `n${i}`, i === 0 ? undefined : keyOf.get(m.parent ?? ""), i === 0));
  const prefab: MeshPrefab = { id: prefabId, name: name.trim() || members[0]!.name || "Prefab", nodes };
  const meshes = sidecar.meshes.map((m) =>
    keyOf.has(m.id) ? { ...m, prefab: { id: prefabId, node: keyOf.get(m.id)!, instance: rootId } } : m,
  );
  return { sidecar: { ...sidecar, meshes, prefabs: [...(sidecar.prefabs ?? []), prefab] }, prefabId };
}

/**
 * Place a new copy of prefab `id`: one entry per node, the root at `transform`
 * (default: the origin) and under `parentId` when given. Returns the new root's id.
 */
export function placePrefab(
  sidecar: MeshSidecar,
  id: string,
  { transform, parentId }: { transform?: MeshTransform; parentId?: string | null } = {},
): { sidecar: MeshSidecar; rootId: string } {
  const prefab = findPrefab(sidecar, id);
  if (!prefab) return { sidecar, rootId: "" };
  const ids = new Map(prefab.nodes.map((n) => [n.key, newId("mesh")]));
  const root = prefab.nodes.find((n) => !n.parent)!;
  const rootId = ids.get(root.key)!;
  const validParent = parentId && sidecar.meshes.some((m) => m.id === parentId) ? parentId : null;
  const added: MeshSidecarEntry[] = prefab.nodes.map((node) => {
    const isRoot = node === root;
    const parent = isRoot ? validParent : ids.get(node.parent!)!;
    return {
      id: ids.get(node.key)!,
      name: isRoot ? uniqueName(sidecar, node.name) : node.name,
      mesh: node.mesh,
      transform: isRoot ? (transform ?? defaultMeshTransform()) : node.transform,
      ...(node.frames ? { frames: node.frames } : {}),
      ...(parent ? { parent } : {}),
      ...(node.tags ? { tags: node.tags } : {}),
      ...(node.props ? { props: node.props } : {}),
      ...(node.physics ? { physics: node.physics } : {}),
      prefab: { id, node: node.key, instance: rootId },
    };
  });
  return { sidecar: { ...sidecar, meshes: [...sidecar.meshes, ...added] }, rootId };
}

/**
 * Bring one placed copy in line with `next`. Each field that still matches `prev`
 * (or every field, with `force`) takes the new value; the rest are the copy's
 * overrides and stay. Nodes new to the prefab are added, nodes gone from it are
 * removed, and the root's placement is never touched.
 */
function syncInstance(
  meshes: MeshSidecarEntry[],
  instanceId: string,
  prev: MeshPrefab,
  next: MeshPrefab,
  force: boolean,
): MeshSidecarEntry[] {
  const byNode = new Map(
    meshes.filter((m) => m.prefab?.id === next.id && m.prefab.instance === instanceId).map((m) => [m.prefab!.node, m]),
  );
  const rootEntry = meshes.find((m) => m.id === instanceId);
  if (!rootEntry) return meshes;
  const idOf = new Map<string, string>();
  for (const node of next.nodes) idOf.set(node.key, byNode.get(node.key)?.id ?? newId("mesh"));
  const prevNode = new Map(prev.nodes.map((n) => [n.key, n]));
  const nextKeys = new Set(next.nodes.map((n) => n.key));

  const updated = new Map<string, MeshSidecarEntry>();
  const added: MeshSidecarEntry[] = [];
  for (const node of next.nodes) {
    const isRoot = !node.parent;
    const existing = byNode.get(node.key);
    if (!existing) {
      added.push({
        id: idOf.get(node.key)!,
        name: node.name,
        mesh: node.mesh,
        transform: node.transform,
        ...(node.frames ? { frames: node.frames } : {}),
        parent: idOf.get(node.parent!)!,
        ...(node.tags ? { tags: node.tags } : {}),
        ...(node.props ? { props: node.props } : {}),
        ...(node.physics ? { physics: node.physics } : {}),
        prefab: { id: next.id, node: node.key, instance: instanceId },
      });
      continue;
    }
    let entry = existing;
    const old = prevNode.get(node.key);
    for (const f of VERSION_FIELDS) {
      if ((f === "transform" || f === "name") && isRoot) continue; // each copy is placed (and named) on its own
      if (force || !old || same(entry, old, f)) entry = assign(entry, node, f);
    }
    if (!isRoot) entry = { ...entry, parent: idOf.get(node.parent!)! };
    updated.set(existing.id, entry);
  }
  const removed = new Set(
    [...byNode.entries()].filter(([key]) => !nextKeys.has(key)).map(([, m]) => m.id),
  );
  return [
    ...meshes.filter((m) => !removed.has(m.id)).map((m) => updated.get(m.id) ?? m),
    ...added,
  ];
}

/**
 * Make the copy rooted at `instanceId` the new prefab (its whole subtree, including
 * objects added under it since it was placed), then update every other copy,
 * keeping their overrides.
 */
export function applyToPrefab(sidecar: MeshSidecar, instanceId: string): MeshSidecar {
  const root = sidecar.meshes.find((m) => m.id === instanceId);
  const prev = root?.prefab ? findPrefab(sidecar, root.prefab.id) : undefined;
  if (!root?.prefab || !prev || root.prefab.instance !== instanceId) return sidecar;
  const members = subtree(sidecar, instanceId);
  // Existing nodes keep their keys; objects added under the copy get fresh ones.
  const used = new Set(prev.nodes.map((n) => n.key));
  let counter = prev.nodes.length;
  const keyOf = new Map<string, string>();
  for (const m of members) {
    if (m.prefab?.id === prev.id && m.prefab.instance === instanceId) keyOf.set(m.id, m.prefab.node);
    else {
      while (used.has(`n${counter}`)) counter += 1;
      used.add(`n${counter}`);
      keyOf.set(m.id, `n${counter}`);
    }
  }
  const nodes = members.map((m, i) => nodeFrom(m, keyOf.get(m.id)!, i === 0 ? undefined : keyOf.get(m.parent ?? ""), i === 0));
  const next: MeshPrefab = { ...prev, nodes };
  let meshes = sidecar.meshes.map((m) =>
    keyOf.has(m.id) ? { ...m, prefab: { id: prev.id, node: keyOf.get(m.id)!, instance: instanceId } } : m,
  );
  for (const other of prefabInstances({ ...sidecar, meshes }, prev.id)) {
    if (other !== instanceId) meshes = syncInstance(meshes, other, prev, next, false);
  }
  return { ...sidecar, meshes, prefabs: (sidecar.prefabs ?? []).map((p) => (p.id === prev.id ? next : p)) };
}

/** Drop every override on the copy rooted at `instanceId` (its placement stays). */
export function revertToPrefab(sidecar: MeshSidecar, instanceId: string): MeshSidecar {
  const root = sidecar.meshes.find((m) => m.id === instanceId);
  const prefab = root?.prefab ? findPrefab(sidecar, root.prefab.id) : undefined;
  if (!prefab) return sidecar;
  return { ...sidecar, meshes: syncInstance([...sidecar.meshes], instanceId, prefab, prefab, true) };
}

/** Turn the copy rooted at `instanceId` back into plain objects. */
export function unlinkPrefab(sidecar: MeshSidecar, instanceId: string): MeshSidecar {
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (m.prefab?.instance !== instanceId) return m;
      const { prefab: _drop, ...rest } = m;
      return rest;
    }),
  };
}

/** Delete prefab `id`; its copies stay as plain objects. */
export function deletePrefab(sidecar: MeshSidecar, id: string): MeshSidecar {
  return {
    ...sidecar,
    meshes: sidecar.meshes.map((m) => {
      if (m.prefab?.id !== id) return m;
      const { prefab: _drop, ...rest } = m;
      return rest;
    }),
    prefabs: (sidecar.prefabs ?? []).filter((p) => p.id !== id),
  };
}

/** Rename prefab `id`. */
export function renamePrefab(sidecar: MeshSidecar, id: string, name: string): MeshSidecar {
  return { ...sidecar, prefabs: (sidecar.prefabs ?? []).map((p) => (p.id === id ? { ...p, name } : p)) };
}

/**
 * How many fields the copy rooted at `instanceId` overrides, plus objects added
 * under it that the prefab doesn't have (what Apply would push, Revert would drop).
 */
export function overrideCount(sidecar: MeshSidecar, instanceId: string): number {
  const root = sidecar.meshes.find((m) => m.id === instanceId);
  const prefab = root?.prefab ? findPrefab(sidecar, root.prefab.id) : undefined;
  if (!prefab) return 0;
  const nodes = new Map(prefab.nodes.map((n) => [n.key, n]));
  let count = 0;
  for (const m of subtree(sidecar, instanceId)) {
    const node = m.prefab?.id === prefab.id && m.prefab.instance === instanceId ? nodes.get(m.prefab.node) : undefined;
    if (!node) {
      count += 1;
      continue;
    }
    for (const f of VERSION_FIELDS) {
      if ((f === "transform" || f === "name") && !node.parent) continue;
      if (!same(m, node, f)) count += 1;
    }
  }
  return count;
}
