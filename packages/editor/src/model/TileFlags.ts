/**
 * TileFlags — a per-cell gameplay-property layer laid over the cart's map grid.
 *
 * Where {@link CollisionMap} answers the single question "is this cell solid?",
 * TileFlags carries eight independent boolean properties per cell — hazard,
 * ladder, one-way platform, water, trigger zones, and so on — so a cart can tag
 * the world with whatever its rules need beyond solidity. It is one byte per map
 * cell (eight bit-planes), held packed and serialised to a compact,
 * platform-independent payload for storage alongside the cart.
 *
 * The flag *meanings* are the cart's to define; the labels here are only the
 * editor's suggestions. Pure (no DOM), like {@link TileMap} and
 * {@link CollisionMap}, so the map canvas, the save path and the tests drive it
 * identically.
 */

/** Format version of the serialised flags payload; bumped on any schema change. */
export const TILE_FLAGS_VERSION = 1 as const;

/** Number of independent flags per cell (one byte). */
export const FLAG_COUNT = 8;

/**
 * Suggested editor labels for the eight flags. Purely advisory — the runtime
 * exposes flags by index (`cartbox.flag(cx, cy, n)`), and a cart may read any
 * flag for any purpose. Deliberately does NOT include "solid": solidity is the
 * dedicated CollisionMap layer, so these cover the properties beyond it.
 */
export const FLAG_LABELS: readonly string[] = [
  "hazard",
  "ladder",
  "platform",
  "water",
  "trigger",
  "zone A",
  "zone B",
  "zone C",
];

/** The stored shape of a flags layer: its dimensions and packed per-cell bytes. */
export interface FlagData {
  version: typeof TILE_FLAGS_VERSION;
  /** Grid width in cells, so a payload can be remapped onto a different-sized map. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** Base64 of the row-major, one-byte-per-cell flag bytes (width*height bytes). */
  bytes: string;
}

export class TileFlags {
  readonly width: number;
  readonly height: number;
  /** Row-major, one byte per cell; bit n is flag n. */
  private readonly cells: Uint8Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.cells = new Uint8Array(this.width * this.height);
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  private validBit(bit: number): boolean {
    return bit >= 0 && bit < FLAG_COUNT;
  }

  /** Whether flag `bit` is set at (x, y). Out-of-bounds / invalid bit reads as false. */
  get(x: number, y: number, bit: number): boolean {
    if (!this.inBounds(x, y) || !this.validBit(bit)) return false;
    return (this.cells[y * this.width + x]! & (1 << bit)) !== 0;
  }

  /** Set or clear flag `bit` at (x, y). Out-of-bounds / invalid bit is a no-op. */
  set(x: number, y: number, bit: number, on: boolean): void {
    if (!this.inBounds(x, y) || !this.validBit(bit)) return;
    const index = y * this.width + x;
    const mask = 1 << bit;
    if (on) this.cells[index]! |= mask;
    else this.cells[index]! &= ~mask;
  }

  /** Flip flag `bit` at (x, y). */
  toggle(x: number, y: number, bit: number): void {
    this.set(x, y, bit, !this.get(x, y, bit));
  }

  /** The whole flag byte at (x, y) — all eight flags at once. */
  byteAt(x: number, y: number): number {
    return this.inBounds(x, y) ? this.cells[y * this.width + x]! : 0;
  }

  /**
   * Flood the contiguous run of cells sharing the start cell's value for flag
   * `bit`, setting them all to `on`. Mirrors {@link CollisionMap.fill}: a no-op
   * when the start cell already matches, and it flows only across cells whose
   * bit matches the start's, so filling respects existing borders of that flag.
   */
  fill(x: number, y: number, bit: number, on: boolean): void {
    if (!this.inBounds(x, y) || !this.validBit(bit)) return;
    const target = this.get(x, y, bit);
    if (target === on) return;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      if (!this.inBounds(cx, cy)) continue;
      if (this.get(cx, cy, bit) !== target) continue;
      this.set(cx, cy, bit, on);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  /** Clear one flag across every cell, leaving the others untouched. */
  clearBit(bit: number): void {
    if (!this.validBit(bit)) return;
    const mask = ~(1 << bit);
    for (let i = 0; i < this.cells.length; i += 1) this.cells[i]! &= mask;
  }

  /** Clear every flag on every cell. */
  clearAll(): void {
    this.cells.fill(0);
  }

  /** How many cells have flag `bit` set. */
  countBit(bit: number): number {
    if (!this.validBit(bit)) return 0;
    const mask = 1 << bit;
    let count = 0;
    for (const cell of this.cells) if ((cell & mask) !== 0) count += 1;
    return count;
  }

  /** Whether no flag is set anywhere — the state a cart with no tagging has. */
  get isEmpty(): boolean {
    for (const cell of this.cells) if (cell !== 0) return false;
    return true;
  }

  /** Serialise to a compact, platform-independent payload for cart storage. */
  serialize(): FlagData {
    return {
      version: TILE_FLAGS_VERSION,
      width: this.width,
      height: this.height,
      bytes: bytesToBase64(this.cells),
    };
  }

  /**
   * Rebuild a flags layer for a map of the given size from a stored payload.
   *
   * The target dimensions are authoritative — the map's own — so a payload saved
   * at a different size is remapped by copying only the overlapping region. A
   * missing or malformed payload yields an empty layer, so an unmigrated cart
   * simply opens with no flags.
   */
  static deserialize(data: unknown, width: number, height: number): TileFlags {
    const flags = new TileFlags(width, height);
    if (!isFlagData(data)) return flags;

    const bytes = base64ToBytes(data.bytes);
    const copyWidth = Math.min(width, data.width);
    const copyHeight = Math.min(height, data.height);
    for (let y = 0; y < copyHeight; y += 1) {
      for (let x = 0; x < copyWidth; x += 1) {
        const value = bytes[y * data.width + x] ?? 0;
        if (value !== 0) flags.cells[y * width + x] = value;
      }
    }
    return flags;
  }
}

/** Validate an untrusted value as a FlagData payload before trusting its fields. */
export function isFlagData(value: unknown): value is FlagData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === TILE_FLAGS_VERSION &&
    typeof data.width === "number" &&
    typeof data.height === "number" &&
    data.width >= 0 &&
    data.height >= 0 &&
    typeof data.bytes === "string"
  );
}

// --- Serialisation helpers (portable base64, no Buffer dependency) -----------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
