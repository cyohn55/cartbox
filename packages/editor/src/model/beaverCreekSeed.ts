/**
 * Beaver Creek (BEAVER_CREEK_ROADMAP.md B8): a homage to Halo 2's Beaver Creek
 * and Halo: Combat Evolved's Battle Creek, in grey box. The layout is the
 * original's, scaled to Lockout's units; the art (B9) is ours.
 *
 * A short box canyon running east-west. Blue's base stands at the west end,
 * red's at the east, each two storeys:
 * - a ground floor with doors front and sides;
 * - a ramp up inside to an open roof behind a parapet, where the Sniper
 *   Rifle lies and a teleporter waits.
 *
 * A wadeable creek crosses the middle, north to south, out of the rock and
 * back into it. A natural arch spans it, climbed by steps of rock at either
 * end, with the Rocket Launcher on the creek bed beneath.
 *
 * Grassy ledges three metres up run along both canyon walls, reached by
 * ramps near each end. Each base's teleporter sends you to the ledge beside
 * the other base. Red's half is blue's turned about the centre, so neither
 * team's view is the other's mirror image.
 */

import {
  arenaColliders,
  arenaFlight,
  arenaGround,
  arenaPads,
  groundBoxes,
  groundHeight,
  type ArenaBox,
  type ArenaGround,
  type ArenaMap,
  type ArenaMarker,
  type ArenaPoint,
  type ArenaSpawn,
  type ArenaTeleporter,
} from "./forerunnerArena";
import { applyLightmapImage, bakeLightProbes, bakeLightmap, layoutFingerprint, layoutLightmap, type LightmapLayout } from "./lightmap";
import { planProbeGrid, type LightProbeGrid, type StoredLightProbes } from "./lightProbes";
import type { MeshAsset, MeshPrimitive } from "./MeshAsset";
import { base64ToBytes } from "./base64";
import { BEAVER_LIGHTMAP } from "./beaverCreekLightmap.generated";
import { BEAVER_PROBES } from "./beaverCreekProbes.generated";
import { LOCKOUT_AUDIO, LOCKOUT_KEY_DIRECTION, LOCKOUT_LIGHTING, LOCKOUT_NAV_AGENT, arenaSceneCenter, boxesPrimitive, type ArenaScene } from "./lockoutSeed";
import { arenaNavMesh } from "./arenaValidate";
import type { NavMesh } from "./navmesh";
import type { SceneLighting } from "./SceneLighting";
import { terrainMesh, type Terrain } from "./terrain";
import type { SceneTimeline } from "./timeline";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

// --- The layout -------------------------------------------------------------
// Metres: the canyon floor is y = 0, 66 m long (x) between its end walls and
// 32 m wide (z) between its side walls; the ledges are 3 m up; the creek bed
// is 1 m down, its water 0.45 m down.

const LEDGE = 3;
const CREEK_BED = -1;
const WATER = -0.45;
const ROOF = 3.4;

/** The ground: canyon floor, creek, ledges, their ramps, and the canyon's walls. */
function beaverHeight(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax >= 33 || az >= 16) return 12; // the canyon's walls
  if (az >= 11) return LEDGE; // the ledges along the walls (the creek runs out of the rock beneath them)
  // Ramps up to the ledges, 4 m long, near either end of each.
  if (az >= 7 && ax >= 8 && ax <= 14) return (LEDGE * (az - 7)) / 4;
  // The creek: a bed 5 m wide, banks sloping a metre over two.
  if (ax < 2.5) return CREEK_BED;
  if (ax < 4.5) return CREEK_BED * ((4.5 - ax) / 2);
  return 0;
}

export const BEAVER_GROUND: ArenaGround = arenaGround(-34, -34, 1, 69, beaverHeight);

/** Turn a box, point or yaw half round the centre: red's half is blue's so turned. */
const turnBox = ([cx, cy, cz, hx, hy, hz]: ArenaBox): ArenaBox => [-cx, cy, -cz, hx, hy, hz];
const turnPoint = ([x, y, z]: ArenaPoint): ArenaPoint => [-x, y, -z];

