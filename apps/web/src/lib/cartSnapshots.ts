/**
 * Named snapshots of a cart (ENGINE_PARITY_ROADMAP.md EP19): the whole cart —
 * its .tic bytes, every sidecar and its details — kept under a name, to go
 * back to later.
 *
 * - **What's kept** is exactly what Save writes (see persistCart.ts), so a
 *   restore puts back everything a save would.
 * - **Where:** in the creator's account when they're signed in (the snapshots
 *   API, object storage), else in this browser (IndexedDB). See
 *   snapshotStore.ts.
 * - **Restoring** says first what will change, by part of the cart (code,
 *   sprites, map… and each sidecar), and takes a snapshot of the current state
 *   before it replaces anything — so a restore can itself be undone.
 *
 * A snapshot travels as gzipped JSON. This module is the pure half: names,
 * the payload codec and the change summary.
 */

import { base64ToBytes, bytesToBase64 } from "@cartbox/editor";

import type { CartMeta } from "./cartMeta";
import { SIDECARS, SIDECAR_KEYS, parseSidecars, type Sidecars } from "./sidecars";

/** What a snapshot holds: what Save writes. */
export interface SnapshotContent {
  readonly model: string;
  readonly bytes: Uint8Array;
  readonly sidecars: Sidecars;
  readonly meta: CartMeta;
}

/** A snapshot as listed (its content loaded only on restore). */
export interface SnapshotInfo {
  readonly id: string;
  readonly name: string;
  /** ISO time it was taken. */
  readonly createdAt: string;
  /** Compressed size in bytes. */
  readonly size: number;
}

export const MAX_SNAPSHOT_NAME = 80;
/** Snapshots kept per cart; the oldest must be deleted to take more. */
export const MAX_SNAPSHOTS = 50;
/** Largest compressed snapshot accepted (a big 3D scene is a few MB). */
export const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;

/** A snapshot name: trimmed, single-line, 1–80 characters (null when there's nothing left). */
export function snapshotName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const printable = Array.from(raw, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? " " : c)).join("");
  const name = printable.replace(/\s+/g, " ").trim().slice(0, MAX_SNAPSHOT_NAME).trim();
  return name.length > 0 ? name : null;
}

/** The default name for a snapshot taken now. */
export function defaultSnapshotName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Snapshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The snapshot as JSON text. */
export function encodeSnapshot(content: SnapshotContent): string {
  return JSON.stringify({ version: 1, model: content.model, bytes: bytesToBase64(content.bytes), sidecars: content.sidecars, meta: content.meta });
}

/** A snapshot read back defensively: null for anything that isn't one; sidecars re-validated. */
export function decodeSnapshot(text: string): SnapshotContent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.model !== "string" || typeof r.bytes !== "string") return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(r.bytes);
  } catch {
    return null;
  }
  const m = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
  const meta: CartMeta = {
    title: typeof m.title === "string" ? m.title : "",
    description: typeof m.description === "string" ? m.description : "",
    tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [],
  };
  return { model: r.model, bytes, sidecars: parseSidecars(r.sidecars), meta };
}

/** Gzip, by the platform's CompressionStream. */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gunzip to text (null when the bytes aren't gzip). */
export async function gunzip(bytes: Uint8Array): Promise<string | null> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  try {
    const stream = new Blob([bytes.buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  } catch {
    return null;
  }
}

/** A snapshot compressed for storage. */
export async function packSnapshot(content: SnapshotContent): Promise<Uint8Array> {
  return gzip(encodeSnapshot(content));
}

/** A stored snapshot opened (null when damaged). */
export async function unpackSnapshot(bytes: Uint8Array): Promise<SnapshotContent | null> {
  const text = await gunzip(bytes);
  return text === null ? null : decodeSnapshot(text);
}

/** What each TIC-80 chunk type holds, as a creator would name it. */
const CHUNK_PARTS: Readonly<Record<number, string>> = {
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
  15: "music",
  16: "code",
  18: "cover",
  19: "code",
};

/** The cart's chunks grouped by part ("code", "sprites"…), each part's bytes joined in order. */
function cartParts(bytes: Uint8Array): Map<string, number[]> {
  const parts = new Map<string, number[]>();
  let at = 0;
  while (at + 4 <= bytes.length) {
    const type = bytes[at]! & 0x1f;
    const bank = bytes[at]! >> 5;
    const field = bytes[at + 1]! | (bytes[at + 2]! << 8);
    const size = field === 0 && (type === 5 || type === 19) ? 0x10000 : field;
    const end = Math.min(bytes.length, at + 4 + size);
    const name = CHUNK_PARTS[type] ?? "other data";
    const list = parts.get(name) ?? [];
    list.push(bank, ...bytes.subarray(at + 4, end));
    parts.set(name, list);
    at = at + 4 + size;
  }
  return parts;
}

const sameNumbers = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((v, i) => v === b![i]);

/**
 * What would change going from `current` to `target`, by part: the cart's own
 * parts ("code", "sprites", "map"…), then each sidecar by its label, then
 * "details" and "console model". Empty when they're the same.
 */
export function snapshotChanges(current: SnapshotContent, target: SnapshotContent): string[] {
  const out: string[] = [];
  const a = cartParts(current.bytes);
  const b = cartParts(target.bytes);
  const names = new Set([...a.keys(), ...b.keys()]);
  const order = ["code", "sprites", "tiles", "sprite flags", "map", "palette", "sound effects", "waveforms", "music", "cover", "other data"];
  for (const name of order) if (names.has(name) && !sameNumbers(a.get(name), b.get(name))) out.push(name);
  for (const key of SIDECAR_KEYS) {
    if (JSON.stringify(current.sidecars[key] ?? null) !== JSON.stringify(target.sidecars[key] ?? null)) out.push(SIDECARS[key].label);
  }
  if (JSON.stringify(current.meta) !== JSON.stringify(target.meta)) out.push("details");
  if (current.model !== target.model) out.push("console model");
  return out;
}

/** Newest first, then by name. */
export function sortSnapshots(list: readonly SnapshotInfo[]): SnapshotInfo[] {
  return [...list].sort((x, y) => y.createdAt.localeCompare(x.createdAt) || x.name.localeCompare(y.name));
}

/** Where a snapshot's payload lives in object storage. */
export function snapshotObjectKey(cartId: string, id: string): string {
  return `snapshots/${cartId}/${id}.json.gz`;
}

/**
 * Why an upload can't be kept, with its HTTP status (null when it can): it must
 * be gzip, within the size limit, and the cart must have room for another.
 */
export function snapshotUploadError(bytes: Uint8Array, existing: number): { message: string; status: 400 | 409 | 413 } | null {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { message: "A snapshot is a gzipped cart.", status: 400 };
  if (bytes.length > MAX_SNAPSHOT_BYTES) return { message: `A snapshot can be at most ${Math.round(MAX_SNAPSHOT_BYTES / 1048576)} MB.`, status: 413 };
  if (existing >= MAX_SNAPSHOTS) return { message: `A cart keeps at most ${MAX_SNAPSHOTS} snapshots: delete an old one first.`, status: 409 };
  return null;
}
