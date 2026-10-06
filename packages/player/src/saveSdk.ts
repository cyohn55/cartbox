/**
 * Save data (ENGINE_PARITY_ROADMAP.md EP15b): a cart saves one Lua table and
 * gets it back next time —
 *
 *   cartbox.save(t)   -> true, or false and why ("too big", "can't save a function")
 *   cartbox.load()    -> the table last saved (in this session or an earlier one), or nil
 *   cartbox.erase()   forget it
 *
 * A table saves as JSON: numbers, strings, booleans and tables of them (a
 * table with keys 1..n is a list; any other keys are kept as strings).
 *
 * The saved text reaches the cart in its code (a prelude the player writes at
 * load), so load() works from the first line. A save goes the other way
 * through a block of the console's free RAM just below the input block (see
 * actionsSdk.ts) —
 *
 *   +0 magic ("CBSV", the host's)   +4 pending (the cart's: 1 saved, 2 erased)   +8 length   +12 the JSON
 *
 * — which the host reads after any tick that left something pending, clears,
 * and keeps (in the browser, and in the player's account when signed in).
 * Nothing in the block has to last past the tick it was written in: Classic's
 * core clears that RAM between frames. The block is
 * 16 KB on the larger cores and 448 bytes on Classic, whose free RAM is a few
 * hundred bytes.
 */

import { inputBlockAddress } from "./actionsSdk.js";
import type { RamLayout } from "./physics/protocol.js";

export const SAVE_MAGIC = 0x56534243; // "CBSV"
export const SAVE_PENDING = 4;
export const SAVE_SAVED = 1;
export const SAVE_ERASED = 2;
export const SAVE_LENGTH = 8;
export const SAVE_DATA = 12;

/** The save block's size on a core: what its free RAM affords. */
export function saveBlockBytes(layout: RamLayout): number {
  return layout.ramSize <= 98304 ? 448 : 16384;
}

/** The most JSON a save can hold on a core. */
export function saveCapacity(layout: RamLayout): number {
  return saveBlockBytes(layout) - SAVE_DATA;
}

/** Where the save block sits in Lua's RAM address space. */
export function saveBlockAddress(layout: RamLayout): number {
  return inputBlockAddress(layout) - saveBlockBytes(layout);
}

/** Mark the block as watched (before each tick). */
export function armSaveBlock(block: DataView): void {
  block.setUint32(0, SAVE_MAGIC, true);
}

/**
 * Take what the cart left in the block this tick, clearing it: `{ data }` with
 * the saved JSON, or `{ data: null }` for an erase; null when nothing is
 * pending (or a save doesn't hold valid JSON, which is dropped).
 */
export function takeSave(block: DataView): { data: string | null } | null {
  const pending = block.getUint32(SAVE_PENDING, true);
  if (pending === 0) return null;
  block.setUint32(SAVE_PENDING, 0, true);
  if (pending === SAVE_ERASED) return { data: null };
  if (pending !== SAVE_SAVED) return null;
  const length = block.getUint32(SAVE_LENGTH, true);
  if (length === 0 || length > block.byteLength - SAVE_DATA) return null;
  const text = new TextDecoder().decode(new Uint8Array(block.buffer, block.byteOffset + SAVE_DATA, length).slice());
  const data = validSave(text);
  return data ? { data } : null;
}

/** `text` when it's a JSON object or list (what a save is), else null. */
export function validSave(text: string | null | undefined): string | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" ? text : null;
  } catch {
    return null;
  }
}

const luaLong = (s: string): string => {
  // A long bracket the text can't close early.
  let eq = "";
  while (s.includes(`]${eq}]`)) eq += "=";
  return `[${eq}[${s}]${eq}]`;
};

