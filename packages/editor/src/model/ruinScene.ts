/**
 * The AAA tier's photoreal reference scene (AAA_FIDELITY_ROADMAP.md F11b): a
 * Forerunner ruin in a misty canyon at dusk, built entirely through the
 * pipeline, as the "ruin" starter.
 *
 * - **The canyon** is a heightfield sculpted as a gorge, then eroded by water
 *   and by slumping (P2), and painted with generated mud, moss and banded
 *   cliff (P1c), triplanar on the walls.
 * - **A cluster-rendered cliff** (F6a): a dense face (some 40 000 triangles of
 *   strata and fractures) behind the ruin, its cluster LOD hierarchy built so
 *   the GPU picks its cut per frame.
 * - **Scanned rock** (F9c): a dense "scan" (a displaced sphere with its colour
 *   per vertex, as a photogrammetry export arrives) run through the scan
 *   pipeline: welded, delit, simplified under budget, unwrapped, its colour
 *   baked into a texture, with LODs and clusters.
 * - **A hero prop baked from high-poly** (F9a): a Forerunner pylon whose
 *   bevelled, inset high-poly detail is baked into the low mesh's normal and
 *   relief maps.
 * - **The ruin**: angular Forerunner slabs, a broken arch and a stair, in
 *   generated Forerunner metal and worn stone.
 * - **A creek** down the gorge (P3's river spline), with F5d's water: depth
 *   absorption, foam and caustics.
 * - **Foliage** (P4): grass cards and reeds on the floor, boulders and cliff
 *   rocks on the walls.
 * - **A Spartan** standing at the ruin's foot, skinned and animated (F7a), for
 *   the close-up.
 * - **Dusk**: a physical sky (F5a) with the sun a few degrees up, volumetric
 *   clouds (F5c), volumetric fog through the gorge (F5b), aerial perspective
 *   scaled for a large landscape, damp ground after rain (F5e).
 *
 * Built lazily (the sidecar is a getter on the starter), about a second.
 */

import { withClusterLods } from "./clusterLod";
import { foliagePreset } from "./foliagePresets";
import { foliageRandom, serializeFoliage, type FoliageCopy, type FoliageLayer } from "./foliage";
import { bakeHighToLow } from "./highToLowBake";
import { hydraulicErosion, thermalErosion } from "./landscapeTools";
import { computeSmoothNormals, serializeMeshAsset, withGeneratedMaps, type MeshAsset, type MeshMaterial, type MeshPrimitive } from "./MeshAsset";
import { packMeshLibrary } from "./meshLibrary";
import { prepareScan } from "./scanImport";
import { defaultProceduralSky, defaultSceneLighting, type SceneLighting } from "./SceneLighting";
import { riverSurface, riverWaterMaterial, type Spline } from "./splines";
import { serializeTerrain, terrainHeight, type Terrain } from "./terrain";

type V3 = [number, number, number];

/** The gorge: a square of terrain, its samples, and its floor's half width. */
const GORGE = { x0: -48, z0: -48, size: 96, samples: 97, floor: 9 } as const;
/** The water's surface height. */
const WATER_Y = -1.2;