/** Blue's base, at the west end (x < 0): walls, roof slab, parapets. */
const BLUE_BASE: ArenaBox[] = [
  // Walls, 3.4 m: the back; the sides with doors (2 m wide, 2.4 m high); the front with a wide door.
  [-30.75, 1.7, 0, 0.25, 1.7, 6],
  [-28, 1.7, 5.75, 3, 1.7, 0.25],
  [-21, 1.7, 5.75, 2, 1.7, 0.25],
  [-24, 2.9, 5.75, 1, 0.5, 0.25],
  [-28, 1.7, -5.75, 3, 1.7, 0.25],
  [-21, 1.7, -5.75, 2, 1.7, 0.25],
  [-24, 2.9, -5.75, 1, 0.5, 0.25],
  [-19.25, 1.7, -4, 0.25, 1.7, 2],
  [-19.25, 1.7, 4, 0.25, 1.7, 2],
  [-19.25, 2.9, 0, 0.25, 0.5, 2],
  // The roof slab, open over the stairwell (x -30.5..-28, z -4.6..1.5).
  [-23.5, ROOF - 0.2, 0, 4.5, 0.2, 6],
  [-29.5, ROOF - 0.2, 3.75, 1.5, 0.2, 2.25],
  [-29.5, ROOF - 0.2, -5.3, 1.5, 0.2, 0.7],
  // Parapets round the roof, waist high, open at the front's middle.
  [-30.75, ROOF + 0.4, 0, 0.25, 0.4, 6],
  [-25, ROOF + 0.4, 5.75, 6, 0.4, 0.25],
  [-25, ROOF + 0.4, -5.75, 6, 0.4, 0.25],
  [-19.25, ROOF + 0.4, 3.5, 0.25, 0.4, 2.5],
  [-19.25, ROOF + 0.4, -3.5, 0.25, 0.4, 2.5],
];

/** The arch over the creek: its span, 3.5 m up, on two piers on the banks. */
const ARCH: ArenaBox[] = [
  [0, 3.3, 0, 6, 0.2, 1.5],
  [-5.5, 1.55, 0, 0.5, 1.55, 1.5],
  [5.5, 1.55, 0, 0.5, 1.55, 1.5],
];

const BEAVER_SOLIDS: ArenaBox[] = [...BLUE_BASE, ...BLUE_BASE.map(turnBox), ...ARCH];

const BEAVER_FLIGHTS = [
  // Inside each base: up from the ground floor to the roof.
  arenaFlight("z", -29.25, 1, 1.5, -1, ROOF, 0),
  arenaFlight("z", 29.25, 1, -1.5, 1, ROOF, 0),
  // Up the rocks to either end of the arch.
  arenaFlight("x", 0, 1.5, -6, -1, 3.5, 0),
  arenaFlight("x", 0, 1.5, 6, 1, 3.5, 0),
];

const pad = (x: number, floor: number, z: number): ArenaBox => [x, floor + 0.4, z, 0.28, 0.4, 0.28];

/**
 * The weapon pads, each starting on what the original has there and turning
 * through the rest of the sandbox (LOCKOUT_ARSENAL_ROADMAP.md).
 */
const BLUE_PADS: { box: ArenaBox; rotation: ArenaMarker["weapon"][] }[] = [
  { box: pad(-22, ROOF, -3), rotation: ["sniper", "beamrifle"] }, // the roof
  { box: pad(-27, 0, 3), rotation: ["smg", "ar", "plasmarifle", "needler", "spiker", "plasmapistol"] }, // the ground floor
  { box: pad(-8, 0, -4), rotation: ["br", "dmr", "carbine", "needlerifle"] }, // the creek's west bank
];
const BEAVER_MARKERS: ArenaMarker[] = [
  ...BLUE_PADS.map((p) => ({ box: p.box, weapon: p.rotation[0]!, rotation: p.rotation })),
  ...BLUE_PADS.map((p) => ({ box: turnBox(p.box), weapon: p.rotation[0]!, rotation: p.rotation })),
  // Beneath the arch, on the creek bed: the power weapons.
  { box: pad(0, CREEK_BED, 0), weapon: "rocket", rotation: ["rocket", "fuelrod", "splaser"] },
  // Over the creek's mouths on the ledges: close quarters.
  { box: pad(0, LEDGE, 13), weapon: "sword", rotation: ["sword", "hammer"] },
  { box: pad(0, LEDGE, -13), weapon: "shotgun", rotation: ["shotgun", "mauler", "bruteshot", "concussion"] },
];

