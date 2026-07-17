/**
 * The editable backdrop prop set: the serialisable data behind the onboarding
 * scene's 3D props (arcade cabinet, star, heart, controller, …). Turning the
 * props from hardcoded sprites into this data model is what makes them editable
 * and publishable — a committed `props.json` every visitor loads, plus a local
 * working copy the manager and editor edit (see backdropPropsStore.ts).
 *
 * Each prop stores its pixel art as base64 (albedo RGBA + an emissive plane),
 * its depth, its placement, and its bob/spin motion. Everything here is pure and
 * dep-free (no editor barrel, no DOM), so it loads under the node TS hook and
 * the same encode/decode + validation gate runs in the app and the tests. The
 * extrusion into voxel models lives in retroVoxels.ts.
 */

import type { MotionParams } from "./bobSpin";
import { PROP_SPECS, spriteToPixels } from "./retroVoxelSpecs";

/** A partial motion update (used by the manager's per-field edits). */
export type MotionPatch = Partial<MotionParams>;

/** A prop's pixels: straight-alpha RGBA albedo + a 0..255 emissive plane. */
export interface PropArt {
  readonly width: number;
  readonly height: number;
  /** base64 of width*height*4 RGBA bytes. */
  readonly albedo: string;
  /** base64 of width*height emissive bytes. */
  readonly emissive: string;
}

/** One editable prop. A prop is either a 2D sprite (`art`, extruded) or a true
 * 3D voxel model (`voxel`, a serialized VoxelGrid) — exactly one is present. */
export interface StoredBackdropProp {
  readonly id: string;
  readonly name: string;
  /** 2D pixel art, extruded by `depth`. Absent for voxel props. */
  readonly art?: PropArt;
  /** Serialized 3D voxel grid. Absent for sprite props. */
  readonly voxel?: string;
  /** Extrusion depth for a sprite prop; ignored for voxel props. */
  readonly depth: number;
  /** Centre anchor as a fraction of the backdrop (0..1). */
  readonly fx: number;
  readonly fy: number;
  /** Backdrop-buffer pixels per voxel. */
  readonly cell: number;
  readonly motion: MotionParams;
}

/** The whole scene: a versioned list of props. */
export interface BackdropPropSet {
  readonly version: number;
  readonly props: readonly StoredBackdropProp[];
}

export const BACKDROP_PROP_SET_VERSION = 1;

// Bounds for the untrusted-input gate. Props are small pixel art; the scene is a
// handful of them.
const MAX_DIM = 64;
const MAX_PROPS = 40;
const MAX_DEPTH = 32;
const MAX_CELL = 8;
// A 32³ grid serializes to ~230KB of base64; bound it generously. The strict
// grid validation (dims, byte lengths) happens in deserializeVoxelGrid when the
// model is built — this module stays free of the editor/WASM barrel.
const MAX_VOXEL_CHARS = 400_000;

// --- base64 <-> bytes (portable across node >=16 and browsers) ---------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decode a base64 string to raw bytes (e.g. a pending edit's albedo plane). */
export function decodeBase64Bytes(base64: string): Uint8Array {
  return base64ToBytes(base64);
}

/** Pack pixels into a PropArt (albedo RGBA + emissive plane) as base64. */
export function encodePropArt(
  albedo: Uint8ClampedArray,
  emissive: Uint8Array,
  width: number,
  height: number,
): PropArt {
  return {
    width,
    height,
    albedo: bytesToBase64(new Uint8Array(albedo.buffer, albedo.byteOffset, albedo.length)),
    emissive: bytesToBase64(emissive),
  };
}

/** Decode a PropArt back to typed pixel planes. */
export function decodePropArt(art: PropArt): {
  albedo: Uint8ClampedArray;
  emissive: Uint8Array;
  width: number;
  height: number;
} {
  return {
    albedo: new Uint8ClampedArray(base64ToBytes(art.albedo)),
    emissive: base64ToBytes(art.emissive),
    width: art.width,
    height: art.height,
  };
}

// --- validation gate ---------------------------------------------------------

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Coerce untrusted motion into safe, bounded parameters. */
function normalizeMotion(value: unknown): MotionParams | null {
  if (typeof value !== "object" || value === null) return null;
  const m = value as Record<string, unknown>;
  const fields = ["bobAmplitude", "bobPeriod", "bobPhase", "spinCycle", "spinDuration", "spinPhase"];
  for (const field of fields) if (!isFiniteNumber(m[field])) return null;

  const spinCycle = clamp(m.spinCycle as number, 0.5, 600);
  return {
    bobAmplitude: clamp(m.bobAmplitude as number, 0, 40),
    bobPeriod: clamp(m.bobPeriod as number, 0.2, 60),
    bobPhase: clamp(m.bobPhase as number, 0, 1),
    spinCycle,
    spinDuration: clamp(m.spinDuration as number, 0.2, spinCycle),
    spinPhase: clamp(m.spinPhase as number, 0, 1),
  };
}

