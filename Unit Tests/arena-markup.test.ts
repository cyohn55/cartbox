/**
 * A map's markup as actors, and built into the game (ENGINE_PARITY_ROADMAP.md
 * EP21–EP26, BEAVER_CREEK_ROADMAP.md B4): Lockout's and Beaver Creek's
 * spawns, pads, hills, destinations, teleporters, colliders and death plane
 * open in the editor as actors; moving, adding and removing them edits the
 * map; the map round-trips through a sidecar; Build rewrites only the cart's
 * map lines and lays the Pickups out again; and an edited Beaver Creek plays
 * on the real engine, a teleporter added in the editor carrying a soldier.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARENA_CODE_KEYS,
  ARENA_MAPS,
  BEAVER_MAP,
  DEFAULT_ACCESSIBILITY,
  LOCKOUT_CENTER_X,
  LOCKOUT_CENTER_Y,
  LOCKOUT_CENTER_Z,
  LOCKOUT_CODE,
  LOCKOUT_MAP,
  LOCKOUT_STRINGS,
  addArenaActor,
  arenaActor,
  arenaActors,
  arenaMap,
  arenaMapCode,
  arenaPads,
  duplicateArenaActors,
  groundHeight,
  isArenaCode,
  lockoutCartridge,
  lockoutCode,
  moveArenaActor,
  parseArenaActorId,
  patchArenaCode,
  readArenaMap,
  readNavMesh,
  removeArenaActors,
  resizeArenaActor,
  sameArenaCollision,
  sameArenaMap,
  setDestinationPower,
  setPadWeapons,
  setSpawnTeam,
  setTeleporterYaw,
  storeArenaMap,
  type ArenaMap,
  type NavMesh,
} from "@cartbox/editor";
import {
  INPUT_BLOCK_BYTES,
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

import { arenaActorsInRect, arenaFloorBelow, groundLines, iconPoint, navmeshPoints, pickArenaActor, pivotOnFloor, rayBox, visibleArenaActors } from "@/lib/arenaOverlay";
import { arenaSceneCentre, buildArenaToGame, checkArenaMap, rebuildArenaNavigation, relayArenaPickups } from "@/lib/arenaBuild";
import { bookmarkIn, bookmarkSlot, readBookmarks, setBookmark } from "@/lib/cameraBookmarks";
import { lockoutMarkup } from "@/lib/lockoutAssets";
import { decodeMeshSidecar, encodeMeshSidecar, setMeshArena, setMeshBookmarks } from "@/lib/meshSidecar";
import { cameraLookingAt } from "@/lib/viewportCamera";

/** The walkable floors' heights in the navmesh column over (x, z). */
function floorsAt(nav: NavMesh, x: number, z: number): number[] {
  const col = Math.floor((x - nav.originX) / nav.cell);
  const row = Math.floor((z - nav.originZ) / nav.cell);
  let at = 0;
  for (let i = 0; i < row * nav.cols + col; i += 1) at += nav.counts[i]!;
  return [...nav.heights.subarray(at, at + nav.counts[row * nav.cols + col]!)];
}

const ENGINE = path.resolve(__dirname, "../packages/engine/dist/xbox360/engine.js");
const LAYOUT = RAM_LAYOUTS.xbox360;

