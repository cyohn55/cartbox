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

/** Marker world positions (for the glow lights), as a flat Lua list. */
function markersLua(): string {
  const markers = GROUPS.find((g) => g.name === "markers")!;
  return markers.boxes.map(([cx, cy, cz]) => `${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}`).join(",");
}

export const LOCKOUT_CODE = `-- title:  Lockout arena
-- author: you
-- desc:   Halo 2 Lockout homage -- first-person vs 7 bots on the Xbox 360 core
-- script: lua

-- Cartbox has no netcode, so "8 players" is you + 7 AI bots in one local match.
-- Controls: WASD move . mouse or arrow keys look . left-click / B fire . A jump.
-- This is the map + core FPS pass; game types and the full weapon sandbox land
-- next. See MODES for the scaffold.

local CENTER_Y = ${LOCKOUT_CENTER_Y.toFixed(4)}
local COL = {${collidersLua()}}       -- solid boxes: x0,y0,z0,x1,y1,z1 repeating
local SPN = {${spawnsLua()}}          -- spawn points: x,y,z repeating
local MRK = {${markersLua()}}         -- weapon-marker glow positions: x,y,z repeating
local NBOT = ${BOT_COUNT}

-- Standard Lockout sandbox + per-mode rules, scaffolded for the follow-up pass.
local MODES = {
  ffa    = { name="Free for All",  teams=false, shields=true,  radar=true,  weapons={"br","smg","shotgun","sniper","sword"} },
  slayer = { name="Team Slayer",   teams=true,  shields=true,  radar=true,  weapons={"br","smg","shotgun","sniper","sword"} },
  swat   = { name="SWAT",          teams=true,  shields=false, radar=false, weapons={"br","magnum"} },
  snipe  = { name="Team Snipers",  teams=true,  shields=true,  radar=false, weapons={"sniper","magnum"} },
}
local MODE = MODES.ffa   -- this pass ships FFA + Battle Rifle

local PR   = 0.55        -- player collision radius
local PH   = 1.7         -- player height
local EYE  = 1.5         -- eye height above feet
local STEP = 0.6         -- max ledge you auto-step onto
local GRAV = 0.028
local MOVE = 0.16
local JUMP = 0.5
local SENS = 0.006

local p = nil            -- player state, built on first frame
local bots = {}
local last_mx, last_my = 640, 360
local inited = false

local function ncol() return #COL // 6 end

-- Resolve one horizontal axis of movement against the collider boxes, allowing
-- a step up onto anything whose top is within STEP of the feet.
local function move_axis(ax, d)
  if ax == "x" then p.x = p.x + d else p.z = p.z + d end
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i * 6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR > x0 and p.x-PR < x1 and p.z+PR > z0 and p.z-PR < z1 and head > y0 and feet < y1 then
      if y1 - feet <= STEP and y1 - feet > 0 then
        p.y = y1; feet = y1; head = y1 + PH      -- step up onto it
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

-- Gravity + landing: drop, then rest on the highest box top under the feet.
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
        p.y = y0 - PH; p.vy = 0                 -- bonk the ceiling
      end
    end
  end
  if p.y < -6 then respawn(p) end               -- fell off the world
end

function respawn(who)
  local s = (math.random(0, NBOT)) * 3
  who.x, who.y, who.z = SPN[s+1], SPN[s+2], SPN[s+3]
  who.vy = 0; who.hp = 100; who.sh = MODE.shields and 100 or 0
  who.dead = false; who.respawn = 0
end

local function forward()
  local cp = math.cos(p.ap)
  return cp*math.sin(p.ay), math.sin(p.ap), cp*math.cos(p.ay)
end

-- Point the orbit camera so the eye lands exactly at the player: target = eye +
-- forward*d, and the orbit angles are inverse-solved from -forward. Offsets are
-- relative to the scene centre (0, CENTER_Y, 0).
local function drive_camera()
  local fx, fy, fz = forward()
  local ex, ey, ez = p.x, p.y + EYE, p.z
  local d = 0.5
  local tx, ty, tz = ex + fx*d, ey + fy*d, ez + fz*d
  local oy = math.atan(-fx, -fz)
  local op = math.asin(math.max(-0.999, math.min(0.999, -fy)))
  cartbox.worldcam(oy, op, d, 1.2, tx - 0, ty - CENTER_Y, tz - 0)
end

-- Hitscan the Battle Rifle: nearest bot within a small screen-cone of the
-- crosshair and in range, not blocked by geometry (approximate: range only).
local function fire()
  if p.cool > 0 then return end
  p.cool = 8
  local fx, fy, fz = forward()
  local ex, ey, ez = p.x, p.y + EYE, p.z
  local best, bestt = nil, 999
  for _, o in ipairs(bots) do
    if not o.dead then
      local dx, dy, dz = o.x - ex, (o.y + 1.2) - ey, o.z - ez
      local t = dx*fx + dy*fy + dz*fz               -- distance along the ray
      if t > 0.5 and t < 40 then
        local px, py, pz = ex + fx*t, ey + fy*t, ez + fz*t
        local m = math.sqrt((o.x-px)^2 + (o.y+1.2-py)^2 + (o.z-pz)^2)
        if m < 0.8 and t < bestt then best, bestt = o, t end
      end
    end
  end
  if best then
    local dmg = 24
    if best.sh > 0 then best.sh = best.sh - dmg else best.hp = best.hp - dmg end
    if best.hp <= 0 then
      best.dead = true; best.respawn = 120; p.score = p.score + 1
    end
  end
end

local function think_bot(o)
  if o.dead then
    o.respawn = o.respawn - 1
    if o.respawn <= 0 then respawn(o) end
    return
  end
  -- Wander toward the current waypoint; repick when close or stuck.
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
  -- Snap the bot to the deck/floor height beneath it (cheap gravity).
  local top = 0
  for i = 0, ncol() - 1 do
    local b = i * 6
    if o.x > COL[b+1] and o.x < COL[b+4] and o.z > COL[b+3] and o.z < COL[b+6] then
      if COL[b+5] <= 2.6 and COL[b+5] > top then top = COL[b+5] end
    end
  end
  o.y = top
  -- Take a poke at the player if roughly facing and close.
  local pdx, pdz = p.x - o.x, p.z - o.z
  local pm = math.sqrt(pdx*pdx + pdz*pdz)
  if pm < 16 and math.random() < 0.02 then
    if p.sh > 0 then p.sh = p.sh - 6 else p.hp = p.hp - 8 end
    if p.hp <= 0 then respawn(p); p.deaths = p.deaths + 1 end
  end
end

local function read_input()
  -- Look: mouse delta (primary) + arrow keys (fallback).
  local mx, my, ml = mouse()
  p.ay = p.ay + (mx - last_mx) * SENS
  p.ap = p.ap - (my - last_my) * SENS
  last_mx, last_my = mx, my
  if btn(2) then p.ay = p.ay - 0.045 end
  if btn(3) then p.ay = p.ay + 0.045 end
  if btn(0) then p.ap = p.ap + 0.04 end
  if btn(1) then p.ap = p.ap - 0.04 end
  if p.ap > 1.4 then p.ap = 1.4 elseif p.ap < -1.4 then p.ap = -1.4 end

  -- Move: WASD. Strafe is forward rotated 90 degrees on the XZ plane.
  local sy, cy = math.sin(p.ay), math.cos(p.ay)
  local mvx, mvz = 0, 0
  if key(23) then mvx = mvx + sy; mvz = mvz + cy end   -- W
  if key(19) then mvx = mvx - sy; mvz = mvz - cy end   -- S
  if key(1)  then mvx = mvx - cy; mvz = mvz + sy end   -- A
  if key(4)  then mvx = mvx + cy; mvz = mvz - sy end   -- D
  local mm = math.sqrt(mvx*mvx + mvz*mvz)
  if mm > 0 then move_axis("x", mvx/mm*MOVE); move_axis("z", mvz/mm*MOVE) end

  if btn(4) and p.grounded then p.vy = JUMP; p.grounded = false end  -- A = jump
  if p.cool > 0 then p.cool = p.cool - 1 end
  if ml or btn(5) then fire() end                                    -- click / B = fire
end

local function init()
  p = { ay=0, ap=0, vy=0, cool=0, score=0, deaths=0 }
  respawn(p)
  for i = 1, NBOT do
    local o = { tx=0, tz=0, face=0 }
    respawn(o)
    o.tx, o.tz = o.x, o.z
    bots[i] = o
  end
  inited = true
end

function TIC()
  if not inited then init() end
  read_input()
  move_vertical()
  for _, o in ipairs(bots) do think_bot(o) end

  -- Sky + lights.
  cls(0)
  rect(0, 0, 1280, 300, 1)
  rect(0, 300, 1280, 420, 2)
  cartbox.clearlights()
  cartbox.sun(-0.4, -0.85, 0.4, 200, 214, 240, 0.85)
  for i = 0, (#MRK // 3) - 1 do
    local b = i * 3
    cartbox.light(0, 0, 5, 40, 220, 210, 1.4)  -- teal marker glow (screen-space x,y unused for mesh)
  end

  -- Pose the 7 bots (map is instance 0; bots are 1..7).
  cartbox.clearposes()
  for i = 1, NBOT do
    local o = bots[i]
    if o.dead then
      cartbox.meshpose(i, 0, -50, 0, 0, 0, 0, 0)  -- parked + scaled to nothing
    else
      cartbox.meshpose(i, o.x, o.y, o.z, o.face, 0, 0, 1)
    end
  end

  drive_camera()

  -- HUD.
  local cx, cy2 = 640, 360
  line(cx-14, cy2, cx-5, cy2, 12); line(cx+5, cy2, cx+14, cy2, 12)
  line(cx, cy2-14, cx, cy2-5, 12); line(cx, cy2+5, cx, cy2+14, 12)
  rect(40, 40, 300, 18, 0); rect(40, 40, 3*p.hp, 18, 6)          -- health
  rect(40, 64, 300, 12, 0); rect(40, 64, 3*(p.sh>0 and p.sh or 0), 12, 9)  -- shields
  print(MODE.name.."  --  BATTLE RIFLE", 40, 90, 12, false, 1, true)
  print("Score "..p.score.."   Deaths "..p.deaths, 40, 690, 12, false, 1, true)
  print("WASD move . mouse/arrows look . click fire . A jump", 700, 690, 13, false, 1, true)
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
