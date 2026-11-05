/**
 * Co-editing's transports (AAA_PRODUCTION_ROADMAP.md W2): the hosted realtime
 * channel netplay uses (Supabase Realtime broadcast, one channel per cart), or,
 * without one (the static demo build), a BroadcastChannel between this
 * browser's tabs.
 *
 * A realtime broadcast carries a bounded message, and a scene object (a mesh
 * with its geometry) or a newcomer's catch-up can be far larger, so messages
 * travel in parts: each part names its message, its index and the count, and
 * the far end puts a message together once every part is in (parts of a
 * message left incomplete are dropped after a while).
 */

import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

import { broadcastChannelTransport, type CoEditMessage, type CoEditTransport } from "./coEdit";
import { onlineRoomsAvailable } from "./netplayTransport";

/** A part of a message: its id, index, count and slice of the JSON. */
export interface CoEditPart {
  readonly id: string;
  readonly i: number;
  readonly n: number;
  readonly s: string;
}

/** Characters a part carries: well under Realtime's per-message limit once wrapped. */
export const COEDIT_PART_CHARS = 100_000;

let counter = 0;

/** A message as parts of at most `size` characters of its JSON. */
export function splitCoEditMessage(message: CoEditMessage, size = COEDIT_PART_CHARS, id = `${message.from}:${(counter += 1)}`): CoEditPart[] {
  const json = JSON.stringify(message);
  const n = Math.max(1, Math.ceil(json.length / size));
  return Array.from({ length: n }, (_, i) => ({ id, i, n, s: json.slice(i * size, (i + 1) * size) }));
}

/** Puts parts back together, in any order; a message whose parts stop coming is dropped after `ttlMs`. */
export class CoEditAssembler {
  private readonly pending = new Map<string, { parts: (string | undefined)[]; got: number; seen: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A part: the whole message once its last part is in, else null. A malformed part is ignored. */
  add(part: CoEditPart): CoEditMessage | null {
    const t = this.now();
    for (const [id, p] of this.pending) if (t - p.seen > this.ttlMs) this.pending.delete(id);
    if (typeof part?.id !== "string" || !Number.isInteger(part.n) || part.n < 1 || part.n > 10_000 || !Number.isInteger(part.i) || part.i < 0 || part.i >= part.n || typeof part.s !== "string") return null;
    let entry = this.pending.get(part.id);
    if (!entry || entry.parts.length !== part.n) {
      entry = { parts: new Array<string | undefined>(part.n), got: 0, seen: t };
      this.pending.set(part.id, entry);
    }
    entry.seen = t;
    if (entry.parts[part.i] === undefined) {
      entry.parts[part.i] = part.s;
      entry.got += 1;
    }
    if (entry.got < part.n) return null;
    this.pending.delete(part.id);
    try {
      return JSON.parse(entry.parts.join("")) as CoEditMessage;
    } catch {
      return null;
    }
  }

  /** Messages waiting on parts (tests). */
  get waiting(): number {
    return this.pending.size;
  }
}

/** Co-editing over a Supabase Realtime broadcast channel, one per cart. */
export function supabaseCoEditTransport(client: SupabaseClient, cartId: string): CoEditTransport & { close(): void; ready: Promise<void> } {
  const channel: RealtimeChannel = client.channel(`cartbox-coedit:${cartId}`, { config: { broadcast: { self: false, ack: false } } });
  const assembler = new CoEditAssembler();
  const handlers: ((m: CoEditMessage) => void)[] = [];
  const queued: CoEditMessage[] = [];
  let subscribed = false;
  const post = (m: CoEditMessage) => {
    for (const part of splitCoEditMessage(m)) void channel.send({ type: "broadcast", event: "coedit", payload: part });
  };
  channel.on("broadcast", { event: "coedit" }, ({ payload }) => {
    const message = assembler.add(payload as CoEditPart);
    if (message) for (const h of handlers) h(message);
  });
  const ready = new Promise<void>((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        subscribed = true;
        // What was said before the channel opened (the session's hello) goes now.
        for (const m of queued.splice(0)) post(m);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        reject(new Error(`Could not join the cart's editing channel (${status.toLowerCase().replace("_", " ")})`));
      }
    });
  });
  ready.catch(() => undefined);
  return {
    ready,
    send: (m) => (subscribed ? post(m) : void queued.push(m)),
    onMessage: (h) => void handlers.push(h),
    close: () => void client.removeChannel(channel),
  };
}

/** Where co-editing reaches: other devices (the hosted channel) or this browser's tabs. */
export function coEditReach(): "online" | "tabs" {
  return onlineRoomsAvailable() ? "online" : "tabs";
}

/** The transport for a cart's co-editing: the hosted channel when there is one, else this browser's tabs. */
export async function coEditTransport(cartId: string): Promise<CoEditTransport & { close(): void }> {
  if (coEditReach() === "online") {
    const { supabaseBrowser } = await import("./supabase-browser");
    return supabaseCoEditTransport(supabaseBrowser(), cartId);
  }
  return broadcastChannelTransport(cartId);
}
