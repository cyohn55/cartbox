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
    ],
  },
  {
    label: "cartbox · platform",
    open: true,
    entries: [
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
        signature: "cartbox.meshpose(index, x, y, z, yaw, pitch, roll, scale)",
        doc: "Move/rotate/scale one mesh instance by its sidecar index, on top of its authored placement (up to 8/frame; scale 0 hides).",
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
