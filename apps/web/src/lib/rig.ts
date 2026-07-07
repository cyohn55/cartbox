/**
 * Server-safe validation for the character-rig sidecar. The editor package owns
 * the rich SpriteRig model, but server code (API route, server component) must
 * stay free of that package's client/DOM code — mirroring lib/consoleModel and
 * lib/starter. So this module re-declares the wire shape and validates untrusted
 * JSON (a PUT body or a jsonb column) structurally, rejecting anything malformed
 * rather than storing or loading garbage that could break the editor.
 *
 * The wire shape is structurally identical to SpriteRig / SpriteRigPart, so the
 * editor consumes a parsed WireRig directly.
 */

export interface WireRigPart {
  readonly name: string;
  readonly page: 0 | 1;
  readonly baseTile: number;
  readonly blockTiles: number;
  readonly depthOffset: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly unitsPerPixel: number;
}

export interface WireRig {
  readonly parts: readonly WireRigPart[];
  readonly pivotDepth: number;
  readonly colorKey: number;
}

/** A rig can hold at most one plane per named part, with headroom to spare. */
export const MAX_RIG_PARTS = 16;

/** Block sizes the editor offers (tiles per side). */
const VALID_BLOCK_TILES = new Set([1, 2, 4]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A finite number within [min, max], else null. */
function boundedNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  return value;
}

/** A finite integer within [min, max], else null. */
function boundedInteger(value: unknown, min: number, max: number): number | null {
  const number = boundedNumber(value, min, max);
  return number !== null && Number.isInteger(number) ? number : null;
}

function parsePart(value: unknown): WireRigPart | null {
  if (!isRecord(value)) return null;

  const { name } = value;
  if (typeof name !== "string" || name.length === 0 || name.length > 32) return null;

  const page = value.page === 0 || value.page === 1 ? value.page : null;
  const baseTile = boundedInteger(value.baseTile, 0, 255);
  const blockTiles = boundedInteger(value.blockTiles, 1, 4);
  const depthOffset = boundedNumber(value.depthOffset, -64, 64);
  const offsetX = boundedNumber(value.offsetX, -256, 256);
  const offsetY = boundedNumber(value.offsetY, -256, 256);
  const unitsPerPixel = boundedNumber(value.unitsPerPixel, 0.0001, 16);

  if (
    page === null ||
    baseTile === null ||
    blockTiles === null ||
    !VALID_BLOCK_TILES.has(blockTiles) ||
    depthOffset === null ||
    offsetX === null ||
    offsetY === null ||
    unitsPerPixel === null
  ) {
    return null;
  }

  return { name, page, baseTile, blockTiles, depthOffset, offsetX, offsetY, unitsPerPixel };
}

/**
 * Validate untrusted JSON into a WireRig, or null when malformed. Strict: any
 * bad part rejects the whole rig, since the client only ever sends valid data
 * and a null simply means "no rig".
 */
export function parseRig(value: unknown): WireRig | null {
  if (!isRecord(value) || !Array.isArray(value.parts)) return null;
  if (value.parts.length > MAX_RIG_PARTS) return null;

  const pivotDepth = boundedNumber(value.pivotDepth, 0.5, 1000);
  const colorKey = boundedInteger(value.colorKey, 0, 63);
  if (pivotDepth === null || colorKey === null) return null;

  const parts: WireRigPart[] = [];
  const seen = new Set<string>();
  for (const rawPart of value.parts) {
    const part = parsePart(rawPart);
    if (!part || seen.has(part.name)) return null; // no duplicates, no garbage
    seen.add(part.name);
    parts.push(part);
  }

  return { parts, pivotDepth, colorKey };
}
