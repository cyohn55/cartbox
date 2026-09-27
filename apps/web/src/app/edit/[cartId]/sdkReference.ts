/**
 * The in-editor API reference for cartridge code — the single source of truth the
 * Code tab's reference panel reads.
 *
 * It covers two surfaces a creator needs but the editor otherwise never exposes:
 * the platform's own `cartbox.*` SDK (lighting, collision, achievements — none of
 * which are discoverable without reading the repo), and a curated slice of the
 * TIC-80 built-ins carts are actually written against. Each entry carries a
 * signature and a one-line doc for scanning, plus an insertable snippet so the
 * panel can drop working code at the caret. Kept as plain data (no React) so it is
 * trivially unit-testable and can back autocomplete later.
 */

/** One callable a cart can use, as the reference panel renders and inserts it. */
export interface SdkEntry {
  /** The name shown in the list, e.g. `cartbox.solid`. */
  readonly name: string;
  /** The call signature, e.g. `cartbox.solid(cx, cy) -> bool`. */
  readonly signature: string;
  /** One line: what it does / when to reach for it. */
  readonly doc: string;
  /** Code inserted at the caret when the entry is chosen. */
  readonly snippet: string;
}

/** A titled group of related entries. */
export interface SdkGroup {
  readonly label: string;
  /** Whether the group is open by default — the cartbox APIs are, TIC-80 is not. */
  readonly open: boolean;
  readonly entries: readonly SdkEntry[];
}

