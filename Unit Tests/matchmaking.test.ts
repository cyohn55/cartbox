/**
 * Matchmaking: choosing a room from the advertised ones, and Matchmakers moving
 * real NetSessions into shared rooms — joining an open room of the same
 * playlist, opening one when there is none, keeping the host's advertisement
 * current, merging two rooms opened at the same moment, and cancelling.
 */

import { describe, expect, it } from "vitest";

import { MemoryNetHub, NetSession, SwitchableTransport } from "@cartbox/player";
import {
  MM_IDLE,
  MM_IN_ROOM,
  Matchmaker,
  betterRoom,
  chooseRoom,
  type AdvertisedRoom,
  type MatchBoard,
} from "../apps/web/src/lib/matchmaking";

describe("chooseRoom", () => {
  const rooms: AdvertisedRoom[] = [
    { room: "AAAAA", mode: 2, players: 3, createdAt: 10 },
    { room: "BBBBB", mode: 2, players: 5, createdAt: 20 },
    { room: "CCCCC", mode: 2, players: 8, createdAt: 5 }, // full
    { room: "DDDDD", mode: 0, players: 6, createdAt: 1 },
  ];
  it("joins the fullest open room of the playlist", () => {
    expect(chooseRoom(rooms, 2)?.room).toBe("BBBBB");
    expect(chooseRoom(rooms, "any")?.room).toBe("DDDDD");
    expect(chooseRoom(rooms, 4)).toBeNull();
  });
  it("merges a lone room into an older one of the same playlist", () => {
    const mine = { room: "ZZZZZ", mode: 2, players: 1, createdAt: 30 };
    expect(betterRoom(rooms, mine)?.room).toBe("AAAAA");
    expect(betterRoom(rooms, { ...mine, createdAt: 1 })).toBeNull(); // mine is the oldest
  });
});

/** An in-memory board shared by several matchmakers. */
function boardHub() {
  const entries = new Map<string, AdvertisedRoom>();
  const listeners = new Set<() => void>();
  let n = 0;
  return (): MatchBoard => {
    const key = `b${n++}`;
    return {
      ready: async () => {},
      rooms: () => [...entries].filter(([k]) => k !== key).map(([, r]) => r),
      onChange: (listener) => void listeners.add(listener),
      advertise: (room) => {
        if (room) entries.set(key, room);
        else entries.delete(key);
        for (const listener of listeners) queueMicrotask(listener);
      },
      close: () => void entries.delete(key),
    };
  };
}

async function searcher(board: MatchBoard, rooms: Map<string, MemoryNetHub>, name: string, codes: string[], clock: { t: number }) {
  const switcher = new SwitchableTransport();
  const session = new NetSession(switcher);
  await session.connect(name);
  const mm = new Matchmaker({
    board,
    switcher,
    session,
    openRoom: async (room) => {
      if (!rooms.has(room)) rooms.set(room, new MemoryNetHub());
      return rooms.get(room)!.transport(`${name}-${room}`);
    },
    newRoom: () => codes.shift()!,
    now: () => clock.t++,
  });
  return { mm, session, board };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("Matchmaker", () => {
  it("opens a room when none is open, and the next searcher joins it", async () => {
    const hub = boardHub();
    const rooms = new Map<string, MemoryNetHub>();
    const clock = { t: 100 };
    const a = await searcher(hub(), rooms, "a", ["ROOMA"], clock);
    const b = await searcher(hub(), rooms, "b", ["ROOMB"], clock);
    await a.mm.search(2);
    expect(a.mm.current).toBe("ROOMA");
    expect(a.session.isHost).toBe(true);
    await b.mm.search(2);
    await settle();
    expect(b.mm.current).toBe("ROOMA");
    expect(b.session.mySlot).toBe(1);
    expect(a.board.rooms()).toHaveLength(0); // only the host advertises…
    expect(b.board.rooms()[0]).toMatchObject({ room: "ROOMA", players: 2 }); // …with the count kept current
  });

  it("keeps playlists apart", async () => {
    const hub = boardHub();
    const rooms = new Map<string, MemoryNetHub>();
    const clock = { t: 100 };
    const a = await searcher(hub(), rooms, "a", ["ROOMA"], clock);
    const b = await searcher(hub(), rooms, "b", ["ROOMB"], clock);
    await a.mm.search(2);
    await b.mm.search(4);
    expect(b.mm.current).toBe("ROOMB");
    const c = await searcher(hub(), rooms, "c", ["ROOMC"], clock);
    await c.mm.search("any"); // any playlist: the fullest (a tie: the older, A's)
    expect(c.mm.current).toBe("ROOMA");
  });

  it("merges two rooms opened at the same moment", async () => {
    const hub = boardHub();
    const rooms = new Map<string, MemoryNetHub>();
    const clock = { t: 100 };
    const a = await searcher(hub(), rooms, "a", ["ROOMA"], clock);
    const b = await searcher(hub(), rooms, "b", ["ROOMB"], clock);
    await Promise.all([a.mm.search(1), b.mm.search(1)]); // neither saw the other's room
    for (let i = 0; i < 5; i += 1) await settle();
    expect(a.mm.current).toBe(b.mm.current);
    expect(new Set([a.session.mySlot, b.session.mySlot])).toEqual(new Set([0, 1]));
  });

  it("cancels: leaves the room, stops advertising, and reports idle", async () => {
    const hub = boardHub();
    const rooms = new Map<string, MemoryNetHub>();
    const clock = { t: 100 };
    const a = await searcher(hub(), rooms, "a", ["ROOMA"], clock);
    const watcher = hub();
    await a.mm.search(0);
    expect(watcher.rooms()).toHaveLength(1);
    await a.mm.cancel();
    expect(a.mm.current).toBeNull();
    expect(watcher.rooms()).toHaveLength(0);
    expect(a.session.mySlot).toBe(-1);
    const words = new Uint32Array(119);
    a.session.beforeTick(words);
    expect((words[0]! >> 5) & 7).toBe(MM_IDLE);
    await a.mm.search(0);
    a.session.beforeTick(words);
    expect((words[0]! >> 5) & 7).toBe(MM_IN_ROOM);
  });
});
