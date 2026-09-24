/**
 * Netplay — online multiplayer for carts, relayed by the host page.
 *
 * TIC-80 has no networking, so the browser does it: each player's page runs its
 * own copy of the cart, and a {@link NetSession} relays compact player state and
 * events between them over a {@link NetTransport} (Supabase Realtime broadcast
 * online, BroadcastChannel between tabs, an in-memory hub in tests).
 *
 * The cart and its host page exchange that data through the low 119 words of
 * persistent memory (pmem 0..118) — the words just below the event mailbox,
 * which a netplay cart must therefore not use for save data. The host writes the
 * INBOX before every tick and reads the OUTBOX after it:
 *
 * ```
 * INBOX  (host → cart)
 *   0      header   bits 0-1 mode (0 offline, 1 client, 2 host) · 2-4 my slot ·
 *                   8-15 slots held by a human · 16-23 slots with live remote state
 *   1      the host's match word (opaque to the relay: the host cart's game state)
 *   2      tick sequence
 *   3..26  8 slots × 3 words of remote player state (opaque to the relay)
 *   27     event count (≤ 20)
 *   28..67 20 events × 2 words
 * OUTBOX (cart → host)
 *   70     mask of slots the cart published this tick
 *   71     match word (only the host's is relayed)
 *   72..95 8 slots × 3 words: this player's state (and, on the host, its bots')
 *   96     event count (≤ 10)
 *   97..116 10 events × 2 words
 * ```
 *
 * The relay never interprets state or event words — a cart defines them — so the
 * same channel serves any game: every client is authoritative for its own slot,
 * the lowest slot is the host (it simulates anything no human controls), and
 * events (a hit, a kill) are broadcast to everyone.
 */

/** Words of pmem the netplay channel uses (0..118, just below the mailbox). */
export const NET_WORDS = 119;
/** Player slots per room. */
export const NET_SLOTS = 8;
/** Words of opaque state per slot. */
export const NET_STATE_WORDS = 3;

export const NET_IN_HEADER = 0;
export const NET_IN_MATCH = 1;
export const NET_IN_SEQ = 2;
export const NET_IN_SLOTS = 3;
export const NET_IN_EVENT_COUNT = 27;
export const NET_IN_EVENTS = 28;
export const NET_IN_EVENT_CAPACITY = 20;

export const NET_OUT_MASK = 70;
export const NET_OUT_MATCH = 71;
export const NET_OUT_SLOTS = 72;
export const NET_OUT_EVENT_COUNT = 96;
export const NET_OUT_EVENTS = 97;
export const NET_OUT_EVENT_CAPACITY = 10;

export const NET_MODE_OFFLINE = 0;
export const NET_MODE_CLIENT = 1;
export const NET_MODE_HOST = 2;

/** One slot's opaque state. */
export type NetState = readonly [number, number, number];
/** One opaque event. */
export type NetEvent = readonly [number, number];

/** What the host page tells the cart before a tick. */
export interface NetInbox {
  readonly mode: number;
  readonly mySlot: number;
  /** Bitmask of slots held by a human (including mine). */
  readonly humans: number;
  /** Bitmask of remote slots with live state this tick. */
  readonly live: number;
  readonly match: number;
  readonly seq: number;
  /** Remote state per slot (null when there is none). */
  readonly slots: readonly (NetState | null)[];
  readonly events: readonly NetEvent[];
}

/** What the cart told the host page during a tick. */
export interface NetOutbox {
  /** Slot → state for every slot the cart published this tick. */
  readonly states: ReadonlyMap<number, NetState>;
  readonly match: number;
  readonly events: readonly NetEvent[];
}

/** Write an inbox into the net words (a live view of pmem 0..118). */
export function writeNetInbox(words: Uint32Array, inbox: NetInbox): number {
  words[NET_IN_HEADER] =
    ((inbox.mode & 3) | ((inbox.mySlot & 7) << 2) | ((inbox.humans & 0xff) << 8) | ((inbox.live & 0xff) << 16)) >>> 0;
  words[NET_IN_MATCH] = inbox.match >>> 0;
  words[NET_IN_SEQ] = inbox.seq >>> 0;
  for (let slot = 0; slot < NET_SLOTS; slot += 1) {
    const state = inbox.slots[slot] ?? null;
    for (let k = 0; k < NET_STATE_WORDS; k += 1) {
      words[NET_IN_SLOTS + slot * NET_STATE_WORDS + k] = state ? state[k]! >>> 0 : 0;
    }
  }
  const count = Math.min(inbox.events.length, NET_IN_EVENT_CAPACITY);
  words[NET_IN_EVENT_COUNT] = count;
  for (let i = 0; i < count; i += 1) {
    words[NET_IN_EVENTS + i * 2] = inbox.events[i]![0] >>> 0;
    words[NET_IN_EVENTS + i * 2 + 1] = inbox.events[i]![1] >>> 0;
  }
  return count; // how many events were delivered (the rest wait for the next tick)
}

/** Read what the cart published this tick, then clear the outbox for the next. */
export function takeNetOutbox(words: Uint32Array): NetOutbox {
  const mask = words[NET_OUT_MASK]! & 0xff;
  const states = new Map<number, NetState>();
  for (let slot = 0; slot < NET_SLOTS; slot += 1) {
    if (!(mask & (1 << slot))) continue;
    const base = NET_OUT_SLOTS + slot * NET_STATE_WORDS;
    states.set(slot, [words[base]!, words[base + 1]!, words[base + 2]!]);
  }
  const count = Math.min(words[NET_OUT_EVENT_COUNT]!, NET_OUT_EVENT_CAPACITY);
  const events: NetEvent[] = [];
  for (let i = 0; i < count; i += 1) events.push([words[NET_OUT_EVENTS + i * 2]!, words[NET_OUT_EVENTS + i * 2 + 1]!]);
  const match = words[NET_OUT_MATCH]!;
  words[NET_OUT_MASK] = 0;
  words[NET_OUT_EVENT_COUNT] = 0;
  return { states, match, events };
}
