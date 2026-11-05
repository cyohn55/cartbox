/**
 * Branches (AAA_PRODUCTION_ROADMAP.md W3): two versions of a cart (the one in
 * the editor and a snapshot) compared and merged per object, rather than one
 * replacing the other whole.
 *
 * An object is the smallest thing two people change independently:
 *
 * - each of the .tic's chunks (code, sprites, map… per bank);
 * - each sidecar, except the mesh sidecar, which is split further:
 * - each placed object of the scene (by its id), and the rest of the scene
 *   (lighting, prefabs, levels…) as one;
 * - the details and the console model.
 *
 * `compareBranches` lists what differs. `mergeBranches` takes a common ancestor
 * when there is one: an object only one side changed takes that side's version,
 * one both changed the same way takes it, and one both changed differently is a
 * conflict the caller resolves (ours or theirs). Without an ancestor every
 * difference is the caller's to choose. The mesh library is the union of both
 * sides', so an object taken from either still finds its meshes.
 */

import type { SnapshotContent } from "./cartSnapshots";
import { SIDECARS, SIDECAR_KEYS, type Sidecars } from "./sidecars";

const CHUNK_NAMES: Readonly<Record<number, string>> = {
  1: "tiles",
  2: "sprites",
  3: "cover",
  4: "map",
  5: "code",
  6: "sprite flags",
  9: "sound effects",
  10: "waveforms",
  12: "palette",
  14: "music",
  15: "music patterns",
  16: "code",
  18: "cover",
  19: "code",
};

export interface BranchObject {
  readonly key: string;
  readonly label: string;
  /** Its content, comparable as a string (JSON, or a chunk's bytes as numbers). */
  readonly value: string;
}

type Chunk = { key: string; bytes: Uint8Array };

