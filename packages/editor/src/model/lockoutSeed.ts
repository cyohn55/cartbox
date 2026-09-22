/**
 * The "Lockout arena" starter — a Halo 2 Lockout-inspired first-person arena for
 * the Xbox 360 model, and the cart that shows off the editor's newest 3D features:
 * **PBR metallic-roughness** surfaces (glossy Forerunner metal, cyan **emissive**
 * energy) **normal-mapped** for panel relief, lit by an authored **scene lighting
 * rig** — a cool image-based-lighting skybox, a directional key + fill, a cyan
 * point light in the Sword pit, ACES tone mapping and directional **shadows**.
 * This is the Modern (AAA) tier: the metals reflect the sky and the energy glows
 * and rolls off through the tone-map curve, rather than the flat option-2 shading
 * the cart shipped with before.
 *
 * Hard truths this cart is built around:
 *  - Cartbox has no networking, so "8 players" is you + 7 AI bots, one local match.
 *  - The web player forwards only 8 gamepad buttons to a cart (arrows + Z/X/A/S) —
 *    no keyboard or mouse passthrough — so the controls are a single-stick console
 *    FPS: tank move + turn, a strafe modifier, and vertical auto-aim.
 *  - A software-rasterised fantasy console can't match real Halo 2 fidelity; this
 *    is a stylised Forerunner homage that pushes the engine's lighting hard.
 *
 * The camera is first-person via a trick: the mesh renderer exposes only an orbit
 * camera, so the cart moves that orbit *target* (the `worldcam` alias writes the
 * same mailbox slot the mesh camera reads) and inverse-solves the orbit angles so
 * the eye lands exactly on the player. The offset is relative to the scene centre,
 * so the geometry is symmetric in X/Z and the bots are authored at the origin,
 * making that centre the known constant a test pins against the runtime bounds.
 */

import type { CartEngine } from "../engine/CartEngine";
import { encodeRgbaPng } from "./png";
import { serializeMeshAsset, type EncodedImage, type MeshAsset, type MeshPrimitive } from "./MeshAsset";
import type { SceneLighting } from "./SceneLighting";
import { newStreams, pushBox, toPrimitive, type Streams } from "./seedGeometry";

/** An axis-aligned box: centre (cx,cy,cz) and half-extents (hx,hy,hz). */
type Box = readonly [number, number, number, number, number, number];

// --- The Forerunner texture set -------------------------------------------
// One 128x128 texture, painted procedurally, baked into the glTF-style PBR maps
// the Modern-tier rasteriser reads together: albedo (panels), a tangent-space
// normal map (beveled panel edges + a recessed grout grid = greebles), a packed
// metallic-roughness map (G=roughness, B=metallic) that makes the panels glossy
// metal and the grout matte, and an emissive map that lights the cyan energy
// channel. The BRDF then reflects the skybox in the metal and glows the channel.

const TEX = 128;
const PANEL = 32; // panel grid pitch

interface Surf {
  r: number;
  g: number;
  b: number;
  h: number; // height 0..1 (relief)
  spec: number; // 0..15
  rough: number; // 0..15
  emis: number; // 0..15
}

function forerunnerSurface(x: number, y: number): Surf {
  const px = ((x % PANEL) + PANEL) % PANEL;
  const py = ((y % PANEL) + PANEL) % PANEL;
  // Brushed blue-grey metal with a faint horizontal brush streak.
  const streak = Math.round((Math.sin(y * 0.8) + Math.sin(y * 2.3)) * 2.5);
  let r = 66 + streak;
  let g = 80 + streak;
  let b = 102 + streak;
  let h = 0.55;
  let spec = 12;
  let rough = 4;
  let emis = 0;

  const edge = Math.min(px, PANEL - 1 - px, py, PANEL - 1 - py);
  if (edge < 1) {
    // recessed grout between panels
    r = 22;
    g = 27;
    b = 36;
    h = 0.12;
    spec = 3;
    rough = 13;
  } else if (edge < 3) {
    // lit bevel around each panel (kept restrained so it reads as metal, not neon)
    r = 92;
    g = 104;
    b = 124;
    h = 0.9;
    spec = 14;
    rough = 3;
  }

  // Inner sub-panel frame — a little machined detail inside each panel.
  const ipx = Math.min(px, PANEL - 1 - px);
  const ipy = Math.min(py, PANEL - 1 - py);
  if (edge >= 3 && ((ipx > 7 && ipx < 9) || (ipy > 7 && ipy < 9))) {
    r -= 14;
    g -= 14;
    b -= 10;
    h = 0.42;
  }

  // A thin cyan energy channel — only on every other panel row, so it reads as a
  // Forerunner light strip, not a Tron grid.
  const panelRow = Math.floor(y / PANEL);
  if (panelRow % 2 === 0 && py >= 15 && py <= 16) {
    r = 66;
    g = 196;
    b = 220;
    h = 0.5;
    spec = 6;
    rough = 8;
    emis = 12;
  }
  return { r, g, b, h, spec, rough, emis };
}

