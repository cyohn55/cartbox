/**
 * A PNG decoder for tests: the 8-bit RGBA the editor's encoder writes
 * (filtered per row), as width, height and pixels.
 */

import { inflateSync } from "node:zlib";

/** A PNG's RGBA (the encoder writes 8-bit RGBA, filtered per row). */
export function decodeRgbaPng(png: Uint8Array): { width: number; height: number; data: Uint8Array } {
  const b = Buffer.from(png);
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString("ascii", o + 4, o + 8);
    const d = b.subarray(o + 8, o + 8 + len);
    if (type === "IHDR") {
      width = d.readUInt32BE(0);
      height = d.readUInt32BE(4);
    } else if (type === "IDAT") idat.push(d);
    o += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const f = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x += 1) {
      const v = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const up = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = up;
      else if (f === 3) p = (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + x] = (v + p) & 255;
    }
  }
  return { width, height, data: out };
}
