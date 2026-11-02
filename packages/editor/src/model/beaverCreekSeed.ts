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
import { LOCKOUT_AUDIO, LOCKOUT_KEY_DIRECTION, LOCKOUT_LIGHTING, LOCKOUT_NAV_AGENT, arenaSceneCenter, bakeLandscape, boxesPrimitive, clampByte, tfbm, type ArenaScene, type Surf } from "./lockoutSeed";
import { foliageRandom, serializeFoliage, type FoliageCopy, type FoliageLayer, type SerializedFoliage } from "./foliage";
import { foliagePreset } from "./foliagePresets";
import { serializeMeshAsset, type EncodedImage } from "./MeshAsset";
import { arenaNavMesh } from "./arenaValidate";
import type { NavMesh } from "./navmesh";
import type { SceneLighting, SceneLightingOverride } from "./SceneLighting";
import { terrainMesh, type Terrain } from "./terrain";
import { boxSolid, csg, solidFromFaces } from "./csg";
import { buildParametric, kitMaterial } from "./shapeGenerators";
import { riverFoam, riverFoamMaterial, riverSurface, riverWaterMaterial, type Spline } from "./splines";
import { hydraulicErosion, thermalErosion } from "./landscapeTools";
import { generateTextures } from "./textureGenerators";
import { withGeneratedMaps, type MeshMaterial } from "./MeshAsset";
import type { MaterialLibrary } from "./materialInstances";
import type { InstanceField } from "./materialInstanceLink";
import { bakeImpostor } from "../render/impostor";
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

// --- The map, built with the editor's tools (EDITOR_PRO_ROADMAP.md P9) ------
// Everything here is visual: the collision above is untouched, so the map
// plays exactly as before. The bases are worn stone shells cut by CSG with
// Forerunner pillars, trim and team lights from the kit; the arch is rock cut
// by CSG; the creek is a river spline's flowing water and foam; the
// materials are instances of a small library of generated sets.

const material = (name: string, color: readonly [number, number, number], roughness: number, extra: Partial<MeshPrimitive["material"]> = {}): MeshPrimitive["material"] => ({
  name,
  baseColorFactor: [color[0], color[1], color[2], 1],
  baseColorImage: null,
  metallicFactor: 0,
  roughnessFactor: roughness,
  ...extra,
});

/** A parent material in the scene's library, and an instance of it (overriding `overrides`). */
const instance = (parentId: string, parent: MeshMaterial, name: string, overrides: Partial<MeshMaterial> = {}): MeshMaterial => ({
  ...parent,
  ...overrides,
  name,
  instance: { of: parentId, overrides: Object.keys(overrides) as InstanceField[] },
});

let library: { library: MaterialLibrary; stone: MeshMaterial; metal: MeshMaterial; rock: MeshMaterial; blue: MeshMaterial; red: MeshMaterial } | null = null;

/**
 * The map's material library (P1b): worn stone and Forerunner metal from the
 * kit, canyon rock and team light as parents, and the instances the map
 * wears — the bases' stone, the arch's rock with a broader macro variation,
 * and blue and red lights that override only their colour.
 */
function beaverMaterials() {
  if (library) return library;
  const stone = { ...kitMaterial("stone"), name: "beaver-stone" };
  const metal = { ...kitMaterial("forerunner"), name: "beaver-metal" };
  const rock = withGeneratedMaps({
    name: "beaver-rock",
    baseColorFactor: [1, 1, 1, 1],
    baseColorImage: null,
    metallicFactor: 1,
    roughnessFactor: 1,
    generator: { kind: "rock", seed: 9, scale: 1.5, tint: [0.86, 0.8, 0.7], size: 256 },
    triplanar: 3,
    macro: { scale: 5, strength: 0.2 },
  });
  const light = material("beaver-light", [0.9, 0.95, 1], 0.4, { emissiveFactor: [1.2, 1.4, 1.6] });
  library = {
    library: [
      { id: "beaver-stone", material: stone },
      { id: "beaver-metal", material: metal },
      { id: "beaver-rock", material: rock },
      { id: "beaver-light", material: light },
    ],
    stone: instance("beaver-stone", stone, "base-stone"),
    metal: instance("beaver-metal", metal, "base-metal"),
    rock: instance("beaver-rock", rock, "arch-rock", { macro: { scale: 8, strength: 0.28 } }),
    blue: instance("beaver-light", light, "blue-light", { baseColorFactor: [0.35, 0.6, 1, 1], emissiveFactor: [0.5, 1.1, 2.6] }),
    red: instance("beaver-light", light, "red-light", { baseColorFactor: [1, 0.4, 0.3, 1], emissiveFactor: [2.6, 0.7, 0.45] }),
  };
  return library;
}

/** Move a mesh, or turn it half round the centre as red's half is blue's. */
function placeMesh(mesh: MeshAsset, dx: number, dy: number, dz: number, turn = false): MeshAsset {
  const k = turn ? -1 : 1;
  return {
    ...mesh,
    primitives: mesh.primitives.map((p) => {
      const positions = new Float32Array(p.positions.length);
      const normals = p.normals ? new Float32Array(p.normals.length) : null;
      for (let i = 0; i < p.positions.length; i += 3) {
        positions[i] = k * (p.positions[i]! + dx);
        positions[i + 1] = p.positions[i + 1]! + dy;
        positions[i + 2] = k * (p.positions[i + 2]! + dz);
        if (normals && p.normals) {
          normals[i] = k * p.normals[i]!;
          normals[i + 1] = p.normals[i + 1]!;
          normals[i + 2] = k * p.normals[i + 2]!;
        }
      }
      return { ...p, positions, normals };
    }),
  };
}

