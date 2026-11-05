/**
 * The mesh sidecar's meshes as binary packages (AAA_PRODUCTION_ROADMAP.md D4).
 *
 * A stored mesh sidecar holds each mesh as a JSON string of base64 streams:
 * a third larger than the bytes, parsed whole, and copied into every remix's
 * row. On save, each mesh of any size moves into the cart asset store as a
 * `.cbpk` package (F9e's format, cartPackage.ts in @cartbox/editor, with the
 * geometry squeezed by meshoptimizer's codecs), and the sidecar keeps a
 * reference in its place:
 *
 * ```
 *   "mesh": "{\"version\":1,\"primitives\":[…]}"   // as authored
 *   "mesh": "@pkg:<sha-256>"                         // as stored
 * ```
 *
 * On load the references are put back as the JSON every reader already
 * understands, so nothing downstream knows. A sidecar saved before this (inline
 * JSON) reads exactly as it did; so does a mesh this can't package.
 *
 * Runs after the texture offload (meshTextureAssets.ts): by then a mesh's
 * images are asset references, which the package keeps as refs (its bytes are
 * the geometry), and on the way out they become asset references again, for
 * the texture inlining or streaming that follows.
 *
 * Packages are filed in the cart's manifest under the same `mesh-<hash>` name
 * as offloaded textures, so the sweep that reclaims unreferenced assets sees
 * them. Pure and isomorphic: hashing, fetching and the codec are injected.
 */

import { deserializeMeshAsset, packMeshAsset, serializeMeshAsset, unpackMeshAsset, type MeshoptCodec } from "@cartbox/editor";

import type { ExtractedTexture } from "./meshTextureAssets";

/** A stored mesh string that names a package in the cart asset store. */
export const PACKAGE_PREFIX = "@pkg:";
/** The asset store's content type for a package. */
export const PACKAGE_MIME = "application/vnd.cartbox.package";
/** Meshes whose JSON is shorter than this stay inline: a request costs more than they save. */
export const MIN_PACKAGED_CHARS = 4096;

/** The package a stored mesh string names, or null. */
export function packageRef(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(PACKAGE_PREFIX) ? value.slice(PACKAGE_PREFIX.length) : null;
}

/** meshoptimizer's codecs, or null where they won't load (packages are then stored raw). */
export async function loadMeshoptCodec(): Promise<MeshoptCodec | null> {
  try {
    const { MeshoptEncoder, MeshoptDecoder } = await import("meshoptimizer");
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;
    return {
      encodeVertexBuffer: (s, c, z) => MeshoptEncoder.encodeVertexBuffer(s, c, z),
      encodeIndexBuffer: (s, c, z) => MeshoptEncoder.encodeIndexBuffer(s, c, z),
      decodeVertexBuffer: (t, c, z, s) => MeshoptDecoder.decodeVertexBuffer(t, c, z, s),
      decodeIndexBuffer: (t, c, z, s) => MeshoptDecoder.decodeIndexBuffer(t, c, z, s),
    };
  } catch {
    return null;
  }
}

type Holder = { mesh?: unknown; frames?: unknown; lods?: unknown };
export type SidecarRoot = { meshes?: Holder[]; library?: Record<string, unknown>; prefabs?: { nodes?: Holder[] }[] };

/** Every mesh string slot of a sidecar: entries' meshes, frames and LOD levels, the library, prefab nodes. */
export function meshSlots(root: SidecarRoot): { value: unknown; write: (value: string) => void }[] {
  const slots: { value: unknown; write: (value: string) => void }[] = [];
  const holder = (h: Holder) => {
    slots.push({ value: h.mesh, write: (v) => (h.mesh = v) });
    if (Array.isArray(h.frames)) {
      const frames = h.frames as unknown[];
      frames.forEach((f, i) => slots.push({ value: f, write: (v) => (frames[i] = v) }));
    }
    const lods = h.lods as { levels?: unknown } | undefined;
    if (lods && Array.isArray(lods.levels)) {
      const levels = lods.levels as unknown[];
      levels.forEach((l, i) => slots.push({ value: l, write: (v) => (levels[i] = v) }));
    }
  };
  for (const entry of root.meshes ?? []) if (entry && typeof entry === "object") holder(entry);
  const library = root.library;
  if (library && typeof library === "object") for (const key of Object.keys(library)) slots.push({ value: library[key], write: (v) => (library[key] = v) });
  for (const prefab of root.prefabs ?? []) for (const node of prefab?.nodes ?? []) if (node && typeof node === "object") holder(node);
  return slots;
}

