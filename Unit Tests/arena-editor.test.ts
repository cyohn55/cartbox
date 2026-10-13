/**
 * The level editor (EDITOR_PRO_ROADMAP.md P7): arena maps stored as JSON on
 * a scene — Lockout and Beaver Creek round-trip exactly, and their sidecars
 * carry their markup — read defensively; the Arena panel's edits; kill
 * volumes in the validator and in the cart (on the real engine); colliders
 * fitted to scene objects and ground from a terrain; and a saved arena made
 * playable in the arena cart.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARENA_LIMITS,
  BEAVER_MAP,
  LOCKOUT_MAP,
  addMarkup,
  arenaGround,
  arenaLua,
  emptyArenaMap,
  groundFromTerrain,
  groundHeight,
  lockoutCartridge,
  lockoutCode,
  lockoutMeshSidecar,
  markupOverlays,
  newTerrain,
  placeMarkup,
  readArenaMap,
  removeMarkup,
  resizeMarkup,

  serializeTerrain,
  setPower,
  terrainHeight,
  validateArenaMap,
  writeArenaMap,
  type ArenaMap,
  type MeshAsset,
} from "@cartbox/editor";
import { NET_WORDS, injectSdk, parseMeshScene, readSidecarUi, uiSdkLua } from "@cartbox/player";
import { prependLuaCode } from "../packages/player/src/cartseed";

import { arenaIssues, collidersFromObjects, groundFromSidecarTerrain, setSidecarArena, sidecarArena } from "../apps/web/src/lib/arenaEdit";
import { addMesh, decodeMeshSidecar, emptyMeshSidecar, encodeMeshSidecar, setMeshTransform } from "../apps/web/src/lib/meshSidecar";
import { playableArena } from "../apps/web/src/lib/savedArena";

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");

/** A flat field: two spawns, a pad, a hill, a destination. */
const FIELD: ArenaMap = {
  ...emptyArenaMap("field", "Field"),
  ground: arenaGround(-20, -20, 2, 21, () => 0),
  spawns: [{ at: [-10, 0, 0], team: "blue" }, { at: [10, 0, 0], team: "red" }],
  markers: [{ box: [0, 0.3, 5, 0.6, 0.3, 0.6], weapon: "rocket", rotation: ["rocket", "sniper"] }],
  hills: [[0, 0, -5]],
  destinations: [[5, 0, 5]],
  power: [0],
  ball: [0, 0, 0],
  deathY: -10,
};

/** A unit cube, one primitive. */
function cube(): MeshAsset {
  const p = [-0.5, 0.5];
  const positions: number[] = [];
  for (const x of p) for (const y of p) for (const z of p) positions.push(x, y, z);
  const indices = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return {
    name: "cube",
    primitives: [{ positions: Float32Array.from(positions), normals: null, uvs: null, indices: Uint32Array.from(indices), material: { name: "m", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 1 } }],
  };
}

