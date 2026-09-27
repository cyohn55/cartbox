/**
 * The cart-facing physics calls (ENGINE_ROADMAP.md, Phase 2), generated for a
 * cart that has physics bodies: they read body state from, and write commands
 * to, the shared block at the end of RAM (see protocol.ts) with peek/poke.
 *
 *   cartbox.physics()                 -> true once the host's physics is running
 *   cartbox.body(obj)                 -> x, y, z, vx, vy, vz, grounded (nil if no body)
 *   cartbox.impulse(obj, x, y, z)     push a dynamic body (instant change of momentum)
 *   cartbox.velocity(obj, x, y, z)    set a dynamic or kinematic body's velocity
 *   cartbox.teleport(obj, x, y, z)    move a body there at once
 *   cartbox.move(obj, dx, dy, dz)     walk a character this tick (slides, climbs, steps)
 *   cartbox.ray(slot, x, y, z, dx, dy, dz, max, ignore)   cast a ray (slot 0-15); read next tick
 *   cartbox.sweep(slot, shape, x, y, z, dx, dy, dz, max, ignore)   sweep a shape instead:
 *                                     shape = radius (sphere), {hx, hy, hz} (box half-extents)
 *                                     or {radius, halfheight} (upright capsule)
 *   cartbox.hit(slot)                 -> hit, obj, x, y, z, nx, ny, nz, distance
 *   cartbox.contacts()                -> this tick's contacts { {a=, b=, started=, trigger=}, ... }
 *   cartbox.entered(trigger)          -> objects that came into a trigger zone this tick
 *   cartbox.exited(trigger)           -> objects that left it this tick
 *   cartbox.inside(trigger)           -> objects in it now
 *   cartbox.motor(obj, speed, force)  drive a hinge joint (rad/s, max force; no speed = off)
 *   cartbox.unjoin(obj)               break an object's joint (it's remade if the copy respawns)
 *
 * Spawning prefab copies (when the cart has prefabs) rides the same block:
 *
 *   cartbox.spawn(prefab, x, y, z, yaw, pitch, roll) -> the copy's root object, or nil
 *   cartbox.despawn(obj)              put a spawned copy back in reserve
 *   cartbox.alive(obj)                -> whether a copy is spawned
 *
 * `obj` is an object index or its name (as cartbox.find). The SDK's defaults
 * (sdk.ts) make every call a safe no-op for carts without bodies or prefabs.
 */

import type { MeshScene } from "../mesh/meshScene.js";
import {
  PHYS_BODIES,
  PHYS_BODY_BYTES,
  PHYS_CAST_BOX,
  PHYS_CAST_CAPSULE,
  PHYS_CAST_RAY,
  PHYS_CAST_SPHERE,
  PHYS_CMD_BYTES,
  PHYS_CMDS,
  PHYS_EVENT_BYTES,
  PHYS_EVENTS,
  PHYS_FIX,
  PHYS_MAGIC,
  PHYS_MAX_CMDS,
  PHYS_MAX_RAYS,
  PHYS_OVERLAP_BYTES,
  PHYS_OVERLAPS,
  PHYS_OP_CAST,
  PHYS_OP_DESPAWN,
  PHYS_OP_IMPULSE,
  PHYS_OP_MOTOR,
  PHYS_OP_MOVE,
  PHYS_OP_RAY,
  PHYS_OP_SPAWN,
  PHYS_OP_TELEPORT,
  PHYS_OP_UNJOIN,
  PHYS_OP_VELOCITY,
  PHYS_RAY_BYTES,
  PHYS_RAYS,
  physicsBlockAddress,
  type RamLayout,
} from "./protocol.js";
import { physicsSlots, sceneHasPhysics } from "./physicsSession.js";

/**
 * Whether a scene needs the runtime block at all: bodies (when a physics engine
 * will run them), or prefabs to spawn.
 */
export function sceneNeedsRuntime(scene: MeshScene | null | undefined, { physics = true }: { physics?: boolean } = {}): boolean {
  return Boolean(scene && ((physics && sceneHasPhysics(scene)) || (scene.pools?.length ?? 0) > 0));
}

const luaString = (s: string) => JSON.stringify(s);

/**
 * The Lua for a cart's runtime calls — physics (when it has bodies) and spawning
 * (when it has prefabs) — or "" when it needs neither.
 */