const hash = (x: number, y: number, s: number) => {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function noise2(x: number, y: number, s: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s), b = hash(ix + 1, iy, s), c = hash(ix, iy + 1, s), d = hash(ix + 1, iy + 1, s);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}
function fbm(x: number, y: number, s: number, octaves = 4): number {
  let v = 0, a = 0.5, n = 0, f = 1;
  for (let o = 0; o < octaves; o += 1) {
    v += a * noise2(x * f, y * f, s + o);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return v / n;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The gorge's shape before erosion: a floor, walls rising steeply past its edge in ledges, the creek's channel down the middle. */
function gorgeHeight(x: number, z: number): number {
  const wander = creekCentre(z);
  const d = Math.abs(x - wander);
  const wall = smooth(GORGE.floor, GORGE.floor + 14, d);
  const ledges = Math.floor(wall * 5) / 5 * 0.35 + wall * 0.65;
  const rim = 26 + (fbm(x * 0.03, z * 0.03, 7) - 0.5) * 10;
  const channel = -2.4 * (1 - smooth(1.5, 4.5, d));
  const floor = (fbm(x * 0.08, z * 0.08, 11) - 0.5) * 0.8;
  return ledges * rim + channel + floor * (1 - wall);
}

const gen = (kind: "rock" | "cliff" | "grass" | "dirt" | "mud" | "sand" | "stone" | "forerunner", seed: number, tint: readonly [number, number, number], scale = 1, size = 256) => ({ kind, seed, scale, tint, size });

function material(name: string, base: readonly [number, number, number], roughness: number, extra: Partial<MeshMaterial> = {}): MeshMaterial {
  return withGeneratedMaps({ name, baseColorFactor: [base[0], base[1], base[2], 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: roughness, ...extra } as MeshMaterial);
}

let terrain: Terrain | null = null;

/** The gorge (P2): sculpted, eroded, painted with mud along the creek, moss on the flats and banded cliff on the walls. */
export function ruinTerrain(): Terrain {
  if (terrain) return terrain;
  const { x0, z0, size, samples } = GORGE;
  const step = size / (samples - 1);
  const heights = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j += 1) for (let i = 0; i < samples; i += 1) heights[j * samples + i] = gorgeHeight(x0 + i * step, z0 + j * step);
  let shaped: Terrain = {
    id: "ruin-gorge",
    name: "Gorge",
    origin: [x0, 0, z0],
    size: [size, size],
    samples,
    heights,
    layers: [
      { material: material("gorge-mud", [1, 1, 1], 0.6, { generator: gen("mud", 21, [0.85, 0.8, 0.72], 2, 128) }), height: [-4, -1.4] },
      { material: material("gorge-moss", [1, 1, 1], 0.9, { generator: gen("grass", 23, [0.72, 0.8, 0.6], 2, 128) }), up: [0.82, 1] },
      { material: material("gorge-cliff", [1, 1, 1], 0.88, { generator: gen("cliff", 29, [0.86, 0.8, 0.74], 1, 256) }) },
    ],
    tile: 8,
    blend: { up: 0.12, height: 1, noise: 0.5, sharpness: 0.5 },
    triplanar: true,
    castShadows: true,
  } as Terrain;
  shaped = hydraulicErosion(shaped, { droplets: 9000, seed: 71, capacity: 5, erode: 0.35, deposit: 0.2, lifetime: 45 });
  shaped = thermalErosion(shaped, { iterations: 8, talus: 50, rate: 0.4 });
  // The creek's bed cut back in after erosion has silted it: 0.8 m under the water down its middle, rising to its banks.
  const carved = Float32Array.from(shaped.heights);
  for (let j = 0; j < samples; j += 1) {
    for (let i = 0; i < samples; i += 1) {
      const x = x0 + i * step, z = z0 + j * step;
      const d = Math.abs(x - creekCentre(z));
      if (d < 4.5) carved[j * samples + i] = Math.min(carved[j * samples + i]!, WATER_Y - 0.8 + smooth(0, 3.4, d) * 1.6 + Math.max(0, d - 3.4) * 2);
    }
  }
  terrain = { ...shaped, heights: carved };
  return terrain;
}

/** Where the creek runs down the gorge at z. */
function creekCentre(z: number): number {
  return Math.sin(z * 0.06) * 3 + (fbm(z * 0.02, 0.5, 3) - 0.5) * 6;
}

/** The ground at (x, z), or the gorge's shape outside it. */
function groundAt(x: number, z: number): number {
  return terrainHeight(ruinTerrain(), x, z) ?? gorgeHeight(x, z);
}

// --- Geometry helpers --------------------------------------------------------------

interface Streams {
  positions: number[];
  uvs: number[];
  indices: number[];
}
const streams = (): Streams => ({ positions: [], uvs: [], indices: [] });

/** A box (centre, half extents, yaw), its faces UV'd in metres. */
function pushBox(s: Streams, c: readonly number[], h: readonly number[], yaw = 0, tilt = 0): void {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), ct = Math.cos(tilt), st = Math.sin(tilt);
  const place = (x: number, y: number, z: number): V3 => {
    // Tilt about x, then yaw about y.
    const y1 = y * ct - z * st, z1 = y * st + z * ct;
    return [c[0]! + x * cy + z1 * sy, c[1]! + y1, c[2]! - x * sy + z1 * cy];
  };
  const faces: [V3, V3, V3][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, a, b] of faces) {
    const base = s.positions.length / 3;
    const ext = (v: V3) => [v[0] * h[0]!, v[1] * h[1]!, v[2] * h[2]!];
    const en = ext(n), ea = ext(a), eb = ext(b);
    const la = Math.hypot(ea[0]!, ea[1]!, ea[2]!), lb = Math.hypot(eb[0]!, eb[1]!, eb[2]!);
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      s.positions.push(...place(en[0]! + ea[0]! * u! + eb[0]! * v!, en[1]! + ea[1]! * u! + eb[1]! * v!, en[2]! + ea[2]! * u! + eb[2]! * v!));
      s.uvs.push(u! * la, v! * lb);
    }
    s.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
}