describe("arena maps as JSON", () => {
  it("round-trips Lockout and Beaver Creek exactly, and plays them the same", () => {
    for (const map of [LOCKOUT_MAP, BEAVER_MAP]) {
      const back = readArenaMap(JSON.parse(JSON.stringify(writeArenaMap(map))))!;
      // The same map (JSON's view: a -0 reads back as 0, and a hole stays a hole).
      expect(JSON.stringify(writeArenaMap(back))).toBe(JSON.stringify(writeArenaMap(map)));
      expect(back.ground?.heights.filter(Number.isNaN).length ?? 0).toBe(map.ground?.heights.filter(Number.isNaN).length ?? 0);
      expect(arenaLua(back)).toBe(arenaLua(map));
    }
  });

  it("goes into the shipped maps' sidecars, so the editor opens them as arena maps", () => {
    const json = JSON.parse(lockoutMeshSidecar()) as { arena?: unknown };
    expect(readArenaMap(json.arena)).toEqual(LOCKOUT_MAP);
    // And through the editor's sidecar, unchanged.
    const sidecar = decodeMeshSidecar(lockoutMeshSidecar());
    expect(sidecarArena(sidecar)).toEqual(LOCKOUT_MAP);
  });

  it("reads defensively: junk dropped, values clamped, power positions kept valid", () => {
    expect(readArenaMap(null)).toBeNull();
    expect(readArenaMap({ id: "x" })).toBeNull(); // no ball or death height
    const read = readArenaMap({
      id: "x",
      name: 7,
      deathY: -5,
      ball: [0, 1, 0],
      solids: [[0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1], "box", [0, 0, 0, -1, 1, 1]],
      spawns: [{ at: [1, 2, 3], team: "green" }, { at: [1, 2] }],
      markers: [{ box: [0, 0, 0, 1, 1, 1], weapon: "railgun" }, { box: [0, 0, 0, 1, 1, 1], weapon: "br", rotation: ["br", "nope", "sniper"] }],
      destinations: [[0, 0, 0], [1, 1, 1]],
      power: [1, 1, 5, -1, 0.5],
      flights: [{ axis: "y" }],
      ground: { x0: 0, z0: 0, step: 1, n: 2, heights: [0, null, 1] },
      kills: [[0, 0, 0, 2, 2, 2]],
    })!;
    expect(read.name).toBe("Arena");
    expect(read.solids).toEqual([[0, 0, 0, 1, 1, 1], [0, 0, 0, 0.01, 1, 1]]);
    expect(read.spawns).toEqual([{ at: [1, 2, 3] }]);
    expect(read.markers).toEqual([{ box: [0, 0, 0, 1, 1, 1], weapon: "br", rotation: ["br", "sniper"] }]);
    expect(read.power).toEqual([1]);
    expect(read.flights).toEqual([]);
    expect(read.ground).toBeUndefined(); // 3 heights for a 2 × 2 grid
    expect(read.kills).toHaveLength(1);
    const many = readArenaMap({ ...writeArenaMap(FIELD), spawns: Array.from({ length: 500 }, () => ({ at: [0, 0, 0] })) })!;
    expect(many.spawns).toHaveLength(ARENA_LIMITS.spawns);
  });
});

describe("the Arena panel's edits", () => {
  it("adds markup where it's placed, a box standing on the point", () => {
    let map = emptyArenaMap("a", "A");
    for (const kind of ["spawn", "pad", "hill", "destination", "teleporter", "kill", "collider"] as const) map = addMarkup(map, kind, [1, 2, 3]).map;
    expect(map.spawns[0]!.at).toEqual([1, 2, 3]);
    expect(map.markers[0]!.box[1] - map.markers[0]!.box[4]).toBeCloseTo(2, 9);
    expect(map.solids[0]![1] - map.solids[0]![4]).toBeCloseTo(2, 9);
    expect(map.kills![0]![1] - map.kills![0]![4]).toBeCloseTo(2, 9);
    expect(map.teleporters![0]).toEqual({ from: [1, 2, 3], to: [1, 2, 7], yaw: 0 });
    expect(addMarkup(map, "ball", [4, 5, 6]).map.ball).toEqual([4, 5, 6]);
    // Every piece is drawn (colliders when asked).
    expect(markupOverlays(map).length).toBe(1 + 1 + 1 + 1 + 1 + 2 + 1);
    expect(markupOverlays(map, true).length).toBe(markupOverlays(map).length + 1);
  });

  it("moves, resizes and removes markup; power positions follow their destinations", () => {
    let map = FIELD;
    map = placeMarkup(map, { kind: "pad", index: 0 }, [3, 1, 3]);
    expect(map.markers[0]!.box).toEqual([3, 1.3, 3, 0.6, 0.3, 0.6]);
    map = resizeMarkup(map, { kind: "pad", index: 0 }, [1, 0.5, 1]);
    expect(map.markers[0]!.box).toEqual([3, 1.5, 3, 1, 0.5, 1]); // its bottom stays at 1
    map = placeMarkup(addMarkup(map, "teleporter", [0, 0, 0]).map, { kind: "exit", index: 0 }, [9, 0, 9]);
    expect(map.teleporters![0]!.to).toEqual([9, 0, 9]);
    // Two destinations, power on the second; removing the first keeps the second as power.
    map = setPower(addMarkup(map, "destination", [7, 0, 7]).map, 1, true);
    expect(map.power).toEqual([0, 1]);
    map = removeMarkup(map, { kind: "destination", index: 0 });
    expect(map.destinations).toEqual([[7, 0, 7]]);
    expect(map.power).toEqual([0]);
    expect(removeMarkup(map, { kind: "ball", index: 0 })).toBe(map);
  });
});

