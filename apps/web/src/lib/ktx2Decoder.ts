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

/** Basis transcoder targets for the WebGPU formats a device may sample: a byte a texel, or half that. */
export const NATIVE_TARGETS: Readonly<Record<string, number>> = {
  "bc7-rgba-unorm": 6, // cTFBC7_RGBA
  "astc-4x4-unorm": 10, // cTFASTC_4x4_RGBA
  "etc2-rgba8unorm": 1, // cTFETC2_RGBA
  "bc1-rgba-unorm": 2, // cTFBC1_RGB: opaque, half a byte a texel
  "etc2-rgb8unorm": 0, // cTFETC1_RGB (ETC1 is ETC2's RGB subset): opaque, half a byte a texel
};

/**
 * Formats that hold no alpha at half a byte a texel. An opaque ETC1S file
 * (ETC1 blocks already) loses nothing more in them, so it takes one first.
 */
const OPAQUE_FORMATS = new Set(["bc1-rgba-unorm", "etc2-rgb8unorm"]);

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

/** What a worker can answer with: the texture as it came back, or null. */
export type Ktx2DecodeAsync = (bytes: Uint8Array, options?: Ktx2DecodeOptions) => Promise<DecodedTexture | null>;

/** What a decoder's worker needs of a Worker (or a stand-in). */
export interface Ktx2WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: any }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** The buffers a decoded texture can hand over rather than copy: its pixels and its compressed levels. */
export function ktx2Transfers(texture: DecodedTexture): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>([texture.data.buffer as ArrayBuffer]);
  for (const level of (texture as { gpu?: CompressedTexture | null }).gpu?.levels ?? []) out.add(level.data.buffer as ArrayBuffer);
  return [...out];
}

/**
 * A decoder that transcodes on `worker` (F0e): each file posted with an id and
 * answered with its texture. A worker that fails (it couldn't load the
 * transcoder, say) hands this and every later file to `fallback`, here.
 */
export function workerKtx2Decoder(worker: Ktx2WorkerLike, fallback: () => Promise<Ktx2Decode>): Ktx2DecodeAsync {
  const pending = new Map<number, { bytes: Uint8Array; options?: Ktx2DecodeOptions; resolve: (texture: DecodedTexture | null) => void }>();
  let nextId = 1;
  let broken = false;
  const onMain = (bytes: Uint8Array, options?: Ktx2DecodeOptions) => fallback().then((decode) => decode(bytes, options));
  const fail = () => {
    broken = true;
    for (const job of pending.values()) void onMain(job.bytes, job.options).then(job.resolve, () => job.resolve(null));
    pending.clear();
  };
  worker.onmessage = (event) => {
    const { id, texture, error } = event.data ?? {};
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) void onMain(job.bytes, job.options).then(job.resolve, () => job.resolve(null));
    else job.resolve(texture ?? null);
  };
  worker.onerror = fail;
  return (bytes, options) => {
    if (broken) return onMain(bytes, options);
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { bytes, ...(options ? { options } : {}), resolve });
      worker.postMessage({ id, bytes, ...(options ? { options } : {}) });
    });
  };
}

let offThread: Promise<Ktx2DecodeAsync> | null = null;

/**
 * The KTX2 decoder on a worker where the browser has them (F0e), so a scene's
 * textures transcode while the game draws; on the main thread otherwise.
 */
export function loadKtx2DecoderOffThread(): Promise<Ktx2DecodeAsync> {
  offThread ??= (async () => {
    if (typeof Worker !== "function") {
      const decode = await loadKtx2Decoder();
      return async (bytes: Uint8Array, options?: Ktx2DecodeOptions) => decode(bytes, options);
    }
    const worker = new Worker(new URL("./ktx2Worker.ts", import.meta.url), { type: "module" });
    return workerKtx2Decoder(worker as unknown as Ktx2WorkerLike, loadKtx2Decoder);
  })();
  return offThread;
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
  // An opaque ETC1S texture goes to half a byte a texel where the device can; anything else needs a byte.
  const opaque = !file.getHasAlpha?.() && !file.isUASTC?.();
  const order = [...formats.filter((f) => opaque && OPAQUE_FORMATS.has(f)), ...formats.filter((f) => !OPAQUE_FORMATS.has(f))];
  for (const format of order) {
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