function primitive(s: Streams, mat: MeshMaterial): MeshPrimitive {
  const positions = Float32Array.from(s.positions);
  const indices = Uint32Array.from(s.indices);
  return { positions, normals: computeSmoothNormals(positions, indices), uvs: Float32Array.from(s.uvs), indices, material: mat } as MeshPrimitive;
}

// --- The ruin -----------------------------------------------------------------------

/** The ruin's slabs, arch and stair, at the gorge's west foot: angular Forerunner forms in metal over worn stone. */
function ruinMesh(): MeshAsset {
  const metal = material("forerunner-metal", [1, 1, 1], 0.4, { metallicFactor: 0.8, generator: gen("forerunner", 31, [0.78, 0.8, 0.84], 1, 256) });
  const stone = material("worn-stone", [1, 1, 1], 0.85, { generator: gen("stone", 37, [0.82, 0.8, 0.76], 1.5, 256) });
  const glow = { name: "forerunner-glow", baseColorFactor: [0.4, 0.85, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.3, emissiveFactor: [0.6, 2.4, 3.2] } as MeshMaterial;
  const m = streams();
  const s = streams();
  const g = streams();
  const bx = -11, bz = 2;
  const by = groundAt(bx, bz);
  // A plinth of stepped stone, then the stair up it.
  pushBox(s, [bx, by + 0.5, bz], [6, 1, 5]);
  pushBox(s, [bx, by + 1.6, bz], [4.5, 0.6, 3.6]);
  for (let k = 0; k < 6; k += 1) pushBox(s, [bx + 6.4 + k * 0.45, by + 1.7 - k * 0.3, bz], [0.25, 0.15 + (5 - k) * 0.15, 1.6]);
  // Two leaning slabs (the Forerunner's sweeping planes) and the broken arch between them.
  pushBox(m, [bx - 2.2, by + 6.5, bz - 2.6], [0.5, 5, 1.6], 0.2, 0.22);
  pushBox(m, [bx - 2.2, by + 6.5, bz + 2.6], [0.5, 5, 1.6], -0.2, -0.22);
  pushBox(m, [bx - 2.2, by + 11.3, bz - 0.9], [0.45, 0.5, 2.2], 0, -0.15);
  // Fallen pieces.
  pushBox(m, [bx + 4.5, by + 0.5, bz + 6], [2.2, 0.4, 0.9], 0.7, 0.3);
  pushBox(s, [bx - 7, by + 0.4, bz - 5], [1.2, 0.8, 1.4], 0.3);
  // Inlaid light along the slabs' edges.
  pushBox(g, [bx - 1.65, by + 6.5, bz - 2.6], [0.04, 4.6, 0.12], 0.2, 0.22);
  pushBox(g, [bx - 1.65, by + 6.5, bz + 2.6], [0.04, 4.6, 0.12], -0.2, -0.22);
  return { name: "Forerunner ruin", primitives: [primitive(s, stone), primitive(m, metal), primitive(g, glow)] } as MeshAsset;
}

/** The hero prop (F9a): a pylon whose bevels, insets and fins are baked from a high-poly into the low box's maps. */
function heroPylon(): MeshAsset {
  const metal = material("pylon-metal", [0.82, 0.84, 0.88], 0.35, { metallicFactor: 0.85 });
  const low = streams();
  pushBox(low, [0, 2, 0], [0.6, 2, 0.6]);
  const high = streams();
  // The high-poly: the core inset, bevel bands, and fins that stand proud of the low surface.
  pushBox(high, [0, 2, 0], [0.55, 2, 0.55]);
  for (let k = 0; k < 7; k += 1) pushBox(high, [0, 0.35 + k * 0.55, 0], [0.62, 0.06, 0.62]);
  for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) pushBox(high, [sx! * 0.58, 2, sz! * 0.58], [sx ? 0.05 : 0.18, 1.7, sz ? 0.05 : 0.18]);
  const lowMesh: MeshAsset = { name: "Pylon", primitives: [primitive(low, metal)] } as MeshAsset;
  const highMesh: MeshAsset = { name: "Pylon (high)", primitives: [primitive(high, metal)] } as MeshAsset;
  return bakeHighToLow(lowMesh, highMesh, { size: 128, supersample: 1, rays: 0 }).mesh;
}

