/**
 * Beaver Creek in grey box (BEAVER_CREEK_ROADMAP.md B8): a valid map with the
 * whole sandbox on its pads, playing every game type on the real engine as
 * the player runs it (bots walking its navmesh, over its ground), its
 * teleporters carrying soldiers and bots across the canyon, and a match on it
 * online staying in step.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARENA_MAPS,
  BEAVER_GROUND,
  BEAVER_MAP,
  DEFAULT_ACCESSIBILITY,
  LOCKOUT_STRINGS,
  LOCKOUT_VIEWMODELS,
  arenaMap,
  arenaMapCartridge,
  arenaMapCode,
  arenaPads,
  beaverCenter,
  beaverFoliage,
  beaverNavMesh,
  beaverTerrain,
  validateArenaMap,
} from "@cartbox/editor";
import {
  INPUT_BLOCK_BYTES,
  NET_WORDS,
  PHYS_BLOCK_BYTES,
  RAM_LAYOUTS,
  RuntimeChannel,
  actionsSdkLua,
  appendLuaCode,
  componentsSdkLua,
  createConsole,
  getModel,
  injectSdk,
  inputBlockAddress,
  parseMeshScene,
  physicsBlockAddress,
  playLanguage,
  prependLuaCode,
  readSidecarActions,
  readSidecarUi,
  runtimeSdkLua,
  saveSdkLua,
  sceneObjectsSdkLua,
  seedCartridge,
  stringsSdkLua,
  takePhysicsCommands,
  uiSdkLua,
  writeInputBlock,
  writeInputSettings,
} from "@cartbox/player";
import { lockoutRoom } from "./helpers/lockoutRoom";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const LAYOUT = RAM_LAYOUTS.xbox360;

describe("Beaver Creek, the map", () => {
  it("is the second map, and passes the validator", () => {
    expect(ARENA_MAPS.map((m) => m.id)).toEqual(["lockout", "beaver"]);
    expect(arenaMap("beaver").name).toBe("Beaver Creek");
    expect(validateArenaMap(BEAVER_MAP, { navmesh: beaverNavMesh(), sidecar: { size: arenaMap("beaver").sidecar().length, budget: 2_800_000 } })).toEqual([]);
    // Every map's code knows both, and its own place.
    expect(arenaMapCode("beaver")).toContain('MAPS = { "Lockout", "Beaver Creek" }');
    expect(arenaMapCode("beaver")).toContain("MAP_INDEX = 2");
    expect(arenaMapCode("lockout")).toContain("MAP_INDEX = 1");
  });

  it("puts the camera's centre where the player bounds its scene", () => {
    const bounds = parseMeshScene(arenaMap("beaver").sidecar())!.bounds;
    beaverCenter().forEach((v, a) => expect(v).toBeCloseTo(bounds.center[a]!, 5));
  });

  it("carries the whole sandbox on its pads, Halo's weapons first", () => {
    const pads = arenaPads(BEAVER_MAP);
    const offered = new Set(pads.flat());
    // Everything but the Magnum (which is a loadout's), as on Lockout.
    expect([...offered].sort()).toEqual(LOCKOUT_VIEWMODELS.filter((w) => w !== "magnum").sort());
    // A Sniper Rifle on each base's roof, the Rocket Launcher on the creek bed under the arch.
    const at = (w: string) => BEAVER_MAP.markers.filter((m) => m.weapon === w).map((m) => m.box.slice(0, 3));
    expect(at("sniper")).toEqual([[-22, 3.8, -3], [22, 3.8, 3]]);
    expect(at("rocket")).toEqual([[0, -0.6, 0]]);
    // Two teleporters, each from a roof to the ledge by the other base.
    expect(BEAVER_MAP.teleporters!.map((t) => [Math.sign(t.from[0]), Math.sign(t.to[0])])).toEqual([[-1, 1], [1, -1]]);
  });
});

/** Beaver Creek's cartridge as the player prepares it, with `probe` appended. */
async function play(probe: string) {
  const sidecar = arenaMap("beaver").sidecar();
  const mesh = parseMeshScene(sidecar)!;
  let prepared = seedCartridge(arenaMapCartridge("beaver", probe), 12345);
  const components = componentsSdkLua(mesh);
  if (components) prepared = appendLuaCode(prependLuaCode(prepared, components.prelude), components.postlude);
  prepared = prependLuaCode(prepared, saveSdkLua(LAYOUT, null));
  prepared = prependLuaCode(prepared, actionsSdkLua(readSidecarActions(sidecar), LAYOUT));
  prepared = prependLuaCode(prepared, stringsSdkLua(LOCKOUT_STRINGS, playLanguage(LOCKOUT_STRINGS, ["en"]), DEFAULT_ACCESSIBILITY, inputBlockAddress(LAYOUT)));
  prepared = prependLuaCode(prepared, uiSdkLua(readSidecarUi(sidecar), 1280, 720));
  prepared = prependLuaCode(prepared, sceneObjectsSdkLua(mesh));
  prepared = prependLuaCode(prepared, runtimeSdkLua(mesh, LAYOUT, { physics: false }));
  const hd = createConsole(await (await import(pathToFileURL(ENGINE).href)).default(), getModel("xbox360"), 44100);
  expect(hd.loadCartridge(injectSdk(prepared))).toBe(true);
  const channel = new RuntimeChannel(mesh, null);
  const view = (offset: number, length: number) => {
    const b = hd.ramView(offset - LAYOUT.pmemAddress, length)!;
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
  };
  let last = 0;
  const tick = (buttons = 0, held = 0) => {
    const block = view(inputBlockAddress(LAYOUT), INPUT_BLOCK_BYTES);
    writeInputBlock(block, held, last);
    writeInputSettings(block, DEFAULT_ACCESSIBILITY, 1, 1);
    last = held;
    channel.beforeTick(view(physicsBlockAddress(LAYOUT), PHYS_BLOCK_BYTES));
    hd.tick(buttons);
    channel.applyCommands(takePhysicsCommands(view(physicsBlockAddress(LAYOUT), PHYS_BLOCK_BYTES)));
    const error = hd.readError().message;
    if (error) throw new Error(error);
  };
  const words = () => {
    const w = hd.netWords()!;
    return [w[117]!, w[118]!] as const;
  };
  /** From the title screen into the game type `downs` presses down the list, past the intro. */
  const start = (downs: number) => {
    for (let i = 0; i < 4; i += 1) tick();
    for (let i = 0; i < downs; i += 1) {
      tick(1 << 1);
      tick();
    }
    tick(1 << 4);
    for (let i = 0; i < 40; i += 1) tick(i % 2 ? 1 << 4 : 0);
  };
  return { tick, words, start, destroy: () => channel.destroy() };
}