/** Validate a base64 string decodes to exactly `expectedBytes` bytes. */
function base64HasLength(value: unknown, expectedBytes: number): value is string {
  if (typeof value !== "string") return false;
  try {
    return base64ToBytes(value).length === expectedBytes;
  } catch {
    return false;
  }
}

/** Coerce untrusted art; returns null if malformed or out of bounds. */
function normalizePropArt(value: unknown): PropArt | null {
  if (typeof value !== "object" || value === null) return null;
  const art = value as Record<string, unknown>;
  const { width, height } = art;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (!base64HasLength(art.albedo, width * height * 4)) return null;
  if (!base64HasLength(art.emissive, width * height)) return null;
  return { width, height, albedo: art.albedo, emissive: art.emissive };
}

/** Coerce an untrusted serialized voxel grid: a bounded non-empty string. */
function normalizeVoxel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VOXEL_CHARS) return null;
  return trimmed;
}

/** Coerce one untrusted prop; returns null if it cannot be made valid. */
function normalizeProp(value: unknown): StoredBackdropProp | null {
  if (typeof value !== "object" || value === null) return null;
  const p = value as Record<string, unknown>;
  const art = normalizePropArt(p.art);
  const voxel = normalizeVoxel(p.voxel);
  const motion = normalizeMotion(p.motion);
  if (!motion) return null;
  if (!art && !voxel) return null; // a prop must carry geometry (sprite or voxel)
  if (typeof p.id !== "string" || p.id.length === 0 || p.id.length > 64) return null;
  if (!isFiniteNumber(p.fx) || !isFiniteNumber(p.fy) || !isFiniteNumber(p.cell)) return null;
  return {
    id: p.id,
    name: typeof p.name === "string" ? p.name.slice(0, 64) : p.id,
    ...(art ? { art } : {}),
    ...(voxel ? { voxel } : {}),
    depth: clamp(Math.round(isFiniteNumber(p.depth) ? p.depth : 1), 1, MAX_DEPTH),
    fx: clamp(p.fx, -0.2, 1.2),
    fy: clamp(p.fy, -0.2, 1.2),
    cell: clamp(Math.round(p.cell), 1, MAX_CELL),
    motion,
  };
}

/**
 * Validate an untrusted value (parsed JSON, localStorage, a fetched file) into a
 * safe prop set, or null if it is not a recognisable set. Individual malformed
 * props are dropped rather than failing the whole set.
 */
export function normalizePropSet(value: unknown): BackdropPropSet | null {
  if (typeof value !== "object" || value === null) return null;
  const set = value as Record<string, unknown>;
  if (!Array.isArray(set.props)) return null;
  const props = set.props
    .slice(0, MAX_PROPS)
    .map(normalizeProp)
    .filter((p): p is StoredBackdropProp => p !== null);
  return { version: isFiniteNumber(set.version) ? set.version : BACKDROP_PROP_SET_VERSION, props };
}

/** A gentle bob + occasional slow spin, the starting motion for a new prop. */
export const DEFAULT_PROP_MOTION: MotionParams = {
  bobAmplitude: 3,
  bobPeriod: 4,
  bobPhase: 0,
  spinCycle: 12,
  spinDuration: 6,
  spinPhase: 0,
};

/**
 * Build a fresh voxel-model prop for the working set, centred on the backdrop
 * with default motion. Placement and motion are tuned afterwards in the manager.
 */
export function createVoxelBackdropProp(id: string, name: string, voxel: string): StoredBackdropProp {
  return { id, name, voxel, depth: 1, fx: 0.5, fy: 0.5, cell: 2, motion: DEFAULT_PROP_MOTION };
}

/** Serialise a set to a JSON string. */
export function serializePropSet(set: BackdropPropSet): string {
  return JSON.stringify(set);
}

/** Parse + validate a JSON string into a set, or null. */
export function deserializePropSet(json: string): BackdropPropSet | null {
  try {
    return normalizePropSet(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * The built-in prop set, derived from the code-defined {@link PROP_SPECS}. This
 * is the seed for the committed `props.json` and the guaranteed fallback when no
 * set has been published or a stored one fails to load.
 */
export const DEFAULT_BACKDROP_PROP_SET: BackdropPropSet = {
  version: BACKDROP_PROP_SET_VERSION,
  props: PROP_SPECS.map((spec, index) => {
    const { albedo, emissive, width, height } = spriteToPixels(spec.sprite);
    return {
      id: `default-${index}`,
      name: spec.name,
      art: encodePropArt(albedo, emissive, width, height),
      depth: spec.depth,
      fx: spec.fx,
      fy: spec.fy,
      cell: spec.cell,
      motion: spec.motion,
    };
  }),
};
