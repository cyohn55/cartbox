/**
 * Moving mesh textures out of the mesh sidecar and into the cart asset store.
 *
 * `serializeMeshAsset` base64-encodes every base-colour texture *into* the
 * sidecar JSON. That is the bloat the asset store exists to remove: a 1MB PNG
 * becomes ~1.33MB of base64 inside a database column, it is re-sent on every
 * read and write, and fifty remixes of one cart store fifty copies of the same
 * texture.
 *
 * This rewrites the stored payload so each image becomes a reference:
 *
 * ```
 *   { "mime": "image/png", "bytes": "<base64>" }   // as authored
 *   { "mime": "image/png", "asset": "<sha-256>" }  // as stored
 * ```
 *
 * and puts the bytes back on the way out, so nothing downstream —
 * `deserializeMeshAsset`, either renderer, the editor — knows this happened.
 * Old carts with inline bytes keep working untouched, which is what makes this
 * safe to deploy before anything has been migrated.
 *
 * ## Two decisions worth knowing
 *
 * **Offloaded textures are recorded in the cart's asset manifest**, under a
 * deterministic `mesh-<hash>` name. They could have been left referenced only
 * from inside the mesh JSON, but then the manifest would not be a complete
 * picture of what a cart uses — and the sweep that eventually reclaims
 * unreferenced assets marks from manifests, so it would delete textures that
 * are very much in use. One manifest as the single source of truth for "what
 * this cart references" is the invariant worth protecting.
 *
 * **This path does not check the model's asset budget.** The budget bounds how
 * much a cart may *carry*; offloading changes where existing content lives, not
 * how much there is. Charging for it would mean a cart could fail to save
 * merely because we chose to store it more efficiently — and would make every
 * cartridge-only model (budget 0) unable to save a textured mesh it could
 * already save yesterday.
 *
 * Pure and isomorphic: hashing and fetching are injected.
 */

import { serializeCartAssets, type AssetRef, type CartAssets } from "./cartAssetStore";

/** The deterministic manifest name an offloaded mesh texture is filed under. */
export function meshTextureName(hash: string): string {
  return `mesh-${hash}`;
}

/** One texture lifted out of a mesh payload, ready to store. */
export interface ExtractedTexture {
  readonly hash: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface ExtractResult {
  /** The payload with every inline image replaced by a reference. */
  readonly encoded: string;
  /** Distinct textures the payload referenced, in first-seen order. */
  readonly textures: readonly ExtractedTexture[];
}

/** Decode standard base64 to bytes, isomorphically. */
function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Encode bytes to standard base64, isomorphically. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunked: spreading a multi-megabyte array into String.fromCharCode blows
  // the argument limit, which is exactly the size of texture this path exists for.
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

type Payload = { primitives?: { material?: { image?: unknown } }[] };

/**
 * Walk a serialized mesh's images. Returns the parsed payload and the image
 * objects in place, so a caller can rewrite them without re-walking.
 */
function imagesIn(encoded: string): { payload: Payload; images: Record<string, unknown>[] } | null {
  let payload: Payload;
  try {
    payload = JSON.parse(encoded) as Payload;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray(payload.primitives)) return null;

  const images: Record<string, unknown>[] = [];
  for (const primitive of payload.primitives) {
    const image = primitive?.material?.image;
    if (image && typeof image === "object") images.push(image as Record<string, unknown>);
  }
  return { payload, images };
}

/**
 * Replace inline texture bytes with content hashes.
 *
 * A payload that is unparseable, has no images, or is already fully offloaded
 * comes back unchanged with no textures — so callers can run this
 * unconditionally and pay nothing when there is nothing to do.
 */
export async function extractMeshTextures(
  encoded: string,
  hash: (bytes: Uint8Array) => Promise<string>,
): Promise<ExtractResult> {
  const walked = imagesIn(encoded);
  if (!walked) return { encoded, textures: [] };

  const textures: ExtractedTexture[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const image of walked.images) {
    if (typeof image.bytes !== "string" || typeof image.mime !== "string") continue;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(image.bytes);
    } catch {
      continue; // Malformed base64: leave it alone rather than lose the entry.
    }
    if (bytes.length === 0) continue;

    const digest = await hash(bytes);
    if (!seen.has(digest)) {
      seen.add(digest);
      textures.push({ hash: digest, mime: image.mime, bytes });
    }
    delete image.bytes;
    image.asset = digest;
    changed = true;
  }

  return { encoded: changed ? JSON.stringify(walked.payload) : encoded, textures };
}

/**
 * Put texture bytes back, turning references into the inline form every
 * downstream consumer already understands.
 *
 * A reference that cannot be fetched is dropped to an untextured material
 * rather than failing the mesh: a missing texture costs its surface's colour,
 * where a thrown error costs the whole cart.
 */
export async function inlineMeshTextures(
  encoded: string,
  fetchAsset: (hash: string) => Promise<Uint8Array | null>,
): Promise<string> {
  const walked = imagesIn(encoded);
  if (!walked) return encoded;

  let changed = false;
  const cache = new Map<string, Uint8Array | null>();

  for (const image of walked.images) {
    const reference = image.asset;
    if (typeof reference !== "string") continue;

    if (!cache.has(reference)) {
      try {
        cache.set(reference, await fetchAsset(reference));
      } catch {
        cache.set(reference, null);
      }
    }
    const bytes = cache.get(reference) ?? null;

    delete image.asset;
    if (bytes && bytes.length > 0) {
      image.bytes = bytesToBase64(bytes);
    } else {
      // `deserializeMeshAsset` treats a null image as an untextured material.
      image.mime = undefined;
      image.bytes = undefined;
    }
    changed = true;
  }

  if (!changed) return encoded;

  // A material whose image lost both fields becomes null, which is the shape
  // the deserializer expects for "no texture".
  for (const primitive of walked.payload.primitives ?? []) {
    const image = primitive?.material?.image as Record<string, unknown> | undefined;
    if (image && image.bytes === undefined) primitive.material!.image = null;
  }
  return JSON.stringify(walked.payload);
}

/** Record offloaded textures in a cart's manifest, so nothing sweeps them away. */
export function withMeshTextures(assets: CartAssets, textures: readonly ExtractedTexture[]): CartAssets {
  if (textures.length === 0) return assets;
  const entries = { ...assets.entries };
  for (const texture of textures) {
    const ref: AssetRef = { hash: texture.hash, bytes: texture.bytes.length, contentType: texture.mime };
    entries[meshTextureName(texture.hash)] = ref;
  }
  return { entries };
}

/** Convenience for the write path: the manifest JSON to store, or null if unchanged. */
export function manifestUpdate(
  assets: CartAssets,
  textures: readonly ExtractedTexture[],
): string | null {
  const next = withMeshTextures(assets, textures);
  return next === assets ? null : serializeCartAssets(next);
}
