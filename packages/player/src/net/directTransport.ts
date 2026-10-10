/**
 * Direct connections between players (LOCKOUT_MULTIPLAYER_ROADMAP.md L3): a
 * {@link NetTransport} that opens a WebRTC data channel to every peer, using a
 * relay transport (Supabase Realtime, say) for presence, for the handshake,
 * and for any peer a direct connection can't reach.
 *
 * Each link has two channels: `state`, unordered with no retransmits (a lost
 * snapshot is replaced by the next), and `events`, reliable and ordered (a
 * hit or a kill must arrive). Messages on them are packed binary
 * (netCodec.ts). A message is sent directly to every peer whose channels are
 * open and once through the relay, addressed to the rest; so each peer gets
 * it exactly once. With every peer direct the session sends at 30 Hz.
 *
 * The lower peer id makes the offer, so each pair negotiates once. A link
 * that fails, or hasn't opened within `timeoutMs`, stays on the relay.
 */

import { decodeNetMessage, encodeNetMessage } from "./netCodec.js";
import { netSendInterval, type NetMessage, type NetPeer, type NetSignal, type NetTransport } from "./NetSession.js";

/** The parts of the WebRTC API the transport uses (so tests can stand in for it). */
export interface RtcDataChannelLike {
  readonly label: string;
  readyState: string;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}
export interface RtcPeerConnectionLike {
  connectionState: string;
  onicecandidate: ((event: { candidate: unknown }) => void) | null;
  ondatachannel: ((event: { channel: RtcDataChannelLike }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  createDataChannel(label: string, options?: { ordered?: boolean; maxRetransmits?: number }): RtcDataChannelLike;
  createOffer(): Promise<{ type: string; sdp?: string }>;
  createAnswer(): Promise<{ type: string; sdp?: string }>;
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>;
  setRemoteDescription(description: { type: string; sdp?: string }): Promise<void>;
  addIceCandidate(candidate: unknown): Promise<void>;
  close(): void;
}
export type RtcPeerConnectionFactory = (config: { iceServers: readonly { urls: string | readonly string[] }[] }) => RtcPeerConnectionLike;

export interface DirectTransportOptions {
  /** Makes peer connections; absent (or null) means none can be made: everything goes over the relay. */
  readonly rtc?: RtcPeerConnectionFactory | null;
  readonly iceServers?: readonly { urls: string | readonly string[] }[];
  /** How long a link may take to open before its peer stays on the relay, ms. */
  readonly timeoutMs?: number;
  /** Ticks between messages with every peer direct (2: 30 Hz). */
  readonly directInterval?: number;
}

/** Public STUN, to find each browser's address; no TURN (a relay of our own we don't run). */
const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];

/** The browser's RTCPeerConnection as a factory, when there is one. */
export function browserRtc(): RtcPeerConnectionFactory | null {
  const Ctor = (globalThis as { RTCPeerConnection?: new (config: unknown) => RtcPeerConnectionLike }).RTCPeerConnection;
  return Ctor ? (config) => new Ctor(config) : null;
}

type LinkState = "connecting" | "open" | "relay";

interface Link {
  readonly peer: string;
  readonly pc: RtcPeerConnectionLike;
  state: RtcDataChannelLike | null;
  events: RtcDataChannelLike | null;
  status: LinkState;
  timer: ReturnType<typeof setTimeout> | null;
}

export class DirectTransport implements NetTransport {
  private readonly links = new Map<string, Link>();
  private peers: readonly NetPeer[] = [];
  private messageHandler: ((message: NetMessage, from: string) => void) | null = null;
  private peersHandler: ((peers: readonly NetPeer[]) => void) | null = null;
  private readonly rtc: RtcPeerConnectionFactory | null;
  private closed = false;

  constructor(
    private readonly relay: NetTransport,
    private readonly options: DirectTransportOptions = {},
  ) {
    this.rtc = options.rtc === undefined ? browserRtc() : options.rtc;
  }

  get selfId(): string {
    return this.relay.selfId;
  }

  /** How each other peer is reached: directly, still connecting, or through the relay. */
  linkStatus(peer: string): LinkState {
    return this.links.get(peer)?.status ?? "relay";
  }

  async connect(joinedAt: number, name?: string): Promise<void> {
    this.relay.onMessage((message, from) => this.fromRelay(message, from));
    this.relay.onPeers((peers) => {
      this.peers = peers;
      this.syncLinks();
      this.peersHandler?.(peers);
    });
    await this.relay.connect(joinedAt, name);
  }

  send(message: NetMessage): void {
    const others = this.peers.filter((p) => p.id !== this.selfId);
    const relayed: string[] = [];
    let stateBytes: Uint8Array | null = null;
    let eventBytes: Uint8Array | null = null;
    for (const peer of others) {
      const link = this.links.get(peer.id);
      if (link?.status !== "open" || !link.state || !link.events) {
        relayed.push(peer.id);
        continue;
      }
      // Snapshots (and the match word) unreliably; events reliably.
      if (message.s || message.m !== undefined) link.state.send((stateBytes ??= encodeNetMessage({ s: message.s, m: message.m })));
      if (message.e) link.events.send((eventBytes ??= encodeNetMessage({ e: message.e })));
    }
    if (relayed.length > 0) this.relay.send(relayed.length === others.length ? message : { ...message, r: relayed });
  }

