/**
 * OpenEXR and float KTX2 environments on import (AAA_FIDELITY_ROADMAP.md F9d),
 * beside the Radiance `.hdr` the sky already takes (skyLayers.ts).
 *
 * - **OpenEXR**: single-part scanline images, half or float channels (R, G, B,
 *   and A or Y when that is all there is), uncompressed or compressed with
 *   RLE, ZIPS or ZIP (zlib over 1 or 16 lines, predictor and interleave
 *   undone). PIZ, PXR24 and the lossy B44 and DWA codecs aren't read: a file
 *   using one is refused with its codec's name, so it can be re-saved as ZIP.
 * - **KTX2 HDR**: an uncompressed float image (R16G16B16A16_SFLOAT,
 *   R32G32B32A32_SFLOAT, B10G11R11_UFLOAT or E5B9G9R9_UFLOAT), level 0.
 *
 * Either decodes to linear RGB floats, and {@link encodeRadianceHdr} writes
 * that as a Radiance file, so an EXR panorama travels and lights the scene
 * exactly as an imported `.hdr` does.
 */

export interface FloatImage {
  readonly width: number;
  readonly height: number;
  /** Linear RGB, three floats a pixel, top row first. */
  readonly data: Float32Array;
}

/** zlib (RFC 1950) inflate, through the platform's DecompressionStream. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** IEEE half → float. */
export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * 2 ** -14 * (m / 1024);
  if (e === 31) return m ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + m / 1024);
}

const EXR_COMPRESSION = ["NONE", "RLE", "ZIPS", "ZIP", "PIZ", "PXR24", "B44", "B44A", "DWAA", "DWAB"] as const;