/** pmem 117: bots alive (bits 0-3), bots in the canyon (4-7), in play (8), kills (16+); 118: the player's x, z (cm + 5000). */
const WATCH = `;(function()
local _rk = register_kill
function register_kill(k, v, h) KILLS = (KILLS or 0) + 1; return _rk(k, v, h) end
local _T = TIC
function TIC()
  _T()
  local alive, inside = 0, 0
  for _,o in ipairs(bots) do
    if not o.dead then
      alive = alive + 1
      if math.abs(o.x) < 33 and math.abs(o.z) < 16 and o.y > -2 and o.y < 9 then inside = inside + 1 end
    end
  end
  pmem(117, alive | (inside << 4) | ((phase == "play" and 1 or 0) << 8) | ((KILLS or 0) << 16))
  if p then pmem(118, (math.floor(p.x*100 + 5000) & 0xffff) | ((math.floor(p.z*100 + 5000) & 0xffff) << 16)) end
end
end)()`;

describe("Beaver Creek, dressed (B9)", () => {
  it("textures its canyon: grass on the flats and sandstone on the walls, mapped triplanar", () => {
    const t = beaverTerrain();
    expect(t.triplanar).toBe(true);
    expect(t.layers.map((l) => l.material.baseColorImage?.mime)).toEqual(["image/png", "image/png"]);
  });

  it("grows grass and reeds clear of the bases, the pads and the water, and trees only out of play", () => {
    const layers = beaverFoliage();
    const g = BEAVER_GROUND;
    const byId = Object.fromEntries(layers.map(({ layer }) => [layer.id, layer]));
    expect(byId["beaver-grass"]!.copies.length).toBeGreaterThan(300);
    expect(byId["beaver-reeds"]!.copies.length).toBeGreaterThan(40);
    const pads = BEAVER_MAP.markers.map((m) => m.box);
    for (const id of ["beaver-grass", "beaver-reeds"]) {
      for (const c of byId[id]!.copies) {
        const x = c.x + g.x0;
        const z = c.z + g.z0;
        expect(Math.abs(x) < 4.6 && Math.abs(z) < 11.2, `${id} in the water at ${x}, ${z}`).toBe(false);
        expect(Math.abs(x) > 18.6 && Math.abs(x) < 31.4 && Math.abs(z) < 6.4, `${id} in a base at ${x}, ${z}`).toBe(false);
        expect(pads.some((b) => Math.abs(x - b[0]) < 1.4 && Math.abs(z - b[2]) < 1.4), `${id} on a pad at ${x}, ${z}`).toBe(false);
      }
    }
    // Low plants only where play goes; trees and boulders are filled on the rims and walls by rules.
    expect(byId["beaver-grass"]!.wind).toBeGreaterThan(0);
    for (const id of ["beaver-trees", "beaver-pines"]) expect(byId[id]!.fill?.height?.[0]).toBeGreaterThan(10);
  });

  it("stores them in its sidecar, still within budget", () => {
    const stored = JSON.parse(arenaMap("beaver").sidecar()) as { foliage?: unknown[] };
    expect(stored.foliage?.length).toBe(5);
    expect(arenaMap("beaver").sidecar().length).toBeLessThan(2_800_000);
  });
});

