/**
 * The "Lockout arena" starter — a Halo 2 Lockout-inspired multiplayer map for the
 * Xbox 360 model, playable first-person against AI bots.
 *
 * Cartbox has no networking (carts are single-process TIC-80 Lua), so the "8
 * players" of the original are modelled as **you + 7 AI bots** in one local match.
 * This is the first pass — the map geometry, first-person movement/look with AABB
 * collision, a Battle Rifle (hitscan), wandering bots that shoot back and respawn,
 * and a Free-for-All scoreline. The four game types (FFA / Team Slayer / SWAT /
 * Team Snipers) and the full Lockout weapon sandbox are scaffolded in `MODES`
 * below and filled in follow-up passes.
 *
 * The layout is a stylised homage, not a survey-accurate rip: a central pillar
 * (the iconic tower) on a raised cross of platforms — the four arms stand in for
 * BR tower, Sniper tower, and the two elbow rooms — over a recover floor, with
 * ramps up from the floor. It is built from the shared {@link seedGeometry}
 * primitives, coloured Forerunner blue-grey, and lit by the code's sun so the
 * material lighting shipped in the era work reads on it.
 *
 * The camera is first-person via a trick: the mesh renderer only exposes an orbit
 * camera (yaw/pitch/distance around the scene centre), but the cart can move that
 * orbit *target* (the `worldcam` alias writes the same mailbox slot the mesh
 * camera reads). Placing the target just ahead of the player and inverse-solving
 * the orbit angles lands the eye exactly at the player — see LOCKOUT_CODE. Because
 * the offset is relative to the scene's bounding-box centre, the geometry is kept
 * symmetric in X/Z with the bots authored at the origin, so that centre is a known
 * constant (0, CENTER_Y, 0) that a test pins against the runtime's own bounds.
 */

import type { CartEngine } from "../engine/CartEngine";
import { serializeMeshAsset, type MeshAsset, type MeshPrimitive } from "./MeshAsset";
import { newStreams, pushBox, toPrimitive, type Streams } from "./seedGeometry";

/** An axis-aligned box: centre (cx,cy,cz) and half-extents (hx,hy,hz). */
type Box = readonly [number, number, number, number, number, number];

/** A named group of same-coloured boxes → one mesh primitive. */
interface BoxGroup {
  readonly name: string;
  readonly color: readonly [number, number, number];
  /** Whether these boxes are solid (contribute to collision). Markers are not. */
  readonly solid: boolean;
  readonly boxes: Box[];
}

// --- The map, as coloured box groups --------------------------------------
// Coordinates: X right, Y up, Z forward. The map is symmetric in X and Z about
// the origin so the scene's bounding-box centre is exactly (0, CENTER_Y, 0).

const FLOOR_HALF = 12; // recover floor spans ±12 in X and Z
const DECK_TOP = 2.5; // the raised cross of platforms
const DECK_HY = DECK_TOP / 2;

/** Generate a descending flight of steps from a deck edge down to the floor,
 *  so the player and bots can climb back up (paired with the code's step-up). */
function stairs(
  axis: "x" | "z",
  sign: 1 | -1,
  edge: number, // deck edge coordinate on `axis`
  cross: number, // fixed coordinate on the other axis
  halfCross: number,
): Box[] {
  const steps = 5;
  const rise = DECK_TOP / steps; // 0.5 per step
  const run = 0.7;
  const out: Box[] = [];
  for (let i = 0; i < steps; i += 1) {
    const top = DECK_TOP - rise * (i + 1); // 2.0,1.5,1.0,0.5,0.0
    const pos = edge + sign * (i + 0.5) * run;
    const hy = Math.max(0.02, top / 2);
    out.push(
      axis === "z"
        ? [cross, top / 2, pos, halfCross, hy, run / 2]
        : [pos, top / 2, cross, run / 2, hy, halfCross],
    );
  }
  return out;
}

const DECKS: Box[] = [
  [0, DECK_HY, 0, 3, DECK_HY, 3], // centre platform
  [0, DECK_HY, -8, 3, DECK_HY, 3], // north arm — "BR tower"
  [0, DECK_HY, 8, 3, DECK_HY, 3], // south arm — "Sniper tower"
  [-8, DECK_HY, 0, 3, DECK_HY, 3], // west arm — elbow
  [8, DECK_HY, 0, 3, DECK_HY, 3], // east arm — elbow
  [0, DECK_HY, -4.5, 1.2, DECK_HY, 1.5], // north bridge
  [0, DECK_HY, 4.5, 1.2, DECK_HY, 1.5], // south bridge
  [-4.5, DECK_HY, 0, 1.5, DECK_HY, 1.2], // west bridge
  [4.5, DECK_HY, 0, 1.5, DECK_HY, 1.2], // east bridge
];

