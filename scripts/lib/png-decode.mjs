// A minimal PNG reader, for verification scripts that need to look at what a
// canvas actually drew.
//
// Playwright hands back a PNG; asserting on rendered output means turning that
// back into pixels. Only the one shape Chrome emits is supported — 8-bit RGBA,
// no interlacing — because that is the only shape this is ever handed, and a
// general decoder would be a dependency for no benefit.

import { inflateSync } from "node:zlib";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Undo one scanline's filter, in place, given the row above it. */
function unfilter(type, row, previous, bytesPerPixel) {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previous ? previous[i] : 0;
    const upLeft = previous && i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0;
    switch (type) {
      case 0: break;
      case 1: row[i] = (row[i] + left) & 0xff; break;
      case 2: row[i] = (row[i] + up) & 0xff; break;
      case 3: row[i] = (row[i] + ((left + up) >> 1)) & 0xff; break;
      case 4: row[i] = (row[i] + paeth(left, up, upLeft)) & 0xff; break;
      default: throw new Error(`unknown PNG filter ${type}`);
    }
  }
}

/** Decode an 8-bit RGBA PNG into `{ width, height, data }`. */
export function decodePng(bytes) {
  const view = Buffer.from(bytes);
  for (let i = 0; i < SIGNATURE.length; i += 1) {
    if (view[i] !== SIGNATURE[i]) throw new Error("not a PNG");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const parts = [];
  while (offset < view.length) {
    const length = view.readUInt32BE(offset);
    const type = view.toString("ascii", offset + 4, offset + 8);
    const body = view.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colourType = body[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colourType];
      if (!channels) throw new Error(`unsupported colour type ${colourType}`);
      if (body[12] !== 0) throw new Error("interlaced PNGs are not supported");
    } else if (type === "IDAT") {
      parts.push(body);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const data = new Uint8Array(width * height * 4);
  let previous = null;
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1);
    const row = raw.subarray(at + 1, at + 1 + stride);
    unfilter(raw[at], row, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      data[to] = row[from];
      data[to + 1] = channels >= 3 ? row[from + 1] : row[from];
      data[to + 2] = channels >= 3 ? row[from + 2] : row[from];
      data[to + 3] = channels === 4 ? row[from + 3] : channels === 2 ? row[from + 1] : 255;
    }
    previous = row;
  }
  return { width, height, data };
}
