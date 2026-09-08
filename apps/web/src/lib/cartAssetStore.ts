/**
 * Content-addressed asset manifests — the cart format for content that cannot
 * fit in a cartridge.
 *
 * A `.tic` is one blob capped at 2MB (`MAX_CART_BYTES`), which is the right
 * shape for an 8-bit console and the wrong shape for any 3D one: a textured
 * PS1-era scene does not fit, at any resolution. So a cart that needs more
 * stops being a blob and becomes *a blob plus a manifest*, with the bulk stored
 * beside it and referenced by hash. See ERA_MODELS.md §5.2.
 *
 * ## Not to be confused with the Tier C asset vault
 *
 * `assetVault.ts` stores game files a *player* supplies for a Tier C title, and
 * it deliberately refuses content addressing: keys there are scoped per title
 * and never by hash, because a shared copy between two accounts is the exact
 * mechanism that would make the platform a distributor rather than a viewer.
 * That is a legal posture, and nothing here changes it.
 *
 * This module is the opposite case — content a *creator* uploads to their own
 * cart and has the right to publish — where sharing one stored copy between
 * carts is the whole point. The two must never be merged, and neither one's
 * rules should be read across to the other.
 *
 * ## Why content-addressed here
 *
 * An asset's identity is its SHA-256, not a name or a row id. Three things
 * follow, and all three matter more than the hashing costs:
 *
 * - **Dedup is free and global.** A tileset shared by fifty remixes of a cart
 *   is stored once. For a marketplace built on remixing, that is the difference
 *   between storage growing with forks and growing with originals.
 * - **Assets are immutable**, so they cache forever and a published cart cannot
 *   be altered underneath its players by re-uploading a texture.
 * - **Uploads are idempotent.** Re-saving a cart re-sends nothing it already
 *   stored, because the hash is already present.
 *
 * The trade is that nothing is ever edited in place: changing a texture makes a
 * new asset and leaves the old one referenced by whoever still points at it.
 * Reclaiming those is deferred — see `UNREFERENCED ASSETS` at the bottom.
 *
 * Pure and isomorphic: no R2, no database, no DOM.
 */

export { sha256Hex as hashAsset } from "./sha256";

/** A SHA-256 as 64 lowercase hex characters. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Names that would be unsafe or ambiguous once a manifest key reaches a URL, a
 * log line, or a filesystem-shaped cache: path separators and control
 * characters. Traversal is checked separately.
 */
const UNSAFE_NAME = /[\u0000-\u001f\u007f/\\]/;

/**
 * What a cart may reference. Deliberately a small allowlist rather than
 * anything-goes: an asset store that accepts arbitrary bytes is a file host,
 * with a file host's abuse surface, and nothing here needs to be one.
 *
 * No SVG. It is a script-execution vector dressed as an image, and none of the
 * runtime's texture paths can consume it anyway.
 */
export const ALLOWED_ASSET_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "model/gltf-binary",
  "audio/wav",
  "audio/ogg",
];

/** Largest single asset, whatever the model's total budget. */
export const MAX_ASSET_BYTES = 16 * 1024 * 1024;

/** One stored blob, addressed by its content hash. */
export interface AssetRef {
  /** SHA-256 of the bytes, lowercase hex. */
  readonly hash: string;
  readonly bytes: number;
  readonly contentType: string;
}

/** A cart's named references into the asset store. */
export interface CartAssets {
  /** Author-facing name to the asset it resolves to. */
  readonly entries: Readonly<Record<string, AssetRef>>;
}

export const EMPTY_CART_ASSETS: CartAssets = { entries: {} };

/** The object key for an asset. Flat and content-addressed: no cart in the path. */
export function assetKey(hash: string): string {
  return `assets/${hash}`;
}

export function isValidHash(value: unknown): value is string {
  return typeof value === "string" && HASH_PATTERN.test(value);
}

/**
 * Total bytes a manifest is responsible for, counting each distinct asset once.
 *
 * Two names pointing at the same hash are one stored object, so charging a cart
 * twice for it would be charging for storage nobody uses. This is the number a
 * model's budget is checked against.
 */
export function cartAssetBytes(assets: CartAssets): number {
  const seen = new Map<string, number>();
  for (const ref of Object.values(assets.entries)) {
    seen.set(ref.hash, ref.bytes);
  }
  let total = 0;
  for (const bytes of seen.values()) total += bytes;
  return total;
}

/** Every distinct asset a manifest references. */
export function cartAssetHashes(assets: CartAssets): string[] {
  return [...new Set(Object.values(assets.entries).map((ref) => ref.hash))];
}

function parseRef(raw: unknown): AssetRef | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (!isValidHash(record.hash)) return null;
  if (typeof record.bytes !== "number" || !Number.isInteger(record.bytes) || record.bytes <= 0) return null;
  if (record.bytes > MAX_ASSET_BYTES) return null;
  if (typeof record.contentType !== "string" || !ALLOWED_ASSET_TYPES.includes(record.contentType)) return null;
  return { hash: record.hash, bytes: record.bytes, contentType: record.contentType };
}

