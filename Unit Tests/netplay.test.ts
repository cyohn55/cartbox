/**
 * Netplay: the pmem inbox/outbox codec a cart and its host page share, and
 * NetSession relaying slot state, events and the host's match word between two
 * players over an in-memory room.
 */

import { describe, expect, it } from "vitest";

import {
  MemoryNetHub,
  NET_MODE_CLIENT,
  NET_MODE_HOST,
  NET_WORDS,
  NetSession,
  takeNetOutbox,
  writeNetInbox,
} from "@cartbox/player";

/** Simulate a cart writing its outbox the way the SDK's net helpers do. */
function publish(words: Uint32Array, slot: number, state: [number, number, number]): void {
  words[70] = (words[70]! | (1 << slot)) >>> 0;
  words.set(state, 72 + slot * 3);
}
function send(words: Uint32Array, a: number, b: number): void {
  const n = words[96]!;
  words[97 + n * 2] = a;
  words[98 + n * 2] = b;
  words[96] = n + 1;
}

describe("netplay codec", () => {
  it("packs the inbox header and slots", () => {
    const words = new Uint32Array(NET_WORDS);
    const delivered = writeNetInbox(words, {
      mode: NET_MODE_HOST,
      mySlot: 3,
      humans: 0b1001,
      live: 0b0001,
      match: 0xdeadbeef,
      seq: 7,
      slots: [[1, 2, 0xffffffff], null, null, null],
      events: [[5, 6]],
    });
    expect(delivered).toBe(1);
    expect(words[0]! & 3).toBe(NET_MODE_HOST);
    expect((words[0]! >> 2) & 7).toBe(3);
    expect((words[0]! >> 8) & 0xff).toBe(0b1001);
    expect((words[0]! >> 16) & 0xff).toBe(0b0001);
    expect(words[1]).toBe(0xdeadbeef);
    expect(Array.from(words.subarray(3, 6))).toEqual([1, 2, 0xffffffff]);
    expect(words[27]).toBe(1);
    expect(Array.from(words.subarray(28, 30))).toEqual([5, 6]);
  });

  it("caps inbox events at 20 and reports how many landed", () => {
    const words = new Uint32Array(NET_WORDS);
    const events = Array.from({ length: 25 }, (_, i) => [i, i] as const);
    expect(writeNetInbox(words, { mode: 1, mySlot: 1, humans: 3, live: 1, match: 0, seq: 0, slots: [], events })).toBe(20);
    expect(words[27]).toBe(20);
  });

  it("reads the outbox and clears it for the next tick", () => {
    const words = new Uint32Array(NET_WORDS);
    publish(words, 2, [10, 20, 30]);
    send(words, 1, 99);
    words[71] = 42;
    const out = takeNetOutbox(words);
    expect([...out.states]).toEqual([[2, [10, 20, 30]]]);
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

  it("relays state at 15 Hz, events at once, and the host's match word", async () => {
    const { host, guest, advance } = await room();
    const hw = new Uint32Array(NET_WORDS);
    const gw = new Uint32Array(NET_WORDS);

    // Four ticks: the host publishes itself and a bot, the guest itself; the
    // guest also reports one hit on the host's bot.
    for (let t = 0; t < 4; t += 1) {
      host.beforeTick(hw);
      publish(hw, 0, [1, 2, 3]);
      publish(hw, 5, [7, 8, 9]);
      hw[71] = 0x1234;
      host.afterTick(hw);

      guest.beforeTick(gw);
      publish(gw, 1, [4, 5, 6]);
      if (t === 3) send(gw, 1, 0x505);
      guest.afterTick(gw);
    }

    host.beforeTick(hw);
    expect(hw[0]! & 3).toBe(NET_MODE_HOST);
    expect((hw[0]! >> 8) & 0xff).toBe(0b11); // two humans
    expect((hw[0]! >> 16) & 0xff).toBe(0b10); // the guest's state is live
    expect(Array.from(hw.subarray(3 + 3, 3 + 6))).toEqual([4, 5, 6]);
    expect(hw[27]).toBe(1);
    expect(Array.from(hw.subarray(28, 30))).toEqual([1, 0x505]);

    guest.beforeTick(gw);
    expect(gw[0]! & 3).toBe(NET_MODE_CLIENT);
    expect((gw[0]! >> 2) & 7).toBe(1);
    expect(gw[1]).toBe(0x1234);
    expect(Array.from(gw.subarray(3, 6))).toEqual([1, 2, 3]);
    expect(Array.from(gw.subarray(3 + 15, 3 + 18))).toEqual([7, 8, 9]); // the host's bot
    expect(gw[27]).toBe(0); // events are delivered once

    // A guest's view of its own slot is never overwritten by relayed state.
    expect(Array.from(gw.subarray(3 + 3, 3 + 6))).toEqual([0, 0, 0]);

    // State that stops arriving goes stale.
    advance(5000);
    guest.beforeTick(gw);
    expect((gw[0]! >> 16) & 0xff).toBe(0);
  });

  it("promotes the guest to host when the host leaves", async () => {
    const { host, guest } = await room();
    host.close();
    expect(guest.mySlot).toBe(0);
    expect(guest.isHost).toBe(true);
  });

  it("writes an offline inbox before connecting", () => {
    const hub = new MemoryNetHub();
    const solo = new NetSession(hub.transport("x"));
    const words = new Uint32Array(NET_WORDS).fill(0xffffffff);
    solo.beforeTick(words);
    expect(words[0]).toBe(0);
    expect(words[27]).toBe(0);
  });
});