/** Primitives joined into one of `material` (UVs and normals filled in where a part has none). */
function joinPrimitives(parts: readonly MeshPrimitive[], mat: MeshMaterial): MeshPrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const p of parts) {
    const base = positions.length / 3;
    const count = p.positions.length / 3;
    for (let i = 0; i < p.positions.length; i += 1) positions.push(p.positions[i]!);
    for (let v = 0; v < count; v += 1) {
      normals.push(p.normals ? p.normals[v * 3]! : 0, p.normals ? p.normals[v * 3 + 1]! : 1, p.normals ? p.normals[v * 3 + 2]! : 0);
      uvs.push(p.uvs ? p.uvs[v * 2]! : 0, p.uvs ? p.uvs[v * 2 + 1]! : 0);
    }
    for (let i = 0; i < p.indices.length; i += 1) indices.push(p.indices[i]! + base);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material: mat };
}

/** Every primitive of these meshes, of whatever material, as parts to join. */
const partsOf = (...meshes: MeshAsset[]): MeshPrimitive[] => meshes.flatMap((m) => m.primitives);

/**
 * A base's shell (blue's): one block of worn stone, hollowed and cut by CSG
 * for its doors — the same walls the cart collides with, as one clean solid.
 */
function baseShell(stone: MeshMaterial): MeshAsset {
  // The block, x -31..-19, 3.4 m tall, z -6..6 (centred at the origin, placed after).
  let shell = boxSolid([12, ROOF, 12], stone);
  const cut = (size: readonly [number, number, number], at: readonly [number, number, number]) => {
    shell = csg(shell, boxSolid(size, stone), "subtract", { bModel: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1] });
  };
  // Hollow (open to the roof slab above), then the side doors (x -25..-23) and the wide front door (z -2..2), 2.4 m high.
  cut([11, ROOF + 1, 11], [0, 0, 0]);
  cut([2, 2.5, 1.2], [1, -ROOF / 2 + 1.2, 5.75]);
  cut([2, 2.5, 1.2], [1, -ROOF / 2 + 1.2, -5.75]);
  cut([1.2, 2.5, 4], [5.75, -ROOF / 2 + 1.2, 0]);
  return placeMesh(shell, -25, ROOF / 2, 0);
}

/** A base's Forerunner dressing (blue's): pillars at its corners and a trim band under the parapet. */
function baseDressing(metal: MeshMaterial): MeshAsset[] {
  const pillar = buildParametric({ kind: "pillar", params: { radius: 0.36, height: ROOF + 0.9, sides: 6, plinth: 0.22 } }, metal);
  const corners: [number, number][] = [[-31, -6], [-31, 6], [-19, -6], [-19, 6]];
  const trim: ArenaBox[] = [
    [-18.92, ROOF - 0.12, 0, 0.08, 0.14, 6.1],
    [-31.08, ROOF - 0.12, 0, 0.08, 0.14, 6.1],
    [-25, ROOF - 0.12, 6.08, 6.1, 0.14, 0.08],
    [-25, ROOF - 0.12, -6.08, 6.1, 0.14, 0.08],
  ];
  return [...corners.map(([x, z]) => placeMesh(pillar, x, 0, z)), { name: "trim", primitives: [boxesPrimitive(trim, metal, 1)] }];
}

/** A base's team lights (blue's): strips over its doors. */
const BASE_LIGHTS: ArenaBox[] = [
  [-18.9, 2.55, 0, 0.04, 0.05, 1.7],
  [-24, 2.55, 6.04, 0.9, 0.05, 0.04],
  [-24, 2.55, -6.04, 0.9, 0.05, 0.04],
];

/**
 * The arch over the creek: a block of canyon rock with its opening cut by CSG
 * — a rounded-square head (a superellipse) whose crown meets the span the
 * cart stands soldiers on, and piers where the cart's piers are.
 */
function archRock(rock: MeshMaterial): MeshAsset {
  const block = boxSolid([12, 3.5, 3], rock);
  // The opening, in the block's space (its floor at y = -1.75): 10 m wide, 3.1 m high at the crown.
  const a = 5, b = 3.1, power = 4, n = 24, floor = -1.75;
  const outline: [number, number][] = [[a, floor - 0.2]];
  for (let k = 0; k <= n; k += 1) {
    const x = a - (2 * a * k) / n;
    outline.push([x, floor + b * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x / a), power)), 1 / power)]);
  }
  outline.push([-a, floor - 0.2]);
  const front = outline.map(([x, y]) => [x, y, 2] as [number, number, number]);
  const back = outline.map(([x, y]) => [x, y, -2] as [number, number, number]).reverse();
  const sides = outline.map(([x0, y0], i) => {
    const [x1, y1] = outline[(i + 1) % outline.length]!;
    const ex = x1 - x0, ey = y1 - y0;
    return { points: [[x0, y0, 2], [x1, y1, 2], [x1, y1, -2], [x0, y0, -2]] as [number, number, number][], out: [ey, -ex, 0] as [number, number, number] };
  });
  const opening = solidFromFaces("opening", rock, [{ points: front, out: [0, 0, 1] }, { points: back, out: [0, 0, -1] }, ...sides]);
  return placeMesh(csg(block, opening, "subtract"), 0, 1.75, 0);
}

/** The creek as a river spline (P3): down the middle of its bed, under the arch, from one ledge to the other. */
export const BEAVER_CREEK_SPLINE: Spline = {
  id: "beaver-creek",
  name: "Creek",
  kind: "river",
  terrain: "beaver-canyon",
  depth: 0.55,
  points: [-11.4, -7, -3, 0, 3, 7, 11.4].map((z) => ({ p: [Math.sin(z * 0.42) * 0.35, WATER, z] as const, width: 7.4 })),
};

