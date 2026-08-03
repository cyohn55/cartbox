/**
 * The cartbox SDK as an injectable string.
 *
 * Kept in sync with sdk/cartbox.lua (that file is the copy creators read/import;
 * this string is what the platform injects into carts that opt in). Both must
 * agree with the mailbox protocol in mailbox.ts (base word 192, event ring
 * capacity 8, lights block at word 217, event types 1/2/3, FNV-1a id hash).
 */

import { prependLuaCode } from "./cartseed.js";

/** Lua source of the cartbox SDK. */
export const CARTBOX_SDK_LUA = `local _MB = 192
local _CAP = 8
local _LB = _MB + 25
local _LCAP = 6
local _CB = _LB + 1 + _LCAP * 6
local _ln = 0
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
}`;

/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
export function injectSdk(bytes: Uint8Array): Uint8Array {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}
