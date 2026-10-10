/**
 * The network lab (LOCKOUT_MULTIPLAYER_ROADMAP.md L2): a simulated network
 * that delays, jitters, reorders, loses and throttles messages on a virtual
 * clock, and a harness that plays real Lockout engines in one room over it,
 * reporting each client's traffic and how far each client's view of the other
 * players drifts from where their owners have them — the baseline the
 * netcode items (L3–L8) must beat.
 */

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NetSession, SimulatedNetHub, encodeNetMessage, runNetLab, type LinkConditions, type NetLabReport, type NetMessage } from "@cartbox/player";
import { LOCKOUT_ENGINE, LOCKOUT_PROBE, lockoutLabCart, lockoutLabInput } from "./helpers/lockoutNetLab";

/** Two peers on a hub; what the second hears, with the virtual time it arrived. */
async function pair(conditions: LinkConditions, seed = 1) {
  const hub = new SimulatedNetHub(conditions, seed);
  const a = hub.transport("a");
  const b = hub.transport("b");
  const heard: { at: number; message: NetMessage }[] = [];
  b.onMessage((message) => heard.push({ at: hub.now(), message }));
  await a.connect(0);
  await b.connect(1);
  return { hub, a, heard };
}

describe("the simulated network", () => {
  it("delays every message by the link's latency, on the virtual clock", async () => {
    const { hub, a, heard } = await pair({ latencyMs: 80 });
    a.send({ m: 1 });
    hub.advance(79);
    expect(heard).toHaveLength(0);
    hub.advance(1);
    expect(heard).toEqual([{ at: 80, message: { m: 1 } }]);
  });

  it("loses about the share it's told to, and the same messages for the same seed", async () => {
    const run = async (seed: number) => {
      const { hub, a, heard } = await pair({ latencyMs: 10, loss: 0.2 }, seed);
      for (let i = 0; i < 1000; i += 1) a.send({ m: i });
      hub.advance(20);
      return heard.map((h) => h.message.m);
    };
    const once = await run(7);
    expect(once.length).toBeGreaterThan(760);
    expect(once.length).toBeLessThan(840);
    expect(await run(7)).toEqual(once);
    expect(await run(8)).not.toEqual(once);
  });

  it("reorders messages under jitter", async () => {
    const { hub, a, heard } = await pair({ latencyMs: 50, jitterMs: 40 });
    for (let i = 0; i < 50; i += 1) {
      a.send({ m: i });
      hub.advance(2);
    }
    hub.advance(100);
    const order = heard.map((h) => h.message.m!);
    expect(order).toHaveLength(50);
    expect(order).not.toEqual([...order].sort((x, y) => x - y));
  });

  it("queues a sender's messages behind each other on a thin uplink", async () => {
    // 1 KB/s: a ~320-byte message (packed, as it travels) takes about a third of a second to leave.
    const { hub, a, heard } = await pair({ latencyMs: 0, bandwidth: 1000 });
    const big = { e: Array.from({ length: 40 }, (_, i) => [i, 123456789] as [number, number]) };
    const bytes = encodeNetMessage(big).length;
    a.send(big);
    a.send(big);
    hub.advance(5000);
    expect(heard[0]!.at).toBeGreaterThanOrEqual((bytes / 1000) * 1000 - 17);
    expect(heard[1]!.at - heard[0]!.at).toBeGreaterThanOrEqual((bytes / 1000) * 1000 - 17);
  });

  it("carries a NetSession room: two sessions see each other's slot state through it", async () => {
    const hub = new SimulatedNetHub({ latencyMs: 30 });
    const one = new NetSession(hub.transport("p0"), hub.now);
    const two = new NetSession(hub.transport("p1"), hub.now);
    await one.connect();
    await two.connect();
    expect([one.mySlot, two.mySlot]).toEqual([0, 1]);
  });
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("Lockout in the lab (today's netcode, the baseline)", () => {
  const lab = (conditions: LinkConditions, players = 2, ticks = 600) =>
    runNetLab({ players, conditions, ticks, warmup: 30, seed: 3, cart: lockoutLabCart, input: lockoutLabInput(0), probe: LOCKOUT_PROBE });

  const reports: NetLabReport[] = [];

  it("measures two players at 0, 80 and 200 ms: drift grows with latency, traffic doesn't", async () => {
    for (const latencyMs of [0, 80, 200]) reports.push(await lab({ latencyMs, jitterMs: latencyMs / 8 }));
    const [lan, net, far] = reports;
    for (const r of reports) {
      // Both players were seen by each other through most of the match.
      expect(r.humans.samples).toBeGreaterThan(600);
      expect(r.all.samples).toBeGreaterThan(r.humans.samples);
    }
    // Remote Spartans trail their owners more the further away they are.
    expect(net!.humans.mean).toBeGreaterThan(lan!.humans.mean);
    expect(far!.humans.mean).toBeGreaterThan(net!.humans.mean);
    // The same messages go out whatever the latency: 15 Hz for two players.
    expect(Math.abs(far!.bytesPerSecond[0]!.sent - lan!.bytesPerSecond[0]!.sent)).toBeLessThan(lan!.bytesPerSecond[0]!.sent * 0.25);
    // A record of the baseline, for the netcode items to beat.
    console.log(
      "net lab baseline (2 players, 10 s):\n" +
        reports
          .map((r) => `  ${r.conditions.latencyMs} ms: humans drift mean ${r.humans.mean} m, p95 ${r.humans.p95} m, max ${r.humans.max} m; all ${r.all.mean} m; host sends ${r.bytesPerSecond[0]!.sent} B/s, receives ${r.bytesPerSecond[0]!.received} B/s`)
          .join("\n"),
    );
  }, 300_000);

  it("reports the same numbers for the same seed", async () => {
    const again = await lab({ latencyMs: 80, jitterMs: 10 });
    expect(again).toEqual(reports[1]);
  }, 300_000);

  it("plays a full room of 8 at 80 ms with 5% loss inside a traffic budget", async () => {
    const r = await lab({ latencyMs: 80, jitterMs: 20, loss: 0.05 }, 8, 300);
    expect(r.humans.samples).toBeGreaterThan(1000);
    expect(r.messages.lost).toBeGreaterThan(0);
    for (const b of r.bytesPerSecond) {
      expect(b.sent).toBeLessThan(2_000);
      expect(b.received).toBeLessThan(12_000);
    }
    console.log(`net lab, 8 players at 80 ms with 5% loss: humans drift mean ${r.humans.mean} m, p95 ${r.humans.p95} m; host sends ${r.bytesPerSecond[0]!.sent} B/s, receives ${r.bytesPerSecond[0]!.received} B/s; guest sends ${r.bytesPerSecond[1]!.sent} B/s`);
  }, 600_000);
});
