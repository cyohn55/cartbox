/**
 * A sidecar and a cart per map (BEAVER_CREEK_ROADMAP.md B2). Any map gets
 * its own sidecar from the arena's shared assets, with Pickups over its own
 * pads, in the instance order its cart's code is written for. With more than
 * one map, the title menu offers the next and asks the page to load it, and
 * online the host's match word carries its map: a guest on another map asks
 * for the host's instead of joining the host's match on the wrong one, and a
 * guest's hello mid-match has the host catch it up.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARENA_MAPS,
  LOCKOUT_CODE,
  LOCKOUT_SCENE,
  LOCKOUT_VIEWMODELS,
  arenaCenter,
  arenaFlight,
  arenaMap,
  arenaMapCode,
  arenaMeshSidecar,
  lockoutCartridge,
  lockoutCode,
  lockoutMeshSidecar,
  type ArenaMap,
} from "@cartbox/editor";
import { NET_WORDS, injectSdk, parseMeshScene, readSidecarUi, uiSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";
import { lockoutRoom } from "./helpers/lockoutRoom";
import { LOCKOUT_ENGINE } from "./helpers/lockoutNetLab";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A small map with two pads that turn through their weapons. */
const TWO_PADS: ArenaMap = {
  id: "twopads",
  name: "Two Pads",
  solids: [[0, -0.5, 0, 12, 0.5, 6]],
  flights: [arenaFlight("z", 0, 1, -2.2, 1, 2, 0)],
  spawns: [
    { at: [-9, 0, 0], team: "blue" },
    { at: [-9, 0, 3], team: "blue" },
    { at: [9, 0, 0], team: "red" },
    { at: [9, 0, 3], team: "red" },
  ],
  destinations: [[-6, 0, 0], [6, 0, 0]],
  power: [0],
  hills: [[0, 0, 3]],
  ball: [0, 0.4, 3],
  deathY: -4,
  markers: [
    { box: [-3, 0.4, 0, 0.28, 0.4, 0.28], weapon: "rocket", rotation: ["rocket", "splaser", "hammer"] },
    { box: [3, 0.4, 0, 0.28, 0.4, 0.28], weapon: "needler" },
  ],
};

describe("a sidecar and a cart for any map", () => {
  it("lists Lockout first, by id, with its own code", () => {
    expect(ARENA_MAPS[0]!.id).toBe("lockout");
    expect(arenaMap("nowhere").id).toBe("lockout");
    expect(arenaMap("lockout").sidecar()).toBe(lockoutMeshSidecar());
    // The editor's Lockout knows only itself (it has no page to load another);
    // the demo's knows every map, so its menu offers them.
    expect(LOCKOUT_CODE).toContain('MAPS = { "Lockout" }');
    expect(arenaMapCode("lockout")).toContain(`MAPS = { ${ARENA_MAPS.map((m) => JSON.stringify(m.name)).join(", ")} }`);
  });

  it("builds another map's sidecar from the shared assets, its Pickups over its own pads", () => {
    const sidecar = arenaMeshSidecar({ ...LOCKOUT_SCENE, id: "twopads", name: "Two Pads", map: TWO_PADS });
    const scene = parseMeshScene(sidecar)!;
    const names = scene.instances.map((i) => i.name);
    expect(names[0]).toBe("Two Pads arena");
    expect(names.slice(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7].map((i) => `bot ${i}`));
    const first = 8 + LOCKOUT_VIEWMODELS.length;
    expect(names.slice(first, first + 4)).toEqual(["pickup rocket", "pickup splaser", "pickup hammer", "pickup needler"]);
    expect(names.slice(first + 4, first + 6)).toEqual(["hologram 1", "hologram 2"]);
    const pickups = scene.instances.slice(first, first + 4);
    expect(pickups.map((p) => p.model[12])).toEqual([-3, -3, -3, 3]); // (the translation)
    // Its cart is written for that order.
    const code = lockoutCode(TWO_PADS, arenaCenter(TWO_PADS));
    expect(code).toContain('PAD_ROT = { { "rocket", "splaser", "hammer" }, { "needler" } }');
    expect(code).toContain(`HOLO_IDX = { ${first + 4}, ${first + 5} }`);
    // (Lockout's, built the same way, is unchanged in kind: six pads, 21 Pickups.)
    const lockout = parseMeshScene(lockoutMeshSidecar())!.instances.filter((i) => i.name.startsWith("pickup "));
    expect(lockout).toHaveLength(21);
  });
});

