/**
 * The half of the cart asset store that reaches storage.
 *
 * `cartAssetStore.ts` is pure: hashing, manifests, budgets, validation. This
 * one talks to R2 and Postgres, and is server-only.
 *
 * The write path is deliberately ordered **blob first, row second, manifest
 * third**, because each failure between steps has to leave something
 * recoverable rather than something broken:
 *
 * 1. Put the object. If this fails, nothing has changed.
 * 2. Insert the `cart_assets` row. If this fails, an object exists that no row
 *    describes — invisible, costs storage, swept later. Harmless.
 * 3. The caller saves the manifest. If that fails, an asset exists that no cart
 *    references — the same harmless state.
 *
 * The order that would be wrong is manifest-first: a cart would reference an
 * asset that does not exist, and the missing texture is visible to players.
 * Orphaned bytes are a bill; a dangling reference is a bug.
 */

import { assetKey, isValidHash, type AssetRef } from "./cartAssetStore";
import { putObject, publicUrl } from "./storage";
import { serviceClient } from "./supabase";

/** Postgres unique-violation. An asset that already exists is success, not error. */
const UNIQUE_VIOLATION = "23505";
/** Postgres undefined-table, for a deployment without migration 0024 yet. */
const UNDEFINED_TABLE = "42P01";

export interface StoreAssetResult {
  readonly ref: AssetRef;
  /** False when this content was already stored, so nothing was uploaded. */
  readonly uploaded: boolean;
}

/**
 * Store one asset, or recognise that it is already stored.
 *
 * Idempotent by construction: the key is the content hash, so re-storing the
 * same bytes writes the same object and hits a unique violation on the row,
 * both of which are success. That is what makes re-saving a cart cheap.
 */
export async function storeCartAsset(
  hash: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<StoreAssetResult> {
  const ref: AssetRef = { hash, bytes: bytes.length, contentType };
  const existing = await findCartAsset(hash);
  if (existing) return { ref: existing, uploaded: false };

  await putObject(assetKey(hash), bytes, contentType);

  const { error } = await serviceClient()
    .from("cart_assets")
    .insert({ hash, bytes: bytes.length, content_type: contentType });

  // A concurrent upload of identical bytes wrote the same row first. Both
  // uploads produced the same object, so there is nothing to reconcile.
  if (error && error.code !== UNIQUE_VIOLATION) {
    if (error.code === UNDEFINED_TABLE) {
      throw new Error("Asset storage is not available: migration 0024 has not been applied");
    }
    throw new Error(error.message);
  }
  return { ref, uploaded: true };
}

/** Look up a stored asset by hash, or null when it is not stored. */
export async function findCartAsset(hash: string): Promise<AssetRef | null> {
  if (!isValidHash(hash)) return null;

  const { data, error } = await serviceClient()
    .from("cart_assets")
    .select("hash, bytes, content_type")
    .eq("hash", hash)
    .maybeSingle();

  // A deployment without the migration has no assets, which is a truthful
  // answer rather than an error: the caller then uploads, and *that* fails
  // loudly with something actionable.
  if (error) return null;
  if (!data) return null;
  return { hash: data.hash as string, bytes: data.bytes as number, contentType: data.content_type as string };
}

/**
 * The public URL for an asset.
 *
 * Content-addressed and immutable, so this is safe to cache indefinitely —
 * the bytes behind a hash can never change.
 */
export function cartAssetUrl(ref: AssetRef): string {
  return publicUrl(assetKey(ref.hash));
}
