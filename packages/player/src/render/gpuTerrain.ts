/**
 * Terrain at scale (AAA_FIDELITY_ROADMAP.md F6c): a heightfield of any size up
 * to 4097² drawn with no CPU meshing, shaded from a runtime virtual texture.
 *
 * **CDLOD.** One grid patch ({@link TERRAIN_PATCH} cells a side) is the only
 * mesh. Each frame a quadtree over the terrain (its nodes' height ranges known
 * once, from a min/max pyramid of the cells) picks the nodes the eye needs: a
 * node splits while the eye is within {@link TERRAIN_RANGE} of its children's
 * size (distances in the ground plane). Each chosen node is a copy of the
 * patch, its model scaling the patch to the node's square and height range,
 * so the GPU culls the copies as it culls any others. The vertex shader reads
 * the heights (`heightTex`, 16 bits a sample in red and green) at each vertex,
 * and morphs a vertex onto its node's coarser grid as it nears the end of the
 * node's range, so neighbouring nodes a level apart meet without cracks.
 *
 * **The virtual texture.** The blended layers (rules, painted weights, the
 * blend's noise, triplanar projection, each layer's maps and factors) are
 * baked on the GPU into pages: a square window round the eye a level, each
 * twice the last's size, and one of the whole terrain, side by side in one
 * atlas of albedo, normal, roughness/metal and occlusion (whose G carries a
 * relief height for parallax, and whose alpha is 0 over cut cells). A node shades from the page of its own level,
 * which its window is sized to hold, so terrain shading is one sample a map
 * however many layers it blends. A window moves (and re-bakes) when the eye
 * has moved an eighth of it.
 *
 * **Relief.** The nearest nodes are displaced by the page's relief (fading out
 * with their morph, so they still meet their neighbours); the rest take it as
 * parallax occlusion.
 */

import { composeModelMatrix, type DecodedTexture, type Mat4, type MeshAsset, type MeshMaterial, type MeshSceneInstance, type Terrain } from "@cartbox/editor";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebGPU handles aren't typed in this build */

/** Cells a side of the one patch every node draws. */
export const TERRAIN_PATCH = 16;
/** A node splits while the eye is within this many of its children's sizes (in the ground plane). */
export const TERRAIN_RANGE = 5;
/** Where in a node's range its vertices start to morph to the coarser grid (a share of the range). */
export const TERRAIN_MORPH = 0.8;
/** Texels a side of a virtual-texture page. */
export const TERRAIN_PAGE_TEXELS = 512;
/** The nearest page's texel, in metres. */
export const TERRAIN_TEXEL = 0.025;
/** Nodes of a level a side of that level's page: its window holds every node of the level the eye can choose. */
const NODES_PER_PAGE = 22;
/** Pages that follow the eye, at most; past them a node shades from the whole terrain's page. */
export const MAX_TERRAIN_PAGES = 8;
/** A window moves by an eighth of its size. */
const PAGE_SNAP = 8;
/** The deepest relief displaced or parallaxed, in metres. */
export const MAX_TERRAIN_RELIEF = 0.5;

/** How a terrain is laid out for the GPU. */
export interface TerrainPlan {
  /** The terrain's extent (metres, x and z), and the cells a side of its grid. */
  readonly size: readonly [number, number];
  readonly cells: number;
  /** The smallest node's side (metres), and the levels above it to the root. */
  readonly leaf: number;
  readonly levels: number;
  /** The nearest page's side (metres): each further page's is twice the last's. */
  readonly page: number;
  /** Pages that follow the eye (the whole terrain's comes after them in the atlas). */
  readonly eyePages: number;
  readonly texels: number;
}

export function terrainPlan(t: Terrain, texels = TERRAIN_PAGE_TEXELS): TerrainPlan {
  const page = texels * TERRAIN_TEXEL;
  const leaf = page / NODES_PER_PAGE;
  const extent = Math.max(t.size[0], t.size[1]);
  const levels = Math.max(0, Math.ceil(Math.log2(extent / leaf)));
  // A page that would hold the whole terrain twice over is the whole terrain's page.
  let eyePages = 0;
  while (eyePages < MAX_TERRAIN_PAGES && eyePages < levels && page * 2 ** eyePages < 2 * extent) eyePages += 1;
  return { size: [t.size[0], t.size[1]], cells: t.samples - 1, leaf, levels, page, eyePages, texels };
}

/**
 * The heights as the GPU reads them: RG = the height above `min` in 16 bits of
 * `range`, B = 255 where the cell starting at this sample is cut away (a hole,
 * or wholly below the floor), A = 255.
 */
