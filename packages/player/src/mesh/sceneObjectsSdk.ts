/**
 * Scene objects for the cart's Lua (ENGINE_ROADMAP.md, Phase 1): the authored
 * names, parents, tags and properties of the cart's placed meshes, injected as a
 * table behind `cartbox.find` / `cartbox.prop` / `cartbox.tagged` and friends, so
 * code finds an object by name instead of hard-coding its slot number.
 *
 * Objects are identified by the same 0-based index `cartbox.meshpose` takes (the
 * instance's position in the runtime scene), so `cartbox.meshpose(cartbox.find("door"), ...)`
 * moves the door. The SDK ships no-op defaults for every call (see sdk.ts), so a
 * cart without meshes can call them safely; this overrides them when it has some.
 */

import type { MeshScene } from "./meshScene.js";

/** A Lua double-quoted string literal (control characters escaped as \\ddd). */
export function luaQuote(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 32 || code === 127) out += `\\${String(code).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function luaValue(value: number | string | boolean): string {
  if (typeof value === "string") return luaQuote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return Number.isFinite(value) ? String(value) : "0";
}

/**
 * The Lua that defines the scene-object calls for `scene`, or "" when there is no
 * scene (the SDK's defaults then stand).
 */
export function sceneObjectsSdkLua(scene: MeshScene | null | undefined): string {
  if (!scene || scene.instances.length === 0) return "";
  const names: string[] = [];
  const parents: string[] = [];
  const tags: string[] = [];
  const props: string[] = [];
  scene.instances.forEach((instance, i) => {
    names.push(`[${i}]=${luaQuote(instance.name ?? "")}`);
    if ((instance.parent ?? -1) >= 0) parents.push(`[${i}]=${instance.parent}`);
    const t = instance.tags ?? [];
    if (t.length > 0) tags.push(`[${i}]={${t.map((tag) => `[${luaQuote(tag)}]=true`).join(",")}}`);
    const entries = Object.entries(instance.props ?? {});
    if (entries.length > 0) props.push(`[${i}]={${entries.map(([k, v]) => `[${luaQuote(k)}]=${luaValue(v)}`).join(",")}}`);
  });
  return `do
  cartbox = cartbox or {}
  local _n = {${names.join(",")}}
  local _p = {${parents.join(",")}}
  local _t = {${tags.join(",")}}
  local _pr = {${props.join(",")}}
  local _count = ${scene.instances.length}
  local _byname = {}
  for i = _count - 1, 0, -1 do _byname[_n[i]] = i end
  local function _obj(o)
    if type(o) == "string" then return _byname[o] end
    if type(o) == "number" and o >= 0 and o < _count then return math.floor(o) end
    return nil
  end
  cartbox.objects = function() return _count end
  cartbox.find = function(name) return _byname[name] end
  cartbox.objname = function(o) local i = _obj(o) return i and _n[i] end
  cartbox.parent = function(o) local i = _obj(o) return i and _p[i] end
  cartbox.children = function(o)
    local i = _obj(o)
    local out = {}
    if i == nil then return out end
    for c = 0, _count - 1 do if _p[c] == i then out[#out + 1] = c end end
    return out
  end
  cartbox.prop = function(o, key, default)
    local i = _obj(o)
    local v = i and _pr[i] and _pr[i][key]
    if v == nil then return default end
    return v
  end
  cartbox.hastag = function(o, tag)
    local i = _obj(o)
    return (i and _t[i] and _t[i][tag]) == true
  end
  cartbox.tagged = function(tag)
    local out = {}
    for i = 0, _count - 1 do if _t[i] and _t[i][tag] then out[#out + 1] = i end end
    return out
  end
end`;
}
