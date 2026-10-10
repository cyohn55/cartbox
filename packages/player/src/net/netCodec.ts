/**
 * Netplay messages on the wire (LOCKOUT_MULTIPLAYER_ROADMAP.md L3): a packed
 * little-endian binary form of {@link NetMessage} — about a third of its JSON
 * for full 32-bit state words, about half for small numbers.
 *
 *   flags  u8   bit 0 states, bit 1 events, bit 2 match, bit 3 time,
 *               bit 4 ping, bit 5 pongs
 *   states u8 count, then per slot: u8 slot, u32 × 4
 *   events u16 count, then per event: u32 × 2
 *   match  u32
 *   time   u32  when the states were taken, on the room's shared clock (L4)
 *   ping   u32  the sender's own clock, for the host to echo
 *   pongs  u8 count, then per echo: u8 slot, u32 × 3 (the ping, when the
 *               host heard it, when it answered)
 *   roster u8 count, then per player: u8 slot, u8 length, its id in UTF-8
 *               (the host's, L8; bit 6)
 *
 * Pure. Transport-level fields (signalling, relay recipients) never travel
 * this way: they ride the relay as JSON.
 */

import type { NetMessage } from "./NetSession.js";
import type { NetEvent } from "./netplay.js";

const STATES = 1, EVENTS = 2, MATCH = 4, TIME = 8, PING = 16, PONGS = 32, ROSTER = 64;
const STATE_BYTES = 17, PONG_BYTES = 13;
const utf8 = new TextEncoder();
const utf8decode = new TextDecoder();

/** The binary form of a message's states, events, match word, time and clock sync. */
export function encodeNetMessage(message: NetMessage): Uint8Array {
  const states = message.s ?? [];
  const events = message.e ?? [];
  const pongs = message.po ?? [];
  const roster = (message.ro ?? []).map(([slot, id]) => [slot, utf8.encode(id).slice(0, 255)] as const);
  const hasMatch = message.m !== undefined;
  const hasTime = message.t !== undefined;
  const hasPing = message.pi !== undefined;
  const size =
    1 +
    (states.length ? 1 + states.length * STATE_BYTES : 0) +
    (events.length ? 2 + events.length * 8 : 0) +
    (hasMatch ? 4 : 0) +
    (hasTime ? 4 : 0) +
    (hasPing ? 4 : 0) +
    (pongs.length ? 1 + pongs.length * PONG_BYTES : 0) +
    (roster.length ? 1 + roster.reduce((n, [, id]) => n + 2 + id.length, 0) : 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  bytes[at++] =
    (states.length ? STATES : 0) |
    (events.length ? EVENTS : 0) |
    (hasMatch ? MATCH : 0) |
    (hasTime ? TIME : 0) |
    (hasPing ? PING : 0) |
    (pongs.length ? PONGS : 0) |
    (roster.length ? ROSTER : 0);
  const u32 = (v: number) => {
    view.setUint32(at, v >>> 0, true);
    at += 4;
  };
  if (states.length) {
    if (states.length > 255) throw new Error("too many slot states in one message");
    bytes[at++] = states.length;
    for (const [slot, a, b, c, d] of states) {
      bytes[at++] = slot & 0xff;
      u32(a);
      u32(b);
      u32(c);
      u32(d);
    }
  }
  if (events.length) {
    if (events.length > 0xffff) throw new Error("too many events in one message");
    view.setUint16(at, events.length, true);
    at += 2;
    for (const [a, b] of events) {
      u32(a);
      u32(b);
    }
  }
  if (hasMatch) u32(message.m!);
  if (hasTime) u32(message.t!);
  if (hasPing) u32(message.pi!);
  if (pongs.length) {
    if (pongs.length > 255) throw new Error("too many pongs in one message");
    bytes[at++] = pongs.length;
    for (const [slot, t0, t1, t2] of pongs) {
      bytes[at++] = slot & 0xff;
      u32(t0);
      u32(t1);
      u32(t2);
    }
  }
  if (roster.length) {
    if (roster.length > 255) throw new Error("too many players in one roster");
    bytes[at++] = roster.length;
    for (const [slot, id] of roster) {
      bytes[at++] = slot & 0xff;
      bytes[at++] = id.length;
      bytes.set(id, at);
      at += id.length;
    }
  }
  return bytes;
}

/** A message back from its binary form; null when the bytes aren't one. */
export function decodeNetMessage(bytes: Uint8Array): NetMessage | null {
  if (bytes.length < 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = bytes[0]!;
  if (flags & ~(STATES | EVENTS | MATCH | TIME | PING | PONGS | ROSTER)) return null;
  let at = 1;
  const need = (n: number) => at + n <= bytes.length;
  const u32 = () => {
    const v = view.getUint32(at, true);
    at += 4;
    return v;
  };
  const message: {
    s?: [number, number, number, number, number][];
    e?: NetEvent[];
    m?: number;
    t?: number;
    pi?: number;
    po?: [number, number, number, number][];
    ro?: [number, string][];
  } = {};
  if (flags & STATES) {
    if (!need(1)) return null;
    const count = bytes[at++]!;
    if (!need(count * STATE_BYTES)) return null;
    message.s = [];
    for (let i = 0; i < count; i += 1) {
      const slot = bytes[at++]!;
      message.s.push([slot, u32(), u32(), u32(), u32()]);
    }
  }
  if (flags & EVENTS) {
    if (!need(2)) return null;
    const count = view.getUint16(at, true);
    at += 2;
    if (!need(count * 8)) return null;
    message.e = [];
    for (let i = 0; i < count; i += 1) message.e.push([u32(), u32()]);
  }
  for (const [flag, key] of [
    [MATCH, "m"],
    [TIME, "t"],
    [PING, "pi"],
  ] as const) {
    if (!(flags & flag)) continue;
    if (!need(4)) return null;
    message[key] = u32();
  }
  if (flags & PONGS) {
    if (!need(1)) return null;
    const count = bytes[at++]!;
    if (!need(count * PONG_BYTES)) return null;
    message.po = [];
    for (let i = 0; i < count; i += 1) {
      const slot = bytes[at++]!;
      message.po.push([slot, u32(), u32(), u32()]);
    }
  }
  if (flags & ROSTER) {
    if (!need(1)) return null;
    const count = bytes[at++]!;
    message.ro = [];
    for (let i = 0; i < count; i += 1) {
      if (!need(2)) return null;
      const slot = bytes[at++]!;
      const length = bytes[at++]!;
      if (!need(length)) return null;
      message.ro.push([slot, utf8decode.decode(bytes.subarray(at, at + length))]);
      at += length;
    }
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
