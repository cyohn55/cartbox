/**
 * Netplay transports for the web app.
 *
 * Online rooms ride Supabase Realtime: a broadcast channel carries the players'
 * batched state/event messages (packed binary, as base64) and presence
 * carries who is in the room (and when they joined, which orders the slots).
 * No database table and no server code — the relay is Realtime's own. Over
 * it, players open direct WebRTC connections to each other (L3,
 * DirectTransport): the relay then carries only the handshake and whatever a
 * direct connection can't reach. Without Supabase credentials (the static
 * demo build) rooms fall back to a BroadcastChannel, which spans the tabs of
 * one browser: enough to try a match on one machine.
 */

import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import {
  BroadcastChannelTransport,
  DirectTransport,
  decodeNetMessage,
  encodeNetMessage,
  type NetMessage,
  type NetPeer,
  type NetTransport,
} from "@cartbox/player";

import { isStaticExport } from "./staticSite";

/** Room codes: short, unambiguous, easy to read out. */
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < 5; i += 1) code += ROOM_ALPHABET[Math.floor(random() * ROOM_ALPHABET.length)];
  return code;
}

/** Normalise a typed or linked room code; null when it isn't one. */
export function parseRoomCode(raw: string | null | undefined): string | null {
  const code = (raw ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
}

/** Whether rooms can reach other devices (Supabase configured) or only other tabs. */
export function onlineRoomsAvailable(): boolean {
  return !isStaticExport && Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

interface PresenceMeta {
  readonly joinedAt?: number;
  readonly name?: string;
}

/** A room over a Supabase Realtime channel (broadcast + presence). */
export class SupabaseNetTransport implements NetTransport {
  readonly selfId = `p-${Math.random().toString(36).slice(2, 10)}`;
  private channel: RealtimeChannel | null = null;
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;

  constructor(
    private readonly client: SupabaseClient,
    private readonly topic: string,
  ) {}

  connect(joinedAt: number, name?: string): Promise<void> {
    const channel = this.client.channel(this.topic, {
      config: { broadcast: { self: false, ack: false }, presence: { key: this.selfId } },
    });
    this.channel = channel;
    channel.on("broadcast", { event: "net" }, ({ payload }) => {
      const data = payload as { f?: string; m?: NetMessage; b?: string; r?: string[] };
      if (data.f === this.selfId) return;
      // A game message travels packed (b), with its relay recipients (r); a handshake as JSON (m).
      const message = data.b ? decodeNetMessage(base64Bytes(data.b)) : data.m;
      if (message) this.messageHandler?.(data.r ? { ...message, r: data.r } : message, data.f ?? "");
    });
    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresenceMeta>();
      const peers: NetPeer[] = [];
      for (const [id, metas] of Object.entries(state)) {
        const meta = metas[0];
        if (meta) peers.push({ id, joinedAt: Number(meta.joinedAt) || 0, name: meta.name });
      }
      this.peersHandler?.(peers);
    });
    return new Promise((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void channel.track({ joinedAt, name }).then(() => resolve());
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(new Error(`Could not join the room (${status.toLowerCase().replace("_", " ")})`));
        }
      });
    });
  }

  send(message: NetMessage): void {
    const payload = message.sig
      ? { f: this.selfId, m: message }
      : { f: this.selfId, b: bytesBase64(encodeNetMessage(message)), ...(message.r ? { r: message.r } : {}) };
    void this.channel?.send({ type: "broadcast", event: "net", payload });
  }

  onMessage(handler: (message: NetMessage, from: string) => void): void {
    this.messageHandler = handler;
  }

  onPeers(handler: (peers: readonly NetPeer[]) => void): void {
    this.peersHandler = handler;
  }

  close(): void {
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      void channel.untrack();
      void this.client.removeChannel(channel);
    }
  }
}

function bytesBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function base64Bytes(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

/**
 * The transport for a room: online, direct connections between the players
 * over a Supabase Realtime room (which also relays for any player a direct
 * connection can't reach); else this browser's tabs.
 */
export async function roomTransport(game: string, room: string): Promise<NetTransport> {
  const topic = `cartbox-net:${game}:${room}`;
  if (onlineRoomsAvailable()) {
    const { supabaseBrowser } = await import("./supabase-browser");
    return new DirectTransport(new SupabaseNetTransport(supabaseBrowser(), topic));
  }
  return new BroadcastChannelTransport(`${game}:${room}`); // it adds its own "cartbox-net:" prefix
}
