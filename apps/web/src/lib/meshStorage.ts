/**
 * Large mesh-sidecar offload to object storage (R2).
 *
 * A cart's mesh sidecar (see lib/meshSidecar.ts) is base64 geometry plus embedded
 * textures, and a single imported model can be several megabytes — far too big to
 * sit comfortably in the `carts.mesh` text column, where it bloats every row read
 * of the cart. This module keeps small sidecars inline (the common case) but
 * offloads large ones to R2, storing only a tiny reference in the column. Reads
 * resolve a reference back to the full sidecar so the rest of the app — the editor
 * loader, the play page, the runtime — never sees the difference.
 *
 * It degrades safely: when R2 is not configured (a local dev box or a deployment
 * whose credentials aren't to hand), or an upload fails, the sidecar is stored
 * inline exactly as before. So offload is an optimisation that can never block a
 * save, and a deployment without R2 keeps working.
 *
 * Server-only — the storage client uses secret credentials.
 */

import { putObject, publicUrl } from "./storage";

/**
 * Sidecars larger than this (UTF-8 bytes) offload to R2; smaller ones stay inline.
 * 512 KB comfortably covers hand-authored meshes and voxel exports while catching
 * the multi-megabyte imported models that don't belong in a DB column.
 */
export const MESH_INLINE_LIMIT = 512 * 1024;

/** The key under which a stored reference names its offloaded object. */
const REFERENCE_KEY = "$meshRef";

/** The R2 object key a cart's offloaded sidecar lives under. */
export function meshObjectKey(cartId: string): string {
  return `meshes/${cartId}.json`;
}

/** Serialise a reference to an offloaded sidecar (what gets stored in the column). */
export function buildMeshReference(objectKey: string): string {
  return JSON.stringify({ [REFERENCE_KEY]: objectKey });
}

/**
 * If `stored` is a reference to an offloaded sidecar, return its object key;
 * otherwise null (the value is an inline sidecar, or empty/malformed). A real
 * sidecar is `{version, meshes}` and never carries the reference key, so the two
 * are unambiguous.
 */
export function parseMeshReference(stored: string | null | undefined): string | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const key = (parsed as Record<string, unknown>)[REFERENCE_KEY];
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Whether an encoded sidecar is large enough to warrant offloading. */
export function shouldOffload(encoded: string): boolean {
  return Buffer.byteLength(encoded, "utf8") > MESH_INLINE_LIMIT;
}

/** Whether the R2 credentials needed to offload/resolve are all present. */
export function isObjectStorageConfigured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT &&
      process.env.R2_BUCKET &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_PUBLIC_BASE_URL,
  );
}

/**
 * Decide how to persist a cart's encoded sidecar and return the value to write
 * into `carts.mesh`: null to clear, the inline string for small sidecars (or when
 * R2 is unavailable), or a small reference after offloading a large one to R2.
 *
 * Never throws for storage reasons: an upload failure falls back to inline, so a
 * creator's Save always succeeds.
 */
export async function storeMeshSidecar(cartId: string, encoded: string | null): Promise<string | null> {
  if (!encoded) return null;
  if (!shouldOffload(encoded) || !isObjectStorageConfigured()) return encoded;
  try {
    const key = meshObjectKey(cartId);
    await putObject(key, new TextEncoder().encode(encoded), "application/json");
    return buildMeshReference(key);
  } catch (error) {
    console.error(`mesh offload to R2 failed for cart ${cartId}; storing inline`, error);
    return encoded;
  }
}

/**
 * Resolve a stored `carts.mesh` value into the full sidecar string the client
 * consumes: pass an inline sidecar through unchanged, or fetch an offloaded one
 * back from R2. Returns null on a missing/failed fetch so the cart simply plays
 * without meshes rather than erroring.
 */
export async function resolveMeshSidecar(stored: string | null | undefined): Promise<string | null> {
  if (!stored) return null;
  const key = parseMeshReference(stored);
  if (!key) return stored; // an inline sidecar
  try {
    const response = await fetch(publicUrl(key), { cache: "no-store" });
    if (!response.ok) {
      console.error(`mesh resolve from R2 failed (${response.status}) for key ${key}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    console.error(`mesh resolve from R2 threw for key ${key}`, error);
    return null;
  }
}