/** Whether a manifest key is safe to store and later put in a URL. */
export function isValidAssetName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.includes("..")) return false;
  return !UNSAFE_NAME.test(name);
}

/**
 * Parse a stored manifest, dropping anything malformed.
 *
 * Dropping rather than rejecting matches how every other sidecar behaves: a
 * cart with one bad entry still plays, missing that asset, instead of failing
 * to load at all. Returns null only when there is no manifest to speak of, so
 * callers can skip the asset path entirely.
 */
export function parseCartAssets(raw: unknown): CartAssets | null {
  if (raw == null) return null;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;

  const source = (parsed as { entries?: unknown }).entries;
  if (!source || typeof source !== "object") return null;

  const entries: Record<string, AssetRef> = {};
  for (const [name, value] of Object.entries(source as Record<string, unknown>)) {
    if (!isValidAssetName(name)) continue;
    const ref = parseRef(value);
    if (ref) entries[name] = ref;
  }
  return { entries };
}

export function serializeCartAssets(assets: CartAssets): string {
  return JSON.stringify({ entries: assets.entries });
}

export type AssetRejection =
  | { readonly reason: "name"; readonly name: string }
  | { readonly reason: "type"; readonly contentType: string }
  | { readonly reason: "empty" }
  | { readonly reason: "too-large"; readonly bytes: number; readonly limit: number }
  | { readonly reason: "over-budget"; readonly bytes: number; readonly budget: number };

/**
 * Whether one upload is acceptable for a model, given what the cart already
 * references.
 *
 * `budgetBytes` is the model's asset allowance (0 means the model takes no
 * assets at all — every cartridge-only model today). An asset already in the
 * manifest costs nothing to re-add, which is what makes re-saving a cart free
 * and keeps a creator from being charged twice for one stored object.
 */
export function checkAssetUpload(
  name: string,
  hash: string,
  bytes: number,
  contentType: string,
  assets: CartAssets,
  budgetBytes: number,
): AssetRejection | null {
  if (!isValidAssetName(name)) return { reason: "name", name };
  if (!ALLOWED_ASSET_TYPES.includes(contentType)) return { reason: "type", contentType };
  if (bytes <= 0) return { reason: "empty" };
  if (bytes > MAX_ASSET_BYTES) return { reason: "too-large", bytes, limit: MAX_ASSET_BYTES };

  // Already referenced: no new storage, so no new charge against the budget.
  if (cartAssetHashes(assets).includes(hash)) return null;

  const total = cartAssetBytes(assets) + bytes;
  if (total > budgetBytes) return { reason: "over-budget", bytes: total, budget: budgetBytes };
  return null;
}

/** Human-readable rejection, for an API response. */
export function describeRejection(rejection: AssetRejection): string {
  switch (rejection.reason) {
    case "name":
      return `Unsafe asset name: ${JSON.stringify(rejection.name)}`;
    case "type":
      return `Unsupported asset type: ${rejection.contentType}`;
    case "empty":
      return "Asset is empty";
    case "too-large":
      return `Asset is ${rejection.bytes} bytes, over the ${rejection.limit}-byte per-asset limit`;
    case "over-budget":
      return `Asset would bring this cart to ${rejection.bytes} bytes, over its ${rejection.budget}-byte budget`;
  }
}

/**
 * Whether a hash a client sent alongside its bytes agrees with those bytes.
 *
 * The hash is the storage key, so it is always recomputed server-side and this
 * is only a cross-check — but the check earns its place: a mismatch means one
 * side is confused about which bytes it holds, and silently correcting it would
 * store content under a key the client will never look up. Sending no hash at
 * all is fine; sending a wrong one is not.
 */
export function claimedHashAgrees(claimed: unknown, actual: string): boolean {
  if (claimed == null || claimed === "") return true; // not claimed, nothing to disagree with
  return isValidHash(claimed) && claimed === actual;
}

/** Add or replace one entry, returning a new manifest. */
export function withAsset(assets: CartAssets, name: string, ref: AssetRef): CartAssets {
  return { entries: { ...assets.entries, [name]: ref } };
}

/** Remove one entry by name, returning a new manifest. */
export function withoutAsset(assets: CartAssets, name: string): CartAssets {
  const entries = { ...assets.entries };
  delete entries[name];
  return { entries };
}

/*
 * UNREFERENCED ASSETS
 *
 * Nothing here deletes a blob. Because assets are shared across carts by hash,
 * "this cart stopped referencing it" does not mean "nobody references it", so
 * deleting on dereference would let one creator's edit break another creator's
 * published cart — a far worse failure than paying for an orphaned object.
 *
 * Reclaiming them is a mark-and-sweep over every live manifest, run offline,
 * with a grace period so an asset uploaded but not yet saved into a manifest is
 * not swept between those two steps. That is a background job, not a request
 * path, and it is deliberately not part of this change.
 */