export function parseSidecar(encoded: string): SidecarRoot | null {
  try {
    const root = JSON.parse(encoded) as SidecarRoot;
    return root && typeof root === "object" && Array.isArray(root.meshes) ? root : null;
  } catch {
    return null;
  }
}

export interface PackageExtractResult {
  /** The sidecar with each packaged mesh replaced by its reference. */
  readonly encoded: string;
  /** The distinct packages to store, in first-seen order (shaped as the texture offload's, for the manifest). */
  readonly packages: readonly ExtractedTexture[];
}

/**
 * Move a sidecar's meshes into packages. A mesh that won't deserialize, is
 * already a reference (`@lib:`, `@pkg:`), or is under `minChars` stays as it
 * is; a sidecar with nothing to package comes back unchanged.
 */
export async function extractMeshPackages(
  encoded: string,
  hash: (bytes: Uint8Array) => Promise<string>,
  codec: MeshoptCodec | null,
  minChars = MIN_PACKAGED_CHARS,
): Promise<PackageExtractResult> {
  const root = parseSidecar(encoded);
  if (!root) return { encoded, packages: [] };
  const packages: ExtractedTexture[] = [];
  const done = new Map<string, string | null>();
  let changed = false;
  for (const slot of meshSlots(root)) {
    const value = slot.value;
    if (typeof value !== "string" || value.startsWith("@") || value.length < minChars) continue;
    let ref = done.get(value);
    if (ref === undefined) {
      ref = null;
      try {
        const bytes = packMeshAsset(deserializeMeshAsset(value), codec);
        const digest = await hash(bytes);
        if (!packages.some((p) => p.hash === digest)) packages.push({ hash: digest, mime: PACKAGE_MIME, bytes });
        ref = `${PACKAGE_PREFIX}${digest}`;
      } catch {
        // A mesh the codec can't take is left inline, as it was.
      }
      done.set(value, ref);
    }
    if (ref) {
      slot.write(ref);
      changed = true;
    }
  }
  return { encoded: changed ? JSON.stringify(root) : encoded, packages };
}

/** Turn a re-serialized mesh's asset-backed images (bytes elsewhere, a ref) back into the stored `asset` form. */
function refsToAssets(json: string): string {
  const payload = JSON.parse(json) as { primitives?: { material?: Record<string, unknown> }[]; variants?: { materials?: (Record<string, unknown> | null)[] }[] };
  let changed = false;
  const visit = (material: Record<string, unknown> | null | undefined) => {
    if (!material) return;
    for (const value of Object.values(material)) {
      const image = value as Record<string, unknown> | null;
      if (!image || typeof image !== "object" || typeof image.ref !== "string" || (typeof image.bytes === "string" && image.bytes.length > 0)) continue;
      image.asset = image.ref;
      delete image.ref;
      delete image.bytes;
      changed = true;
    }
  };
  for (const p of payload.primitives ?? []) visit(p.material);
  for (const v of payload.variants ?? []) for (const m of v.materials ?? []) visit(m);
  return changed ? JSON.stringify(payload) : json;
}

/**
 * Put packaged meshes back as JSON. A package that can't be fetched or read
 * leaves its reference, which the sidecar's reader drops as an invalid mesh:
 * a missing package costs its objects, never the cart.
 */
export async function inlineMeshPackages(
  encoded: string,
  fetchAsset: (hash: string) => Promise<Uint8Array | null>,
  codec: MeshoptCodec | null,
): Promise<string> {
  if (!encoded.includes(PACKAGE_PREFIX)) return encoded;
  const root = parseSidecar(encoded);
  if (!root) return encoded;
  const done = new Map<string, string | null>();
  let changed = false;
  for (const slot of meshSlots(root)) {
    const ref = packageRef(slot.value);
    if (!ref) continue;
    let json = done.get(ref);
    if (json === undefined) {
      json = null;
      try {
        const bytes = await fetchAsset(ref);
        // `cook` keeps a generator's cooked maps (D5) with their recipe, as they were stored.
        if (bytes) json = refsToAssets(serializeMeshAsset(unpackMeshAsset(bytes, codec), { cook: true }));
      } catch {
        // Left as a reference.
      }
      done.set(ref, json);
    }
    if (json) {
      slot.write(json);
      changed = true;
    }
  }
  return changed ? JSON.stringify(root) : encoded;
}

/** The packages a stored sidecar references, for the manifest and the sweep. */
export function meshPackageRefs(encoded: string | null): string[] {
  const root = encoded && encoded.includes(PACKAGE_PREFIX) ? parseSidecar(encoded) : null;
  if (!root) return [];
  return [...new Set(meshSlots(root).map((s) => packageRef(s.value)).filter((r): r is string => r !== null))];
}
