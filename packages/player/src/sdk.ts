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
cartbox = {
  unlock = function(id) _emit(1, _hash(id), 0) end,
  score = function(v) _emit(2, 0, v // 1) end,
  progress = function(id, v) _emit(3, _hash(id), v // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
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
    pmem(_LB, _ln)
  end,
}`;

/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
export function injectSdk(bytes: Uint8Array): Uint8Array {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}