/** The cluster-rendered cliff (F6a): a dense, stratified, fractured face, its cluster LOD hierarchy built. */
function cliffFace(): MeshAsset {
  const cols = 220, rows = 90, width = 44, height = 26;
  const rock = material("cliff-face", [1, 1, 1], 0.9, { generator: gen("cliff", 41, [0.84, 0.78, 0.72], 1, 256) });
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const u = i / cols, v = j / rows;
      const x = (u - 0.5) * width, y = v * height;
      const strata = Math.sin(y * 2.1 + fbm(x * 0.1, y * 0.1, 5) * 4) * 0.25;
      const fracture = (fbm(x * 0.35, y * 0.35, 9) - 0.5) * 1.6 + (fbm(x * 1.4, y * 1.4, 13) - 0.5) * 0.4;
      positions.push(x, y, strata + fracture);
      uvs.push(x / 4, y / 4);
    }
  }
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  }
  const p = Float32Array.from(positions);
  const idx = Uint32Array.from(indices);
  const mesh = { name: "Cliff face", primitives: [{ positions: p, normals: computeSmoothNormals(p, idx), uvs: Float32Array.from(uvs), indices: idx, material: rock }] } as unknown as MeshAsset;
  return withClusterLods(mesh);
}

/** A "scan" of a boulder (F9c): a dense displaced sphere with per-vertex colour, as a photogrammetry export arrives, through the scan pipeline. */
function scannedRock(): MeshAsset {
  // An icosphere subdivided to about 20 000 triangles.
  let verts: V3[] = [];
  const t = (1 + Math.sqrt(5)) / 2;
  verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => {
    const l = Math.hypot(v[0]!, v[1]!, v[2]!);
    return [v[0]! / l, v[1]! / l, v[2]! / l] as V3;
  });
  let faces: [number, number, number][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let level = 0; level < 5; level += 1) {
    const mid = new Map<string, number>();
    const at = (a: number, b: number) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let k = mid.get(key);
      if (k === undefined) {
        const m: V3 = [(verts[a]![0] + verts[b]![0]) / 2, (verts[a]![1] + verts[b]![1]) / 2, (verts[a]![2] + verts[b]![2]) / 2];
        const l = Math.hypot(...m);
        verts.push([m[0] / l, m[1] / l, m[2] / l]);
        k = verts.length - 1;
        mid.set(key, k);
      }
      return k;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = at(a, b), bc = at(b, c), ca = at(c, a);
      return [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]] as [number, number, number][];
    });
  }
  const positions = new Float32Array(verts.length * 3);
  const colors = new Float32Array(verts.length * 3);
  verts.forEach(([x, y, z], i) => {
    // Squashed, lumpy, faceted by a few planar cuts, with lichen in the hollows.
    const lump = 1 + (fbm(x * 2 + 3, z * 2 + y, 17) - 0.5) * 0.5 + (fbm(x * 7, y * 7 + z, 19) - 0.5) * 0.12;
    const r = lump * 1.6;
    positions.set([x * r * 1.3, Math.max(-0.2, y * r * 0.85), z * r], i * 3);
    const lichen = smooth(0.55, 0.7, fbm(x * 5, z * 5 + y, 23));
    const g = 0.42 + (fbm(x * 9, y * 9, 29) - 0.5) * 0.12;
    colors.set([g * (1 - lichen) + 0.36 * lichen, g * (1 - lichen) + 0.42 * lichen, g * 0.95 * (1 - lichen) + 0.24 * lichen], i * 3);
  });
  const indices = Uint32Array.from(faces.flat());
  const dense = { name: "Scanned boulder", primitives: [{ positions, normals: computeSmoothNormals(positions, indices), uvs: null, indices, material: { name: "scan", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.9 } }] } as unknown as MeshAsset;
  return prepareScan({ mesh: dense, colors }, { triangles: 4000, textureSize: 256 }).mesh;
}

// --- The creek, plants and the Spartan --------------------------------------------------

