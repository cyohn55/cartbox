/**
 * Spot and point light shadows on the GPU, on the AAA tier
 * (AAA_FIDELITY_ROADMAP.md F2d). The other tiers rasterise each light's maps
 * on the CPU into sixteen fixed 256² tiles (EP8c); here the renderer draws them
 * itself, each frame, into one {@link LOCAL_ATLAS_SIZE}² depth atlas.
 *
 * - **Tiles by what they cover.** Each casting light is weighed by how much of
 *   the screen its range can cover from where the camera stands, and given
 *   1024², 512² or 256² tiles (one for a spot, six faces for a point light),
 *   the largest first, from a buddy allocator over the atlas. A light that
 *   doesn't fit at its size tries the next smaller one; past
 *   {@link MAX_GPU_LOCAL_TILES}, or with no room left, it casts no shadow.
 * - **Depth as drawn.** A face's GL-style projection is remapped to WebGPU's
 *   0..1 depth for drawing. The shader still reads distances (the same
 *   `linear` terms as the CPU tiles), so its world-unit bias carries over; it
 *   turns the biased distance back into a depth and lets hardware comparisons
 *   filter it over a 3×3 grid, each itself bilinear, kept inside the tile.
 */

import { localShadowTileCount, localShadowViews, multiplyMat4, type Mat4, type SceneLight } from "@cartbox/editor";

/** The local lights' atlas edge in texels. */
export const LOCAL_ATLAS_SIZE = 4096;
/** The most tiles a frame's local lights take (the tile records' buffer holds this many). */
export const MAX_GPU_LOCAL_TILES = 64;
/** The tile sizes a light may get, largest first. */
export const LOCAL_TILE_SIZES: readonly number[] = [1024, 512, 256];
/** Screen coverage (its range's share of half the view's height) from which a light gets each size. */
export const LOCAL_TILE_COVERAGE: readonly number[] = [0.5, 0.15];
/** Floats per tile record: world → GL clip (16), linear terms (x, y), its rect in the atlas (x, y, size, 0). */
export const LOCAL_TILE_FLOATS = 24;

/** One tile of the atlas: which light and face, where it sits, and its view through that face. */
export interface LocalTile {
  readonly light: number;
  readonly face: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** World → GL clip through the face (what the shader projects with). */
  readonly viewProj: Mat4;
  /** World → WebGPU clip (depth 0..1), for drawing the face. */
  readonly drawViewProj: Mat4;
  /** distance = linear[1] / (ndc z + linear[0]). */
  readonly linear: readonly [number, number];
}

/** A buddy allocator over a square of `size`² texels, in power-of-two blocks. */
export class TileAllocator {
  private readonly free = new Map<number, [number, number][]>();

  constructor(private readonly size: number) {
    this.free.set(size, [[0, 0]]);
  }

  /** A block of `want`² texels, or null when none is left. */
  alloc(want: number): [number, number] | null {
    let s = want;
    while (s <= this.size && !(this.free.get(s)?.length)) s *= 2;
    if (s > this.size) return null;
    let block = this.free.get(s)!.pop()!;
    // Split down to the size wanted, keeping the other three quarters free.
    while (s > want) {
      s /= 2;
      const [x, y] = block;
      const list = this.free.get(s) ?? [];
      list.push([x + s, y], [x, y + s], [x + s, y + s]);
      this.free.set(s, list);
      block = [x, y];
    }
    return block;
  }

  /** Give a block back (no merging: the allocator lives one frame). */
  release(block: [number, number], size: number): void {
    const list = this.free.get(size) ?? [];
    list.push(block);
    this.free.set(size, list);
  }
}

/** WebGPU's clip from a GL-style one: z' = (z + w) / 2. */
const TO_WEBGPU_DEPTH: Mat4 = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1]);

/** How much of the screen a light's range can cover from `eye`: its radius over the distance, against half the view's height. */
export function localCoverage(light: SceneLight, eye: readonly [number, number, number], tanHalfFov: number): number {
  const p = light.position ?? [0, 0, 0];
  const r = light.range ?? 0;
  const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
  return r / (Math.max(d - r, r * 0.25, 1e-3) * Math.max(tanHalfFov, 1e-3));
}

/**
 * Plan the frame's local-light tiles: the lights with each caster's first tile
 * (`shadowTile`) set, or cleared for one that gets none, and the tiles in
 * index order (a point light's six faces in a row).
 */
