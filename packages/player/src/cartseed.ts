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
 */

/** CHUNK_CODE in TIC-80's cart format. */
const CHUNK_CODE = 5;

/** 16-bit chunk size ceiling; we cannot grow a chunk past this. */
const MAX_CHUNK_SIZE = 0xffff;

interface CodeChunk {
  headerStart: number;
  dataStart: number;
  dataEnd: number;
  headerByte0: number;
  reserved: number;
}

/** Finds the first non-empty CODE chunk, or null if there isn't one. */
function locateCodeChunk(bytes: Uint8Array): CodeChunk | null {
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const headerByte0 = bytes[offset] ?? 0;
    const type = headerByte0 & 0x1f;
    const size = (bytes[offset + 1] ?? 0) | ((bytes[offset + 2] ?? 0) << 8);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;

    if (type === CHUNK_CODE && size > 0 && dataEnd <= bytes.length) {
      return { headerStart: offset, dataStart, dataEnd, headerByte0, reserved: bytes[offset + 3] ?? 0 };
    }
    offset = dataEnd;
  }
  return null;
}

/** Detects the cart language from a `script:` marker on the first line; defaults to Lua. */
function detectLanguage(code: string): string {
  const firstLine = code.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/script:\s*([a-z0-9]+)/i);
  return match?.[1]?.toLowerCase() ?? "lua";
}

/** Returns the cart's source code (first CODE chunk), or null if absent. */
export function readCartCode(bytes: Uint8Array): string | null {
  const chunk = locateCodeChunk(bytes);
  if (!chunk) {
    return null;
  }
  return new TextDecoder().decode(bytes.subarray(chunk.dataStart, chunk.dataEnd));
}

/**
 * Returns a copy of the cartridge with `prelude` (plus a newline) prepended to
 * its Lua code chunk. Non-Lua carts, carts without a code chunk, or carts that
 * would overflow the 16-bit chunk size are returned unchanged.
 *
 * Shared by RNG seeding and SDK injection.
 */
export function prependLuaCode(bytes: Uint8Array, prelude: string): Uint8Array {
  const chunk = locateCodeChunk(bytes);
  if (!chunk) {
    return bytes;
  }

  const code = new TextDecoder().decode(bytes.subarray(chunk.dataStart, chunk.dataEnd));
  if (detectLanguage(code) !== "lua") {
    return bytes;
  }

  const merged = `${prelude}\n${code}`;
  const mergedData = new TextEncoder().encode(merged);
  if (mergedData.length > MAX_CHUNK_SIZE) {
    return bytes;
  }

  const before = bytes.subarray(0, chunk.headerStart);
  const after = bytes.subarray(chunk.dataEnd);
  const header = new Uint8Array([
    chunk.headerByte0,
    mergedData.length & 0xff,
    (mergedData.length >> 8) & 0xff,
    chunk.reserved,
  ]);

  const out = new Uint8Array(before.length + header.length + mergedData.length + after.length);
  out.set(before, 0);
  out.set(header, before.length);
  out.set(mergedData, before.length + header.length);
  out.set(after, before.length + header.length + mergedData.length);
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