/** Decode an OpenEXR file (see the module comment). Throws with a reason when it can't. */
export async function decodeExr(bytes: Uint8Array): Promise<FloatImage> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, true) !== 20000630) throw new Error("Not an OpenEXR file.");
  const flags = view.getUint32(4, true);
  if (flags & 0x200) throw new Error("Tiled OpenEXR isn't supported: save it as scanlines.");
  if (flags & 0x1000) throw new Error("Multi-part OpenEXR isn't supported.");
  let pos = 8;
  const cstring = () => {
    let s = "";
    while (pos < bytes.length && bytes[pos] !== 0) s += String.fromCharCode(bytes[pos++]!);
    pos += 1;
    return s;
  };
  const channels: { name: string; type: number }[] = [];
  let compression = 0;
  let window: [number, number, number, number] | null = null;
  for (;;) {
    const name = cstring();
    if (name === "") break;
    const type = cstring();
    const size = view.getUint32(pos, true);
    pos += 4;
    const start = pos;
    if (name === "channels" && type === "chlist") {
      while (pos < start + size - 1) {
        const cname = cstring();
        const ptype = view.getInt32(pos, true);
        pos += 16; // pixel type, pLinear + reserved, xSampling, ySampling
        channels.push({ name: cname, type: ptype });
      }
    } else if (name === "compression") {
      compression = bytes[start]!;
    } else if (name === "dataWindow") {
      window = [view.getInt32(start, true), view.getInt32(start + 4, true), view.getInt32(start + 8, true), view.getInt32(start + 12, true)];
    }
    pos = start + size;
  }
  if (!window) throw new Error("OpenEXR without a data window.");
  const codec = EXR_COMPRESSION[compression] ?? `#${compression}`;
  if (!["NONE", "RLE", "ZIPS", "ZIP"].includes(codec)) throw new Error(`OpenEXR ${codec} compression isn't supported: re-save it with ZIP compression.`);
  const width = window[2] - window[0] + 1;
  const height = window[3] - window[1] + 1;
  if (!(width > 0 && height > 0) || width * height > 16384 * 8192) throw new Error("OpenEXR image too large.");
  // Channels are stored sorted by name; each line holds each channel's row in turn.
  channels.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sizes = channels.map((c) => (c.type === 1 ? 2 : 4));
  const lineBytes = sizes.reduce((s, n) => s + n * width, 0);
  const linesPerBlock = codec === "ZIP" ? 16 : 1;
  const blocks = Math.ceil(height / linesPerBlock);
  // The offset table, then the blocks.
  const offsets: number[] = [];
  for (let i = 0; i < blocks; i += 1) offsets.push(Number(view.getBigUint64(pos + i * 8, true)));
  const pick = (want: string[]) => channels.findIndex((c) => want.includes(c.name) || want.some((w) => c.name.endsWith(`.${w}`)));
  const ri = pick(["R", "r"]);
  const gi = pick(["G", "g"]);
  const bi = pick(["B", "b"]);
  const yi = pick(["Y", "y"]);
  if (ri < 0 && yi < 0) throw new Error("OpenEXR without R, G, B or Y channels.");
  const data = new Float32Array(width * height * 3);
  for (let block = 0; block < blocks; block += 1) {
    const o = offsets[block]!;
    if (o + 8 > bytes.length) throw new Error("OpenEXR truncated.");
    const y0 = view.getInt32(o, true) - window[1];
    const packed = view.getUint32(o + 4, true);
    const lines = Math.min(linesPerBlock, height - y0);
    const raw = bytes.subarray(o + 8, o + 8 + packed);
    const expected = lineBytes * lines;
    let plain: Uint8Array;
    if (codec === "NONE" || packed === expected) plain = raw;
    else if (codec === "RLE") plain = undoPredictor(unRle(raw, expected));
    else plain = undoPredictor(await inflate(raw));
    if (plain.length < expected) throw new Error("OpenEXR block decoded short.");
    const pv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
    for (let l = 0; l < lines; l += 1) {
      let at = l * lineBytes;
      const row = (y0 + l) * width;
      for (let c = 0; c < channels.length; c += 1) {
        const size = sizes[c]!;
        const type = channels[c]!.type;
        const target = c === ri ? 0 : c === gi ? 1 : c === bi ? 2 : c === yi && ri < 0 ? 3 : -1;
        for (let x = 0; x < width; x += 1) {
          if (target >= 0) {
            const v = type === 1 ? halfToFloat(pv.getUint16(at, true)) : type === 2 ? pv.getFloat32(at, true) : pv.getUint32(at, true);
            const v2 = Number.isFinite(v) ? Math.max(0, v) : 0;
            if (target === 3) data.set([v2, v2, v2], (row + x) * 3);
            else data[(row + x) * 3 + target] = v2;
          }
          at += size;
        }
      }
    }
  }
  // A single channel of colour (R alone) stands for grey.
  if (ri >= 0 && gi < 0 && bi < 0) for (let i = 0; i < width * height; i += 1) data[i * 3 + 1] = data[i * 3 + 2] = data[i * 3]!;
  return { width, height, data };
}

/** EXR's RLE: a signed count, then a run of one byte or that many literals. */
function unRle(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0;
  let o = 0;
  while (i < src.length && o < size) {
    const n = (src[i++]! << 24) >> 24;
    if (n < 0) {
      const count = -n;
      out.set(src.subarray(i, i + count), o);
      i += count;
      o += count;
    } else {
      out.fill(src[i++]!, o, o + n + 1);
      o += n + 1;
    }
  }
  return out;
}

/** Undo EXR's byte predictor and the split of even and odd bytes (RLE and ZIP both apply them). */
function undoPredictor(src: Uint8Array): Uint8Array {
  const t = Uint8Array.from(src);
  for (let i = 1; i < t.length; i += 1) t[i] = (t[i - 1]! + t[i]! - 128) & 0xff;
  const out = new Uint8Array(t.length);
  const half = Math.ceil(t.length / 2);
  for (let i = 0, a = 0, b = half; i < t.length; i += 1) out[i] = i % 2 === 0 ? t[a++]! : t[b++]!;
  return out;
}

