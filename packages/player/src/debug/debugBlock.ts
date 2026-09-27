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
 * - Debugger: with the cart's code instrumented (see instrument.ts), `TIC` runs
 *   in a coroutine and the statement hooks yield at a breakpoint or a step. The
 *   Lua then writes where it stopped — the call stack, the paused function's
 *   locals and upvalues, and the watch expressions' values — and the host
 *   stops ticking until it writes a command (continue, step into/over/out).
 * - The host writes a magic word, the cart's line offset and line count, the
 *   breakpoints and the watch expressions before every tick, and reads the
 *   traces and any pause after it.
 *
 * Only the editor's playtest adds this prelude; a published cart never has it.
 * All words are little-endian int32.
 */

import { PHYS_BLOCK_BYTES, type RamLayout } from "../physics/protocol.js";
import { BREAK_HOOK } from "./instrument.js";

export const DEBUG_BLOCK_BYTES = 4096;
export const DEBUG_MAGIC = 0x47444243; // "CBDG"

// Host → Lua (written before each tick).
export const DBG_MAGIC = 0;
/** Lines of injected code above the cart's own (see codeLineOffset). */
export const DBG_LINE_OFFSET = 4;
/** 1 while the cart is stopped at a breakpoint (Lua sets it; resuming clears it). */
export const DBG_STATE = 8;
/** The host's command to a stopped cart: see {@link DebugCommand}. Lua zeroes it once taken. */
export const DBG_COMMAND = 12;
// Lua → host.
/** Bytes of the trace ring in use; the host drains and zeroes it after each tick. */
export const DBG_TRACE_USED = 16;
/** Traces that didn't fit this tick. */
export const DBG_TRACE_DROPPED = 20;
/** The cart line the cart is stopped at. */
export const DBG_PAUSED_LINE = 24;
// Host → Lua.
/** Bumped by the host whenever the breakpoint list changes. */
export const DBG_BP_VERSION = 28;
export const DBG_BP_COUNT = 32;
/** Lines in the cart's own code: positions past it are the injected code after it. */
export const DBG_LINE_COUNT = 36;
// Lua → host.
/** Bytes of pause information written. */
export const DBG_INFO_LENGTH = 40;
// Host → Lua.
/** Bytes of watch expressions written. */
export const DBG_WATCH_LENGTH = 44;

/** Breakpoint lines, int32 each. */
export const DBG_BPS_AT = 64;
export const DBG_BPS_MAX = 240;
/** The trace ring: entries of [length lo, length hi, colour, ...UTF-8 bytes]. */
export const DBG_TRACE_AT = 1024;
export const DBG_TRACE_BYTES = 1024;
/** Longest single trace kept (longer ones are cut). */
export const DBG_TRACE_MAX = 240;
/** Watch expressions, one per line (UTF-8). */
export const DBG_WATCH_AT = 2048;
export const DBG_WATCH_BYTES = 512;
/** Where the cart stopped, as lines: `S name:line`, `L name=value`, `U name=value`, `W index=value` (or `W index!error`). */
export const DBG_INFO_AT = 2560;
export const DBG_INFO_BYTES = 1536;

/** Commands to a stopped cart. 5 re-reads the pause information (after the watches change) without moving on. */
export const DebugCommand = { continue: 1, into: 2, over: 3, out: 4, refresh: 5 } as const;
export type DebugStep = Exclude<keyof typeof DebugCommand, "refresh">;

/** Where the debug block sits in Lua's RAM address space. */
export function debugBlockAddress(layout: RamLayout): number {
  return layout.ramSize - PHYS_BLOCK_BYTES - DEBUG_BLOCK_BYTES;
}

/**
 * Lines of code above the cart's own in the source the engine runs: `final` is
 * the cart's code with preludes stacked on top (see prependLuaCode) and perhaps
 * a postlude after it, so error line N in the merged source is cart line
 * N − offset. 0 when `final` doesn't contain the cart's code past its start
 * (nothing was added, or it isn't Lua).
 */