describe("markup as actors", () => {
  it("lists every spawn, pad, hill, destination, teleporter end, collider and flight, plus the ball and the death plane", () => {
    for (const map of [LOCKOUT_MAP, BEAVER_MAP]) {
      const actors = arenaActors(map);
      const count = (kind: string) => actors.filter((a) => a.kind === kind).length;
      expect(count("spawn")).toBe(map.spawns.length);
      expect(count("pad")).toBe(map.markers.length);
      expect(count("hill")).toBe(map.hills.length);
      expect(count("dest")).toBe(map.destinations.length);
      expect(count("tpfrom")).toBe(map.teleporters?.length ?? 0);
      expect(count("tpto")).toBe(map.teleporters?.length ?? 0);
      expect(count("solid")).toBe(map.solids.length);
      expect(count("flight")).toBe(map.flights.length);
      expect(count("ball") + count("death")).toBe(2);
      // Ids are unique and read back to their kind and index.
      expect(new Set(actors.map((a) => a.id)).size).toBe(actors.length);
      for (const a of actors) expect(parseArenaActorId(a.id)).toEqual({ kind: a.kind, index: a.index });
    }
    expect(parseArenaActorId("mesh-1")).toBeNull();
    expect(parseArenaActorId("arena:nope:1")).toBeNull();
    // Power positions are starred; the death plane sits at the death height.
    expect(arenaActor(LOCKOUT_MAP, `arena:dest:${LOCKOUT_MAP.power[0]}`)!.name).toContain("★");
    expect(arenaActor(LOCKOUT_MAP, "arena:death:0")!.at[1]).toBe(LOCKOUT_MAP.deathY);
  });

  it("moves each kind by its pivot, and resizes boxes", () => {
    const m = BEAVER_MAP;
    expect(moveArenaActor(m, "arena:spawn:0", [1, 2, 3]).spawns[0]).toEqual({ ...m.spawns[0], at: [1, 2, 3] });
    const pad = moveArenaActor(m, "arena:pad:1", [4, 5, 6]).markers[1]!;
    expect(pad.box).toEqual([4, 5, 6, ...m.markers[1]!.box.slice(3)]);
    expect(pad.rotation).toEqual(m.markers[1]!.rotation);
    expect(moveArenaActor(m, "arena:ball:0", [0, 9, 0]).ball).toEqual([0, 9, 0]);
    expect(moveArenaActor(m, "arena:tpto:0", [7, 1, 7]).teleporters![0]!.to).toEqual([7, 1, 7]);
    expect(moveArenaActor(m, "arena:tpto:0", [7, 1, 7]).teleporters![0]!.from).toEqual(m.teleporters![0]!.from);
    // The death plane only moves up and down.
    expect(moveArenaActor(m, "arena:death:0", [99, -20, 99]).deathY).toBe(-20);
    // A flight moves along and across its run, its tops with it.
    const f = LOCKOUT_MAP.flights[0]!;
    const moved = moveArenaActor(LOCKOUT_MAP, "arena:flight:0", f.axis === "z" ? [f.fixed + 1, f.topFrom + 0.5, f.start + 2] : [f.start + 2, f.topFrom + 0.5, f.fixed + 1]).flights[0]!;
    expect([moved.start, moved.fixed, moved.topFrom, moved.topTo]).toEqual([f.start + 2, f.fixed + 1, f.topFrom + 0.5, f.topTo + 0.5]);
    // Boxes resize (never to nothing); points don't.
    expect(resizeArenaActor(m, "arena:solid:0", [2, 0, -3]).solids[0]!.slice(3)).toEqual([2, 0.05, 3]);
    expect(resizeArenaActor(m, "arena:spawn:0", [2, 2, 2])).toBe(m);
    // Unknown ids change nothing.
    expect(moveArenaActor(m, "arena:spawn:999", [0, 0, 0])).toBe(m);
  });

  it("adds, duplicates and removes actors, keeping power positions on their destinations", () => {
    const added = addArenaActor(LOCKOUT_MAP, "spawn", [1, 0, 1], { team: "red" });
    expect(added.id).toBe(`arena:spawn:${LOCKOUT_MAP.spawns.length}`);
    expect(added.map.spawns.at(-1)).toEqual({ at: [1, 0, 1], team: "red" });
    const pad = addArenaActor(LOCKOUT_MAP, "pad", [2, 1, 2], { weapon: "rocket" });
    expect(pad.map.markers.at(-1)).toEqual({ box: [2, 1.4, 2, 0.28, 0.4, 0.28], weapon: "rocket", rotation: ["rocket"] });
    const tp = addArenaActor(LOCKOUT_MAP, "tpfrom", [0, 0, 0]);
    expect(tp.map.teleporters).toHaveLength(1);

    // Removing a destination before a power position renumbers it; removing a power position drops it.
    const firstPower = LOCKOUT_MAP.power[0]!;
    const before = removeArenaActors(LOCKOUT_MAP, ["arena:dest:0"]);
    expect(before.destinations).toHaveLength(LOCKOUT_MAP.destinations.length - 1);
    expect(before.power).toEqual(LOCKOUT_MAP.power.map((i) => i - 1));
    expect(before.power.map((i) => before.destinations[i])).toEqual(LOCKOUT_MAP.power.map((i) => LOCKOUT_MAP.destinations[i]));
    expect(removeArenaActors(LOCKOUT_MAP, [`arena:dest:${firstPower}`]).power).not.toContain(firstPower);
    // Either end removes its teleporter; the ball and the death plane stay.
    expect(removeArenaActors(BEAVER_MAP, ["arena:tpto:1"]).teleporters).toEqual([BEAVER_MAP.teleporters![0]]);
    expect(removeArenaActors(BEAVER_MAP, ["arena:ball:0", "arena:death:0"])).toBe(BEAVER_MAP);

    const copy = duplicateArenaActors(BEAVER_MAP, ["arena:pad:0", "arena:tpfrom:0", "arena:tpto:0", "arena:ball:0"]);
    expect(copy.ids).toEqual([`arena:pad:${BEAVER_MAP.markers.length}`, "arena:tpfrom:2"]);
    expect(copy.map.markers.at(-1)!.box.slice(0, 3)).toEqual([BEAVER_MAP.markers[0]!.box[0] + 1, BEAVER_MAP.markers[0]!.box[1], BEAVER_MAP.markers[0]!.box[2] + 1]);
    expect(copy.map.teleporters).toHaveLength(3);
  });

  it("edits a spawn's team, a pad's weapons, a power position and a teleporter's facing", () => {
    expect(setSpawnTeam(BEAVER_MAP, 0, null).spawns[0]).toEqual({ at: BEAVER_MAP.spawns[0]!.at });
    expect(setSpawnTeam(LOCKOUT_MAP, 0, "blue").spawns[0]!.team).toBe("blue");
    const pads = setPadWeapons(LOCKOUT_MAP, 0, ["hammer", "sword"]);
    expect(pads.markers[0]).toEqual({ box: LOCKOUT_MAP.markers[0]!.box, weapon: "hammer", rotation: ["hammer", "sword"] });
    expect(arenaPads(pads)[0]).toEqual(["hammer", "sword"]);
    expect(setPadWeapons(LOCKOUT_MAP, 0, [])).toBe(LOCKOUT_MAP);
    expect(setDestinationPower(LOCKOUT_MAP, 0, true).power).toContain(0);
    expect(setDestinationPower(LOCKOUT_MAP, LOCKOUT_MAP.power[0]!, false).power).not.toContain(LOCKOUT_MAP.power[0]);
    expect(setTeleporterYaw(BEAVER_MAP, 1, 1.5).teleporters![1]!.yaw).toBe(1.5);
  });
});

