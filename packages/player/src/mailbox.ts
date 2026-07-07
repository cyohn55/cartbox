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
 * This module is pure — no engine, no DOM — so the protocol is unit-testable.
 */

import type { Light } from "./lighting/types.js";

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
    const intensity = (words[base + 5] ?? LIGHT_INTENSITY_SCALE) / LIGHT_INTENSITY_SCALE;
    lights.push({
      x: words[base] ?? 0,
      y: words[base + 1] ?? 0,
      z: words[base + 2] ?? 0,
      radius: words[base + 3] ?? 0,
      color: [
        (((packed >>> 16) & 0xff) / 255) * intensity,
        (((packed >>> 8) & 0xff) / 255) * intensity,
        ((packed & 0xff) / 255) * intensity,
      ],
    });
  }
  return lights;
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
