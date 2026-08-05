/**
 * The "Platformer" starter — a worked example of the collision layer.
 *
 * The cart bakes in no walls: it draws the level and runs its physics entirely
 * against `cartbox.solid`, so it is both a playable jump-around and living
 * documentation for the collision feature. The matching collision layer ships
 * with the starter ({@link PLATFORMER_COLLISION}) so a fresh cart works the moment
 * it opens — the editor loads it as the new cart's collision sidecar.
 *
 * Written against the CartEngine interface, like {@link seedDemoCart}, so the same
 * seed populates the in-memory stub and a freshly created WASM cartridge.
 */

import type { CartEngine } from "../engine/CartEngine";
import { paletteForModel, hexToRgb } from "./palette";
import { CollisionMap, type CollisionData } from "./CollisionMap";

/** The collision grid: one classic screen of 8px cells. */
const GRID_W = 30;
const GRID_H = 17;

/** Build the starter's collision layer — a floor plus a few reachable platforms. */
function buildCollision(): CollisionData {
  const map = new CollisionMap(GRID_W, GRID_H);
  // Ground: the bottom two rows, right across.
  for (let x = 0; x < GRID_W; x += 1) {
    map.setSolid(x, GRID_H - 1, true);
    map.setSolid(x, GRID_H - 2, true);
  }
  // Three platforms to hop between, low to high.
  const platforms: Array<[number, number, number]> = [
    [4, 11, 9], // [startX, y, endX]
    [14, 8, 20],
    [22, 12, 27],
  ];
  for (const [startX, y, endX] of platforms) {
    for (let x = startX; x <= endX; x += 1) map.setSolid(x, y, true);
  }
  return map.serialize();
}

/** The collision layer the editor loads for a new Platformer cart. */
export const PLATFORMER_COLLISION: CollisionData = buildCollision();

/** The playable platformer, driven entirely by cartbox.solid(). */
export const PLATFORMER_CODE = `-- title:  platformer starter
-- author: you
-- desc:   arrows move, A jumps -- physics runs on cartbox.solid
-- script: lua

local CS = 8            -- collision cell size, pixels
local W, H = 6, 8       -- player size, pixels
local SPD = 1.2
local GRAV = 0.3
local JUMP = -3.4
local px, py, vy = 24, 96, 0

-- Is the player's box overlapping any solid cell at (x, y)?
local function hits(x, y)
  return cartbox.solid(x // CS, y // CS)
      or cartbox.solid((x + W - 1) // CS, y // CS)
      or cartbox.solid(x // CS, (y + H - 1) // CS)
      or cartbox.solid((x + W - 1) // CS, (y + H - 1) // CS)
end

function TIC()
  -- Horizontal: move only if the way is clear, so you stop flush against walls.
  local dx = (btn(3) and SPD or 0) - (btn(2) and SPD or 0)
  if dx ~= 0 and not hits(px + dx, py) then px = px + dx end
  px = math.max(0, math.min(px, 240 - W))

  -- Gravity, then resolve the vertical move by creeping to the surface.
  vy = vy + GRAV
  local grounded = false
  if hits(px, py + vy) then
    local step = vy > 0 and 1 or -1
    while not hits(px, py + step) do py = py + step end
    grounded = vy > 0
    vy = 0
  else
    py = py + vy
  end

  if grounded and btnp(4) then vy = JUMP end
  if py > 150 then px, py, vy = 24, 96, 0 end -- fell off: respawn

  cls(0)
  local mw, mh = cartbox.mapsize()
  for cy = 0, mh - 1 do
    for cx = 0, mw - 1 do
      if cartbox.solid(cx, cy) then rect(cx * CS, cy * CS, CS, CS, 3) end
    end
  end
  rect(px, py, W, H, 12)
  print("arrows move   A jumps", 4, 4, 15)
end
`;

export function seedPlatformerCart(engine: CartEngine): void {
  // The model's default palette; colours 3 (walls) and 12 (player) come from it.
  paletteForModel(engine.model()).forEach((hex, index) => {
    const [red, green, blue] = hexToRgb(hex);
    engine.setPaletteColor(index, red, green, blue);
  });

  engine.setLanguage("lua");
  engine.setCode(PLATFORMER_CODE);
}
