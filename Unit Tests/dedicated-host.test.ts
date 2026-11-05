/**
 * A headless authoritative host (AAA_PRODUCTION_ROADMAP.md N2), the engine
 * side: a peer announcing itself as dedicated is the room's host wherever it
 * joins, holds a slot but isn't counted a player, and the cart is told.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { DEDICATED_HOST_NAME, MemoryNetHub, NetSession, codeChunks, createDirectConsole, getModel, injectSdk } from "@cartbox/player";
import { NET_IN_HEADER, NET_IN_HOST, writeNetInbox } from "../packages/player/src/net/netplay";

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

const MODERN_CORE = path.resolve(__dirname, "../packages/modern-core/dist/modern-core.js");

describe.skipIf(!existsSync(MODERN_CORE))("the cart's view of a dedicated host (N2)", () => {
  it("cartbox.net() says the host is dedicated, and which slot it holds", async () => {
    const code = `function TIC()
  local mode, slot, humans, _, _, hostslot, dedicated = cartbox.net()
  pmem(100, mode) pmem(101, hostslot) pmem(102, dedicated and 1 or 0) pmem(103, humans)
end`;
    const mod = await (await import(pathToFileURL(MODERN_CORE).href)).default();
    const console = createDirectConsole(mod, getModel("xbox360"));
    expect(console.loadCartridge(injectSdk(codeChunks(new TextEncoder().encode(code))))).toBe(true);
    const run = (dedicatedHost: boolean) => {
      writeNetInbox(console.netWords()!, { mode: 1, mySlot: 1, humans: 0b110, live: 0b111, match: 0, clock: 0, hostSlot: 0, dedicatedHost, slots: [], events: [] });
      console.tick(0);
      expect(console.readError().message).toBe("");
      return [...console.netWords()!.slice(100, 104)];
    };
    expect(run(true)).toEqual([1, 0, 1, 0b110]); // a guest; the host in slot 0 is dedicated, and not among the people
    expect(run(false)).toEqual([1, 0, 0, 0b110]);
  });
});
