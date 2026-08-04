/**
 * CollisionMap — a per-cell solidity layer laid over the cart's map grid.
 *
 * The tile, pixel and column layers describe how the map *looks*; collision
 * describes how it *behaves* — which cells a game should treat as solid ground
 * or walls. It is one boolean per map cell, held as a packed bitmap so even a
 * full 240×136 map costs a few kilobytes, and it serialises to a compact,
 * platform-independent payload (little-endian packed bits, base64) for storage
 * alongside the cart.
 *
 * Pure (no DOM), like {@link TileMap} and {@link VoxelGrid}, so the map canvas,
 * the save path and the unit tests all drive it identically.
 */

/** Format version of the serialised collision payload; bumped on any schema change. */
export const COLLISION_MAP_VERSION = 1 as const;

/** The stored shape of a collision layer: its dimensions and packed solidity bits. */
export interface CollisionData {
  version: typeof COLLISION_MAP_VERSION;
  /** Grid width in cells, so a payload can be remapped onto a different-sized map. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** Base64 of the row-major, LSB-first packed solidity bits (ceil(w*h/8) bytes). */
  bits: string;
}

export class CollisionMap {
  readonly width: number;
  readonly height: number;
  /** Row-major solidity bits, one per cell, LSB-first within each byte. */
  private readonly bits: Uint8Array;

  constructor(width: number, height: number) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.bits = new Uint8Array(Math.ceil((this.width * this.height) / 8));
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  /** Whether the cell at (x, y) is marked solid. Out-of-bounds reads as false. */
  isSolid(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    const cell = y * this.width + x;
    return (this.bits[cell >> 3]! & (1 << (cell & 7))) !== 0;
  }

  /** Mark the cell at (x, y) solid or clear. Out-of-bounds is a no-op. */
  setSolid(x: number, y: number, solid: boolean): void {
    if (!this.inBounds(x, y)) return;
    const cell = y * this.width + x;
    const byte = cell >> 3;
    const mask = 1 << (cell & 7);
    if (solid) this.bits[byte]! |= mask;
    else this.bits[byte]! &= ~mask;
  }

  /** Flip the solidity of the cell at (x, y). Out-of-bounds is a no-op. */
  toggle(x: number, y: number): void {
    this.setSolid(x, y, !this.isSolid(x, y));
  }

  /**
   * Flood the contiguous run of cells sharing the start cell's solidity, setting
   * them all to `solid`. Mirrors {@link TileMap.fill}: a no-op when the start
   * cell already matches the target, so filling solid over solid does nothing.
   */
  fill(x: number, y: number, solid: boolean): void {
    if (!this.inBounds(x, y)) return;
    const target = this.isSolid(x, y);
    if (target === solid) return;

    const stack: Array<[number, number]> = [[x, y]];
    while (stack.length > 0) {
      const [cx, cy] = stack.pop()!;
      if (!this.inBounds(cx, cy)) continue;
      if (this.isSolid(cx, cy) !== target) continue;
      this.setSolid(cx, cy, solid);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  /** Clear every cell back to non-solid. */
  clear(): void {
    this.bits.fill(0);
  }

  /** How many cells are marked solid. */
  get solidCount(): number {
    let count = 0;
    for (const byte of this.bits) {
      // Brian Kernighan's population count: one iteration per set bit.
      let value = byte;
      while (value !== 0) {
        value &= value - 1;
        count += 1;
      }
    }
    return count;
  }

  /** Whether no cell is marked solid — the state a cart with no collision authored has. */
  get isEmpty(): boolean {
    return this.solidCount === 0;
  }

  /** Serialise to a compact, platform-independent payload for cart storage. */
  serialize(): CollisionData {
    return {
      version: COLLISION_MAP_VERSION,
      width: this.width,
      height: this.height,
      bits: bytesToBase64(this.bits),
    };
  }

  /**
   * Rebuild a collision layer for a map of the given size from a stored payload.
   *
   * The target dimensions are authoritative — the map's own — so a payload saved
   * at a different size is remapped by copying only the overlapping region rather
   * than trusting the payload's extent. A missing or malformed payload yields an
   * empty layer, so an unmigrated cart (no column) simply opens with no collision.
   */
  static deserialize(data: unknown, width: number, height: number): CollisionMap {
    const map = new CollisionMap(width, height);
    if (!isCollisionData(data)) return map;

    const bytes = base64ToBytes(data.bits);
    const source = new CollisionMap(data.width, data.height);
    // Guard against a truncated payload: only copy the bits the buffer actually
    // holds, so a corrupt string can never overrun the source grid.
    source.bits.set(bytes.subarray(0, source.bits.length));

    const copyWidth = Math.min(width, data.width);
    const copyHeight = Math.min(height, data.height);
    for (let y = 0; y < copyHeight; y += 1) {
      for (let x = 0; x < copyWidth; x += 1) {
        if (source.isSolid(x, y)) map.setSolid(x, y, true);
      }
    }
    return map;
  }
}

/** Validate an untrusted value as a CollisionData payload before trusting its fields. */
export function isCollisionData(value: unknown): value is CollisionData {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === COLLISION_MAP_VERSION &&
    typeof data.width === "number" &&
    typeof data.height === "number" &&
    data.width >= 0 &&
    data.height >= 0 &&
    typeof data.bits === "string"
  );
}

// --- Serialisation helpers (portable base64, no Buffer dependency) -----------
// Mirrors VoxelGrid's helpers so both models round-trip identically in the
// browser (btoa/atob) and under Node's test runner.

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