/** The map: bases, arch, steps, pads and teleporters, and the creek's water and foam. */
function beaverMesh(): MeshAsset {
  const m = beaverMaterials();
  const steps = BEAVER_FLIGHTS.flatMap((f) => arenaColliders({ solids: [], flights: [f] }));
  const glow = material("energy", [0.3, 0.9, 1], 0.4, { emissiveFactor: [0.5, 1.6, 1.9] });
  const teleporterPads: ArenaBox[] = BEAVER_TELEPORTERS.map(({ from: [x, y, z] }) => [x, y + 0.05, z, 0.8, 0.05, 0.8]);
  // The roof slabs and parapets (blue's), as the cart has them.
  const roof: ArenaBox[] = [...BLUE_BASE.slice(10), [-25, 0.015, 0, 5.5, 0.015, 5.5]]; // and a stone floor
  const blueStone = [baseShell(m.stone), { name: "roof", primitives: [boxesPrimitive([...roof, ...steps.slice(0, stepsInBases() / 2)], m.stone)] }];
  const redStone = blueStone.map((mesh) => placeMesh(mesh, 0, 0, 0, true));
  // (The base flights are each other's turn: blue's steps are the first half.)
  const dressing = baseDressing(m.metal);
  const water = riverSurface(BEAVER_CREEK_SPLINE, riverWaterMaterial());
  const foam = riverFoam(BEAVER_CREEK_SPLINE, riverFoamMaterial());
  return {
    name: "beaver-creek",
    primitives: [
      joinPrimitives(partsOf(...blueStone, ...redStone), m.stone),
      joinPrimitives(partsOf(...dressing, ...dressing.map((d) => placeMesh(d, 0, 0, 0, true))), m.metal),
      boxesPrimitive(BASE_LIGHTS, m.blue, 1),
      boxesPrimitive(BASE_LIGHTS.map(turnBox), m.red, 1),
      joinPrimitives([...archRock(m.rock).primitives, boxesPrimitive(steps.slice(stepsInBases()), m.rock)], m.rock),
      boxesPrimitive([...BEAVER_MARKERS.map((mk) => mk.box), ...teleporterPads], glow, 1),
      ...(water ? [water] : []),
      ...(foam ? [foam] : []),
    ],
  };
}

/** How many of the flights' steps are the bases' (the first two flights). */
function stepsInBases(): number {
  return BEAVER_FLIGHTS.slice(0, 2).reduce((n, f) => n + arenaColliders({ solids: [], flights: [f] }).length, 0);
}

// --- The canyon (P2's landscape tools) ------------------------------------------

/**
 * The canyon's terrain grid: 96 m square, reaching past the walls to the
 * rims, at the cart's own metre (so inside play its samples are the cart's
 * ground exactly, and it draws in 36 chunks).
 */
const CANYON = { x0: -48, z0: -48, size: 96, samples: 97 };
/** Inside these the terrain is exactly the ground the cart stands soldiers on. */
const PLAY_X = 32;
const PLAY_Z = 15;

/** A smooth hash noise in 0..1 (value noise, cosine-eased), and its sum over octaves. */
function valueNoise(x: number, z: number, seed: number): number {
  const h = (i: number, j: number) => {
    let v = Math.imul(i ^ Math.imul(seed, 0x27d4eb2d), 0x85ebca6b) ^ Math.imul(j, 0xc2b2ae35);
    v = Math.imul(v ^ (v >>> 15), 0x2c1b3c6d);
    return ((v ^ (v >>> 13)) >>> 0) / 4294967296;
  };
  const i = Math.floor(x), j = Math.floor(z);
  const fx = x - i, fz = z - j;
  const u = (1 - Math.cos(fx * Math.PI)) / 2, v = (1 - Math.cos(fz * Math.PI)) / 2;
  const a = h(i, j) + (h(i + 1, j) - h(i, j)) * u;
  const b = h(i, j + 1) + (h(i + 1, j + 1) - h(i, j + 1)) * u;
  return a + (b - a) * v;
}
function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < octaves; o += 1) {
    sum += valueNoise(x * f, z * f, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** How far a point lies outside the play space (0 or less inside it). */
const outside = (x: number, z: number): number => Math.max(Math.abs(x) - PLAY_X, Math.abs(z) - PLAY_Z);

/**
 * The canyon before erosion: inside the play space, the cart's ground; beyond
 * it, walls of rock rising steeply from the ground at its edge to rims 14–20 m
 * up, broken by noise into buttresses and gullies, rolling hills beyond.
 */
function canyonSculpt(x: number, z: number): number {
  const d = outside(x, z);
  if (d <= 0) return groundHeight(BEAVER_GROUND, x, z) ?? 0;
  const foot = groundHeight(BEAVER_GROUND, Math.max(-PLAY_X, Math.min(PLAY_X, x)), Math.max(-PLAY_Z, Math.min(PLAY_Z, z))) ?? 0;
  // The creek's gorge: north and south the walls fall away to a notch the water comes out of (and the intro flies down).
  const gorge = Math.abs(z) > PLAY_Z ? 0.7 * Math.exp(-((x / 9) ** 2)) : 0;
  const rim = (12.5 + fbm(x * 0.05, z * 0.05, 61) * 10 + Math.max(0, d - 10) * 0.15) * (1 - gorge);
  // Steep near the play space, buttressed along it (the wall's foot wanders in and out a little).
  const wander = (fbm(x * 0.12, z * 0.12, 67) - 0.5) * 2.2;
  const t = 1 - Math.exp(-Math.max(0, d + wander * Math.min(1, d / 2)) / 2.1);
  const jag = (fbm(x * 0.32, z * 0.32, 71) - 0.5) * 3 * Math.min(1, d / 2.5);
  // Strata: the wall steps back in ledges a metre or two apart.
  const raw = foot + (rim - foot) * t;
  const strata = raw + (Math.round(raw / 1.7) * 1.7 - raw) * 0.35 * Math.min(1, d / 3);
  return strata + jag;
}

let terrain: Terrain | null = null;

/**
 * The canyon's terrain (P2): sculpted, then eroded by water and by slumping,
 * and the play space put back exactly as the cart has it. Grass on the flats,
 * wet mud along the creek, banded rock on the walls (all triplanar).
 */
export function beaverTerrain(): Terrain {
  if (terrain) return terrain;
  const { x0, z0, size, samples } = CANYON;
  const step = size / (samples - 1);
  const heights = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j += 1) for (let i = 0; i < samples; i += 1) heights[j * samples + i] = canyonSculpt(x0 + i * step, z0 + j * step);
  const t = beaverTextures();
  let shaped: Terrain = {
    id: "beaver-canyon",
    name: "Canyon",
    origin: [x0, 0, z0],
    size: [size, size],
    samples,
    heights,
    layers: [
      // Wet mud and stone down the creek's bed and banks.
      { material: { ...material("terrain-mud", [1, 1, 1], 0.55), baseColorImage: t.mud }, height: [-3, -0.32] },
      { material: { ...material("terrain-grass", [1, 1, 1], 0.9), baseColorImage: t.grass }, up: [0.8, 1] },
      { material: { ...material("terrain-rock", [1, 1, 1], 0.92), baseColorImage: t.rock } },
    ],
    tile: 6,
    parent: "beaver-map",
    blend: { up: 0.12, height: 1, noise: 0.5, sharpness: 0.5 },
    triplanar: true,
    castShadows: true,
  };
  // Water carves gullies down the walls; loose rock slumps to its angle of repose.
  shaped = hydraulicErosion(shaped, { droplets: 14000, seed: 59, capacity: 5, erode: 0.35, deposit: 0.2, lifetime: 45 });
  shaped = thermalErosion(shaped, { iterations: 12, talus: 52, rate: 0.4 });
  // The play space as the cart has it, the walls' first metre eased back into it.
  const eroded = shaped.heights;
  const out = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j += 1) {
    for (let i = 0; i < samples; i += 1) {
      const x = x0 + i * step, z = z0 + j * step;
      const d = outside(x, z);
      const k = j * samples + i;
      const w = d <= 0 ? 0 : Math.min(1, d / 1.2);
      out[k] = heights[k]! + (eroded[k]! - heights[k]!) * w;
    }
  }
  terrain = { ...shaped, heights: out };
  return terrain;
}

