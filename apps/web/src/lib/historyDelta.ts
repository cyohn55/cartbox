/**
 * The editor's undo steps as deltas (AAA_PRODUCTION_ROADMAP.md W1): a cart
 * snapshot's patch is the runs of its .tic bytes that changed and the sidecars
 * that changed (sidecar values are immutable, so an unchanged one is the same
 * object and costs nothing).
 */

import { applyBytes, bytesPatchSize, diffBytes, type BytesPatch, type DeltaCodec } from "@cartbox/editor";

import { SIDECAR_KEYS, type Sidecars } from "./sidecars";

/** What the history holds for the editor (useEditorHistory's CartSnapshot). */
export interface DeltaSnapshot {
  bytes: Uint8Array;
  bank: number;
  sidecars: Sidecars;
  hash: number;
}

export interface SnapshotPatch {
  readonly bytes: BytesPatch;
  readonly bank: number;
  readonly hash: number;
  /** The sidecars that differ, as the target has them. */
  readonly sidecars: Partial<Sidecars>;
}

/** A sidecar value's size, measured once per value (they're immutable). */
const sizes = new WeakMap<object, number>();
function valueSize(value: unknown): number {
  if (value === null || value === undefined) return 8;
  if (typeof value === "string") return 16 + value.length * 2;
  if (typeof value !== "object") return 16;
  const known = sizes.get(value);
  if (known !== undefined) return known;
  let size: number;
  try {
    size = 16 + JSON.stringify(value).length * 2;
  } catch {
    size = 1024;
  }
  sizes.set(value, size);
  return size;
}

export const SNAPSHOT_DELTAS: DeltaCodec<DeltaSnapshot, SnapshotPatch> = {
  diff(to, from) {
    const sidecars: Partial<Record<keyof Sidecars, unknown>> = {};
    for (const key of SIDECAR_KEYS) if (to.sidecars[key] !== from.sidecars[key]) sidecars[key] = to.sidecars[key];
    return { bytes: diffBytes(to.bytes, from.bytes), bank: to.bank, hash: to.hash, sidecars: sidecars as Partial<Sidecars> };
  },
  apply(from, patch) {
    return { bytes: applyBytes(from.bytes, patch.bytes), bank: patch.bank, hash: patch.hash, sidecars: { ...from.sidecars, ...patch.sidecars } };
  },
  size(patch) {
    return bytesPatchSize(patch.bytes) + Object.values(patch.sidecars).reduce((n: number, v) => n + valueSize(v), 0);
  },
};
