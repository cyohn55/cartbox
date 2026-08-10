/**
 * The cartbox SDK as an injectable string.
 *
 * Kept in sync with sdk/cartbox.lua (that file is the copy creators read/import;
 * this string is what the platform injects into carts that opt in). Both must
 * agree with the mailbox protocol in mailbox.ts (base word 119, event ring
 * capacity 8, lights block at word 144, parallax camera at 181, mesh camera at
 * 183, mesh-pose block at 191, event types 1/2/3, FNV-1a id hash).
 */

import { prependLuaCode } from "./cartseed.js";

/** Lua source of the cartbox SDK. */
export const CARTBOX_SDK_LUA = `local _MB = 119
local _CAP = 8
local _LB = _MB + 25
local _LCAP = 6
local _CB = _LB + 1 + _LCAP * 6
local _MCB = _CB + 2
local _MPB = _MCB + 8
local _MPCAP = 8
local _ln = 0
local _mn = 0
local function _emit(kind, id, value)
  local seq = pmem(_MB)
  local slot = seq % _CAP
  local base = _MB + 1 + slot * 3
  pmem(base, kind)
  pmem(base + 1, id)
  pmem(base + 2, value)
  pmem(_MB, seq + 1)
end
local function _hash(s)
  local h = 2166136261
  for i = 1, #s do
    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff
  end
  return h
end
local function _norm(x, y, z)
  local m = math.sqrt(x * x + y * y + z * z)
  if m < 1e-6 then return 0, 0, 1 end
  return x / m, y / m, z / m
end
local function _byte(v)
  local b = math.floor((v or 0) * 127 + 0.5)
  if b < -127 then b = -127 elseif b > 127 then b = 127 end
  if b < 0 then b = b + 256 end
  return b
end
local function _light(kind, x, y, z, radius, r, g, b, intensity, dx, dy, cone)
  if _ln >= _LCAP then return end
  local base = _LB + 1 + _ln * 6
  pmem(base, x // 1)
  pmem(base + 1, y // 1)
  pmem(base + 2, z // 1)
  pmem(base + 3, radius // 1)
  local rgb = (math.floor(r or 255) & 0xff) << 16
  rgb = rgb | ((math.floor(g or 255) & 0xff) << 8)
  rgb = rgb | (math.floor(b or 255) & 0xff)
  pmem(base + 4, rgb | (kind << 24) | (cone << 26))
  local inten = math.floor((intensity or 1) * 256)
  if inten < 0 then inten = 0 elseif inten > 0xffff then inten = 0xffff end
  pmem(base + 5, inten | (dx << 16) | (dy << 24))
  _ln = _ln + 1
  pmem(_LB, _ln)
end
cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,
  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)
    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end
    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)
  end,
  camera = function(x, y)
    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)
    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)
  end,
  -- Drive the 3D mesh orbit camera this frame: yaw/pitch (radians), distance in
  -- world units (0 = auto-fit the scene), fov (radians, 0 = default). Call every
  -- frame; not calling leaves the player's gentle auto-orbit in charge.
  meshcam = function(yaw, pitch, dist, fov)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, 0)
    pmem(_MCB + 5, 0)
    pmem(_MCB + 6, 0)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's mesh-pose list. Call once before any meshpose() calls;
  -- instances you don't pose keep their authored transform.
  clearposes = function() _mn = 0 pmem(_MPB, 0) end,
  -- Move/rotate/scale one mesh instance (by its sidecar index) this frame, on top
  -- of its authored placement. x,y,z are world units; yaw,pitch,roll radians;
  -- scale defaults to 1 (pass 0 to hide). math.floor keeps every value integer so
  -- the bitwise mask never sees a float (the Pro core's Lua throws on that). Must
  -- match decodeMeshPoses() on the host.
  meshpose = function(index, x, y, z, yaw, pitch, roll, scale)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    pmem(base, math.floor(index or 0) & 0xff)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 5, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 6, math.floor((roll or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- HD-2D world (optional): a cart with a world sidecar draws a 3D tile terrain
  -- and stands its 2D character sprites in it as depth-sorted billboards. The
  -- world camera and billboards reuse the mesh camera/pose mailbox channels, so
  -- no engine change is needed — these are thin aliases with the world's naming.
  --
  -- Drive the world camera this frame: yaw/pitch (radians), distance (world units,
  -- 0 = auto-fit), fov (radians, 0 = default). Optional tx,ty,tz make the camera
  -- LOOK AT that point (grid x/z units, height units for y) so it follows the
  -- player; omit them (or pass 0,0,0) to frame the whole terrain. Same mailbox
  -- layout as meshcam (target rides at _MCB+4..6).
  worldcam = function(yaw, pitch, dist, fov, tx, ty, tz)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, math.floor((tx or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 5, math.floor((ty or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 6, math.floor((tz or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's billboard list. Call once before billboard() calls each
  -- frame (an alias of clearposes — they share the mesh-pose channel).
  clearbillboards = function() _mn = 0 pmem(_MPB, 0) end,
  -- Place billboard index (declared in the world sidecar) at world position
  -- (x,z grid units, y height units) this frame; scale defaults to 1 (0 hides).
  -- math.floor keeps every value integer so the bitwise mask never sees a float.
  billboard = function(index, x, y, z, scale)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    pmem(base, math.floor(index or 0) & 0xff)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, 0)
    pmem(base + 5, 0)
    pmem(base + 6, 0)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- Collision defaults: overridden by the injected layer when the cart has one,
  -- so cartbox.solid/mapsize are always safe to call (a cart with no collision
  -- layer simply sees every cell as non-solid).
  solid = function() return false end,
  mapsize = function() return 0, 0 end,
  -- Tile-flags default: overridden by the injected layer when the cart has one.
  flag = function() return false end,
}`;

/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
export function injectSdk(bytes: Uint8Array): Uint8Array {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}