// --- Beyond the rim (DEMO_QUALITY_ROADMAP.md V2) ---------------------------------
// The canyon's grid stops 48 m out, a few metres past its rims, and the sky
// showed straight past it. Round it, as round Lockout: real ground near enough
// for its parallax to matter (the hills), and a vista baked into the sky beyond.

/** The hills round the canyon: 384 m square, a sample every 6 m, a grid line on the canyon's edge (±48 m). */
const HILLS = { x0: -192, z0: -192, size: 384, samples: 65 };
/** Hill cells wholly inside this (half a side) are left out: the canyon's own ground is there. */
const HILLS_HOLE = 42;
/** The hills' textures (texels a side): seen from 50 m and more, a quarter of the canyon's do. */
const HILLS_TEXTURE = 64;
/** Under the canyon's outer band the hills sit this far below its ground, so the canyon covers them. */
const HILLS_TUCK = 0.4;

const smoothstep = (e0: number, e1: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** The canyon terrain's height at (x, z), bilinear between its samples (clamped to its grid). */
function canyonHeightAt(x: number, z: number): number {
  const t = beaverTerrain();
  const { x0, z0, size, samples } = CANYON;
  const step = size / (samples - 1);
  const fi = Math.max(0, Math.min(samples - 1, (x - x0) / step));
  const fj = Math.max(0, Math.min(samples - 1, (z - z0) / step));
  const i = Math.min(samples - 2, Math.floor(fi)), j = Math.min(samples - 2, Math.floor(fj));
  const u = fi - i, v = fj - j;
  const h = (a: number, b: number) => t.heights[(j + b) * samples + i + a]!;
  return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v) + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
}

/**
 * The ground round the canyon at (x, z): its rims carried on into rolling,
 * wooded hills, the creek's valley running on north and south, rising to
 * ridges at the edge of the grid. Under the canyon it follows the canyon's own
 * ground, a little below it, meeting it exactly along the canyon's edge.
 */
function hillsGround(x: number, z: number): number {
  const edge = CANYON.x0 + CANYON.size; // 48
  const inside = Math.max(Math.abs(x), Math.abs(z));
  if (inside < edge) return canyonHeightAt(x, z) - HILLS_TUCK;
  const rim = canyonHeightAt(x, z);
  if (inside === edge) return rim;
  const d = inside - edge;
  // Rolling hills, and the creek's valley on through them north and south.
  const roll = 16 + fbm(x * 0.018, z * 0.018, 401) * 26 + (fbm(x * 0.06, z * 0.06, 409) - 0.5) * 6;
  const valley = Math.exp(-((x / (14 + d * 0.25)) ** 2)) * smoothstep(0, 40, Math.abs(z) - edge);
  const hills = roll * (1 - 0.75 * valley);
  // Ridges toward the grid's edge, so it ends on a skyline the vista continues.
  const ridge = smoothstep(90, 185, inside) * (30 + fbm(x * 0.01, z * 0.01, 419) * 45);
  return rim + (hills + ridge - rim) * smoothstep(0, 28, d);
}

let hills: Terrain | null = null;
let hillsTextures: { grass: EncodedImage; rock: EncodedImage } | null = null;

