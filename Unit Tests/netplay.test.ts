/**
 * Netplay: the pmem inbox/outbox codec a cart and its host page share, and
 * NetSession relaying slot state, events and the host's match word between two
 * players over an in-memory room — and, since L4, a clock the room shares:
 * every snapshot stamped on it, every guest keeping time with the host by ping.
 */

import { describe, expect, it } from "vitest";

import {
  MemoryNetHub,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  NET_WORDS,
  NetSession,
  SimulatedNetHub,
  netSendInterval,
  takeNetOutbox,
  type NetMessage,
  type NetTransport,
  writeNetInbox,
} from "@cartbox/player";

/** Simulate a cart writing its outbox the way the SDK's net helpers do. */
function publish(words: Uint32Array, slot: number, state: [number, number, number, number]): void {
  words[70] = (words[70]! | (1 << slot)) >>> 0;
  words.set(state, 72 + slot * 4);
}
function send(words: Uint32Array, a: number, b: number): void {
  const n = words[104]!;
  words[105 + n * 2] = a;
  words[106 + n * 2] = b;
  words[104] = n + 1;
}
/** A slot's state words and its snapshot stamp (ms mod 65536) as the cart reads them. */
const slotWords = (words: Uint32Array, slot: number) => Array.from(words.subarray(3 + slot * 4, 7 + slot * 4));
const stampOf = (words: Uint32Array, slot: number) => (words[35 + (slot >> 1)]! >>> ((slot & 1) * 16)) & 0xffff;

describe("netplay codec", () => {
  it("packs the inbox header, the shared clock, slots and their stamps", () => {
    const words = new Uint32Array(NET_WORDS);
    const delivered = writeNetInbox(words, {
      mode: NET_MODE_HOST,
      mySlot: 3,
      humans: 0b1001,
      live: 0b0001,
      match: 0xdeadbeef,
      clock: 123_456_789,
      slots: [[1, 2, 0xffffffff, 4], null, null, [9, 9, 9, 9]],
      stamps: [70_000, 0, 0, 65_535],
      events: [[5, 6]],
    });
    expect(delivered).toBe(1);
    expect(words[0]! & 3).toBe(NET_MODE_HOST);
    expect((words[0]! >> 2) & 7).toBe(3);
    expect((words[0]! >> 8) & 0xff).toBe(0b1001);
    expect((words[0]! >> 16) & 0xff).toBe(0b0001);
    expect(words[1]).toBe(0xdeadbeef);
    expect(words[2]).toBe(123_456_789);
    expect(slotWords(words, 0)).toEqual([1, 2, 0xffffffff, 4]);
    expect(slotWords(words, 3)).toEqual([9, 9, 9, 9]);
    expect(stampOf(words, 0)).toBe(70_000 & 0xffff);
    expect(stampOf(words, 3)).toBe(65_535);
    expect(words[39]).toBe(1);
    expect(Array.from(words.subarray(40, 42))).toEqual([5, 6]);
  });

  it("caps inbox events at 12, each with the slot it came from, and reports how many landed", () => {
    const words = new Uint32Array(NET_WORDS);
    const events = Array.from({ length: 25 }, (_, i) => [i, i] as const);
    const senders = events.map((_, i) => i % 8);
    expect(writeNetInbox(words, { mode: 1, mySlot: 1, humans: 3, live: 1, match: 0, clock: 0, slots: [], events, senders })).toBe(12);
    expect(words[39]).toBe(12);
    const sender = (i: number) => (words[i < 10 ? 64 : 65]! >>> ((i % 10) * 3)) & 7;
    expect(Array.from({ length: 12 }, (_, i) => sender(i))).toEqual(senders.slice(0, 12));
    expect(words[68]).toBe(0); // the sticks' words are left alone
  });

  it("reads the outbox and clears it for the next tick, leaving 117 and 118 to the cart", () => {
    const words = new Uint32Array(NET_WORDS);
    publish(words, 7, [10, 20, 30, 40]);
    send(words, 1, 99);
    words[71] = 42;
    words[117] = 5;
    words[118] = 6;
    const out = takeNetOutbox(words);
    expect([...out.states]).toEqual([[7, [10, 20, 30, 40]]]);
    expect(words[117]).toBe(5);
    expect(words[118]).toBe(6);
    expect(out.events).toEqual([[1, 99]]);
    expect(out.match).toBe(42);
    const again = takeNetOutbox(words);
    expect(again.states.size).toBe(0);
    expect(again.events).toEqual([]);
  });
});