export function encodeTerrainHeights(t: Terrain): { data: Uint8Array; min: number; range: number } {
  const n = t.samples;
  let min = Infinity;
  let max = -Infinity;
  for (const h of t.heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const range = Math.max(max - min, 0.01);
  const data = new Uint8Array(n * n * 4);
  const floor = t.floor ?? -Infinity;
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const k = j * n + i;
      const q = Math.max(0, Math.min(65535, Math.round(((t.heights[k]! - min) / range) * 65535)));
      data[k * 4] = q >> 8;
      data[k * 4 + 1] = q & 255;
      let cut = false;
      if (i < n - 1 && j < n - 1) {
        if (t.holes && t.holes[j * (n - 1) + i]) cut = true;
        else if (floor > -Infinity) {
          const top = Math.max(t.heights[k]!, t.heights[k + 1]!, t.heights[k + n]!, t.heights[k + n + 1]!);
          cut = t.origin[1] + top < floor;
        }
      }
      data[k * 4 + 2] = cut ? 255 : 0;
      data[k * 4 + 3] = 255;
    }
  }
  return { data, min, range };
}

/** A node the eye needs: its corner (metres from the terrain's), side, level and height range (local). */
export interface TerrainNode {
  readonly x: number;
  readonly z: number;
  readonly size: number;
  readonly level: number;
  readonly min: number;
  readonly max: number;
}

/** The terrain's quadtree: each node's height range from a min/max pyramid of its cells. */
export class TerrainTree {
  private readonly mins: Float32Array[] = [];
  private readonly maxs: Float32Array[] = [];
  private readonly sides: number[] = [];

  constructor(
    private readonly t: Terrain,
    readonly plan: TerrainPlan,
    /** Displacement below the heights (the relief), so a displaced node's bounds still hold it. */
    private readonly relief = 0,
  ) {
    const n = t.samples;
    const c = n - 1;
    let side = c;
    let mins = new Float32Array(c * c);
    let maxs = new Float32Array(c * c);
    for (let j = 0; j < c; j += 1) {
      for (let i = 0; i < c; i += 1) {
        const k = j * n + i;
        const a = t.heights[k]!, b = t.heights[k + 1]!, d = t.heights[k + n]!, e = t.heights[k + n + 1]!;
        mins[j * c + i] = Math.min(a, b, d, e);
        maxs[j * c + i] = Math.max(a, b, d, e);
      }
    }
    for (;;) {
      this.mins.push(mins);
      this.maxs.push(maxs);
      this.sides.push(side);
      if (side <= 1) break;
      const next = Math.ceil(side / 2);
      const nm = new Float32Array(next * next).fill(Infinity);
      const nx = new Float32Array(next * next).fill(-Infinity);
      for (let j = 0; j < side; j += 1) {
        for (let i = 0; i < side; i += 1) {
          const to = (j >> 1) * next + (i >> 1);
          nm[to] = Math.min(nm[to]!, mins[j * side + i]!);
          nx[to] = Math.max(nx[to]!, maxs[j * side + i]!);
        }
      }
      mins = nm;
      maxs = nx;
      side = next;
    }
  }

  /** The heights' range over cells [i0, i1) × [j0, j1). */
  private range(i0: number, j0: number, i1: number, j1: number): [number, number] {
    const span = Math.max(i1 - i0, j1 - j0, 1);
    const p = Math.min(this.sides.length - 1, Math.max(0, Math.ceil(Math.log2(span)) - 1));
    const side = this.sides[p]!;
    let lo = Infinity;
    let hi = -Infinity;
    for (let b = j0 >> p; b <= (j1 - 1) >> p && b < side; b += 1) {
      for (let a = i0 >> p; a <= (i1 - 1) >> p && a < side; a += 1) {
        lo = Math.min(lo, this.mins[p]![b * side + a]!);
        hi = Math.max(hi, this.maxs[p]![b * side + a]!);
      }
    }
    return [lo, hi];
  }

  /** The nodes to draw for an eye at (x, z), metres from the terrain's corner. */
  select(eye: readonly [number, number]): TerrainNode[] {
    const { leaf, levels, size, cells } = this.plan;
    const dx = size[0] / cells;
    const dz = size[1] / cells;
    const out: TerrainNode[] = [];
    const visit = (x: number, z: number, level: number) => {
      if (x >= size[0] || z >= size[1]) return;
      const s = leaf * 2 ** level;
      const away = Math.hypot(Math.max(x - eye[0], 0, eye[0] - (x + s)), Math.max(z - eye[1], 0, eye[1] - (z + s)));
      if (level > 0 && away <= (TERRAIN_RANGE * s) / 2) {
        const h = s / 2;
        visit(x, z, level - 1);
        visit(x + h, z, level - 1);
        visit(x, z + h, level - 1);
        visit(x + h, z + h, level - 1);
        return;
      }
      const i0 = Math.max(0, Math.floor(x / dx));
      const j0 = Math.max(0, Math.floor(z / dz));
      const i1 = Math.min(cells, Math.max(i0 + 1, Math.ceil((x + s) / dx)));
      const j1 = Math.min(cells, Math.max(j0 + 1, Math.ceil((z + s) / dz)));
      const [lo, hi] = this.range(Math.min(i0, cells - 1), Math.min(j0, cells - 1), i1, j1);
      out.push({ x, z, size: s, level, min: lo - this.relief, max: hi });
    };
    visit(0, 0, levels);
    return out;
  }

