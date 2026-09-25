/**
 * Lockout's title-screen matchmaking, through the real engine: picking
 * Matchmaking → a playlist asks the page (cartbox.request) to find a room; in
 * a room the host's lobby starts that playlist's game type on its own, and a
 * second player who joins lands in the same match; cancelling asks the page to
 * leave; a failed search says so.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { lockoutCartridge } from "@cartbox/editor";
import {
  MemoryNetHub,
  NET_WORDS,
  NetSession,
  SwitchableTransport,
  decodeMailbox,
  decodeMeshPoses,
  injectSdk,
  type MailboxEvent,
} from "@cartbox/player";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const DOWN = 1 << 1, A = 1 << 4, B = 1 << 5;

async function player(session: NetSession) {
  const tic = injectSdk(lockoutCartridge());
  const mod = await (await import(pathToFileURL(ENGINE).href)).default();
  const h = mod._cbx_create(44100);
  const ptr = mod._malloc(tic.length);
  mod.HEAPU8.set(tic, ptr);
  expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
  mod._free(ptr);
  const mailbox = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice();
  const net = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
  let seq = decodeMailbox(mailbox(), 0).seq;
  const requests: MailboxEvent[] = [];
  const tick = (buttons = 0) => {
    session.beforeTick(net());
    mod._cbx_tick(h, buttons);
    session.afterTick(net());
    const read = decodeMailbox(mailbox(), seq);
    seq = read.seq;
    requests.push(...read.events.filter((e) => e.kind === "request"));
  };
  /** Press and release a button (menus act on the press). */
  const press = (button: number) => {
    tick(button);
    tick(0);
  };
  const inMatch = () => decodeMeshPoses(mailbox()).some((p) => p.index >= 1 && p.index <= 7 && p.position[1] > -10);
  return { tick, press, requests, inMatch, net, mailbox };
}

describe.skipIf(!existsSync(ENGINE))("Lockout matchmaking from the title screen", () => {
  it("asks the page for a SWAT match, hosts the lobby, and starts SWAT for everyone", async () => {
    const hub = new MemoryNetHub();
    const switcherA = new SwitchableTransport();
    const sessionA = new NetSession(switcherA);
    await sessionA.connect();
    const a = await player(sessionA);
    for (let i = 0; i < 3; i += 1) a.tick();

    // Title: seven game types, then Matchmaking last.
    for (let i = 0; i < 7; i += 1) a.press(DOWN);
    a.press(A);
    // Playlist: Any, Free for All, Team Slayer, SWAT…
    for (let i = 0; i < 3; i += 1) a.press(DOWN);
    a.press(A);
    expect(a.requests.at(-1)).toMatchObject({ kind: "request", id: 1, value: 3 }); // matchmake, SWAT

    // The page finds nobody, so it opens a room: player A hosts it.
    sessionA.setStatus(1);
    await switcherA.use(hub.transport("a"));
    sessionA.setStatus(2);
    for (let i = 0; i < 10; i += 1) a.tick();
    expect(a.inMatch()).toBe(false); // the lobby waits for players

    // Player B's search finds A's room and joins it.
    const switcherB = new SwitchableTransport();
    const sessionB = new NetSession(switcherB);
    await sessionB.connect();
    const b = await player(sessionB);
    for (let i = 0; i < 3; i += 1) b.tick();
    await switcherB.use(hub.transport("b"));
    for (let i = 0; i < 10; i += 1) {
      a.tick();
      b.tick();
    }
    expect(sessionB.mySlot).toBe(1);

    // The host starts now (or its 15s timer would): both are in the SWAT match.
    a.press(A);
    for (let i = 0; i < 20; i += 1) {
      a.tick();
      b.tick();
    }
    expect(a.inMatch()).toBe(true);
    expect(b.inMatch()).toBe(true);
    const word = a.net()[71]!; // the host's match word: in play, game type index 2 (SWAT)
    expect(word & 1).toBe(1);
    expect((word >> 1) & 7).toBe(2);
  }, 120_000);

  it("starts the lobby on its own after the countdown", async () => {
    const hub = new MemoryNetHub();
    const switcher = new SwitchableTransport();
    const session = new NetSession(switcher);
    await session.connect();
    const a = await player(session);
    for (let i = 0; i < 3; i += 1) a.tick();
    for (let i = 0; i < 7; i += 1) a.press(DOWN);
    a.press(A);
    a.press(A); // "Any game type"
    expect(a.requests.at(-1)).toMatchObject({ id: 1, value: 0 });
    await switcher.use(hub.transport("a"));
    for (let i = 0; i < 960; i += 1) a.tick();
    expect(a.inMatch()).toBe(true);
  }, 120_000);

  it("cancels a search, and reports a failed one", async () => {
    const switcher = new SwitchableTransport();
    const session = new NetSession(switcher);
    await session.connect();
    const a = await player(session);
    for (let i = 0; i < 3; i += 1) a.tick();
    for (let i = 0; i < 7; i += 1) a.press(DOWN);
    a.press(A);
    a.press(A);
    session.setStatus(3); // the page couldn't matchmake
    for (let i = 0; i < 3; i += 1) a.tick();
    a.press(B);
    expect(a.requests.at(-1)).toMatchObject({ id: 2 }); // cancel
    // Back on the title screen, still on Matchmaking: A opens the playlists again.
    a.press(A);
    a.press(A);
    expect(a.requests.at(-1)).toMatchObject({ id: 1, value: 0 });
  }, 120_000);
});
