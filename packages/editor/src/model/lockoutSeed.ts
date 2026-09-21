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
-- desc:   Halo 2 Lockout homage -- first-person arena vs 7 bots, Xbox 360 core
-- script: lua

-- No netcode on Cartbox, so "8 players" is you + 7 AI bots, one local match.
-- The web player only forwards 8 buttons (arrows + Z X A S), so this is a
-- single-stick console FPS with vertical auto-aim:
--   Up/Down move . Left/Right turn . hold A(keyboard A) to strafe
--   Z fire . X jump . S swap weapon . (menu: Up/Down pick, Z start)

local CENTER_X = ${LOCKOUT_CENTER_X.toFixed(4)}
local CENTER_Y = ${LOCKOUT_CENTER_Y.toFixed(4)}
local CENTER_Z = ${LOCKOUT_CENTER_Z.toFixed(4)}
local COL = {${collidersLua()}}
local SPN = {${spawnsLua()}}
local MRK = {${markersLua()}}
local MW  = {${markerWeaponsLua()}}
local NBOT = ${BOT_COUNT}

local W = {
  br      = { name="Battle Rifle",  dmg=18, cool=9,  rng=44, hs=1.7, mag=36, pel=1, spr=0.02 },
  smg     = { name="SMG",           dmg=8,  cool=3,  rng=24, hs=1.2, mag=60, pel=1, spr=0.05 },
  shotgun = { name="Shotgun",       dmg=13, cool=20, rng=11, hs=1.0, mag=6,  pel=6, spr=0.12 },
  sniper  = { name="Sniper Rifle",  dmg=80, cool=42, rng=130,hs=3.0, mag=4,  pel=1, spr=0.0, zoom=true },
  magnum  = { name="Magnum",        dmg=22, cool=13, rng=36, hs=2.2, mag=8,  pel=1, spr=0.01 },
  sword   = { name="Energy Sword",  dmg=200,cool=22, rng=3.0,hs=1.0, mag=99, pel=1, spr=0.0, melee=true },
}
local MODES = {
  ffa    = { name="Free for All", teams=false, shields=true,  radar=true,  start="br",     target=15, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  slayer = { name="Team Slayer",  teams=true,  shields=true,  radar=true,  start="br",     target=40, weapons={br=true,smg=true,shotgun=true,sniper=true,sword=true} },
  swat   = { name="SWAT",         teams=true,  shields=false, radar=false, start="br",     target=40, weapons={} },
  snipe  = { name="Team Snipers", teams=true,  shields=true,  radar=false, start="sniper", target=25, weapons={} },
}
local MODE_KEYS = {"ffa","slayer","swat","snipe"}

local PR,PH,EYE,STEP = 0.55,1.7,1.5,0.6
local GRAV,MOVE,JUMP,TURN = 0.028,0.15,0.5,0.045

local phase = "menu"
local sel = 1
local MODE = MODES.ffa
local p = nil
local bots = {}
local team = { blue=0, red=0 }
local mtimer = {}
local winner = ""
local prev = {}
local bob = 0
local flash = 0

local function ncol() return #COL // 6 end
local function edge(k, held) local was = prev[k]; prev[k] = held; return held and not was end

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
  if p.y < -6 then respawn(p) end
end

function respawn(who)
  local s = (math.random(0, NBOT)) * 3
  who.x,who.y,who.z = SPN[s+1],SPN[s+2],SPN[s+3]
  who.vy=0; who.hp=100; who.sh = MODE.shields and 100 or 0
  who.dead=false; who.respawn=0
end

local function give(who, slot, id) who["g"..slot]=id; who["a"..slot]=W[id].mag end

-- Forward from yaw + auto-aim pitch p.ap.
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
  local op = math.asin(math.max(-0.999, math.min(0.999, -fy)))
  cartbox.worldcam(oy, op, d, p.zoom and 0.5 or 1.15, tx-CENTER_X, ty-CENTER_Y, tz-CENTER_Z)
end

local function enemy_of(a, o) if not MODE.teams then return true end return a.team ~= o.team end
local function score_kill(k) if MODE.teams then team[k.team]=team[k.team]+1 else k.score=(k.score or 0)+1 end end

-- The nearest live enemy bot inside a yaw cone of where the player faces, for
-- auto-aim (no manual pitch on an 8-button pad). Returns bot + distance.
local function auto_target()
  local best, bd = nil, 1e9
  for _, o in ipairs(bots) do
    if not o.dead and enemy_of(p, o) then
      local dx,dz = o.x-p.x, o.z-p.z
      local m = math.sqrt(dx*dx+dz*dz)
      if m > 0.3 then
        local ang = math.atan(dx, dz) - p.ay
        while ang > math.pi do ang = ang - 2*math.pi end
        while ang < -math.pi do ang = ang + 2*math.pi end
        if math.abs(ang) < 0.25 and m < bd then best, bd = o, m end
      end
    end
  end
  return best, bd
end

local function player_fire()
  if p.cool>0 or p.dead then return end
  local w = W[p.slot==1 and p.g1 or p.g2]
  local ammo = p.slot==1 and p.a1 or p.a2
  if ammo<=0 then p.slot = (p.slot==1) and 2 or 1; return end  -- auto-fall back to the magnum
  p.cool = w.cool; flash = 4
  if p.slot==1 then p.a1=p.a1-1 else p.a2=p.a2-1 end
  local ex,ey,ez = p.x, p.y+EYE, p.z
  local aim = auto_target()
  for _=1,w.pel do
    local fx,fy,fz
    if aim then
      fx,fy,fz = aim.x-ex, (aim.y+1.2)-ey, aim.z-ez
      local m = math.sqrt(fx*fx+fy*fy+fz*fz); fx,fy,fz = fx/m,fy/m,fz/m
    else fx,fy,fz = forward() end
    if w.spr>0 then fx=fx+(math.random()-0.5)*w.spr; fz=fz+(math.random()-0.5)*w.spr end
    local best,bt = nil,1e9
    for _,o in ipairs(bots) do
      if not o.dead and enemy_of(p,o) then
        local t = (o.x-ex)*fx+(o.y+1.2-ey)*fy+(o.z-ez)*fz
        if t>0.4 and t<w.rng then
          local hx,hy,hz = ex+fx*t, ey+fy*t, ez+fz*t
          local m = math.sqrt((o.x-hx)^2+(o.y+1.2-hy)^2+(o.z-hz)^2)
          if m<0.9 and t<bt then best,bt=o,t; o._hy=hy end
        end
      end
    end
    if best then
      local dmg = w.dmg
      if best._hy and best._hy>best.y+1.5 then dmg=dmg*w.hs end
      if best.sh>0 then best.sh=best.sh-dmg; if best.sh<0 then best.hp=best.hp+best.sh; best.sh=0 end
      else best.hp=best.hp-dmg end
      if best.hp<=0 then best.dead=true; best.respawn=100; score_kill(p) end
    end
  end
end

local function try_pickups()
  for i=0,(#MRK//3)-1 do
    local id=MW[i+1]; local legal=MODE.weapons[id]
    mtimer[i+1]=math.max(0,(mtimer[i+1] or 0)-1)
    if legal and mtimer[i+1]==0 then
      local mx,my,mz = MRK[i*3+1],MRK[i*3+2],MRK[i*3+3]
      if math.abs(p.x-mx)<1.4 and math.abs(p.z-mz)<1.6 and math.abs((p.y+1)-my)<2.0 then
        give(p,1,id); p.slot=1; mtimer[i+1]=540
      end
    end
  end
end

local function think_bot(o)
  if o.dead then o.respawn=o.respawn-1; if o.respawn<=0 then respawn(o) end return end
  local dx,dz = o.tx-o.x, o.tz-o.z
  local m = math.sqrt(dx*dx+dz*dz)
  if m<1.0 then local s=math.random(0,NBOT)*3; o.tx,o.tz=SPN[s+1],SPN[s+3]
  else o.x=o.x+(dx/m)*0.06; o.z=o.z+(dz/m)*0.06; o.face=math.atan(dx,dz) end
  local top=0
  for i=0,ncol()-1 do local b=i*6
    if o.x>COL[b+1] and o.x<COL[b+4] and o.z>COL[b+3] and o.z<COL[b+6] then
      if COL[b+5]<=2.6 and COL[b+5]>top then top=COL[b+5] end end end
  o.y=top
  local pdx,pdz = p.x-o.x, p.z-o.z
  local pm = math.sqrt(pdx*pdx+pdz*pdz)
  if enemy_of(o,p) and not p.dead and pm<15 and math.random()<0.02 then
    local dmg = MODE.shields and 8 or 30
    if p.sh>0 then p.sh=p.sh-6 else p.hp=p.hp-dmg end
    if p.hp<=0 then p.dead=true; p.respawn=90; p.deaths=p.deaths+1; score_kill(o) end
  end
  if math.random()<0.004 then
    local v=bots[math.random(1,NBOT)]
    if v and not v.dead and v~=o and enemy_of(o,v) then v.dead=true; v.respawn=100; score_kill(o) end
  end
end

local function reached_target()
  if MODE.teams then
    if team.blue>=MODE.target then return "BLUE TEAM WINS" end
    if team.red>=MODE.target then return "RED TEAM WINS" end
  else
    if (p.score or 0)>=MODE.target then return "YOU WIN" end
    for _,o in ipairs(bots) do if (o.score or 0)>=MODE.target then return "A BOT WINS" end end
  end
end

local function start_match(key)
  MODE = MODES[key]; team.blue,team.red,winner = 0,0,""
  for i=1,(#MRK//3) do mtimer[i]=0 end
  p = { ay=0, ap=0, vy=0, cool=0, score=0, deaths=0, slot=1, team="blue", dead=false, respawn=0 }
  respawn(p); give(p,1,MODE.start); give(p,2,"magnum")
  bots = {}
  for i=1,NBOT do
    local o = { tx=0, tz=0, face=0, score=0, team=(i<=3) and "blue" or "red", g1=MODE.start }
    respawn(o); o.tx,o.tz = o.x,o.z; bots[i]=o
  end
  phase = "play"
end

-- 8-button controls: tank move + turn, hold X-button(=A key, btn 6) to strafe.
local function play_input()
  local strafe = btn(6)
  local sy,cy = math.sin(p.ay), math.cos(p.ay)
  local mvx,mvz = 0,0
  local moving = false
  if not p.dead then
    if btn(0) then mvx=mvx+sy; mvz=mvz+cy; moving=true end
    if btn(1) then mvx=mvx-sy; mvz=mvz-cy; moving=true end
    if strafe then
      if btn(2) then mvx=mvx-cy; mvz=mvz+sy; moving=true end
      if btn(3) then mvx=mvx+cy; mvz=mvz-sy; moving=true end
    else
      if btn(2) then p.ay=p.ay-TURN end
      if btn(3) then p.ay=p.ay+TURN end
    end
    local mm = math.sqrt(mvx*mvx+mvz*mvz)
    if mm>0 then move_axis("x",mvx/mm*MOVE); move_axis("z",mvz/mm*MOVE) end
  end
  if moving then bob = bob + 0.28 end
  -- Ease auto-aim pitch toward the locked enemy so the view tips at them.
  local aim = auto_target()
  local want = 0
  if aim then want = math.asin(math.max(-0.9, math.min(0.9, ((aim.y+1.2)-(p.y+EYE))/math.max(1,aim.x==aim.x and math.sqrt((aim.x-p.x)^2+(aim.z-p.z)^2) or 1)))) end
  p.ap = p.ap + (want - p.ap)*0.2
  if btn(5) and p.grounded and not p.dead then p.vy=JUMP; p.grounded=false end -- X = jump
  if edge("swap", btn(7)) then p.slot = (p.slot==1) and 2 or 1 end             -- S = swap
  local cur = W[p.slot==1 and p.g1 or p.g2]
  p.zoom = cur.zoom and btn(6) and not (btn(0) or btn(1) or btn(2) or btn(3))  -- hold strafe-btn still to zoom a sniper
  if p.cool>0 then p.cool=p.cool-1 end
  if btn(4) then player_fire() end                                            -- Z = fire
end

local function sky()
  for i=0,8 do rect(0, i*40, 1280, 40, i<3 and 1 or (i<5 and 2 or 3)) end
  rect(0, 360, 1280, 360, 3)
end

-- A first-person weapon viewmodel drawn in 2D at the bottom, with view-bob and a
-- muzzle flash, so it reads unmistakably as an FPS.
local function draw_viewmodel(cur)
  local bx = 720 + math.sin(bob)*10
  local by = 720 + math.abs(math.cos(bob))*8
  if cur.melee then
    tri(bx-30,by, bx+70,by-160, bx+40,by-150, 9)      -- energy sword blade
    tri(bx-30,by, bx+40,by-150, bx-40,by-120, 9)
    rect(bx-46,by-40,40,44,13)
  elseif cur.zoom then
    rect(bx-120,by-40,240,34,0); rect(bx-30,by-96,60,60,0) -- sniper body + scope
    rect(bx-150,by-24,300,14,13)
  else
    rect(bx-40,by-150,80,150,0)                        -- rifle body
    rect(bx-24,by-186,48,44,13)
    rect(bx-14,by-210,28,30,0)                         -- barrel
    rect(bx-70,by-40,150,40,13)                        -- stock/grip
  end
  if flash>0 then circ(bx, by-210, 12+flash*3, 9); circ(bx, by-210, 6+flash*2, 12) end
end

function TIC()
  cls(0)

  if phase == "menu" then
    if edge("up", btn(0)) then sel=(sel-2)%4+1 end
    if edge("down", btn(1)) then sel=sel%4+1 end
    if edge("go", btn(4)) then start_match(MODE_KEYS[sel]) end
    sky()
    print("LOCKOUT ARENA", 452, 150, 12, false, 3, true)
    print("you + 7 bots  --  a Forerunner homage on the Xbox 360 core", 396, 214, 13, false, 1, true)
    for i=1,4 do
      local mo = MODES[MODE_KEYS[i]]
      if i==sel then rect(500, 288+(i-1)*46, 300, 34, 1) end
      print(mo.name, 520, 298+(i-1)*46, (i==sel) and 12 or 13, false, 2, true)
    end
    print("Up/Down choose . Z (or A) start", 480, 520, 13, false, 1, true)
    print("Touch: on-screen pad + A fire + B jump (auto-aim + auto weapon)", 360, 636, 13, false, 1, true)
    print("Keyboard: arrows move/turn . hold A strafe . Z fire . X jump . S swap", 340, 664, 13, false, 1, true)
    return
  end

  if phase == "over" then
    sky()
    print(winner, 520, 300, 12, false, 3, true)
    print("Z -> back to game types", 520, 380, 13, false, 1, true)
    if edge("go", btn(4)) then phase="menu" end
    return
  end

  play_input()
  if p.dead then p.respawn=p.respawn-1; if p.respawn<=0 then respawn(p) end
  else move_vertical(); try_pickups() end
  for _,o in ipairs(bots) do think_bot(o) end
  local w = reached_target(); if w then winner=w; phase="over" end
  if flash>0 then flash=flash-1 end

  sky()
  cartbox.clearlights()
  cartbox.sun(-0.4, -0.8, 0.45, 205, 216, 240, 0.9)
  cartbox.light(p.x, p.z, 8, 90, 200, 235, p.y+4, 0.6)   -- a soft cyan fill near the player

  cartbox.clearposes()
  for i=1,NBOT do local o=bots[i]
    if o.dead then cartbox.meshpose(i,0,-50,0,0,0,0,0)
    else cartbox.meshpose(i,o.x,o.y,o.z,o.face,0,0,1) end
  end
  drive_camera()

  -- Reticle (red when auto-aim is locked) + optional scope.
  local cx,cy2 = 640,360
  local locked = auto_target() ~= nil
  local rc = locked and 6 or 12
  if p.zoom then circb(cx,cy2,210,0); line(cx-240,cy2,cx+240,cy2,0); line(cx,cy2-240,cx,cy2+240,0) end
  circb(cx,cy2,10,rc); line(cx-16,cy2,cx-6,cy2,rc); line(cx+6,cy2,cx+16,cy2,rc)
  line(cx,cy2-16,cx,cy2-6,rc); line(cx,cy2+6,cx,cy2+16,rc)

  local cur = W[p.slot==1 and p.g1 or p.g2]
  draw_viewmodel(cur)

  -- HUD.
  rect(40,40,300,18,0); rect(40,40,math.max(0,3*p.hp),18,6)
  if MODE.shields then rect(40,64,300,12,0); rect(40,64,math.max(0,3*p.sh),12,9) end
  local ammo = p.slot==1 and p.a1 or p.a2
  print(MODE.name.."  --  "..cur.name.."  ["..ammo.."]", 40,92,12,false,1,true)
  if MODE.teams then print("BLUE "..team.blue.."   RED "..team.red.."   / "..MODE.target, 40,690,12,false,1,true)
  else print("Score "..(p.score or 0).."   Deaths "..p.deaths.."   / "..MODE.target, 40,690,12,false,1,true) end
  if MODE.radar then
    local rx,ry,rr = 1180,600,70
    circb(rx,ry,rr,13)
    for _,o in ipairs(bots) do
      if not o.dead and enemy_of(p,o) then
        local dx,dz = o.x-p.x, o.z-p.z
        if math.abs(dx)<30 and math.abs(dz)<30 then circ(rx+dx*rr/30, ry+dz*rr/30, 2, 6) end
      end
    end
  end
end
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