export function runtimeSdkLua(
  scene: MeshScene | null | undefined,
  layout: RamLayout,
  { physics: engine = true }: { physics?: boolean } = {},
): string {
  if (!scene || !sceneNeedsRuntime(scene, { physics: engine })) return "";
  // Without an engine to run them, bodies keep the SDK's no-op physics calls.
  const physics = engine && sceneHasPhysics(scene);
  const slots = physicsSlots(scene).map((object, slot) => `[${object}]=${slot}`);
  const pools = (scene.pools ?? []).map((pool) => `[${luaString(pool.prefab)}]={${pool.roots.join(",")}}`);
  const B = physicsBlockAddress(layout);
  return `do
  cartbox = cartbox or {}
  local _B = ${B}
  local _slot = {${slots.join(",")}}
  local _ok = false
  local function _rd(a)
    local v = peek(a) | (peek(a + 1) << 8) | (peek(a + 2) << 16) | (peek(a + 3) << 24)
    if v >= 0x80000000 then v = v - 0x100000000 end
    return v
  end
  local function _wr(a, v)
    v = math.floor(v) & 0xffffffff
    poke(a, v & 0xff) poke(a + 1, (v >> 8) & 0xff) poke(a + 2, (v >> 16) & 0xff) poke(a + 3, (v >> 24) & 0xff)
  end
  -- The host writes a magic word before every tick; until it has (code run at
  -- load time) or if the block isn't where this build expects, physics is off.
  local function _live()
    if not _ok then _ok = _rd(_B) == ${PHYS_MAGIC} end
    return _ok
  end
  local function _obj(o)
    if type(o) == "string" then return cartbox.find(o) end
    return o
  end
  local function _cmd(op, a, v1, v2, v3, v4, v5, v6)
    if not _live() then return end
    local n = _rd(_B + ${PHYS_CMDS})
    if n < 0 or n >= ${PHYS_MAX_CMDS} then return end
    local at = _B + ${PHYS_CMDS + 4} + n * ${PHYS_CMD_BYTES}
    _wr(at, op) _wr(at + 4, a)
    _wr(at + 8, (v1 or 0) * ${PHYS_FIX}) _wr(at + 12, (v2 or 0) * ${PHYS_FIX}) _wr(at + 16, (v3 or 0) * ${PHYS_FIX})
    _wr(at + 20, (v4 or 0) * ${PHYS_FIX}) _wr(at + 24, (v5 or 0) * ${PHYS_FIX}) _wr(at + 28, (v6 or 0) * ${PHYS_FIX})
    _wr(_B + ${PHYS_CMDS}, n + 1)
  end
${physics ? PHYSICS_CALLS() : ""}
${pools.length > 0 ? SPAWN_CALLS(pools) : ""}end`;
}

