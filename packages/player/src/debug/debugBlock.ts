/**
 * The editor's debug channel (ENGINE_ROADMAP.md, Phase 5): a 4 KB block in the
 * console's free RAM, just below the runtime block (see physics/protocol.ts),
 * shared by the cart's Lua and the host.
 *
 * - Console: a prelude replaces `trace()` so each message lands in a ring here
 *   (the engine's own trace callback goes nowhere), and replaces
 *   `debug.traceback` — which the core calls on every runtime error — with one
 *   that names cart lines rather than lines of the merged, SDK-prefixed source
 *   and fits the core's 256-byte error buffer.
 * - The host writes a magic word and the cart's line offset before every tick,
 *   and drains the ring after it.
 *
 * Only the editor's playtest adds this prelude; a published cart never has it.
 * All words are little-endian int32.
 */

import { PHYS_BLOCK_BYTES, type RamLayout } from "../physics/protocol.js";

export const DEBUG_BLOCK_BYTES = 4096;
export const DEBUG_MAGIC = 0x47444243; // "CBDG"

// Host → Lua (written before each tick).
export const DBG_MAGIC = 0;
/** Lines of injected code above the cart's own (see codeLineOffset). */
export const DBG_LINE_OFFSET = 4;
// Lua → host.
/** Bytes of the trace ring in use; the host drains and zeroes it after each tick. */
export const DBG_TRACE_USED = 16;
/** Traces that didn't fit this tick. */
export const DBG_TRACE_DROPPED = 20;

/** The trace ring: entries of [length lo, length hi, colour, ...UTF-8 bytes]. */
export const DBG_TRACE_AT = 1024;
export const DBG_TRACE_BYTES = 1536;
/** Longest single trace kept (longer ones are cut). */
export const DBG_TRACE_MAX = 240;

/** Where the debug block sits in Lua's RAM address space. */
export function debugBlockAddress(layout: RamLayout): number {
  return layout.ramSize - PHYS_BLOCK_BYTES - DEBUG_BLOCK_BYTES;
}

/**
 * Lines of code above the cart's own in the source the engine runs: `final` is
 * the cart's code with preludes stacked on top (see prependLuaCode), so error
 * line N in the merged source is cart line N − offset. 0 when `final` doesn't end
 * with the cart's code (nothing was added, or it isn't Lua).
 */
export function codeLineOffset(original: string | null, final: string | null): number {
  if (original === null || final === null || final.length <= original.length || !final.endsWith(original)) return 0;
  const head = final.slice(0, final.length - original.length);
  let lines = 0;
  for (let i = 0; i < head.length; i += 1) if (head.charCodeAt(i) === 10) lines += 1;
  return lines;
}

/**
 * Rewrite the core's `[string "…"]:N:` positions to cart lines (`line N:`); a
 * position inside the injected code (N ≤ offset) becomes `cartbox:`, since it
 * has no cart line. Positions the debug prelude already rewrote are left alone.
 */
export function remapErrorLines(message: string, offset: number): string {
  return message.replace(/\[string "[^"]*"\]:(\d+):/g, (_all, n: string) => {
    const line = Number(n) - offset;
    return line > 0 ? `line ${line}:` : "cartbox:";
  });
}

/** One frame of a runtime error's call stack, innermost first. */
export interface ErrorFrame {
  readonly name: string;
  readonly line: number;
}

/**
 * The call stack the debug prelude appends to an error (`at update:12 < TIC:40`),
 * innermost first; empty when the message carries none.
 */
export function errorStack(message: string): ErrorFrame[] {
  const at = /\nat (.*)$/m.exec(message);
  if (!at) return [];
  const frames: ErrorFrame[] = [];
  for (const part of at[1]!.split(" < ")) {
    const m = /^(.*):(\d+)$/.exec(part.trim());
    if (m) frames.push({ name: m[1]!, line: Number(m[2]) });
  }
  return frames;
}

