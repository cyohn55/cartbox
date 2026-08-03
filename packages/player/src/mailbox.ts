/**
 * Event mailbox decoder (Platform P2).
 *
 * Carts emit platform events (achievements, scores, stats) by writing to a
 * reserved slice of persistent memory via the cartbox SDK. The engine exposes
 * that slice as u32 words; this module decodes new events since the last read.
 *
 * The reserved window is 64 pmem words, shared by two sub-protocols:
 *
 *   Events (words 0..24): word[0] is a monotonic sequence counter; words 1..24
 *   are a ring of {@link EVENT_CAPACITY} 3-word records {type, id, value}. The
 *   host reads the ring every tick, so a small capacity is plenty. A burst that
 *   overflows the ring drops the oldest rather than reading stale data.
 *
 *   Lights (words 25..61): word[25] is a light count; each of up to
 *   {@link LIGHTS_CAPACITY} records is {@link LIGHT_STRIDE} words
 *   {x, y, z, radius, packedRGB, intensity*256}. Unlike events, lights are
 *   per-frame *state*: the cart rewrites the whole block each tick (clear + add),
 *   and the host reads the latest set to relight the frame.
 *
 *   Camera (words 62..63): the parallax-scene backdrop position a cart publishes
 *   via `cartbox.camera(x, y)`, so a gameplay-driven backdrop can pan instead of
 *   only auto-scrolling. Like lights it is per-frame state: two signed
 *   fixed-point words (× {@link CAMERA_SCALE}) for x and y. An unset camera reads
 *   as (0, 0), which adds nothing to the scene's own auto-scroll.
 *
 * This module is pure — no engine, no DOM — so the protocol is unit-testable.
 */

import type { Light, LightKind } from "./lighting/types.js";

export const MAILBOX_TYPE_ACHIEVEMENT = 1;
export const MAILBOX_TYPE_SCORE = 2;
export const MAILBOX_TYPE_PROGRESS = 3;

/** Total reserved pmem words (mirrors CBX_MAILBOX_WORDS in the engine shim). */
export const MAILBOX_WORDS = 64;
/** Event ring capacity. Small on purpose: the host drains the ring every tick. */
export const EVENT_CAPACITY = 8;
/** Word index of the light-count header (just past the event ring). */
export const LIGHTS_BASE = 1 + EVENT_CAPACITY * 3;
/** Maximum cart-emitted lights (matches the renderer's light limit). */
export const LIGHTS_CAPACITY = 6;
/** Words per light record: x, y, z, radius, packedRGB, intensity*256. */
export const LIGHT_STRIDE = 6;
/** Fixed-point scale the SDK multiplies a light's intensity by before storing. */
export const LIGHT_INTENSITY_SCALE = 256;

/** Word index of the cart-published parallax camera, just past the lights block. */
export const CAMERA_BASE = LIGHTS_BASE + 1 + LIGHTS_CAPACITY * LIGHT_STRIDE;
/**
 * Fixed-point scale for the camera's x/y, stored as signed 32-bit words. 16 gives
 * sub-pixel panning (parallax factors scale it further) with a range of ±134M px
 * — far beyond any cart world.
 */
export const CAMERA_SCALE = 16;

/**
 * Directional and spot lights ride in the bits that a point light leaves zero,
 * so the record stays 6 words wide and every existing cart keeps working — an
 * old light simply decodes with kind 0 and no direction. Two words carry the
 * extras:
 *
 *   word[4] (colour):    bits 0..23  = 0xRRGGBB (as before)
 *                        bits 24..25 = light kind (0 point, 1 directional, 2 spot)
 *                        bits 26..31 = spot inner-cone cosine × {@link LIGHT_CONE_SCALE}
 *   word[5] (intensity): bits 0..15  = intensity × {@link LIGHT_INTENSITY_SCALE}
 *                        bits 16..23 = direction x as a signed byte (× {@link LIGHT_DIR_SCALE})
 *                        bits 24..31 = direction y as a signed byte
 *
 * The direction's z is derived as sqrt(1 − x² − y²) — a light on the viewer's
 * side of the scene — so two bytes carry a full unit vector.
 */
export const LIGHT_KIND_POINT = 0;
export const LIGHT_KIND_DIRECTIONAL = 1;
export const LIGHT_KIND_SPOT = 2;
/** Fixed-point scale for a direction component packed as a signed byte. */
export const LIGHT_DIR_SCALE = 127;
/** Fixed-point scale for a spot's inner-cone cosine packed in 6 bits. */
export const LIGHT_CONE_SCALE = 63;

const KIND_BY_CODE: readonly LightKind[] = ["point", "directional", "spot"];

/** Reads a byte as a two's-complement signed value (−128..127). */
function signedByte(byte: number): number {
  return byte < 128 ? byte : byte - 256;
}

export type MailboxEventKind = "achievement" | "score" | "progress" | "unknown";

export interface MailboxEvent {
  kind: MailboxEventKind;
  /** Raw numeric type code. */
  type: number;
  /** Hashed string id (see {@link hashEventId}); 0 for score events. */
  id: number;
  /** Event payload (e.g. the score). */
  value: number;
}