export function codeLineOffset(original: string | null, final: string | null): number {
  if (!original || final === null || final.length <= original.length) return 0;
  const at = final.lastIndexOf(original);
  if (at <= 0) return 0;
  const head = final.slice(0, at);
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

/**
 * The prelude for the playtest, over the block at `address`: trace capture and
 * cart-line tracebacks, and with `debugger` the breakpoint machinery the
 * instrumented code calls (pair it with {@link debugPostlude}).
 */
export function debugSdkLua(address: number, options: { debugger?: boolean } = {}): string {
  const dbg = options.debugger === true;
  return `${dbg ? `local ${BREAK_HOOK}, __cbx_run\n` : ""}do
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
  local _src = debug.getinfo(1, "S").source
  -- A cart line for a line of the merged source, or nil inside the injected code.
  local function _cart(n)
    local off = _live() and _rd(_B + ${DBG_LINE_OFFSET}) or 0
    local count = _live() and _rd(_B + ${DBG_LINE_COUNT}) or 0
    n = tonumber(n) - off
    if n < 1 or (count > 0 and n > count) then return nil end
    return n
  end
  local _tic = nil -- the cart's own TIC, once the debugger wraps it
  -- A function the core calls (TIC, BDR ...) has no name Lua can see: look it up.
  local function _name(info)
    if info.name then return info.name end
    if info.what == "main" then return "main" end
    if _tic and info.func == _tic then return "TIC" end
    for k, v in pairs(_G) do
      if v == info.func and type(k) == "string" then return k end
    end
    return "?"
  end
  -- The cart frames of a stack, innermost first: {name, line, level}.
  local function _frames(co, max)
    local out = {}
    for level = co and 0 or 2, 60 do
      local info
      if co then info = debug.getinfo(co, level, "Slnf") else info = debug.getinfo(level, "Slnf") end
      if not info then break end
      if info.source == _src and info.currentline and info.currentline > 0 then
        local l = _cart(info.currentline)
        if l then out[#out + 1] = { name = _name(info), line = l, level = level, func = info.func } end
      end
      if #out >= max then break end
    end
    return out
  end
  -- The core passes every runtime error through debug.traceback. Name cart
  -- lines, and keep it short: the core keeps only 256 bytes of it.
  local _tb = debug.traceback
  local function _traceback(co, msg)
    msg = tostring(msg or ""):gsub('^%[string "[^"]*"%]:(%d+):', function(n)
      local l = _cart(n)
      return l and ("line " .. l .. ":") or "cartbox:"
    end)
    local parts = {}
    for _, f in ipairs(_frames(co, 6)) do parts[#parts + 1] = f.name .. ":" .. f.line end
    if #parts > 0 then msg = msg .. "\\nat " .. table.concat(parts, " < ") end
    return msg
  end
  debug.traceback = function(msg, ...)
    if type(msg) ~= "string" and msg ~= nil then return _tb(msg, ...) end
    return _traceback(nil, msg)
  end${dbg ? debuggerLua() : ""}
end`;
}

/** The debugger half of the prelude (inside its do-block, after the shared helpers). */
function debuggerLua(): string {
  return `
  local _bps, _bpver, _armed = {}, -1, false
  local _step, _depth = 0, 0 -- step: 1 into, 2 over, 3 out
  local _co = nil
  local function _stackdepth()
    local d = 0
    for level = 2, 250 do
      local info = debug.getinfo(level, "S")
      if not info then break end
      if info.source == _src then d = d + 1 end
    end
    return d
  end
  local function _loadbps()
    local v = _rd(_B + ${DBG_BP_VERSION})
    if v == _bpver then return end
    _bpver = v
    _bps = {}
    for i = 0, math.min(_rd(_B + ${DBG_BP_COUNT}), ${DBG_BPS_MAX}) - 1 do _bps[_rd(_B + ${DBG_BPS_AT} + i * 4)] = true end
  end
  ${BREAK_HOOK} = function(line)
    if not _armed then return end
    local stop = _bps[line]
    if not stop then
      if _step == 1 then stop = true
      elseif _step == 2 then stop = _stackdepth() <= _depth
      elseif _step == 3 then stop = _stackdepth() < _depth end
    end
    if not stop or not coroutine.isyieldable() then return end
    _depth = _stackdepth()
    _step = 0
    _wr(_B + ${DBG_PAUSED_LINE}, line)
    _wr(_B + ${DBG_STATE}, 1)
    coroutine.yield()
    local cmd = _rd(_B + ${DBG_COMMAND})
    _wr(_B + ${DBG_COMMAND}, 0)
    _wr(_B + ${DBG_STATE}, 0)
    _step = (cmd == ${DebugCommand.into} and 1) or (cmd == ${DebugCommand.over} and 2) or (cmd == ${DebugCommand.out} and 3) or 0
    _armed = _step ~= 0 or next(_bps) ~= nil
  end
  local function _fmt(v, deep)
    local t = type(v)
    if t == "string" then
      if #v > 40 then v = v:sub(1, 40) .. "..." end
      return (string.format("%q", v):gsub("\\n", "n"))
    elseif t == "number" then
      return math.type(v) == "integer" and tostring(v) or string.format("%.4g", v)
    elseif t == "table" then
      if deep then return "{...}" end
      local parts, n = {}, 0
      for k, x in pairs(v) do
        n = n + 1
        if n <= 4 then parts[#parts + 1] = (type(k) == "string" and k or ("[" .. tostring(k) .. "]")) .. "=" .. _fmt(x, true) end
      end
      return "{" .. table.concat(parts, ", ") .. (n > 4 and (", ... " .. n .. " in all") or "") .. "}"
    elseif t == "function" then
      return "function"
    end
    return tostring(v)
  end
  local function _show(v)
    local ok, s = pcall(_fmt, v)
    s = ok and s or "?"
    return #s > 90 and (s:sub(1, 90) .. "...") or s
  end
  -- Write where the cart stopped: its stack, the stopped function's locals and
  -- upvalues, and each watch expression's value there.
  local function _writeinfo(co)
    local lines = {}
    local frames = _frames(co, 8)
    for _, f in ipairs(frames) do lines[#lines + 1] = "S " .. f.name .. ":" .. f.line end
    local top = frames[1]
    local scope = {}
    if top then
      for i = 1, 200 do
        local k, v = debug.getlocal(co, top.level, i)
        if not k then break end
        if k:sub(1, 1) ~= "(" then scope[k] = { v }; lines[#lines + 1] = "L " .. k .. "=" .. _show(v) end
      end
      for i = 1, 60 do
        local k, v = debug.getupvalue(top.func, i)
        if not k then break end
        if k ~= "_ENV" and k ~= "${BREAK_HOOK}" and not scope[k] then scope[k] = { v }; lines[#lines + 1] = "U " .. k .. "=" .. _show(v) end
      end
    end
    local env = setmetatable({}, { __index = function(_, k)
      local s = scope[k]
      if s then return s[1] end
      return _G[k]
    end })
    local n = _rd(_B + ${DBG_WATCH_LENGTH})
    local text = {}
    for i = 0, math.min(n, ${DBG_WATCH_BYTES}) - 1 do text[#text + 1] = string.char(peek(_B + ${DBG_WATCH_AT} + i)) end
    local index = 0
    for expr in (table.concat(text) .. "\\n"):gmatch("([^\\n]*)\\n") do
      index = index + 1
      if expr:match("%S") then
        local f, err = load("return " .. expr, "=watch", "t", env)
        local ok, v = false, err
        if f then ok, v = pcall(f) end
        lines[#lines + 1] = "W " .. index .. (ok and ("=" .. _show(v)) or ("!" .. tostring(v):gsub("^watch:1: ", ""))):sub(1, 120)
      end
    end
    local out = table.concat(lines, "\\n")
    if #out > ${DBG_INFO_BYTES} then out = out:sub(1, ${DBG_INFO_BYTES}) end
    for i = 1, #out do poke(_B + ${DBG_INFO_AT} + i - 1, out:byte(i)) end
    _wr(_B + ${DBG_INFO_LENGTH}, #out)
  end
  -- Run one frame of the cart's TIC: straight through when nothing can stop it,
  -- else in a coroutine the hooks can yield from, carrying on from a stop.
  __cbx_run = function(tic)
    _tic = tic
    if not _live() then return tic() end
    _loadbps()
    if _co then
      if _rd(_B + ${DBG_STATE}) == 1 then
        local cmd = _rd(_B + ${DBG_COMMAND})
        if cmd == ${DebugCommand.refresh} then
          _wr(_B + ${DBG_COMMAND}, 0)
          _writeinfo(_co)
        end
        if cmd < ${DebugCommand.continue} or cmd > ${DebugCommand.out} then return end
      end
    else
      _armed = _step ~= 0 or next(_bps) ~= nil
      if not _armed then return tic() end
      _co = coroutine.create(tic)
    end
    local ok, err = coroutine.resume(_co)
    if not ok then
      local co = _co
      _co = nil
      _step = 0
      _wr(_B + ${DBG_STATE}, 0)
      error(_traceback(co, err), 0)
    end
    if coroutine.status(_co) == "dead" then
      _co = nil
    else
      _writeinfo(_co)
    end
  end`;
}

/** Appended after the cart's code (so its lines don't move): runs TIC through the debugger. */
export function debugPostlude(): string {
  return `do local _t = TIC if type(_t) == "function" then TIC = function() __cbx_run(_t) end end end`;
}

/** Where the cart stopped, as the debugger reads it. */
export interface PauseInfo {
  readonly line: number;
  /** Innermost first. */
  readonly stack: readonly ErrorFrame[];
  readonly locals: readonly { readonly name: string; readonly value: string }[];
  readonly upvalues: readonly { readonly name: string; readonly value: string }[];
  /** One per watch expression, in order; null value for a blank one. */
  readonly watches: readonly { readonly value: string; readonly error: boolean }[];
}

/** Parse the pause information the Lua wrote (see {@link DBG_INFO_AT}); `watchCount` sizes the result's watches. */
export function parsePauseInfo(line: number, text: string, watchCount: number): PauseInfo {
  const stack: ErrorFrame[] = [];
  const locals: { name: string; value: string }[] = [];
  const upvalues: { name: string; value: string }[] = [];
  const watches: { value: string; error: boolean }[] = Array.from({ length: watchCount }, () => ({ value: "", error: false }));
  for (const row of text.split("\n")) {
    const kind = row.slice(0, 2);
    const body = row.slice(2);
    if (kind === "S ") {
      const m = /^(.*):(\d+)$/.exec(body);
      if (m) stack.push({ name: m[1]!, line: Number(m[2]) });
    } else if (kind === "L " || kind === "U ") {
      const eq = body.indexOf("=");
      if (eq > 0) (kind === "L " ? locals : upvalues).push({ name: body.slice(0, eq), value: body.slice(eq + 1) });
    } else if (kind === "W ") {
      const m = /^(\d+)([=!])(.*)$/s.exec(body);
      const index = m ? Number(m[1]) - 1 : -1;
      if (m && index >= 0 && index < watchCount) watches[index] = { value: m[3]!, error: m[2] === "!" };
    }
  }
  return { line, stack, locals, upvalues, watches };
}

/** Read a pause from the block, or null while the cart runs. */
export function readPause(block: DataView, watchCount: number): PauseInfo | null {
  if (block.getInt32(DBG_STATE, true) !== 1) return null;
  const length = Math.max(0, Math.min(block.getInt32(DBG_INFO_LENGTH, true), DBG_INFO_BYTES));
  const text = new TextDecoder().decode(new Uint8Array(block.buffer, block.byteOffset + DBG_INFO_AT, length));
  return parsePauseInfo(block.getInt32(DBG_PAUSED_LINE, true), text, watchCount);
}

/** Tell a stopped cart how to go on. */
export function sendDebugCommand(block: DataView, command: number): void {
  block.setInt32(DBG_COMMAND, command, true);
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

/** Arm the block for the next tick: magic, and where the cart's lines are in the merged source. */
export function armDebugBlock(block: DataView, lineOffset: number, lineCount = 0): void {
  block.setUint32(DBG_MAGIC, DEBUG_MAGIC, true);
  block.setInt32(DBG_LINE_OFFSET, lineOffset, true);
  block.setInt32(DBG_LINE_COUNT, lineCount, true);
}

/** Write the breakpoint lines (at most {@link DBG_BPS_MAX}) and bump the version so the Lua reloads them. */
export function writeBreakpoints(block: DataView, lines: readonly number[]): void {
  const list = lines.slice(0, DBG_BPS_MAX);
  list.forEach((line, i) => block.setInt32(DBG_BPS_AT + i * 4, line, true));
  block.setInt32(DBG_BP_COUNT, list.length, true);
  block.setInt32(DBG_BP_VERSION, (block.getInt32(DBG_BP_VERSION, true) + 1) | 0, true);
}

/** Write the watch expressions, one per line; returns how many fit. */
export function writeWatches(block: DataView, expressions: readonly string[]): number {
  const encoder = new TextEncoder();
  let bytes = new Uint8Array(0);
  let fitted = 0;
  for (const expr of expressions) {
    const next = encoder.encode((fitted > 0 ? "\n" : "") + expr.replace(/\n/g, " "));
    if (bytes.length + next.length > DBG_WATCH_BYTES) break;
    const joined = new Uint8Array(bytes.length + next.length);
    joined.set(bytes);
    joined.set(next, bytes.length);
    bytes = joined;
    fitted += 1;
  }
  new Uint8Array(block.buffer, block.byteOffset + DBG_WATCH_AT, bytes.length).set(bytes);
  block.setInt32(DBG_WATCH_LENGTH, bytes.length, true);
  return fitted;
}