const GROUPS: BoxGroup[] = [
  {
    name: "floor",
    color: [0.16, 0.18, 0.22],
    solid: true,
    boxes: [[0, -0.5, 0, FLOOR_HALF, 0.5, FLOOR_HALF]],
  },
  {
    name: "decks",
    color: [0.44, 0.5, 0.58],
    solid: true,
    boxes: DECKS,
  },
  {
    name: "ramps",
    color: [0.38, 0.42, 0.5],
    solid: true,
    boxes: [
      ...stairs("z", -1, -11, 0, 2), // north ramp, off the BR tower's outer edge
      ...stairs("z", 1, 11, 0, 2), // south ramp, off the Sniper tower's outer edge
    ],
  },
  {
    name: "tower",
    color: [0.3, 0.36, 0.44],
    solid: true,
    // The central pillar: from the deck (2.5) up to 5.5, the map's tallest point.
    boxes: [[0, 4, 0, 1.5, 1.5, 1.5]],
  },
  {
    name: "rails",
    color: [0.24, 0.27, 0.32],
    solid: true,
    // Low guard blocks on the outer corners of the arms — cover and a lip.
    boxes: [
      [0, DECK_TOP + 0.4, -11, 3, 0.4, 0.2],
      [0, DECK_TOP + 0.4, 11, 3, 0.4, 0.2],
      [-11, DECK_TOP + 0.4, 0, 0.2, 0.4, 3],
      [11, DECK_TOP + 0.4, 0, 0.2, 0.4, 3],
    ],
  },
  {
    name: "markers",
    color: [0.15, 0.85, 0.8], // teal weapon-spawn markers (non-solid, walk-through)
    solid: false,
    boxes: [
      [0, DECK_TOP + 0.4, -8, 0.3, 0.4, 0.3], // BR — north
      [0, DECK_TOP + 0.4, 8, 0.3, 0.4, 0.3], // Sniper — south
      [-8, DECK_TOP + 0.4, 0, 0.3, 0.4, 0.3], // Shotgun — west
      [8, DECK_TOP + 0.4, 0, 0.3, 0.4, 0.3], // Sword — east
      [0, 0.4, 0, 0.3, 0.4, 0.3], // SMG — floor centre (under the cross)
    ],
  },
];

/** Player and bot spawn points, on the deck and floor. [x, yFeet, z]. */
const SPAWNS: ReadonlyArray<readonly [number, number, number]> = [
  [0, DECK_TOP, -8], // BR tower
  [0, DECK_TOP, 8], // Sniper tower
  [-8, DECK_TOP, 0], // west elbow
  [8, DECK_TOP, 0], // east elbow
  [0, DECK_TOP, 0], // centre (by the pillar)
  [7, 0, -7], // floor corners
  [-7, 0, 7],
  [7, 0, 7],
];

const BOT_COUNT = 7;

// --- Mesh assembly --------------------------------------------------------

function mapMesh(): MeshAsset {
  const primitives: MeshPrimitive[] = [];
  for (const group of GROUPS) {
    if (group.boxes.length === 0) continue;
    const streams = newStreams();
    for (const [cx, cy, cz, hx, hy, hz] of group.boxes) {
      pushBox(streams, [cx, cy, cz], [hx, hy, hz], 1);
    }
    primitives.push(
      toPrimitive(streams, {
        name: group.name,
        baseColorFactor: [group.color[0], group.color[1], group.color[2], 1],
        baseColorImage: null,
      }),
    );
  }
  return { name: "Lockout arena", primitives };
}

/** A blocky spartan-ish figure: legs, torso, head. Authored at the origin,
 *  feet at y=0, so a per-frame meshpose places it in absolute world space. */
