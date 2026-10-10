/**
 * Arena maps as data (LOCKOUT_MULTIPLAYER_ROADMAP.md L1): Lockout is an
 * ArenaMap whose Lua tables are exactly the literals the cart carried before;
 * the cart's code reads its map instead of carrying it, so a second, tiny map
 * plays on the same code — Spartans spawning on it, on their own team's spawns
 * in a team game.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  LOCKOUT_CODE,
  LOCKOUT_MAP,
  LOCKOUT_RAGDOLL_COLLIDERS,
  arenaCenter,
  arenaColliders,
  arenaFlight,
  arenaLua,
  flightSteps,
  lockoutCartridge,
  lockoutCode,
  lockoutMeshSidecar,
  type ArenaMap,
} from "@cartbox/editor";
import { decodeMeshPoses, injectSdk, readSidecarUi, uiSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A table's line in a cart's code. */
const table = (code: string, name: string) => code.split("\n").find((l) => new RegExp(`^local ${name} +=`).test(l))!;
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

describe("Lockout as an arena map", () => {
  it("writes the same colliders, spawns, markers and bot destinations the cart carried before", () => {
    // Hashes of the lines as they stood before the map became data.
    expect(sha(table(LOCKOUT_CODE, "COL"))).toBe("fcbe139eea0492de");
    expect(sha(table(LOCKOUT_CODE, "SPN"))).toBe("2e91c25189221891");
    expect(sha(table(LOCKOUT_CODE, "MRK"))).toBe("1e7416c2bdad3d87");
    expect(sha(table(LOCKOUT_CODE, "MW"))).toBe("7f4e5eec43323bf0");
    expect(sha(table(LOCKOUT_CODE, "ROAM"))).toBe("94d67f7f20b2c6a4");
    expect(sha(table(LOCKOUT_CODE, "POWER"))).toBe("c7636255f34a2258");
    // And the hills, ball and death plane it had written into its code.
    expect(table(LOCKOUT_CODE, "HILLS")).toBe("local HILLS = {{0.00,3.65,0.00},{-6.70,7.00,-8.60},{9.60,4.00,7.20},{0.00,0.70,0.00},{-9.00,2.20,6.00}}");
    expect(table(LOCKOUT_CODE, "BALL")).toBe("local BALL = {0.00,1.10,0.00}");
    expect(table(LOCKOUT_CODE, "DEATH_Y")).toBe("local DEATH_Y = -6.00");
    // Its spawns serve either team; its ragdolls land on the same colliders.
    expect(table(LOCKOUT_CODE, "SPT")).toBe("local SPT = {0,0,0,0,0,0,0,0}");
    expect(LOCKOUT_RAGDOLL_COLLIDERS).toHaveLength(arenaColliders(LOCKOUT_MAP).length);
  });

  it("carries no map of its own in the code beyond its tables", () => {
    // The literals the cart used to carry inline are gone.
    expect(LOCKOUT_CODE).not.toContain("{0,3.65,0}");
    expect(LOCKOUT_CODE).not.toContain("p.y < -6");
    expect(LOCKOUT_CODE).not.toContain("x=0,y=1.1,z=0");
    expect(LOCKOUT_CODE).toContain("e.y < DEATH_Y"); // any soldier falling off (L7: the host moves them all)
  });
});

describe("arena maps", () => {
  it("climb a flight in 0.5 m steps along its axis, and centre on their colliders", () => {
    const steps = flightSteps(arenaFlight("x", 2, 1, 0, 1, 2, 0));
    expect(steps).toHaveLength(4);
    // Descending eastward from a top of 2: the first step is the tallest.
    expect(steps[0]![1] * 2).toBeCloseTo(1.5, 9);
    expect(steps[0]![0]).toBeCloseTo(0.425, 9);
    expect(steps.every((b) => b[2] === 2 && b[5] === 1)).toBe(true);
    const map = { ...TINY, solids: [[0, -0.5, 0, 10, 0.5, 4] as const] };
    expect(arenaCenter({ ...map, flights: [] })).toEqual([0, -0.5, 0]);
  });

  it("refuse a power position that isn't a destination", () => {
    expect(() => arenaLua({ ...TINY, power: [99] })).toThrow(/power position 99/);
  });
});

/** A tiny two-team map: a floor, a raised block with steps, blue spawns west and red east. */
const TINY: ArenaMap = {
  id: "tiny",
  name: "Tiny",
  solids: [
    [0, -0.5, 0, 12, 0.5, 6],
    [0, 1, -4, 2, 1, 1],
  ],
  flights: [arenaFlight("z", 0, 1, -2.2, 1, 2, 0)],
  spawns: [
    { at: [-9, 0, -3], team: "blue" },
    { at: [-9, 0, 0], team: "blue" },
    { at: [-9, 0, 3], team: "blue" },
    { at: [-10, 0, 1.5], team: "blue" },
    { at: [9, 0, -3], team: "red" },
    { at: [9, 0, 0], team: "red" },
    { at: [9, 0, 3], team: "red" },
    { at: [10, 0, 1.5], team: "red" },
  ],
  destinations: [[-6, 0, 0], [6, 0, 0], [0, 0, 3], [0, 2, -4]],
  power: [3],
  hills: [[0, 2, -4], [0, 0, 3]],
  ball: [0, 0.4, 3],
  deathY: -4,
  markers: [{ box: [0, 2.4, -4, 0.28, 0.4, 0.28], weapon: "sniper" }],
};

describe.skipIf(!existsSync(ENGINE))("a second map on the same code, through the real engine", () => {
  async function play(modeDowns: number) {
    const code = lockoutCode(TINY, arenaCenter(TINY));
    const tic = injectSdk(prependLuaCode(lockoutCartridge(code), uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    const DOWN = 1 << 1, A = 1 << 4;
    const tick = (b = 0) => mod._cbx_tick(h, b);
    for (let i = 0; i < 3; i += 1) tick();
    for (let i = 0; i < modeDowns; i += 1) {
      tick(DOWN);
      tick();
    }
    tick(A);
    tick();
    tick();
    const poses = decodeMeshPoses(new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h), mod._cbx_mailbox_words(h)).slice()).filter((p) => p.index >= 1 && p.index <= 7);
    mod._cbx_delete(h);
    return poses;
  }

  const spawnNear = (x: number, z: number) => TINY.spawns.find((s) => Math.hypot(s.at[0] - x, s.at[2] - z) < 1.2);

  it("spawns every bot on the map's spawns in Free for All", async () => {
    const bots = await play(0);
    expect(bots).toHaveLength(7);
    for (const b of bots) {
      expect(spawnNear(b.position[0], b.position[2])).toBeDefined();
      expect(b.position[1]).toBeCloseTo(0, 1);
    }
  });

  it("spawns each team on its own spawns in Team Slayer", async () => {
    const bots = await play(1);
    expect(bots).toHaveLength(7);
    // Bots of one team wear one tint; every bot of a tint stands on that team's side.
    const sides = new Map<number, Set<string>>();
    for (const b of bots) {
      const spawn = spawnNear(b.position[0], b.position[2]);
      expect(spawn?.team).toBeDefined();
      const tint = b.tint ?? 0;
      if (!sides.has(tint)) sides.set(tint, new Set());
      sides.get(tint)!.add(spawn!.team!);
    }
    expect(sides.size).toBe(2);
    for (const teams of sides.values()) expect(teams.size).toBe(1);
  });
});
