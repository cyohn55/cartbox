/**
 * Perception (AAA_PRODUCTION_ROADMAP.md K5): what an agent sees and hears, and
 * what it remembers, written into a K4 blackboard for its tree to act on.
 *
 * Lua the player puts ahead of a cart's code (when the cart has behaviour trees
 * or names `cartbox.sense`):
 *
 * - `cartbox.sense.new{ fov = 110, range = 25, hearing = 1, memory = 4 }`
 *   makes a perceiver: a sight cone (`fov` degrees across, out to `range`
 *   metres), how keen its hearing is, and how long (seconds) it remembers.
 * - `cartbox.sense.look(p, x, y, z, fx, fy, fz, candidates)` sees, from an eye
 *   at (x, y, z) facing (fx, fy, fz), each candidate (`{ id = , x = , y = ,
 *   z = }`) inside the cone with a line of sight. Line of sight is S2's ray on
 *   the dedicated core (a candidate is visible when the ray reaches it or hits
 *   nothing); elsewhere, or with a `los` function on the perceiver, that's
 *   used instead.
 * - `cartbox.sense.noise(x, y, z, loudness, source)` makes a sound each
 *   perceiver hears once, at its next update, if it's within `loudness ×
 *   hearing` metres.
 * - `cartbox.sense.update(p, dt, x, y, z, blackboard)` hears, ages memories
 *   (a memory is dropped once older than `memory`), and writes the blackboard:
 *   `target` (the freshest memory; seen before heard when as fresh; then
 *   the nearest), `target_x/y/z`, `target_seen`, `target_age` and `alert`
 *   (1 on sight, fading to 0 over the memory).
 *
 * Everything is in order and uses only the cart's inputs, so a replay perceives
 * the same.
 */

export const PERCEPTION_LUA = `cartbox = cartbox or {}
cartbox.sense = {}
do
local noises = {}
local stamp = 0
-- Each noise is numbered; a perceiver hears those made since its last update, once.
local function cos_half(fov) return math.cos(math.rad((fov or 110) / 2)) end
function cartbox.sense.new(o)
  o = o or {}
  return { fov = o.fov or 110, range = o.range or 25, hearing = o.hearing or 1, memory = o.memory or 4, los = o.los, self = o.self, known = {}, order = {}, heardTo = stamp }
end
local function remember(p, id, x, y, z, seen)
  local m = p.known[id]
  if m == nil then m = { id = id } p.known[id] = m p.order[#p.order + 1] = id end
  m.x, m.y, m.z, m.age, m.fresh = x, y, z, 0, true
  if seen then m.seen = true end
end
local function clear(p, ex, ey, ez, c)
  if p.los then return p.los(ex, ey, ez, c.x, c.y, c.z, c.id) end
  if cartbox.ray then
    local dx, dy, dz = c.x - ex, c.y - ey, c.z - ez
    local d = math.sqrt(dx * dx + dy * dy + dz * dz)
    local hit, obj = cartbox.ray(15, ex, ey, ez, dx, dy, dz, d, p.self)
    if hit == true then return obj == c.id end
  end
  return true
end
function cartbox.sense.look(p, x, y, z, fx, fy, fz, candidates)
  local fl = math.sqrt(fx * fx + fy * fy + fz * fz)
  if fl < 1e-9 then return {} end
  fx, fy, fz = fx / fl, fy / fl, fz / fl
  local limit = cos_half(p.fov)
  local seen = {}
  for _, c in ipairs(candidates or {}) do
    local dx, dy, dz = c.x - x, c.y - y, c.z - z
    local d = math.sqrt(dx * dx + dy * dy + dz * dz)
    if d <= p.range and (d < 1e-9 or (dx * fx + dy * fy + dz * fz) / d >= limit) and clear(p, x, y, z, c) then
      remember(p, c.id, c.x, c.y, c.z, true)
      seen[#seen + 1] = c.id
    end
  end
  return seen
end
function cartbox.sense.noise(x, y, z, loudness, source)
  stamp = stamp + 1
  noises[#noises + 1] = { n = stamp, x = x, y = y, z = z, loudness = loudness or 10, source = source }
  -- Keep the last few hundred: every perceiver updating each tick has heard them by then.
  if #noises > 256 then table.remove(noises, 1) end
end
function cartbox.sense.update(p, dt, x, y, z, bb)
  dt = dt or (1 / 60)
  for _, n in ipairs(noises) do
    local dx, dy, dz = n.x - x, n.y - y, n.z - z
    if n.n > p.heardTo and n.source ~= p.self and math.sqrt(dx * dx + dy * dy + dz * dz) <= n.loudness * p.hearing then
      local id = n.source or ("noise " .. n.n)
      remember(p, id, n.x, n.y, n.z, false)
      p.known[id].heard = true
    end
  end
  p.heardTo = stamp
  -- Age everything not sensed since the last update; forget what's older than the memory.
  local keep = {}
  for _, id in ipairs(p.order) do
    local m = p.known[id]
    if m.fresh then m.fresh = false else m.age = m.age + dt end
    if m.age <= p.memory + 1e-9 then keep[#keep + 1] = id else p.known[id] = nil end
  end
  p.order = keep
  local best, bestKey = nil, nil
  for _, id in ipairs(p.order) do
    local m = p.known[id]
    local dx, dy, dz = m.x - x, m.y - y, m.z - z
    local key = { m.age, m.seen and 0 or 1, dx * dx + dy * dy + dz * dz }
    if best == nil or key[1] < bestKey[1] or (key[1] == bestKey[1] and (key[2] < bestKey[2] or (key[2] == bestKey[2] and key[3] < bestKey[3]))) then best, bestKey = m, key end
  end
  if bb then
    if best then
      bb.target, bb.target_x, bb.target_y, bb.target_z = best.id, best.x, best.y, best.z
      bb.target_seen, bb.target_age = best.seen == true and best.age == 0, best.age
      bb.alert = math.max(0, 1 - best.age / math.max(p.memory, 1e-9))
    else
      bb.target, bb.target_x, bb.target_y, bb.target_z, bb.target_seen, bb.target_age, bb.alert = nil, nil, nil, nil, false, nil, 0
    end
  end
  return best
end
end`;

/** The perception runtime, when a cart needs it (behaviour trees, or code that names cartbox.sense). */
export function perceptionLua(code: string | null, hasTrees: boolean): string {
  return hasTrees || (code ?? "").includes("cartbox.sense") ? PERCEPTION_LUA : "";
}