const BLUE_SPAWNS: ArenaPoint[] = [
  [-25, 0, -3],
  [-25, 0, 3],
  [-21.5, 0, 0],
  [-27, ROOF, -2.5],
  [-16, 0, -6],
];
const BEAVER_SPAWNS: ArenaSpawn[] = [
  ...BLUE_SPAWNS.map((at) => ({ at, team: "blue" as const })),
  ...BLUE_SPAWNS.map((at) => ({ at: turnPoint(at), team: "red" as const })),
  // Free for All also spawns on the ledges.
  ...([
    [-10, LEDGE, 13],
    [10, LEDGE, -13],
    [-20, LEDGE, -13],
    [20, LEDGE, 13],
  ] as ArenaPoint[]).map((at) => ({ at })),
];

const BLUE_DESTINATIONS: ArenaPoint[] = [
  [-25, 0, 0], // the ground floor
  [-24, ROOF, 0], // the roof
  [-28, ROOF, 4], // the top of the stairs
  [-24, 0, 8], // outside the north door
  [-24, 0, -8],
  [-16, 0, 0], // before the base
  [-32, 0, 9], // behind it
  [-11, 0, 4], // the bank
  [-11, 0, -8], // the foot of a ramp
  [-11, LEDGE, 13], // the ledges
  [-20, LEDGE, -13],
  [-26, LEDGE, 13],
  [-8, 3.5, 0], // the arch's west steps, half way
  [-3, 3.5, 0], // its top
  [-2, CREEK_BED, 7], // the creek
];
const BEAVER_DESTINATIONS: ArenaPoint[] = [...BLUE_DESTINATIONS, ...BLUE_DESTINATIONS.map(turnPoint)];
/** The power positions: each roof, the arch top, and the ledges (indices into the destinations). */
const BEAVER_POWER = [1, 13, 9, 1 + BLUE_DESTINATIONS.length, 13 + BLUE_DESTINATIONS.length, 9 + BLUE_DESTINATIONS.length];

/** Each roof's teleporter sends you to the ledge beside the other base, facing back into the canyon. */
const BEAVER_TELEPORTERS: ArenaTeleporter[] = [
  { from: [-26, ROOF, 3.5], to: [16, LEDGE, 13], yaw: -Math.PI / 2 },
  { from: [26, ROOF, -3.5], to: [-16, LEDGE, -13], yaw: Math.PI / 2 },
];

export const BEAVER_MAP: ArenaMap = {
  id: "beaver",
  name: "Beaver Creek",
  solids: BEAVER_SOLIDS,
  flights: BEAVER_FLIGHTS,
  spawns: BEAVER_SPAWNS,
  destinations: BEAVER_DESTINATIONS,
  power: BEAVER_POWER,
  // King of the Hill: the arch top, each base's ground floor, the creek under the arch, the ledges.
  hills: [[0, 3.5, 0], [-25, 0, 0], [25, 0, 0], [0, CREEK_BED, 5], [-14, LEDGE, 13], [14, LEDGE, -13]],
  ball: [0, 3.5, 0],
  deathY: -6,
  markers: BEAVER_MARKERS,
  ground: BEAVER_GROUND,
  teleporters: BEAVER_TELEPORTERS,
};

// --- The grey box ----------------------------------------------------------

const material = (name: string, color: readonly [number, number, number], roughness: number, extra: Partial<MeshPrimitive["material"]> = {}): MeshPrimitive["material"] => ({
  name,
  baseColorFactor: [color[0], color[1], color[2], 1],
  baseColorImage: null,
  metallicFactor: 0,
  roughnessFactor: roughness,
  ...extra,
});