/** The hills round the canyon (V2): real ground out to 192 m, grass on the flats and rock on the steeps. */
export function beaverHills(): Terrain {
  if (hills) return hills;
  const { x0, z0, size, samples } = HILLS;
  const step = size / (samples - 1);
  const heights = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j += 1) for (let i = 0; i < samples; i += 1) heights[j * samples + i] = hillsGround(x0 + i * step, z0 + j * step);
  const holes = new Uint8Array((samples - 1) * (samples - 1));
  for (let j = 0; j < samples - 1; j += 1) {
    for (let i = 0; i < samples - 1; i += 1) {
      const ax = x0 + i * step, az = z0 + j * step;
      if (ax >= -HILLS_HOLE && ax + step <= HILLS_HOLE && az >= -HILLS_HOLE && az + step <= HILLS_HOLE) holes[j * (samples - 1) + i] = 1;
    }
  }
  hillsTextures ??= { grass: bakeLandscape(grassSurface, 1, HILLS_TEXTURE).albedo, rock: bakeLandscape(sandstoneSurface, 1, HILLS_TEXTURE).albedo };
  const t = hillsTextures;
  hills = {
    id: "beaver-hills",
    name: "Hills",
    origin: [x0, 0, z0],
    size: [size, size],
    samples,
    heights,
    holes,
    layers: [
      { material: { ...material("terrain-grass", [0.92, 0.95, 0.88], 0.9), baseColorImage: t.grass }, up: [0.78, 1] },
      { material: { ...material("terrain-rock", [1, 1, 1], 0.92), baseColorImage: t.rock } },
    ],
    // Coarser than the canyon's: seen from inside it, the hills are 50 m off and more.
    tile: 12,
    parent: "beaver-map",
    blend: { up: 0.14, height: 2, noise: 0.6 },
    triplanar: true,
    // Out of play and below the sun, they shade nothing that matters: spared the shadow passes.
    castShadows: false,
  };
  return hills;
}

/** A broadleaf canopy seen from a kilometre off: crowns in clumps, shade between them. */
function canopySurface(x: number, y: number): Surf {
  const crowns = tfbm(x, y, 24, 431, 3);
  const clumps = tfbm(x, y, 6, 433, 2);
  const gap = crowns < 0.4 ? 1 : 0;
  const v = 78 + (crowns - 0.5) * 60 + (clumps - 0.5) * 34 - gap * 34;
  return { r: clampByte(v * 0.58), g: clampByte(v * 0.86), b: clampByte(v * 0.5), h: crowns - gap * 0.3, rough: 0.95, metal: 0, emis: 0 };
}

/** The vista's extent, and the square round the hills it leaves out (half a side). */
const VISTA = { size: 3200, samples: 65, hole: 180, texture: 48 };

/** The far country at (x, z): wooded hills round the canyon's, rising to a range of blue mountains. */
function vistaGround(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const woods = 30 + fbm(x * 0.006, z * 0.006, 441) * 70;
  const range = 120 + 520 * fbm(x * 0.0022, z * 0.0022, 443, 5) ** 1.6;
  return woods + (range - woods) * smoothstep(500, 1300, r);
}

let vista: Terrain | null = null;
let canopyTexture: EncodedImage | null = null;
let farRock: EncodedImage | null = null;

/**
 * Beaver Creek's vista (V2; HALO_INFINITE_STYLE_ROADMAP.md I7): wooded country
 * past the hills and a range of mountains on the horizon, baked into the sky
 * at load, so it costs nothing a frame.
 */
export function beaverVista(): Terrain {
  if (vista) return vista;
  const { size, samples: n, hole, texture } = VISTA;
  const origin: [number, number, number] = [-size / 2, 0, -size / 2];
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j += 1) for (let i = 0; i < n; i += 1) heights[j * n + i] = vistaGround(origin[0] + (i / (n - 1)) * size, origin[2] + (j / (n - 1)) * size);
  const holes = new Uint8Array((n - 1) * (n - 1));
  const cell = size / (n - 1);
  for (let j = 0; j < n - 1; j += 1) {
    for (let i = 0; i < n - 1; i += 1) {
      const x = origin[0] + (i + 0.5) * cell, z = origin[2] + (j + 0.5) * cell;
      if (Math.max(Math.abs(x), Math.abs(z)) < hole) holes[j * (n - 1) + i] = 1;
    }
  }
  // Small maps, and no normal maps: from a kilometre off a finer grain only shimmers,
  // and the vista is drawn once, into the sky, so its relief is its own shading.
  canopyTexture ??= bakeLandscape(canopySurface, 2, texture).albedo;
  farRock ??= bakeLandscape(sandstoneFarSurface, 2, texture).albedo;
  const woods: MeshPrimitive["material"] = { ...material("vista-woods", [0.42, 0.52, 0.4], 0.95), baseColorImage: canopyTexture };
  const rock: MeshPrimitive["material"] = { ...material("vista-rock", [0.48, 0.5, 0.54], 0.9), baseColorImage: farRock };
  const snow = material("vista-snow", [0.84, 0.87, 0.92], 0.85);
  vista = {
    id: "beaver-vista",
    name: "Far country",
    origin,
    size: [size, size],
    samples: n,
    heights,
    holes,
    layers: [
      { material: snow, up: [0.65, 1], height: [520, 5000] },
      { material: woods, up: [0.6, 1], height: [-200, 420] },
      { material: rock },
    ],
    tile: 160,
    blend: { up: 0.14, height: 40, noise: 0.7 },
    // Hazier than Lockout's: a valley's air at noon, not a summit's.
    vista: { haze: 0.55 },
  };
  return vista;
}

