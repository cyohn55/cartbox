/**
 * Direct connections between players (LOCKOUT_MULTIPLAYER_ROADMAP.md L3):
 * messages packed in binary; WebRTC data channels between peers, signalled
 * over the room's relay, with an unreliable channel for snapshots and a
 * reliable one for events; the relay for any peer a direct link can't reach,
 * each message reaching each peer once; 30 Hz with every peer direct — and in
 * the lab, Lockout's remote Spartans drifting less for it.
 */

import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DirectTransport,
  MemoryNetHub,
  NetSession,
  decodeNetMessage,
  encodeNetMessage,
  runNetLab,
  type NetMessage,
  type NetTransport,
  type RtcDataChannelLike,
  type RtcPeerConnectionFactory,
  type RtcPeerConnectionLike,
} from "@cartbox/player";
import { LOCKOUT_ENGINE, LOCKOUT_PROBE, lockoutLabCart, lockoutLabInput } from "./helpers/lockoutNetLab";

describe("the packed message format", () => {
  it("round-trips states, events and the match word, well under the JSON", () => {
    const message: NetMessage = {
      s: [[0, 0xdeadbeef, 12345, 0], [3, 1, 2, 3]],
      e: [[0x11223344, 0xffffffff], [5, 6]],
      m: 0x80000001,
    };
    const bytes = encodeNetMessage(message);
    expect(decodeNetMessage(bytes)).toEqual(message);
    expect(bytes.length).toBe(1 + 1 + 2 * 13 + 2 + 2 * 8 + 4);
    expect(bytes.length).toBeLessThan(JSON.stringify(message).length * 0.6);
    // Full 32-bit words (Lockout packs positions into them): about a third.
    const lockoutLike: NetMessage = { s: [[1, 0xfe0c0a1b, 0x3a2b00c8, 0x000a3c64]] };
    expect(encodeNetMessage(lockoutLike).length).toBeLessThan(JSON.stringify(lockoutLike).length * 0.4);
    expect(decodeNetMessage(encodeNetMessage({}))).toEqual({});
    expect(decodeNetMessage(encodeNetMessage({ m: 0 }))).toEqual({ m: 0 });
  });

  it("refuses bytes that aren't a message", () => {
    expect(decodeNetMessage(new Uint8Array([]))).toBeNull();
    expect(decodeNetMessage(new Uint8Array([0x80]))).toBeNull(); // unknown flag
    expect(decodeNetMessage(new Uint8Array([1, 2, 0]))).toBeNull(); // two states promised, none there
    expect(decodeNetMessage(new Uint8Array([4, 0, 0, 0, 0, 9]))).toBeNull(); // trailing byte
  });
});

// --- A stand-in for WebRTC -------------------------------------------------------

/** An in-memory WebRTC: links open (or fail) as the rules say; channels deliver asynchronously. */
class FakeRtc {
  readonly pcs = new Map<string, FakePc>();
  /** Pairs (by owner, "a|b" sorted) whose connection fails. */
  readonly failing = new Set<string>();
  /** Owners whose connections never open (and never say they failed). */
  readonly silent = new Set<string>();
  /** Drop the next n messages on unreliable channels. */
  dropUnreliable = 0;
  private next = 0;

  factory(owner: string): RtcPeerConnectionFactory {
    return () => {
      const pc = new FakePc(this, owner, `pc${this.next++}`);
      this.pcs.set(pc.id, pc);
      return pc;
    };
  }

  connect(offerer: FakePc, answerer: FakePc): void {
    const pair = [offerer.owner, answerer.owner].sort().join("|");
    if (this.silent.has(offerer.owner) || this.silent.has(answerer.owner)) return;
    if (this.failing.has(pair)) {
      for (const pc of [offerer, answerer]) {
        pc.connectionState = "failed";
        pc.onconnectionstatechange?.();
      }
      return;
    }
    queueMicrotask(() => {
      for (const local of offerer.channels) {
        const remote = new FakeChannel(this, local.label, local.reliable);
        local.peer = remote;
        remote.peer = local;
        answerer.ondatachannel?.({ channel: remote });
        for (const ch of [local, remote]) {
          ch.readyState = "open";
          ch.onopen?.();
        }
      }
      offerer.connectionState = answerer.connectionState = "connected";
    });
  }
}

