/**
 * When a scene keeps KTX2 textures (ENGINE_ROADMAP.md, Phase 4).
 *
 * KTX2 (Basis Universal) textures are usually far smaller than PNG, but a player
 * can only show them after fetching the transcoder (~250 KB gzipped, once per
 * scene). So KTX2 only pays when it saves more than that:
 *
 * - When a model with KTX2 textures is imported, each texture is transcoded and
 *   re-encoded as PNG, and both forms are measured as they'd travel (gzipped).
 * - If the scene already keeps KTX2 textures, the transcoder is already paid
 *   for: KTX2 stays whenever it is the smaller form.
 * - Otherwise KTX2 stays only if the saving exceeds the transcoder's own size;
 *   below that the textures become PNG, and players of this cart never fetch
 *   the transcoder at all.
 */

import type { DecodedTexture, EncodedImage, MeshAsset, MeshMaterial } from "@cartbox/editor";

import { KTX2_TRANSCODER_TRANSFER_BYTES, gzipSize } from "./downloadBudget";
import type { Ktx2Codec, Ktx2Encode, TextureKind } from "./ktx2Encoder";
import { KTX2_MAX_TEXELS } from "./ktx2Encoder";

/**
 * The platform an import's textures are compressed for (AAA_FIDELITY_ROADMAP.md
 * F9d): a desktop's GPU memory and BC7 take UASTC colour maps at up to 8K (past
 * Basis Universal's 12-megapixel limit they stay PNG); a phone's take ETC1S
 * colour, and every map held to 2048 across.
 */
export type TexturePlatform = "desktop" | "mobile";

/** The largest edge a platform's textures keep on import. */
export const PLATFORM_MAX_EDGE: Readonly<Record<TexturePlatform, number>> = { desktop: 8192, mobile: 2048 };

/** How one texture of `kind`, `width × height`, is compressed for `platform`: its codec (or kept as it is), and its largest edge. */
export function importTexturePlan(platform: TexturePlatform, kind: TextureKind, width: number, height: number): { readonly codec: Ktx2Codec | "keep"; readonly maxEdge: number } {
  const maxEdge = PLATFORM_MAX_EDGE[platform];
  const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
  const texels = Math.round(width * scale) * Math.round(height * scale);
  if (texels > KTX2_MAX_TEXELS) return { codec: "keep", maxEdge };
  const data = kind === "data" || kind === "normal";
  return { codec: data || platform === "desktop" ? "uastc" : "etc1s", maxEdge };
}

/** A texture halved (2×2 box) until its longer edge is at most `maxEdge`. */
export function downscaleTexture(texture: DecodedTexture, maxEdge: number): DecodedTexture {
  let t = texture;
  while (Math.max(t.width, t.height) > maxEdge) {
    const w = Math.max(1, t.width >> 1), h = Math.max(1, t.height >> 1);
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        for (let c = 0; c < 4; c += 1) {
          let sum = 0;
          for (let k = 0; k < 4; k += 1) sum += t.data[((Math.min(t.height - 1, y * 2 + (k >> 1))) * t.width + Math.min(t.width - 1, x * 2 + (k & 1))) * 4 + c]!;
          data[(y * w + x) * 4 + c] = Math.round(sum / 4);
        }
      }
    }
    t = { width: w, height: h, data };
  }
  return t;
}

export { KTX2_TRANSCODER_TRANSFER_BYTES };

/** The material slots that can hold an image. */
const IMAGE_SLOTS = ["baseColorImage", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "detailImage", "blendImage", "reliefImage"] as const;

/** Whether KTX2 textures that travel as `ktx2Bytes` should stay, against `pngBytes` for the same textures as PNG. */
export function keepKtx2(input: { ktx2Bytes: number; pngBytes: number; sceneHasKtx2: boolean }): boolean {
  const saving = input.pngBytes - input.ktx2Bytes;
  return input.sceneHasKtx2 ? saving > 0 : saving > KTX2_TRANSCODER_TRANSFER_BYTES;
}