  /** The terrain this tree was built over. */
  get terrain(): Terrain {
    return this.t;
  }
}

/** Each eye-following page's corner (metres from the terrain's), snapped to an eighth of its side. */
export function pageCorners(plan: TerrainPlan, eye: readonly [number, number]): [number, number][] {
  return Array.from({ length: plan.eyePages }, (_, k) => {
    const side = plan.page * 2 ** k;
    const snap = side / PAGE_SNAP;
    return [Math.round((eye[0] - side / 2) / snap) * snap, Math.round((eye[1] - side / 2) / snap) * snap];
  });
}

/** A node's model: the patch's unit square to its square, its unit height to its height range. */
export function terrainNodeModel(t: Terrain, node: TerrainNode): Mat4 {
  return composeModelMatrix([t.origin[0] + node.x, t.origin[1] + node.min, t.origin[2] + node.z], [0, 0, 0], [node.size, Math.max(node.max - node.min, 0.01), node.size]);
}

/**
 * The patch: a grid over the unit square, every quad split the same way (so a
 * morphed node's triangles are its coarser grid's), and two vertices no
 * triangle uses at the top of the unit cube, so the bounds the culling reads
 * hold the node's height range.
 */
export function terrainPatchMesh(name: string, material: MeshMaterial): MeshAsset {
  const n = TERRAIN_PATCH;
  const positions: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j <= n; j += 1) {
    for (let i = 0; i <= n; i += 1) {
      positions.push(i / n, 0, j / n);
      uvs.push(i / n, j / n);
    }
  }
  positions.push(0, 1, 0, 1, 1, 1);
  uvs.push(0, 0, 1, 1);
  const indices: number[] = [];
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const a = j * (n + 1) + i;
      indices.push(a, a + n + 1, a + n + 2, a, a + n + 2, a + 1);
    }
  }
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v += 1) normals[v * 3 + 1] = 1;
  return {
    name,
    primitives: [{ positions: Float32Array.from(positions), normals, uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices), material }],
  } as MeshAsset;
}

/** The maps a layer bakes from: its base colour, normal and metallic-roughness maps (null: flat). */
export interface TerrainLayerMaps {
  readonly base: DecodedTexture | null;
  readonly normal: DecodedTexture | null;
  readonly mr: DecodedTexture | null;
}

/** A terrain the GPU draws (F6c): its heightfield and the decoded maps of its layers, in order. */
export interface GpuTerrainSource {
  readonly terrain: Terrain;
  readonly layers: readonly TerrainLayerMaps[];
}

/** Floats of a draw's terrain uniform (scenePacking.ts's terrain1..4 and its pages). */
export const TERRAIN_UNIFORM_FLOATS = 32;

const LAYER_VEC4S = 5;
const BAKE_BYTES = (6 + 4 * LAYER_VEC4S) * 16;

