/**
 * A tiny, dependency-free PNG encoder.
 *
 * The era starters paint their scene texture into the cart's sprite sheet AND
 * bake an initial copy into the mesh material so the scene renders before the
 * first playtest. Both must come from the same pixels, and this runs at module
 * load in the browser (no `node:zlib`), so the encoder is pure JS and uses
 * *stored* (uncompressed) DEFLATE blocks — larger bytes, but trivial and correct
 * everywhere. Textures here are at most 128×128, so the size is immaterial.
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

/**
 * Encode tightly-packed straight RGBA (`width*height*4` bytes) as an 8-bit
 * truecolour-with-alpha PNG.
 */
export function encodeRgbaPng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  // Prepend a zero (no-filter) byte to each scanline.
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(src.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", ihdr), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