/** Bare mountain rock far off: grey, faintly banded, without the canyon's warm strata. */
function sandstoneFarSurface(x: number, y: number): Surf {
  const grain = tfbm(x, y, 16, 451, 3);
  const bands = Math.sin(((y + tfbm(x, y, 4, 453, 2) * 30) / 256) * Math.PI * 2 * 5) * 0.5 + 0.5;
  const v = 0.72 + (grain - 0.5) * 0.4 + (bands - 0.5) * 0.12;
  return { r: clampByte(150 * v), g: clampByte(150 * v), b: clampByte(156 * v), h: grain, rough: 0.92, metal: 0, emis: 0 };
}

// --- The art pass (BEAVER_CREEK_ROADMAP.md B9) --------------------------------

/** Meadow grass: greens, mottled, with worn patches of earth showing through. */
function grassSurface(x: number, y: number): Surf {
  const blades = tfbm(x, y, 64, 211, 2);
  const tufts = tfbm(x, y, 12, 213, 3);
  const earth = Math.max(0, Math.min(1, (tfbm(x, y, 4, 217, 3) - 0.58) * 6));
  const g = 0.75 + (blades - 0.5) * 0.5 + (tufts - 0.5) * 0.35;
  const r = (70 * g) * (1 - earth) + 118 * earth;
  const gg = (108 * g) * (1 - earth) + 98 * earth;
  const b = (46 * g) * (1 - earth) + 70 * earth;
  return { r: clampByte(r), g: clampByte(gg), b: clampByte(b), h: tufts, rough: 0.9, metal: 0, emis: 0 };
}

/** Canyon sandstone: warm, in horizontal strata (texture V is height on a cliff, B6), weathered and streaked. */
function sandstoneSurface(x: number, y: number): Surf {
  const warp = tfbm(x, y, 4, 223, 3) * 22;
  const strata = Math.sin(((y + warp) / 256) * Math.PI * 2 * 7) * 0.5 + 0.5;
  const fine = Math.sin(((y + warp * 0.6) / 256) * Math.PI * 2 * 23) * 0.5 + 0.5;
  const grain = tfbm(x, y, 32, 227, 3);
  const v = 0.78 + (strata - 0.5) * 0.28 + (fine - 0.5) * 0.08 + (grain - 0.5) * 0.3;
  return { r: clampByte(168 * v), g: clampByte(146 * v), b: clampByte(118 * v), h: strata * 0.6 + grain * 0.4, rough: 0.92, metal: 0, emis: 0 };
}

let textures: { grass: EncodedImage; rock: EncodedImage; mud: EncodedImage } | null = null;

/** The canyon's terrain textures, baked once on first use (albedo only: 128² each; the mud from P1c's generator). */
function beaverTextures(): { grass: EncodedImage; rock: EncodedImage; mud: EncodedImage } {
  textures ??= {
    grass: bakeLandscape(grassSurface, 1, 128).albedo,
    rock: bakeLandscape(sandstoneSurface, 1, 128).albedo,
    mud: generateTextures({ kind: "mud", seed: 13, scale: 2, tint: [0.92, 0.88, 0.8], size: 128 }).albedo,
  };
  return textures;
}

/** The bases' footprints (both teams'), the weapon pads and the creek's water, which no plant may stand in. */
function plantFree(x: number, z: number): boolean {
  if (Math.abs(x) < 4.6 && Math.abs(z) < 11.2) return true; // in the water
  if (Math.abs(x) > 18.6 && Math.abs(x) < 31.4 && Math.abs(z) < 6.4) return true; // inside or against a base
  if (ARCH.some(([cx, , cz, hx, , hz]) => Math.abs(x - cx) < hx + 0.5 && Math.abs(z - cz) < hz + 0.5)) return true;
  return BEAVER_MARKERS.some((m) => Math.abs(x - m.box[0]) < 1.4 && Math.abs(z - m.box[2]) < 1.4);
}

/**
 * Plants scattered where `ok` says over the canyon floor, `count` tries from
 * `seed`, as copies in the terrain's space (deterministic: the same on every load).
 */
function scatter(seed: number, count: number, ok: (x: number, z: number, y: number) => boolean, scale: readonly [number, number]): FoliageCopy[] {
  const random = foliageRandom(seed);
  const g = BEAVER_GROUND;
  const out: FoliageCopy[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = -32.5 + random() * 65;
    const z = -15.5 + random() * 31;
    const yaw = random() * Math.PI * 2;
    const size = scale[0] + random() * (scale[1] - scale[0]);
    const y = groundHeight(g, x, z);
    if (y === null || plantFree(x, z) || !ok(x, z, y)) continue;
    // Flat enough: the ground a pace either side within 0.3 m.
    const flat = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([dx, dz]) => Math.abs((groundHeight(g, x + dx!, z + dz!) ?? y) - y) < 0.3);
    if (!flat) continue;
    out.push({ x: x - CANYON.x0, z: z - CANYON.z0, yaw, scale: size });
  }
  return out;
}

/**
 * Beaver Creek's plants (B9; foliage.ts): meadow grass over the floor and
 * ledges, reeds along the creek's banks — both low, so they hide no one —
 * and, out of play on the canyon's rims, broadleaf trees, pines and boulders
 * that frame it. Grass and reeds are painted copies (placed here, in code,
 * clear of the bases, pads and water); the rims are filled by rules.
 */
