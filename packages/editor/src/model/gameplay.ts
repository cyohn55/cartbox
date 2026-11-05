/**
 * Damage, abilities and tags (AAA_PRODUCTION_ROADMAP.md K6): the gameplay
 * framework a shooter or an action game rebuilds by hand, as Lua the player
 * puts ahead of a cart's code when it names any of it.
 *
 * - **Tags** (`cartbox.tags`): an entity's gameplay tags, hierarchical by dots,
 *   so `state.stunned` counts as `state`. `add`, `remove`, `has`, `all`, `any`,
 *   and `list`. Any table (or number) is an entity.
 * - **Health** (`cartbox.health.new{max, shield, shieldDelay, shieldRate,
 *   resist}`) and **damage** (`cartbox.damage(target, amount, {type, zone,
 *   source})`): resistance by damage type and a multiplier by hit zone; the
 *   shield takes it first and recharges after a delay; the events of each hit
 *   (`hit`, `shield_broken`, `death`) queue for `cartbox.damage.events()`.
 *   Dead things take no damage. `cartbox.health.update(h, dt)` recharges.
 * - **Hitboxes** (`cartbox.hitbox.new(shapes)`): spheres and capsules, each a
 *   zone with a multiplier, placed on a skeleton's joints (`at` a joint name,
 *   or between two for a capsule) from the world positions the cart reads with
 *   cartbox.joint each frame (`cartbox.hitbox.place(hb, joints)`).
 *   `cartbox.hitbox.ray(hb, origin, direction, max)` returns the nearest zone
 *   hit, its distance and its multiplier.
 * - **Abilities** (`cartbox.ability.new{name, cooldown, cost, requires,
 *   blocked, grants, duration}`): `cartbox.ability.try(owner, ability)`
 *   checks the cooldown, the owner's resources (`owner.resources`) and its tags
 *   (all of `requires`, none of `blocked`), then pays, starts the cooldown and
 *   grants its tags for `duration`; `cartbox.ability.update(owner, dt)` runs
 *   the clocks.
 *
 * - **Lag compensation** (`cartbox.rewind`, N3): the host records each
 *   target's joints every tick (`record`), and tests a shot against the
 *   targets' hitboxes as they were at the shooter's view time (`ray`),
 *   interpolated between ticks and never further back than `max` seconds.
 *
 * Time is the `dt` the cart passes and there is no randomness, so a replay
 * plays out the same.
 */