/** The map in grey box: bases, arch, steps, the pads and teleporters glowing, and the creek's water. */
function beaverMesh(): MeshAsset {
  const steps = BEAVER_FLIGHTS.flatMap((f) => arenaColliders({ solids: [], flights: [f] }));
  const glow = material("energy", [0.3, 0.9, 1], 0.4, { emissiveFactor: [0.5, 1.6, 1.9] });
  const teleporterPads: ArenaBox[] = BEAVER_TELEPORTERS.map(({ from: [x, y, z] }) => [x, y + 0.05, z, 0.8, 0.05, 0.8]);
  const water: ArenaBox = [0, WATER - 0.02, 0, 4.5, 0.02, 11];
  return {
    name: "beaver-creek",
    primitives: [
      boxesPrimitive([...BEAVER_SOLIDS.slice(0, BLUE_BASE.length * 2), ...steps.slice(0, stepsInBases())], material("base-concrete", [0.56, 0.57, 0.6], 0.75)),
      boxesPrimitive([...ARCH, ...steps.slice(stepsInBases())], material("rock", [0.42, 0.4, 0.37], 0.9)),
      boxesPrimitive([...BEAVER_MARKERS.map((m) => m.box), ...teleporterPads], glow, 1),
      // The creek (B5): rippling, flowing down the canyon (+Z), bending the bed beneath it.
      boxesPrimitive(
        [water],
        material("creek-water", [0.16, 0.3, 0.34], 0.06, {
          alphaMode: "blend",
          baseColorFactor: [0.16, 0.3, 0.34, 0.55],
          reflectivity: 1.3,
          refraction: 0.3,
          softDepth: 0.35,
          water: { strength: 0.35, scale: 1.2, speed: 0.7, flow: Math.PI / 2 },
        }),
        1,
      ),
    ],
  };
}

/** How many of the flights' steps are the bases' (the first two flights). */
function stepsInBases(): number {
  return BEAVER_FLIGHTS.slice(0, 2).reduce((n, f) => n + arenaColliders({ solids: [], flights: [f] }).length, 0);
}

let terrain: Terrain | null = null;

/** The canyon's terrain: the same heights the cart stands soldiers on, grass on the flats, rock on the walls. */
export function beaverTerrain(): Terrain {
  if (terrain) return terrain;
  const g = BEAVER_GROUND;
  terrain = {
    id: "beaver-canyon",
    name: "Canyon",
    origin: [g.x0, 0, g.z0],
    size: [g.step * (g.n - 1), g.step * (g.n - 1)],
    samples: g.n,
    heights: Float32Array.from(g.heights),
    layers: [
      { material: material("terrain-grass", [0.3, 0.42, 0.22], 0.9), up: [0.8, 1] },
      { material: material("terrain-rock", [0.42, 0.4, 0.37], 0.92) },
    ],
    tile: 6,
    parent: "beaver-map",
    blend: { up: 0.12, height: 1, noise: 0.5 },
    castShadows: true,
  };
  return terrain;
}

let layout: LightmapLayout | null = null;

/** The grey box's light-map layout (B1's fingerprint is taken from it). */
export function beaverMapLayout(): LightmapLayout {
  layout ??= layoutLightmap(beaverMesh(), IDENTITY, { density: 4, maxSize: 1024 });
  return layout;
}

const BAKE = { rays: 64, distance: 9, sun: LOCKOUT_KEY_DIRECTION, bounce: 0.9, contrast: 1.2 };

/** The canyon's terrain as an occluder: its walls shade the bases. */
const occluders = () => [
  { mesh: beaverMapLayout().mesh, model: IDENTITY },
  { mesh: terrainMesh(beaverTerrain()), model: IDENTITY },
];

export function bakeBeaverLightmap(progress?: (done: number) => void): Uint8ClampedArray {
  return bakeLightmap(beaverMapLayout(), occluders(), BAKE, progress);
}

export function bakeBeaverProbes(progress?: (done: number) => void): LightProbeGrid {
  const min: [number, number, number] = [-33, -1.5, -16];
  const max: [number, number, number] = [33, 9, 16];
  return bakeLightProbes(min, max, planProbeGrid(min, max, 3), occluders(), BAKE, progress);
}

function beaverProbes(): StoredLightProbes | null {
  if (!BEAVER_PROBES.probes || BEAVER_PROBES.fingerprint !== layoutFingerprint(beaverMapLayout())) return null;
  return { ...BEAVER_PROBES.probes, bake: { sun: LOCKOUT_KEY_DIRECTION, distance: BAKE.distance, bounce: BAKE.bounce } };
}