describe.skipIf(!existsSync(ENGINE))("Beaver Creek on the real engine, as the player runs it", () => {
  it("plays every game type, its bots alive and in the canyon", async () => {
    for (let downs = 0; downs < 7; downs += 1) {
      const g = await play(WATCH);
      g.start(downs);
      for (let i = 0; i < 600; i += 1) g.tick();
      const [w] = g.words();
      expect((w >> 8) & 1, `game type ${downs}`).toBe(1);
      expect(w & 15, `game type ${downs}`).toBeGreaterThanOrEqual(5);
      expect((w >> 4) & 15, `game type ${downs}`).toBe(w & 15);
      g.destroy();
    }
  }, 300_000);

  it("has its bots fight over the canyon in Free for All: kills happen", async () => {
    const g = await play(WATCH);
    g.start(0);
    for (let i = 0; i < 3600; i += 1) g.tick();
    const [w] = g.words();
    console.log(`B8: a minute of Free for All on Beaver Creek: ${w >>> 16} kills`);
    expect(w >>> 16).toBeGreaterThan(0);
    g.destroy();
  }, 300_000);

  it("teleports a soldier from blue's roof to the ledge by red's base, and a bot from red's to blue's", async () => {
    const g = await play(`;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  n = n + 1
  local o = bots[1]
  if n == 5 then
    p.x, p.y, p.z, p.vy, p.tp_cd = -26, 3.4, 2.8, 0, 0
    nav_drop(o); o.x, o.y, o.z, o.dead, o.respawn, o.tp_cd = 26, 3.4, -3.5, false, 0, 0; nav_place(o)
  end
  if n == 4 or n == 30 then
    pmem(118, (math.floor(o.x*100 + 5000) & 0xffff) | ((math.floor(o.z*100 + 5000) & 0xffff) << 16))
  end
  if n > 5 and n < 30 then move_soldier(p, 1, 0, 0, false, false, false, 0) end
  if n == 30 then pmem(117, (math.floor(p.x*100 + 5000) & 0xffff) | ((math.floor(p.z*100 + 5000) & 0xffff) << 16)) end
end
end)()`);
    g.start(0);
    for (let i = 0; i < 40; i += 1) g.tick();
    const [a, b] = g.words();
    const xz = (w: number) => [((w & 0xffff) - 5000) / 100, ((w >>> 16) - 5000) / 100];
    const [px, pz] = xz(a);
    // Arrived by the red base's ledge (16, 13), and walked on a little.
    expect(Math.hypot(px - 16, pz - 13)).toBeLessThan(3);
    const [bx, bz] = xz(b);
    expect(Math.hypot(bx + 16, bz + 13)).toBeLessThan(3);
    g.destroy();
  }, 120_000);
});

describe.skipIf(!existsSync(ENGINE))("Beaver Creek online", () => {
  it("runs a Free for All in step: the guest plays the host's map, and both count the same kills", async () => {
    const probe = `;(function()
local _rk = register_kill
function register_kill(k, v, h) KILLS = (KILLS or 0) + 1; return _rk(k, v, h) end
local _T = TIC
function TIC() _T(); pmem(117, (KILLS or 0) | ((phase == "play" and 1 or 0) << 16) | (MAP_INDEX << 17)) end
end)()`;
    const { host, guest, both } = await lockoutRoom(probe, { code: arenaMapCode("beaver") });
    for (let f = 0; f < 1800; f += 1) both(0, f % 240 < 150 ? 0x01 : 0x08);
    const [h] = host.probe();
    const [g] = guest.probe();
    expect((g >> 16) & 1).toBe(1);
    expect(g >>> 17).toBe(2);
    expect(g & 0xffff).toBe(h & 0xffff);
  }, 300_000);
});

void NET_WORDS;