describe("actors in the scene view", () => {
  /** A top-down projection: a metre is ten pixels, x to the right and z down, centred on (500, 500). */
  const topDown = (p: readonly [number, number, number]) => [500 + p[0] * 10, 500 + p[2] * 10] as const;

  it("shows markup with Gameplay and colliders and steps with Collision", () => {
    const gameplay = visibleArenaActors(LOCKOUT_MAP, { gameplay: true, collision: false, navigation: false });
    expect(gameplay.some((a) => a.kind === "solid" || a.kind === "flight")).toBe(false);
    expect(gameplay.filter((a) => a.kind === "spawn")).toHaveLength(LOCKOUT_MAP.spawns.length);
    const collision = visibleArenaActors(LOCKOUT_MAP, { gameplay: false, collision: true, navigation: false });
    expect(collision.every((a) => a.kind === "solid" || a.kind === "flight")).toBe(true);
    expect(collision).toHaveLength(LOCKOUT_MAP.solids.length + LOCKOUT_MAP.flights.length);
  });

  it("picks the nearest icon under the cursor, else the collider the ray enters first", () => {
    const actors = visibleArenaActors(BEAVER_MAP, { gameplay: true, collision: true, navigation: false });
    // An actor with nothing else within a metre of it, seen from above.
    const lone = actors.find((a) => a.kind !== "solid" && a.kind !== "flight" && actors.every((b) => b === a || Math.hypot(b.at[0] - a.at[0], b.at[2] - a.at[2]) > 1))!;
    expect(pickArenaActor(actors, topDown, [topDown(lone.at)[0] + 2, topDown(lone.at)[1]], 6)).toBe(lone.id);
    // The ball floats on the arch right over the rocket pad: seen from the side, it is the one under the cursor.
    const ball = actors.find((a) => a.kind === "ball")!;
    const front = (p: readonly [number, number, number]) => [500 + p[0] * 10, 500 - p[1] * 10] as const;
    expect(pickArenaActor(actors.filter((a) => a.kind === "ball" || a.kind === "pad"), front, front(ball.at), 6)).toBe(ball.id);
    // A spawn is picked by its icon at its chest, not its feet.
    const spawn = actors.find((a) => a.kind === "spawn")!;
    const side = (p: readonly [number, number, number]) => [500 + p[0] * 10, 500 - p[1] * 10] as const;
    expect(pickArenaActor([spawn], side, side(iconPoint(spawn)), 4)).toBe(spawn.id);
    // Nothing within reach and no ray: nothing.
    expect(pickArenaActor(actors, topDown, [-999, -999], 6)).toBeNull();
    // A ray straight down onto a collider's middle finds it.
    const solid = actors.find((a) => a.kind === "solid")!;
    const ray = { origin: [solid.at[0], 100, solid.at[2]] as const, dir: [0, -1, 0] as const };
    const onlySolids = actors.filter((a) => a.kind === "solid");
    expect(pickArenaActor(onlySolids, topDown, [-999, -999], 6, ray)).not.toBeNull();
    expect(rayBox(ray, [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(rayBox({ origin: [0.5, 5, 0.5], dir: [0, -1, 0] }, [0, 0, 0], [1, 1, 1])).toBeCloseTo(4);
  });

  it("box-selects the actors whose icons fall inside", () => {
    const actors = visibleArenaActors(BEAVER_MAP, DEFAULTS);
    const inside = arenaActorsInRect(actors, topDown, { x0: 500, y0: 0, x1: 2000, y1: 2000 });
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every((id) => arenaActor(BEAVER_MAP, id)!.at[0] >= 0)).toBe(true);
  });

  it("finds the floor under a point, and stands a box on it", () => {
    // Blue's first spawn stands on its base's ground floor, under the roof (3.4 m).
    const [x, y, z] = BEAVER_MAP.spawns[0]!.at;
    expect(arenaFloorBelow(BEAVER_MAP, x, y, z, 0.05)).toBeCloseTo(y, 1);
    expect(arenaFloorBelow(BEAVER_MAP, x, y + 5, z, 0)).toBeCloseTo(3.4, 1);
    expect(arenaFloorBelow({ ...BEAVER_MAP, ground: undefined, solids: [] }, 999, 0, 999)).toBeNull();
    const pad = arenaActor(BEAVER_MAP, "arena:pad:0")!;
    expect(pivotOnFloor(pad, 2)).toEqual([pad.at[0], 2 + pad.half![1], pad.at[2]]);
  });

  it("draws the ground's grid and the navmesh's floors", () => {
    expect(groundLines(LOCKOUT_MAP, 2)).toEqual([]);
    const lines = groundLines(BEAVER_MAP, 4);
    expect(lines.length).toBeGreaterThan(100);
    const sidecar = decodeMeshSidecar(arenaMap("beaver").sidecar());
    const nav = readNavMesh(sidecar.navmesh)!;
    const all = navmeshPoints(nav, 1);
    expect(all).toHaveLength(nav.heights.length);
    expect(navmeshPoints(nav, 2).length).toBeLessThan(all.length / 2);
  });
});

const DEFAULTS = { gameplay: true, collision: false, navigation: false } as const;

describe("markup in a sidecar", () => {
  it("round-trips both maps, ground holes and all, to the centimetre", () => {
    for (const map of [LOCKOUT_MAP, BEAVER_MAP]) {
      const read = readArenaMap(JSON.parse(JSON.stringify(storeArenaMap(map))));
      expect(read).not.toBeNull();
      expect(sameArenaMap(read!, map)).toBe(true);
    }
    const holed: ArenaMap = { ...BEAVER_MAP, ground: { ...BEAVER_MAP.ground!, heights: BEAVER_MAP.ground!.heights.map((h, i) => (i === 5 ? NaN : h)) } };
    const back = readArenaMap(JSON.parse(JSON.stringify(storeArenaMap(holed))))!;
    expect(Number.isNaN(back.ground!.heights[5])).toBe(true);
  });

  it("refuses a malformed map whole", () => {
    const good = JSON.parse(JSON.stringify(storeArenaMap(BEAVER_MAP)));
    expect(readArenaMap(good)).not.toBeNull();
    const broken = (patch: Record<string, unknown>) => readArenaMap({ ...good, ...patch });
    expect(broken({ spawns: [{ at: [0, "x", 0] }] })).toBeNull();
    expect(broken({ spawns: [{ at: [0, 0, 0], team: "green" }] })).toBeNull();
    expect(broken({ markers: [{ box: [0, 0, 0, 1, 1, 1], weapon: "bfg" }] })).toBeNull();
    expect(broken({ power: [9999] })).toBeNull();
    expect(broken({ ground: { ...good.ground, heights: [1, 2, 3] } })).toBeNull();
    expect(broken({ deathY: Infinity })).toBeNull();
    expect(readArenaMap(null)).toBeNull();
  });

  it("is carried by both maps' sidecars, and kept by the editor's sidecar", () => {
    for (const entry of ARENA_MAPS) {
      const sidecar = decodeMeshSidecar(entry.sidecar());
      expect(sidecar.arena).toBeDefined();
      expect(sameArenaMap(sidecar.arena!, entry.scene.map)).toBe(true);
      // Re-encoded and read again: the same markup.
      expect(sameArenaMap(decodeMeshSidecar(encodeMeshSidecar(sidecar))!.arena!, entry.scene.map)).toBe(true);
    }
    // Removing it leaves a sidecar without it.
    expect(setMeshArena(decodeMeshSidecar(arenaMap("lockout").sidecar()), null).arena).toBeUndefined();
  });

  it("keeps camera bookmarks in slots 1 to 9", () => {
    const cam = cameraLookingAt([0, 0, 0], 0.5, 0.4, 10);
    let list = setBookmark([], 3, cam);
    list = setBookmark(list, 1, { ...cam, yaw: 1 });
    list = setBookmark(list, 3, { ...cam, yaw: 2 });
    expect(list.map((b) => b.slot)).toEqual([1, 3]);
    expect(bookmarkIn(list, 3)!.yaw).toBe(2);
    expect(setBookmark(list, 12, cam)).toEqual(list);
    const stored = decodeMeshSidecar(encodeMeshSidecar(setMeshBookmarks(decodeMeshSidecar(arenaMap("lockout").sidecar()), list)));
    expect(stored.bookmarks).toEqual(list);
    expect(readBookmarks([{ slot: 0, camera: cam }, { slot: 2, camera: { ...cam, distance: -1 } }, "x"])).toEqual([]);
    expect(bookmarkSlot({ key: "!", code: "Digit1" })).toBe(1);
    expect(bookmarkSlot({ key: "7" })).toBe(7);
    expect(bookmarkSlot({ key: "0", code: "Digit0" })).toBeNull();
  });
});

describe("markup into the game", () => {
  it("names each map line once in an arena cart's code", () => {
    for (const code of [LOCKOUT_CODE, arenaMapCode("beaver")]) {
      const lines = code.split("\n");
      for (const key of ARENA_CODE_KEYS) {
        const n = lines.filter((l) => l.startsWith(key)).length;
        expect(n, key).toBe(key === "HF_N," && code === LOCKOUT_CODE ? 0 : 1);
      }
      expect(isArenaCode(code)).toBe(true);
    }
    expect(isArenaCode("function TIC() end")).toBe(false);
  });

  it("rewrites only the map's lines: none for the map the code was written for, and the right ones for an edit", () => {
    const centre = [LOCKOUT_CENTER_X, LOCKOUT_CENTER_Y, LOCKOUT_CENTER_Z] as const;
    expect(patchArenaCode(LOCKOUT_CODE, LOCKOUT_MAP, centre)).toEqual({ code: LOCKOUT_CODE, missing: [], changed: 0 });
    // The author's own edits elsewhere survive.
    const authored = LOCKOUT_CODE.replace("local NBOT = 7", "local NBOT = 3 -- mine");
    const moved = moveArenaActor(LOCKOUT_MAP, "arena:spawn:0", [1, 2, 3]);
    const patched = patchArenaCode(authored, moved, centre);
    expect(patched.changed).toBe(1);
    expect(patched.code).toContain("local NBOT = 3 -- mine");
    expect(patched.code).toBe(authored.replace(/^local SPN = .*$/m, lockoutCode(moved, centre).match(/^local SPN = .*$/m)![0]));
    // Ground arriving writes its grid line after HF; ground leaving takes it away again.
    const grounded = { ...LOCKOUT_MAP, ground: BEAVER_MAP.ground };
    const withGround = patchArenaCode(LOCKOUT_CODE, grounded, centre);
    expect(withGround.code.split("\n").filter((l) => l.startsWith("HF_N,"))).toHaveLength(1);
    expect(patchArenaCode(withGround.code, LOCKOUT_MAP, centre).code).toBe(LOCKOUT_CODE);
    // Code that isn't an arena cart's is left alone, and says what it lacks.
    expect(patchArenaCode("function TIC() end", LOCKOUT_MAP, centre).missing).toContain("local COL =");
  });

  it("measures the camera's centre where the runtime frames the scene", () => {
    const lockout = arenaSceneCentre(decodeMeshSidecar(arenaMap("lockout").sidecar()))!;
    [LOCKOUT_CENTER_X, LOCKOUT_CENTER_Y, LOCKOUT_CENTER_Z].forEach((v, a) => expect(lockout[a]).toBeCloseTo(v, 4));
  });

  it("builds an unedited map to exactly the code and scene it already has", () => {
    const sidecar = decodeMeshSidecar(arenaMap("beaver").sidecar());
    const built = buildArenaToGame(arenaMapCode("beaver"), sidecar)!;
    expect(built.missing).toEqual([]);
    expect(built.warning).toBeNull();
    expect(built.changed).toBe(0);
    expect(built.code).toBe(arenaMapCode("beaver"));
    expect(built.sidecar.meshes.map((m) => m.id)).toEqual(sidecar.meshes.map((m) => m.id));
    expect(built.sidecar.meshes.map((m) => m.mesh)).toEqual(sidecar.meshes.map((m) => m.mesh));
  });

  it("lays the Pickups out again for edited pads, before the Holograms, keeping the models it has", () => {
    const sidecar = decodeMeshSidecar(arenaMap("lockout").sidecar());
    const pads = setPadWeapons(addArenaActor(LOCKOUT_MAP, "pad", [0, 0, 5], { weapon: "hammer" }).map, 0, ["sniper", "fuelrod"]);
    const { sidecar: next, warning } = relayArenaPickups(sidecar, pads);
    expect(warning).toBeNull();
    const pickups = next.meshes.filter((m) => /^pickup-\d+$/.test(m.id));
    expect(pickups.map((m) => m.name)).toEqual(arenaPads(pads).flat().map((w) => `pickup ${w}`));
    const first = next.meshes.findIndex((m) => m.id === "pickup-1");
    expect(next.meshes[first + pickups.length]!.id).toBe("hologram-1");
    // The sniper's model is the one the scene already floated.
    const old = sidecar.meshes.find((m) => m.name === "pickup sniper")!;
    expect(pickups.find((m) => m.name === "pickup sniper")!.mesh).toBe(old.mesh);
    // Each floats over its pad.
    const hammer = pickups.at(-1)!;
    expect(hammer.name).toBe("pickup hammer");
    expect(hammer.transform.position[0]).toBe(0);
    expect(hammer.transform.position[2]).toBe(5);
    // The rest of the scene is untouched and in order.
    expect(next.meshes.filter((m) => !/^pickup-/.test(m.id)).map((m) => m.id)).toEqual(sidecar.meshes.filter((m) => !/^pickup-/.test(m.id)).map((m) => m.id));
  });

  it("checks a map: both shipped maps pass; a spawn dragged into the air is reported where it is", () => {
    for (const entry of ARENA_MAPS) expect(checkArenaMap(decodeMeshSidecar(entry.sidecar()))).toEqual([]);
    const sidecar = decodeMeshSidecar(arenaMap("beaver").sidecar());
    const floating = setMeshArena(sidecar, moveArenaActor(sidecar.arena!, "arena:spawn:0", [0, 12, 0]));
    const issues = checkArenaMap(floating);
    expect(issues.map((i) => i.kind)).toContain("spawn-floor");
    expect(issues.find((i) => i.kind === "spawn-floor")!.at).toEqual([0, 12, 0]);
  });

  it("rebuilds navigation from collision: a new platform gets walkable floor, and bots reach its pad", () => {
    const sidecar = decodeMeshSidecar(arenaMap("beaver").sidecar());
    const [x, z] = [6, 6];
    const g = groundHeight(sidecar.arena!.ground!, x, z)!;
    // A 5 m platform on the canyon floor, a pad on top, and steps down from it.
    const placed = addArenaActor(sidecar.arena!, "solid", [x, g, z]);
    let map = resizeArenaActor(moveArenaActor(placed.map, placed.id, [x, g + 2.5, z]), placed.id, [1, 2.5, 1]);
    map = addArenaActor(map, "pad", [x, g + 5, z], { weapon: "hammer" }).map;
    map = { ...map, flights: [...map.flights, { axis: "x", fixed: z, halfFixed: 0.8, start: x - 1, sign: -1, topFrom: g + 5, topTo: g }] };
    expect(sameArenaCollision(map, sidecar.arena!)).toBe(false);
    const stale = setMeshArena(sidecar, map);
    expect(floorsAt(readNavMesh(stale.navmesh)!, x, z).some((h) => Math.abs(h - (g + 5)) < 0.1)).toBe(false);
    const fresh = rebuildArenaNavigation(stale);
    expect(floorsAt(readNavMesh(fresh.navmesh)!, x, z).some((h) => Math.abs(h - (g + 5)) < 0.1)).toBe(true);
    expect(checkArenaMap(fresh)).toEqual([]);
  }, 120_000);

  it("plays a saved cart's edited markup in the demo, and only when it was edited", () => {
    const json = arenaMap("beaver").sidecar();
    const saved = decodeMeshSidecar(json);
    expect(lockoutMarkup("beaver", json, saved)).toBeNull();
    expect(lockoutMarkup("lockout", arenaMap("lockout").sidecar(), saved)).toBeNull(); // Beaver's markup isn't Lockout's
    const edited = setMeshArena(saved, setPadWeapons(saved.arena!, 0, ["hammer"]));
    const markup = lockoutMarkup("beaver", json, edited)!;
    expect(markup.code).toContain('PAD_ROT = { { "hammer" }');
    expect(markup.code).toContain('MAPS = { "Lockout", "Beaver Creek" }');
    expect(markup.code).toContain("MAP_INDEX = 2");
    expect(markup.issues).toEqual([]);
    const scene = decodeMeshSidecar(markup.json);
    expect(scene.meshes.filter((m) => /^pickup-/.test(m.id)).map((m) => m.name)).toContain("pickup hammer");
  });
});

/** An arena cart and its scene as the player prepares them, with `probe` appended to the code. */
async function play(code: string, sidecar: string, probe: string) {
  const mesh = parseMeshScene(sidecar)!;
  let prepared = seedCartridge(lockoutCartridge(`${code}\n${probe}`), 12345);
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
  const start = () => {
    for (let i = 0; i < 4; i += 1) tick();
    tick(1 << 4);
    for (let i = 0; i < 40; i += 1) tick(i % 2 ? 1 << 4 : 0);
  };
  return { tick, words, start, destroy: () => channel.destroy() };
}

describe.skipIf(!existsSync(ENGINE))("an edited Beaver Creek, on the real engine", () => {
  it("carries a soldier through a teleporter placed in the editor, and floats a pad's new weapon", async () => {
    const json = arenaMap("beaver").sidecar();
    const saved = decodeMeshSidecar(json);
    // A new teleporter on the creek bed's west bank, sending you up onto the arch;
    // and the rocket pad under the arch now carries the Gravity Hammer.
    const floor = (x: number, z: number) => groundHeight(saved.arena!.ground!, x, z)!;
    let map = addArenaActor(saved.arena!, "tpfrom", [-8, floor(-8, 4), 4]).map;
    map = moveArenaActor(map, `arena:tpto:${map.teleporters!.length - 1}`, [12, floor(12, 6), 6]);
    const rocket = map.markers.findIndex((m) => m.weapon === "rocket");
    map = setPadWeapons(map, rocket, ["hammer"]);
    const markup = lockoutMarkup("beaver", json, setMeshArena(saved, map))!;
    expect(markup).not.toBeNull();
    const g = await play(
      markup.code,
      markup.json,
      `;(function()
local _T, n = TIC, 0
function TIC()
  _T()
  if phase ~= "play" or not p then return end
  n = n + 1
  if n == 5 then p.x, p.y, p.z, p.vy, p.tp_cd = -8.3, ${floor(-8.3, 4).toFixed(2)}, 4, 0, 0 end
  if n > 5 and n < 25 then move_soldier(p, 1, 0, 0, false, false, false, 0) end
  if n == 25 then pmem(118, (math.floor(p.x*100 + 5000) & 0xffff) | ((math.floor(p.z*100 + 5000) & 0xffff) << 16)) end
  local w = PAD_ROT[${rocket + 1}][1]
  pmem(117, w == "hammer" and 1 or 0)
end
end)()`,
    );
    g.start();
    for (let i = 0; i < 40; i += 1) g.tick();
    const [hammer, at] = g.words();
    expect(hammer).toBe(1);
    const [px, pz] = [((at & 0xffff) - 5000) / 100, ((at >>> 16) - 5000) / 100];
    // Arrived at the exit (12, 6), not left on the bank.
    expect(Math.hypot(px - 12, pz - 6)).toBeLessThan(3);
    g.destroy();
  }, 180_000);
});