describe("NetSession over a memory room", () => {
  async function room() {
    const hub = new MemoryNetHub();
    let clock = 1000;
    const now = () => clock;
    const host = new NetSession(hub.transport("a"), now);
    await host.connect("Host");
    // The guest joins later, so it takes slot 1.
    await new Promise((r) => setTimeout(r, 2));
    const guest = new NetSession(hub.transport("b"), now);
    await guest.connect("Guest");
    return { host, guest, advance: (ms: number) => (clock += ms) };
  }

  it("assigns slots by join order; the first is host", async () => {
    const { host, guest } = await room();
    expect(host.mySlot).toBe(0);
    expect(host.isHost).toBe(true);
    expect(guest.mySlot).toBe(1);
    expect(guest.status().peers).toHaveLength(2);
  });

  it("relays state, events and the host's match word in one message, stamped on the shared clock", async () => {
    const { host, guest, advance } = await room();
    const hw = new Uint32Array(NET_WORDS);
    const gw = new Uint32Array(NET_WORDS);

    // Four ticks: the host publishes itself and a bot, the guest itself; the
    // guest also reports one hit on the host's bot.
    for (let t = 0; t < 4; t += 1) {
      host.beforeTick(hw);
      publish(hw, 0, [1, 2, 3, 10]);
      publish(hw, 5, [7, 8, 9, 11]);
      hw[71] = 0x1234;
      host.afterTick(hw);

      guest.beforeTick(gw);
      publish(gw, 1, [4, 5, 6, 12]);
      if (t === 3) send(gw, 1, 0x505);
      guest.afterTick(gw);
    }

    host.beforeTick(hw);
    expect(hw[0]! & 3).toBe(NET_MODE_HOST);
    expect((hw[0]! >> 8) & 0xff).toBe(0b11); // two humans
    expect((hw[0]! >> 16) & 0xff).toBe(0b10); // the guest's state is live
    expect(slotWords(hw, 1)).toEqual([4, 5, 6, 12]);
    expect(hw[39]).toBe(1);
    expect(Array.from(hw.subarray(40, 42))).toEqual([1, 0x505]);
    // Stamped when it was sent, on the shared clock (here everyone's 1000 ms).
    expect(hw[2]).toBe(1000);
    expect(stampOf(hw, 1)).toBe(1000);

    guest.beforeTick(gw);
    expect(gw[0]! & 3).toBe(NET_MODE_CLIENT);
    expect((gw[0]! >> 2) & 7).toBe(1);
    expect(gw[1]).toBe(0x1234);
    expect(slotWords(gw, 0)).toEqual([1, 2, 3, 10]);
    expect(slotWords(gw, 5)).toEqual([7, 8, 9, 11]); // the host's bot
    expect(stampOf(gw, 5)).toBe(1000);
    expect(gw[39]).toBe(0); // events are delivered once

    // A guest's view of its own slot is never overwritten by relayed state.
    expect(slotWords(gw, 1)).toEqual([0, 0, 0, 0]);

    // State that stops arriving goes stale.
    advance(5000);
    guest.beforeTick(gw);
    expect((gw[0]! >> 16) & 0xff).toBe(0);
  });

  it("promotes the guest to host when the host leaves, in the slot it had (L8)", async () => {
    const { host, guest } = await room();
    host.close();
    expect(guest.mySlot).toBe(1);
    expect(guest.isHost).toBe(true);
    expect(guest.hostSlot).toBe(1);
  });

  it("sends one batched message per 4 ticks however busy the tick is", async () => {
    const sent: NetMessage[] = [];
    const transport: NetTransport = {
      selfId: "me",
      connect: async () => {},
      send: (message) => sent.push(message),
      onMessage: () => {},
      onPeers: (handler) => queueMicrotask(() => handler([{ id: "me", joinedAt: 0 }])),
      close: () => {},
    };
    const session = new NetSession(transport);
    await session.connect();
    await Promise.resolve();
    const words = new Uint32Array(NET_WORDS);
    for (let t = 0; t < 8; t += 1) {
      session.beforeTick(words);
      publish(words, 0, [t, 0, 0, 0]);
      send(words, 1, t);
      send(words, 2, t);
      session.afterTick(words);
    }
    expect(sent).toHaveLength(2);
    expect(sent[1]!.s).toEqual([[0, 7, 0, 0, 0]]); // the latest state
    expect(sent[1]!.e).toEqual([[1, 4], [2, 4], [1, 5], [2, 5], [1, 6], [2, 6], [1, 7], [2, 7]]); // every event since
    expect(sent[1]!.m).toBe(0); // the host's match word rides along
  });

  it("stays quiet when nothing changed, bar a keepalive once a second", async () => {
    const sent: NetMessage[] = [];
    const transport: NetTransport = {
      selfId: "me",
      connect: async () => {},
      send: (message) => sent.push(message),
      onMessage: () => {},
      onPeers: (handler) => queueMicrotask(() => handler([{ id: "me", joinedAt: 0 }, { id: "you", joinedAt: 1 }])),
      close: () => {},
    };
    const session = new NetSession(transport);
    await session.connect();
    await Promise.resolve();
    const words = new Uint32Array(NET_WORDS);
    const tick = (state: [number, number, number, number], event = false) => {
      session.beforeTick(words);
      publish(words, 0, state);
      if (event) send(words, 1, 2);
      session.afterTick(words);
    };
    for (let t = 0; t < 120; t += 1) tick([5, 5, 5, 5]); // standing still for two seconds
    expect(sent.length).toBe(2); // the first snapshot, then one keepalive
    tick([5, 5, 5, 5], true); // an event always goes out (on the next send tick)
    for (let t = 0; t < 3; t += 1) tick([5, 5, 5, 5]);
    expect(sent.at(-1)!.e).toEqual([[1, 2]]);
    const before = sent.length;
    for (let t = 0; t < 8; t += 1) tick([6 + t, 5, 5, 5]); // moving again: sends resume
    expect(sent.length - before).toBe(2);
  });

  it("slows each player's rate as the room fills", () => {
    expect(netSendInterval(2)).toBe(4); // 15 Hz
    expect(netSendInterval(4)).toBe(6); // 10 Hz
    expect(netSendInterval(8)).toBe(8); // 7.5 Hz
    // Messages a room receives per second stay bounded as it fills.
    const load = (n: number) => (n * (n - 1) * 60) / netSendInterval(n);
    expect(load(8)).toBeLessThan(load(2) * 16);
  });

  it("writes an offline inbox before connecting", () => {
    const hub = new MemoryNetHub();
    const solo = new NetSession(hub.transport("x"));
    const words = new Uint32Array(NET_WORDS).fill(0xffffffff);
    solo.beforeTick(words);
    expect(words[0]).toBe(0);
    expect(words[39]).toBe(0);
  });
});

