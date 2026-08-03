-- Cartbox SDK — emit platform events and dynamic lights to the host.
--
-- Include this at the top of your cart, or let the platform inject it for you.
-- It writes into a reserved slice of persistent memory (pmem words 192..255);
-- the host reads it each frame. Your cart may still use pmem words 0..191 for
-- its own save data.
--
--   cartbox.unlock("first_blood")      -- fire an achievement
--   cartbox.score(4200)                -- post to the leaderboard
--   cartbox.progress("distance", 120)  -- update a stat
--
-- Dynamic lights (needs the player mounted with `lighting`): rebuild the light
-- set every frame — clear, then add up to 6 lights of any kind. r,g,b default to
-- white (0..255) and intensity scales brightness (default 1) for all of them.
--
--   cartbox.light(x, y, radius, r, g, b, z, intensity)
--       An omnidirectional pool. x,y are framebuffer pixels, radius is the reach
--       in pixels, z is the light's height (default 12).
--   cartbox.sun(dx, dy, dz, r, g, b, intensity)
--       A distant directional key (sun/moon). dx,dy,dz point TOWARD the light
--       (it should sit on the viewer's side, dz > 0); there is no position or
--       falloff, so it lights the whole frame evenly.
--   cartbox.spot(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)
--       A cone from (x,y,z) shining along dx,dy,dz. `angle` is the inner
--       half-angle in degrees (feathered to zero just past it).
--
--   function TIC()
--     cartbox.clearlights()
--     cartbox.sun(-0.4, -0.6, 0.7, 120, 140, 210, 0.9)   -- cool moon key
--     cartbox.light(px, py, 90, 255, 180, 90)            -- a warm torch on the player
--     cartbox.spot(200, 20, 40, 0.2, 1, 0.3, 140, 22, 255, 210, 150) -- a lamp cone
--   end
--
-- Parallax backdrop camera (needs the cart mounted with a `scene`): publish where
-- the backdrop should look each frame so it pans with gameplay instead of only
-- auto-scrolling. x,y are in cart pixels and are ADDED to the scene's own
-- auto-scroll; nearer layers move more (their parallax factor scales this).
--
--   cartbox.camera(worldX, 0)   -- backdrop follows the player's world position

local _MB = 192   -- pmem word: mailbox base (event sequence counter)
local _CAP = 8    -- event ring capacity (must match the host)
local _LB = _MB + 25 -- pmem word: light-count header (must match the host)
local _LCAP = 6   -- maximum lights per frame (must match the host)
local _CB = _LB + 1 + _LCAP * 6 -- pmem word: backdrop camera x (must match the host)
local _ln = 0     -- lights written since the last clearlights()

local function _emit(kind, id, value)
  local seq = pmem(_MB)
  local slot = seq % _CAP
  local base = _MB + 1 + slot * 3
  pmem(base, kind)
  pmem(base + 1, id)
  pmem(base + 2, value)
  pmem(_MB, seq + 1) -- publish last, so the host never sees a partial event
end

-- FNV-1a 32-bit hash; must match hashEventId() on the host.
local function _hash(s)
  local h = 2166136261
  for i = 1, #s do
    h = ((h ~ string.byte(s, i)) * 16777619) & 0xffffffff
  end
  return h
end

-- Normalize a vector, defaulting to facing the camera when it is degenerate.
local function _norm(x, y, z)
  local m = math.sqrt(x * x + y * y + z * z)
  if m < 1e-6 then return 0, 0, 1 end
  return x / m, y / m, z / m
end

-- Pack a direction component (-1..1) as an unsigned byte (host re-signs it).
-- math.floor keeps it an integer so the bitwise packing below never sees a float
-- (the Pro core's Lua throws on bitwise-of-float).
local function _byte(v)
  local b = math.floor((v or 0) * 127 + 0.5)
  if b < -127 then b = -127 elseif b > 127 then b = 127 end
  if b < 0 then b = b + 256 end
  return b
end

-- Shared writer for all three light kinds. Directional/spot extras ride in the
-- bits a point light leaves zero (kind + cone in word[4], direction in word[5]),
-- so the record stays 6 words wide and old carts keep working. Must match
-- decodeLights() on the host (mailbox.ts).
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
  pmem(_LB, _ln) -- publish the count last
end

cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,

  -- Start a fresh frame's light list. Call once at the top of TIC().
  clearlights = function()
    _ln = 0
    pmem(_LB, 0)
  end,

  -- An omnidirectional point light (up to 6 lights total per frame).
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,

  -- A distant directional key. dx,dy,dz point TOWARD the light (dz > 0).
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,

  -- A cone from (x,y,z) shining along dx,dy,dz; `angle` = inner half-angle (deg).
  spot = function(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    local cone = math.floor(math.cos(math.rad(angle or 30)) * 63 + 0.5)
    if cone < 0 then cone = 0 elseif cone > 63 then cone = 63 end
    _light(2, x, y, z or 12, radius, r, g, b, intensity, _byte(nx), _byte(ny), cone)
  end,

  -- Publish the parallax backdrop camera for this frame (scene carts only). x,y
  -- are cart pixels, stored as signed fixed-point (× 16). math.floor keeps the
  -- value integer so the mask never sees a float (the Pro core's Lua throws on
  -- bitwise-of-float). Must match decodeCamera() on the host (mailbox.ts).
  camera = function(x, y)
    pmem(_CB, math.floor((x or 0) * 16 + 0.5) & 0xffffffff)
    pmem(_CB + 1, math.floor((y or 0) * 16 + 0.5) & 0xffffffff)
  end,
}