/** Request kinds and values the probe saw, in pmem 117 (kind | value << 8 | count << 16). */
const REQUESTS = `;(function()
local _r = cartbox.request
cartbox.request = function(k, v) REQ_N = (REQ_N or 0) + 1; REQ_K, REQ_V = k, v; if _r then return _r(k, v) end end
local _T = TIC
function TIC()
  _T()
  pmem(117, (REQ_K or 0) | ((REQ_V or 0) << 8) | ((REQ_N or 0) << 16))
  pmem(118, phase == "play" and 1 or 0)
end
end)()`;

describe.skipIf(!existsSync(ENGINE))("choosing a map from the title menu", () => {
  async function menu(boot: string) {
    const code = `${lockoutCode(TWO_PADS, arenaCenter(TWO_PADS), { maps: ["Lockout", "Two Pads"], mapIndex: 1 })}\n${boot}\n${REQUESTS}`;
    const tic = injectSdk(prependLuaCode(lockoutCartridge(code), uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const words = () => new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS);
    return { tick: (b = 0) => mod._cbx_tick(h, b), probe: () => [words()[117]!, words()[118]!] as const };
  }

  it("offers the next map after the game types, and asks the page for it", async () => {
    const m = await menu("");
    const DOWN = 1 << 1, A = 1 << 4;
    for (let i = 0; i < 3; i += 1) m.tick();
    for (let i = 0; i < 7; i += 1) {
      m.tick(DOWN);
      m.tick();
    }
    m.tick(A);
    m.tick();
    const [req, playing] = m.probe();
    expect(req & 0xff).toBe(3); // REQ_MAP
    expect((req >> 8) & 0xff).toBe(0); // the next map: Lockout (0-based), round from the last
    expect(playing).toBe(0); // and no match started here
  }, 60_000);

  it("keeps the cursor on the map after the page loads one, to step on again", async () => {
    const m = await menu("MAP_SWITCHED = true");
    for (let i = 0; i < 3; i += 1) m.tick();
    m.tick(1 << 4);
    m.tick();
    expect(m.probe()[0] & 0xff).toBe(3);
  }, 60_000);
});

describe.skipIf(!existsSync(LOCKOUT_ENGINE))("a guest follows its host's map", () => {
  it("asks for the host's map rather than joining its match on another", async () => {
    const hostProbe = `MAPS = { "Lockout", "Two Pads" }; MAP_INDEX = 2; MAP_NAME = MAPS[2]`;
    const guestProbe = `MAPS = { "Lockout", "Two Pads" }; MAP_INDEX = 1; MAP_NAME = MAPS[1]\n${REQUESTS}`;
    const { guest, both } = await lockoutRoom("", { hostProbe, guestProbe });
    for (let f = 0; f < 120; f += 1) both(0, 0);
    const [req, playing] = guest.probe();
    expect(req & 0xff).toBe(3);
    expect((req >> 8) & 0xff).toBe(1); // the host's: Two Pads
    expect(req >>> 16).toBe(1); // asked once
    expect(playing).toBe(0);
  }, 120_000);

  it("on the same map, joins the host's match as before", async () => {
    const both2 = `MAPS = { "Lockout", "Two Pads" }; MAP_INDEX = 1; MAP_NAME = MAPS[1]`;
    const { guest, both } = await lockoutRoom("", { hostProbe: both2, guestProbe: `${both2}\n${REQUESTS}` });
    for (let f = 0; f < 120; f += 1) both(0, 0);
    const [req, playing] = guest.probe();
    expect(req >>> 16).toBe(0);
    expect(playing).toBe(1);
  }, 120_000);

  it("catches a guest up when it says hello mid-match", async () => {
    const hostProbe = `;(function()
local _c = net_catch_up
function net_catch_up() CATCHUPS = (CATCHUPS or 0) + 1; return _c() end
local _T = TIC
function TIC() _T(); pmem(117, CATCHUPS or 0) end
end)()`;
    const guestProbe = `;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase == "play" then n = n + 1 end
  if n == 60 then cartbox.netsend(1 | ((MYSLOT & 7) << 4) | (5 << 7), 0) end
end
end)()`;
    const { host, both } = await lockoutRoom("", { hostProbe, guestProbe });
    for (let f = 0; f < 30; f += 1) both(0, 0);
    const before = host.probe()[0];
    for (let f = 0; f < 90; f += 1) both(0, 0);
    expect(host.probe()[0]).toBe(before + 1);
  }, 120_000);
});