/** The `cartbox.save/load/erase` Lua for a core, with the save to start from (or null). */
export function saveSdkLua(layout: RamLayout, saved: string | null | undefined): string {
  const start = validSave(saved);
  return `do
local _S, _CAP = ${saveBlockAddress(layout)}, ${saveCapacity(layout)}
local saved = ${start ? luaLong(start) : "nil"}
local function wr(a, v) poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff) end
local ESC = { ['"'] = '\\\\"', ['\\\\'] = '\\\\\\\\', ['\\b'] = '\\\\b', ['\\f'] = '\\\\f', ['\\n'] = '\\\\n', ['\\r'] = '\\\\r', ['\\t'] = '\\\\t' }
local function enc(v, out, depth)
  local t = type(v)
  if depth > 32 then error("nested too deep", 0) end
  if v == nil then out[#out + 1] = "null"
  elseif t == "boolean" then out[#out + 1] = v and "true" or "false"
  elseif t == "number" then
    if v ~= v or v == math.huge or v == -math.huge then out[#out + 1] = "null"
    elseif math.type(v) == "integer" then out[#out + 1] = string.format("%d", v)
    else out[#out + 1] = string.format("%.14g", v) end
  elseif t == "string" then
    out[#out + 1] = '"' .. v:gsub('[%c"\\\\]', function(c) return ESC[c] or string.format("\\\\u%04x", c:byte()) end) .. '"'
  elseif t == "table" then
    local n = #v
    local list = n > 0
    if list then for k in pairs(v) do if math.type(k) ~= "integer" or k < 1 or k > n then list = false break end end end
    if list then
      out[#out + 1] = "["
      for i = 1, n do if i > 1 then out[#out + 1] = "," end enc(v[i], out, depth + 1) end
      out[#out + 1] = "]"
    else
      out[#out + 1] = "{"
      local first = true
      for k, x in pairs(v) do
        local kt = type(k)
        if kt ~= "string" and kt ~= "number" then error("can't save a " .. kt .. " key", 0) end
        if not first then out[#out + 1] = "," end
        first = false
        enc(tostring(k), out, depth + 1)
        out[#out + 1] = ":"
        enc(x, out, depth + 1)
      end
      out[#out + 1] = "}"
    end
  else error("can't save a " .. t, 0) end
end
local function dec(s)
  local i = 1
  local function ws() i = s:find("[^ \\t\\r\\n]", i) or #s + 1 end
  local value
  local function str()
    local out, j = {}, i + 1
    while true do
      local c = s:sub(j, j)
      if c == "" then error("bad save", 0) end
      if c == '"' then i = j + 1 return table.concat(out) end
      if c == "\\\\" then
        local e = s:sub(j + 1, j + 1)
        local map = { b = "\\b", f = "\\f", n = "\\n", r = "\\r", t = "\\t" }
        if e == "u" then out[#out + 1] = utf8.char(tonumber(s:sub(j + 2, j + 5), 16) or 63) j = j + 6
        else out[#out + 1] = map[e] or e j = j + 2 end
      else out[#out + 1] = c j = j + 1 end
    end
  end
  value = function(depth)
    if depth > 32 then error("bad save", 0) end
    ws()
    local c = s:sub(i, i)
    if c == "{" then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == "}" then i = i + 1 return t end
      while true do
        ws()
        if s:sub(i, i) ~= '"' then error("bad save", 0) end
        local k = str()
        ws()
        if s:sub(i, i) ~= ":" then error("bad save", 0) end
        i = i + 1
        t[k] = value(depth + 1)
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "}" then return t elseif d ~= "," then error("bad save", 0) end
      end
    elseif c == "[" then
      local t = {}
      i = i + 1 ws()
      if s:sub(i, i) == "]" then i = i + 1 return t end
      while true do
        t[#t + 1] = value(depth + 1)
        ws()
        local d = s:sub(i, i)
        i = i + 1
        if d == "]" then return t elseif d ~= "," then error("bad save", 0) end
      end
    elseif c == '"' then return str()
    elseif s:sub(i, i + 3) == "true" then i = i + 4 return true
    elseif s:sub(i, i + 4) == "false" then i = i + 5 return false
    elseif s:sub(i, i + 3) == "null" then i = i + 4 return nil
    else
      local num = s:match("^-?%d+%.?%d*[eE]?[-+]?%d*", i)
      if not num or num == "" then error("bad save", 0) end
      i = i + #num
      return math.tointeger(tonumber(num)) or tonumber(num)
    end
  end
  return value(0)
end
local function publish(text)
  local n = #text
  for k = 1, n do poke(_S + ${SAVE_DATA} + k - 1, text:byte(k)) end
  wr(_S + ${SAVE_LENGTH}, n)
  wr(_S + ${SAVE_PENDING}, n > 0 and ${SAVE_SAVED} or ${SAVE_ERASED})
end
cartbox.save = function(t)
  if type(t) ~= "table" then return false, "save a table" end
  local out = {}
  local ok, err = pcall(enc, t, out, 0)
  if not ok then return false, err end
  local text = table.concat(out)
  if #text > _CAP then return false, "too big" end
  saved = text
  publish(text)
  return true
end
cartbox.load = function()
  if not saved then return nil end
  local ok, t = pcall(dec, saved)
  if ok and type(t) == "table" then return t end
  return nil
end
cartbox.erase = function()
  saved = nil
  publish("")
end
end`;
}