/** The grey box as it ships: with its light map when the stored bake is current. */
function litBeaverMesh(): MeshAsset {
  const l = beaverMapLayout();
  if (BEAVER_LIGHTMAP.fingerprint !== layoutFingerprint(l)) return beaverMesh();
  return applyLightmapImage(l.mesh, { mime: "image/png", bytes: base64ToBytes(BEAVER_LIGHTMAP.png) });
}

/** The scene's centre, which the mesh camera orbits (as the player bounds the scene). */
export function beaverCenter(): ArenaPoint {
  return arenaSceneCenter(BEAVER_MAP, beaverMesh());
}

/** Daylight down a green canyon: Lockout's sun and sky, its own probes, no arena lamps. */
export const BEAVER_LIGHTING: SceneLighting = {
  ...LOCKOUT_LIGHTING,
  lights: LOCKOUT_LIGHTING.lights.filter((l) => l.kind === "directional"),
  fog: { color: [0.72, 0.82, 0.92], density: 0.008, start: 24, max: 0.28, glow: { color: [1, 0.92, 0.78], strength: 0.25 } },
  probes: [
    { name: "blue base", position: [-25, 1.6, 0], min: [-31, 0, -6], max: [-19, 3.4, 6] },
    { name: "red base", position: [25, 1.6, 0], min: [19, 0, -6], max: [31, 3.4, 6] },
    { name: "canyon", position: [0, 4, 0], min: [-34, -2, -17], max: [34, 14, 17] },
  ],
};

/** The intro: down the creek from the north ledge, over the arch, to blue's base. */
export const BEAVER_INTRO: SceneTimeline = {
  name: "Intro",
  duration: 7.5,
  loop: false,
  autoplay: false,
  hold: false,
  tracks: [
    {
      kind: "camera",
      keys: [
        { time: 0, eye: [0, 14, 24], target: [0, 0, 0], fov: 60, ease: "smooth" },
        { time: 2.6, eye: [10, 7, 9], target: [0, 2, 0], fov: 56, ease: "smooth" },
        { time: 5.2, eye: [-6, 5, -5], target: [-20, 2, 0], fov: 52, ease: "smooth" },
        { time: 7.5, eye: [-14, 4, -4], target: [-25, 2.5, 0], fov: 50, ease: "smooth" },
      ],
    },
    {
      kind: "value",
      name: "letterbox",
      keys: [
        { time: 0, value: 0, ease: "curve", curve: [0.16, 1, 0.3, 1] },
        { time: 0.8, value: 1, ease: "step" },
        { time: 6.9, value: 1, ease: "curve", curve: [0.7, 0, 0.84, 0] },
        { time: 7.5, value: 0, ease: "step" },
      ],
    },
  ],
};

let navMesh: NavMesh | null = null;

export function beaverNavMesh(): NavMesh {
  navMesh ??= arenaNavMesh(BEAVER_MAP, LOCKOUT_NAV_AGENT);
  return navMesh;
}

/** Ragdolls and debris land on the boxes, and on coarse boxes standing in for the canyon floor. */
function beaverRagdollColliders(): ArenaBox[] {
  const ground = groundBoxes(BEAVER_GROUND, 4).filter(([cx, , cz]) => Math.abs(cx) < 33 && Math.abs(cz) < 16);
  return [...arenaColliders(BEAVER_MAP), ...ground];
}

/** Beaver Creek as an arena scene (B2). */
export const BEAVER_SCENE: ArenaScene = {
  id: "beaver",
  name: "Beaver Creek",
  map: BEAVER_MAP,
  parts: () => ({
    mesh: litBeaverMesh(),
    lighting: { ...BEAVER_LIGHTING, ...(beaverProbes() ? { lightProbes: beaverProbes() } : {}) },
    navmesh: beaverNavMesh(),
    terrains: [beaverTerrain()],
    timelines: [BEAVER_INTRO],
    ragdollColliders: beaverRagdollColliders(),
    decalMarks: [],
    foliage: [],
    audio: LOCKOUT_AUDIO,
  }),
};

// (Pads by weapon, for the tests and the validator's messages.)
export const BEAVER_PADS = arenaPads(BEAVER_MAP);
export const beaverGroundAt = (x: number, z: number) => groundHeight(BEAVER_GROUND, x, z);
