/**
 * RGBA to KTX2 (Basis Universal) — compressed textures by default
 * (HALO_INFINITE_STYLE_ROADMAP.md I13).
 *
 * An imported model's PNG and JPEG maps are encoded to KTX2 with the official
 * Basis Universal encoder (vendored in src/vendor/basis, see its README), and
 * ktx2Policy.ts keeps whichever form travels lighter. The encoder is large
 * (~3 MB of WebAssembly), so it is fetched only when an import has textures,
 * and only in the editor: players never load it.
 *
 * Colour maps (base colour, emission) are encoded as ETC1S at a high quality
 * level, in sRGB, the smallest form. Data maps — normals, and packed occlusion,
 * roughness and metal — are encoded as UASTC (near-lossless, with RDO and Zstd
 * supercompression), in linear: their channels are numbers, not colours, and
 * ETC1S's block colours would smear them.
 */

import type { DecodedTexture } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** What a texture holds, which decides how it is encoded; "light" is a light map: colour, but linear (ETC1S, not sRGB). */
export type TextureKind = "color" | "light" | "data" | "normal";

/** Which Basis codec (F9d's per-platform plan): ETC1S, smallest; or UASTC, near-lossless (BC7 and ASTC on the GPU). */
export type Ktx2Codec = "etc1s" | "uastc";

export type Ktx2Encode = (texture: DecodedTexture, kind: TextureKind, codec?: Ktx2Codec) => Uint8Array | null;

/** ETC1S quality (1–255) for colour maps. */
export const KTX2_COLOR_QUALITY = 192;
/** The largest texture the encoder takes (Basis Universal's own limit is 12 Mpix). */
export const KTX2_MAX_TEXELS = 4096 * 2048;

let loading: Promise<Ktx2Encode> | null = null;

/** The KTX2 encoder, loading it on first use (and retrying after a failed load). */
export function loadKtx2Encoder(): Promise<Ktx2Encode> {
  loading ??= (async () => {
    const [{ default: createBasis }, wasm] = await Promise.all([
      import("../vendor/basis/basis_encoder.mjs") as Promise<{ default: (options: object) => Promise<any> }>,
      fetch(new URL("../vendor/basis/basis_encoder.wasm", import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`KTX2 encoder failed to load (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    const basis = await createBasis({ wasmBinary: wasm });
    basis.initializeBasis();
    return (texture: DecodedTexture, kind: TextureKind, codec?: Ktx2Codec) => encodeKtx2(basis, texture, kind, codec);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Encode RGBA to a KTX2 file with an initialised Basis encoder module; null when it can't. */
export function encodeKtx2(basis: any, texture: DecodedTexture, kind: TextureKind, codec?: Ktx2Codec): Uint8Array | null {
  const { width, height } = texture;
  if (width <= 0 || height <= 0 || width * height > KTX2_MAX_TEXELS) return null;
  const encoder = new basis.BasisEncoder();
  try {
    encoder.setCreateKTX2File(true);
    // The whole mip chain (F1a): a renderer that samples the GPU's own compressed
    // formats can't make a compressed texture's mips, so they ride in the file.
    // The RGBA paths read only the top level.
    encoder.setMipGen(true);
    const colour = kind === "color";
    encoder.setKTX2AndBasisSRGBTransferFunc(colour);
    encoder.setPerceptual(colour);
    // A light map is smooth colour: ETC1S holds it well, in linear (its bytes are light, not sRGB).
    // A colour map ETC1S unless the platform's plan asks for UASTC (F9d); data always UASTC.
    if ((colour || kind === "light") && codec !== "uastc") {
      encoder.setUASTC(false);
      encoder.setQualityLevel(KTX2_COLOR_QUALITY);
    } else {
      encoder.setUASTC(true);
      if (kind === "normal") {
        encoder.setNormalMapPreset();
        // Each level's normals averaged, then set back to unit length.
        encoder.setMipRenormalize?.(true);
      }
      encoder.setRDOUASTC(true);
      encoder.setKTX2UASTCSupercompression(true);
    }
    const rgba = new Uint8Array(texture.data.buffer, texture.data.byteOffset, width * height * 4);
    if (encoder.setSliceSourceImage(0, rgba, width, height, 0) === false) return null;
    // Room for the worst case: uncompressed with its mips (a third more), plus the file's header.
    const out = new Uint8Array(Math.ceil((width * height * 4 * 4) / 3) + 64 * 1024);
    const length: number = encoder.encode(out);
    return length > 0 ? out.slice(0, length) : null;
  } catch {
    return null;
  } finally {
    encoder.delete();
  }
}