export const GAMEPLAY_LUA = `cartbox = cartbox or {}
do
-- Tags -------------------------------------------------------------------------
local tagsOf = setmetatable({}, { __mode = "k" })
local numbered = {}
local function bag(e)
  if type(e) == "table" then
    local b = tagsOf[e]
    if b == nil then b = {} tagsOf[e] = b end
    return b
  end
  local b = numbered[e]
  if b == nil then b = {} numbered[e] = b end
  return b
end
local function under(tag, query) return tag == query or tag:sub(1, #query + 1) == query .. "." end
cartbox.tags = {}
function cartbox.tags.add(e, tag) bag(e)[tag] = (bag(e)[tag] or 0) + 1 end
function cartbox.tags.remove(e, tag)
  local b = bag(e)
  if b[tag] == nil then return end
  b[tag] = b[tag] - 1
  if b[tag] <= 0 then b[tag] = nil end
end
function cartbox.tags.has(e, query)
  for tag in pairs(bag(e)) do if under(tag, query) then return true end end
  return false
end
function cartbox.tags.all(e, list) for _, q in ipairs(list or {}) do if not cartbox.tags.has(e, q) then return false end end return true end
function cartbox.tags.any(e, list) for _, q in ipairs(list or {}) do if cartbox.tags.has(e, q) then return true end end return false end
function cartbox.tags.list(e) local out = {} for tag in pairs(bag(e)) do out[#out + 1] = tag end table.sort(out) return out end

-- Health and damage --------------------------------------------------------------
local events = {}
cartbox.health = {}
function cartbox.health.new(o)
  o = o or {}
  return { max = o.max or 100, hp = o.max or 100, maxShield = o.shield or 0, shield = o.shield or 0, shieldDelay = o.shieldDelay or 3, shieldRate = o.shieldRate or 25, sinceHit = 0, resist = o.resist or {}, dead = false, zones = o.zones or {} }
end
function cartbox.health.update(h, dt)
  if h.dead then return end
  h.sinceHit = h.sinceHit + (dt or 1 / 60)
  if h.sinceHit >= h.shieldDelay and h.shield < h.maxShield then h.shield = math.min(h.maxShield, h.shield + h.shieldRate * (dt or 1 / 60)) end
end
local damage = {}
setmetatable(damage, { __call = function(_, target, amount, o)
  o = o or {}
  local h = target.health or target
  if h.dead or amount <= 0 then return 0 end
  local kind = o.type or "normal"
  local scale = (1 - (h.resist[kind] or 0)) * (o.multiplier or h.zones[o.zone or ""] or 1)
  local left = math.max(0, amount * scale)
  local dealt = left
  local hadShield = h.shield > 0
  if h.shield > 0 and kind ~= "true" then
    local take = math.min(h.shield, left)
    h.shield = h.shield - take
    left = left - take
  end
  h.hp = math.max(0, h.hp - left)
  h.sinceHit = 0
  events[#events + 1] = { kind = "hit", target = target, amount = dealt, type = kind, zone = o.zone, source = o.source, hp = h.hp, shield = h.shield }
  if hadShield and h.shield <= 0 then events[#events + 1] = { kind = "shield_broken", target = target, source = o.source } end
  if h.hp <= 0 then
    h.dead = true
    events[#events + 1] = { kind = "death", target = target, source = o.source, type = kind, zone = o.zone }
  end
  return dealt
end })
function damage.events() local out = events events = {} return out end
cartbox.damage = damage

-- Hitboxes --------------------------------------------------------------------------
cartbox.hitbox = {}
function cartbox.hitbox.new(shapes) return { shapes = shapes or {}, placed = {} } end
function cartbox.hitbox.place(hb, joints)
  hb.placed = {}
  for i, s in ipairs(hb.shapes) do
    local a = joints[s.at] or s.point
    local b = s.to and joints[s.to] or nil
    if a then hb.placed[i] = { a = a, b = b } end
  end
end
local function dot(ax, ay, az, bx, by, bz) return ax * bx + ay * by + az * bz end
-- A ray against a sphere at (cx, cy, cz): its distance along the ray, or nil.
local function sphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r)
  local lx, ly, lz = ox - cx, oy - cy, oz - cz
  local b = dot(lx, ly, lz, dx, dy, dz)
  local c = dot(lx, ly, lz, lx, ly, lz) - r * r
  local disc = b * b - c
  if disc < 0 then return nil end
  local t = -b - math.sqrt(disc)
  if t < 0 then t = -b + math.sqrt(disc) end
  if t < 0 then return nil end
  return t
end
-- A ray against a capsule from a to b: the nearest hit, sampling the closest points of the two lines.
local function capsule(ox, oy, oz, dx, dy, dz, a, b, r)
  local ux, uy, uz = b[1] - a[1], b[2] - a[2], b[3] - a[3]
  local wx, wy, wz = ox - a[1], oy - a[2], oz - a[3]
  local A, B, C = dot(dx, dy, dz, dx, dy, dz), dot(dx, dy, dz, ux, uy, uz), dot(ux, uy, uz, ux, uy, uz)
  local D, E = dot(dx, dy, dz, wx, wy, wz), dot(ux, uy, uz, wx, wy, wz)
  local den = A * C - B * B
  local s = 0
  if den > 1e-12 then s = math.max(0, math.min(1, (A * E - B * D) / den)) end
  -- The sphere at the axis point nearest the ray, and the two end caps: the nearest of their hits.
  local best = nil
  for _, k in ipairs({ s, 0, 1 }) do
    local t = sphere(ox, oy, oz, dx, dy, dz, a[1] + ux * k, a[2] + uy * k, a[3] + uz * k, r)
    if t and (best == nil or t < best) then best = t end
  end
  return best
end
function cartbox.hitbox.ray(hb, ox, oy, oz, dx, dy, dz, max)
  local l = math.sqrt(dx * dx + dy * dy + dz * dz)
  if l < 1e-12 then return nil end
  dx, dy, dz = dx / l, dy / l, dz / l
  local best, bestT = nil, max or math.huge
  for i, s in ipairs(hb.shapes) do
    local p = hb.placed[i]
    if p then
      local ax, ay, az = p.a[1] + (s.offset and s.offset[1] or 0), p.a[2] + (s.offset and s.offset[2] or 0), p.a[3] + (s.offset and s.offset[3] or 0)
      local t
      if p.b then t = capsule(ox, oy, oz, dx, dy, dz, { ax, ay, az }, p.b, s.r or 0.2)
      else t = sphere(ox, oy, oz, dx, dy, dz, ax, ay, az, s.r or 0.2) end
      if t and t < bestT - 1e-9 then best, bestT = s, t end -- ties go to the earlier shape (list the head first)
    end
  end
  if best == nil then return nil end
  return best.zone or "body", bestT, best.multiplier or 1
end

-- Abilities ---------------------------------------------------------------------------
cartbox.ability = {}
function cartbox.ability.new(o) return { name = o.name or "ability", cooldown = o.cooldown or 0, cost = o.cost or {}, requires = o.requires or {}, blocked = o.blocked or {}, grants = o.grants or {}, duration = o.duration or 0 } end
local function state(owner)
  owner.abilities = owner.abilities or { ready = {}, active = {} }
  return owner.abilities
end
function cartbox.ability.try(owner, ab)
  local st = state(owner)
  if (st.ready[ab.name] or 0) > 0 then return false, "cooldown", st.ready[ab.name] end
  if not cartbox.tags.all(owner, ab.requires) then return false, "requires" end
  if cartbox.tags.any(owner, ab.blocked) then return false, "blocked" end
  local res = owner.resources or {}
  for k, v in pairs(ab.cost) do if (res[k] or 0) < v then return false, "cost", k end end
  for k, v in pairs(ab.cost) do res[k] = res[k] - v end
  st.ready[ab.name] = ab.cooldown
  for _, tag in ipairs(ab.grants) do cartbox.tags.add(owner, tag) end
  if #ab.grants > 0 then st.active[#st.active + 1] = { left = ab.duration, grants = ab.grants } end
  return true
end
function cartbox.ability.update(owner, dt)
  local st = state(owner)
  dt = dt or 1 / 60
  for name, left in pairs(st.ready) do st.ready[name] = math.max(0, left - dt) end
  local keep = {}
  for _, a in ipairs(st.active) do
    a.left = a.left - dt
    if a.left <= 1e-9 then for _, tag in ipairs(a.grants) do cartbox.tags.remove(owner, tag) end else keep[#keep + 1] = a end
  end
  st.active = keep
end
function cartbox.ability.cooldown(owner, ab) return state(owner).ready[ab.name] or 0 end

-- Lag compensation (N3) ---------------------------------------------------------------
-- The host records where each target's joints were, tick by tick, and tests a
-- shot against them as they were when the shooter saw them, never further back
-- than the maximum.
cartbox.rewind = {}
function cartbox.rewind.new(o) o = o or {} return { max = o.max or 0.25, keep = o.keep or 1, frames = {} } end
function cartbox.rewind.record(h, now, id, joints)
  local list = h.frames[id]
  if list == nil then list = {} h.frames[id] = list end
  local copy = {}
  for name, p in pairs(joints) do copy[name] = { p[1], p[2], p[3] } end
  list[#list + 1] = { t = now, joints = copy }
  while #list > 1 and list[1].t < now - h.keep do table.remove(list, 1) end
end
-- Joints as they were at time t (held within the maximum before now), between the two recorded frames around it.
function cartbox.rewind.at(h, id, t, now)
  local list = h.frames[id]
  if list == nil or #list == 0 then return nil end
  t = math.max(now - h.max, math.min(now, t))
  if t <= list[1].t then return list[1].joints end
  for i = #list, 1, -1 do
    local a = list[i]
    if a.t <= t then
      local b = list[i + 1]
      if b == nil or b.t <= a.t then return a.joints end
      local k = (t - a.t) / (b.t - a.t)
      local out = {}
      for name, p in pairs(a.joints) do
        local q = b.joints[name] or p
        out[name] = { p[1] + (q[1] - p[1]) * k, p[2] + (q[2] - p[2]) * k, p[3] + (q[3] - p[3]) * k }
      end
      return out
    end
  end
  return list[1].joints
end
-- A shot at the targets as the shooter saw them: each target's hitboxes placed at time t, the nearest hit.
function cartbox.rewind.ray(h, targets, t, now, ox, oy, oz, dx, dy, dz, max)
  local best, bestZone, bestD, bestM = nil, nil, max or math.huge, 1
  local ids = {}
  for id in pairs(targets) do ids[#ids + 1] = id end
  table.sort(ids, function(a, b) return tostring(a) < tostring(b) end)
  for _, id in ipairs(ids) do
    local joints = cartbox.rewind.at(h, id, t, now)
    if joints then
      local hb = targets[id]
      cartbox.hitbox.place(hb, joints)
      local zone, d, m = cartbox.hitbox.ray(hb, ox, oy, oz, dx, dy, dz, bestD)
      if zone and d < bestD then best, bestZone, bestD, bestM = id, zone, d, m end
    end
  end
  return best, bestZone, best and bestD or nil, bestM
end
end`;

/** The framework, when the cart's code names any of it. */
export function gameplayLua(code: string | null): string {
  return /cartbox\.(tags|health|damage|hitbox|ability|rewind)\b/.test(code ?? "") ? GAMEPLAY_LUA : "";
}