describe("checking a map as it's edited", () => {
  it("passes a good map with or without its routes checked", () => {
    expect(arenaIssues(FIELD)).toEqual([]);
    expect(arenaIssues(FIELD, true)).toEqual([]);
  });

  it("flags no spawns, and play inside a kill volume", () => {
    expect(validateArenaMap(emptyArenaMap("e", "E"), {}).map((i) => i.kind)).toContain("no-spawns");
    const killing = { ...FIELD, kills: [[0, 0.5, -5, 2, 1, 2]] as ArenaMap["solids"] };
    expect(arenaIssues(killing).map((i) => i.message)).toEqual(["hill 1 at (0.00, 0.00, -5.00) is inside kill volume 1"]);
  });

  it("writes kill volumes into the cart as min/max corners", () => {
    expect(arenaLua({ ...FIELD, kills: [[0, 1, 2, 1, 1, 1]] })).toContain("KILL = {-1.00,0.00,1.00,1.00,2.00,3.00}");
    expect(arenaLua(FIELD)).toContain("KILL = {}");
  });
});

describe("collision from the scene", () => {
  it("fits a collider round an object where it stands", () => {
    const added = addMesh(emptyMeshSidecar(), cube(), "block");
    const sidecar = setMeshTransform(added.sidecar, added.id, { position: [4, 1, 0], rotation: [0, 0, 0], scale: [2, 2, 2] });
    const [box] = collidersFromObjects(sidecar, [added.id]);
    expect(box![0]).toBeCloseTo(4, 5);
    expect(box![1]).toBeCloseTo(1, 5);
    expect(box![3]).toBeCloseTo(1, 5);
    expect(box![4]).toBeCloseTo(1, 5);
  });

  it("takes walkable ground from a terrain, the same heights", () => {
    const t = newTerrain("t", { name: "hills", size: 16, samples: 17 });
    const hilly = { ...t, heights: t.heights.map((_, k) => Math.sin(k * 0.37) * 2) };
    const g = groundFromTerrain(hilly, 1);
    expect(g.n).toBe(17);
    for (const [x, z] of [[-3, 2], [0.5, -4.5], [6, 6]] as const) expect(groundHeight(g, x, z)!).toBeCloseTo(terrainHeight(hilly, x, z)!, 4);
    const sidecar = { ...emptyMeshSidecar(), terrains: [serializeTerrain(hilly)] };
    expect(groundFromSidecarTerrain(sidecar, "t", 1)?.n).toBe(17);
  });
});

