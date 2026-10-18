/**
 * A map's textures baked to KTX2 (AAA_FIDELITY_ROADMAP.md F1a): `npm run
 * bake:map <id> textures` encodes each image of the map's sidecar once, with
 * its mip chain, into a generated table keyed by the image's bytes. When the
 * sidecar is built, {@link withCompressedImages} gives each image found in the
 * table its KTX2 beside its PNG (`ktx2`, see EncodedImage). A renderer that
 * samples the GPU's own compressed formats decodes that; every other path, and
 * every fantasy tier, still decodes the PNG, so the map looks as it did.
 *
 * An entry is `""` for an image the bake chose to leave as it is: a cut-out's
 * colour map, whose mips keep their coverage only on the RGBA path.
 *
 * An occlusion map with a relief map beside it is packed with it at load (I4:
 * occlusion in R, the relief in G, B and A), so the bake compresses the pair
 * packed, under the pair's key ({@link pairKey}); the occlusion image carries
 * that KTX2, marked `ktx2Relief`, and decodes straight to the packed texture.
 */

/** A baked table: image key → KTX2 bytes (base64), or `""` for an image left uncompressed. */
export type CompressedImageTable = Readonly<Record<string, string>>;

/** How a baked image is encoded: a colour (sRGB), a light map (linear colour), data, or a normal map. */
export type CompressedImageKind = "color" | "light" | "data" | "normal";

/** One image a map's sidecar holds, as the bake sees it. */
export interface SidecarImage {
  readonly key: string;
  /** The image's bytes, base64, as stored. */
  readonly base64: string;
  readonly mime: string;
  readonly kind: CompressedImageKind;
  /** One of an occlusion and relief pair: compressed only as the pair (see {@link SidecarPair}). */
  readonly packed: boolean;
}

/** An occlusion map and the relief map packed beside it at load, which the bake compresses packed. */
export interface SidecarPair {
  readonly key: string;
  /** The occlusion image's bytes (base64), or null for a relief without one (its R is then white). */
  readonly occlusion: string | null;
  readonly relief: string;
}

/** A packed occlusion-and-relief pair's key: the two images' keys. */
export function pairKey(occlusion: string | null, relief: string): string {
  return `${occlusion ? imageKey(occlusion) : "none"}+${imageKey(relief)}`;
}

/** An image's key: FNV-1a of its stored base64, with its length (no decode needed). */
export function imageKey(base64: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < base64.length; i += 1) {
    hash ^= base64.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${base64.length}`;
}

/** Which kind each material image field is. Fields not named here (a tint mask) aren't compressed. */
const FIELD_KINDS: Readonly<Record<string, CompressedImageKind>> = {
  image: "color",
  emissiveImage: "color",
  blendImage: "color",
  lightmapImage: "light",
  metallicRoughnessImage: "data",
  occlusionImage: "data",
  reliefImage: "data",
  materialImage: "data",
  detailImage: "data",
  normalImage: "normal",
};

/**
 * Walk a sidecar's JSON, nested mesh payloads (stored as JSON strings) included,
 * calling `visit` on every material holding images. `visit` may change the
 * material in place; the walk returns the JSON with every change.
 */
function walkMaterials(json: string, visit: (material: Record<string, unknown>) => void): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.length > 2 && value[0] === "{" && value.includes('"primitives"')) {
        try {
          return JSON.stringify(walk(JSON.parse(value)));
        } catch {
          return value;
        }
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    for (const [k, v] of Object.entries(record)) record[k] = walk(v);
    if (Object.keys(FIELD_KINDS).some((field) => isImage(record[field]))) visit(record);
    return record;
  };
  return JSON.stringify(walk(JSON.parse(json)));
}

function isImage(value: unknown): value is { mime: string; bytes: string; ktx2?: string } {
  return !!value && typeof value === "object" && typeof (value as { bytes?: unknown }).bytes === "string" && ((value as { bytes: string }).bytes.length > 0);
}

/** Every distinct occlusion-and-relief pair a map's sidecar packs at load. */
export function sidecarPairs(json: string): SidecarPair[] {
  const found = new Map<string, SidecarPair>();
  walkMaterials(json, (material) => {
    if (!isImage(material.reliefImage)) return;
    const occlusion = isImage(material.occlusionImage) ? material.occlusionImage.bytes : null;
    const key = pairKey(occlusion, material.reliefImage.bytes);
    if (!found.has(key)) found.set(key, { key, occlusion, relief: material.reliefImage.bytes });
  });
  return [...found.values()];
}

/** Every distinct image a map's sidecar holds, with how the bake should treat it. */
export function sidecarImages(json: string): SidecarImage[] {
  const found = new Map<string, SidecarImage>();
  walkMaterials(json, (material) => {
    const packed = isImage(material.reliefImage);
    for (const [field, kind] of Object.entries(FIELD_KINDS)) {
      const image = material[field];
      if (!isImage(image)) continue;
      const key = imageKey(image.bytes);
      if (!found.has(key)) found.set(key, { key, base64: image.bytes, mime: image.mime, kind, packed: packed && (field === "occlusionImage" || field === "reliefImage") });
    }
  });
  return [...found.values()];
}

/** The sidecar with each image the table has a KTX2 for carrying it (`ktx2`, base64) beside its own bytes. */
export function withCompressedImages(json: string, table: CompressedImageTable): string {
  if (Object.keys(table).length === 0) return json;
  return walkMaterials(json, (material) => {
    for (const field of Object.keys(FIELD_KINDS)) {
      const image = material[field];
      if (!isImage(image)) continue;
      const ktx2 = table[imageKey(image.bytes)];
      if (ktx2) image.ktx2 = ktx2;
    }
    // An occlusion map packed with its relief: the occlusion carries the pair, packed.
    if (isImage(material.reliefImage) && isImage(material.occlusionImage)) {
      const packed = table[pairKey(material.occlusionImage.bytes, material.reliefImage.bytes)];
      if (packed) Object.assign(material.occlusionImage, { ktx2: packed, ktx2Relief: true });
    }
  });
}

/**
 * Whether a stored table fits a sidecar: an entry for every image it holds, and
 * none for an image it no longer does.
 */
export function compressedImagesCurrent(json: string, table: CompressedImageTable): boolean {
  const keys = new Set([...sidecarImages(json).map((image) => image.key), ...sidecarPairs(json).map((pair) => pair.key)]);
  return keys.size === Object.keys(table).length && [...keys].every((key) => key in table);
}