function chunksOf(bytes: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  const seen = new Map<string, number>();
  let at = 0;
  while (at + 4 <= bytes.length) {
    const type = bytes[at]! & 0x1f;
    const bank = bytes[at]! >> 5;
    const field = bytes[at + 1]! | (bytes[at + 2]! << 8);
    const size = field === 0 && (type === 5 || type === 19) ? 0x10000 : field;
    const end = Math.min(bytes.length, at + 4 + size);
    const base = `chunk:${type}:${bank}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ key: n === 0 ? base : `${base}:${n}`, bytes: bytes.subarray(at, end) });
    at = end;
  }
  return out;
}

const chunkLabel = (key: string) => {
  const [, type, bank] = key.split(":");
  return `${CHUNK_NAMES[Number(type)] ?? "other data"}${Number(bank) > 0 ? ` (bank ${bank})` : ""}`;
};

type MeshJson = { meshes?: { id?: string; name?: string }[]; library?: Record<string, unknown> } & Record<string, unknown>;

function meshOf(sidecars: Sidecars): MeshJson | null {
  const raw = sidecars.mesh as unknown;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as MeshJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Every object of a version, by key. */
export function branchObjects(content: SnapshotContent): Map<string, BranchObject> {
  const out = new Map<string, BranchObject>();
  for (const c of chunksOf(content.bytes)) out.set(c.key, { key: c.key, label: chunkLabel(c.key), value: Array.from(c.bytes).join(",") });
  for (const key of SIDECAR_KEYS) {
    if (key === "mesh") continue;
    const v = content.sidecars[key];
    if (v !== null && v !== undefined) out.set(`sidecar:${key}`, { key: `sidecar:${key}`, label: SIDECARS[key].label, value: JSON.stringify(v) });
  }
  const mesh = meshOf(content.sidecars);
  if (mesh) {
    const { meshes = [], library: _library, ...rest } = mesh;
    void _library;
    out.set("mesh:*", { key: "mesh:*", label: "the scene's settings (lighting, prefabs, levels…)", value: JSON.stringify(rest) });
    for (const entry of meshes) if (typeof entry?.id === "string") out.set(`mesh:${entry.id}`, { key: `mesh:${entry.id}`, label: `object “${entry.name ?? entry.id}”`, value: JSON.stringify(entry) });
  }
  out.set("meta", { key: "meta", label: "details", value: JSON.stringify(content.meta) });
  out.set("model", { key: "model", label: "console model", value: content.model });
  return out;
}

export type BranchChange = "added" | "removed" | "changed";

/** What differs from `ours` to `theirs`, object by object. */
export function compareBranches(ours: SnapshotContent, theirs: SnapshotContent): { key: string; label: string; change: BranchChange }[] {
  const a = branchObjects(ours);
  const b = branchObjects(theirs);
  const out: { key: string; label: string; change: BranchChange }[] = [];
  for (const [key, o] of a) {
    const t = b.get(key);
    if (!t) out.push({ key, label: o.label, change: "removed" });
    else if (t.value !== o.value) out.push({ key, label: o.label, change: "changed" });
  }
  for (const [key, t] of b) if (!a.has(key)) out.push({ key, label: t.label, change: "added" });
  return out;
}

export interface MergeResult {
  readonly content: SnapshotContent;
  /** Objects both sides changed differently (or, without an ancestor, any that differ), as resolved. */
  readonly conflicts: readonly { key: string; label: string; took: "ours" | "theirs" }[];
}

/**
 * Merge `theirs` into `ours`, against their common `base` when known. `choose`
 * resolves a conflict (default: ours).
 */
export function mergeBranches(base: SnapshotContent | null, ours: SnapshotContent, theirs: SnapshotContent, choose: (key: string) => "ours" | "theirs" = () => "ours"): MergeResult {
  const o = branchObjects(ours);
  const t = branchObjects(theirs);
  const b = base ? branchObjects(base) : null;
  const keys = [...new Set([...o.keys(), ...t.keys()])];
  const pick = new Map<string, "ours" | "theirs">();
  const conflicts: { key: string; label: string; took: "ours" | "theirs" }[] = [];
  for (const key of keys) {
    const ov = o.get(key)?.value;
    const tv = t.get(key)?.value;
    if (ov === tv) {
      pick.set(key, "ours");
      continue;
    }
    if (b) {
      const bv = b.get(key)?.value;
      if (ov === bv) {
        pick.set(key, "theirs");
        continue;
      }
      if (tv === bv) {
        pick.set(key, "ours");
        continue;
      }
    }
    const took = choose(key);
    pick.set(key, took);
    conflicts.push({ key, label: (o.get(key) ?? t.get(key))!.label, took });
  }
  const from = (key: string) => (pick.get(key) === "theirs" ? theirs : ours);
  // The .tic: ours' chunks in their order, then any only theirs has, each from the side picked (absent there: dropped).
  const oc = chunksOf(ours.bytes);
  const tc = chunksOf(theirs.bytes);
  const chunkFrom = (side: SnapshotContent, key: string) => (side === ours ? oc : tc).find((c) => c.key === key)?.bytes;
  const order = [...oc.map((c) => c.key), ...tc.map((c) => c.key).filter((k) => !oc.some((c) => c.key === k))];
  const parts = order.map((key) => chunkFrom(from(key), key)).filter((x): x is Uint8Array => x !== undefined);
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  // Sidecars, each from the side picked.
  const sidecars = { ...ours.sidecars } as Record<string, unknown>;
  for (const key of SIDECAR_KEYS) if (key !== "mesh") sidecars[key] = from(`sidecar:${key}`).sidecars[key] ?? null;
  // The scene: its settings from one side, each object from the side picked, the library from both.
  const om = meshOf(ours.sidecars);
  const tm = meshOf(theirs.sidecars);
  if (om || tm) {
    const restSide = meshOf(from("mesh:*").sidecars) ?? om ?? tm!;
    const { meshes: _m, library: _l, ...rest } = restSide;
    void _m;
    void _l;
    const ids = [...(om?.meshes ?? []).map((m) => m.id!), ...(tm?.meshes ?? []).map((m) => m.id!).filter((id) => !(om?.meshes ?? []).some((m) => m.id === id))];
    const meshes = ids.flatMap((id) => {
      const side = pick.get(`mesh:${id}`) === "theirs" ? tm : om;
      const entry = side?.meshes?.find((m) => m.id === id);
      return entry ? [entry] : [];
    });
    const library = { ...(tm?.library ?? {}), ...(om?.library ?? {}) };
    sidecars.mesh = JSON.stringify({ ...rest, meshes, ...(Object.keys(library).length > 0 ? { library } : {}) });
  }
  return {
    content: { model: from("model").model, bytes, sidecars: sidecars as unknown as Sidecars, meta: from("meta").meta },
    conflicts,
  };
}