export function beaverFoliage(): { layer: FoliageLayer; mesh: MeshAsset }[] {
  const terrainId = "beaver-canyon";
  const grass = foliagePreset("grassCards");
  const reeds = foliagePreset("reeds");
  const broadleaf = foliagePreset("broadleaf");
  const pine = foliagePreset("pine");
  const boulder = foliagePreset("boulder");
  const cliff = foliagePreset("cliffRocks");
  const half = CANYON.size / 2;
  // The rims (P4's fill rules): trees on the level ground above the walls, drawn as impostors past 32 m.
  const rim: [number, number] = [12.5, 30];
  return [
    { mesh: grass.mesh, layer: { id: "beaver-grass", name: "Meadow grass", terrain: terrainId, ...grass.settings, scale: [0.6, 1.1], cull: 45, copies: scatter(31, 3200, (_x, _z, y) => y > -0.1 && y < 3.2, [0.6, 1.1]) } },
    { mesh: reeds.mesh, layer: { id: "beaver-reeds", name: "Reeds", terrain: terrainId, ...reeds.settings, copies: scatter(37, 4200, (x, z, y) => Math.abs(x) > 4.6 && Math.abs(x) < 6.2 && Math.abs(z) < 11 && y < 0.2, [0.8, 1.3]) } },
    { mesh: broadleaf.mesh, layer: { id: "beaver-trees", name: "Broadleaf trees", terrain: terrainId, ...broadleaf.settings, density: 1.4, copies: [], fill: { seed: 41, up: [0.88, 1], height: rim, clear: [half, half, 17], patches: { scale: 22, cover: 0.65 } }, ...impostorOf(broadleaf.mesh) } },
    { mesh: pine.mesh, layer: { id: "beaver-pines", name: "Pines", terrain: terrainId, ...pine.settings, density: 1, copies: [], fill: { seed: 43, up: [0.85, 1], height: rim, clear: [half, half, 17], patches: { scale: 18, cover: 0.55 } }, ...impostorOf(pine.mesh) } },
    { mesh: boulder.mesh, layer: { id: "beaver-boulders", name: "Boulders", terrain: terrainId, ...boulder.settings, density: 1.2, copies: [], fill: { seed: 47, up: [0.55, 0.9], height: [3.5, 16] } } },
    // Rock breaking out of the walls (P4's cliff rocks), on the steep faces only.
    { mesh: cliff.mesh, layer: { id: "beaver-cliff-rocks", name: "Cliff rocks", terrain: terrainId, ...cliff.settings, density: 3, copies: [], fill: { seed: 53, up: [0.08, 0.8], height: [3.4, 24] } } },
  ];
}

/** A tree's impostor (P4): two crossed cards baked from it, drawn in its place past 32 m. */
function impostorOf(mesh: MeshAsset): { impostor?: { distance: number; mesh: string } } {
  const baked = bakeImpostor(mesh);
  return baked ? { impostor: { distance: 32, mesh: serializeMeshAsset(baked.mesh) } } : {};
}

/** The plants as the sidecar stores them. */
function beaverFoliageStored(): SerializedFoliage[] {
  const t = beaverTerrain();
  const h = beaverHills();
  return [
    ...beaverFoliage().map(({ layer, mesh }) => serializeFoliage(t, layer, serializeMeshAsset(mesh))),
    ...beaverHillsFoliage().map(({ layer, mesh }) => serializeFoliage(h, layer, serializeMeshAsset(mesh))),
  ];
}

/**
 * Woods on the hills (V2): broadleaf trees and pines in patches over the gentle
 * ground, filled by rules (nothing stored per copy), kept off the canyon
 * itself, and drawn as impostors past 32 m, which is nearly all of them.
 */
export function beaverHillsFoliage(): { layer: FoliageLayer; mesh: MeshAsset }[] {
  const broadleaf = foliagePreset("broadleaf");
  const pine = foliagePreset("pine");
  const centre = HILLS.size / 2;
  // The canyon's square, corners and all (its half-diagonal is 68 m), stays clear: its rims have their own trees.
  const clear: [number, number, number] = [centre, centre, 70];
  return [
    { mesh: broadleaf.mesh, layer: { id: "beaver-hill-trees", name: "Hill woods", terrain: "beaver-hills", ...broadleaf.settings, density: 0.35, scale: [1.2, 2], cull: 320, copies: [], fill: { seed: 461, up: [0.86, 1], clear, patches: { scale: 60, cover: 0.55 } }, ...impostorOf(broadleaf.mesh) } },
    { mesh: pine.mesh, layer: { id: "beaver-hill-pines", name: "Hill pines", terrain: "beaver-hills", ...pine.settings, density: 0.3, scale: [1.4, 2.4], cull: 320, copies: [], fill: { seed: 463, up: [0.8, 1], height: [22, 200], clear, patches: { scale: 45, cover: 0.5 } }, ...impostorOf(pine.mesh) } },
  ];
}

let layout: LightmapLayout | null = null;

/** The grey box's light-map layout (B1's fingerprint is taken from it). */
export function beaverMapLayout(): LightmapLayout {
  layout ??= layoutLightmap(beaverMesh(), IDENTITY, { density: 4, maxSize: 1024 });
  return layout;
}

// Two bounces (P6): the shade under the arch and in the bases fills with light off the grass and stone.
const BAKE = { rays: 64, distance: 9, sun: LOCKOUT_KEY_DIRECTION, bounce: 0.9, contrast: 1.2, bounces: 2 };

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
let center: ArenaPoint | null = null;
export function beaverCenter(): ArenaPoint {
  // Memoised: it builds the map's whole mesh, its CSG included (about 0.8 s).
  center ??= arenaSceneCenter(BEAVER_MAP, beaverMesh());
  return center;
}

/**
 * Beaver Creek's own sky (DEMO_QUALITY_ROADMAP.md V1). It had Lockout's: an
 * alpine dome 3 km up, with snow peaks, a glacier's mist and the ring. A green
 * valley at noon is under a softer blue, hazier toward a horizon of wooded
 * ridges and far blue mountains, with fair-weather cumulus drifting over and
 * a pale moon in the east. The sun is Lockout's, as the canyon's bakes are.
 */
