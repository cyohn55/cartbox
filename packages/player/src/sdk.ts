/**
 * The cartbox SDK as an injectable string.
 *
 * Kept in sync with sdk/cartbox.lua (that file is the copy creators read/import;
 * this string is what the platform injects into carts that opt in). Both must
 * agree with the mailbox protocol in mailbox.ts (base word 119, event ring
 * capacity 8, lights block at word 144, parallax camera at 181, mesh camera at
 * 183, mesh-pose block at 191, event types 1/2/3, FNV-1a id hash).
 */

import { prependLuaCode } from "./cartseed.js";

/** Lua source of the cartbox SDK. */
export const CARTBOX_SDK_LUA = `local _MB = 119
local _CAP = 8
local _LB = _MB + 25
local _LCAP = 6
local _CB = _LB + 1 + _LCAP * 6
local _MCB = _CB + 2
local _MPB = _MCB + 8
local _MPCAP = 8
local _ln = 0
local _mn = 0
local _netq = {}
local function _netflush()
  local n = pmem(104)
  while n < 6 and #_netq > 0 do
    local e = table.remove(_netq, 1)
    pmem(105 + n * 2, e[1])
    pmem(106 + n * 2, e[2])
    n = n + 1
  end
  pmem(104, n)
end
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
  -- request(kind, value): ask the host page for something it provides (e.g. a
  -- page's matchmaking); kind and value are numbers the page defines.
  request = function(kind, value) _emit(4, (kind or 0) // 1, (value or 0) // 1) end,
  clearlights = function() _ln = 0 pmem(_LB, 0) end,
  light = function(x, y, radius, r, g, b, z, intensity)
    _light(0, x, y, z or 12, radius, r, g, b, intensity, 0, 0, 0)
  end,
  sun = function(dx, dy, dz, r, g, b, intensity)
    local nx, ny = _norm(dx or 0, dy or 0, dz or 1)
    _light(1, 0, 0, 0, 0, r, g, b, intensity, _byte(nx), _byte(ny), 0)
  end,
  -- light3d(x, y, z, radius, r, g, b, intensity): a point light in a 3D scene's
  -- world units (signed, fractional), lighting a first-person mesh view -- the
  -- 2D relight ignores it. E.g. a glow over an objective.
  light3d = function(x, y, z, radius, r, g, b, intensity)
    _light(3, (x or 0) * 64, (y or 0) * 64, (z or 0) * 64, (radius or 4) * 64, r, g, b, intensity, 0, 0, 0)
  end,
  -- sun3d(dx, dy, dz, r, g, b, intensity): the 3D scene's sun this frame, toward
  -- (dx, dy, dz) -- a time of day: it replaces the lighting rig's key light,
  -- its shadows follow, and the light probes' bounce relights (I17).
  sun3d = function(dx, dy, dz, r, g, b, intensity)
    local l = math.sqrt((dx or 0)^2 + (dy or 1)^2 + (dz or 0)^2)
    if l < 1e-6 then l = 1 end
    _light(3, (dx or 0) / l * 64, (dy or 1) / l * 64, (dz or 0) / l * 64, -64, r, g, b, intensity, 0, 0, 0)
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
  -- Drive the 3D mesh orbit camera this frame: yaw/pitch (radians), distance in
  -- world units (0 = auto-fit the scene), fov (radians, 0 = default). Call every
  -- frame; not calling leaves the player's gentle auto-orbit in charge.
  meshcam = function(yaw, pitch, dist, fov)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, 0)
    pmem(_MCB + 5, 0)
    pmem(_MCB + 6, 0)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's mesh-pose list. Call once before any meshpose() calls;
  -- instances you don't pose keep their authored transform.
  clearposes = function() _mn = 0 pmem(_MPB, 0) end,
  -- First-person mode: composite the cart's 2D frame as a HUD OVER the 3D scene,
  -- rather than drawing the meshes over the 2D (the default third-person showcase
  -- compositing). Call each frame AFTER the camera call with a truthy value to
  -- enable; near-black (index 0) pixels the cart leaves are the transparent "world"
  -- and everything else the cart draws is the HUD. Rides a spare bit of the
  -- mesh-camera flag word, so it costs no mailbox space.
  hud = function(on)
    local f = pmem(_MCB)
    if on and on ~= 0 then pmem(_MCB, f | 2) else pmem(_MCB, f & 0xfffffffd) end
  end,
  -- Move/rotate/scale one mesh instance (by its sidecar index) this frame, on top
  -- of its authored placement. x,y,z are world units; yaw (about Y), pitch (about
  -- X), roll (about Z) radians;
  -- scale defaults to 1 (pass 0 to hide). math.floor keeps every value integer so
  -- the bitwise mask never sees a float (the Pro core's Lua throws on that). Must
  -- match decodeMeshPoses() on the host.
  -- Optional extras: frame picks one of the instance's animation frames (0 = its
  -- base mesh, up to 127), tint recolours its tintable materials from the
  -- 15-colour tint palette (0 = none), and front (true/1) draws it over the
  -- whole scene — a held weapon that must never clip into a wall.
  meshpose = function(index, x, y, z, yaw, pitch, roll, scale, frame, tint, front)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    local word = math.floor(index or 0) & 0xff
    word = word | ((math.floor(frame or 0) & 0x7f) << 9) | ((math.floor(tint or 0) & 0xf) << 16)
    if front and front ~= 0 then word = word | 0x100000 end
    pmem(base, word)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 5, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 6, math.floor((roll or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- HD-2D world (optional): a cart with a world sidecar draws a 3D tile terrain
  -- and stands its 2D character sprites in it as depth-sorted billboards. The
  -- world camera and billboards reuse the mesh camera/pose mailbox channels, so
  -- no engine change is needed — these are thin aliases with the world's naming.
  --
  -- Drive the world camera this frame: yaw/pitch (radians), distance (world units,
  -- 0 = auto-fit), fov (radians, 0 = default). Optional tx,ty,tz make the camera
  -- LOOK AT that point (grid x/z units, height units for y) so it follows the
  -- player; omit them (or pass 0,0,0) to frame the whole terrain. Same mailbox
  -- layout as meshcam (target rides at _MCB+4..6).
  worldcam = function(yaw, pitch, dist, fov, tx, ty, tz)
    pmem(_MCB, 1)
    pmem(_MCB + 1, math.floor((yaw or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 2, math.floor((pitch or 0) * 1024 + 0.5) & 0xffffffff)
    pmem(_MCB + 3, math.floor((dist or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 4, math.floor((tx or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 5, math.floor((ty or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 6, math.floor((tz or 0) * 256 + 0.5) & 0xffffffff)
    pmem(_MCB + 7, math.floor((fov or 0) * 1024 + 0.5) & 0xffffffff)
  end,
  -- Start a fresh frame's billboard list. Call once before billboard() calls each
  -- frame (an alias of clearposes — they share the mesh-pose channel).
  clearbillboards = function() _mn = 0 pmem(_MPB, 0) end,
  -- Place billboard index (declared in the world sidecar) at world position
  -- (x,z grid units, y height units) this frame; scale defaults to 1 (0 hides).
  -- math.floor keeps every value integer so the bitwise mask never sees a float.
  billboard = function(index, x, y, z, scale)
    if _mn >= _MPCAP then return end
    local base = _MPB + 1 + _mn * 8
    pmem(base, math.floor(index or 0) & 0xff)
    pmem(base + 1, math.floor((x or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 2, math.floor((y or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 3, math.floor((z or 0) * 256 + 0.5) & 0xffffffff)
    pmem(base + 4, 0)
    pmem(base + 5, 0)
    pmem(base + 6, 0)
    pmem(base + 7, math.floor((scale or 1) * 256 + 0.5) & 0xffffffff)
    _mn = _mn + 1
    pmem(_MPB, _mn)
  end,
  -- stick(n) -> x, y: analog stick n (0 left, 1 right), each -1..1, y down-
  -- positive. Reads 0,0 with no sticks (keyboard); on a touchscreen the pad
  -- shows its right stick once a cart calls this. Uses pmem 68..69.
  stick = function(n)
    if pmem(69) ~= 0x53544b31 then pmem(69, 0x53544b31) end
    local w = pmem(68)
    local sh = (n == 1) and 16 or 0
    local x, y = (w >> sh) & 0xff, (w >> (sh + 8)) & 0xff
    if x >= 128 then x = x - 256 end
    if y >= 128 then y = y - 256 end
    return x / 127, y / 127
  end,
  -- Netplay (online multiplayer). The host page relays player state + events
  -- between browsers through pmem words 0..118 (so a netplay cart must not keep
  -- save data there); see packages/player/src/net/netplay.ts for the layout.
  -- net() -> mode (0 offline, 1 client, 2 host), my slot, humans mask, match word,
  -- the page's status code (0 idle; the page defines the rest, e.g. searching),
  -- and the host's slot (slots stick, so after a host leaves it may not be 0)
  net = function()
    local h = pmem(0)
    return h & 3, (h >> 2) & 7, (h >> 8) & 0xff, pmem(1), (h >> 5) & 7, pmem(66) & 7
  end,
  -- netclock() -> the room's shared clock, ms (the host's clock; every player
  -- keeps theirs on it by ping), and the view lag: how old the others'
  -- snapshots are when they arrive. Draw them at clock - lag - a buffer.
  netclock = function() return pmem(2), ((pmem(0) >> 24) & 0xff) * 4 end,
  -- netpeer(slot) -> the slot's 4 state words, whether they are live, and when
  -- they were taken on the shared clock (ms) -- to draw it between snapshots
  netpeer = function(slot)
    local b = 3 + slot * 4
    local clock = pmem(2)
    local half = (pmem(35 + (slot >> 1)) >> ((slot & 1) * 16)) & 0xffff
    return pmem(b), pmem(b + 1), pmem(b + 2), pmem(b + 3), ((pmem(0) >> 16) & (1 << slot)) ~= 0,
      clock - ((clock - half) & 0xffff)
  end,
  -- netpublish(slot, a, b, c, d): publish a slot's state this tick (your own, or
  -- a bot's when you are the host)
  netpublish = function(slot, a, b, c, d)
    local base = 72 + slot * 4
    pmem(base, math.floor(a or 0) & 0xffffffff)
    pmem(base + 1, math.floor(b or 0) & 0xffffffff)
    pmem(base + 2, math.floor(c or 0) & 0xffffffff)
    pmem(base + 3, math.floor(d or 0) & 0xffffffff)
    pmem(70, pmem(70) | (1 << slot))
    _netflush()
  end,
  -- netmatch(word): the host's shared game-state word (clients read it via net())
  netmatch = function(w) pmem(71, math.floor(w or 0) & 0xffffffff) end,
  -- netsend(a, b): broadcast a 2-word event to every other player. Six go out a
  -- tick; the rest wait their turn (up to 64), sent on the next netsend or netpublish.
  netsend = function(a, b)
    if #_netq >= 64 then return false end
    _netq[#_netq + 1] = { math.floor(a or 0) & 0xffffffff, math.floor(b or 0) & 0xffffffff }
    _netflush()
    return true
  end,
  -- netevents() -> this tick's incoming events, as a list of {a, b, from}: from
  -- is the slot that sent it (the host is slot 0), for telling its word apart
  netevents = function()
    local n = pmem(39)
    local out = {}
    for i = 0, n - 1 do
      local from = (pmem(i < 10 and 64 or 65) >> ((i % 10) * 3)) & 7
      out[#out + 1] = { pmem(40 + i * 2), pmem(41 + i * 2), from }
    end
    return out
  end,
  -- Collision defaults: overridden by the injected layer when the cart has one,
  -- so cartbox.solid/mapsize are always safe to call (a cart with no collision
  -- layer simply sees every cell as non-solid).
  solid = function() return false end,
  mapsize = function() return 0, 0 end,
  -- Tile-flags default: overridden by the injected layer when the cart has one.
  flag = function() return false end,
  -- Scene objects (the cart's placed meshes by name, with parents, tags and
  -- properties): overridden by the injected scene table when the cart has meshes.
  -- An object is the 0-based index cartbox.meshpose takes, or its name.
  objects = function() return 0 end,
  find = function() return nil end,
  objname = function() return nil end,
  parent = function() return nil end,
  children = function() return {} end,
  prop = function(_, _, default) return default end,
  hastag = function() return false end,
  tagged = function() return {} end,
  -- Physics (bodies on scene objects): overridden by the injected physics calls
  -- when the cart has bodies.
  physics = function() return false end,
  body = function() return nil end,
  impulse = function() end,
  velocity = function() end,
  teleport = function() end,
  move = function() end,
  ray = function() end,
  sweep = function() end,
  hit = function() return false end,
  contacts = function() return {} end,
  entered = function() return {} end,
  exited = function() return {} end,
  inside = function() return {} end,
  motor = function() end,
  unjoin = function() end,
  physicshash = function() return 0 end,
  -- Spawning prefab copies: overridden when the cart has prefabs.
  spawn = function() return nil end,
  despawn = function() end,
  alive = function() return false end,
  -- Skeletal animation: overridden when the scene has skinned objects.
  play = function() end,
  anim = function() return nil, 0, false end,
  clips = function() return {} end,
  set = function() end,
  trigger = function() end,
  state = function() return nil end,
  setstate = function() end,
  events = function() return {} end,
  ik = function() end,
  lookat = function() end,
  ragdoll = function() end,
  unragdoll = function() end,
  shield = function() end,
  joint = function() return nil end,
  joints = function() return {} end,
  playtimeline = function() end,
  stoptimeline = function() end,
  timeline = function() return nil, 0, false end,
  timelineevents = function() return {} end,
  -- Navigation agents: overridden when the scene has a baked walkable surface.
  agent = function() end,
  obstacle = function() end,
  moveto = function() end,
  stopagent = function() end,
  removeagent = function() end,
  agentpos = function() return nil end,
  navigable = function() return false end,
  -- Spatial loading's focus: overridden when the scene streams by distance.
  streamfocus = function() end,
  burst = function() end,
  decal = function() end,
  decals = function() return {} end,
  debris = function() end,
  debrislist = function() return {} end,
  -- Sound: overridden when the scene has sounds.
  sound = function() end,
  loop = function() end,
  mix = function() end,
  sounds = function() return {} end,
  -- UI documents (EP13): replaced when the cart has any.
  ui = {
    set = function() end, get = function() return nil end,
    show = function() end, hide = function() end, shown = function() return false end,
    focus = function() end, focused = function() return nil end,
    select = function() end, selected = function() return 1 end,
    on = function() end, update = function() return nil end, draw = function() end,
  },
  effects = function() return {} end,
  -- Timeline values (EP17): replaced when the scene's timelines have value tracks.
  timelinevalue = function() return nil end,
  -- Save data (EP15b): replaced when the host keeps saves.
  save = function() return false, "saves are off here" end,
  load = function() return nil end,
  erase = function() end,
  -- Input actions (EP15): replaced when the cart has any.
  action = function() return false end,
  actionp = function() return false end,
  actionr = function() return false end,
  actions = function() return {} end,
  actionlabel = function() return "" end,
  -- Placing objects (EP14): live once the scene has the runtime.
  place = function() end,
  -- Components (EP14): replaced when any object has one.
  component = function() return nil end,
  -- Localisation (EP19b): replaced when the cart has a string table.
  text = function(k, ...)
    local a = {...}
    local t = type(a[1]) == "table" and a[1] or nil
    return (string.gsub(tostring(k), "{(%w+)}", function(n)
      local v
      if tonumber(n) then v = a[tonumber(n)] elseif t then v = t[n] end
      if v == nil then return nil end
      return tostring(v)
    end))
  end,
  language = function() return nil end,
  languages = function() return {} end,
  setlanguage = function() return false end,
  -- Accessibility (EP19b): replaced when the player has set any.
  textscale = function() return 1 end,
  colorfilter = function() return "none" end,
}`;

/** Injects the cartbox SDK into a Lua cart (returns non-Lua carts unchanged). */
export function injectSdk(bytes: Uint8Array): Uint8Array {
  return prependLuaCode(bytes, CARTBOX_SDK_LUA);
}
