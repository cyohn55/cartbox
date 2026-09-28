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

import { effectiveLevels, readLevels, readStreaming } from "@cartbox/editor";

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

/** The material fields that hold an image in a serialized mesh. */
const IMAGE_FIELDS = ["image", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "detailImage"] as const;

type Payload = { primitives?: { material?: Record<string, unknown> }[] };

type SidecarRoot = {
  meshes?: { mesh?: unknown; frames?: unknown }[];
  library?: Record<string, unknown>;
  prefabs?: { nodes?: { mesh?: unknown; frames?: unknown }[] }[];
};

/** One image in place: the object itself and where it sits, so it can be rewritten or dropped. */
interface ImageSlot {
  readonly image: Record<string, unknown>;
  readonly material: Record<string, unknown>;
  readonly field: (typeof IMAGE_FIELDS)[number];
}

/** A parsed payload's images, and a way to serialize the payload back once they're rewritten. */
interface Walked {
  readonly images: ImageSlot[];
  serialize(): string;
}

function imagesOfMesh(payload: Payload, into: ImageSlot[]): void {
  for (const primitive of payload.primitives ?? []) {
    const material = primitive?.material;
    if (!material || typeof material !== "object") continue;
    for (const field of IMAGE_FIELDS) {
      const image = material[field];
      if (image && typeof image === "object") into.push({ image: image as Record<string, unknown>, material, field });
    }
  }
}

/**
 * Walk a payload's images: either one serialized mesh, or a whole mesh sidecar
 * (`{version, meshes, library?, prefabs?}`), whose meshes are serialized strings
 * inside it — in `meshes[].mesh`/`frames`, the shared `library`, and prefab
 * nodes (`@lib:` references are skipped; the library holds the mesh itself).
 */