export const TERRAIN_BAKE_WGSL = /* wgsl */ `
struct Layer {
  up: vec4<f32>,      // lo, hi, 1 when set, 1 when painted only
  height: vec4<f32>,  // lo, hi, 1 when set
  curve: vec4<f32>,   // lo, hi, 1 when set
  colour: vec4<f32>,  // the base colour factor (rgb), 1 with a base map
  pbr: vec4<f32>,     // roughness, metallic, 1 with a metallic-roughness map, 1 with a normal map
};
struct Bake {
  page: vec4<f32>,    // the page's corner (x, z, metres from the terrain's), side, slot in the atlas
  size: vec4<f32>,    // the terrain's size (x, z), cells a side, texels a page side
  height: vec4<f32>,  // the heights' min and range, the terrain's origin y, 1 when painted
  world: vec4<f32>,   // the terrain's origin x and z, the maps' tile, 1 when triplanar
  blend: vec4<f32>,   // the blend's up and height widths and noise (x < 0: hard edges), its sharpness
  count: vec4<f32>,   // layers
  layers: array<Layer, 4>,
};
@group(0) @binding(0) var<uniform> b: Bake;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var heights: texture_2d<f32>;
@group(0) @binding(3) var paint: texture_2d<f32>;
@group(0) @binding(4) var base0: texture_2d<f32>;
@group(0) @binding(5) var base1: texture_2d<f32>;
@group(0) @binding(6) var base2: texture_2d<f32>;
@group(0) @binding(7) var base3: texture_2d<f32>;
@group(0) @binding(8) var nrm0: texture_2d<f32>;
@group(0) @binding(9) var nrm1: texture_2d<f32>;
@group(0) @binding(10) var nrm2: texture_2d<f32>;
@group(0) @binding(11) var nrm3: texture_2d<f32>;
@group(0) @binding(12) var mr0: texture_2d<f32>;
@group(0) @binding(13) var mr1: texture_2d<f32>;
@group(0) @binding(14) var mr2: texture_2d<f32>;
@group(0) @binding(15) var mr3: texture_2d<f32>;
@group(0) @binding(16) var albedoOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(17) var normalOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(18) var mrOut: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(19) var occOut: texture_storage_2d<rgba8unorm, write>;

// A sample's height (local), its four corners' bilinear blend, as the scene's vertex reads it.
fn heightAt(p: vec2<f32>) -> f32 {
  let cells = b.size.z;
  let q = clamp(p / b.size.xy, vec2<f32>(0.0), vec2<f32>(1.0)) * cells;
  let i = min(vec2<i32>(floor(q)), vec2<i32>(i32(cells) - 1));
  let f = q - vec2<f32>(i);
  let h00 = textureLoad(heights, i, 0);
  let h10 = textureLoad(heights, i + vec2<i32>(1, 0), 0);
  let h01 = textureLoad(heights, i + vec2<i32>(0, 1), 0);
  let h11 = textureLoad(heights, i + vec2<i32>(1, 1), 0);
  let d = vec4<f32>(h00.r * 65280.0 + h00.g * 255.0, h10.r * 65280.0 + h10.g * 255.0, h01.r * 65280.0 + h01.g * 255.0, h11.r * 65280.0 + h11.g * 255.0) / 65535.0;
  return b.height.x + mix(mix(d.x, d.y, f.x), mix(d.z, d.w, f.x), f.y) * b.height.y;
}
fn paintAt(p: vec2<f32>) -> vec4<f32> {
  let cells = b.size.z;
  let q = clamp(p / b.size.xy, vec2<f32>(0.0), vec2<f32>(1.0)) * cells;
  let i = min(vec2<i32>(floor(q)), vec2<i32>(i32(cells) - 1));
  let f = q - vec2<f32>(i);
  return mix(mix(textureLoad(paint, i, 0), textureLoad(paint, i + vec2<i32>(1, 0), 0), f.x), mix(textureLoad(paint, i + vec2<i32>(0, 1), 0), textureLoad(paint, i + vec2<i32>(1, 1), 0), f.x), f.y);
}

// terrain.ts's ramp, within and edgeNoise, term for term.
fn ramp(v: f32, edge: f32, w: f32) -> f32 {
  if (w <= 0.0) { return select(0.0, 1.0, v >= edge); }
  let t = clamp((v - edge + w / 2.0) / w, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn within(v: f32, range: vec4<f32>, w: f32, lo: f32, hi: f32) -> f32 {
  if (range.z < 0.5) { return 1.0; }
  let low = select(ramp(v, range.x, w), 1.0, range.x <= lo);
  let high = select(1.0 - ramp(v, range.y, w), 1.0, range.y >= hi);
  return low * high;
}
fn inside(v: f32, range: vec4<f32>) -> bool {
  return range.z < 0.5 || (v >= range.x && v <= range.y);
}
fn cellHash(i: i32, j: i32) -> f32 {
  var h = bitcast<u32>(i) * 374761393u + bitcast<u32>(j) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967295.0;
}
fn octave(x: f32, z: f32, scale: f32) -> f32 {
  let g = vec2<f32>(x, z) / scale;
  let c = floor(g);
  let f = g - c;
  let s = f * f * (3.0 - 2.0 * f);
  let i = i32(c.x);
  let j = i32(c.y);
  let top = cellHash(i, j) + (cellHash(i + 1, j) - cellHash(i, j)) * s.x;
  let bottom = cellHash(i, j + 1) + (cellHash(i + 1, j + 1) - cellHash(i, j + 1)) * s.x;
  return top + (bottom - top) * s.y;
}
fn edgeNoise(x: f32, z: f32) -> f32 {
  return (octave(x, z, 9.0) * 0.65 + octave(x, z, 3.5) * 0.35) * 2.0 - 1.0;
}

// A layer's map at a point: by the terrain's planar UVs, or projected from three axes (triMap, term for term).
fn mapAt(t: texture_2d<f32>, p: vec3<f32>, n: vec3<f32>, lod: f32) -> vec4<f32> {
  if (b.world.w < 0.5) { return textureSampleLevel(t, samp, vec2<f32>(p.x, 1.0 - p.z), lod); }
  let a = n * n;
  var w = a * a;
  w = w / max(w.x + w.y + w.z, 1e-30);
  return textureSampleLevel(t, samp, vec2<f32>(p.z, 1.0 - p.y), lod) * w.x + textureSampleLevel(t, samp, vec2<f32>(p.x, 1.0 - p.z), lod) * w.y + textureSampleLevel(t, samp, vec2<f32>(p.x, 1.0 - p.y), lod) * w.z;
}
fn lodOf(t: texture_2d<f32>) -> f32 {
  let texel = b.page.z / b.size.w / b.world.z;
  return max(log2(texel * f32(textureDimensions(t).x)), 0.0);
}
struct Surface { colour: vec4<f32>, normal: vec3<f32>, rough: f32, metal: f32 };
fn layerSurface(k: i32, p: vec3<f32>, n: vec3<f32>) -> Surface {
  let l = b.layers[k];
  var s: Surface;
  var colour = vec4<f32>(1.0);
  var tn = vec4<f32>(0.5, 0.5, 1.0, 1.0);
  var mr = vec4<f32>(1.0);
  switch k {
    case 0: { colour = mapAt(base0, p, n, lodOf(base0)); tn = mapAt(nrm0, p, n, lodOf(nrm0)); mr = mapAt(mr0, p, n, lodOf(mr0)); }
    case 1: { colour = mapAt(base1, p, n, lodOf(base1)); tn = mapAt(nrm1, p, n, lodOf(nrm1)); mr = mapAt(mr1, p, n, lodOf(mr1)); }
    case 2: { colour = mapAt(base2, p, n, lodOf(base2)); tn = mapAt(nrm2, p, n, lodOf(nrm2)); mr = mapAt(mr2, p, n, lodOf(mr2)); }
    default: { colour = mapAt(base3, p, n, lodOf(base3)); tn = mapAt(nrm3, p, n, lodOf(nrm3)); mr = mapAt(mr3, p, n, lodOf(mr3)); }
  }
  s.colour = vec4<f32>(l.colour.rgb, 1.0) * select(vec4<f32>(1.0), colour, l.colour.w > 0.5);
  s.normal = select(vec3<f32>(0.0, 0.0, 1.0), tn.rgb * 2.0 - 1.0, l.pbr.w > 0.5);
  s.rough = l.pbr.x * select(1.0, mr.g, l.pbr.z > 0.5);
  s.metal = l.pbr.y * select(1.0, mr.b, l.pbr.z > 0.5);
  return s;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let texels = u32(b.size.w);
  if (id.x >= texels || id.y >= texels) { return; }
  let local = b.page.xy + (vec2<f32>(id.xy) + 0.5) / b.size.w * b.page.z;
  let cell = b.size.xy / b.size.z;
  let h = heightAt(local);
  // The slope at the grid's own spacing (terrainMesh's vertex normal), and the curvature (terrainCurvature).
  let hl = heightAt(local - vec2<f32>(cell.x, 0.0));
  let hr = heightAt(local + vec2<f32>(cell.x, 0.0));
  let hd = heightAt(local - vec2<f32>(0.0, cell.y));
  let hu = heightAt(local + vec2<f32>(0.0, cell.y));
  let n = normalize(vec3<f32>(-(hr - hl) / (2.0 * cell.x), 1.0, -(hu - hd) / (2.0 * cell.y)));
  let curvature = (hl + hr + hd + hu) / 4.0 - h;
  let world = vec3<f32>(b.world.x + local.x, b.height.z + h, b.world.y + local.y);
  let count = i32(b.count.x);
  // Each layer's weight: painted, else the rules (softly, first match winning, with the blend; else the first match).
  var w = array<f32, 4>(0.0, 0.0, 0.0, 0.0);
  var painted = false;
  if (b.height.w > 0.5) {
    let p = paintAt(local);
    let sum = p.x + p.y + p.z + p.w;
    if (sum > 1e-4) {
      painted = true;
      w = array<f32, 4>(p.x / sum, p.y / sum, p.z / sum, p.w / sum);
    }
  }
  if (!painted && b.blend.x >= 0.0) {
    let jitter = b.blend.z * edgeNoise(world.x, world.z);
    let uu = n.y + jitter * b.blend.x;
    let hh = world.y + jitter * b.blend.y;
    var rest = 1.0;
    for (var k = 0; k < count; k = k + 1) {
      if (k == count - 1) { w[k] = rest; break; }
      let l = b.layers[k];
      var m = 0.0;
      if (l.up.w < 0.5) { m = rest * within(uu, l.up, b.blend.x, 0.0, 1.0) * within(hh, l.height, b.blend.y, -1e30, 1e30) * within(curvature, l.curve, ${0.05}, -1e30, 1e30); }
      w[k] = m;
      rest = rest - m;
    }
  } else if (!painted) {
    var chosen = count - 1;
    for (var k = 0; k < count - 1; k = k + 1) {
      let l = b.layers[k];
      if (l.up.w > 0.5) { continue; }
      if (inside(n.y, l.up) && inside(world.y, l.height) && inside(curvature, l.curve)) { chosen = k; break; }
    }
    w[chosen] = 1.0;
  }
  let p = world / b.world.z;
  var colour = vec4<f32>(0.0);
  var tn = vec3<f32>(0.0);
  var rough = 0.0;
  var metal = 0.0;
  var relief = 0.0;
  // The blend's sharpness lets the brighter (higher) surface through first.
  var weights = w;
  var total = 0.0;
  var surfaces: array<Surface, 4>;
  for (var k = 0; k < count; k = k + 1) {
    if (w[k] <= 0.0) { continue; }
    surfaces[k] = layerSurface(k, p, n);
    let lum = dot(surfaces[k].colour.rgb, vec3<f32>(0.299, 0.587, 0.114));
    weights[k] = w[k] * exp(4.0 * b.blend.w * (lum - 0.5));
    total = total + weights[k];
  }
  for (var k = 0; k < count; k = k + 1) {
    if (w[k] <= 0.0) { continue; }
    let s = surfaces[k];
    let share = weights[k] / max(total, 1e-6);
    colour = colour + s.colour * share;
    tn = tn + s.normal * share;
    rough = rough + s.rough * share;
    metal = metal + s.metal * share;
    relief = relief + dot(s.colour.rgb, vec3<f32>(0.299, 0.587, 0.114)) * share;
  }
  let at = vec2<i32>(i32(b.page.w) * i32(texels) + i32(id.x), i32(id.y));
  textureStore(albedoOut, at, vec4<f32>(colour.rgb, 1.0));
  textureStore(normalOut, at, vec4<f32>(normalize(tn + vec3<f32>(0.0, 0.0, 1e-6)) * 0.5 + 0.5, 1.0));
  textureStore(mrOut, at, vec4<f32>(1.0, clamp(rough, 0.0, 1.0), clamp(metal, 0.0, 1.0), 1.0));
  // A cut cell (B of its corner's sample) leaves the occlusion's alpha at 0: the draw discards it.
  let cells = b.size.z;
  let ci = clamp(vec2<i32>(floor(local / b.size.xy * cells)), vec2<i32>(0), vec2<i32>(i32(cells) - 1));
  let cut = textureLoad(heights, ci, 0).b > 0.5;
  textureStore(occOut, at, vec4<f32>(1.0, clamp(relief, 0.0, 1.0), 0.5, select(1.0, 0.0, cut)));
}
`;

