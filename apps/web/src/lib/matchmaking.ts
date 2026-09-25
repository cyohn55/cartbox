/**
 * Matchmaking: find other people to play with, without a server of our own.
 *
 * Hosts of public (matchmade) rooms advertise them on a shared "board" — a
 * presence channel every searcher can read: Supabase Realtime presence online,
 * a BroadcastChannel between the tabs of one browser otherwise. A search reads
 * the board, joins the fullest open room of the playlist it wants, and if there
 * is none opens a room of its own and advertises it. Two searchers who open
 * rooms at the same moment would each sit alone, so a host still alone in its
 * room moves into an older open room of the same playlist when one appears.
 *
 * The game (the cart) decides when a matchmade room's match starts; this only
 * gets people into the same room.
 */

import type { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";
import type { NetSession, NetTransport, SwitchableTransport } from "@cartbox/player";

import { newRoomCode, onlineRoomsAvailable, roomTransport } from "./netplayTransport";

/** A public room as its host advertises it. */
export interface AdvertisedRoom {
  readonly room: string;
  /** Playlist (game type index); a searcher for "any" accepts every playlist. */
  readonly mode: number;
  readonly players: number;
  readonly createdAt: number;
}

/** Players a room holds (the game's slots). */
export const ROOM_CAPACITY = 8;

/**
 * The room a searcher should join: an open room of the playlist it wants (any
 * playlist for "any"), fullest first so rooms fill up rather than fragment,
 * then oldest. Null when there is none — the searcher opens its own.
 */
export function chooseRoom(rooms: readonly AdvertisedRoom[], wanted: number | "any", exclude?: string): AdvertisedRoom | null {
  const open = rooms.filter(
    (r) => r.room !== exclude && r.players < ROOM_CAPACITY && r.players > 0 && (wanted === "any" || r.mode === wanted),
  );
  open.sort((a, b) => b.players - a.players || a.createdAt - b.createdAt || (a.room < b.room ? -1 : 1));
  return open[0] ?? null;
}

/**
 * Whether a host alone in `mine` should move into another advertised room: one
 * of the same playlist, with space, opened earlier (ties broken by code so both
 * sides agree on which one survives).
 */
export function betterRoom(rooms: readonly AdvertisedRoom[], mine: AdvertisedRoom): AdvertisedRoom | null {
  const older = rooms.filter(
    (r) =>
      r.room !== mine.room &&
      r.mode === mine.mode &&
      r.players > 0 &&
      r.players < ROOM_CAPACITY &&
      (r.createdAt < mine.createdAt || (r.createdAt === mine.createdAt && r.room < mine.room)),
  );
  older.sort((a, b) => a.createdAt - b.createdAt || (a.room < b.room ? -1 : 1));
  return older[0] ?? null;
}

/** Where public rooms are advertised. */
export interface MatchBoard {
  /** Resolves once the board has had a chance to hear the rooms already open. */
  ready(): Promise<void>;
  rooms(): readonly AdvertisedRoom[];
  onChange(listener: () => void): void;
  /** Advertise this browser's room (while it hosts one), or stop (null). */
  advertise(room: AdvertisedRoom | null): void;
  close(): void;
}

/** The board over Supabase Realtime presence: each host tracks its room. */
export class SupabaseMatchBoard implements MatchBoard {
  private readonly key = `m-${Math.random().toString(36).slice(2, 10)}`;
  private readonly channel: RealtimeChannel;
  private readonly listeners = new Set<() => void>();
  private list: AdvertisedRoom[] = [];
  private subscribed: Promise<void>;
  private advertised: AdvertisedRoom | null = null;

  constructor(
    private readonly client: SupabaseClient,
    topic: string,
  ) {
    this.channel = client.channel(topic, { config: { presence: { key: this.key } } });
    this.channel.on("presence", { event: "sync" }, () => {
      const state = this.channel.presenceState<Partial<AdvertisedRoom>>();
      this.list = Object.entries(state).flatMap(([key, metas]) => {
        const meta = metas[0];
        if (key === this.key || !meta || typeof meta.room !== "string") return [];
        return [{ room: meta.room, mode: Number(meta.mode) || 0, players: Number(meta.players) || 0, createdAt: Number(meta.createdAt) || 0 }];
      });
      for (const listener of this.listeners) listener();
    });
    this.subscribed = new Promise((resolve) => {
      this.channel.subscribe((status) => {
        if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
      });
    });
  }

  async ready(): Promise<void> {
    await this.subscribed;
    await new Promise((r) => setTimeout(r, 1200)); // let the first presence sync land
  }
  rooms(): readonly AdvertisedRoom[] {
    return this.list;
  }
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }
  advertise(room: AdvertisedRoom | null): void {
    const same = JSON.stringify(room) === JSON.stringify(this.advertised);
    this.advertised = room;
    if (same) return;
    void this.subscribed.then(() => (room ? this.channel.track(room) : this.channel.untrack()));
  }
  close(): void {
    void this.channel.untrack();
    void this.client.removeChannel(this.channel);
  }
}

/** The board across the tabs of one browser: hosts announce their rooms each second. */
export class BroadcastMatchBoard implements MatchBoard {
  private readonly id = `t-${Math.random().toString(36).slice(2, 10)}`;
  private readonly channel: BroadcastChannel;
  private readonly seen = new Map<string, { room: AdvertisedRoom; at: number }>();
  private readonly listeners = new Set<() => void>();
  private advertised: AdvertisedRoom | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(topic: string) {
    this.channel = new BroadcastChannel(topic);
    this.channel.onmessage = (event: MessageEvent) => {
      const data = event.data as { from: string; room: AdvertisedRoom | null };
      if (!data || data.from === this.id) return;
      if (data.room) this.seen.set(data.from, { room: data.room, at: Date.now() });
      else this.seen.delete(data.from);
      this.emit();
    };
    this.timer = setInterval(() => {
      if (this.advertised) this.channel.postMessage({ from: this.id, room: this.advertised });
      const now = Date.now();
      let changed = false;
      for (const [key, entry] of this.seen) if (now - entry.at > 3500) changed = this.seen.delete(key) || changed;
      if (changed) this.emit();
    }, 1000);
  }

