/**
 * The /lockout page's pieces: the cartridge it builds from the starter, the
 * room codes it shares, and the Supabase Realtime transport that carries a room
 * (driven here against a fake channel with Realtime's API shape).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { LOCKOUT_CODE, lockoutCartridge } from "@cartbox/editor";
import { CARTBOX_SDK_LUA, decodeMeshPoses, injectSdk, type NetMessage, type NetPeer } from "@cartbox/player";
import { SupabaseNetTransport, newRoomCode, parseRoomCode } from "../apps/web/src/lib/netplayTransport";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

describe("lockoutCartridge", () => {
  it("is a palette chunk and a code chunk carrying the starter's code", () => {
    const bytes = lockoutCartridge();
    expect(bytes[0]).toBe(12); // CHUNK_PALETTE, bank 0
    expect(bytes[1]! | (bytes[2]! << 8)).toBe(48);
    expect(Array.from(bytes.subarray(4, 7))).toEqual([0, 0, 0]); // index 0 is the HUD's transparent black
    const code = 4 + 48;
    expect(bytes[code]).toBe(5); // CHUNK_CODE
    const size = bytes[code + 1]! | (bytes[code + 2]! << 8);
    expect(new TextDecoder().decode(bytes.subarray(code + 4, code + 4 + size))).toBe(LOCKOUT_CODE);
  });

  it("leaves room for the SDK in its one code chunk", () => {
    // The player prepends the SDK to the code chunk — and silently skips it if
    // the result would pass 65535 bytes, which would break every cartbox.* call.
    const merged = new TextEncoder().encode(`${CARTBOX_SDK_LUA}\n${LOCKOUT_CODE}`).length;
    expect(merged).toBeLessThan(0xffff - 1024);
    expect(injectSdk(lockoutCartridge()).length).toBeGreaterThan(lockoutCartridge().length);
  });

  it.skipIf(!existsSync(ENGINE))("boots on the Xbox 360 core and starts a match from its menu", async () => {
    const tic = injectSdk(lockoutCartridge());
    const factory = (await import(pathToFileURL(ENGINE).href)).default;
    const mod = await factory();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    for (const buttons of [0, 0, 0x10, 0x10, 0, 0, 0]) mod._cbx_tick(h, buttons);
    const words = new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
    mod._cbx_delete(h);
    const bots = decodeMeshPoses(words).filter((pose) => pose.index >= 1 && pose.index <= 7 && pose.position[1] > -10);
    expect(bots.length).toBeGreaterThan(0);
  });
});

describe("room codes", () => {
  it("makes readable codes that parse back", () => {
    let seed = 0;
    const code = newRoomCode(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280));
    expect(code).toMatch(/^[A-Z2-9]{5}$/);
    expect(code).not.toMatch(/[IO01]/);
    expect(parseRoomCode(` ${code.toLowerCase()} `)).toBe(code);
  });

  it("rejects junk", () => {
    expect(parseRoomCode(null)).toBeNull();
    expect(parseRoomCode("ab")).toBeNull();
    expect(parseRoomCode("<script>")).toBeNull();
  });
});

/** A fake Supabase client: one shared room of channels, with Realtime's API shape. */
function fakeRealtime() {
  type Handler = (arg: { payload?: unknown }) => void;
  const channels: FakeChannel[] = [];
  const rooms = new Map<string, Map<string, unknown>>(); // topic → presence key → meta
  class FakeChannel {
    get presence() {
      let room = rooms.get(this.topic);
      if (!room) rooms.set(this.topic, (room = new Map()));
      return room;
    }
    handlers: { type: string; event: string; fn: Handler }[] = [];
    removed = false;
    constructor(
      readonly topic: string,
      readonly key: string,
      readonly self: boolean,
    ) {}
    on(type: string, filter: { event: string }, fn: Handler) {
      this.handlers.push({ type, event: filter.event, fn });
      return this;
    }
    subscribe(callback: (status: string) => void) {
      channels.push(this);
      queueMicrotask(() => callback("SUBSCRIBED"));
      return this;
    }
    async track(meta: unknown) {
      this.presence.set(this.key, meta);
      for (const channel of channels) if (channel.topic === this.topic) channel.syncPresence();
      return "ok";
    }
    async untrack() {
      return "ok";
    }
    syncPresence() {
      for (const h of this.handlers) if (h.type === "presence" && h.event === "sync") h.fn({});
    }
    presenceState() {
      const state: Record<string, unknown[]> = {};
      for (const [key, meta] of this.presence) state[key] = [meta];
      return state;
    }
    async send(message: { event: string; payload: unknown }) {
      for (const channel of channels) {
        if (channel.topic !== this.topic || (channel === this && !this.self)) continue;
        for (const h of channel.handlers) if (h.type === "broadcast" && h.event === message.event) h.fn({ payload: message.payload });
      }
      return "ok";
    }
  }
  return {
    channels,
    client: {
      channel: (topic: string, opts: { config: { broadcast: { self: boolean }; presence: { key: string } } }) =>
        new FakeChannel(topic, opts.config.presence.key, opts.config.broadcast.self),
      removeChannel: async (channel: FakeChannel) => {
        channel.removed = true;
        return "ok";
      },
    },
  };
}

describe("SupabaseNetTransport", () => {
  it("shares presence (with join times) and relays messages to the other players only", async () => {
    const realtime = fakeRealtime();
    const client = realtime.client as never;
    const a = new SupabaseNetTransport(client, "cartbox-net:lockout:ABCDE");
    const b = new SupabaseNetTransport(client, "cartbox-net:lockout:ABCDE");
    let peersSeenByB: readonly NetPeer[] = [];
    const gotA: NetMessage[] = [];
    const gotB: NetMessage[] = [];
    a.onMessage((m) => gotA.push(m));
    b.onMessage((m) => gotB.push(m));
    b.onPeers((peers) => (peersSeenByB = peers));
    await a.connect(100, "Ann");
    await b.connect(200, "Bo");

    expect(peersSeenByB.map((p) => [p.id, p.joinedAt])).toEqual([
      [a.selfId, 100],
      [b.selfId, 200],
    ]);
    a.send({ s: [[0, 1, 2, 3]], m: 5 });
    expect(gotB).toEqual([{ s: [[0, 1, 2, 3]], m: 5 }]);
    expect(gotA).toEqual([]); // never echoed to the sender

    a.close();
    expect(realtime.channels[0]!.removed).toBe(true);
  });
});
