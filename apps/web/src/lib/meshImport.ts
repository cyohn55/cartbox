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
 * surfaced as a clear error rather than a silently untextured import.
 */

import {
  parseObj,
  parseGlb,
  parseGltfText,
  type MeshAsset,
  type DecodedTexture,
} from "@cartbox/editor";

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
    return parseGlb(new Uint8Array(await file.arrayBuffer()), name);
  }
  if (extension === "gltf") {
    return parseGltfText(await file.text(), name);
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

/** Decode compressed image bytes into an RGBA {@link DecodedTexture}. */
async function decodeImage(bytes: Uint8Array, mime: string): Promise<DecodedTexture> {
  // Copy into a standalone ArrayBuffer so Blob never sees a shared/offset view.
  const blob = new Blob([bytes.slice().buffer], { type: mime || "image/png" });
  const bitmap = await createImageBitmap(blob);
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
