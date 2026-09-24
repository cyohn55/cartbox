/**
 * A tiny, dependency-free PNG encoder.
 *
 * The era starters paint their scene texture into the cart's sprite sheet AND
 * bake an initial copy into the mesh material so the scene renders before the
 * first playtest. Both must come from the same pixels, and this runs at module
 * load in the browser (no `node:zlib`), so the encoder is pure JS and uses
 * *stored* (uncompressed) DEFLATE blocks — larger bytes, but trivial and correct
 * everywhere. Textures here are at most 128×128, so the size is immaterial.
 *
 * Larger textures (the Lockout arena's 256² PBR set) opt into `compress`: PNG
 * row filters plus a small fixed-Huffman DEFLATE, still pure and synchronous.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Wrap raw bytes in a zlib stream made of stored (uncompressed) DEFLATE blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const chunks: number[] = [0x78, 0x01]; // zlib header: no compression
  let offset = 0;
  do {
    const len = Math.min(0xffff, data.length - offset);
    const last = offset + len >= data.length ? 1 : 0;
    chunks.push(last, len & 0xff, (len >> 8) & 0xff, ~len & 0xff, (~len >> 8) & 0xff);
    for (let i = 0; i < len; i += 1) chunks.push(data[offset + i]!);
    offset += len;
  } while (offset < data.length);
  const adler = adler32(data);
  chunks.push((adler >>> 24) & 0xff, (adler >>> 16) & 0xff, (adler >>> 8) & 0xff, adler & 0xff);
  return Uint8Array.from(chunks);
}

// --- A small DEFLATE compressor (RFC 1951, fixed Huffman + LZ77) -------------
// Pure JS and synchronous, so it runs at module load in the browser like the
// stored encoder above. Fixed Huffman codes need no code-table header, and a
// hash-chain LZ77 finds the long repeats procedural textures are full of —
// typically a several-fold saving over stored blocks.

/** Writes bits LSB-first, as DEFLATE requires. */
class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;
  write(value: number, bits: number): void {
    this.acc |= value << this.n;
    this.n += bits;
    while (this.n >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.n -= 8;
    }
  }
  /** Write a Huffman code, which DEFLATE stores most-significant bit first. */
  writeCode(code: number, bits: number): void {
    let rev = 0;
    for (let i = 0; i < bits; i += 1) rev |= ((code >>> i) & 1) << (bits - 1 - i);
    this.write(rev, bits);
  }
  finish(): Uint8Array {
    if (this.n > 0) this.bytes.push(this.acc & 0xff);
    this.acc = 0;
    this.n = 0;
    return Uint8Array.from(this.bytes);
  }
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

/** Emit one literal/length symbol with the fixed Huffman code. */
function writeLitLen(w: BitWriter, symbol: number): void {
  if (symbol < 144) w.writeCode(0x30 + symbol, 8);
  else if (symbol < 256) w.writeCode(0x190 + symbol - 144, 9);
  else if (symbol < 280) w.writeCode(symbol - 256, 7);
  else w.writeCode(0xc0 + symbol - 280, 8);
}

function writeMatch(w: BitWriter, length: number, distance: number): void {
  let li = LENGTH_BASE.length - 1;
  while (LENGTH_BASE[li]! > length) li -= 1;
  writeLitLen(w, 257 + li);
  if (LENGTH_EXTRA[li]! > 0) w.write(length - LENGTH_BASE[li]!, LENGTH_EXTRA[li]!);
  let di = DIST_BASE.length - 1;
  while (DIST_BASE[di]! > distance) di -= 1;
  w.writeCode(di, 5);
  if (DIST_EXTRA[di]! > 0) w.write(distance - DIST_BASE[di]!, DIST_EXTRA[di]!);
}