export const BEAVER_SKY: NonNullable<SceneLighting["sky"]> = {
  zenith: [0.24, 0.46, 0.8],
  horizon: [0.78, 0.86, 0.94],
  // Below the horizon (seen only past the vista's edge): the valley's haze over green country.
  below: [0.56, 0.64, 0.6],
  sunDirection: [...LOCKOUT_KEY_DIRECTION],
  sunColor: [1, 0.94, 0.82],
  clouds: 0.3,
  cloudColor: [0.95, 0.96, 0.98],
  mountains: [
    // Near: wooded ridges, green-grey in the haze, no snow.
    { height: 5, peaks: 13, rock: [0.36, 0.44, 0.4], snow: [0.36, 0.44, 0.4], snowLine: 1, haze: 0.55, seed: 17 },
    // Far: a blue range, snow on its highest tips.
    { height: 10, peaks: 7, rock: [0.42, 0.48, 0.56], snow: [0.9, 0.92, 0.96], snowLine: 0.8, haze: 0.35, seed: 23 },
  ],
  seed: 19,
  objects: [{ kind: "planet", direction: [-0.72, 0.3, 0.62], radius: 3.2, color: [0.84, 0.85, 0.88], atmosphere: [0.7, 0.8, 0.95], seed: 5 }],
  cloudLayers: [
    // Fair-weather cumulus: bright, puffy, with gaps of blue between.
    { cover: 0.42, scale: 0.42, wind: [0.022, 0.009], color: [0.98, 0.98, 0.99], opacity: 0.85, seed: 47 },
    // A high, thin veil above them.
    { cover: 0.22, scale: 0.16, wind: [0.01, 0.004], color: [0.94, 0.96, 0.99], opacity: 0.4, seed: 53 },
  ],
};

/** Daylight down a green canyon: Lockout's sun, its own valley sky, its own probes, no arena lamps. */
export const BEAVER_LIGHTING: SceneLighting = {
  ...LOCKOUT_LIGHTING,
  // The shade's fill: the same open blue sky as Lockout's, with grass, not snow, below it.
  environment: { ...LOCKOUT_LIGHTING.environment, ground: [0.36, 0.4, 0.32] },
  sky: BEAVER_SKY,
  lights: [
    ...LOCKOUT_LIGHTING.lights.filter((l) => l.kind === "directional"),
    // A warm lamp under each base's roof, so the ground floor reads in the shade (P9).
    { kind: "point", position: [-25, 2.9, 0], color: [1, 0.88, 0.72], intensity: 3.2, range: 10 },
    { kind: "point", position: [25, 2.9, 0], color: [1, 0.88, 0.72], intensity: 3.2, range: 10 },
  ],
  // The haze takes the valley sky's horizon, so the hills fade into it.
  fog: { color: [0.74, 0.83, 0.92], density: 0.008, start: 24, max: 0.28, glow: { color: [1, 0.92, 0.78], strength: 0.25 } },
  // Daylight in a canyon (B7): soft sun shadows, and a breeze down the creek for its plants (B6).
  softShadows: true,
  wind: { direction: Math.PI / 2, strength: 0.45, gust: 0.5 },
  probes: [
    { name: "blue base", position: [-25, 1.6, 0], min: [-31, 0, -6], max: [-19, 3.4, 6] },
    { name: "red base", position: [25, 1.6, 0], min: [19, 0, -6], max: [31, 3.4, 6] },
    { name: "canyon", position: [0, 4, 0], min: [-34, -2, -17], max: [34, 14, 17] },
  ],
  // P6: inside a base the view cools and steadies (a post volume each), and the eye adapts stepping in and out.
  postVolumes: [
    { id: "blue-base", name: "Blue base", center: [-25, 1.7, 0], size: [11.5, 3.4, 11.5], blend: 1.5, exposure: 0.9, saturation: 0.92, contrast: 1.04 },
    { id: "red-base", name: "Red base", center: [25, 1.7, 0], size: [11.5, 3.4, 11.5], blend: 1.5, exposure: 0.9, saturation: 0.92, contrast: 1.04 },
    { id: "creek", name: "Under the arch", center: [0, 0.6, 0], size: [9, 2.6, 3], blend: 2, saturation: 1.08 },
  ],
  autoExposure: { min: -0.5, max: 1.5, up: 1.4, down: 3, key: 0.2 },
};

/**
 * Beaver Creek re-lit in physical units on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F11a-11; see physicalRelight.ts): the same noon sun, a fair-weather cumulus
 * deck whose shadows cross the canyon, and the canyon's haze a medium the sun lights.
 */
export function beaverRelight(): SceneLightingOverride {
  return {
    physical: {
      atmosphere: { altitude: 600, clouds: { coverage: 0.45, base: 1.4, thickness: 1.6, density: 50, type: 0.75, scale: 8, windSpeed: 6, windDirection: 90, shadows: 0.7 } },
      volumetric: { albedo: [0.94, 0.95, 0.97], anisotropy: 0.6, distance: 100, ambient: 1 },
    },
  };
}

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
    // On the AAA tier, re-lit in physical units (F11a-11).
    lighting: { ...BEAVER_LIGHTING, ...(beaverProbes() ? { lightProbes: beaverProbes() } : {}), aaa: beaverRelight() },
    navmesh: beaverNavMesh(),
    // The canyon, the hills round it (real ground) and the far country (baked into the sky): V2.
    terrains: [beaverTerrain(), beaverHills(), beaverVista()],
    timelines: [BEAVER_INTRO],
    ragdollColliders: beaverRagdollColliders(),
    decalMarks: [],
    foliage: beaverFoliageStored(),
    audio: LOCKOUT_AUDIO,
    materials: beaverMaterials().library,
    splines: [BEAVER_CREEK_SPLINE],
  }),
};

// (Pads by weapon, for the tests and the validator's messages.)
export const BEAVER_PADS = arenaPads(BEAVER_MAP);
export const beaverGroundAt = (x: number, z: number) => groundHeight(BEAVER_GROUND, x, z);