/** What a terrain's GPU state needs of the renderer that draws it. */
export interface TerrainHost {
  readonly device: any;
  /** Upload (once) a decoded map, as the scene's draws would (colour: sRGB-encoded). */
  upload(texture: DecodedTexture, colour: boolean): any;
  /** Make a map's mips from its first level. */
  mips(texture: any, levels: number, format: string): void;
  /** Have the scene's draws bind `texture` wherever they bind `key`. */
  adopt(key: DecodedTexture, texture: any, colour: boolean): void;
  readonly blank: any;
}

const STORAGE_BINDING = 0x08;
const TEXTURE_BINDING = 0x04;
const COPY_DST = 0x02;
const RENDER_ATTACHMENT = 0x10;

/** A placeholder a draw's maps are keyed by; the host binds the GPU texture adopted for it. */
function key(width: number, height: number, packedWithRelief = false): DecodedTexture {
  return { width, height, data: new Uint8ClampedArray(0), ...(packedWithRelief ? { packedWithRelief: true } : {}) };
}

/** The draw's terrain uniform, as scenePacking.ts writes it. */
export interface TerrainUniform {
  readonly values: Float32Array;
}

/**
 * One terrain on the GPU: its heights, its quadtree, its patch and the pages
 * of its virtual texture, re-baked as the eye moves.
 */