export const SDK_REFERENCE: readonly SdkGroup[] = [
  {
    label: "cartbox · collision & flags",
    open: true,
    entries: [
      {
        name: "cartbox.solid",
        signature: "cartbox.solid(cx, cy) -> bool",
        doc: "Is map cell (cx, cy) solid in the cart's collision layer? False out of bounds.",
        snippet: "cartbox.solid(cx, cy)",
      },
      {
        name: "cartbox.mapsize",
        signature: "cartbox.mapsize() -> w, h",
        doc: "The collision grid size in cells (0, 0 when no layer is authored).",
        snippet: "local mw, mh = cartbox.mapsize()",
      },
      {
        name: "cartbox.flag",
        signature: "cartbox.flag(cx, cy, n) -> bool",
        doc: "Is gameplay flag n (0..7) set on cell (cx, cy)? Tag cells in the Map tab's Flags layer.",
        snippet: "cartbox.flag(cx, cy, 0)",
      },
    ],
  },
  {
    label: "cartbox · lighting",
    open: true,
    entries: [
      {
        name: "cartbox.clearlights",
        signature: "cartbox.clearlights()",
        doc: "Start a fresh frame's light list. Call once at the top of TIC().",
        snippet: "cartbox.clearlights()",
      },
      {
        name: "cartbox.light",
        signature: "cartbox.light(x, y, radius, r, g, b, z, intensity)",
        doc: "An omnidirectional point light in framebuffer pixels (up to 6 lights/frame).",
        snippet: "cartbox.light(px, py, 90, 255, 180, 90)",
      },
      {
        name: "cartbox.sun",
        signature: "cartbox.sun(dx, dy, dz, r, g, b, intensity)",
        doc: "A distant directional key (sun/moon); dx,dy,dz point TOWARD the light, dz>0.",
        snippet: "cartbox.sun(-0.4, -0.6, 0.7, 120, 140, 210, 0.9)",
      },
      {
        name: "cartbox.spot",
        signature: "cartbox.spot(x, y, z, dx, dy, dz, radius, angle, r, g, b, intensity)",
        doc: "A cone light from (x,y,z) along dx,dy,dz; angle is the inner half-angle in degrees.",
        snippet: "cartbox.spot(200, 20, 40, 0.2, 1, 0.3, 140, 22, 255, 210, 150)",
      },
      {
        name: "cartbox.light3d",
        signature: "cartbox.light3d(x, y, z, radius, r, g, b, intensity)",
        doc: "A point light in a first-person 3D scene's world units (not the 2D relight): an objective's glow, a flash.",
        snippet: "cartbox.light3d(0, 1, 0, 5, 120, 255, 150, 2)",
      },
    ],
  },
  {
    label: "cartbox · platform",
    open: true,
    entries: [
      {
        name: "cartbox.stick",
        signature: "cartbox.stick(n) -> x, y",
        doc: "Analog stick n (0 left, 1 right) as -1..1 each (y down-positive). The touch pad's sticks; 0,0 on a keyboard, so keep a button fallback.",
        snippet: "local lx, ly = cartbox.stick(0)",
      },
      {
        name: "cartbox.score",
        signature: "cartbox.score(value)",
        doc: "Post a score to the leaderboard (best of the run is kept).",
        snippet: "cartbox.score(points)",
      },
      {
        name: "cartbox.unlock",
        signature: 'cartbox.unlock("id")',
        doc: "Fire an achievement by id.",
        snippet: 'cartbox.unlock("first_blood")',
      },
      {
        name: "cartbox.progress",
        signature: 'cartbox.progress("id", value)',
        doc: "Update a tracked stat.",
        snippet: 'cartbox.progress("distance", 120)',
      },
      {
        name: "cartbox.camera",
        signature: "cartbox.camera(x, y)",
        doc: "Pan the parallax backdrop (scene carts): x,y are added to the scene's auto-scroll.",
        snippet: "cartbox.camera(worldX, 0)",
      },
      {
        name: "cartbox.meshcam",
        signature: "cartbox.meshcam(yaw, pitch, distance, fov)",
        doc: "Drive the 3D mesh orbit camera (mesh carts): radians + world units; 0 = auto-fit / default. Replaces the auto-orbit.",
        snippet: "cartbox.meshcam(t / 60, 0.4, 0)",
      },
      {
        name: "cartbox.clearposes",
        signature: "cartbox.clearposes()",
        doc: "Start a fresh frame's mesh-pose list. Call once before any meshpose() calls.",
        snippet: "cartbox.clearposes()",
      },
      {
        name: "cartbox.meshpose",
        signature: "cartbox.meshpose(index, x, y, z, yaw, pitch, roll, scale, frame, tint, front)",
        doc: "Move/rotate/scale one mesh instance by its sidecar index, on top of its authored placement (up to 8/frame; scale 0 hides). Yaw turns about Y, pitch about X, roll about Z. Optional: frame picks an animation frame (0 = base mesh), tint (1-15) recolours its tintable materials, front draws it over the whole scene (a held weapon).",
        snippet: "cartbox.meshpose(0, 0, 0, 0, t / 30, 0, 0)",
      },
      {
        name: "cartbox.worldcam",
        signature: "cartbox.worldcam(yaw, pitch, distance, fov)",
        doc: "Drive the HD-2D world camera (World tab carts): radians + world units; 0 = auto-fit/default. Call each frame.",
        snippet: "cartbox.worldcam(t / 200, 0.62, 0)",
      },
      {
        name: "cartbox.clearbillboards",
        signature: "cartbox.clearbillboards()",
        doc: "Start a fresh frame's billboard list. Call once before any billboard() calls each frame.",
        snippet: "cartbox.clearbillboards()",
      },
      {
        name: "cartbox.billboard",
        signature: "cartbox.billboard(index, x, y, z, scale)",
        doc: "Stand billboard `index` (a 2D character declared in the World tab) at world position (x,z grid, y height); scale 0 hides. Occludes correctly against the 3D terrain.",
        snippet: "cartbox.billboard(0, px, 0, pz)",
      },
      {
        name: "cartbox.clip",
        signature: "cartbox.clip(name, tick) -> id, w, h",
        doc: "Current frame of an Anim-tab sprite clip at `tick` (your frame counter): returns the sprite id + size in tiles. Draw it with spr(id, x, y, key, 1, flip, 0, w, h).",
        snippet: 'local id, w, h = cartbox.clip("walk", t)',
      },
    ],
  },
  {
    label: "cartbox · scene objects",
    open: false,
    entries: [
      {
        name: "cartbox.find",
        signature: "cartbox.find(name) -> index",
        doc: "The placed mesh named `name` in the Hierarchy, as the index cartbox.meshpose takes (nil if none). Moving a parent moves its children too.",
        snippet: 'local door = cartbox.find("door")\ncartbox.meshpose(door, 0, 0, 0, t / 60)',
      },
      {
        name: "cartbox.prop",
        signature: "cartbox.prop(obj, key, default) -> value",
        doc: "A custom property set on an object in the Inspector (number, text or true/false), or `default`. `obj` is an index or a name.",
        snippet: 'local hp = cartbox.prop("crate", "hp", 10)',
      },
      {
        name: "cartbox.tagged",
        signature: "cartbox.tagged(tag) -> { index, ... }",
        doc: "Every object carrying `tag`, in Hierarchy order.",
        snippet: 'for _, i in ipairs(cartbox.tagged("pickup")) do\n  \nend',
      },
      {
        name: "cartbox.hastag",
        signature: "cartbox.hastag(obj, tag) -> bool",
        doc: "Whether an object carries `tag`.",
        snippet: 'if cartbox.hastag(i, "enemy") then\n  \nend',
      },
      {
        name: "cartbox.objname",
        signature: "cartbox.objname(obj) -> name",
        doc: "An object's name.",
        snippet: "local name = cartbox.objname(i)",
      },
      {
        name: "cartbox.parent",
        signature: "cartbox.parent(obj) -> index",
        doc: "An object's parent index, or nil for a top-level object.",
        snippet: "local p = cartbox.parent(i)",
      },
      {
        name: "cartbox.children",
        signature: "cartbox.children(obj) -> { index, ... }",
        doc: "An object's direct children.",
        snippet: 'for _, c in ipairs(cartbox.children("tower")) do\n  \nend',
      },
      {
        name: "cartbox.spawn",
        signature: "cartbox.spawn(prefab, x, y, z, yaw, pitch, roll) -> obj",
        doc: "Place a copy of a prefab in the world (angles in radians) and get its root object, or nil when all its reserve copies are out. Set how many copies a prefab keeps in the Prefabs list.",
        snippet: 'local crate = cartbox.spawn("Crate", x, 5, z)',
      },
      {
        name: "cartbox.despawn",
        signature: "cartbox.despawn(obj)",
        doc: "Take a spawned copy out of the world and back into reserve.",
        snippet: "cartbox.despawn(crate)",
      },
      {
        name: "cartbox.alive",
        signature: "cartbox.alive(obj) -> bool",
        doc: "Whether a prefab copy is currently spawned.",
        snippet: "if cartbox.alive(crate) then\n  \nend",
      },
      {
        name: "cartbox.objects",
        signature: "cartbox.objects() -> count",
        doc: "How many placed objects the cart has (indices run 0 .. count - 1).",
        snippet: "for i = 0, cartbox.objects() - 1 do\n  \nend",
      },
    ],
  },
  {
    label: "cartbox · physics",
    open: false,
    entries: [
      {
        name: "cartbox.body",
        signature: "cartbox.body(obj) -> x, y, z, vx, vy, vz, grounded",
        doc: "A physics body's position and velocity after the last step (set a body on the object in the Inspector). grounded is for characters.",
        snippet: 'local x, y, z, vx, vy, vz, grounded = cartbox.body("crate")',
      },
      {
        name: "cartbox.impulse",
        signature: "cartbox.impulse(obj, x, y, z)",
        doc: "Push a dynamic body: an instant change of momentum (heavier bodies move less).",
        snippet: 'cartbox.impulse("ball", 0, 5, 0)',
      },
      {
        name: "cartbox.velocity",
        signature: "cartbox.velocity(obj, x, y, z)",
        doc: "Set a dynamic or kinematic body's velocity (units per second). Kinematic bodies push dynamic ones.",
        snippet: 'cartbox.velocity("lift", 0, 1, 0)',
      },
      {
        name: "cartbox.teleport",
        signature: "cartbox.teleport(obj, x, y, z)",
        doc: "Move a body to a position at once.",
        snippet: 'cartbox.teleport("player", 0, 2, 0)',
      },
      {
        name: "cartbox.move",
        signature: "cartbox.move(obj, dx, dy, dz)",
        doc: "Walk a character body this tick: slides along walls, climbs slopes and steps. Add your own gravity to dy; cartbox.body reports grounded.",
        snippet: 'vy = grounded and 0 or vy - 0.01\ncartbox.move("player", dx, vy, dz)',
      },
      {
        name: "cartbox.ray",
        signature: "cartbox.ray(slot, x, y, z, dx, dy, dz, max, ignore)",
        doc: "Cast a ray from (x,y,z) along (dx,dy,dz) up to max units in slot 0-15. The result is ready next tick via cartbox.hit(slot). ignore (optional) is an object the ray passes through, such as the player casting it.",
        snippet: 'cartbox.ray(0, x, y, z, 0, -1, 0, 50, "player")',
      },
      {
        name: "cartbox.sweep",
        signature: "cartbox.sweep(slot, shape, x, y, z, dx, dy, dz, max, ignore)",
        doc: "Like cartbox.ray, but sweeps a solid shape: a number is a sphere's radius, {hx, hy, hz} a box's half-extents, {radius, halfheight} an upright capsule. cartbox.hit(slot) then gives the surface point touched, its normal, and how far the shape's centre travelled first. Use it for thick bullets, ledge and landing checks, or whether a body fits somewhere.",
        snippet: 'cartbox.sweep(0, 0.4, x, y, z, 0, -1, 0, 5, "player")\nlocal hit, obj, hx, hy, hz, nx, ny, nz, d = cartbox.hit(0)',
      },
      {
        name: "cartbox.hit",
        signature: "cartbox.hit(slot) -> hit, obj, x, y, z, nx, ny, nz, distance",
        doc: "Last tick's result for a ray slot: whether it hit, the object it hit (nil if not a scene object), the point, the surface normal and the distance.",
        snippet: "local hit, obj, hx, hy, hz = cartbox.hit(0)",
      },
      {
        name: "cartbox.entered",
        signature: "cartbox.entered(trigger) -> { obj, ... }",
        doc: "Objects that came into a trigger zone this tick (tick Trigger on the object's Physics in the Inspector).",
        snippet: 'for _, o in ipairs(cartbox.entered("goal")) do\n  \nend',
      },
      {
        name: "cartbox.exited",
        signature: "cartbox.exited(trigger) -> { obj, ... }",
        doc: "Objects that left a trigger zone this tick.",
        snippet: 'for _, o in ipairs(cartbox.exited("goal")) do\n  \nend',
      },
      {
        name: "cartbox.inside",
        signature: "cartbox.inside(trigger) -> { obj, ... }",
        doc: "Every object in a trigger zone right now.",
        snippet: 'local n = #cartbox.inside("zone")',
      },
      {
        name: "cartbox.contacts",
        signature: "cartbox.contacts() -> { {a=, b=, started=, trigger=}, ... }",
        doc: "Every contact that began (started = true) or ended this tick between two objects; trigger is true for trigger-zone overlaps.",
        snippet: "for _, c in ipairs(cartbox.contacts()) do\n  if c.started then\n    \n  end\nend",
      },
      {
        name: "cartbox.motor",
        signature: "cartbox.motor(obj, speed, force)",
        doc: "Drive an object's hinge joint (set on its Physics in the Inspector) at speed radians per second, pushing with at most force (default 1000). Speed 0 holds it still; cartbox.motor(obj) turns the motor off so it swings freely.",
        snippet: 'cartbox.motor("wheel", 6)',
      },
      {
        name: "cartbox.unjoin",
        signature: "cartbox.unjoin(obj)",
        doc: "Break an object's joint: a hinged door comes off, a hanging lamp falls. A prefab copy gets its joints back when it's spawned again.",
        snippet: 'cartbox.unjoin("lamp")',
      },
      {
        name: "cartbox.physicshash",
        signature: "cartbox.physicshash() -> n",
        doc: "A 32-bit digest of every moving body's exact state after the last step. With Deterministic physics on (Mesh tab, Physics world) it matches on every machine running the same inputs — publish it over netplay to catch a desync.",
        snippet: "local h = cartbox.physicshash()",
      },
      {
        name: "cartbox.physics",
        signature: "cartbox.physics() -> bool",
        doc: "Whether the cart's physics is running (false in carts without bodies).",
        snippet: "if cartbox.physics() then\n  \nend",
      },
    ],
  },
  {
    label: "cartbox · animation",
    open: false,
    entries: [
      {
        name: "cartbox.play",
        signature: "cartbox.play(obj, clip, fade, speed, loop)",
        doc: "Play a skinned object's animation clip (a glTF imported with a skeleton and animations): clip is its name or 0-based index, nil for the rest pose. Crossfades from the current clip over fade seconds (default 0.2); speed 1 and loop true by default. Until told otherwise each skinned object loops its first clip.",
        snippet: 'cartbox.play("hero", "run", 0.2)',
      },
      {
        name: "cartbox.anim",
        signature: "cartbox.anim(obj) -> clip, time, finished",
        doc: "What a skinned object is playing: the clip's name (nil at rest), seconds into it, and whether a non-looping clip has reached its end.",
        snippet: 'local clip, t, done = cartbox.anim("hero")',
      },
      {
        name: "cartbox.clips",
        signature: "cartbox.clips(obj) -> { name, ... }",
        doc: "The names of a skinned object's animation clips, in order (index 0 first).",
        snippet: 'for i, name in ipairs(cartbox.clips("hero")) do\n  \nend',
      },
      {
        name: "cartbox.set",
        signature: "cartbox.set(obj, param, value)",
        doc: "Set a number or bool parameter of a skinned object's state machine (Mesh tab → State machine); transitions whose conditions now hold fire on this tick.",
        snippet: 'cartbox.set("hero", "speed", math.abs(vx))',
      },
      {
        name: "cartbox.trigger",
        signature: "cartbox.trigger(obj, param)",
        doc: "Fire a trigger parameter: it stays set until a transition that tests it fires (and uses it up).",
        snippet: 'if btnp(4) then cartbox.trigger("hero", "shoot") end',
      },
      {
        name: "cartbox.state",
        signature: "cartbox.state(obj) -> name",
        doc: "The state machine's current state (nil while cartbox.play has taken direct control).",
        snippet: 'if cartbox.state("hero") == "shoot" then\n  \nend',
      },
      {
        name: "cartbox.setstate",
        signature: "cartbox.setstate(obj, state, fade)",
        doc: "Jump to a state (crossfading over fade seconds, default 0.2) — also hands control back to the machine after cartbox.play.",
        snippet: 'cartbox.setstate("hero", "idle")',
      },
      {
        name: "cartbox.events",
        signature: "cartbox.events(obj) -> { name, ... }",
        doc: "Clip events (named moments set up in the state machine, e.g. a footstep) that the playhead passed on the last tick.",
        snippet: 'for _, e in ipairs(cartbox.events("hero")) do\n  if e == "step" then sfx(1) end\nend',
      },
      {
        name: "cartbox.ik",
        signature: "cartbox.ik(obj, joint, x, y, z, weight, px, py, pz)",
        doc: "Two-bone inverse kinematics on top of the animation: bend the chain that ends at joint (e.g. a foot: foot, knee, hip) so it reaches the world point x, y, z; the middle joint bends toward the pole px, py, pz when given. weight 0..1 blends it in (default 1); the request stands until repeated, and weight 0 lets go.",
        snippet: 'local hit, _, hx, hy, hz = cartbox.hit(0)\nif hit then cartbox.ik("hero", "foot_l", hx, hy, hz, 1) end',
      },
      {
        name: "cartbox.lookat",
        signature: "cartbox.lookat(obj, joint, x, y, z, weight, maxdeg)",
        doc: "Turn a joint (a head, a spine) toward the world point x, y, z by at most maxdeg degrees (default 60) — the way it faced the model's front at rest swings to the target. Stands until repeated; weight 0 lets go.",
        snippet: 'cartbox.lookat("guard", "head", px, py + 1.6, pz, 1, 70)',
      },
      {
        name: "cartbox.joint",
        signature: "cartbox.joint(obj, joint) -> x, y, z",
        doc: "Where a joint is in the world after animation and IK — to cast a ray down from a foot, or put a muzzle flash at a hand. nil until the tick after you first ask.",
        snippet: 'local hx, hy, hz = cartbox.joint("hero", "hand_r")',
      },
      {
        name: "cartbox.joints",
        signature: "cartbox.joints(obj) -> { name, ... }",
        doc: "The names of a skinned object's joints, in order (a joint can also be given by its 0-based index).",
        snippet: 'for i, name in ipairs(cartbox.joints("hero")) do\n  trace(name)\nend',
      },
    ],
  },
  {
    label: "cartbox · timelines",
    open: false,
    entries: [
      {
        name: "cartbox.playtimeline",
        signature: "cartbox.playtimeline(name, from, speed)",
        doc: "Play a timeline made in the Mesh tab (a cutscene or camera move) from `from` seconds (default 0) at `speed` (default 1). While it plays it has the camera and places the objects it moves; its animation cues start clips or states.",
        snippet: 'cartbox.playtimeline("intro")',
      },
      {
        name: "cartbox.stoptimeline",
        signature: "cartbox.stoptimeline()",
        doc: "Stop the timeline: the camera and objects go back to the game (use it to skip a cutscene, or to let go of one that holds its last frame).",
        snippet: "if btnp(4) then cartbox.stoptimeline() end",
      },
      {
        name: "cartbox.timeline",
        signature: "cartbox.timeline() -> name, time, playing",
        doc: "The timeline playing (nil when none), seconds into it, and whether it is still playing (false once one that holds has ended).",
        snippet: "local name, t, playing = cartbox.timeline()",
      },
      {
        name: "cartbox.timelineevents",
        signature: "cartbox.timelineevents() -> { name, ... }",
        doc: "The playing timeline's events that passed on the last tick — cue a line of dialogue, a sound, or the game starting.",
        snippet: 'for _, e in ipairs(cartbox.timelineevents()) do\n  if e == "done" then state = "play" end\nend',
      },
    ],
  },
  {
    label: "cartbox · netplay",
    open: false,
    entries: [
      {
        name: "cartbox.net",
        signature: "cartbox.net() -> mode, slot, humans, match",
        doc: "Online multiplayer (a page opened with netplay relays it; uses pmem 0..118). mode 0 offline / 1 guest / 2 host, your slot 0-7, a bitmask of slots held by people, and the host's match word.",
        snippet: "local mode, slot, humans, match = cartbox.net()",
      },
      {
        name: "cartbox.netpeer",
        signature: "cartbox.netpeer(slot) -> a, b, c, live",
        doc: "Another slot's 3 state words as its owner last published them, and whether they are fresh.",
        snippet: "local a, b, c, live = cartbox.netpeer(1)",
      },
      {
        name: "cartbox.netpublish",
        signature: "cartbox.netpublish(slot, a, b, c)",
        doc: "Publish a slot's state this tick: your own, or (as host) the bots you simulate. Sent ~15 times a second.",
        snippet: "cartbox.netpublish(slot, x, y, hp)",
      },
      {
        name: "cartbox.netsend",
        signature: "cartbox.netsend(a, b) -> ok",
        doc: "Broadcast a 2-word event (a hit, a kill) to every other player at once; up to 10 a tick.",
        snippet: "cartbox.netsend(1, 0)",
      },
      {
        name: "cartbox.netevents",
        signature: "cartbox.netevents() -> { {a, b}, ... }",
        doc: "This tick's events from the other players.",
        snippet: "for _, ev in ipairs(cartbox.netevents()) do\n  \nend",
      },
      {
        name: "cartbox.netmatch",
        signature: "cartbox.netmatch(word)",
        doc: "As host, set the shared match word (game type, phase) the guests read from net().",
        snippet: "cartbox.netmatch(0)",
      },
    ],
  },
  {
    label: "TIC-80 · loop",
    open: false,
    entries: [
      {
        name: "TIC",
        signature: "function TIC() ... end",
        doc: "The main loop — called 60 times a second. Every cart needs one.",
        snippet: "function TIC()\n  cls(0)\n  \nend",
      },
      {
        name: "BOOT",
        signature: "function BOOT() ... end",
        doc: "Runs once at startup — set up state here before TIC() takes over.",
        snippet: "function BOOT()\n  \nend",
      },
    ],
  },
  {
    label: "TIC-80 · draw",
    open: false,
    entries: [
      { name: "cls", signature: "cls(color)", doc: "Clear the screen to a palette colour.", snippet: "cls(0)" },
      {
        name: "spr",
        signature: "spr(id, x, y, colorkey, scale, flip, rotate, w, h)",
        doc: "Draw sprite id at (x, y). colorkey -1 draws every pixel.",
        snippet: "spr(id, x, y, 0)",
      },
      {
        name: "map",
        signature: "map(x, y, w, h, sx, sy, colorkey)",
        doc: "Draw a region of the tile map to the screen.",
        snippet: "map(0, 0, 30, 17, 0, 0)",
      },
      {
        name: "print",
        signature: "print(text, x, y, color, fixed, scale, smallfont)",
        doc: "Draw text with the system font; returns the pixel width.",
        snippet: 'print("hello", 8, 8, 15)',
      },
      { name: "rect", signature: "rect(x, y, w, h, color)", doc: "Draw a filled rectangle.", snippet: "rect(x, y, w, h, 12)" },
      { name: "rectb", signature: "rectb(x, y, w, h, color)", doc: "Draw a rectangle outline.", snippet: "rectb(x, y, w, h, 12)" },
      { name: "circ", signature: "circ(x, y, radius, color)", doc: "Draw a filled circle.", snippet: "circ(x, y, r, 12)" },
      { name: "line", signature: "line(x0, y0, x1, y1, color)", doc: "Draw a line between two points.", snippet: "line(x0, y0, x1, y1, 12)" },
      { name: "pix", signature: "pix(x, y, color)", doc: "Set (or, with no color, read) one pixel.", snippet: "pix(x, y, 12)" },
    ],
  },
  {
    label: "TIC-80 · input",
    open: false,
    entries: [
      {
        name: "btn",
        signature: "btn(id) -> bool",
        doc: "Is button id held? 0..3 = up/down/left/right, 4/5 = A/B on player 1.",
        snippet: "btn(0)",
      },
      { name: "btnp", signature: "btnp(id, hold, period) -> bool", doc: "Was button id just pressed this frame?", snippet: "btnp(4)" },
      { name: "key", signature: "key(code) -> bool", doc: "Is keyboard key `code` held?", snippet: "key(1)" },
      { name: "keyp", signature: "keyp(code, hold, period) -> bool", doc: "Was key `code` just pressed?", snippet: "keyp(1)" },
      { name: "mouse", signature: "mouse() -> x, y, left, middle, right, sx, sy", doc: "Read the pointer position and buttons.", snippet: "local mx, my, md = mouse()" },
    ],
  },
  {
    label: "TIC-80 · map & sound",
    open: false,
    entries: [
      { name: "mget", signature: "mget(cx, cy) -> id", doc: "Read the tile id at map cell (cx, cy).", snippet: "mget(cx, cy)" },
      { name: "mset", signature: "mset(cx, cy, id)", doc: "Set the tile id at map cell (cx, cy).", snippet: "mset(cx, cy, id)" },
      { name: "sfx", signature: "sfx(id, note, duration, channel, volume, speed)", doc: "Play a sound effect.", snippet: "sfx(0)" },
      { name: "music", signature: "music(track, frame, row, loop)", doc: "Play a music track (music(-1) stops).", snippet: "music(0)" },
    ],
  },
  {
    label: "TIC-80 · util",
    open: false,
    entries: [
      { name: "time", signature: "time() -> ms", doc: "Milliseconds since the cart started.", snippet: "time()" },
      { name: "trace", signature: 'trace(message, color)', doc: "Print to the console log (debugging).", snippet: 'trace("here")' },
      { name: "math.random", signature: "math.random(m, n) -> int", doc: "A random integer in [m, n] (Lua standard library).", snippet: "math.random(1, 6)" },
    ],
  },
];