/** Whether serialized scene meshes (sidecar strings) hold any KTX2 texture. */
export function sceneHasKtx2(serializedMeshes: Iterable<string>): boolean {
  for (const mesh of serializedMeshes) if (mesh.includes('"mime":"image/ktx2"')) return true;
  return false;
}

/** Whether a mesh has any KTX2 texture. */
export function hasKtx2(mesh: MeshAsset): boolean {
  return ktx2Images(mesh).length > 0;
}

/** Every material a mesh draws with: its primitives' and its material sets'. */
function meshMaterials(mesh: MeshAsset): MeshMaterial[] {
  return [...mesh.primitives.map((p) => p.material), ...(mesh.variants ?? []).flatMap((v) => v.materials.filter((m): m is MeshMaterial => m !== null))];
}

/** Every distinct KTX2 image in a mesh's materials. */
function ktx2Images(mesh: MeshAsset): EncodedImage[] {
  const found = new Set<EncodedImage>();
  for (const material of meshMaterials(mesh)) {
    for (const slot of IMAGE_SLOTS) {
      const image = material[slot];
      if (image && image.mime === "image/ktx2") found.add(image);
    }
  }
  return [...found];
}

/**
 * `mesh` with images swapped for their replacements, in its primitives and its
 * material sets alike. A material (and so an image) shared between primitives
 * or sets stays shared.
 */
function swapImages(mesh: MeshAsset, replacements: ReadonlyMap<EncodedImage, EncodedImage>): MeshAsset {
  const swapped = new Map<MeshMaterial, MeshMaterial>();
  const swap = (material: MeshMaterial): MeshMaterial => {
    let next = swapped.get(material);
    if (!next) {
      next = material;
      for (const slot of IMAGE_SLOTS) {
        const image = material[slot];
        const replacement = image ? replacements.get(image) : undefined;
        if (replacement) next = { ...next, [slot]: replacement };
      }
      swapped.set(material, next);
    }
    return next;
  };
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => ({ ...p, material: swap(p.material) })),
    ...(mesh.variants ? { variants: mesh.variants.map((v) => ({ ...v, materials: v.materials.map((m) => (m ? swap(m) : null)) })) } : {}),
  };
}

export interface Ktx2Settlement {
  readonly mesh: MeshAsset;
  /** "none" when the mesh had no KTX2 textures. */
  readonly outcome: "none" | "kept" | "converted";
  readonly ktx2Bytes: number;
  readonly pngBytes: number;
}

/**
 * Decide an imported mesh's KTX2 textures: keep them, or replace them with PNG
 * (see the file comment). `decode` transcodes KTX2 to RGBA; `encodePng` encodes
 * RGBA as PNG. A texture that can't be transcoded is kept as it is.
 */
export async function settleKtx2Textures(
  mesh: MeshAsset,
  options: {
    sceneHasKtx2: boolean;
    decode: (bytes: Uint8Array) => DecodedTexture | null;
    encodePng: (texture: DecodedTexture) => Promise<Uint8Array>;
  },
): Promise<Ktx2Settlement> {
  const images = ktx2Images(mesh);
  if (images.length === 0) return { mesh, outcome: "none", ktx2Bytes: 0, pngBytes: 0 };
  const replacements = new Map<EncodedImage, EncodedImage>();
  let ktx2Bytes = 0;
  let pngBytes = 0;
  for (const image of images) {
    const decoded = options.decode(image.bytes);
    if (!decoded) continue;
    const png = await options.encodePng(decoded);
    ktx2Bytes += await gzipSize(image.bytes);
    pngBytes += await gzipSize(png);
    replacements.set(image, { mime: "image/png", bytes: png });
  }
  if (replacements.size === 0 || keepKtx2({ ktx2Bytes, pngBytes, sceneHasKtx2: options.sceneHasKtx2 })) {
    return { mesh, outcome: "kept", ktx2Bytes, pngBytes };
  }
  return { mesh: swapImages(mesh, replacements), outcome: "converted", ktx2Bytes, pngBytes };
}