export class GpuTerrain {
  readonly plan: TerrainPlan;
  readonly tree: TerrainTree;
  readonly heights: any;
  readonly heightView: any;
  readonly mesh: MeshAsset;
  /** The patch's draws' maps, keys for the virtual texture's atlases (see {@link TerrainHost.adopt}). */
  readonly maps: { readonly albedo: DecodedTexture; readonly normal: DecodedTexture; readonly mr: DecodedTexture; readonly occ: DecodedTexture; readonly relief: DecodedTexture };
  readonly relief: number;
  private readonly min: number;
  private readonly range: number;
  private readonly paint: any | null;
  private readonly atlases: { albedo: any; normal: any; mr: any; occ: any };
  private readonly levels: number;
  private readonly pipeline: any;
  /** Each page's baked corner (null: not yet), the whole terrain's last. */
  private baked: ([number, number] | null)[];
  private layerKey: readonly (DecodedTexture | null)[] = [];
  readonly values = new Float32Array(TERRAIN_UNIFORM_FLOATS);

  constructor(
    private readonly host: TerrainHost,
    readonly terrain: Terrain,
    texels = TERRAIN_PAGE_TEXELS,
  ) {
    const device = host.device;
    const t = terrain;
    this.plan = terrainPlan(t, texels);
    this.relief = Math.min(MAX_TERRAIN_RELIEF, Math.max(0, t.relief ?? 0));
    this.tree = new TerrainTree(t, this.plan, this.relief);
    const encoded = encodeTerrainHeights(t);
    this.min = encoded.min;
    this.range = encoded.range;
    const n = t.samples;
    this.heights = device.createTexture({ size: { width: n, height: n }, format: "rgba8unorm", usage: TEXTURE_BINDING | COPY_DST });
    device.queue.writeTexture({ texture: this.heights }, encoded.data, { bytesPerRow: n * 4, rowsPerImage: n }, { width: n, height: n });
    this.heightView = this.heights.createView();
    if (t.paint && t.paint.length === n * n * t.layers.length) {
      const L = t.layers.length;
      const data = new Uint8Array(n * n * 4);
      for (let k = 0; k < n * n; k += 1) for (let l = 0; l < L; l += 1) data[k * 4 + l] = t.paint[k * L + l]!;
      this.paint = device.createTexture({ size: { width: n, height: n }, format: "rgba8unorm", usage: TEXTURE_BINDING | COPY_DST });
      device.queue.writeTexture({ texture: this.paint }, data, { bytesPerRow: n * 4, rowsPerImage: n }, { width: n, height: n });
    } else this.paint = null;
    const width = texels * (this.plan.eyePages + 1);
    this.levels = Math.max(1, Math.log2(texels) - 1);
    // Written as storage, so viewed in its own format only: its colour mips average the encoded values.
    const atlas = () => device.createTexture({ size: { width, height: texels }, format: "rgba8unorm", usage: STORAGE_BINDING | TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT, mipLevelCount: this.levels });
    this.atlases = { albedo: atlas(), normal: atlas(), mr: atlas(), occ: atlas() };
    this.maps = { albedo: key(width, texels), normal: key(width, texels), mr: key(width, texels), occ: key(width, texels, true), relief: key(1, 1) };
    host.adopt(this.maps.albedo, this.atlases.albedo, true);
    host.adopt(this.maps.normal, this.atlases.normal, false);
    host.adopt(this.maps.mr, this.atlases.mr, false);
    host.adopt(this.maps.occ, this.atlases.occ, false);
    const material: MeshMaterial = {
      name: `${t.name} (virtual texture)`,
      baseColorFactor: [1, 1, 1, 1],
      baseColorImage: null,
      metallicFactor: 1,
      roughnessFactor: 1,
      ...(this.relief > 0 ? { parallaxDepth: this.relief } : {}),
    } as MeshMaterial;
    this.mesh = terrainPatchMesh(t.name, material);
    this.pipeline = device.createComputePipeline({ layout: "auto", compute: { module: device.createShaderModule({ code: TERRAIN_BAKE_WGSL }), entryPoint: "main" } });
    this.baked = new Array(this.plan.eyePages + 1).fill(null);
  }

