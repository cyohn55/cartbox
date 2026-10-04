/**
 * Clustered light culling (ENGINE_PARITY_ROADMAP.md EP8), the forward+ that
 * lets a scene hold dozens of lights: the view frustum is cut into a grid of
 * cells — {@link CLUSTER_X} × {@link CLUSTER_Y} screen tiles by
 * {@link CLUSTER_Z} depth slices, spaced exponentially — and each cell lists
 * the lights whose reach touches it. A GPU fragment finds its cell from its
 * pixel and depth and shades only that list.
 *
 * Lights with a bounded reach (point and spot lights with a range) are
 * clustered; the rest (the sun, and unranged lights) reach every pixel and
 * are listed once as "global" lights every fragment loops over first. A light
 * contributes exactly nothing past its range, and a cell's list is
 * conservative (the light's sphere against the cell's box), so shading only
 * the list gives the same picture as shading every light — which is what the
 * software rasteriser, the reference, still does.
 */

import type { Mat4, SceneLight } from "./meshRasterizer";

export const CLUSTER_X = 16;
export const CLUSTER_Y = 9;
export const CLUSTER_Z = 24;
export const CLUSTER_CELLS = CLUSTER_X * CLUSTER_Y * CLUSTER_Z;
/** Light indices across all cells (a 1024 × 16 texture on WebGL2). */
export const CLUSTER_INDEX_CAP = 1024 * 16;
/** The most lights one cell lists. */
export const CLUSTER_MAX_PER_CELL = 64;

/** Whether a light's reach is bounded, so it can be clustered. */
export function lightBounded(light: SceneLight): boolean {
  return light.kind !== "directional" && (light.range ?? 0) > 0;
}

/**
 * The lights in the order the GPU packs them: global ones (the sun,
 * unranged lights) first, then the clustered ones. Cells index into this order.
 */
export function orderLights(lights: readonly SceneLight[]): { readonly ordered: readonly SceneLight[]; readonly globalCount: number } {
  const global = lights.filter((l) => !lightBounded(l));
  return { ordered: [...global, ...lights.filter(lightBounded)], globalCount: global.length };
}

export interface LightClusters {
  /** Per cell, two numbers: where its list starts in `indices`, and its length. Cell = (slice · Y + tileY) · X + tileX. */
  readonly table: Uint32Array;
  /** Every cell's light indices (into the ordered lights), back to back. */
  readonly indices: Uint32Array;
  /** Indices used in `indices`. */
  readonly used: number;
  /** A tile's size in pixels, the near plane, and the slice scale: slice = floor(ln(depth / near) · scale). */
  readonly params: readonly [tileWidth: number, tileHeight: number, near: number, sliceScale: number];
  /** True when a cell or the index list overflowed (some light was left out somewhere). */
  readonly overflow: boolean;
}

/** The tile a pixel is in, and the slice a view depth is in (−1 nearer than the near plane). */
export function clusterTile(params: LightClusters["params"], px: number, py: number): [number, number] {
  return [Math.min(CLUSTER_X - 1, Math.floor(px / params[0])), Math.min(CLUSTER_Y - 1, Math.floor(py / params[1]))];
}
export function clusterSlice(params: LightClusters["params"], depth: number): number {
  if (depth < params[2]) return -1;
  return Math.min(CLUSTER_Z - 1, Math.floor(Math.log(depth / params[2]) * params[3]));
}

/**
 * Sort the clustered lights (`ordered` from {@link orderLights}, past
 * `globalCount`) into cells, for a perspective camera. Null for an
 * orthographic projection, where the renderers loop over every light instead.
 */