  async ready(): Promise<void> {
    await new Promise((r) => setTimeout(r, 1200)); // hear the hosts' next announcements
  }
  rooms(): readonly AdvertisedRoom[] {
    return [...this.seen.values()].map((entry) => entry.room);
  }
  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }
  advertise(room: AdvertisedRoom | null): void {
    this.advertised = room;
    this.channel.postMessage({ from: this.id, room });
  }
  close(): void {
    clearInterval(this.timer);
    this.channel.postMessage({ from: this.id, room: null });
    this.channel.close();
  }
  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** The board for a game: Supabase Realtime online, else this browser's tabs. */
export async function matchBoard(game: string): Promise<MatchBoard> {
  if (onlineRoomsAvailable()) {
    const { supabaseBrowser } = await import("./supabase-browser");
    return new SupabaseMatchBoard(supabaseBrowser(), `cartbox-mm:${game}`);
  }
  return new BroadcastMatchBoard(`cartbox-mm:${game}`);
}

/** Status codes the game reads (net()'s fifth value). */
export const MM_IDLE = 0;
export const MM_SEARCHING = 1;
export const MM_IN_ROOM = 2;
export const MM_FAILED = 3;

export interface MatchmakerOptions {
  readonly board: MatchBoard;
  readonly switcher: SwitchableTransport;
  readonly session: NetSession;
  /** Opens a room's transport (default: roomTransport for the game). */
  readonly openRoom: (room: string) => Promise<NetTransport>;
  /** Room code generator (tests pass a fixed one). */
  readonly newRoom?: () => string;
  readonly now?: () => number;
  /** For the page's status line. */
  readonly onStatus?: (status: { code: number; room: string | null; hosting: boolean }) => void;
}

/** Runs searches, keeps the host's advertisement current, and merges lone rooms. */
export class Matchmaker {
  private room: AdvertisedRoom | null = null;
  private searching = 0;

  constructor(private readonly options: MatchmakerOptions) {
    options.board.onChange(() => void this.maybeMerge());
    options.session.onStatus(() => this.readvertise());
  }

  /** The matchmade room this browser is in, or null. */
  get current(): string | null {
    return this.room?.room ?? null;
  }

  /** Find (or open) a room of `wanted`'s playlist and move into it. */
  async search(wanted: number | "any"): Promise<void> {
    const token = ++this.searching;
    const { board, session } = this.options;
    this.setStatus(MM_SEARCHING);
    try {
      await this.leaveRoom();
      await board.ready();
      if (token !== this.searching) return; // cancelled meanwhile
      const pick = chooseRoom(board.rooms(), wanted);
      if (pick) {
        await this.enter({ ...pick });
      } else {
        const now = (this.options.now ?? Date.now)();
        await this.enter({ room: (this.options.newRoom ?? newRoomCode)(), mode: wanted === "any" ? 0 : wanted, players: 1, createdAt: now });
      }
      if (token !== this.searching) return;
      session.resetRoom();
      this.setStatus(MM_IN_ROOM);
      this.readvertise();
    } catch {
      if (token === this.searching) {
        await this.leaveRoom();
        this.setStatus(MM_FAILED);
      }
    }
  }

  /** Stop searching / leave the matchmade room. */
  async cancel(): Promise<void> {
    this.searching += 1;
    await this.leaveRoom();
    this.setStatus(MM_IDLE);
  }

  close(): void {
    this.searching += 1;
    this.options.board.advertise(null);
    this.options.board.close();
  }

  private async enter(room: AdvertisedRoom): Promise<void> {
    this.room = room;
    await this.options.switcher.use(await this.options.openRoom(room.room));
  }

  private async leaveRoom(): Promise<void> {
    this.room = null;
    this.options.board.advertise(null);
    await this.options.switcher.use(null);
    this.options.session.resetRoom();
  }

  /** The host keeps its room's advertisement (player count) current; guests don't advertise. */
  private readvertise(): void {
    const { session, board } = this.options;
    if (!this.room) return;
    const status = session.status();
    if (!status.isHost) {
      board.advertise(null);
      return;
    }
    this.room = { ...this.room, players: Math.max(1, status.peers.length) };
    board.advertise(this.room);
  }

  /** A host still alone moves into an older open room of its playlist. */
  private async maybeMerge(): Promise<void> {
    const { session, board } = this.options;
    const mine = this.room;
    if (!mine) return;
    const status = session.status();
    if (!status.isHost || status.peers.length > 1) return;
    const target = betterRoom(board.rooms(), mine);
    if (!target) return;
    const token = this.searching;
    board.advertise(null);
    await this.enter({ ...target });
    if (token === this.searching) session.resetRoom();
  }

  private setStatus(code: number): void {
    this.options.session.setStatus(code);
    this.options.onStatus?.({ code, room: this.room?.room ?? null, hosting: this.options.session.isHost });
  }
}

/** A matchmaker for a game with the default board and rooms. */
export async function createMatchmaker(
  game: string,
  switcher: SwitchableTransport,
  session: NetSession,
  onStatus?: MatchmakerOptions["onStatus"],
): Promise<Matchmaker> {
  return new Matchmaker({
    board: await matchBoard(game),
    switcher,
    session,
    openRoom: (room) => roomTransport(game, `mm-${room}`),
    onStatus,
  });
}