function imagesIn(encoded: string): Walked | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const images: ImageSlot[] = [];
  if (Array.isArray((parsed as Payload).primitives)) {
    const payload = parsed as Payload;
    imagesOfMesh(payload, images);
    return { images, serialize: () => JSON.stringify(payload) };
  }
  const root = parsed as SidecarRoot;
  if (!Array.isArray(root.meshes)) return null;
  // Each mesh string is parsed once; `serialize` writes every one back.
  const meshes: { payload: Payload; write: (value: string) => void }[] = [];
  const visit = (value: unknown, write: (value: string) => void) => {
    if (typeof value !== "string" || value.startsWith("@lib:")) return;
    try {
      const payload = JSON.parse(value) as Payload;
      if (!payload || !Array.isArray(payload.primitives)) return;
      imagesOfMesh(payload, images);
      meshes.push({ payload, write });
    } catch {
      // An unreadable mesh is left exactly as it is.
    }
  };
  const holder = (h: { mesh?: unknown; frames?: unknown }) => {
    visit(h.mesh, (v) => (h.mesh = v));
    if (Array.isArray(h.frames)) {
      const frames = h.frames as unknown[];
      frames.forEach((f, i) => visit(f, (v) => (frames[i] = v)));
    }
  };
  for (const entry of root.meshes) holder(entry);
  const library = root.library;
  if (library && typeof library === "object") for (const key of Object.keys(library)) visit(library[key], (v) => (library[key] = v));
  for (const prefab of root.prefabs ?? []) for (const node of prefab.nodes ?? []) holder(node);
  return {
    images,
    serialize: () => {
      for (const mesh of meshes) mesh.write(JSON.stringify(mesh.payload));
      return JSON.stringify(root);
    },
  };
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

  for (const { image } of walked.images) {
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

  return { encoded: changed ? walked.serialize() : encoded, textures };
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

  for (const slot of walked.images) {
    const image = slot.image;
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
  for (const { image, material, field } of walked.images) {
    if (image.bytes === undefined && image.same === undefined) material[field] = null;
  }
  return walked.serialize();
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

/**
 * The distinct asset-backed textures a stored payload references (a mesh or a
 * whole sidecar), in first-seen order: what a player streams after the cart
 * starts (see textureStream.ts).
 */
export function meshTextureRefs(encoded: string | null): { hash: string; mime: string }[] {
  const walked = encoded ? imagesIn(encoded) : null;
  if (!walked) return [];
  const seen = new Map<string, string>();
  for (const { image } of walked.images) {
    if (typeof image.asset === "string" && !seen.has(image.asset)) seen.set(image.asset, typeof image.mime === "string" ? image.mime : "image/png");
  }
  return [...seen].map(([hash, mime]) => ({ hash, mime }));
}

/**
 * Which levels need each asset-backed texture (see levels.ts in @cartbox/editor):
 * hash → the level ids of the objects that use it, or null when something
 * always loaded (or in the start level) does — those stream at start, the rest
 * when their level is switched to.
 */
export function meshTextureLevels(encoded: string | null): Map<string, readonly string[] | null> {
  const out = new Map<string, string[] | null>();
  if (!encoded) return out;
  let root: { meshes?: { id?: unknown; mesh?: unknown; frames?: unknown; parent?: unknown; level?: unknown }[]; library?: Record<string, unknown>; levels?: unknown; prefabs?: { nodes?: { mesh?: unknown; frames?: unknown }[] }[] };
  try {
    root = JSON.parse(encoded);
  } catch {
    return out;
  }
  if (!root || !Array.isArray(root.meshes)) return out;
  const levels = readLevels(root.levels);
  const library = root.library ?? {};
  const resolve = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    if (value.startsWith("@lib:")) return typeof library[value.slice(5)] === "string" ? (library[value.slice(5)] as string) : null;
    return value;
  };
  const hashesOf = (holder: { mesh?: unknown; frames?: unknown }): string[] => {
    const serialized = [holder.mesh, ...(Array.isArray(holder.frames) ? holder.frames : [])].map(resolve).filter((m): m is string => m !== null);
    return serialized.flatMap((m) => meshTextureRefs(m).map((r) => r.hash));
  };
  const note = (hash: string, level: string | null) => {
    const seen = out.get(hash);
    if (level === null || seen === null) out.set(hash, null);
    else out.set(hash, seen ? (seen.includes(level) ? seen : [...seen, level]) : [level]);
  };
  const ids = root.meshes.map((m) => (typeof m.id === "string" ? m.id : ""));
  const parents = root.meshes.map((m) => (typeof m.parent === "string" ? ids.indexOf(m.parent) : -1));
  const effective = effectiveLevels(
    root.meshes.map((m) => (typeof m.level === "string" ? m.level : undefined)),
    parents,
    levels,
  );
  root.meshes.forEach((entry, i) => {
    const level = effective[i]!;
    // Always loaded, or in the level the cart starts in: needed at start.
    const tag = level <= 0 ? null : levels[level]!.id;
    for (const hash of hashesOf(entry)) note(hash, tag);
  });
  for (const prefab of root.prefabs ?? []) for (const node of prefab.nodes ?? []) for (const hash of hashesOf(node)) note(hash, null);
  return out;
}

/**
 * With spatial loading on (see streaming.ts in @cartbox/editor), which
 * spatially loaded objects need each asset-backed texture: hash → the ids of
 * the root objects (whose groups load by distance) that use it, or null when
 * something else — an always-loaded object, a level, a prefab — does. Those
 * with ids stream as the focus approaches one of them. Empty without streaming.
 */
export function meshTextureObjects(encoded: string | null): Map<string, readonly string[] | null> {
  const out = new Map<string, string[] | null>();
  if (!encoded) return out;
  let root: { meshes?: { id?: unknown; mesh?: unknown; frames?: unknown; parent?: unknown; level?: unknown; alwaysLoaded?: unknown }[]; library?: Record<string, unknown>; streaming?: unknown; prefabs?: { nodes?: { mesh?: unknown; frames?: unknown }[] }[] };
  try {
    root = JSON.parse(encoded);
  } catch {
    return out;
  }
  if (!root || !Array.isArray(root.meshes) || !readStreaming(root.streaming)) return out;
  const library = root.library ?? {};
  const resolve = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    if (value.startsWith("@lib:")) return typeof library[value.slice(5)] === "string" ? (library[value.slice(5)] as string) : null;
    return value;
  };
  const hashesOf = (holder: { mesh?: unknown; frames?: unknown }): string[] => {
    const serialized = [holder.mesh, ...(Array.isArray(holder.frames) ? holder.frames : [])].map(resolve).filter((m): m is string => m !== null);
    return serialized.flatMap((m) => meshTextureRefs(m).map((r) => r.hash));
  };
  const note = (hash: string, object: string | null) => {
    const seen = out.get(hash);
    if (object === null || seen === null) out.set(hash, null);
    else out.set(hash, seen ? (seen.includes(object) ? seen : [...seen, object]) : [object]);
  };
  const meshes = root.meshes;
  const ids = meshes.map((m) => (typeof m.id === "string" ? m.id : ""));
  const parentOf = (i: number) => (typeof meshes[i]!.parent === "string" ? ids.indexOf(meshes[i]!.parent as string) : -1);
  meshes.forEach((entry, i) => {
    // The group it loads with: its top ancestor (a loop leaves it its own).
    let top = i;
    let inLevel = typeof entry.level === "string" && entry.level !== "";
    for (let guard = 0; parentOf(top) >= 0 && guard < meshes.length; guard += 1) {
      top = parentOf(top);
      if (typeof meshes[top]!.level === "string" && meshes[top]!.level !== "") inLevel = true;
    }
    const spatial = !inLevel && meshes[top]!.alwaysLoaded !== true;
    for (const hash of hashesOf(entry)) note(hash, spatial ? ids[top]! : null);
  });
  for (const prefab of root.prefabs ?? []) for (const node of prefab.nodes ?? []) for (const hash of hashesOf(node)) note(hash, null);
  return out;
}
