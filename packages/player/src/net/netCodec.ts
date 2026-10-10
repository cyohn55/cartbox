/**
 * Netplay messages on the wire (LOCKOUT_MULTIPLAYER_ROADMAP.md L3): a packed
 * little-endian binary form of {@link NetMessage} — about a third of its JSON
 * for full 32-bit state words, about half for small numbers.
 *
 *   flags  u8   bit 0 states, bit 1 events, bit 2 match
 *   states u8 count, then per slot: u8 slot, u32 × 3
 *   events u16 count, then per event: u32 × 2
 *   match  u32
 *
 * Pure. Transport-level fields (signalling, relay recipients) never travel
 * this way: they ride the relay as JSON.
 */

import type { NetMessage } from "./NetSession.js";
import type { NetEvent } from "./netplay.js";

const STATES = 1, EVENTS = 2, MATCH = 4;

/** The binary form of a message's states, events and match word. */
export function encodeNetMessage(message: NetMessage): Uint8Array {
  const states = message.s ?? [];
  const events = message.e ?? [];
  const hasMatch = message.m !== undefined;
  const size = 1 + (states.length ? 1 + states.length * 13 : 0) + (events.length ? 2 + events.length * 8 : 0) + (hasMatch ? 4 : 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  bytes[at++] = (states.length ? STATES : 0) | (events.length ? EVENTS : 0) | (hasMatch ? MATCH : 0);
  if (states.length) {
    if (states.length > 255) throw new Error("too many slot states in one message");
    bytes[at++] = states.length;
    for (const [slot, a, b, c] of states) {
      bytes[at++] = slot & 0xff;
      view.setUint32(at, a >>> 0, true);
      view.setUint32(at + 4, b >>> 0, true);
      view.setUint32(at + 8, c >>> 0, true);
      at += 12;
    }
  }
  if (events.length) {
    if (events.length > 0xffff) throw new Error("too many events in one message");
    view.setUint16(at, events.length, true);
    at += 2;
    for (const [a, b] of events) {
      view.setUint32(at, a >>> 0, true);
      view.setUint32(at + 4, b >>> 0, true);
      at += 8;
    }
  }
  if (hasMatch) view.setUint32(at, message.m! >>> 0, true);
  return bytes;
}

/** A message back from its binary form; null when the bytes aren't one. */
export function decodeNetMessage(bytes: Uint8Array): NetMessage | null {
  if (bytes.length < 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[0]!;
  if (flags & ~(STATES | EVENTS | MATCH)) return null;
  let at = 1;
  const need = (n: number) => at + n <= bytes.length;
  const message: { s?: [number, number, number, number][]; e?: NetEvent[]; m?: number } = {};
  if (flags & STATES) {
    if (!need(1)) return null;
    const count = bytes[at++]!;
    if (!need(count * 13)) return null;
    message.s = [];
    for (let i = 0; i < count; i += 1) {
      message.s.push([bytes[at]!, view.getUint32(at + 1, true), view.getUint32(at + 5, true), view.getUint32(at + 9, true)]);
      at += 13;
    }
  }
  if (flags & EVENTS) {
    if (!need(2)) return null;
    const count = view.getUint16(at, true);
    at += 2;
    if (!need(count * 8)) return null;
    message.e = [];
    for (let i = 0; i < count; i += 1) {
      message.e.push([view.getUint32(at, true), view.getUint32(at + 4, true)]);
      at += 8;
    }
  }
  if (flags & MATCH) {
    if (!need(4)) return null;
    message.m = view.getUint32(at, true);
    at += 4;
  }
  return at === bytes.length ? message : null;
}

/** Bytes to base64 and back (for relays that carry JSON payloads). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
export function base64ToBytes(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}
