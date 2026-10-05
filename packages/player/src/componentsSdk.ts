/**
 * Components at run time (ENGINE_PARITY_ROADMAP.md EP14): the scene's
 * component scripts, each loaded into its own environment (so a mistake in
 * one is reported and skips it rather than breaking the cart), a copy per
 * object it's attached to with that object's field values, and a step run
 * ahead of the cart's own TIC each tick — start on a copy's first tick (and
 * again when a spawned copy comes back), update every tick, and collision /
 * trigger for this tick's contacts — and late after the cart's TIC. A
 * callback that errors is reported (trace) and stops that copy; the cart and
 * the other copies run on.
 *
 *   cartbox.component(obj, name) -> the copy's self table (its fields and state), or nil
 *
 * A copy's self also carries `obj` (its object) and `origin` ({x, y, z}: where
 * the scene placed it, in world space — for cartbox.place).
 *
 * Two pieces: a prelude (the scripts and copies, before the cart's code) and
 * a postlude (wraps the cart's TIC, after it).
 */

import { componentFields, componentValues, type ComponentValue } from "@cartbox/editor";

import type { MeshScene } from "./mesh/meshScene.js";

/** A Lua string literal for any text: quotes, backslashes and control characters escaped. */
function luaQuote(text: string): string {
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (code < 32 || code === 127) out += `\\${code}`;
    else out += ch;
  }
  return out + '"';
}

const luaValue = (v: ComponentValue): string => (typeof v === "string" ? luaQuote(v) : typeof v === "boolean" ? String(v) : Number.isFinite(v) ? String(v) : "0");

/** The prelude and postlude for a scene's components, or null when no object has any. */
export function componentsSdkLua(scene: MeshScene | null | undefined): { prelude: string; postlude: string } | null {
  const defs = scene?.components ?? [];
  if (!scene || defs.length === 0) return null;
  const used = scene.instances.some((i) => (i.components?.length ?? 0) > 0);
  if (!used) return null;
  const byName = new Map(defs.map((d) => [d.name, d]));
  const copies: string[] = [];
  scene.instances.forEach((inst, i) => {
    for (const a of inst.components ?? []) {
      const def = byName.get(a.name);
      if (!def) continue;
      const values = componentValues(def, a);
      const objectFields = componentFields(def.code).filter((f) => f.type === "object").map((f) => luaQuote(f.name));
      const fields = Object.entries(values).map(([k, v]) => `[${luaQuote(k)}]=${luaValue(v)}`);
      const root = inst.pooled ? inst.pooled.root : -1;
      const at = [12, 13, 14].map((k) => +(inst.model[k] ?? 0).toFixed(4));
      copies.push(`{obj=${i},def=${luaQuote(def.name)},root=${root},o={${at.join(",")}},f={${fields.join(",")}},objf={${objectFields.join(",")}}}`);
    }
  });
  const prelude = `do
local SRC = {${defs.map((d) => `[${luaQuote(d.name)}]=${luaQuote(d.code)}`).join(",\n")}}
local LIST = {${copies.join(",\n")}}
local built, C, by = {}, {}, {}
local function behaviour(name)
  if built[name] == nil then
    local env = setmetatable({}, {__index = _G})
    local chunk, err = load(SRC[name], "=" .. name, "t", env)
    if chunk then
      local ok, e = pcall(chunk)
      if ok then built[name] = env else trace("component " .. name .. ": " .. tostring(e), 2); built[name] = false end
    else trace("component " .. name .. ": " .. tostring(err), 2); built[name] = false end
  end
  return built[name]
end
for _, e in ipairs(LIST) do
  local b = behaviour(e.def)
  if b then
    local self = {obj = e.obj, origin = {x = e.o[1], y = e.o[2], z = e.o[3]}}
    for k, v in pairs(e.f) do self[k] = v end
    local c = {b = b, self = self, name = e.def, root = e.root, objf = e.objf, started = false}
    C[#C + 1] = c
    by[e.obj] = by[e.obj] or {}
    table.insert(by[e.obj], c)
  end
end
-- A callback that errors is reported once and that copy stops (the rest run on).
local function call(c, fn, ...)
  local f = rawget(c.b, fn)
  if f and not c.dead then
    local ok, e = pcall(f, c.self, ...)
    if not ok then c.dead = true; trace("component " .. c.name .. " (" .. fn .. "): " .. tostring(e), 2) end
  end
end
cartbox.component = function(obj, name)
  if type(obj) == "string" and cartbox.find then obj = cartbox.find(obj) end
  for _, c in ipairs(by[obj] or {}) do if c.name == name then return c.self end end
  return nil
end
function _cbx_components_late()
  for _, c in ipairs(C) do
    if c.started and (c.root < 0 or (cartbox.alive and cartbox.alive(c.root))) then call(c, "late", 1 / 60) end
  end
end
function _cbx_components_tick()
  for _, c in ipairs(C) do
    if c.root < 0 or (cartbox.alive and cartbox.alive(c.root)) then
      if not c.started then
        c.started = true
        -- An object field names an object: look it up once it exists.
        for _, k in ipairs(c.objf) do
          local v = c.self[k]
          if type(v) == "string" then c.self[k] = (v ~= "" and cartbox.find) and cartbox.find(v) or nil end
        end
        call(c, "start")
      end
      call(c, "update", 1 / 60)
    elseif c.started then c.started = false end
  end
  if cartbox.contacts then
    for _, e in ipairs(cartbox.contacts()) do
      for side = 1, 2 do
        local me, other = e.a, e.b
        if side == 2 then me, other = e.b, e.a end
        for _, c in ipairs(by[me] or {}) do
          if c.started then call(c, e.trigger and "trigger" or "collision", other, e.started) end
        end
      end
    end
  end
end
end`;
  const postlude = `do
local _cart_tic = TIC
function TIC()
  _cbx_components_tick()
  if _cart_tic then _cart_tic() end
  _cbx_components_late()
end
end`;
  return { prelude, postlude };
}
