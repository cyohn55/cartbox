/**
 * A minimal ZIP writer (ENGINE_PARITY_ROADMAP.md EP18): enough to package an
 * exported game for itch.io and the like — files in, one archive out.
 *
 * Each file is DEFLATE-compressed (the editor's own fixed-Huffman encoder) when
 * that makes it smaller, else stored. No directories, encryption or ZIP64: an
 * export is a handful of files well under 4 GB. Pure.
 */

import { crc32, deflateFixed } from "@cartbox/editor";

export interface ZipEntry {
  /** Path inside the archive, "/"-separated. */
  readonly name: string;
  readonly data: Uint8Array;
}

/** DOS date and time fields for a Date (local time, as ZIP tools show it). */
function dosTime(date: Date): { time: number; day: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The archive holding `entries`, in order. */
export function zipFiles(entries: readonly ZipEntry[], date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, day } = dosTime(date);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const packed = deflateFixed(entry.data);
    const deflated = packed.length < entry.data.length;
    const body = deflated ? packed : entry.data;
    const method = deflated ? 8 : 0;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // made by: 2.0
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);

    parts.push(local, body);
    central.push(record);
    offset += local.length + body.length;
  }
  const centralSize = central.reduce((sum, r) => sum + r.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