/** The creek down the gorge (P3), F5d's water over it: absorbing, foaming at its banks. */
export const RUIN_CREEK: Spline = {
  id: "ruin-creek",
  name: "Creek",
  kind: "river",
  terrain: "ruin-gorge",
  depth: 0.8,
  points: [-46, -30, -15, 0, 15, 30, 46].map((z) => ({ p: [creekCentre(z), WATER_Y, z] as const, width: 6 })),
};

function creekWater(): MeshAsset | null {
  const base = riverWaterMaterial();
  const water = { ...base, water: { ...base.water!, absorption: [0.55, 0.11, 0.08] as [number, number, number], scattering: [0.01, 0.026, 0.022] as [number, number, number], foam: 0.6 } };
  const surface = riverSurface(RUIN_CREEK, water as MeshMaterial);
  return surface ? ({ name: "Creek", primitives: [surface] } as MeshAsset) : null;
}

/** Plants scattered over the gorge where `ok` says, as copies in the terrain's space. */
function scatter(seed: number, count: number, ok: (x: number, z: number, y: number) => boolean, scale: readonly [number, number]): FoliageCopy[] {
  const random = foliageRandom(seed);
  const out: FoliageCopy[] = [];
  for (let i = 0; i < count; i += 1) {
    const x = GORGE.x0 + 4 + random() * (GORGE.size - 8);
    const z = GORGE.z0 + 4 + random() * (GORGE.size - 8);
    const yaw = random() * Math.PI * 2;
    const size = scale[0] + random() * (scale[1] - scale[0]);
    const y = groundAt(x, z);
    if (!ok(x, z, y)) continue;
    if (Math.abs(x + 11) < 8 && Math.abs(z - 2) < 7) continue; // clear of the ruin's plinth
    out.push({ x: x - GORGE.x0, z: z - GORGE.z0, yaw, scale: size });
  }
  return out;
}

export function ruinFoliage(): { layer: FoliageLayer; mesh: MeshAsset }[] {
  const id = "ruin-gorge";
  const grass = foliagePreset("grassCards");
  const reeds = foliagePreset("reeds");
  const boulder = foliagePreset("boulder");
  const cliff = foliagePreset("cliffRocks");
  const creek = (x: number, z: number) => Math.abs(x - creekCentre(z));
  return [
    { mesh: grass.mesh, layer: { id: "ruin-grass", name: "Grass", terrain: id, ...grass.settings, scale: [0.6, 1.1], cull: 50, copies: scatter(61, 4500, (x, z, y) => y > WATER_Y + 0.3 && y < 3 && creek(x, z) > 4, [0.6, 1.1]) } },
    { mesh: reeds.mesh, layer: { id: "ruin-reeds", name: "Reeds", terrain: id, ...reeds.settings, copies: scatter(67, 3000, (x, z, y) => creek(x, z) > 3 && creek(x, z) < 4.6 && y < WATER_Y + 0.8, [0.8, 1.4]) } },
    { mesh: boulder.mesh, layer: { id: "ruin-boulders", name: "Boulders", terrain: id, ...boulder.settings, density: 1.2, copies: [], fill: { seed: 71, up: [0.55, 0.9], height: [3, 22] } } },
    { mesh: cliff.mesh, layer: { id: "ruin-cliff-rocks", name: "Cliff rocks", terrain: id, ...cliff.settings, density: 3, copies: [], fill: { seed: 73, up: [0.08, 0.8], height: [3, 30] } } },
  ];
}

/** Dusk in the gorge: the sun 6° up in a physical sky with clouds, mist down the gorge, damp ground after rain. */
export function ruinLighting(): SceneLighting {
  const base = defaultSceneLighting();
  const sun: V3 = (() => {
    const el = (6 * Math.PI) / 180, az = (-35 * Math.PI) / 180;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  })();
  return {
    ...base,
    ambient: 0.25,
    exposure: 1.4,
    tonemap: true,
    shadows: true,
    softShadows: true,
    lights: [{ kind: "directional", direction: sun, color: [1, 1, 1], intensity: 1.2 }],
    sky: {
      ...defaultProceduralSky(),
      sunDirection: sun,
      atmosphere: {
        mie: 4,
        aerialScale: 10,
        clouds: { coverage: 0.55, base: 1.6, thickness: 2.2, density: 45, type: 0.75, scale: 10, windSpeed: 9, windDirection: 70, shadows: 0.8 },
      },
    },
    fog: {
      color: [0.62, 0.66, 0.74],
      density: 0.012,
      start: 6,
      max: 0.6,
      height: { base: 1.5, density: 0.06, falloff: 0.25 },
      volumetric: { albedo: [0.92, 0.92, 0.95], anisotropy: 0.6, distance: 90, ambient: 1 },
    },
    wind: { direction: Math.PI / 2, strength: 0.35, gust: 0.4 },
    weather: { wetness: 0.4, puddles: 0.25, scale: 5 },
  } as SceneLighting;
}