describe("a saved arena, played", () => {
  /** A scene with a floor, marked up as the field. */
  function savedField(map: ArenaMap = FIELD): string {
    const added = addMesh(emptyMeshSidecar(), cube(), "floor");
    const floor = setMeshTransform(added.sidecar, added.id, { position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [40, 1, 40] });
    return encodeMeshSidecar(setSidecarArena(floor, map))!;
  }

  it("stores the markup through the editor's sidecar", () => {
    expect(sidecarArena(decodeMeshSidecar(savedField()))).toEqual(FIELD);
    expect(sidecarArena(setSidecarArena(decodeMeshSidecar(savedField()), null))).toBeNull();
  });

  it("lays the arena's Spartans, weapons and the map's pickups out as the cart expects, then the scene's own objects", () => {
    const saved = savedField();
    const made = playableArena(saved);
    if ("problem" in made) throw new Error(made.problem);
    const scene = parseMeshScene(made.json)!;
    const ids = scene.instances.map((i) => i.id);
    expect(ids[0]).toBe("saved-map");
    expect(ids.slice(1, 8)).toEqual(["bot-1", "bot-2", "bot-3", "bot-4", "bot-5", "bot-6", "bot-7"]);
    // A pickup for each weapon the pad turns through.
    expect(ids.filter((id) => id.startsWith("pickup-"))).toEqual(["pickup-1", "pickup-2"]);
    // The scene's own floor, after the arena's instances (the left hands' guns are its last).
    const floor = ids.indexOf(decodeMeshSidecar(saved).meshes[0]!.id);
    expect(floor).toBeGreaterThan(ids.findLastIndex((id) => id.endsWith("-left")));
    // The code plays the map, the camera about the scene.
    const code = made.code(scene.bounds.center);
    expect(code).toContain(arenaLua(FIELD));
    expect(code).toContain('MAPS = { "Field" }');
  });

  it("says why it can't play a scene that isn't an arena", () => {
    expect(playableArena(null)).toEqual({ problem: expect.stringContaining("isn't saved") });
    expect(playableArena(encodeMeshSidecar(addMesh(emptyMeshSidecar(), cube(), "x").sidecar))).toEqual({ problem: expect.stringContaining("isn't an arena") });
    expect(playableArena(savedField({ ...FIELD, spawns: [] }))).toEqual({ problem: "That arena has no spawns." });
  });
});

describe.skipIf(!existsSync(ENGINE))("kill volumes in the cart, on the real engine", () => {
  /** The field's cart with `kills`, the player put at (x, 0, z): whether they died. */
  async function diesAt(kills: ArenaMap["solids"], x: number, z: number): Promise<number> {
    const probe = `;(function()
local _T, k = TIC, 0
function TIC()
  _T()
  if phase == "play" and p then
    k = k + 1
    for _,o in ipairs(bots) do o.dead, o.respawn, o.x, o.y, o.z = true, 1e9, 0, -60, 0 end
    if k == 2 then p.x, p.y, p.z, p.vy, p.dead, p.deaths = ${x}, 0, ${z}, 0, false, 0 end
    pmem(117, p.deaths or 0)
  end
end
end)()`;
    const code = `${lockoutCode({ ...FIELD, kills }, [0, 0, 0])}\n${probe}`;
    const tic = injectSdk(prependLuaCode(lockoutCartridge(code), uiSdkLua(readSidecarUi(lockoutMeshSidecar()), 1280, 720)));
    const mod = await (await import(pathToFileURL(ENGINE).href)).default();
    const h = mod._cbx_create(44100);
    const ptr = mod._malloc(tic.length);
    mod.HEAPU8.set(tic, ptr);
    expect(mod._cbx_load(h, ptr, tic.length)).toBe(1);
    mod._free(ptr);
    for (let i = 0; i < 3; i += 1) mod._cbx_tick(h, 0);
    mod._cbx_tick(h, 1 << 4); // Free for All
    for (let i = 0; i < 40; i += 1) mod._cbx_tick(h, i % 2 ? 1 << 4 : 0); // past the intro
    for (let i = 0; i < 20; i += 1) mod._cbx_tick(h, 0);
    return new Uint32Array(mod.HEAPU8.buffer, mod._cbx_mailbox_ptr(h) - NET_WORDS * 4, NET_WORDS)[117]!;
  }

  it("kills a soldier who steps into one, and not one beside it", async () => {
    const pit: ArenaMap["solids"] = [[-14, 0.5, 8, 2, 1, 2]];
    expect(await diesAt(pit, -14, 8)).toBeGreaterThan(0);
    expect(await diesAt(pit, -8, 8)).toBe(0);
  }, 60_000);
});


