/**
 * KTX2 (Basis Universal) textures to RGBA (ENGINE_ROADMAP.md, Phase 4).
 *
 * Every renderer here — the software rasteriser included — samples plain RGBA,
 * so a KTX2 texture is transcoded once, when its scene loads, with the official
 * Basis Universal transcoder (vendored in src/vendor/basis, ~250 KB gzipped).
 * It is fetched only the first time a KTX2 texture needs decoding, and only
 * scenes whose textures are worth keeping as KTX2 have any (see ktx2Policy.ts).
 *
 * A renderer that samples block-compressed formats (the AAA tier's, F1a) names
 * them, and the file is transcoded a second time, into the first one it can:
 * BC7, ASTC 4×4 or ETC2, every mip level the file carries. The GPU then holds
 * a byte a texel (a quarter of RGBA's) and reads the chain the encoder made.
 */

import type { CompressedTexture, DecodedTexture } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Basis `transcoder_texture_format::cTFRGBA32`. */
const RGBA32 = 13;

/** Basis transcoder targets for the WebGPU formats a device may sample. Each is 16 bytes a 4×4 block. */
export const NATIVE_TARGETS: Readonly<Record<string, number>> = {
  "bc7-rgba-unorm": 6, // cTFBC7_RGBA
  "astc-4x4-unorm": 10, // cTFASTC_4x4_RGBA
  "etc2-rgba8unorm": 1, // cTFETC2_RGBA
};

export interface Ktx2DecodeOptions {
  /** WebGPU formats the renderer can sample, preferred first; the texture also transcodes to the first one listed here that can be made. */
  readonly gpuFormats?: readonly string[];
}

export type Ktx2Decode = (bytes: Uint8Array, options?: Ktx2DecodeOptions) => DecodedTexture | null;

let loading: Promise<Ktx2Decode> | null = null;

/** The KTX2 decoder, loading the transcoder on first use (and retrying after a failed load). */
export function loadKtx2Decoder(): Promise<Ktx2Decode> {
  loading ??= (async () => {
    const [{ default: createBasis }, wasm] = await Promise.all([
      import("../vendor/basis/basis_transcoder.cjs") as Promise<{ default: (options: object) => Promise<any> }>,
      fetch(new URL("../vendor/basis/basis_transcoder.wasm", import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`KTX2 transcoder failed to load (${r.status})`);
        return r.arrayBuffer();
      }),
    ]);
    const basis = await createBasis({ wasmBinary: wasm });
    basis.initializeBasis();
    return (bytes: Uint8Array, options?: Ktx2DecodeOptions) => transcodeKtx2(basis, bytes, options);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/**
 * Transcode a KTX2 file's top mip to RGBA with an initialised Basis module, and,
 * given `gpuFormats`, its whole chain to the first of them it can (see
 * {@link nativeChain}); null when it can't transcode at all.
 */
export function transcodeKtx2(basis: any, bytes: Uint8Array, options: Ktx2DecodeOptions = {}): DecodedTexture | null {
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid() || file.isHDR?.()) return null;
    const width: number = file.getWidth();
    const height: number = file.getHeight();
    if (!width || !height || !file.startTranscoding()) return null;
    const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!file.transcodeImage(data, 0, 0, 0, RGBA32, 0, -1, -1)) return null;
    const gpu = options.gpuFormats?.length ? nativeChain(file, width, height, options.gpuFormats) : null;
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4), ...(gpu ? { gpu } : {}) };
  } catch {
    return null;
  } finally {
    file.close();
    file.delete();
  }
}

/** Levels in a full chain down to 1×1. */
function fullChain(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height))) + 1;
}

/**
 * Every level of an open KTX2 file in the first of `formats` it transcodes to,
 * or null. Only a file with its whole mip chain, at a size of whole 4×4
 * blocks: the GPU can't make a compressed texture's mips itself, and a texture
 * sampled without them would shimmer, so such a file keeps the RGBA path (where
 * the renderer makes them).
 */
function nativeChain(file: any, width: number, height: number, formats: readonly string[]): CompressedTexture | null {
  const levels: number = file.getLevels?.() ?? 1;
  if (levels < fullChain(width, height) || width % 4 !== 0 || height % 4 !== 0) return null;
  for (const format of formats) {
    const target = NATIVE_TARGETS[format];
    if (target === undefined) continue;
    const out: { width: number; height: number; data: Uint8Array }[] = [];
    for (let level = 0; level < levels; level += 1) {
      const size: number = file.getImageTranscodedSizeInBytes(level, 0, 0, target);
      const data = new Uint8Array(size);
      if (!size || !file.transcodeImage(data, level, 0, 0, target, 0, -1, -1)) break;
      out.push({ width: Math.max(1, width >> level), height: Math.max(1, height >> level), data });
    }
    if (out.length === levels) return { format, levels: out };
  }
  return null;
}