describe("slots that stick (L8)", () => {
  /** Players in one room, each ticking its session (so the host's roster goes round). */
  async function party() {
    const hub = new MemoryNetHub();
    let clock = 1000;
    const players = new Map<string, { session: NetSession; words: Uint32Array }>();
    const join = async (id: string) => {
      const session = new NetSession(hub.transport(id), () => clock);
      await session.connect(id);
      players.set(id, { session, words: new Uint32Array(NET_WORDS) });
      await new Promise((r) => setTimeout(r, 2));
      return session;
    };
    const tick = (n = 8) => {
      for (let t = 0; t < n; t += 1) {
        for (const { session, words } of players.values()) {
          session.beforeTick(words);
          session.afterTick(words);
        }
        clock += 1000 / 60;
      }
    };
    const leave = (id: string) => {
      players.get(id)!.session.close();
      players.delete(id);
    };
    return { join, tick, leave, slot: (id: string) => players.get(id)!.session.mySlot, session: (id: string) => players.get(id)!.session, advance: (ms: number) => (clock += ms) };
  }

  it("keeps everyone's slot when another leaves, and the next in line takes over as host", async () => {
    const room = await party();
    await room.join("a");
    await room.join("b");
    await room.join("c");
    room.tick();
    expect(["a", "b", "c"].map(room.slot)).toEqual([0, 1, 2]);
    room.leave("a");
    room.tick();
    expect(["b", "c"].map(room.slot)).toEqual([1, 2]);
    expect(room.session("b").isHost).toBe(true);
    expect(room.session("c").hostSlot).toBe(1);
    // The new host's inbox says so, for the cart.
    const words = new Uint32Array(NET_WORDS);
    room.session("c").beforeTick(words);
    expect(words[66]).toBe(1);
    expect((words[0]! >> 8) & 0xff).toBe(0b110); // slots 1 and 2 hold humans
  });

  it("gives a newcomer the lowest free slot, and one who drops its own back within a minute", async () => {
    const room = await party();
    for (const id of ["a", "b", "c"]) await room.join(id);
    room.tick();
    room.leave("b");
    room.tick();
    await room.join("d");
    room.tick();
    // Slot 1 is held for b: d takes 3, and everyone agrees.
    expect(room.slot("d")).toBe(3);
    expect(room.session("c").slotOf("d")).toBe(3);
    await room.join("b");
    room.tick();
    expect(room.slot("b")).toBe(1);
    expect(room.session("d").slotOf("b")).toBe(1);
    // After a minute away the slot is free for anyone.
    room.leave("b");
    room.tick();
    room.advance(61_000);
    await room.join("e");
    room.tick();
    expect(room.slot("e")).toBe(1);
  });
});