export interface MailboxRead {
  events: MailboxEvent[];
  /** The sequence counter to remember for the next read. */
  seq: number;
}

function kindOf(type: number): MailboxEventKind {
  switch (type) {
    case MAILBOX_TYPE_ACHIEVEMENT:
      return "achievement";
    case MAILBOX_TYPE_SCORE:
      return "score";
    case MAILBOX_TYPE_PROGRESS:
      return "progress";
    default:
      return "unknown";
  }
}

/**
 * Decodes new events from the mailbox words.
 *
 * @param words The mailbox region (word[0] = sequence counter).
 * @param lastSeq The sequence counter from the previous read.
 * @returns The new events and the sequence to remember next time.
 */
export function decodeMailbox(words: Uint32Array, lastSeq: number): MailboxRead {
  const seq = words[0] ?? 0;
  const capacity = words.length > 0 ? EVENT_CAPACITY : 0;
  if (capacity === 0 || seq <= lastSeq) {
    return { events: [], seq };
  }

  // Never read more than a full ring's worth (older entries were overwritten).
  const start = Math.max(lastSeq, seq - capacity);
  const events: MailboxEvent[] = [];
  for (let i = start; i < seq; i++) {
    const slot = i % capacity;
    const base = 1 + slot * 3;
    const type = words[base] ?? 0;
    events.push({
      type,
      kind: kindOf(type),
      id: words[base + 1] ?? 0,
      value: words[base + 2] ?? 0,
    });
  }
  return { events, seq };
}

/**
 * Decodes the lights a cart wrote this frame via `cartbox.light(...)`.
 *
 * Lights are per-frame state, not events: the block always holds the latest set
 * the cart published, so there is no sequence to track. Colours are stored as a
 * packed 0xRRGGBB word scaled by a fixed-point intensity; here they become the
 * renderer's per-channel multipliers.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 * @returns The decoded lights, clamped to {@link LIGHTS_CAPACITY}.
 */
export function decodeLights(words: Uint32Array): Light[] {
  if (words.length <= LIGHTS_BASE) {
    return [];
  }
  const count = Math.min(words[LIGHTS_BASE] ?? 0, LIGHTS_CAPACITY);
  const lights: Light[] = [];
  for (let i = 0; i < count; i++) {
    const base = LIGHTS_BASE + 1 + i * LIGHT_STRIDE;
    const packed = words[base + 4] ?? 0xffffff;
    const intensityWord = words[base + 5] ?? LIGHT_INTENSITY_SCALE;
    const intensity = (intensityWord & 0xffff) / LIGHT_INTENSITY_SCALE;
    const light: Light = {
      x: words[base] ?? 0,
      y: words[base + 1] ?? 0,
      z: words[base + 2] ?? 0,
      radius: words[base + 3] ?? 0,
      color: [
        (((packed >>> 16) & 0xff) / 255) * intensity,
        (((packed >>> 8) & 0xff) / 255) * intensity,
        ((packed & 0xff) / 255) * intensity,
      ],
    };

    // A point light leaves all the extra bits zero, so decode them only when a
    // producer set the kind — keeping the common case byte-for-byte unchanged.
    const kindCode = (packed >>> 24) & 0x3;
    if (kindCode !== LIGHT_KIND_POINT) {
      light.kind = KIND_BY_CODE[kindCode] ?? "point";
      const dirX = signedByte((intensityWord >>> 16) & 0xff) / LIGHT_DIR_SCALE;
      const dirY = signedByte((intensityWord >>> 24) & 0xff) / LIGHT_DIR_SCALE;
      const dirZ = Math.sqrt(Math.max(0, 1 - dirX * dirX - dirY * dirY));
      light.direction = [dirX, dirY, dirZ];
      if (kindCode === LIGHT_KIND_SPOT) {
        light.coneCos = ((packed >>> 26) & 0x3f) / LIGHT_CONE_SCALE;
      }
    }
    lights.push(light);
  }
  return lights;
}

/** A backdrop camera position in cart pixels. */
export interface MailboxCamera {
  x: number;
  y: number;
}

/**
 * Decodes the parallax-scene camera a cart published this frame via
 * `cartbox.camera(x, y)`.
 *
 * The two words are signed fixed-point: reinterpreted from u32 to int32 (`| 0`)
 * and divided by {@link CAMERA_SCALE}. A cart that never calls `cartbox.camera`
 * leaves the words zero, so this returns (0, 0) — which the scene adds to its own
 * auto-scroll, leaving auto-scroll-only carts unchanged.
 *
 * @param words The mailbox window (same array {@link decodeMailbox} reads).
 */
export function decodeCamera(words: Uint32Array): MailboxCamera {
  if (words.length <= CAMERA_BASE + 1) {
    return { x: 0, y: 0 };
  }
  return {
    x: ((words[CAMERA_BASE] ?? 0) | 0) / CAMERA_SCALE,
    y: ((words[CAMERA_BASE + 1] ?? 0) | 0) / CAMERA_SCALE,
  };
}

/**
 * FNV-1a 32-bit hash of a string event id. Mirrors the hash in the cartbox SDK
 * so the platform can map a mailbox id back to the achievement/stat key.
 */
export function hashEventId(id: string): number {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash ^ id.charCodeAt(i)) >>> 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