export function buildLightClusters(
  ordered: readonly SceneLight[],
  globalCount: number,
  view: Mat4,
  projection: Mat4,
  width: number,
  height: number,
): LightClusters | null {
  if (projection[15] !== 0) return null;
  const p10 = projection[10]!;
  const p14 = projection[14]!;
  const near = p14 / (p10 - 1);
  const far = p14 / (p10 + 1);
  if (!(near > 0) || !(far > near)) return null;
  const sx = projection[0]!;
  const sy = projection[5]!;
  const tileW = Math.ceil(width / CLUSTER_X);
  const tileH = Math.ceil(height / CLUSTER_Y);
  const scale = CLUSTER_Z / Math.log(far / near);
  const sliceDepth = (k: number) => near * Math.exp(k / scale);

  // Each tile's NDC extent; tile rows run top-down, as pixel rows do.
  const ndcX = (x: number) => (Math.min(width, x) / width) * 2 - 1;
  const ndcY = (y: number) => 1 - (Math.min(height, y) / height) * 2;

  const lists: number[][] = Array.from({ length: CLUSTER_CELLS }, () => []);
  let overflow = false;
  for (let li = globalCount; li < ordered.length; li += 1) {
    const light = ordered[li]!;
    const p = light.position ?? [0, 0, 0];
    // The light in view space: x right, y up, d = distance in front of the eye.
    const cx = view[0]! * p[0] + view[4]! * p[1] + view[8]! * p[2] + view[12]!;
    const cy = view[1]! * p[0] + view[5]! * p[1] + view[9]! * p[2] + view[13]!;
    const cd = -(view[2]! * p[0] + view[6]! * p[1] + view[10]! * p[2] + view[14]!);
    // A hair of slack, so float rounding at a cell's face never drops a light that touches it.
    const r = (light.range ?? 0) * 1.001 + 1e-3;
    if (cd + r < near || cd - r > far) continue;
    const k0 = Math.max(0, clusterSlice([tileW, tileH, near, scale], Math.max(near, cd - r)));
    const k1 = Math.min(CLUSTER_Z - 1, Math.max(0, clusterSlice([tileW, tileH, near, scale], Math.min(far, cd + r))));
    for (let k = k0; k <= k1; k += 1) {
      const d0 = sliceDepth(k);
      const d1 = sliceDepth(k + 1);
      // Nearest depth in the slice to the light, and the gap along depth.
      const dd = cd < d0 ? d0 - cd : cd > d1 ? cd - d1 : 0;
      if (dd > r) continue;
      for (let ty = 0; ty < CLUSTER_Y; ty += 1) {
        const ya = ndcY(ty * tileH);
        const yb = ndcY((ty + 1) * tileH);
        const yMin = Math.min(ya * d0, ya * d1, yb * d0, yb * d1) / sy;
        const yMax = Math.max(ya * d0, ya * d1, yb * d0, yb * d1) / sy;
        const dy = cy < yMin ? yMin - cy : cy > yMax ? cy - yMax : 0;
        if (dy * dy + dd * dd > r * r) continue;
        for (let tx = 0; tx < CLUSTER_X; tx += 1) {
          const xa = ndcX(tx * tileW);
          const xb = ndcX((tx + 1) * tileW);
          const xMin = Math.min(xa * d0, xa * d1, xb * d0, xb * d1) / sx;
          const xMax = Math.max(xa * d0, xa * d1, xb * d0, xb * d1) / sx;
          const dx = cx < xMin ? xMin - cx : cx > xMax ? cx - xMax : 0;
          if (dx * dx + dy * dy + dd * dd > r * r) continue;
          const list = lists[(k * CLUSTER_Y + ty) * CLUSTER_X + tx]!;
          if (list.length < CLUSTER_MAX_PER_CELL) list.push(li);
          else overflow = true;
        }
      }
    }
  }

  const table = new Uint32Array(CLUSTER_CELLS * 2);
  const indices = new Uint32Array(CLUSTER_INDEX_CAP);
  let used = 0;
  for (let cell = 0; cell < CLUSTER_CELLS; cell += 1) {
    const list = lists[cell]!;
    const count = Math.min(list.length, CLUSTER_INDEX_CAP - used);
    if (count < list.length) overflow = true;
    table[cell * 2] = used;
    table[cell * 2 + 1] = count;
    for (let i = 0; i < count; i += 1) indices[used + i] = list[i]!;
    used += count;
  }
  return { table, indices, used, params: [tileW, tileH, near, scale], overflow };
}