/** The physics calls (inside the runtime block's do … end, after its helpers). */
function PHYSICS_CALLS(): string {
  return `  cartbox.physics = function() return _live() end
  cartbox.body = function(o)
    local i = _obj(o)
    local s = i and _slot[i]
    if s == nil or not _live() then return nil end
    local at = _B + ${PHYS_BODIES} + s * ${PHYS_BODY_BYTES}
    return _rd(at + 4) / ${PHYS_FIX}, _rd(at + 8) / ${PHYS_FIX}, _rd(at + 12) / ${PHYS_FIX},
      _rd(at + 16) / ${PHYS_FIX}, _rd(at + 20) / ${PHYS_FIX}, _rd(at + 24) / ${PHYS_FIX},
      (_rd(at + 28) & 1) == 1
  end
  local function _each(op)
    return function(o, x, y, z)
      local i = _obj(o)
      if i and _slot[i] then _cmd(op, i, x, y, z) end
    end
  end
  cartbox.impulse = _each(${PHYS_OP_IMPULSE})
  cartbox.velocity = _each(${PHYS_OP_VELOCITY})
  cartbox.teleport = _each(${PHYS_OP_TELEPORT})
  cartbox.move = _each(${PHYS_OP_MOVE})
  cartbox.motor = function(o, speed, force)
    local i = _obj(o)
    if i == nil or not _slot[i] then return end
    if speed == nil then _cmd(${PHYS_OP_MOTOR}, i, 0, 0) else _cmd(${PHYS_OP_MOTOR}, i, speed, force or 1000) end
  end
  cartbox.unjoin = function(o)
    local i = _obj(o)
    if i and _slot[i] then _cmd(${PHYS_OP_UNJOIN}, i) end
  end
  -- A ray, or (kind > 0) a swept shape, from a slot: options first, then the ray.
  local function _cast(slot, kind, a, b, c, x, y, z, dx, dy, dz, max, ignore)
    slot = math.floor(slot or 0)
    if slot < 0 or slot >= ${PHYS_MAX_RAYS} then return end
    local m = math.sqrt((dx or 0)^2 + (dy or 0)^2 + (dz or 0)^2)
    if m < 1e-9 then return end
    local skip = 0
    if ignore ~= nil then skip = (_obj(ignore) or -1) + 1 end
    if kind ~= ${PHYS_CAST_RAY} or skip > 0 then _cmd(${PHYS_OP_CAST}, slot, kind, a, b, c, skip) end
    local k = (max or 100) / m
    _cmd(${PHYS_OP_RAY}, slot, x, y, z, dx * k, dy * k, dz * k)
  end
  cartbox.ray = function(slot, x, y, z, dx, dy, dz, max, ignore)
    _cast(slot, ${PHYS_CAST_RAY}, 0, 0, 0, x, y, z, dx, dy, dz, max, ignore)
  end
  cartbox.sweep = function(slot, shape, x, y, z, dx, dy, dz, max, ignore)
    if type(shape) == "number" then
      _cast(slot, ${PHYS_CAST_SPHERE}, shape, 0, 0, x, y, z, dx, dy, dz, max, ignore)
    elseif type(shape) == "table" and #shape >= 3 then
      _cast(slot, ${PHYS_CAST_BOX}, shape[1], shape[2], shape[3], x, y, z, dx, dy, dz, max, ignore)
    elseif type(shape) == "table" and #shape == 2 then
      _cast(slot, ${PHYS_CAST_CAPSULE}, shape[1], shape[2], 0, x, y, z, dx, dy, dz, max, ignore)
    end
  end
  cartbox.hit = function(slot)
    slot = math.floor(slot or 0)
    if slot < 0 or slot >= ${PHYS_MAX_RAYS} or not _live() then return false end
    local at = _B + ${PHYS_RAYS} + slot * ${PHYS_RAY_BYTES}
    local w = _rd(at)
    if w == 0 then return false end
    local obj = nil
    if w >= 2 then obj = w - 2 end
    return true, obj, _rd(at + 4) / ${PHYS_FIX}, _rd(at + 8) / ${PHYS_FIX}, _rd(at + 12) / ${PHYS_FIX},
      _rd(at + 16) / ${PHYS_FIX}, _rd(at + 20) / ${PHYS_FIX}, _rd(at + 24) / ${PHYS_FIX}, _rd(at + 28) / ${PHYS_FIX}
  end
  cartbox.contacts = function()
    local out = {}
    if not _live() then return out end
    local n = _rd(_B + ${PHYS_EVENTS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_EVENTS + 4} + k * ${PHYS_EVENT_BYTES}
      local f = _rd(at + 8)
      out[#out + 1] = { a = _rd(at), b = _rd(at + 4), started = (f & 1) == 1, trigger = (f & 2) == 2 }
    end
    return out
  end
  local function _crossed(o, started)
    local t = _obj(o)
    local out = {}
    if t == nil then return out end
    for _, e in ipairs(cartbox.contacts()) do
      if e.trigger and e.started == started then
        if e.a == t then out[#out + 1] = e.b elseif e.b == t then out[#out + 1] = e.a end
      end
    end
    return out
  end
  cartbox.entered = function(o) return _crossed(o, true) end
  cartbox.exited = function(o) return _crossed(o, false) end
  cartbox.inside = function(o)
    local t = _obj(o)
    local out = {}
    if t == nil or not _live() then return out end
    local n = _rd(_B + ${PHYS_OVERLAPS})
    for k = 0, n - 1 do
      local at = _B + ${PHYS_OVERLAPS + 4} + k * ${PHYS_OVERLAP_BYTES}
      if _rd(at) == t then out[#out + 1] = _rd(at + 4) end
    end
    return out
  end
`;
}

/** The spawn calls: the cart itself hands out reserve copies, so spawn returns at once. */
function SPAWN_CALLS(pools: readonly string[]): string {
  return `  local _pools = {${pools.join(",")}}
  local _alive = {}
  cartbox.spawn = function(name, x, y, z, yaw, pitch, roll)
    local roots = _pools[name]
    if roots == nil or not _live() then return nil end
    for _, r in ipairs(roots) do
      if not _alive[r] then
        _alive[r] = true
        _cmd(${PHYS_OP_SPAWN}, r, x or 0, y or 0, z or 0, yaw or 0, pitch or 0, roll or 0)
        return r
      end
    end
    return nil
  end
  cartbox.despawn = function(o)
    local i = _obj(o)
    if i ~= nil and _alive[i] then
      _alive[i] = nil
      _cmd(${PHYS_OP_DESPAWN}, i)
    end
  end
  cartbox.alive = function(o)
    local i = _obj(o)
    return i ~= nil and _alive[i] == true
  end
`;
}

/** @deprecated Kept for callers of the physics-only name: the same as runtimeSdkLua. */
export const physicsSdkLua = runtimeSdkLua;