/** The prelude for the playtest: trace capture and cart-line tracebacks, over the block at `address`. */
export function debugSdkLua(address: number): string {
  return `do
  local _B = ${address}
  local function _rd(a)
    local v = peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24)
    if v >= 0x80000000 then v = v - 0x100000000 end
    return v
  end
  local function _wr(a, v)
    v = math.floor(v) & 0xffffffff
    poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff)
  end
  local function _live() return _rd(_B + ${DBG_MAGIC}) == ${DEBUG_MAGIC} end
  local _trace = trace
  trace = function(msg, color)
    if _trace then _trace(msg, color) end
    if not _live() then return end
    local s = tostring(msg)
    if #s > ${DBG_TRACE_MAX} then s = s:sub(1, ${DBG_TRACE_MAX}) end
    local used = _rd(_B + ${DBG_TRACE_USED})
    if used < 0 or used + 3 + #s > ${DBG_TRACE_BYTES} then
      _wr(_B + ${DBG_TRACE_DROPPED}, _rd(_B + ${DBG_TRACE_DROPPED}) + 1)
      return
    end
    local a = _B + ${DBG_TRACE_AT} + used
    poke(a, #s & 0xff) poke(a + 1, #s >> 8) poke(a + 2, (math.tointeger(color) or 15) & 0xff)
    for i = 1, #s do poke(a + 2 + i, s:byte(i)) end
    _wr(_B + ${DBG_TRACE_USED}, used + 3 + #s)
  end
  -- The core passes every runtime error through debug.traceback. Name cart
  -- lines, and keep it short: the core keeps only 256 bytes of it.
  local _src = debug.getinfo(1, "S").source
  local _tb = debug.traceback
  debug.traceback = function(msg, ...)
    if type(msg) ~= "string" and msg ~= nil then return _tb(msg, ...) end
    local off = _live() and _rd(_B + ${DBG_LINE_OFFSET}) or 0
    local function cart(n)
      n = tonumber(n) - off
      return n > 0 and n or nil
    end
    msg = tostring(msg or ""):gsub('^%[string "[^"]*"%]:(%d+):', function(n)
      local l = cart(n)
      return l and ("line " .. l .. ":") or "cartbox:"
    end)
    -- A function the core calls (TIC, BDR ...) has no name Lua can see: look it up.
    local function name(info)
      if info.name then return info.name end
      if info.what == "main" then return "main" end
      for k, v in pairs(_G) do
        if v == info.func and type(k) == "string" then return k end
      end
      return "?"
    end
    local frames = {}
    for level = 2, 40 do
      local info = debug.getinfo(level, "Slnf")
      if not info then break end
      if info.source == _src and info.currentline and info.currentline > 0 then
        local l = cart(info.currentline)
        if l then frames[#frames + 1] = name(info) .. ":" .. l end
      end
      if #frames >= 6 then break end
    end
    if #frames > 0 then msg = msg .. "\\nat " .. table.concat(frames, " < ") end
    return msg
  end
end`;
}

/** A trace the cart printed. */
export interface TraceLine {
  readonly text: string;
  readonly color: number;
}

/**
 * Take this tick's traces out of the block and empty the ring. `dropped` counts
 * traces that didn't fit (the ring holds {@link DBG_TRACE_BYTES} per tick).
 */
export function drainTraces(block: DataView): { traces: TraceLine[]; dropped: number } {
  const used = Math.min(block.getInt32(DBG_TRACE_USED, true), DBG_TRACE_BYTES);
  const dropped = block.getInt32(DBG_TRACE_DROPPED, true);
  const traces: TraceLine[] = [];
  if (used > 0) {
    const decoder = new TextDecoder();
    let at = 0;
    while (at + 3 <= used) {
      const length = block.getUint16(DBG_TRACE_AT + at, true);
      const color = block.getUint8(DBG_TRACE_AT + at + 2);
      const start = DBG_TRACE_AT + at + 3;
      if (at + 3 + length > used) break;
      traces.push({ text: decoder.decode(new Uint8Array(block.buffer, block.byteOffset + start, length)), color });
      at += 3 + length;
    }
  }
  if (used !== 0) block.setInt32(DBG_TRACE_USED, 0, true);
  if (dropped !== 0) block.setInt32(DBG_TRACE_DROPPED, 0, true);
  return { traces, dropped: Math.max(0, dropped) };
}

/** Arm the block for the next tick: magic and the cart's line offset. */
export function armDebugBlock(block: DataView, lineOffset: number): void {
  block.setUint32(DBG_MAGIC, DEBUG_MAGIC, true);
  block.setInt32(DBG_LINE_OFFSET, lineOffset, true);
}