/** The float formats a KTX2 HDR image may use (Vulkan's numbers). */
const VK = { R16G16B16A16_SFLOAT: 97, R32G32B32A32_SFLOAT: 109, B10G11R11_UFLOAT: 122, E5B9G9R9_UFLOAT: 123 } as const;

/** Decode a float KTX2 image's level 0 (see the module comment). Throws with a reason when it can't. */
export function decodeKtx2Hdr(bytes: Uint8Array): FloatImage {
  const id = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 80 || id.some((b, i) => bytes[i] !== b)) throw new Error("Not a KTX2 file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = view.getUint32(12, true);
  const width = view.getUint32(20, true);
  const height = Math.max(1, view.getUint32(24, true));
  const supercompression = view.getUint32(44, true);
  if (supercompression !== 0) throw new Error("Supercompressed KTX2 HDR isn't supported.");
  // The level index starts at byte 80: level 0's offset and length.
  const offset = Number(view.getBigUint64(80, true));
  const length = Number(view.getBigUint64(88, true));
  if (offset + length > bytes.length) throw new Error("KTX2 truncated.");
  const data = new Float32Array(width * height * 3);
  const n = width * height;
  for (let i = 0; i < n; i += 1) {
    if (format === VK.R16G16B16A16_SFLOAT) {
      for (let c = 0; c < 3; c += 1) data[i * 3 + c] = Math.max(0, halfToFloat(view.getUint16(offset + i * 8 + c * 2, true)));
    } else if (format === VK.R32G32B32A32_SFLOAT) {
      for (let c = 0; c < 3; c += 1) data[i * 3 + c] = Math.max(0, view.getFloat32(offset + i * 16 + c * 4, true));
    } else if (format === VK.E5B9G9R9_UFLOAT) {
      const v = view.getUint32(offset + i * 4, true);
      const scale = 2 ** ((v >>> 27) - 15 - 9);
      data.set([(v & 0x1ff) * scale, ((v >>> 9) & 0x1ff) * scale, ((v >>> 18) & 0x1ff) * scale], i * 3);
    } else if (format === VK.B10G11R11_UFLOAT) {
      const v = view.getUint32(offset + i * 4, true);
      const f11 = (x: number) => { const e = (x >> 6) & 0x1f, m = x & 0x3f; return e === 0 ? 2 ** -14 * (m / 64) : 2 ** (e - 15) * (1 + m / 64); };
      const f10 = (x: number) => { const e = (x >> 5) & 0x1f, m = x & 0x1f; return e === 0 ? 2 ** -14 * (m / 32) : 2 ** (e - 15) * (1 + m / 32); };
      data.set([f11(v & 0x7ff), f11((v >>> 11) & 0x7ff), f10((v >>> 22) & 0x3ff)], i * 3);
    } else {
      throw new Error(`KTX2 format ${format} isn't a float format this reads.`);
    }
  }
  return { width, height, data };
}

/** Write linear RGB floats as a Radiance `.hdr` (flat RGBE scanlines), which the sky's import reads. */
export function encodeRadianceHdr(image: FloatImage): Uint8Array {
  const header = new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${image.height} +X ${image.width}\n`);
  const out = new Uint8Array(header.length + image.width * image.height * 4);
  out.set(header);
  let o = header.length;
  for (let i = 0; i < image.width * image.height; i += 1) {
    const r = image.data[i * 3]!, g = image.data[i * 3 + 1]!, b = image.data[i * 3 + 2]!;
    const m = Math.max(r, g, b);
    if (m < 1e-32) {
      out.set([0, 0, 0, 0], o);
    } else {
      const e = Math.ceil(Math.log2(m));
      // So the largest channel's mantissa is under 256.
      const exp = m / 2 ** e >= 1 ? e + 1 : e;
      const scale = 256 / 2 ** exp;
      out.set([Math.min(255, Math.floor(r * scale)), Math.min(255, Math.floor(g * scale)), Math.min(255, Math.floor(b * scale)), exp + 128], o);
    }
    o += 4;
  }
  return out;
}