class FakeChannel implements RtcDataChannelLike {
  readyState = "connecting";
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  peer: FakeChannel | null = null;
  constructor(
    private readonly rtc: FakeRtc,
    readonly label: string,
    readonly reliable: boolean,
  ) {}
  send(data: Uint8Array): void {
    if (this.readyState !== "open") throw new Error("channel not open");
    if (!this.reliable && this.rtc.dropUnreliable > 0) {
      this.rtc.dropUnreliable -= 1;
      return;
    }
    const copy = data.slice().buffer;
    const peer = this.peer;
    queueMicrotask(() => peer?.onmessage?.({ data: copy }));
  }
  close(): void {
    this.readyState = "closed";
  }
}

class FakePc implements RtcPeerConnectionLike {
  connectionState = "new";
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  readonly channels: FakeChannel[] = [];
  constructor(
    private readonly rtc: FakeRtc,
    readonly owner: string,
    readonly id: string,
  ) {}
  createDataChannel(label: string, options?: { ordered?: boolean; maxRetransmits?: number }): RtcDataChannelLike {
    const ch = new FakeChannel(this.rtc, label, options?.maxRetransmits === undefined);
    this.channels.push(ch);
    return ch;
  }
  async createOffer() {
    return { type: "offer", sdp: this.id };
  }
  async createAnswer() {
    return { type: "answer", sdp: this.id };
  }
  async setLocalDescription(): Promise<void> {
    // Every handshake trickles one candidate through the relay.
    queueMicrotask(() => this.onicecandidate?.({ candidate: { candidate: `host ${this.id}` } }));
  }
  async setRemoteDescription(description: { type: string; sdp?: string }): Promise<void> {
    if (description.type === "answer") this.rtc.connect(this, this.rtc.pcs.get(description.sdp!)!);
  }
  async addIceCandidate(): Promise<void> {}
  close(): void {
    this.connectionState = "closed";
  }
}

