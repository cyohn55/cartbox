/**
 * Minimal LHA container reader + "-lh5-" decoder (pure JS).
 *
 * Faithful port of the canonical LHa-for-UNIX algorithm (io.c / huf.c /
 * maketbl.c / slide.c), reduced to the single compression method the Quake
 * shareware DEICE installer (resource.1) uses. This lets the Quake bundle be
 * assembled in pure Node with no external archiver.
 */

const THRESHOLD = 3;
const MAXMATCH = 256;
const DICBIT = 13;
const NC = 255 + MAXMATCH + 2 - THRESHOLD; // 510
const CBIT = 9;
const NP = DICBIT + 1; // 14
const NT = 19;
const PBIT = 4;
const TBIT = 5;

/** Decode a single lh5 stream of known original size. */
export function lh5Decode(src, originalSize) {
  const out = new Uint8Array(originalSize);
  let outPos = 0;

  // ---- 16-bit bit reader (LHa io.c) ----
  let bitbuf = 0;
  let subbitbuf = 0;
  let bitcount = 0;
  let srcPos = 0;
  const nextbyte = () => (srcPos < src.length ? src[srcPos++] : 0);

  function fillbuf(n) {
    while (n > bitcount) {
      n -= bitcount;
      bitbuf = ((bitbuf << bitcount) | (subbitbuf >>> (8 - bitcount))) & 0xffff;
      subbitbuf = nextbyte();
      bitcount = 8;
    }
    bitcount -= n;
    bitbuf = ((bitbuf << n) | (subbitbuf >>> (8 - n))) & 0xffff;
    subbitbuf = (subbitbuf << n) & 0xff;
  }
  const peek = (n) => (bitbuf & 0xffff) >>> (16 - n);
  function getbits(n) {
    if (n === 0) return 0;
    const x = peek(n);
    fillbuf(n);
    return x;
  }
  fillbuf(16);

  // ---- Huffman tables ----
  const left = new Uint16Array(2 * NC - 1);
  const right = new Uint16Array(2 * NC - 1);
  const c_len = new Uint8Array(NC);
  const pt_len = new Uint8Array(NT);
  const c_table = new Uint16Array(4096);
  const pt_table = new Uint16Array(256);
  let blocksize = 0;

  function makeTable(nchar, bitlen, tablebits, table) {
    const count = new Uint16Array(17);
    const weight = new Uint16Array(17);
    const start = new Uint16Array(18);
    let i;
    for (i = 1; i <= 16; i++) count[i] = 0;
    for (i = 0; i < nchar; i++) count[bitlen[i]]++;

    start[1] = 0;
    for (i = 1; i <= 16; i++) start[i + 1] = (start[i] + (count[i] << (16 - i))) & 0xffff;
    if (start[17] !== 0) throw new Error("make_table: bad code table");

    const jutbits = 16 - tablebits;
    for (i = 1; i <= tablebits; i++) {
      start[i] = (start[i] >>> jutbits) & 0xffff;
      weight[i] = 1 << (tablebits - i);
    }
    for (; i <= 16; i++) weight[i] = 1 << (16 - i);

    // Clear the whole fast table; used slots get filled below.
    table.fill(0);

    let avail = nchar;
    const mask = 1 << (15 - tablebits);
    for (let ch = 0; ch < nchar; ch++) {
      const len = bitlen[ch];
      if (len === 0) continue;
      const nextcode = (start[len] + weight[len]) & 0xffff;
      if (len <= tablebits) {
        for (i = start[len]; i < nextcode; i++) table[i] = ch;
      } else {
        // Long code: descend a left/right node tree, allocating nodes.
        let k = start[len];
        // pointer emulation: (kind, idx). kind 0 = table, 1 = left, 2 = right.
        let kind = 0;
        let idx = k >>> jutbits;
        let remaining = len - tablebits;
        while (remaining !== 0) {
          const cur = kind === 0 ? table[idx] : kind === 1 ? left[idx] : right[idx];
          let node = cur;
          if (node === 0) {
            right[avail] = 0;
            left[avail] = 0;
            node = avail++;
            if (kind === 0) table[idx] = node;
            else if (kind === 1) left[idx] = node;
            else right[idx] = node;
          }
          if (k & mask) {
            kind = 2;
            idx = node;
          } else {
            kind = 1;
            idx = node;
          }
          k = (k << 1) & 0xffff;
          remaining--;
        }
        if (kind === 0) table[idx] = ch;
        else if (kind === 1) left[idx] = ch;
        else right[idx] = ch;
      }
      start[len] = nextcode;
    }
  }

  function readPtLen(nn, nbit, iSpecial) {
    let n = getbits(nbit);
    if (n === 0) {
      const c = getbits(nbit);
      for (let i = 0; i < nn; i++) pt_len[i] = 0;
      for (let i = 0; i < 256; i++) pt_table[i] = c;
      return;
    }
    let i = 0;
    while (i < n) {
      let c = peek(3);
      if (c === 7) {
        let m = 1 << (16 - 4);
        while (m & bitbuf) {
          m >>= 1;
          c++;
        }
      }
      fillbuf(c < 7 ? 3 : c - 3);
      pt_len[i++] = c;
      if (i === iSpecial) {
        let z = getbits(2);
        while (--z >= 0) pt_len[i++] = 0;
      }
    }
    while (i < nn) pt_len[i++] = 0;
    makeTable(nn, pt_len, 8, pt_table);
  }

  function readCLen() {
    let n = getbits(CBIT);
    if (n === 0) {
      const c = getbits(CBIT);
      for (let i = 0; i < NC; i++) c_len[i] = 0;
      for (let i = 0; i < 4096; i++) c_table[i] = c;
      return;
    }
    let i = 0;
    while (i < n) {
      let c = pt_table[peek(8)];
      if (c >= NT) {
        let m = 1 << (16 - 9);
        do {
          c = bitbuf & m ? right[c] : left[c];
          m >>= 1;
        } while (c >= NT);
      }
      fillbuf(pt_len[c]);
      if (c <= 2) {
        if (c === 0) c = 1;
        else if (c === 1) c = getbits(4) + 3;
        else c = getbits(CBIT) + 20;
        while (--c >= 0) c_len[i++] = 0;
      } else {
        c_len[i++] = c - 2;
      }
    }
    while (i < NC) c_len[i++] = 0;
    makeTable(NC, c_len, 12, c_table);
  }

  function decodeC() {
    if (blocksize === 0) {
      blocksize = getbits(16);
      readPtLen(NT, TBIT, 3);
      readCLen();
      readPtLen(NP, PBIT, -1);
    }
    blocksize--;
    let j = c_table[peek(12)];
    if (j >= NC) {
      // The 12 table bits are consumed first, so the node walk resumes from the
      // top of the refilled bitbuf (mask 0x8000), not from below the table bits.
      fillbuf(12);
      let m = 0x8000;
      do {
        j = bitbuf & m ? right[j] : left[j];
        m >>= 1;
      } while (j >= NC);
      fillbuf(c_len[j] - 12);
    } else {
      fillbuf(c_len[j]);
    }
    return j;
  }

  function decodeP() {
    let j = pt_table[peek(8)];
    if (j >= NP) {
      // Same as decodeC: the 8 table bits are consumed before the node walk.
      fillbuf(8);
      let m = 0x8000;
      do {
        j = bitbuf & m ? right[j] : left[j];
        m >>= 1;
      } while (j >= NP);
      fillbuf(pt_len[j] - 8);
    } else {
      fillbuf(pt_len[j]);
    }
    if (j !== 0) j = (1 << (j - 1)) + getbits(j - 1);
    return j;
  }

  while (outPos < originalSize) {
    const c = decodeC();
    if (c < 256) {
      out[outPos++] = c;
    } else {
      let matchLen = c - 256 + THRESHOLD;
      const off = decodeP() + 1;
      let from = outPos - off;
      while (matchLen-- > 0 && outPos < originalSize) {
        out[outPos++] = from >= 0 ? out[from] : 0;
        from++;
      }
    }
  }
  return out;
}