/** Bake the albedo, normal, metallic-roughness and emissive PNGs (glTF PBR). */
function bakeForerunner(): {
  albedo: EncodedImage;
  normal: EncodedImage;
  metallicRoughness: EncodedImage;
  emissive: EncodedImage;
} {
  const albedo = new Uint8ClampedArray(TEX * TEX * 4);
  const normal = new Uint8ClampedArray(TEX * TEX * 4);
  const mr = new Uint8ClampedArray(TEX * TEX * 4); // glTF metallic-roughness: G=rough, B=metal
  const emissive = new Uint8ClampedArray(TEX * TEX * 4);
  const hAt = (x: number, y: number) => forerunnerSurface(x, y).h;
  let o = 0;
  for (let y = 0; y < TEX; y += 1) {
    for (let x = 0; x < TEX; x += 1) {
      const s = forerunnerSurface(x, y);
      albedo[o] = s.r;
      albedo[o + 1] = s.g;
      albedo[o + 2] = s.b;
      albedo[o + 3] = 255;
      // Normal from the height gradient (tangent space, z up out of the surface).
      const dhx = hAt(x + 1, y) - hAt(x - 1, y);
      const dhy = hAt(x, y + 1) - hAt(x, y - 1);
      const st = 2.4;
      let nx = -dhx * st;
      let ny = -dhy * st;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      normal[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normal[o + 3] = 255;
      // Roughness from the authored rough channel; metallic from the surface kind:
      // energy strips are non-metal emitters, grout is matte non-metal, panels and
      // their bevels are near-pure metal so they mirror the skybox.
      const roughness = Math.min(255, Math.max(16, s.rough * 17));
      const metallic = s.emis > 0 ? 0 : s.spec <= 3 ? 50 : 230;
      mr[o] = 0;
      mr[o + 1] = roughness;
      mr[o + 2] = metallic;
      mr[o + 3] = 255;
      // Emissive: the cyan channel glows, everything else is dark.
      const e = s.emis / 15;
      emissive[o] = Math.round(s.r * e);
      emissive[o + 1] = Math.round(s.g * e);
      emissive[o + 2] = Math.round(s.b * e);
      emissive[o + 3] = 255;
      o += 4;
    }
  }
  const png = (rgba: Uint8ClampedArray): EncodedImage => ({ mime: "image/png", bytes: encodeRgbaPng(rgba, TEX, TEX) });
  return { albedo: png(albedo), normal: png(normal), metallicRoughness: png(mr), emissive: png(emissive) };
}

const FORE = bakeForerunner();

// --- Map geometry ---------------------------------------------------------
// Coordinates: X right, Y up, Z forward. Symmetric in X/Z so the scene centre is
// exactly (0, CENTER_Y, 0).

// Lockout is an ASYMMETRIC, vertical Forerunner structure: a tall Sniper tower
// on one side, a two-storey BR structure diagonally opposite, a raised central
// walkway spanning a lower "bottom mid" where the Sword sits, and an enclosed
// Shotgun room off to one side, all over a recover floor. This is a homage to
// that massing (axis-aligned, so approximate), not a survey-accurate rip.

/** A flight of steps connecting two heights along one axis (the code's step-up
 *  lets the player and bots climb the ~0.5u risers). */
function steps(axis: "x" | "z", fixed: number, halfFixed: number, start: number, sign: 1 | -1, topFrom: number, topTo: number): Box[] {
  const n = Math.max(1, Math.round(Math.abs(topFrom - topTo) / 0.5));
  const rise = (topFrom - topTo) / n;
  const run = 0.85;
  const out: Box[] = [];
  for (let i = 0; i < n; i += 1) {
    const top = topFrom - rise * (i + 1);
    const pos = start + sign * (i + 0.5) * run;
    const hy = Math.max(0.05, top / 2);
    out.push(axis === "z" ? [fixed, top / 2, pos, halfFixed, hy, run / 2] : [pos, top / 2, fixed, run / 2, hy, halfFixed]);
  }
  return out;
}

/** Structural (solid, Forerunner-textured) boxes. */
const STRUCT: Box[] = [
  [-1, -0.5, 0, 15, 0.5, 13], // recover floor

  // --- Sniper tower (north-west): three stacked, shrinking tiers ---
  [-8, 1.0, -8, 3.4, 1.0, 3.0], // T1 base (top 2.0)
  [-8, 3.25, -8, 2.7, 1.25, 2.4], // T2 mid (top 4.5)
  [-8, 5.75, -8, 2.2, 1.25, 2.2], // T3 sniper deck (top 7.0)
  ...steps("z", -8, 2.6, -4.5, 1, 2.0, 0), // floor -> T1 (ramp toward mid)
  ...steps("x", -10.9, 1.8, -8, -1, 4.5, 2.0), // T1 -> T2 (west side)
  ...steps("x", -5.1, 1.6, -8, 1, 7.0, 4.5), // T2 -> T3 (east side)
  // rails around the open sniper deck
  [-8, 7.3, -9.9, 2.2, 0.3, 0.15],
  [-9.9, 7.3, -8, 0.15, 0.3, 2.2],

  // --- BR structure (south-east): two storeys ---
  [8, 0.9, 7, 3.2, 0.9, 3.0], // B1 lower (top 1.8)
  [8, 2.9, 7, 2.4, 1.1, 2.4], // B2 upper (top 4.0)
  ...steps("z", 8, 2.6, 4.5, -1, 1.8, 0), // floor -> B1
  ...steps("x", 10.9, 1.7, 7, -1, 4.0, 1.8), // B1 -> B2
  [8, 4.3, 9.4, 2.4, 0.3, 0.15], // B2 rail

  // --- Central raised walkway (the "bridge") over the bottom mid ---
  [0, 3.4, 0, 1.6, 0.25, 6.5], // main span (top 3.65) running along Z
  [3.5, 3.4, -3, 3.5, 0.25, 1.4], // spur toward the sniper tower
  [3.5, 3.4, 5, 3.5, 0.25, 1.4], // spur toward BR
  ...steps("z", 0, 1.4, -7.0, -1, 3.65, 0), // ends drop to the floor
  ...steps("z", 0, 1.4, 7.0, 1, 3.65, 0),

  // --- Bottom mid (the Sword pit): a low sunken platform with lips ---
  [0, 0.35, 0, 3.2, 0.35, 2.6], // top 0.7
  [0, 1.1, -2.7, 3.2, 0.5, 0.2], // low walls framing the pit
  [0, 1.1, 2.7, 3.2, 0.5, 0.2],

  // --- Shotgun room (south-west): a covered nook ---
  [-9, 1.1, 6, 2.6, 1.1, 2.4], // floor (top 2.2)
  [-9, 3.5, 6, 2.7, 0.2, 2.6], // roof
  [-9, 2.6, 8.2, 2.7, 1.4, 0.2], // back wall
  ...steps("x", -6.4, 2.0, 6, 1, 2.2, 0), // floor -> shotgun room
];

/** Emissive cyan trim (non-solid): thin Forerunner light strips + tower vents. */
const TRIM: Box[] = [
  [-8, 5.0, -5.85, 2.0, 1.6, 0.04], // sniper-tower vent (a tall thin slit up the front)
  [8, 2.9, 4.55, 1.8, 0.8, 0.04], // BR-tower vent
  // walkway edge lights: a thin strip down each long side
  [1.55, 3.67, 0, 0.05, 0.02, 6.3],
  [-1.55, 3.67, 0, 0.05, 0.02, 6.3],
  // sword-pit rim: a thin strip along each long edge
  [0, 0.72, 2.55, 3.1, 0.02, 0.05],
  [0, 0.72, -2.55, 3.1, 0.02, 0.05],
  [-9, 2.22, 3.65, 2.4, 0.02, 0.05], // shotgun-room threshold strip
];

/** Weapon-spawn markers (non-solid), cyan-lit cubes, at the sandbox spots. */
const MARKERS: Box[] = [
  [-8, 7.4, -8, 0.28, 0.4, 0.28], // Sniper — atop the tower
  [8, 4.4, 7, 0.28, 0.4, 0.28], // BR — atop the BR structure
  [-9, 2.6, 6, 0.28, 0.4, 0.28], // Shotgun — in the nook
  [0, 1.1, 0, 0.28, 0.4, 0.28], // Sword — the bottom-mid pit
  [0, 4.05, 0, 0.28, 0.4, 0.28], // SMG — on the central walkway
];
const MARKER_WEAPONS = ["sniper", "br", "shotgun", "sword", "smg"] as const;

const SPAWNS: ReadonlyArray<readonly [number, number, number]> = [
  [-8, 2.0, -8], // sniper T1
  [-8, 4.5, -8], // sniper mid
  [8, 1.8, 7], // BR lower
  [8, 4.0, 7], // BR upper
  [0, 3.65, 0], // central walkway
  [0, 0.7, 0], // sword pit
  [-9, 2.2, 6], // shotgun room
  [6, 0, -6], // floor
];

const BOT_COUNT = 7;

// --- Mesh assembly --------------------------------------------------------

/** One full texture tile (its four panels) spans about `TILE_WORLD` units on any
 *  box face, so panels read at a consistent, readable size across the map. */
const TILE_WORLD = 12;
function boxesPrimitive(boxes: Box[], material: MeshPrimitive["material"], fixedRepeat?: number): MeshPrimitive {
  const s: Streams = newStreams();
  for (const [cx, cy, cz, hx, hy, hz] of boxes) {
    const r = fixedRepeat ?? Math.max(1, Math.round((Math.max(hx, hy, hz) * 2) / TILE_WORLD));
    pushBox(s, [cx, cy, cz], [hx, hy, hz], r);
  }
  return toPrimitive(s, material);
}

function mapMesh(): MeshAsset {
  // PBR metallic-roughness: the panels are near-pure metal that mirrors the skybox,
  // normal-mapped for relief, with a baked emissive map for the cyan channel.
  const structMat: MeshPrimitive["material"] = {
    name: "forerunner",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: FORE.albedo,
    normalImage: FORE.normal,
    metallicRoughnessImage: FORE.metallicRoughness,
    emissiveImage: FORE.emissive,
    metallicFactor: 1,
    roughnessFactor: 1,
    emissiveFactor: [1.5, 1.5, 1.5], // push the baked glow above 1 so it blooms through the tone-map
  };
  // The energy trim + weapon markers: a flat, non-metal cyan emitter (HDR emissive
  // > 1 so it rolls off through ACES rather than clipping).
  const cyanMat: MeshPrimitive["material"] = {
    name: "energy",
    baseColorFactor: [0.28, 0.95, 1, 1],
    baseColorImage: null,
    metallicFactor: 0,
    roughnessFactor: 0.5,
    emissiveFactor: [0.5, 1.7, 1.9],
  };
  return {
    name: "Lockout arena",
    primitives: [boxesPrimitive(STRUCT, structMat), boxesPrimitive([...TRIM, ...MARKERS], cyanMat, 1)],
  };
}

/** A spartan-ish figure: armour body + a glowing cyan visor. Authored at origin,
 *  feet at y=0, so a per-frame meshpose places it in absolute world space. */
function botMesh(): MeshAsset {
  const armor: Streams = newStreams();
  pushBox(armor, [0, 0.5, 0], [0.3, 0.5, 0.26], 1); // legs
  pushBox(armor, [0, 1.25, 0], [0.36, 0.36, 0.3], 1); // torso
  pushBox(armor, [0, 1.72, 0], [0.2, 0.2, 0.2], 1); // helmet
  pushBox(armor, [0, 1.32, -0.3], [0.13, 0.12, 0.32], 1); // shoulder nub (faces -Z)
  const visor: Streams = newStreams();
  pushBox(visor, [0, 1.74, -0.19], [0.14, 0.07, 0.03], 1); // visor slit
  return {
    name: "spartan",
    primitives: [
      toPrimitive(armor, {
        name: "armor",
        baseColorFactor: [0.5, 0.55, 0.62, 1],
        baseColorImage: null,
        metallicFactor: 0.85, // brushed metal that catches the key light + skybox
        roughnessFactor: 0.35,
      }),
      toPrimitive(visor, {
        name: "visor",
        baseColorFactor: [0.9, 0.55, 0.15, 1],
        baseColorImage: null,
        metallicFactor: 0,
        roughnessFactor: 0.4,
        emissiveFactor: [1.3, 0.75, 0.2], // glowing amber visor
      }),
    ],
  };
}

/** The scene's bounding-box centre over every authored box (the bots are
 *  authored at the origin, which sits inside this footprint, so they never
 *  extend it). The camera's target offset is relative to this, so it must match
 *  the runtime's own `parseMeshScene` bounds — a test pins all three axes. */
function sceneCenter(): [number, number, number] {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (const [cx, cy, cz, hx, hy, hz] of [...STRUCT, ...TRIM, ...MARKERS]) {
    mnx = Math.min(mnx, cx - hx); mny = Math.min(mny, cy - hy); mnz = Math.min(mnz, cz - hz);
    mxx = Math.max(mxx, cx + hx); mxy = Math.max(mxy, cy + hy); mxz = Math.max(mxz, cz + hz);
  }
  return [(mnx + mxx) / 2, (mny + mxy) / 2, (mnz + mxz) / 2];
}
const CENTER = sceneCenter();
export const LOCKOUT_CENTER_X = CENTER[0];
export const LOCKOUT_CENTER_Y = CENTER[1];
export const LOCKOUT_CENTER_Z = CENTER[2];

/**
 * The authored Modern-tier lighting rig: a cool Forerunner skybox (image-based
 * lighting the metals reflect), a warm-white directional key with a cooler fill,
 * a cyan point light down in the Sword pit, ACES tone mapping so the emissive
 * energy and specular highlights roll off instead of clipping, and directional
 * shadows the towers and bridge cast onto the floor.
 */
export const LOCKOUT_LIGHTING: SceneLighting = {
  environment: {
    sky: [0.12, 0.2, 0.34],
    horizon: [0.24, 0.34, 0.42],
    ground: [0.05, 0.08, 0.12],
    intensity: 1,
  },
  ambient: 0.28,
  exposure: 1.15,
  tonemap: true,
  shadows: true,
  lights: [
    // Key: high warm-white sun (direction points *towards* the light).
    { kind: "directional", direction: [0.4, 0.8, -0.45], color: [0.85, 0.9, 1], intensity: 1.5 },
    // Fill: a low, cool bounce from the opposite side so shadows aren't black.
    { kind: "directional", direction: [-0.5, 0.35, 0.55], color: [0.32, 0.5, 0.68], intensity: 0.5 },
    // The Sword pit's cyan glow, at the bottom-mid centre.
    { kind: "point", position: [0, 1, 0], color: [0.35, 0.95, 1], intensity: 3, range: 9 },
  ],
};

export const LOCKOUT_MESH_SIDECAR: string = (() => {
  const identity = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  const bot = serializeMeshAsset(botMesh());
  const meshes: unknown[] = [
    { id: "lockout-map", name: "Lockout arena", mesh: serializeMeshAsset(mapMesh()), transform: identity },
  ];
  for (let i = 0; i < BOT_COUNT; i += 1) meshes.push({ id: `bot-${i}`, name: `bot ${i}`, mesh: bot, transform: identity });
  return JSON.stringify({ version: 2, meshes, lighting: LOCKOUT_LIGHTING });
})();

export const LOCKOUT_SCENE_TRIANGLES = (() => {
  const map = mapMesh().primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  const bot = botMesh().primitives.reduce((n, p) => n + p.indices.length / 3, 0);
  return map + bot * BOT_COUNT;
})();

// --- The cart code --------------------------------------------------------

function collidersLua(): string {
  const nums: number[] = [];
  for (const [cx, cy, cz, hx, hy, hz] of STRUCT) nums.push(cx - hx, cy - hy, cz - hz, cx + hx, cy + hy, cz + hz);
  return nums.map((n) => n.toFixed(2)).join(",");
}
function spawnsLua(): string {
  return SPAWNS.flat().map((n) => n.toFixed(2)).join(",");
}
function markersLua(): string {
  return MARKERS.map(([cx, cy, cz]) => `${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)}`).join(",");
}
function markerWeaponsLua(): string {
  return MARKER_WEAPONS.map((w) => `"${w}"`).join(",");
}

export const LOCKOUT_CODE = `-- title:  Lockout arena
-- author: you
-- desc:   A vertical Forerunner-arena FPS homage -- you + 7 bots, 7 game types, Xbox 360 core
-- script: lua

-- Cartbox has no netcode, so "8 players" is you + 7 AI bots in one local match.
-- The web player forwards only 8 buttons (arrows + Z X A S), so this is a
-- single-stick console FPS with vertical auto-aim:
--   Up/Down move . Left/Right turn . hold A strafe . double-tap A = grenade
--   Z fire (auto-melee point-blank) . X jump . S swap weapon
--   menu: Up/Down pick . Z start   |   sniper: hold A still to zoom

local CENTER_X = ${LOCKOUT_CENTER_X.toFixed(4)}
local CENTER_Y = ${LOCKOUT_CENTER_Y.toFixed(4)}
local CENTER_Z = ${LOCKOUT_CENTER_Z.toFixed(4)}
local COL = {${collidersLua()}}
local SPN = {${spawnsLua()}}
local MRK = {${markersLua()}}
local MW  = {${markerWeaponsLua()}}
local NBOT = ${BOT_COUNT}

-- ---------------------------------------------------------------------------
-- Weapon sandbox. dmg per shot, cool = frames between shots, rng world units,
-- hs = headshot multiplier, mag/pel/spr = clip/pellets/spread, auto = hold to
-- fire, reserve = spare rounds. A Forerunner homage sandbox, not Halo's numbers.
local W = {
  br      = { name="Battle Rifle",  dmg=17, cool=9,  rng=64, hs=1.7, mag=36, pel=1, spr=0.02, auto=false, reserve=108 },
  smg     = { name="SMG",           dmg=7,  cool=3,  rng=26, hs=1.2, mag=60, pel=1, spr=0.05, auto=true,  reserve=180 },
  shotgun = { name="Shotgun",       dmg=12, cool=22, rng=12, hs=1.0, mag=6,  pel=8, spr=0.14, auto=false, reserve=24 },
  sniper  = { name="Sniper Rifle",  dmg=80, cool=44, rng=150,hs=3.0, mag=4,  pel=1, spr=0.0,  auto=false, reserve=12, zoom=true },
  magnum  = { name="Magnum",        dmg=20, cool=13, rng=42, hs=2.0, mag=12, pel=1, spr=0.012,auto=false, reserve=48 },
  sword   = { name="Energy Sword",  dmg=220,cool=20, rng=3.2,hs=1.0, mag=99, pel=1, spr=0.0,  auto=false, reserve=0, melee=true },
}

-- Game types. teams/shields/radar toggle the rules; obj names the objective
-- ("slayer" = kills); target is the score that ends the match.
local MODES = {
  ffa    = { name="Free for All",  obj="slayer", teams=false, shields=true,  radar=true,  start="br",     target=15, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  slayer = { name="Team Slayer",   obj="slayer", teams=true,  shields=true,  radar=true,  start="br",     target=40, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  swat   = { name="SWAT",          obj="slayer", teams=true,  shields=false, radar=false, start="br",     target=40, weapons={} },
  snipe  = { name="Team Snipers",  obj="slayer", teams=true,  shields=true,  radar=false, start="sniper", target=25, weapons={} },
  ball   = { name="Oddball",       obj="ball",   teams=false, shields=true,  radar=true,  start="magnum", target=100,weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  koth   = { name="King of the Hill",obj="hill", teams=false, shields=true,  radar=true,  start="br",     target=100,weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  jugg   = { name="Juggernaut",    obj="jugg",   teams=false, shields=true,  radar=true,  start="magnum", target=15, weapons={br=true,shotgun=true,sniper=true,sword=true} },
}
local MODE_KEYS = {"ffa","slayer","swat","snipe","ball","koth","jugg"}

-- Hill locations King-of-the-Hill rotates through (the named power positions).
local HILLS = { {0,3.65,0}, {-8,7.0,-8}, {8,4.0,7}, {0,0.7,0}, {-9,2.2,6} }

local PR,PH,EYE,STEP = 0.55,1.7,1.5,0.6
local GRAV,MOVE,JUMP,TURN = 0.028,0.15,0.5,0.045

local phase = "menu"
local sel = 1
local MODE = MODES.ffa
local p = nil
local bots = {}
local team = { blue=0, red=0 }
local mtimer = {}
local grenades = {}
local feed = {}          -- kill feed: {text,color,t}
local announce = {t=0, text="", color=12}
local winner = ""
local prev = {}
local bob = 0
local flash = 0
local tick = 0
local ball = { x=0,y=0,z=0, carrier=nil, live=false }
local hill = { x=0,y=0,z=0, next=0, idx=1 }
local shot = {t=0, x=0, y=0, z=0}   -- last shot tracer for a beam flash

-- ---------------------------------------------------------------------------
local function ncol() return #COL // 6 end
local function edge(k, held) local was = prev[k]; prev[k] = held; return held and not was end
local function clamp(v,a,b) if v<a then return a elseif v>b then return b else return v end end
local function d3(ax,ay,az,bx,by,bz) return math.sqrt((ax-bx)^2+(ay-by)^2+(az-bz)^2) end

-- Segment vs every solid collider: true if the shot from A to B hits a wall
-- before maxt (world units). Slab test per box, nearest hit kept -- this is
-- what stops shots (yours and the bots') passing through the Forerunner walls.
function seg_blocked(x0,y0,z0, x1,y1,z1, maxt)
  local dx,dy,dz = x1-x0, y1-y0, z1-z0
  for i=0,ncol()-1 do
    local b=i*6
    local tmin,tmax = 0.0, 1.0
    local ok = true
    local lo,hi
    for a=1,3 do
      local o = (a==1) and x0 or (a==2) and y0 or z0
      local d = (a==1) and dx or (a==2) and dy or dz
      lo = COL[b+a]; hi = COL[b+a+3]
      if math.abs(d) < 1e-6 then
        if o < lo or o > hi then ok=false break end
      else
        local t1=(lo-o)/d; local t2=(hi-o)/d
        if t1>t2 then t1,t2=t2,t1 end
        if t1>tmin then tmin=t1 end
        if t2<tmax then tmax=t2 end
        if tmin>tmax then ok=false break end
      end
    end
    if ok and tmin>0.02 and tmin*1.0 < (maxt or 1) then return true end
  end
  return false
end

local function move_axis(ax, d)
  if ax == "x" then p.x = p.x + d else p.z = p.z + d end
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i*6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR>x0 and p.x-PR<x1 and p.z+PR>z0 and p.z-PR<z1 and head>y0 and feet<y1 then
      if y1-feet<=STEP and y1-feet>0 then p.y=y1; feet=y1; head=y1+PH
      else
        if ax=="x" then if d>0 then p.x=x0-PR else p.x=x1+PR end
        else if d>0 then p.z=z0-PR else p.z=z1+PR end end
      end
    end
  end
end

local function move_vertical()
  p.vy = p.vy - GRAV
  p.y = p.y + p.vy
  p.grounded = false
  local feet, head = p.y, p.y + PH
  for i = 0, ncol() - 1 do
    local b = i*6
    local x0,y0,z0,x1,y1,z1 = COL[b+1],COL[b+2],COL[b+3],COL[b+4],COL[b+5],COL[b+6]
    if p.x+PR>x0 and p.x-PR<x1 and p.z+PR>z0 and p.z-PR<z1 then
      if p.vy<=0 and feet<y1 and feet>y1-1.2 then p.y=y1; p.vy=0; p.grounded=true; feet=y1; head=y1+PH
      elseif p.vy>0 and head>y0 and feet<y0 then p.y=y0-PH; p.vy=0 end
    end
  end
  if p.y < -6 then p.hp=0; p.dead=true; p.respawn=90; p.deaths=p.deaths+1 end
end

function respawn(who)
  local s = (math.random(0, NBOT)) * 3
  who.x,who.y,who.z = SPN[s+1],SPN[s+2],SPN[s+3]
  who.vy=0; who.hp=100; who.sh = MODE.shields and 100 or 0
  who.dead=false; who.respawn=0
end

local function give(who, slot, id) who["g"..slot]=id; who["a"..slot]=W[id].mag; who["r"..slot]=W[id].reserve or 0 end

function enemy_of(a, o)
  if MODE.obj=="jugg" then return a.jugg ~= o.jugg end  -- everyone vs the juggernaut
  if not MODE.teams then return true end
  return a.team ~= o.team
end

-- Forward vector from yaw + auto-aim pitch.
local function forward()
  local cp = math.cos(p.ap)
  return cp*math.sin(p.ay), math.sin(p.ap), cp*math.cos(p.ay)
end

local function drive_camera()
  local fx,fy,fz = forward()
  local ex,ey,ez = p.x, p.y+EYE, p.z
  local d = 0.5
  local tx,ty,tz = ex+fx*d, ey+fy*d, ez+fz*d
  local oy = math.atan(-fx, -fz)
  local op = math.asin(clamp(-fy,-0.999,0.999))
  cartbox.worldcam(oy, op, d, p.zoom and 0.5 or 1.15, tx-CENTER_X, ty-CENTER_Y, tz-CENTER_Z)
end

-- Nearest live enemy inside the player's forward yaw cone AND with clear line of
-- sight, for auto-aim (no manual pitch on an 8-button pad). Returns bot,distance.
local function auto_target()
  local best, bd = nil, 1e9
  local ex,ey,ez = p.x, p.y+EYE, p.z
  for _, o in ipairs(bots) do
    if not o.dead and enemy_of(p, o) then
      local dx,dz = o.x-p.x, o.z-p.z
      local m = math.sqrt(dx*dx+dz*dz)
      if m > 0.3 then
        local ang = math.atan(dx, dz) - p.ay
        while ang > math.pi do ang = ang - 2*math.pi end
        while ang < -math.pi do ang = ang + 2*math.pi end
        if math.abs(ang) < 0.28 and m < bd and not seg_blocked(ex,ey,ez, o.x,o.y+1.2,o.z, 1) then
          best, bd = o, m
        end
      end
    end
  end
  return best, bd
end

function add_feed(txt, color)
  table.insert(feed, 1, {text=txt, color=color, t=180})
  if #feed > 5 then table.remove(feed) end
end

function say(txt, color)
  announce.text=txt; announce.color=color or 12; announce.t=110
end

-- Register a kill: scoring, sprees, multikills, feed, and juggernaut handover.
function register_kill(killer, victim, hs)
  victim.dead=true; victim.respawn = MODE.obj=="jugg" and 70 or 100
  victim.deaths=(victim.deaths or 0)+1
  victim.streak=0
  if killer and killer~=victim then
    if MODE.obj=="ball" or MODE.obj=="hill" then
      -- objective modes: kills don't score, holding does
    elseif MODE.obj=="jugg" then
      if victim.jugg then killer.jugg=true; victim.jugg=false; killer.score=(killer.score or 0)+1; if killer==p then say("JUGGERNAUT",9) elseif victim==p then say("YOU ARE THE HUNTED",6) end end
    elseif MODE.teams then
      team[killer.team]=team[killer.team]+1
    else
      killer.score=(killer.score or 0)+1
    end
    killer.streak=(killer.streak or 0)+1
    -- multikill window (~4s)
    if tick-(killer.lastkill or -999) < 240 then killer.multi=(killer.multi or 1)+1 else killer.multi=1 end
    killer.lastkill=tick
    if killer==p then
      local m = {"","","Double Kill!","Triple Kill!","Overkill!","Killtacular!"}
      if killer.multi>=2 then say(m[math.min(6,killer.multi)] or "Killtacular!",9) end
      local sp = {[5]="Killing Spree!",[10]="Killing Frenzy!",[15]="Running Riot!"}
      if sp[killer.streak] then say(sp[killer.streak],6) end
    end
    add_feed((killer.tag or "?").." > "..(victim.tag or "?")..(hs and "  (headshot)" or ""), killer==p and 6 or 13)
  end
  if MODE.obj=="ball" and ball.carrier==victim then ball.live=true; ball.carrier=nil; ball.x=victim.x; ball.y=victim.y+0.6; ball.z=victim.z end
end

function score_of(who)
  if MODE.teams and MODE.obj=="slayer" then return team[who.team] end
  return who.score or 0
end

-- ---------------------------------------------------------------------------
-- Grenades: a thrown frag arcs under gravity, bounces off floor level, and
-- detonates on a fuse, dealing splash to everyone in range.
function throw_grenade(who, fx,fy,fz)
  if (who.nade or 0) <= 0 then return end
  who.nade = who.nade - 1
  table.insert(grenades, { x=who.x, y=who.y+EYE, z=who.z, vx=fx*0.5, vy=fy*0.5+0.12, vz=fz*0.5, t=90, owner=who })
end

local function explode(g)
  flash = math.max(flash, 3)
  local function splash(o)
    if not o or o.dead then return end
    local m = d3(g.x,g.y,g.z, o.x,o.y+1,o.z)
    if m < 4.5 then
      local dmg = (1 - m/4.5) * 90
      if o.sh>0 then o.sh=o.sh-dmg; if o.sh<0 then o.hp=o.hp+o.sh; o.sh=0 end else o.hp=o.hp-dmg end
      if o.hp<=0 then register_kill(g.owner, o, false) end
    end
  end
  splash(p)
  for _,o in ipairs(bots) do splash(o) end
end

local function update_grenades()
  for i=#grenades,1,-1 do
    local g=grenades[i]
    g.vy = g.vy - GRAV*0.7
    g.x=g.x+g.vx; g.y=g.y+g.vy; g.z=g.z+g.vz
    -- crude floor / ledge bounce
    for j=0,ncol()-1 do local b=j*6
      if g.x>COL[b+1] and g.x<COL[b+4] and g.z>COL[b+3] and g.z<COL[b+6] and g.y<COL[b+5] and g.y>COL[b+5]-0.6 and g.vy<0 then
        g.y=COL[b+5]; g.vy=-g.vy*0.4; g.vx=g.vx*0.6; g.vz=g.vz*0.6
      end
    end
    g.t=g.t-1
    if g.t<=0 or g.y<-8 then explode(g); table.remove(grenades,i) end
  end
end

local function player_fire()
  if p.cool>0 or p.dead then return end
  local wid = p.slot==1 and p.g1 or p.g2
  local w = W[wid]
  local ammo = p.slot==1 and p.a1 or p.a2
  -- auto-melee when an enemy is right in front
  local aim,ad = auto_target()
  if aim and ad < 2.4 then
    p.cool=18; flash=3
    if not aim.dead then
      if aim.sh>0 then aim.sh=0 end
      aim.hp = aim.hp - 90
      if aim.hp<=0 then register_kill(p, aim, false) end
    end
    return
  end
  if ammo<=0 then
    -- reload from reserve, else fall back to the magnum
    local res = p.slot==1 and p.r1 or p.r2
    if res>0 then
      local take=math.min(w.mag,res)
      if p.slot==1 then p.a1=take; p.r1=res-take else p.a2=take; p.r2=res-take end
      p.cool=40; return
    end
    p.slot=(p.slot==1) and 2 or 1; return
  end
  p.cool = w.cool; flash = 4
  if p.slot==1 then p.a1=p.a1-1 else p.a2=p.a2-1 end
  local ex,ey,ez = p.x, p.y+EYE, p.z
  shot.t=3; shot.x=ex; shot.y=ey; shot.z=ez
  for _=1,w.pel do
    local fx,fy,fz
    if aim then
      fx,fy,fz = aim.x-ex, (aim.y+1.2)-ey, aim.z-ez
      local m=math.sqrt(fx*fx+fy*fy+fz*fz); fx,fy,fz=fx/m,fy/m,fz/m
    else fx,fy,fz = forward() end
    if w.spr>0 then fx=fx+(math.random()-0.5)*w.spr; fz=fz+(math.random()-0.5)*w.spr end
    local best,bt=nil,1e9
    for _,o in ipairs(bots) do
      if not o.dead and enemy_of(p,o) then
        local t=(o.x-ex)*fx+(o.y+1.2-ey)*fy+(o.z-ez)*fz
        if t>0.4 and t<w.rng then
          local hx,hy,hz=ex+fx*t, ey+fy*t, ez+fz*t
          local m=math.sqrt((o.x-hx)^2+(o.y+1.2-hy)^2+(o.z-hz)^2)
          if m<0.9 and t<bt and not seg_blocked(ex,ey,ez, hx,hy,hz, 1) then best,bt=o,t; o._hy=hy end
        end
      end
    end
    if best then
      local dmg=w.dmg
      local head = best._hy and best._hy>best.y+1.5
      if head then dmg=dmg*w.hs end
      if best.sh>0 then best.sh=best.sh-dmg; if best.sh<0 then best.hp=best.hp+best.sh; best.sh=0 end
      else best.hp=best.hp-dmg end
      if best.hp<=0 then register_kill(p, best, head) end
    end
  end
end

local function try_pickups()
  for i=0,(#MRK//3)-1 do
    local id=MW[i+1]; local legal=MODE.weapons[id]
    mtimer[i+1]=math.max(0,(mtimer[i+1] or 0)-1)
    if legal and mtimer[i+1]==0 then
      local mx,my,mz=MRK[i*3+1],MRK[i*3+2],MRK[i*3+3]
      if math.abs(p.x-mx)<1.4 and math.abs(p.z-mz)<1.6 and math.abs((p.y+1)-my)<2.0 then
        give(p,1,id); p.slot=1; mtimer[i+1]=540; say("Picked up "..W[id].name,12)
      end
    end
  end
  -- ammo/grenade top-up when standing on a marker (light resupply)
end

-- ---------------------------------------------------------------------------
-- Bot AI: navigate toward an objective-aware goal, engage enemies in LOS, and
-- use the arena's heights via the same step-up the player uses.
local function bot_goal(o)
  if MODE.obj=="ball" then
    if ball.carrier==o then return SPN[1],SPN[3]              -- carrier roams a safe spot
    elseif ball.live then return ball.x, ball.z end
  elseif MODE.obj=="hill" then return hill.x, hill.z
  elseif MODE.obj=="jugg" then
    if o.jugg then return SPN[13] or 0, SPN[15] or 0          -- jugg holds high ground
    else return p.jugg and p.x or (bots[1] and bots[1].x or 0), p.jugg and p.z or 0 end
  end
  return o.tx, o.tz
end

local function think_bot(o)
  if o.dead then o.respawn=o.respawn-1; if o.respawn<=0 then respawn(o) end return end
  o.moving=false
  -- target enemy: player if in LOS+range, else keep wandering
  local pdx,pdz = p.x-o.x, p.z-o.z
  local pm = math.sqrt(pdx*pdx+pdz*pdz)
  local seesP = (not p.dead) and enemy_of(o,p) and pm<40 and not seg_blocked(o.x,o.y+1.4,o.z, p.x,p.y+EYE,p.z, 1)
  local gx,gz
  if seesP then
    gx,gz = p.x, p.z
    o.face = math.atan(pdx,pdz)
    -- shoot the player
    local wid = o.g1 or "br"; local w=W[wid]
    o.cool=(o.cool or 0)-1
    if pm < (w.rng or 40) and (o.cool or 0)<=0 then
      o.cool = (w.cool or 10) + math.random(0,6)
      local acc = MODE.shields and 0.30 or 0.5   -- SWAT bots hit harder
      if math.random() < acc then
        local dmg = (w.dmg or 12) * (w.pel or 1) * 0.6
        if math.random()<0.12 then dmg=dmg*(w.hs or 1.5) end   -- occasional headshot
        if p.sh>0 then p.sh=p.sh-dmg; if p.sh<0 then p.hp=p.hp+p.sh; p.sh=0 end else p.hp=p.hp-dmg end
        if p.hp<=0 and not p.dead then p.dead=true; p.respawn=90; p.deaths=p.deaths+1; register_kill(o,p,false) end
      end
    end
    -- strafe a little at fighting range
    if pm<14 then gx=o.x + math.cos(o.face)*(o.strafe or 1)*0.4; gz=o.z - math.sin(o.face)*(o.strafe or 1)*0.4
      if math.random()<0.03 then o.strafe=-(o.strafe or 1) end
    end
  else
    gx,gz = bot_goal(o)
    if gx==nil then gx,gz=o.tx,o.tz end
  end
  local dx,dz = (gx or o.x)-o.x, (gz or o.z)-o.z
  local m = math.sqrt(dx*dx+dz*dz)
  if m<1.0 then
    local s=math.random(0,NBOT)*3; o.tx,o.tz=SPN[s+1],SPN[s+3]
  else
    o.x=o.x+(dx/m)*0.07; o.z=o.z+(dz/m)*0.07; o.moving=true
    if not seesP then o.face=math.atan(dx,dz) end
  end
  -- rest on the tallest platform under the bot (cheap vertical solve)
  local top=0
  for i=0,ncol()-1 do local b=i*6
    if o.x>COL[b+1] and o.x<COL[b+4] and o.z>COL[b+3] and o.z<COL[b+6] then
      if COL[b+5]<=2.7 and COL[b+5]>top then top=COL[b+5] end end end
  o.y=top
  -- objective interactions
  if MODE.obj=="ball" and ball.live and d3(o.x,o.y,o.z, ball.x,ball.y,ball.z)<1.3 then ball.carrier=o; ball.live=false end
  -- bots occasionally trade kills among themselves so scores move
  if math.random()<0.003 then
    local v=bots[math.random(1,NBOT)]
    if v and not v.dead and v~=o and enemy_of(o,v) then register_kill(o,v,false) end
  end
end

-- ---------------------------------------------------------------------------
local function update_objective()
  if MODE.obj=="ball" then
    if ball.carrier and not ball.carrier.dead then
      ball.x,ball.y,ball.z = ball.carrier.x, ball.carrier.y+1.6, ball.carrier.z
      ball.carrier.score=(ball.carrier.score or 0)+1
    end
    if ball.carrier==p and not p.dead then p.score=(p.score or 0) end
    -- player grabs the ball
    if ball.live and not p.dead and d3(p.x,p.y,p.z, ball.x,ball.y,ball.z)<1.5 then ball.carrier=p; ball.live=false; say("You have the ball",9) end
  elseif MODE.obj=="hill" then
    if tick>=hill.next then
      hill.idx = hill.idx % #HILLS + 1
      local h=HILLS[hill.idx]; hill.x,hill.y,hill.z=h[1],h[2],h[3]; hill.next=tick+900
      if tick>1 then say("Hill moved",12) end
    end
    local function inhill(o) return (not o.dead) and math.abs(o.x-hill.x)<3 and math.abs(o.z-hill.z)<3 end
    if inhill(p) then p.score=(p.score or 0)+1 end
    for _,o in ipairs(bots) do if inhill(o) then o.score=(o.score or 0)+1 end end
  elseif MODE.obj=="jugg" then
    -- the juggernaut earns points just for surviving as the hunted
    local jg=nil
    if p.jugg then jg=p else for _,o in ipairs(bots) do if o.jugg then jg=o break end end end
    if jg and not jg.dead and tick%30==0 then jg.score=(jg.score or 0)+1 end
  end
end

function reached_target()
  if MODE.teams and MODE.obj=="slayer" then
    if team.blue>=MODE.target then return "BLUE TEAM WINS" end
    if team.red>=MODE.target then return "RED TEAM WINS" end
  else
    if (p.score or 0)>=MODE.target then return "YOU WIN" end
    for _,o in ipairs(bots) do if (o.score or 0)>=MODE.target then return (o.tag or "A bot").." WINS" end end
  end
end

local function start_match(key)
  MODE = MODES[key]; team.blue,team.red,winner = 0,0,""
  tick=0; feed={}; grenades={}; announce.t=0
  for i=1,(#MRK//3) do mtimer[i]=0 end
  p = { ay=0, ap=0, vy=0, cool=0, score=0, deaths=0, slot=1, team="blue", dead=false, respawn=0, nade=2, tag="You", streak=0 }
  respawn(p); give(p,1,MODE.start); give(p,2,"magnum")
  bots = {}
  for i=1,NBOT do
    local o = { tx=0, tz=0, face=0, score=0, deaths=0, team=(i<=3) and "blue" or "red", g1=MODE.start, cool=0, strafe=1, tag="Bot "..i, streak=0 }
    respawn(o); o.tx,o.tz = o.x,o.z; bots[i]=o
  end
  if MODE.obj=="ball" then ball={x=0,y=1.1,z=0,carrier=nil,live=true} end
  if MODE.obj=="hill" then hill={x=HILLS[1][1],y=HILLS[1][2],z=HILLS[1][3],next=999999,idx=1} end
  if MODE.obj=="jugg" then bots[1].jugg=true; bots[1].sh=200 end
  phase = "play"
end

-- 8-button controls: tank move + turn, hold A to strafe, double-tap A grenade.
local function play_input()
  local aheld = btn(6)
  if edge("a", aheld) then
    if tick-(p.lastA or -99) < 14 and not p.dead then local fx,fy,fz=forward(); throw_grenade(p,fx,fy,fz) end
    p.lastA=tick
  end
  local sy,cy = math.sin(p.ay), math.cos(p.ay)
  local mvx,mvz = 0,0
  local moving=false
  if not p.dead then
    if btn(0) then mvx=mvx+sy; mvz=mvz+cy; moving=true end
    if btn(1) then mvx=mvx-sy; mvz=mvz-cy; moving=true end
    if aheld then
      if btn(2) then mvx=mvx-cy; mvz=mvz+sy; moving=true end
      if btn(3) then mvx=mvx+cy; mvz=mvz-sy; moving=true end
    else
      if btn(2) then p.ay=p.ay-TURN end
      if btn(3) then p.ay=p.ay+TURN end
    end
    local mm=math.sqrt(mvx*mvx+mvz*mvz)
    if mm>0 then move_axis("x",mvx/mm*MOVE); move_axis("z",mvz/mm*MOVE) end
  end
  if moving then bob=bob+0.28 end
  -- auto-aim pitch eases toward the locked enemy
  local aim=auto_target()
  local want=0
  if aim then
    local hd=math.sqrt((aim.x-p.x)^2+(aim.z-p.z)^2)
    want=math.asin(clamp(((aim.y+1.2)-(p.y+EYE))/math.max(1,hd),-0.9,0.9))
  end
  p.ap=p.ap+(want-p.ap)*0.2
  if btn(5) and p.grounded and not p.dead then p.vy=JUMP; p.grounded=false end
  if edge("swap", btn(7)) then p.slot=(p.slot==1) and 2 or 1 end
  local cur=W[p.slot==1 and p.g1 or p.g2]
  p.zoom = cur.zoom and aheld and not (btn(0) or btn(1) or btn(2) or btn(3))
  if p.cool>0 then p.cool=p.cool-1 end
  local firing = cur.auto and btn(4) or edge("fire", btn(4))
  if firing then player_fire() end
end

-- ---------------------------------------------------------------------------
-- Presentation.
local function sky()
  for i=0,8 do rect(0, i*40, 1280, 40, i<3 and 1 or (i<5 and 2 or 3)) end
  rect(0, 360, 1280, 360, 3)
  -- a few Forerunner stars up high
  for i=1,40 do local sx=(i*131)%1280; local sy=(i*71)%180; pix(sx,sy,12) end
end

local function draw_viewmodel(cur)
  local bx=720+math.sin(bob)*10
  local by=720+math.abs(math.cos(bob))*8
  if cur.melee then
    tri(bx-30,by, bx+70,by-160, bx+40,by-150, 9)
    tri(bx-30,by, bx+40,by-150, bx-40,by-120, 9)
    rect(bx-46,by-40,40,44,13)
  elseif cur.zoom then
    rect(bx-120,by-40,240,34,0); rect(bx-30,by-96,60,60,0)
    rect(bx-150,by-24,300,14,13)
  else
    rect(bx-40,by-150,80,150,0)
    rect(bx-24,by-186,48,44,13)
    rect(bx-14,by-210,28,30,0)
    rect(bx-70,by-40,150,40,13)
  end
  if flash>0 then circ(bx,by-210,12+flash*3,9); circ(bx,by-210,6+flash*2,12) end
end

-- Circular motion tracker (bottom-left): allies yellow, moving/firing enemies
-- red, rotated so the player faces "up". Classic radar -- it only sees motion.
local function draw_tracker()
  local rx,ry,rr=140,560,96
  circ(rx,ry,rr,1); circb(rx,ry,rr,13); circb(rx,ry,rr//2,2)
  -- sweep
  local sw=(tick*0.05)%(2*math.pi)
  line(rx,ry, rx+math.sin(sw)*rr, ry-math.cos(sw)*rr, 2)
  local function blip(o,col)
    local dx,dz=o.x-p.x, o.z-p.z
    local m=math.sqrt(dx*dx+dz*dz)
    if m>28 then return end
    local ang=math.atan(dx,dz)-p.ay
    local px=rx+math.sin(ang)*(m/28)*rr
    local py=ry-math.cos(ang)*(m/28)*rr
    circ(px,py,3,col)
  end
  for _,o in ipairs(bots) do
    if not o.dead and enemy_of(p,o) then if o.moving or MODE.obj=="jugg" and o.jugg then blip(o,6) end
    elseif not o.dead then blip(o,9) end
  end
  tri(rx,ry-7, rx-5,ry+5, rx+5,ry+5, 12)  -- player
  print("MOTION",rx-34,ry+rr+6,13,false,1,true)
end

local function draw_hud()
  -- shield (top) + health (under), segmented
  rect(40,40,300,20,0)
  local sc = p.sh>0 and 9 or 6
  rect(42,42,math.max(0,2.96*(MODE.shields and p.sh or p.hp)),16,sc)
  if MODE.shields then rect(40,66,300,12,0); rect(42,68,math.max(0,2.96*p.hp),8,6) end
  -- weapon + ammo (top-right)
  local cur=W[p.slot==1 and p.g1 or p.g2]
  local ammo=p.slot==1 and p.a1 or p.a2
  local res=p.slot==1 and p.r1 or p.r2
  print(cur.name,900,40,12,false,2,true)
  print(ammo.." / "..res,1040,74,cur.melee and 13 or 12,false,2,true)
  -- grenades
  for i=1,(p.nade or 0) do circ(1150+i*22,120,8,6); circb(1150+i*22,120,8,12) end
  print("FRAG",1150,96,13,false,1,true)
  -- objective / score readout (top center)
  local st
  if MODE.obj=="slayer" and MODE.teams then st="BLUE "..team.blue.."   RED "..team.red.."   /"..MODE.target
  elseif MODE.obj=="ball" then st=(ball.carrier==p and "YOU HOLD THE BALL  " or "").."Ball "..(p.score or 0).." /"..MODE.target
  elseif MODE.obj=="hill" then st="Hill "..(p.score or 0).." /"..MODE.target
  elseif MODE.obj=="jugg" then st=(p.jugg and "YOU ARE THE JUGGERNAUT  " or "Hunt the Juggernaut  ")..(p.score or 0).." /"..MODE.target
  else st="Score "..(p.score or 0).."   Deaths "..p.deaths.."   /"..MODE.target end
  print(MODE.name,540,40,13,false,1,true)
  print(st,540,58,12,false,2,true)
  -- kill feed (right, under ammo)
  for i,f in ipairs(feed) do print(f.text,880,150+i*22,f.color,false,1,true); f.t=f.t-1 end
  for i=#feed,1,-1 do if feed[i].t<=0 then table.remove(feed,i) end end
  -- announcer / medal (center)
  if announce.t>0 then announce.t=announce.t-1; print(announce.text,540,150,announce.color,false,3,true) end
  if MODE.radar then draw_tracker() end
end

local function draw_reticle()
  local cx,cy=640,360
  local cur=W[p.slot==1 and p.g1 or p.g2]
  local locked=auto_target()~=nil
  local rc=locked and 6 or 12
  if p.zoom then circb(cx,cy,210,0); line(cx-240,cy,cx+240,cy,0); line(cx,cy-240,cx,cy+240,0) end
  if cur.melee then
    line(cx-14,cy-14,cx+14,cy+14,rc); line(cx-14,cy+14,cx+14,cy-14,rc)
  elseif cur.pel>1 then
    circb(cx,cy,18,rc); circb(cx,cy,4,rc)
  else
    circb(cx,cy,10,rc); line(cx-16,cy,cx-6,cy,rc); line(cx+6,cy,cx+16,cy,rc)
    line(cx,cy-16,cx,cy-6,rc); line(cx,cy+6,cx,cy+16,rc)
  end
end

-- ---------------------------------------------------------------------------
function TIC()
  cls(0)
  tick=tick+1

  if phase=="menu" then
    local n=#MODE_KEYS
    if edge("up", btn(0)) then sel=(sel-2)%n+1 end
    if edge("down", btn(1)) then sel=sel%n+1 end
    if edge("go", btn(4)) then start_match(MODE_KEYS[sel]) end
    sky()
    print("LOCKOUT ARENA",452,96,12,false,3,true)
    print("you + 7 bots  --  a Forerunner-style homage on the Xbox 360 core",396,150,13,false,1,true)
    for i=1,n do
      local mo=MODES[MODE_KEYS[i]]
      local y=210+(i-1)*44
      if i==sel then rect(470,y-6,360,36,1) end
      print(mo.name,492,y,(i==sel) and 12 or 13,false,2,true)
    end
    print("Up/Down choose . Z (or A) start",470,540,13,false,1,true)
    print("Move Up/Down . Turn Left/Right . hold A strafe . dbl-tap A grenade",300,584,13,false,1,true)
    print("Z fire (auto-melee close) . X jump . S swap . sniper: hold A to zoom",300,612,13,false,1,true)
    return
  end

  if phase=="over" then
    sky()
    print(winner,520,260,12,false,3,true)
    -- simple scoreboard
    print("You: "..(p.score or 0).." kills, "..p.deaths.." deaths",520,340,6,false,2,true)
    if MODE.teams then print("BLUE "..team.blue.."   RED "..team.red,520,380,9,false,2,true) end
    print("Z -> back to game types",520,460,13,false,1,true)
    if edge("go", btn(4)) then phase="menu" end
    return
  end

  play_input()
  if p.dead then p.respawn=p.respawn-1; if p.respawn<=0 then respawn(p) end
  else move_vertical(); try_pickups() end
  for _,o in ipairs(bots) do think_bot(o) end
  update_grenades()
  update_objective()
  local w=reached_target(); if w then winner=w; phase="over" end
  if flash>0 then flash=flash-1 end
  if shot.t>0 then shot.t=shot.t-1 end

  sky()
  cartbox.clearlights()
  cartbox.sun(-0.4,-0.8,0.45, 205,216,240, 0.9)
  cartbox.light(p.x, p.z, 8, 90,200,235, p.y+4, 0.6)
  if MODE.obj=="ball" then cartbox.light(ball.x, ball.z, 6, 90,220,255, ball.y+1, 0.8) end
  if MODE.obj=="hill" then cartbox.light(hill.x, hill.z, 7, 120,255,150, hill.y+2, 0.7) end

  cartbox.clearposes()
  for i=1,NBOT do local o=bots[i]
    if o.dead then cartbox.meshpose(i,0,-50,0,0,0,0,0)
    else cartbox.meshpose(i,o.x,o.y,o.z,o.face,0,0, o.jugg and 1.25 or 1) end
  end
  drive_camera()

  draw_reticle()
  draw_viewmodel(W[p.slot==1 and p.g1 or p.g2])
  draw_hud()
  if p.dead then print("RESPAWNING...",520,330,6,false,3,true) end
`;

/** Seed a fresh cart with the Lockout arena code and a cool Forerunner palette. */
export function seedLockoutCart(engine: CartEngine): void {
  engine.setLanguage("lua");
  engine.setCode(LOCKOUT_CODE);
  const entries: ReadonlyArray<readonly [number, string]> = [
    [0, "#05070c"], // void
    [1, "#1a2740"], // upper sky
    [2, "#2b3f5e"], // mid sky
    [3, "#3f5a72"], // horizon haze (greenish-grey Lockout mood)
    [6, "#37e0a0"], // health / hit green
    [9, "#5cd0ff"], // shield / energy cyan
    [12, "#eaf2ff"], // ink
    [13, "#a7bad4"], // dim ink
  ];
  for (const [index, hex] of entries) {
    engine.setPaletteColor(
      index,
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    );
  }
}
