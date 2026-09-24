/**
 * Deterministic RNG seeding via cart-code injection.
 *
 * Cart randomness comes from the scripting language's own RNG (e.g. Lua's
 * math.random), which each language auto-seeds non-deterministically. A single
 * engine-level seed can't reach it. The robust, engine-agnostic fix is to seed
 * the language RNG from the cart itself: we inject a `math.randomseed(<seed>)`
 * prologue into the CODE chunk before loading, so a replay that reuses the same
 * seed reproduces the same random sequence.
 *
 * This is pure and testable. It currently covers Lua (TIC-80's default and most
 * common language); carts marked as another language are returned unchanged.
 *
 * .tic chunk header (4 bytes, LE): [type(5 bits) | bank(3 bits)][size lo][size hi][reserved]
 * (a CODE chunk's size 0 means a full 64 KB bank).
 */

/** CHUNK_CODE and CHUNK_BINARY in TIC-80's cart format. */
const CHUNK_CODE = 5;
const CHUNK_BINARY = 19;

/**
 * Code lives in up to 8 banks of 64 KB. The engine joins the CODE chunks from
 * the highest bank down to bank 0, and a chunk whose 16-bit size reads 0 holds a
 * full 64 KB bank (65536 does not fit the field).
 */
const CODE_BANK_SIZE = 0x10000;
const CODE_BANKS = 8;
/** The code must stay NUL-terminated inside the engine's 512 KB code buffer. */
const MAX_CODE_BYTES = CODE_BANK_SIZE * CODE_BANKS - 1;

interface Chunk {
  headerStart: number;
  dataStart: number;
  dataEnd: number;
  type: number;
  bank: number;
}

/** Walks the cart's chunks, sizing them exactly as the engine does. */
function chunks(bytes: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const byte0 = bytes[offset] ?? 0;
    const type = byte0 & 0x1f;
    const field = (bytes[offset + 1] ?? 0) | ((bytes[offset + 2] ?? 0) << 8);
    const size = field === 0 && (type === CHUNK_CODE || type === CHUNK_BINARY) ? CODE_BANK_SIZE : field;
    const dataStart = offset + 4;
    const dataEnd = Math.min(dataStart + size, bytes.length);
    out.push({ headerStart: offset, dataStart, dataEnd, type, bank: byte0 >> 5 });
    offset = dataStart + size;
  }
  return out;
}

/** The cart's code as the engine assembles it (banks high → low), or null. */
function joinedCode(bytes: Uint8Array): { code: Uint8Array; chunks: Chunk[] } | null {
  const all = chunks(bytes);
  const byBank = new Map<number, Chunk>();
  for (const chunk of all) if (chunk.type === CHUNK_CODE) byBank.set(chunk.bank, chunk); // the last one per bank wins
  const banks = [...byBank.keys()].sort((a, b) => b - a);
  const parts = banks.map((bank) => bytes.subarray(byBank.get(bank)!.dataStart, byBank.get(bank)!.dataEnd));
  const length = parts.reduce((n, part) => n + part.length, 0);
  if (length === 0) return null;
  const code = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    code.set(part, at);
    at += part.length;
  }
  // The engine reads the code as a C string: it ends at the first NUL.
  const nul = code.indexOf(0);
  return { code: nul >= 0 ? code.subarray(0, nul) : code, chunks: all.filter((chunk) => chunk.type === CHUNK_CODE) };
}

/**
 * CODE chunks carrying `code`, split into 64 KB banks the way the engine saves
 * them: the start of the code in the highest bank used, the end in bank 0.
 */
export function codeChunks(code: Uint8Array): Uint8Array {
  const count = Math.max(1, Math.ceil(code.length / CODE_BANK_SIZE));
  const out = new Uint8Array(code.length + count * 4);
  let at = 0;
  for (let k = 0; k < count; k += 1) {
    const slice = code.subarray(k * CODE_BANK_SIZE, (k + 1) * CODE_BANK_SIZE);
    const bank = count - 1 - k;
    out.set([CHUNK_CODE | (bank << 5), slice.length & 0xff, (slice.length >> 8) & 0xff, 0], at);
    out.set(slice, at + 4);
    at += 4 + slice.length;
  }
  return out;
}

/** Detects the cart language from a `script:` marker on the first line; defaults to Lua. */
function detectLanguage(code: string): string {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/script:\s*([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() ?? "lua";
}

/** Returns the cart's source code (all its code banks, joined), or null if absent. */
export function readCartCode(bytes: Uint8Array): string | null {
  const joined = joinedCode(bytes);
  return joined ? new TextDecoder().decode(joined.code) : null;
}

/**
 * Returns a copy of the cartridge with `prelude` (plus a newline) prepended to
 * its Lua code. The code is re-split across as many 64 KB banks as it needs, so
 * a large cart still gets its prelude. Non-Lua carts, carts without code, or
 * code that would outgrow the engine's 512 KB are returned unchanged.
 *
 * Shared by RNG seeding and SDK injection.
 */
export function prependLuaCode(bytes: Uint8Array, prelude: string): Uint8Array {
  const joined = joinedCode(bytes);
  if (!joined) {
    return bytes;
  }

  const code = new TextDecoder().decode(joined.code);
  if (detectLanguage(code) !== "lua") {
    return bytes;
  }

  const merged = new TextEncoder().encode(`${prelude}\n${code}`);
  if (merged.length > MAX_CODE_BYTES) {
    return bytes;
  }

  // Replace every CODE chunk with the new ones, where the first one stood.
  const replacement = codeChunks(merged);
  const first = joined.chunks[0]!;
  const kept: Uint8Array[] = [];
  let cursor = 0;
  for (const chunk of joined.chunks) {
    kept.push(bytes.subarray(cursor, chunk.headerStart));
    if (chunk === first) kept.push(replacement);
    cursor = chunk.dataEnd;
  }
  kept.push(bytes.subarray(cursor));
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of kept) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Returns a copy of the cartridge with a deterministic RNG seed injected into
 * its Lua code, so a replay reusing the same seed reproduces the randomness.
 *
 * @param bytes Original cartridge bytes.
 * @param seed Seed to make the language RNG reproducible.
 */
export function seedCartridge(bytes: Uint8Array, seed: number): Uint8Array {
  return prependLuaCode(bytes, `math.randomseed(${Math.trunc(seed)})`);
}