  /** The eye (world) in the terrain's ground plane, metres from its corner. */
  private eyeOf(eye: readonly number[]): [number, number] {
    return [eye[0]! - this.terrain.origin[0], eye[2]! - this.terrain.origin[2]];
  }

  /**
   * This frame's nodes as copies of the patch (each its own model), with the
   * pages they shade from baked (and submitted) first. `layers` are the
   * layers' decoded maps; a new set re-bakes every page.
   */
  frame(eyeWorld: readonly number[], layers: readonly TerrainLayerMaps[]): MeshSceneInstance[] {
    const eye = this.eyeOf(eyeWorld);
    const flat = layers.flatMap((l) => [l.base, l.normal, l.mr]);
    if (flat.length !== this.layerKey.length || flat.some((m, i) => m !== this.layerKey[i])) {
      this.layerKey = flat;
      this.baked.fill(null);
    }
    const corners = pageCorners(this.plan, eye);
    const whole: [number, number] = [0, 0];
    const wanted = [...corners, whole];
    const changed: number[] = [];
    wanted.forEach((c, k) => {
      const was = this.baked[k];
      if (!was || was[0] !== c[0] || was[1] !== c[1]) changed.push(k);
    });
    if (changed.length > 0) {
      const encoder = this.host.device.createCommandEncoder();
      for (const k of changed) this.bake(encoder, k, wanted[k]!, layers);
      this.host.device.queue.submit([encoder.finish()]);
      this.release();
      this.host.mips(this.atlases.albedo, this.levels, "rgba8unorm");
      this.host.mips(this.atlases.normal, this.levels, "rgba8unorm");
      this.host.mips(this.atlases.mr, this.levels, "rgba8unorm");
      this.host.mips(this.atlases.occ, this.levels, "rgba8unorm");
    }
    this.writeUniform(eye, corners);
    const textures = [this.maps.albedo];
    return this.tree.select(eye).map((node) => ({
      mesh: this.mesh,
      model: terrainNodeModel(this.terrain, node),
      textures,
      mrTextures: [this.maps.mr],
      normalTextures: [this.maps.normal],
      occlusionTextures: [this.maps.occ],
      reliefTextures: [this.maps.relief],
    })) as unknown as MeshSceneInstance[];
  }

