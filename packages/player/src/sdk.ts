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
  -- request(kind, value): ask the host page for something it provides (e.g. a
  -- page's matchmaking); kind and value are numbers the page defines.
  request = function(kind, value) _emit(4, (kind or 0) // 1, (value or 0) // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,
  -- light3d(x, y, z, radius, r, g, b, intensity): a point light in a 3D scene's
  -- world units (signed, fractional), lighting a first-person mesh view -- the
  -- 2D relight ignores it. E.g. a glow over an objective.
  light3d = function(x, y, z, radius, r, g, b, intensity)
    _light(3, (x or 0) * 64, (y or 0) * 64, (z or 0) * 64, (radius or 4) * 64, r, g, b, intensity, 0, 0, 0)
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
  -- First-person mode: composite the cart's 2D frame as a HUD OVER the 3D scene,
  -- rather than drawing the meshes over the 2D (the default third-person showcase
  -- compositing). Call each frame AFTER the camera call with a truthy value to
  -- enable; near-black (index 0) pixels the cart leaves are the transparent "world"
  -- and everything else the cart draws is the HUD. Rides a spare bit of the
  -- mesh-camera flag word, so it costs no mailbox space.
  hud = function(on)
    local f = pmem(_MCB)
    if on and on ~= 0 then pmem(_MCB, f | 2) else pmem(_MCB, f & 0xfffffffd) end
  end,
  -- Move/rotate/scale one mesh instance (by its sidecar index) this frame, on top
  -- of its authored placement. x,y,z are world units; yaw (about Y), pitch (about
  -- X), roll (about Z) radians;
  -- scale defaults to 1 (pass 0 to hide). math.floor keeps every value integer so
  -- the bitwise mask never sees a float (the Pro core's Lua throws on that). Must
  -- match decodeMeshPoses() on the host.
  -- Optional extras: frame picks one of the instance's animation frames (0 = its
  -- base mesh, up to 127), tint recolours its tintable materials from the
  -- 15-colour tint palette (0 = none), and front (true/1) draws it over the
  -- whole scene — a held weapon that must never clip into a wall.
  meshpose = function(index, x, y, z, yaw, pitch, roll, scale, frame, tint, front)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    local word = math.floor(index or 0) & 0xff
    word = word | ((math.floor(frame or 0) & 0x7f) << 9) | ((math.floor(tint or 0) & 0xf) << 16)
    if front and front ~= 0 then word = word | 0x100000 end
    pmem(base, word)
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
  -- stick(n) -> x, y: analog stick n (0 left, 1 right), each -1..1, y down-
  -- positive. Reads 0,0 with no sticks (keyboard); on a touchscreen the pad
  -- shows its right stick once a cart calls this. Uses pmem 68..69.
  stick = function(n)
    if pmem(69) ~= 0x53544b31 then pmem(69, 0x53544b31) end
    local w = pmem(68)
    local sh = (n == 1) and 16 or 0
    local x, y = (w >> sh) & 0xff, (w >> (sh + 8)) & 0xff
    if x >= 128 then x = x - 256 end
    if y >= 128 then y = y - 256 end
    return x / 127, y / 127
  end,
  -- Netplay (online multiplayer). The host page relays player state + events
  -- between browsers through pmem words 0..118 (so a netplay cart must not keep
  -- save data there); see packages/player/src/net/netplay.ts for the layout.
  -- net() -> mode (0 offline, 1 client, 2 host), my slot, humans mask, match word,
  -- and the page's status code (0 idle; the page defines the rest, e.g. searching)
  net = function()
    local h = pmem(0)
    return h & 3, (h >> 2) & 7, (h >> 8) & 0xff, pmem(1), (h >> 5) & 7
  end,
  -- netpeer(slot) -> the slot's 3 state words, and whether they are live
  netpeer = function(slot)
    local b = 3 + slot * 3
    return pmem(b), pmem(b + 1), pmem(b + 2), ((pmem(0) >> 16) & (1 << slot)) ~= 0
  end,
  -- netpublish(slot, a, b, c): publish a slot's state this tick (your own, or a
  -- bot's when you are the host)
  netpublish = function(slot, a, b, c)
    local base = 72 + slot * 3
    pmem(base, math.floor(a or 0) & 0xffffffff)
    pmem(base + 1, math.floor(b or 0) & 0xffffffff)
    pmem(base + 2, math.floor(c or 0) & 0xffffffff)
    pmem(70, pmem(70) | (1 << slot))
  end,
  -- netmatch(word): the host's shared game-state word (clients read it via net())
  netmatch = function(w) pmem(71, math.floor(w or 0) & 0xffffffff) end,
  -- netsend(a, b): broadcast a 2-word event to every other player (≤ 10/tick)
  netsend = function(a, b)
    local n = pmem(96)
    if n >= 10 then return false end
    pmem(97 + n * 2, math.floor(a or 0) & 0xffffffff)
    pmem(98 + n * 2, math.floor(b or 0) & 0xffffffff)
    pmem(96, n + 1)
    return true
  end,
  -- netevents() -> this tick's incoming events, as a list of {a, b}
  netevents = function()
    local n = pmem(27)
    local out = {}
    for i = 0, n - 1 do out[#out + 1] = { pmem(28 + i * 2), pmem(29 + i * 2) } end
    return out
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
