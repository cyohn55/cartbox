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

export { KTX2_TRANSCODER_TRANSFER_BYTES };

/** The material slots that can hold an image. */
const IMAGE_SLOTS = ["baseColorImage", "normalImage", "materialImage", "metallicRoughnessImage", "occlusionImage", "emissiveImage", "lightmapImage", "detailImage"] as const;

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

/** Every distinct KTX2 image in a mesh's materials. */
function ktx2Images(mesh: MeshAsset): EncodedImage[] {
  const found = new Set<EncodedImage>();
  for (const primitive of mesh.primitives) {
    for (const slot of IMAGE_SLOTS) {
      const image = primitive.material[slot];
      if (image && image.mime === "image/ktx2") found.add(image);
    }
  }
  return [...found];
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
  const swap = (material: MeshMaterial): MeshMaterial => {
    let next = material;
    for (const slot of IMAGE_SLOTS) {
      const image = material[slot];
      const replacement = image ? replacements.get(image) : undefined;
      if (replacement) next = { ...next, [slot]: replacement };
    }
    return next;
  };
  return {
    mesh: { ...mesh, primitives: mesh.primitives.map((p) => ({ ...p, material: swap(p.material) })) },
    outcome: "converted",
    ktx2Bytes,
    pngBytes,
  };
}

/** Encode RGBA as PNG with the browser's canvas encoder. */
export async function encodePngInBrowser(texture: DecodedTexture): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(texture.width, texture.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas context unavailable for PNG encode");
  context.putImageData(new ImageData(new Uint8ClampedArray(texture.data), texture.width, texture.height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}