/** The glTF texture slots an imported model fills, and what each holds (see ktx2Encoder.ts). */
const IMPORT_SLOTS = [
  ["baseColorImage", "color"],
  ["emissiveImage", "color"],
  ["normalImage", "normal"],
  ["metallicRoughnessImage", "data"],
  ["occlusionImage", "data"],
] as const satisfies readonly (readonly [(typeof IMAGE_SLOTS)[number], TextureKind])[];

export interface Ktx2Compression {
  readonly mesh: MeshAsset;
  /** "none": no PNG or JPEG maps (or none would encode); "compressed": they became KTX2; "kept": they stayed, being lighter. */
  readonly outcome: "none" | "compressed" | "kept";
  /** The maps as they'd travel (gzipped): encoded, and as imported. */
  readonly ktx2Bytes: number;
  readonly sourceBytes: number;
}

/**
 * Compressed textures by default (I13): encode an imported model's PNG and
 * JPEG maps to KTX2 and keep that form when it travels lighter, by the same
 * rule as {@link settleKtx2Textures} — the saving must also pay for the
 * transcoder, unless the scene fetches it anyway. An image in several slots (a
 * packed occlusion/roughness/metal map) is encoded once, as its first slot's
 * kind; one that won't decode or encode is kept as it is.
 */
export async function compressMeshTextures(
  mesh: MeshAsset,
  options: {
    sceneHasKtx2: boolean;
    decode: (image: EncodedImage, raw: boolean) => Promise<DecodedTexture | null>;
    /** The encoder, fetched only when there is something to encode. */
    encoder: () => Promise<Ktx2Encode>;
    /** The platform its textures are planned for (F9d); absent, the encoder's defaults at the size given. */
    platform?: TexturePlatform;
  },
): Promise<Ktx2Compression> {
  const kinds = new Map<EncodedImage, TextureKind>();
  for (const material of meshMaterials(mesh)) {
    for (const [slot, kind] of IMPORT_SLOTS) {
      const image = material[slot];
      if (image && image.bytes.length > 0 && (image.mime === "image/png" || image.mime === "image/jpeg") && !kinds.has(image)) kinds.set(image, kind);
    }
  }
  if (kinds.size === 0) return { mesh, outcome: "none", ktx2Bytes: 0, sourceBytes: 0 };
  const encode = await options.encoder();
  const replacements = new Map<EncodedImage, EncodedImage>();
  let ktx2Bytes = 0;
  let sourceBytes = 0;
  for (const [image, kind] of kinds) {
    const decoded = await options.decode(image, kind !== "color").catch(() => null);
    const plan = decoded && options.platform ? importTexturePlan(options.platform, kind, decoded.width, decoded.height) : null;
    if (plan?.codec === "keep") continue;
    const sized = decoded && plan ? downscaleTexture(decoded, plan.maxEdge) : decoded;
    const encoded = sized ? encode(sized, kind, plan?.codec) : null;
    if (!encoded) continue;
    ktx2Bytes += await gzipSize(encoded);
    sourceBytes += await gzipSize(image.bytes);
    replacements.set(image, { mime: "image/ktx2", bytes: encoded });
  }
  if (replacements.size === 0) return { mesh, outcome: "none", ktx2Bytes: 0, sourceBytes: 0 };
  if (!keepKtx2({ ktx2Bytes, pngBytes: sourceBytes, sceneHasKtx2: options.sceneHasKtx2 })) return { mesh, outcome: "kept", ktx2Bytes, sourceBytes };
  return { mesh: swapImages(mesh, replacements), outcome: "compressed", ktx2Bytes, sourceBytes };
}

/** Encode RGBA as PNG with the browser's canvas encoder. */
export async function encodePngInBrowser(texture: DecodedTexture): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(texture.width, texture.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable for PNG encode");
  context.putImageData(new ImageData(new Uint8ClampedArray(texture.data), texture.width, texture.height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}
