/**
 * Browser-side glue between an uploaded 3D file and the pure mesh codecs.
 *
 * The codecs in `@cartbox/editor` are DOM-free: they turn bytes into a
 * {@link MeshAsset} but do not touch the file system or decode images. This
 * module supplies the two browser-only halves — reading the picked `File`(s) and
 * decoding a material's compressed base-colour image into the RGBA the software
 * rasteriser samples — so the editor never re-implements either.
 *
 * OBJ import accepts a companion `.mtl` (and, in principle, texture files) picked
 * alongside the `.obj`; glTF import prefers the self-contained `.glb`, with
 * embedded-`data:` `.gltf` also handled. A glTF pointing at external files is
 * surfaced as a clear error rather than a silently untextured import. Meshopt-
 * or Draco-compressed glTF geometry is decoded on import (see gltfDecoders.ts).
 */

import { parseObj, type MeshAsset, type DecodedTexture } from "@cartbox/editor";

import { parseGlbDecoded, parseGltfTextDecoded } from "./gltfDecoders";
import { loadKtx2Decoder } from "./ktx2Decoder";

/**
 * What an import brought besides geometry (I13), for the editor's note: the
 * skeleton's clips (which arrive with a state machine to start from), the
 * material sets, and a packed occlusion/roughness/metal map kept once.
 */
export function importSummary(mesh: MeshAsset): string {
  const parts: string[] = [];
  const clips = mesh.skin ? (mesh.clips?.length ?? 0) : 0;
  if (mesh.skin) parts.push(`a ${mesh.skin.joints.length}-joint skeleton${clips > 0 ? ` with ${clips} clip${clips === 1 ? "" : "s"} and a state machine` : ""}`);
  const sets = mesh.variants?.length ?? 0;
  if (sets > 0) parts.push(`${sets} material set${sets === 1 ? "" : "s"}`);
  const packed = mesh.primitives.some((p) => p.material.occlusionImage && p.material.occlusionImage === p.material.metallicRoughnessImage);
  if (packed) parts.push("packed occlusion/roughness/metal maps");
  return parts.length > 0 ? ` With ${parts.join(", ")}.` : "";
}

/** Strip the extension and directory to a friendly asset name. */
function assetNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.[^.]+$/, "") || "mesh";
}

/** A picked file's lowercase extension, without the dot. */
function extensionOf(fileName: string): string {
  const match = /\.([^.]+)$/.exec(fileName.toLowerCase());
  return match ? match[1]! : "";
}

/**
 * Parse a picked 3D file into a {@link MeshAsset}. `companions` are other files
 * selected at the same time — an OBJ picks up its `.mtl` from them. Throws a
 * user-facing message for unsupported or externally-referenced files.
 */
export async function importMeshFile(file: File, companions: readonly File[] = []): Promise<MeshAsset> {
  const name = assetNameFromFile(file.name);
  const extension = extensionOf(file.name);

  if (extension === "glb") {
    return parseGlbDecoded(new Uint8Array(await file.arrayBuffer()), name);
  }
  if (extension === "gltf") {
    return parseGltfTextDecoded(await file.text(), name);
  }
  if (extension === "obj") {
    const mtlFile = companions.find((candidate) => extensionOf(candidate.name) === "mtl");
    const mtl = mtlFile ? await mtlFile.text() : undefined;
    return parseObj(await file.text(), { mtl, name });
  }
  throw new Error(`Unsupported 3D format ".${extension}". Import an .obj, .glb, or .gltf file.`);
}

/**
 * Decode each primitive's base-colour image to a tightly-packed RGBA texture the
 * rasteriser can sample; primitives without an image get a null entry, so the
 * result is index-aligned with `mesh.primitives`. Runs only in the browser
 * (uses `createImageBitmap` + a canvas 2D context).
 */
export async function decodeMeshTextures(mesh: MeshAsset): Promise<(DecodedTexture | null)[]> {
  return Promise.all(
    mesh.primitives.map(async (primitive) => {
      const image = primitive.material.baseColorImage;
      if (!image) return null;
      try {
        return await decodeImage(image.bytes, image.mime);
      } catch {
        return null; // an undecodable texture falls back to the flat base colour
      }
    }),
  );
}

/**
 * Decode compressed image bytes into an RGBA {@link DecodedTexture}. `raw`
 * reads the pixels exactly as stored (no colour-space conversion, no
 * premultiplied alpha), as a data map — normals, roughness, metal — needs.
 */
export async function decodeImage(bytes: Uint8Array, mime: string, raw = false): Promise<DecodedTexture> {
  if (mime === "image/ktx2") {
    // Browsers can't decode KTX2; the Basis transcoder (fetched on first use) can.
    const decoded = (await loadKtx2Decoder())(bytes);
    if (!decoded) throw new Error("Could not transcode a KTX2 texture");
    return decoded;
  }
  // Copy into a standalone ArrayBuffer so Blob never sees a shared/offset view.
  const blob = new Blob([bytes.slice().buffer], { type: mime || "image/png" });
  const bitmap = await createImageBitmap(blob, raw ? { colorSpaceConversion: "none", premultiplyAlpha: "none" } : {});
  const { width, height } = bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("2D canvas context unavailable for texture decode");
  }
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data } = context.getImageData(0, 0, width, height);
  return { width, height, data };
}