/** A relay transport that counts the game messages (not handshakes) it carries. */
function counting(inner: NetTransport): NetTransport & { relayed: NetMessage[] } {
  const relayed: NetMessage[] = [];
  return Object.assign(Object.create(inner) as NetTransport, {
    relayed,
    send(message: NetMessage) {
      if (!message.sig) relayed.push(message);
      inner.send(message);
    },
    onMessage: (h: Parameters<NetTransport["onMessage"]>[0]) => inner.onMessage(h),
    onPeers: (h: Parameters<NetTransport["onPeers"]>[0]) => inner.onPeers(h),
    connect: (j: number, n?: string) => inner.connect(j, n),
    close: () => inner.close(),
    selfId: inner.selfId,
  });
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function room(ids: string[], rtc: FakeRtc | null, options: { timeoutMs?: number } = {}) {
  const hub = new MemoryNetHub();
  const peers = ids.map((id) => {
    const relay = counting(hub.transport(id));
    const transport = new DirectTransport(relay, { rtc: rtc ? rtc.factory(id) : null, ...options });
    const heard: { message: NetMessage; from: string }[] = [];
    transport.onMessage((message, from) => heard.push({ message, from }));
    return { id, relay, transport, heard };
  });
  for (const [i, p] of peers.entries()) await p.transport.connect(i, p.id);
  await settle();
  return peers;
}

afterEach(() => vi.useRealTimers());

describe("direct connections", () => {
  it("open a link between two players and carry their messages directly, once", async () => {
    const [a, b] = await room(["a", "b"], new FakeRtc());
    expect(a!.transport.linkStatus("b")).toBe("open");
    expect(b!.transport.linkStatus("a")).toBe("open");
    a!.transport.send({ s: [[0, 1, 2, 3]], e: [[9, 9]], m: 4 });
    await settle();
    // States and the match word on one channel, the events on the other: both arrive, once each.
    const got = b!.heard.map((h) => h.message);
    expect(got).toContainEqual({ s: [[0, 1, 2, 3]], m: 4 });
    expect(got).toContainEqual({ e: [[9, 9]] });
    expect(got).toHaveLength(2);
    expect(a!.relay.relayed).toEqual([]); // nothing went through the relay
  });

  it("keep events when snapshots are lost", async () => {
    const rtc = new FakeRtc();
    const [a, b] = await room(["a", "b"], rtc);
    rtc.dropUnreliable = 1;
    a!.transport.send({ s: [[0, 1, 1, 1]], e: [[7, 7]] });
    await settle();
    expect(b!.heard.map((h) => h.message)).toEqual([{ e: [[7, 7]] }]);
  });

  it("fall back to the relay for a pair that can't connect, still reaching each player once", async () => {
    const rtc = new FakeRtc();
    rtc.failing.add("b|c");
    const [a, b, c] = await room(["a", "b", "c"], rtc);
    expect(b!.transport.linkStatus("c")).toBe("relay");
    expect(b!.transport.linkStatus("a")).toBe("open");
    b!.transport.send({ s: [[1, 5, 5, 5]] });
    await settle();
    expect(a!.heard.map((h) => h.message)).toEqual([{ s: [[1, 5, 5, 5]] }]); // directly
    expect(c!.heard.map((h) => h.message)).toEqual([{ s: [[1, 5, 5, 5]] }]); // through the relay, addressed to c only
    expect(b!.relay.relayed).toEqual([{ s: [[1, 5, 5, 5]], r: ["c"] }]);
  });

  it("fall back to the relay when a link never opens", async () => {
    vi.useFakeTimers();
    const rtc = new FakeRtc();
    rtc.silent.add("b");
    const [a, b] = await room(["a", "b"], rtc, { timeoutMs: 3000 });
    expect(a!.transport.linkStatus("b")).toBe("connecting");
    vi.advanceTimersByTime(3000);
    expect(a!.transport.linkStatus("b")).toBe("relay");
    a!.transport.send({ m: 1 });
    expect(b!.heard.map((h) => h.message)).toEqual([{ m: 1 }]);
  });

  it("use only the relay where there's no WebRTC", async () => {
    const [a, b] = await room(["a", "b"], null);
    expect(a!.transport.linkStatus("b")).toBe("relay");
    a!.transport.send({ m: 2 });
    expect(b!.heard.map((h) => h.message)).toEqual([{ m: 2 }]);
    expect(a!.transport.sendInterval(2)).toBe(4);
  });

  it("let a session send at 30 Hz once every peer is direct", async () => {
    const rtc = new FakeRtc();
    const hub = new MemoryNetHub();
    const one = new DirectTransport(hub.transport("a"), { rtc: rtc.factory("a") });
    const two = new DirectTransport(hub.transport("b"), { rtc: rtc.factory("b") });
    const session = new NetSession(one);
    await session.connect();
    await two.connect(Date.now() + 1);
    await settle();
    expect(one.sendInterval(2)).toBe(2);
    const sent: NetMessage[] = [];
    two.onMessage((m) => sent.push(m));
    const words = new Uint32Array(119);
    for (let t = 0; t < 12; t += 1) {
      session.beforeTick(words);
      // The cart publishes a moving state every tick.
      words[70] = 1;
      words[72] = t;
      session.afterTick(words);
    }
    await settle();
    expect(sent.filter((m) => m.s)).toHaveLength(6);
  });
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("Lockout in the lab over direct links", () => {
  it("drifts less at 30 Hz than at the relay's rate over the same latency, inside the traffic budget", async () => {
    const lab = (direct: boolean, players = 2, ticks = 600) =>
      runNetLab({ players, conditions: { latencyMs: 80, jitterMs: 10, direct }, ticks, warmup: 30, seed: 3, cart: lockoutLabCart, input: lockoutLabInput(0), probe: LOCKOUT_PROBE });
    const relay = await lab(false);
    const direct = await lab(true);
    // The rate alone (same one-way latency): a snapshot half as stale. Cutting the
    // relay's server hop out of the latency is the larger gain online, which the
    // lab can't know; the easing toward each snapshot is L4's to replace.
    expect(direct.humans.mean).toBeLessThan(relay.humans.mean * 0.95);
    expect(direct.humans.p95).toBeLessThan(relay.humans.p95);
    // Packed binary at 30 Hz: twice the messages at about half the size each,
    // so about what the JSON cost at 15 Hz (2.7 KB/s for the host, with 6 bots).
    expect(direct.bytesPerSecond[0]!.sent).toBeLessThan(relay.bytesPerSecond[0]!.sent * 2.1);
    expect(direct.bytesPerSecond[0]!.sent).toBeLessThan(3_200);
    const full = await lab(true, 8, 300);
    for (const b of full.bytesPerSecond) {
      expect(b.sent).toBeLessThan(2_000);
      expect(b.received).toBeLessThan(10_000);
    }
    console.log(
      `direct links, 80 ms: humans drift mean ${direct.humans.mean} m (relay ${relay.humans.mean} m), p95 ${direct.humans.p95} m (relay ${relay.humans.p95} m); ` +
        `host sends ${direct.bytesPerSecond[0]!.sent} B/s (relay ${relay.bytesPerSecond[0]!.sent} B/s); ` +
        `8 players: drift mean ${full.humans.mean} m, host sends ${full.bytesPerSecond[0]!.sent} B/s, receives ${full.bytesPerSecond[0]!.received} B/s`,
    );
  }, 600_000);
});