/** Where the cliff, the scanned boulders, the pylon and the Spartan stand. */
const PLACES = {
  cliff: { position: [-30, 0, -6] as V3, yaw: Math.PI / 2 },
  boulders: [[-4, 6, 0.4], [6, -9, 1.2], [-15, -10, 0.8]] as const,
  pylon: [-4.5, 0, -3] as V3,
  spartan: [-5.2, 0, 1.2] as V3,
};

let sidecar: string | null = null;

/**
 * The starter's sidecar: the gorge, its plants and creek, the ruin, the
 * cliff, the scanned boulders, the pylon and the Spartan, under dusk.
 * `spartan` is the arena's skinned soldier and its animator, when given.
 */
export function ruinSidecar(spartan?: { readonly mesh: string; readonly animator: unknown } | null): string {
  if (sidecar) return sidecar;
  const t = ruinTerrain();
  const at = (p: readonly number[], lift = 0) => [p[0]!, groundAt(p[0]!, p[2]!) + lift, p[2]!];
  const rock = serializeMeshAsset(scannedRock());
  const water = creekWater();
  const meshes = [
    { id: "ruin", name: "Forerunner ruin", mesh: serializeMeshAsset(ruinMesh()), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: "cliff", name: "Cliff face", mesh: serializeMeshAsset(cliffFace()), transform: { position: at(PLACES.cliff.position, -2), rotation: [0, PLACES.cliff.yaw, 0], scale: [1, 1, 1] } },
    { id: "pylon", name: "Pylon", mesh: serializeMeshAsset(heroPylon()), transform: { position: at(PLACES.pylon, -0.2), rotation: [0, 0.3, 0], scale: [1, 1, 1] } },
    ...PLACES.boulders.map(([x, z, s], i) => ({ id: `boulder-${i + 1}`, name: `Scanned boulder ${i + 1}`, mesh: rock, transform: { position: at([x, 0, z], -0.3), rotation: [0, i * 2.1, 0], scale: [s * 1.2, s * 1.2, s * 1.2] } })),
    ...(water ? [{ id: "creek", name: "Creek", mesh: serializeMeshAsset(water), transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }] : []),
    ...(spartan ? [{ id: "spartan", name: "Spartan", mesh: spartan.mesh, animator: spartan.animator, transform: { position: at(PLACES.spartan), rotation: [0, 1.1, 0], scale: [1, 1, 1] } }] : []),
  ];
  const packed = packMeshLibrary(meshes);
  sidecar = JSON.stringify({
    version: 2,
    meshes: packed.entries,
    library: packed.library,
    lighting: ruinLighting(),
    terrains: [serializeTerrain(t)],
    foliage: ruinFoliage().map(({ layer, mesh }) => serializeFoliage(t, layer, serializeMeshAsset(mesh))),
    splines: [RUIN_CREEK],
  });
  return sidecar;
}

/**
 * The starter's code: a slow crane round the gorge, drawing in low over the
 * creek and the ruin every forty seconds and back out (the editor's camera
 * takes the Spartan's close-up).
 */
export const RUIN_CODE = `-- title:  Forerunner ruin
-- author: you
-- desc:   the AAA tier's reference scene: a misty gorge at dusk
-- script: lua

local t = 0
function TIC()
 t = t + 1
 cls(0)
 -- A crane round the gorge, drawing in low over the creek and the ruin every forty seconds.
 local phase = (t % 2400) / 2400
 local close = math.max(0, math.sin(phase * math.pi * 2)) ^ 3
 local yaw = t / 900 + 0.8
 local pitch = 0.24 - close * 0.14
 local dist = 46 - close * 30
 cartbox.meshcam(yaw, pitch, dist, 0)
 print("Forerunner ruin -- AAA reference", 24, 24, 12)
end
`;
