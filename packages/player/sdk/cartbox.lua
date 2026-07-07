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
-- set every frame — clear, then add up to 6 lights. x,y are framebuffer pixels,
-- radius is the reach in pixels; r,g,b default to white (0..255); z is the
-- light's height (default 12) and intensity scales its brightness (default 1).
--
--   function TIC()
--     cartbox.clearlights()
--     cartbox.light(px, py, 90, 255, 180, 90)         -- a warm torch on the player
--     cartbox.light(200, 40, 60, 120, 200, 255, 14, 1.4) -- a bright cool lamp
--   end

local _MB = 192   -- pmem word: mailbox base (event sequence counter)
local _CAP = 8    -- event ring capacity (must match the host)
local _LB = _MB + 25 -- pmem word: light-count header (must match the host)
local _LCAP = 6   -- maximum lights per frame (must match the host)
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

cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,

  -- Start a fresh frame's light list. Call once at the top of TIC().
  clearlights = function()
    _ln = 0
    pmem(_LB, 0)
  end,

  -- Add one light for this frame (up to 6). Extra calls are ignored.
  light = function(x, y, radius, r, g, b, z, intensity)
    if _ln >= _LCAP then return end
    local base = _LB + 1 + _ln * 6
    pmem(base, x // 1)
    pmem(base + 1, y // 1)
    pmem(base + 2, (z or 12) // 1)
    pmem(base + 3, radius // 1)
    local rr = (r or 255) & 0xff
    local gg = (g or 255) & 0xff
    local bb = (b or 255) & 0xff
    pmem(base + 4, (rr << 16) | (gg << 8) | bb)
    pmem(base + 5, ((intensity or 1) * 256) // 1)
    _ln = _ln + 1
    pmem(_LB, _ln) -- publish the count last
  end,
}
