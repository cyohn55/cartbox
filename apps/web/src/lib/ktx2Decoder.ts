/**
 * KTX2 (Basis Universal) textures to RGBA (ENGINE_ROADMAP.md, Phase 4).
 *
 * Every renderer here — the software rasteriser included — samples plain RGBA,
 * so a KTX2 texture is transcoded once, when its scene loads, with the official
 * Basis Universal transcoder (vendored in src/vendor/basis, ~250 KB gzipped).
 * It is fetched only the first time a KTX2 texture needs decoding, and only
 * scenes whose textures are worth keeping as KTX2 have any (see ktx2Policy.ts).
 */

import type { DecodedTexture } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Basis `transcoder_texture_format::cTFRGBA32`. */
const RGBA32 = 13;

export type Ktx2Decode = (bytes: Uint8Array) => DecodedTexture | null;

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
    return (bytes: Uint8Array) => transcodeKtx2(basis, bytes);
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Transcode a KTX2 file's top mip to RGBA with an initialised Basis module; null when it can't. */
export function transcodeKtx2(basis: any, bytes: Uint8Array): DecodedTexture | null {
  const file = new basis.KTX2File(bytes);
  try {
    if (!file.isValid() || file.isHDR?.()) return null;
    const width: number = file.getWidth();
    const height: number = file.getHeight();
    if (!width || !height || !file.startTranscoding()) return null;
    const data = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, RGBA32));
    if (!file.transcodeImage(data, 0, 0, 0, RGBA32, 0, -1, -1)) return null;
    return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4) };
  } catch {
    return null;
  } finally {
    file.close();
    file.delete();
  }
}