function botMesh(): MeshAsset {
  const s: Streams = newStreams();
  pushBox(s, [0, 0.5, 0], [0.28, 0.5, 0.24], 1); // legs
  pushBox(s, [0, 1.25, 0], [0.34, 0.35, 0.28], 1); // torso
  pushBox(s, [0, 1.72, 0], [0.2, 0.2, 0.2], 1); // head
  pushBox(s, [0, 1.35, -0.28], [0.12, 0.12, 0.35], 1); // a nub facing -Z, so facing reads
  return {
    name: "spartan",
    primitives: [
      toPrimitive(s, { name: "armor", baseColorFactor: [0.85, 0.42, 0.12, 1], baseColorImage: null }),
    ],
  };
}

/** The map's vertical extent, from the box groups — floor bottom to pillar top. */
function mapYExtent(): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const group of GROUPS) {
    for (const [, cy, , , hy] of group.boxes) {
      min = Math.min(min, cy - hy);
      max = Math.max(max, cy + hy);
    }
  }
  return { min, max };
}

const Y_EXTENT = mapYExtent();
/** The scene bounding-box centre Y. X and Z centres are 0 by symmetry. Bots are
 *  authored at the origin (inside the map), so they never extend these bounds. */
export const LOCKOUT_CENTER_Y = (Y_EXTENT.min + Y_EXTENT.max) / 2;

/** The stored mesh sidecar: the map (instance 0) + 7 bot instances (1..7),
 *  every bot authored at the origin so a per-frame meshpose is absolute world. */
export const LOCKOUT_MESH_SIDECAR: string = (() => {
  const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const botSerialized = serializeMeshAsset(botMesh());
  const meshes: unknown[] = [
    { id: "lockout-map", name: "Lockout arena", mesh: serializeMeshAsset(mapMesh()), transform: identity },
  ];
  for (let i = 0; i < BOT_COUNT; i += 1) {
    meshes.push({ id: `bot-${i}`, name: `bot ${i}`, mesh: botSerialized, transform: identity });
  }
  return JSON.stringify({ version: 1, meshes });
})();

/** Triangles in the whole scene (map + bots), for the poly-budget test. */
export const LOCKOUT_SCENE_TRIANGLES = (() => {
  const map = mapMesh().primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  const bot = botMesh().primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  return map + bot * BOT_COUNT;
})();

// --- The cart code --------------------------------------------------------

/** Flatten the solid boxes to a Lua collider list `{x0,y0,z0,x1,y1,z1, ...}`. */
function collidersLua(): string {
  const nums: number[] = [];
  for (const group of GROUPS) {
    if (!group.solid) continue;
    for (const [cx, cy, cz, hx, hy, hz] of group.boxes) {
      nums.push(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz);
    }
  }
  return nums.map((n) => n.toFixed(2)).join(",");
}

function spawnsLua(): string {
  return SPAWNS.flat().map((n) => n.toFixed(2)).join(",");
}

/** Marker world positions (for the glow lights + pickups), as a flat Lua list. */
function markersLua(): string {
  const markers = GROUPS.find((g) => g.name === "markers")!;
  return markers.boxes.map(([cx, cy, cz]) => `${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}`).join(",");
}

/** The weapon each marker dispenses, in the same order as the marker boxes:
 *  BR (north), Sniper (south), Shotgun (west), Sword (east), SMG (floor). */
const MARKER_WEAPONS = ["br", "sniper", "shotgun", "sword", "smg"] as const;
function markerWeaponsLua(): string {
  return MARKER_WEAPONS.map((w) => `"${w}"`).join(",");
}