export function planLocalTiles(lights: readonly SceneLight[], eye: readonly [number, number, number], tanHalfFov: number): { readonly lights: SceneLight[]; readonly tiles: LocalTile[] } {
  const casting = lights
    .map((light, index) => ({ light, index, faces: localShadowTileCount(light), coverage: localCoverage(light, eye, tanHalfFov) }))
    .filter((c) => c.faces > 0)
    .sort((a, b) => b.coverage - a.coverage);
  const atlas = new TileAllocator(LOCAL_ATLAS_SIZE);
  const tiles: LocalTile[] = [];
  const first = new Map<number, number>();
  for (const c of casting) {
    if (tiles.length + c.faces > MAX_GPU_LOCAL_TILES) continue;
    const wanted = c.coverage >= LOCAL_TILE_COVERAGE[0]! ? 0 : c.coverage >= LOCAL_TILE_COVERAGE[1]! ? 1 : 2;
    for (let k = wanted; k < LOCAL_TILE_SIZES.length; k += 1) {
      const size = LOCAL_TILE_SIZES[k]!;
      const blocks: [number, number][] = [];
      for (let f = 0; f < c.faces; f += 1) {
        const b = atlas.alloc(size);
        if (!b) break;
        blocks.push(b);
      }
      if (blocks.length < c.faces) {
        for (const b of blocks) atlas.release(b, size);
        continue;
      }
      first.set(c.index, tiles.length);
      localShadowViews(c.light).forEach(({ view, projection }, face) => {
        const viewProj = multiplyMat4(projection, view);
        tiles.push({
          light: c.index,
          face,
          x: blocks[face]![0],
          y: blocks[face]![1],
          size,
          viewProj,
          drawViewProj: multiplyMat4(TO_WEBGPU_DEPTH, viewProj),
          linear: [projection[10]!, projection[14]!],
        });
      });
      break;
    }
  }
  const out = lights.map((light, i) => {
    const t = first.get(i);
    if (t !== undefined) return { ...light, shadowTile: t };
    return light.shadowTile === undefined ? light : { ...light, shadowTile: undefined };
  });
  return { lights: out, tiles };
}

/** The tiles' records for the shader, {@link LOCAL_TILE_FLOATS} each. */
export function packLocalTiles(tiles: readonly LocalTile[], out: Float32Array = new Float32Array(MAX_GPU_LOCAL_TILES * LOCAL_TILE_FLOATS)): Float32Array {
  tiles.forEach((t, i) => {
    out.set(t.viewProj, i * LOCAL_TILE_FLOATS);
    out.set([t.linear[0], t.linear[1], 0, 0], i * LOCAL_TILE_FLOATS + 16);
    out.set([t.x, t.y, t.size, 0], i * LOCAL_TILE_FLOATS + 20);
  });
  return out;
}

/**
 * The AAA tier's spot/point shadow test in WGSL (reads `shadowTiles`,
 * `localDepth`, `cascadeSamp` and `frame.localShadow`): the tile that sees
 * the point (a point light's face by dominant axis), its distance less a
 * slope-scaled world bias turned back into a depth, and a 3×3 grid of
 * hardware comparisons inside the tile.
 */
export const LOCAL_SHADOW_GPU_WGSL = /* wgsl */ `
fn localShadow(first: i32, lgt: Light, P: vec3<f32>, cosL: f32) -> f32 {
  var tile = first;
  if (lgt.d0.w < 1.5) {
    let d = P - lgt.d0.xyz;
    let m = abs(d);
    if (m.x >= m.y && m.x >= m.z) { tile = tile + select(1, 0, d.x >= 0.0); }
    else if (m.y >= m.z) { tile = tile + select(3, 2, d.y >= 0.0); }
    else { tile = tile + select(5, 4, d.z >= 0.0); }
  }
  let t = shadowTiles[tile];
  let c = t.mvp * vec4<f32>(P, 1.0);
  if (c.w <= 0.0) { return 1.0; }
  let n = c.xyz / c.w;
  if (n.x < -1.0 || n.x > 1.0 || n.y < -1.0 || n.y > 1.0 || n.z < -1.0 || n.z > 1.0) { return 1.0; }
  let cc = clamp(cosL, 0.05, 1.0);
  let own = t.params.y / (n.z + t.params.x) - frame.localShadow.y - frame.localShadow.z * min(10.0, sqrt(1.0 - cc * cc) / cc);
  // The biased distance back as a depth, GL's then WebGPU's.
  let depthRef = (t.params.y / max(own, 1e-4) - t.params.x) * 0.5 + 0.5;
  let atlas = ${LOCAL_ATLAS_SIZE}.0;
  let size = t.rect.z;
  // Two texels inside the tile, so the filter (a texel out, each tap bilinear) never reads a neighbour's.
  let px = clamp(vec2<f32>((n.x * 0.5 + 0.5) * size, (0.5 - n.y * 0.5) * size), vec2<f32>(2.0), vec2<f32>(size - 2.0));
  let base = (t.rect.xy + px) / atlas;
  var lit = 0.0;
  for (var y = -1; y <= 1; y = y + 1) {
    for (var x = -1; x <= 1; x = x + 1) {
      lit = lit + textureSampleCompareLevel(localDepth, cascadeSamp, base + vec2<f32>(f32(x), f32(y)) / atlas, depthRef);
    }
  }
  return lit / 9.0;
}
`;