  private writeUniform(eye: readonly [number, number], corners: readonly [number, number][]): void {
    const t = this.terrain;
    const v = this.values;
    v.fill(0);
    // terrain1: size, the heights' min (local) and range (> 0: a GPU terrain).
    v.set([t.size[0], t.size[1], this.min, this.range], 0);
    // terrain2: cells a side, 1 with holes, the nearest page's side, pages following the eye.
    const cut = Boolean(t.holes?.some((h) => h !== 0)) || t.floor !== undefined;
    v.set([this.plan.cells, cut ? 1 : 0, this.plan.page, this.plan.eyePages], 4);
    // terrain3: the terrain's origin, the leaf node's side.
    v.set([t.origin[0], t.origin[1], t.origin[2], this.plan.leaf], 8);
    // terrain4: the eye in the ground plane, the split range, the morph's start; then each page's corner.
    v.set([eye[0], eye[1], TERRAIN_RANGE, TERRAIN_MORPH], 12);
    corners.forEach((c, k) => v.set(c, 16 + k * 2));
  }

  private bake(encoder: any, slot: number, corner: readonly [number, number], layers: readonly TerrainLayerMaps[]): void {
    const t = this.terrain;
    const plan = this.plan;
    const side = slot < plan.eyePages ? plan.page * 2 ** slot : Math.max(t.size[0], t.size[1]);
    const data = new Float32Array(BAKE_BYTES / 4);
    data.set([corner[0], corner[1], side, slot], 0);
    data.set([t.size[0], t.size[1], plan.cells, plan.texels], 4);
    data.set([this.min, this.range, t.origin[1], this.paint ? 1 : 0], 8);
    data.set([t.origin[0], t.origin[2], t.tile && t.tile > 0 ? t.tile : 8, t.triplanar ? 1 : 0], 12);
    data.set(t.blend ? [t.blend.up, t.blend.height, t.blend.noise ?? 0, t.blend.sharpness ?? 0] : [-1, 0, 0, 0], 16);
    data.set([Math.min(4, t.layers.length), 0, 0, 0], 20);
    t.layers.slice(0, 4).forEach((l, k) => {
      const o = 24 + k * LAYER_VEC4S * 4;
      const maps = layers[k];
      data.set([l.up?.[0] ?? 0, l.up?.[1] ?? 0, l.up ? 1 : 0, l.paintOnly ? 1 : 0], o);
      data.set([l.height?.[0] ?? 0, l.height?.[1] ?? 0, l.height ? 1 : 0, 0], o + 4);
      data.set([l.curvature?.[0] ?? 0, l.curvature?.[1] ?? 0, l.curvature ? 1 : 0, 0], o + 8);
      const c = l.material.baseColorFactor;
      data.set([c[0], c[1], c[2], maps?.base ? 1 : 0], o + 12);
      data.set([l.material.roughnessFactor ?? 1, l.material.metallicFactor ?? 0, maps?.mr ? 1 : 0, maps?.normal ? 1 : 0], o + 16);
    });
    const device = this.host.device;
    const uniform = device.createBuffer({ size: BAKE_BYTES, usage: 0x40 | 0x08 }); // UNIFORM | COPY_DST
    device.queue.writeBuffer(uniform, 0, data);
    const view = (m: DecodedTexture | null | undefined, colour: boolean) => (m ? this.host.upload(m, colour) : this.host.blank).createView();
    const level0 = (texture: any) => texture.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    const group = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: this.sampler() },
        { binding: 2, resource: this.heightView },
        { binding: 3, resource: (this.paint ?? this.host.blank).createView() },
        ...[0, 1, 2, 3].map((k) => ({ binding: 4 + k, resource: view(layers[k]?.base, true) })),
        ...[0, 1, 2, 3].map((k) => ({ binding: 8 + k, resource: view(layers[k]?.normal, false) })),
        ...[0, 1, 2, 3].map((k) => ({ binding: 12 + k, resource: view(layers[k]?.mr, false) })),
        { binding: 16, resource: level0(this.atlases.albedo) },
        { binding: 17, resource: level0(this.atlases.normal) },
        { binding: 18, resource: level0(this.atlases.mr) },
        { binding: 19, resource: level0(this.atlases.occ) },
      ],
    });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, group);
    const groups = Math.ceil(plan.texels / 8);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    this.baked[slot] = [corner[0], corner[1]];
    this.spent.push(uniform);
  }

  /** Bake uniforms in flight, released once their bakes are submitted. */
  private spent: any[] = [];
  private release(): void {
    for (const b of this.spent) b.destroy?.();
    this.spent = [];
  }

  private repeat: any = null;
  private sampler(): any {
    this.repeat ??= this.host.device.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "repeat", addressModeV: "repeat" });
    return this.repeat;
  }

  dispose(): void {
    this.release();
    for (const t of [this.heights, this.paint, this.atlases.albedo, this.atlases.normal, this.atlases.mr, this.atlases.occ]) t?.destroy?.();
  }
}
