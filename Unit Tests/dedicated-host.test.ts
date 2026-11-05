/**
 * A headless authoritative host (AAA_PRODUCTION_ROADMAP.md N2), the engine
 * side: a peer announcing itself as dedicated is the room's host wherever it
 * joins, holds a slot but isn't counted a player, and the cart is told.
 */
import { describe, expect, it } from "vitest";
import { DEDICATED_HOST_NAME, MemoryNetHub, NetSession } from "@cartbox/player";
import { NET_IN_HEADER, NET_IN_HOST } from "../packages/player/src/net/netplay";

async function join(hub: MemoryNetHub, id: string, name?: string, clock = () => 0) {
  const s = new NetSession(hub.transport(id), clock);
  await s.connect(name);
  return s;
}

describe("a dedicated host (N2)", () => {
  it("is host wherever it joins, for everyone, and holds a slot without counting as a player", async () => {
    const hub = new MemoryNetHub();
    const ana = await join(hub, "ana");
    const server = await join(hub, "srv", `${DEDICATED_HOST_NAME}eu-1`);
    const ben = await join(hub, "ben");
    // A few ticks: the rosters settle (the host's is adopted).
    const words = new Uint32Array(256);
    for (let t = 0; t < 60; t += 1) for (const s of [ana, server, ben]) {
      s.beforeTick(words);
      s.afterTick(words);
    }
    expect(server.isHost).toBe(true);
    expect(ana.isHost).toBe(false);
    expect(ben.isHost).toBe(false);
    expect(ana.hostSlot).toBe(server.mySlot);
    expect(ben.hostSlot).toBe(server.mySlot);
    ana.beforeTick(words);
    expect(words[NET_IN_HOST]! & 7).toBe(server.mySlot);
    expect(words[NET_IN_HOST]! & 8).toBe(8); // the cart is told its host is dedicated
    const humans = (words[NET_IN_HEADER]! >>> 8) & 0xff;
    expect(humans & (1 << server.mySlot)).toBe(0);
    expect(humans & (1 << ana.mySlot)).not.toBe(0);
  });

  it("without one, the lowest slot hosts as before, and the cart sees no dedicated host", async () => {
    const hub = new MemoryNetHub();
    const ana = await join(hub, "ana");
    const ben = await join(hub, "ben");
    expect(ana.isHost).toBe(true);
    const words = new Uint32Array(256);
    ben.beforeTick(words);
    expect(words[NET_IN_HOST]! & 8).toBe(0);
  });
});