/** Parse LHA level-0/1/2 headers, returning entries with payload slices. */
export function readLhaEntries(buf) {
  // Skip any self-extractor stub: start at the first plausible header whose
  // method id is a known LHA signature.
  let pos = findArchiveStart(buf);
  const entries = [];
  while (pos < buf.length) {
    const headerSize = buf[pos];
    if (headerSize === 0) break; // archive terminator
    const level = buf[pos + 20];
    const method = String.fromCharCode(...buf.subarray(pos + 2, pos + 7));
    const compSize = readU32(buf, pos + 7);
    const origSize = readU32(buf, pos + 11);
    let name = "";
    let dataStart;
    if (level === 0) {
      const nameLen = buf[pos + 21];
      name = latin1(buf, pos + 22, nameLen);
      dataStart = pos + 2 + headerSize;
    } else if (level === 1) {
      const nameLen = buf[pos + 21];
      name = latin1(buf, pos + 22, nameLen);
      // level-1: base header then a chain of extended headers before data.
      dataStart = pos + 2 + headerSize;
      let extPos = dataStart; // extended headers precede the data
      // next-header size is the last 2 bytes of the base header
      let extSize = readU16(buf, pos + 2 + headerSize - 2);
      while (extSize !== 0) {
        extPos += extSize;
        extSize = readU16(buf, extPos - 2);
      }
      dataStart = extPos;
    } else {
      throw new Error(`unsupported LHA header level ${level}`);
    }
    entries.push({ name: name.replace(/\\/g, "/"), method, compSize, origSize, dataStart });
    pos = (level === 1 ? dataStart : pos + 2 + headerSize) + compSize;
    if (level === 0) pos = entries[entries.length - 1].dataStart + compSize;
  }
  return entries;
}

function findArchiveStart(buf) {
  const sigs = ["-lh0-", "-lh4-", "-lh5-", "-lh6-", "-lh7-", "-lhd-"];
  for (let i = 0; i + 7 < buf.length; i++) {
    // A level-0 header has methodid at offset i+2; check header plausibility.
    const m = String.fromCharCode(buf[i + 2], buf[i + 3], buf[i + 4], buf[i + 5], buf[i + 6]);
    if (sigs.includes(m) && buf[i] > 20 && buf[i] < 250) return i;
  }
  throw new Error("no LHA archive found");
}

const readU16 = (b, o) => b[o] | (b[o + 1] << 8);
const readU32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const latin1 = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));