/** Raw DEFLATE (one final fixed-Huffman block) of `data`. */
export function deflateFixed(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.write(1, 1); // BFINAL
  w.write(1, 2); // BTYPE = 01, fixed Huffman
  const WINDOW = 32768;
  const HASH_SIZE = 1 << 15;
  const MAX_CHAIN = 48;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(data.length);
  const hashAt = (i: number): number => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH_SIZE - 1);
  const insert = (i: number): void => {
    if (i + 2 >= data.length) return;
    const h = hashAt(i);
    prev[i] = head[h]!;
    head[h] = i;
  };
  let i = 0;
  while (i < data.length) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < data.length) {
      let cand = head[hashAt(i)]!;
      let chain = 0;
      const maxLen = Math.min(258, data.length - i);
      while (cand >= 0 && i - cand <= WINDOW && chain < MAX_CHAIN) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let len = 0;
          while (len < maxLen && data[cand + len] === data[i + len]) len += 1;
          if (len > bestLen) {
            bestLen = len;
            bestDist = i - cand;
            if (len === maxLen) break;
          }
        }
        cand = prev[cand]!;
        chain += 1;
      }
    }
    if (bestLen >= 3) {
      writeMatch(w, bestLen, bestDist);
      for (let k = 0; k < bestLen; k += 1) insert(i + k);
      i += bestLen;
    } else {
      writeLitLen(w, data[i]!);
      insert(i);
      i += 1;
    }
  }
  writeLitLen(w, 256); // end of block
  return w.finish();
}

/** Wrap raw bytes in a zlib stream compressed with {@link deflateFixed}. */
function zlibDeflate(data: Uint8Array): Uint8Array {
  const body = deflateFixed(data);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out.set(body, 2);
  const adler = adler32(data);
  out[out.length - 4] = (adler >>> 24) & 0xff;
  out[out.length - 3] = (adler >>> 16) & 0xff;
  out[out.length - 2] = (adler >>> 8) & 0xff;
  out[out.length - 1] = adler & 0xff;
  return out;
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Options for {@link encodeRgbaPng}. */
export interface PngEncodeOptions {
  /**
   * Compress (per-row PNG filtering + DEFLATE) instead of storing the pixels
   * raw. Off by default so existing callers keep their exact bytes; worth it for
   * large textures that ship inside a sidecar.
   */
  readonly compress?: boolean;
}

/**
 * Encode tightly-packed straight RGBA (`width*height*4` bytes) as an 8-bit
 * truecolour-with-alpha PNG.
 */
export function encodeRgbaPng(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: PngEncodeOptions = {},
): Uint8Array {
  const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  if (!options.compress) {
    // Prepend a zero (no-filter) byte to each scanline.
    for (let y = 0; y < height; y += 1) {
      raw[y * (stride + 1)] = 0;
      raw.set(src.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    }
  } else {
    // Per row, pick the filter (None/Sub/Up/Average/Paeth) with the smallest
    // sum of absolute residuals — the standard heuristic — so DEFLATE sees
    // runs of near-zero bytes.
    const cand = new Uint8Array(stride);
    const best = new Uint8Array(stride);
    for (let y = 0; y < height; y += 1) {
      const row = src.subarray(y * stride, (y + 1) * stride);
      const up = y > 0 ? src.subarray((y - 1) * stride, y * stride) : null;
      let bestType = 0;
      let bestScore = Infinity;
      for (let type = 0; type <= 4; type += 1) {
        let score = 0;
        for (let x = 0; x < stride; x += 1) {
          const a = x >= 4 ? row[x - 4]! : 0;
          const b = up ? up[x]! : 0;
          const c = up && x >= 4 ? up[x - 4]! : 0;
          const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : paeth(a, b, c);
          const v = (row[x]! - pred) & 0xff;
          cand[x] = v;
          score += v < 128 ? v : 256 - v;
        }
        if (score < bestScore) {
          bestScore = score;
          bestType = type;
          best.set(cand);
        }
      }
      raw[y * (stride + 1)] = bestType;
      raw.set(best, y * (stride + 1) + 1);
    }
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = options.compress ? zlibDeflate(raw) : zlibStored(raw);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