describe("the room's shared clock (L4)", () => {
  /** A host and a guest whose own clocks disagree by `skew` ms, over a link with latency and jitter. */
  async function skewed(skew: number, latencyMs: number, jitterMs: number) {
    const hub = new SimulatedNetHub({ latencyMs, jitterMs }, 5);
    const host = new NetSession(hub.transport("a"), () => 50_000 + hub.now());
    await host.connect("Host");
    const guest = new NetSession(hub.transport("b"), () => 50_000 + hub.now() + skew);
    await guest.connect("Guest");
    const hw = new Uint32Array(NET_WORDS);
    const gw = new Uint32Array(NET_WORDS);
    let t = 0;
    const run = (ticks: number) => {
      for (let i = 0; i < ticks; i += 1, t += 1) {
        host.beforeTick(hw);
        publish(hw, 0, [t, 0, 0, 0]);
        host.afterTick(hw);
        guest.beforeTick(gw);
        publish(gw, 1, [t, 0, 0, 0]);
        guest.afterTick(gw);
        hub.advance(1000 / 60);
      }
    };
    return { host, guest, hw, gw, run };
  }

  it("brings a guest's clock onto the host's by ping, to within the link's jitter", async () => {
    const { host, guest, run } = await skewed(-7_340, 80, 20);
    expect(Math.abs(guest.sharedNow() - host.sharedNow())).toBeGreaterThan(7_000);
    run(120); // two seconds
    const sync = guest.clockSync();
    expect(sync.samples).toBeGreaterThanOrEqual(5);
    expect(sync.rtt).toBeGreaterThanOrEqual(160);
    expect(sync.rtt).toBeLessThan(160 + 2 * 20 + 40);
    // Half the round trip's asymmetry at most: the jitter (and a send interval of waiting) can't fool it by more.
    expect(Math.abs(guest.sharedNow() - host.sharedNow())).toBeLessThan(20);
    expect(host.clockSync().offset).toBe(0); // the host's clock is the room's
  });

  it("stamps each slot on the sender's shared time, so a guest sees how old the host's snapshot is", async () => {
    const { gw, guest, run } = await skewed(3_000, 80, 0);
    run(120);
    guest.beforeTick(gw);
    const clock = gw[2]!;
    const age = (clock - stampOf(gw, 0)) & 0xffff;
    // The host's newest snapshot left it at most a send interval ago and took 80 ms to arrive.
    expect(age).toBeGreaterThanOrEqual(80);
    expect(age).toBeLessThan(80 + 34 + 20);
  });

  it("keeps the newest snapshot when an older one arrives late", async () => {
    const received: ((message: NetMessage, from: string) => void)[] = [];
    const transport: NetTransport = {
      selfId: "me",
      connect: async () => {},
      send: () => {},
      onMessage: (handler) => received.push(handler),
      onPeers: (handler) => queueMicrotask(() => handler([{ id: "host", joinedAt: 0 }, { id: "me", joinedAt: 1 }])),
      close: () => {},
    };
    const session = new NetSession(transport, () => 10_000);
    await session.connect();
    await Promise.resolve();
    received[0]!({ s: [[0, 2, 0, 0, 0]], t: 9_990 }, "host");
    received[0]!({ s: [[0, 1, 0, 0, 0]], t: 9_950 }, "host"); // overtaken on the way
    const words = new Uint32Array(NET_WORDS);
    session.beforeTick(words);
    expect(slotWords(words, 0)).toEqual([2, 0, 0, 0]);
    expect(stampOf(words, 0)).toBe(9_990);
  });
});