export const LOCKOUT_CODE = `-- title:  Lockout arena
-- author: you
-- desc:   Halo 2 Lockout homage -- first-person vs 7 bots on the Xbox 360 core
-- script: lua

-- Cartbox has no netcode, so "8 players" is you + 7 AI bots in one local match.
-- Pick a game type on the start screen, then:
--   WASD move . mouse or arrow keys look . left-click / B fire . A jump
--   X swap weapon . right-click zoom (sniper) . grab the teal markers for weapons

local CENTER_Y = ${LOCKOUT_CENTER_Y.toFixed(4)}
local COL = {${collidersLua()}}       -- solid boxes: x0,y0,z0,x1,y1,z1 repeating
local SPN = {${spawnsLua()}}          -- spawn points: x,y,z repeating
local MRK = {${markersLua()}}         -- weapon-marker positions: x,y,z repeating
local MW  = {${markerWeaponsLua()}}   -- weapon each marker dispenses (aligned to MRK)
local NBOT = ${BOT_COUNT}

-- The Lockout weapon sandbox. dmg per hit, cool = frames between shots, rng =
-- range (world units), hs = headshot multiplier, mag = magazine, pel = pellets,
-- spr = spread. The four game types below pick which of these are in play.
local W = {
  br      = { name="Battle Rifle",  dmg=18, cool=9,  rng=44, hs=1.7, mag=36, pel=1, spr=0.004 },
  smg     = { name="SMG",           dmg=8,  cool=3,  rng=24, hs=1.2, mag=60, pel=1, spr=0.03 },
  shotgun = { name="Shotgun",       dmg=13, cool=20, rng=11, hs=1.0, mag=6,  pel=6, spr=0.11 },
  sniper  = { name="Sniper Rifle",  dmg=80, cool=42, rng=130,hs=3.0, mag=4,  pel=1, spr=0.0,  zoom=true },
  magnum  = { name="Magnum",        dmg=22, cool=13, rng=36, hs=2.2, mag=8,  pel=1, spr=0.0 },
  sword   = { name="Energy Sword",  dmg=200,cool=22, rng=2.6,hs=1.0, mag=99, pel=1, spr=0.0,  melee=true },
}

-- Per-mode rules + loadout. start = spawn primary; secondary is always the magnum.
local MODES = {
  ffa    = { name="Free for All", teams=false, shields=true,  radar=true,  start="br",     target=15,
             weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  slayer = { name="Team Slayer",  teams=true,  shields=true,  radar=true,  start="br",     target=40,
             weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  swat   = { name="SWAT",         teams=true,  shields=false, radar=false, start="br",     target=40,
             weapons={} },   -- no on-map power weapons: BR + magnum only, no shields
  snipe  = { name="Team Snipers", teams=true,  shields=true,  radar=false, start="sniper", target=25,
             weapons={} },   -- sniper + magnum only
}
local MODE_KEYS = {"ffa","slayer","swat","snipe"}

local PR   = 0.55        -- player collision radius
local PH   = 1.7
local EYE  = 1.5
local STEP = 0.6
local GRAV = 0.028
local MOVE = 0.16
local JUMP = 0.5
local SENS = 0.006

local phase = "menu"     -- "menu" | "play" | "over"
local sel = 1            -- menu selection
local MODE = MODES.ffa
local p = nil
local bots = {}
local team = { blue=0, red=0 }
local mtimer = {}        -- per-marker respawn timer
local winner = ""
local last_mx, last_my = 640, 360
local prev = {}          -- edge-detect held buttons

local function ncol() return #COL // 6 end
local function edge(k, held) local was = prev[k]; prev[k] = held; return held and not was end

local function move_axis(ax, d)
  if ax == "x" then p.x = p.x + d else p.z = p.z + d end
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i * 6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR > x0 and p.x-PR < x1 and p.z+PR > z0 and p.z-PR < z1 and head > y0 and feet < y1 then
      if y1 - feet <= STEP and y1 - feet > 0 then
        p.y = y1; feet = y1; head = y1 + PH
      else
        if ax == "x" then
          if d > 0 then p.x = x0 - PR else p.x = x1 + PR end
        else
          if d > 0 then p.z = z0 - PR else p.z = z1 + PR end
        end
      end
    end
  end
end

local function move_vertical()
  p.vy = p.vy - GRAV
  p.y = p.y + p.vy
  p.grounded = false
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i * 6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR > x0 and p.x-PR < x1 and p.z+PR > z0 and p.z-PR < z1 then
      if p.vy <= 0 and feet < y1 and feet > y1 - 1.2 then
        p.y = y1; p.vy = 0; p.grounded = true; feet = y1; head = y1 + PH
      elseif p.vy > 0 and head > y0 and feet < y0 then
        p.y = y0 - PH; p.vy = 0
      end
    end
  end
  if p.y < -6 then respawn(p) end
end

function respawn(who)
  local s = (math.random(0, NBOT)) * 3
  who.x, who.y, who.z = SPN[s+1], SPN[s+2], SPN[s+3]
  who.vy = 0; who.hp = 100; who.sh = MODE.shields and 100 or 0
  who.dead = false; who.respawn = 0
end

-- Give a combatant a weapon in the numbered slot, filled to a full magazine.
local function give(who, slot, id)
  who["g"..slot] = id
  who["a"..slot] = W[id].mag
end

local function forward()
  local cp = math.cos(p.ap)
  return cp*math.sin(p.ay), math.sin(p.ap), cp*math.cos(p.ay)
end

-- Move the orbit target to just ahead of the player and inverse-solve the orbit
-- angles so the eye lands exactly on the player. fov narrows when zoomed.
local function drive_camera()
  local fx, fy, fz = forward()
  local ex, ey, ez = p.x, p.y + EYE, p.z
  local d = 0.5
  local tx, ty, tz = ex + fx*d, ey + fy*d, ez + fz*d
  local oy = math.atan(-fx, -fz)
  local op = math.asin(math.max(-0.999, math.min(0.999, -fy)))
  cartbox.worldcam(oy, op, d, p.zoom and 0.5 or 1.15, tx, ty - CENTER_Y, tz)
end

local function enemy_of(who, o)
  if not MODE.teams then return true end
  return who.team ~= o.team
end

local function score_kill(killer)
  if MODE.teams then team[killer.team] = team[killer.team] + 1
  else killer.score = (killer.score or 0) + 1 end
end

-- Fire the current weapon: one ray per pellet (spread jittered), damaging the
-- nearest enemy bot within range. Shields soak first; a near-head hit multiplies.
local function player_fire()
  if p.cool > 0 or p.dead then return end
  local w = W[p.slot == 1 and p.g1 or p.g2]
  local ammo = p.slot == 1 and p.a1 or p.a2
  if ammo <= 0 then return end
  p.cool = w.cool
  if p.slot == 1 then p.a1 = p.a1 - 1 else p.a2 = p.a2 - 1 end
  local ex, ey, ez = p.x, p.y + EYE, p.z
  for _ = 1, w.pel do
    local fx, fy, fz = forward()
    if w.spr > 0 then
      fx = fx + (math.random()-0.5)*w.spr
      fy = fy + (math.random()-0.5)*w.spr
      fz = fz + (math.random()-0.5)*w.spr
    end
    local best, bestt = nil, 1e9
    for _, o in ipairs(bots) do
      if not o.dead and enemy_of(p, o) then
        local t = (o.x-ex)*fx + (o.y+1.2-ey)*fy + (o.z-ez)*fz
        if t > 0.4 and t < w.rng then
          local hx, hy, hz = ex+fx*t, ey+fy*t, ez+fz*t
          local m = math.sqrt((o.x-hx)^2 + (o.y+1.2-hy)^2 + (o.z-hz)^2)
          if m < 0.85 and t < bestt then best, bestt = o, t; o._hy = hy end
        end
      end
    end
    if best then
      local dmg = w.dmg
      if best._hy and best._hy > best.y + 1.5 then dmg = dmg * w.hs end  -- headshot
      if best.sh > 0 then
        best.sh = best.sh - dmg
        if best.sh < 0 then best.hp = best.hp + best.sh; best.sh = 0 end
      else
        best.hp = best.hp - dmg
      end
      if best.hp <= 0 then best.dead = true; best.respawn = 100; score_kill(p) end
    end
  end
end

-- Walk over a live marker whose weapon is legal this mode to pick it up.
local function try_pickups()
  for i = 0, (#MRK // 3) - 1 do
    local id = MW[i+1]
    local legal = MODE.weapons[id]
    mtimer[i+1] = math.max(0, (mtimer[i+1] or 0) - 1)
    if legal and mtimer[i+1] == 0 then
      local mx, my, mz = MRK[i*3+1], MRK[i*3+2], MRK[i*3+3]
      if math.abs(p.x-mx) < 1.4 and math.abs(p.z-mz) < 1.6 and math.abs((p.y+1)-my) < 2.0 then
        give(p, 1, id); p.slot = 1; mtimer[i+1] = 540
      end
    end
  end
end

local function think_bot(o)
  if o.dead then
    o.respawn = o.respawn - 1
    if o.respawn <= 0 then respawn(o) end
    return
  end
  local dx, dz = o.tx - o.x, o.tz - o.z
  local m = math.sqrt(dx*dx + dz*dz)
  if m < 1.0 then
    local s = math.random(0, NBOT) * 3
    o.tx, o.tz = SPN[s+1], SPN[s+3]
  else
    o.x = o.x + (dx/m) * 0.06
    o.z = o.z + (dz/m) * 0.06
    o.face = math.atan(dx, dz)
  end
  local top = 0
  for i = 0, ncol() - 1 do
    local b = i * 6
    if o.x > COL[b+1] and o.x < COL[b+4] and o.z > COL[b+3] and o.z < COL[b+6] then
      if COL[b+5] <= 2.6 and COL[b+5] > top then top = COL[b+5] end
    end
  end
  o.y = top
  -- Shoot the player if in range and hostile.
  local pdx, pdz = p.x - o.x, p.z - o.z
  local pm = math.sqrt(pdx*pdx + pdz*pdz)
  if enemy_of(o, p) and not p.dead and pm < 15 and math.random() < 0.02 then
    local dmg = MODE.shields and 8 or 30            -- SWAT hits hurt (no shields)
    if p.sh > 0 then p.sh = p.sh - 6 else p.hp = p.hp - dmg end
    if p.hp <= 0 then p.dead = true; p.respawn = 90; p.deaths = p.deaths + 1; score_kill(o) end
  end
  -- Abstract bot-vs-bot skirmishing so team/FFA scores actually move.
  if math.random() < 0.004 then
    local v = bots[math.random(1, NBOT)]
    if v and not v.dead and v ~= o and enemy_of(o, v) then
      v.dead = true; v.respawn = 100; score_kill(o)
    end
  end
end

local function reached_target()
  if MODE.teams then
    if team.blue >= MODE.target then return "BLUE TEAM WINS" end
    if team.red  >= MODE.target then return "RED TEAM WINS" end
  else
    if (p.score or 0) >= MODE.target then return "YOU WIN" end
    for _, o in ipairs(bots) do if (o.score or 0) >= MODE.target then return "A BOT WINS" end end
  end
  return nil
end

local function start_match(key)
  MODE = MODES[key]
  team.blue, team.red, winner = 0, 0, ""
  for i = 1, (#MRK // 3) do mtimer[i] = 0 end
  p = { ay=0, ap=0, vy=0, cool=0, score=0, deaths=0, slot=1, team="blue", dead=false, respawn=0 }
  respawn(p); give(p, 1, MODE.start); give(p, 2, "magnum")
  bots = {}
  for i = 1, NBOT do
    local o = { tx=0, tz=0, face=0, score=0, team=(i<=3) and "blue" or "red", g1=MODE.start }
    respawn(o); o.tx, o.tz = o.x, o.z
    bots[i] = o
  end
  phase = "play"
end

local function play_input()
  local mx, my, ml, _mm, mr = mouse()
  p.ay = p.ay + (mx - last_mx) * SENS
  p.ap = p.ap - (my - last_my) * SENS
  last_mx, last_my = mx, my
  if btn(2) then p.ay = p.ay - 0.045 end
  if btn(3) then p.ay = p.ay + 0.045 end
  if btn(0) then p.ap = p.ap + 0.04 end
  if btn(1) then p.ap = p.ap - 0.04 end
  if p.ap > 1.4 then p.ap = 1.4 elseif p.ap < -1.4 then p.ap = -1.4 end

  local sy, cy = math.sin(p.ay), math.cos(p.ay)
  local mvx, mvz = 0, 0
  if key(23) then mvx = mvx + sy; mvz = mvz + cy end
  if key(19) then mvx = mvx - sy; mvz = mvz - cy end
  if key(1)  then mvx = mvx - cy; mvz = mvz + sy end
  if key(4)  then mvx = mvx + cy; mvz = mvz - sy end
  if not p.dead then
    local mm = math.sqrt(mvx*mvx + mvz*mvz)
    if mm > 0 then move_axis("x", mvx/mm*MOVE); move_axis("z", mvz/mm*MOVE) end
  end

  if btn(4) and p.grounded and not p.dead then p.vy = JUMP; p.grounded = false end
  if edge("swap", btn(6) or key(24)) then p.slot = (p.slot == 1) and 2 or 1 end   -- X = swap
  local cur = W[p.slot == 1 and p.g1 or p.g2]
  p.zoom = (mr and cur.zoom) or false
  if p.cool > 0 then p.cool = p.cool - 1 end
  if ml or btn(5) then player_fire() end
end

function TIC()
  cls(0)

  if phase == "menu" then
    if edge("up", btn(0)) then sel = (sel - 2) % 4 + 1 end
    if edge("down", btn(1)) then sel = sel % 4 + 1 end
    local _mx,_my,ml = mouse()
    if edge("go", btn(4) or btn(5) or ml or key(48)) then start_match(MODE_KEYS[sel]) end
    print("LOCKOUT ARENA", 470, 140, 12, false, 3, true)
    print("you + 7 bots  --  Cartbox has no netcode, so the 8th slots are AI", 380, 210, 13, false, 1, true)
    for i = 1, 4 do
      local mo = MODES[MODE_KEYS[i]]
      local c = (i == sel) and 12 or 13
      if i == sel then rect(500, 286 + (i-1)*46, 280, 34, 1) end
      print(mo.name, 520, 296 + (i-1)*46, c, false, 2, true)
    end
    print("UP/DOWN choose . A or click start", 470, 520, 13, false, 1, true)
    return
  end

  if phase == "over" then
    local _mx,_my,ml = mouse()
    print(winner, 520, 300, 12, false, 3, true)
    print("A or click -> back to game types", 470, 380, 13, false, 1, true)
    if edge("go", btn(4) or btn(5) or ml) then phase = "menu" end
    return
  end

  -- phase == "play"
  play_input()
  if p.dead then
    p.respawn = p.respawn - 1
    if p.respawn <= 0 then respawn(p) end
  else
    move_vertical()
    try_pickups()
  end
  for _, o in ipairs(bots) do think_bot(o) end

  local w = reached_target()
  if w then winner = w; phase = "over" end

  -- Sky + light.
  rect(0, 0, 1280, 300, 1)
  rect(0, 300, 1280, 420, 2)
  cartbox.clearlights()
  cartbox.sun(-0.4, -0.85, 0.4, 200, 214, 240, 0.9)

  -- Pose the bots (map is instance 0; bots are 1..7).
  cartbox.clearposes()
  for i = 1, NBOT do
    local o = bots[i]
    if o.dead then cartbox.meshpose(i, 0, -50, 0, 0, 0, 0, 0)
    else cartbox.meshpose(i, o.x, o.y, o.z, o.face, 0, 0, 1) end
  end

  drive_camera()

  -- Reticle + optional scope.
  local cx, cy2 = 640, 360
  if p.zoom then
    circb(cx, cy2, 220, 0); circb(cx, cy2, 6, 12)
    line(cx-260, cy2, cx+260, cy2, 0); line(cx, cy2-260, cx, cy2+260, 0)
  else
    line(cx-14, cy2, cx-5, cy2, 12); line(cx+5, cy2, cx+14, cy2, 12)
    line(cx, cy2-14, cx, cy2-5, 12); line(cx, cy2+5, cx, cy2+14, 12)
  end

  -- HUD: health, shields (if any), weapon + ammo, score line, radar.
  rect(40, 40, 300, 18, 0); rect(40, 40, math.max(0,3*p.hp), 18, 6)
  if MODE.shields then rect(40, 64, 300, 12, 0); rect(40, 64, math.max(0,3*p.sh), 12, 9) end
  local cur = W[p.slot == 1 and p.g1 or p.g2]
  local ammo = p.slot == 1 and p.a1 or p.a2
  print(MODE.name.."  --  "..cur.name.."  ["..ammo.."]", 40, 92, 12, false, 1, true)
  if MODE.teams then
    print("BLUE "..team.blue.."   RED "..team.red.."   / "..MODE.target, 40, 690, 12, false, 1, true)
  else
    print("Score "..(p.score or 0).."   Deaths "..p.deaths.."   / "..MODE.target, 40, 690, 12, false, 1, true)
  end
  if MODE.radar then
    local rx, ry, rr = 1180, 600, 70
    circb(rx, ry, rr, 13)
    for _, o in ipairs(bots) do
      if not o.dead and enemy_of(p, o) then
        local dx, dz = o.x - p.x, o.z - p.z
        if math.abs(dx) < 30 and math.abs(dz) < 30 then
          circ(rx + dx*rr/30, ry + dz*rr/30, 2, 6)
        end
      end
    end
  end
  print("WASD move . look . fire . A jump . X swap . RMB zoom", 700, 690, 13, false, 1, true)
end
`;

/** Seed a fresh cart with the Lockout arena code and a cool metallic palette. */
export function seedLockoutCart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(LOCKOUT_CODE);
  const entries: ReadonlyArray<readonly [number, string]> = [
    [0, "#0b0e14"], // void
    [1, "#26324a"], // upper sky
    [2, "#3a4a63"], // horizon haze
    [6, "#3ad06a"], // health green
    [9, "#43b6ff"], // shield blue
    [12, "#e8eef7"], // ink
    [13, "#9fb0c8"], // dim ink
  ];
  for (const [index, hex] of entries) {
    engine.setPaletteColor(
      index,
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    );
  }
}