  sendInterval(players: number): number {
    const others = this.peers.filter((p) => p.id !== this.selfId);
    const allDirect = others.length > 0 && others.every((p) => this.links.get(p.id)?.status === "open");
    return allDirect ? (this.options.directInterval ?? 2) : netSendInterval(players);
  }

  onMessage(handler: (message: NetMessage, from: string) => void): void {
    this.messageHandler = handler;
  }

  onPeers(handler: (peers: readonly NetPeer[]) => void): void {
    this.peersHandler = handler;
  }

  close(): void {
    this.closed = true;
    for (const link of this.links.values()) this.drop(link);
    this.links.clear();
    this.relay.close();
  }

  // --- Links ---------------------------------------------------------------

  /** Open a link to every new peer (offering when our id is lower) and drop departed ones. */
  private syncLinks(): void {
    if (this.closed) return;
    const present = new Set(this.peers.map((p) => p.id));
    for (const [id, link] of this.links) {
      if (!present.has(id)) {
        this.drop(link);
        this.links.delete(id);
      }
    }
    if (!this.rtc) return;
    for (const peer of this.peers) {
      if (peer.id === this.selfId || this.links.has(peer.id)) continue;
      if (this.selfId < peer.id) void this.offer(peer.id);
    }
  }

  private newLink(peer: string): Link {
    const pc = this.rtc!({ iceServers: this.options.iceServers ?? DEFAULT_ICE });
    const link: Link = { peer, pc, state: null, events: null, status: "connecting", timer: null };
    this.links.set(peer, link);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal({ to: peer, candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fallBack(link);
    };
    pc.ondatachannel = ({ channel }) => this.attach(link, channel);
    link.timer = setTimeout(() => {
      if (link.status === "connecting") this.fallBack(link);
    }, this.options.timeoutMs ?? 5000);
    return link;
  }

  private async offer(peer: string): Promise<void> {
    const link = this.newLink(peer);
    try {
      this.attach(link, link.pc.createDataChannel("state", { ordered: false, maxRetransmits: 0 }));
      this.attach(link, link.pc.createDataChannel("events", { ordered: true }));
      const offer = await link.pc.createOffer();
      await link.pc.setLocalDescription(offer);
      this.signal({ to: peer, description: offer });
    } catch {
      this.fallBack(link);
    }
  }

  private async answer(peer: string, description: { type: string; sdp?: string }): Promise<void> {
    if (!this.rtc) return;
    const existing = this.links.get(peer);
    if (existing) {
      this.drop(existing);
      this.links.delete(peer);
    }
    const link = this.newLink(peer);
    try {
      await link.pc.setRemoteDescription(description);
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      this.signal({ to: peer, description: answer });
    } catch {
      this.fallBack(link);
    }
  }

  private attach(link: Link, channel: RtcDataChannelLike): void {
    channel.binaryType = "arraybuffer";
    if (channel.label === "state") link.state = channel;
    else if (channel.label === "events") link.events = channel;
    else return;
    channel.onopen = () => this.maybeOpen(link);
    channel.onclose = () => this.fallBack(link);
    channel.onmessage = ({ data }) => {
      const bytes = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
      const message = bytes ? decodeNetMessage(bytes) : null;
      if (message && this.links.get(link.peer) === link) this.messageHandler?.(message, link.peer);
    };
    if (channel.readyState === "open") this.maybeOpen(link);
  }

  private maybeOpen(link: Link): void {
    if (link.status !== "connecting") return;
    if (link.state?.readyState === "open" && link.events?.readyState === "open") {
      link.status = "open";
      if (link.timer) clearTimeout(link.timer);
    }
  }

  private fallBack(link: Link): void {
    if (link.status === "relay") return;
    link.status = "relay";
    if (link.timer) clearTimeout(link.timer);
  }

  private drop(link: Link): void {
    if (link.timer) clearTimeout(link.timer);
    link.status = "relay";
    try {
      link.state?.close();
      link.events?.close();
      link.pc.close();
    } catch {
      // already gone
    }
  }

  // --- The relay -------------------------------------------------------------

  private signal(sig: NetSignal): void {
    this.relay.send({ sig });
  }

  private fromRelay(message: NetMessage, from: string): void {
    if (message.sig) {
      if (message.sig.to === this.selfId) void this.onSignal(message.sig, from);
      return;
    }
    if (message.r && !message.r.includes(this.selfId)) return; // we had it directly
    if (message.r) {
      const { r: _r, ...rest } = message;
      void _r;
      this.messageHandler?.(rest, from);
      return;
    }
    this.messageHandler?.(message, from);
  }

  private async onSignal(sig: NetSignal, from: string): Promise<void> {
    if (sig.description?.type === "offer") {
      await this.answer(from, sig.description);
      return;
    }
    const link = this.links.get(from);
    if (!link) return;
    try {
      if (sig.description) await link.pc.setRemoteDescription(sig.description);
      if (sig.candidate) await link.pc.addIceCandidate(sig.candidate);
    } catch {
      this.fallBack(link);
    }
  }
}
