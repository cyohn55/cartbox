/**
 * Small mesh-building toolkit shared by the era starter scenes (PS1, N64, Xbox
 * 360). Each era's cart is a different *arrangement* of the same handful of
 * primitives — a flat-faced box, a subdivided ground that can roll, a smooth
 * sphere, a cone, a cylinder, a faceted octahedron — so the primitives live here
 * and the seed files stay about composition and character.
 *
 * Everything writes into one shared set of attribute streams and then a whole
 * stream set becomes one {@link MeshPrimitive}. Flat-faced builders give each
 * face its own vertices with the face normal (hard edges — crates, monoliths);
 * smooth builders share vertices and average normals (rounded silhouettes —
 * hills, trees). The choice of which to use per shape is the era, not a detail.
 */

import type { MeshMaterial, MeshPrimitive } from "./MeshAsset";

/** Interleave-free attribute streams a primitive is assembled from. */
export interface Streams {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export function newStreams(): Streams {
  return { positions: [], normals: [], uvs: [], indices: [] };
}

/** Triangles emitted so far — checked against a model's poly budget by tests. */
export function triangleCount(streams: Streams): number {
  return streams.indices.length / 3;
}

type Vec3 = readonly [number, number, number];

/** The six faces of a unit box, as corner offsets and a face normal. */
const BOX_FACES: ReadonlyArray<{ normal: Vec3; corners: ReadonlyArray<Vec3> }> = [
  { normal: [0, 1, 0], corners: [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
];

/**
 * A flat-faced axis-aligned box. Each face carries its own normal, so the box
 * stays hard-edged however the scene lights it — the right choice for crates,
 * girders and machined blocks.
 */
export function pushBox(
  streams: Streams,
  center: Vec3,
  half: Vec3,
  uvRepeat = 1,
): void {
  for (const face of BOX_FACES) {
    const base = streams.positions.length / 3;
    for (const [cx, cy, cz] of face.corners) {
      streams.positions.push(
        center[0] + cx * half[0],
        center[1] + cy * half[1],
        center[2] + cz * half[2],
      );
      streams.normals.push(...face.normal);
    }
    const r = uvRepeat;
    streams.uvs.push(0, 0, r, 0, r, r, 0, r);
    streams.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

/**
 * A subdivided horizontal ground plane, optionally displaced by `height(x, z)`
 * for rolling terrain. Normals are estimated by finite difference of the height
 * field, so a hilly ground shades smoothly. Subdivision also matters without a
 * depth buffer (see ps1Seed) and reduces affine warp, so even a flat ground is
 * built from many cells.
 */
export function pushGround(
  streams: Streams,
  opts: {
    cells: number;
    half: number;
    uvRepeat: number;
    height?: (x: number, z: number) => number;
  },
): void {
  const { cells, half, uvRepeat } = opts;
  const height = opts.height ?? (() => 0);
  const step = (half * 2) / cells;
  const eps = step * 0.5;
  const normalAt = (x: number, z: number): Vec3 => {
    const hx = height(x + eps, z) - height(x - eps, z);
    const hz = height(x, z + eps) - height(x, z - eps);
    // Gradient of a height field: (-dh/dx, 1, -dh/dz), normalised.
    const nx = -hx / (2 * eps);
    const nz = -hz / (2 * eps);
    const len = Math.hypot(nx, 1, nz) || 1;
    return [nx / len, 1 / len, nz / len];
  };
  for (let cz = 0; cz < cells; cz += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      const x0 = -half + cx * step;
      const z0 = -half + cz * step;
      const base = streams.positions.length / 3;
      for (const [dx, dz] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        const x = x0 + dx * step;
        const z = z0 + dz * step;
        streams.positions.push(x, height(x, z), z);
        streams.normals.push(...normalAt(x, z));
      }
      const r = uvRepeat;
      streams.uvs.push(0, 0, r, 0, r, r, 0, r);
      streams.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/**
 * A smooth UV sphere (or a hemisphere, with `bottom` clamped). Shared vertices
 * with radial normals, so it reads as a rounded solid — the low-poly curved form
 * the N64 generation leaned on when the PS1 could only afford flat facets.
 */
export function pushSphere(
  streams: Streams,
  center: Vec3,
  radius: number,
  segments: number,
  rings: number,
  opts: { hemisphere?: boolean } = {},
): void {
  const base = streams.positions.length / 3;
  const vStart = opts.hemisphere ? Math.PI / 2 : 0;
  const vEnd = Math.PI;
  for (let r = 0; r <= rings; r += 1) {
    const v = vStart + (r / rings) * (vEnd - vStart);
    const y = Math.cos(v);
    const ringR = Math.sin(v);
    for (let s = 0; s <= segments; s += 1) {
      const u = (s / segments) * Math.PI * 2;
      const nx = ringR * Math.cos(u);
      const nz = ringR * Math.sin(u);
      streams.positions.push(center[0] + nx * radius, center[1] + y * radius, center[2] + nz * radius);
      streams.normals.push(nx, y, nz);
      streams.uvs.push(s / segments, r / rings);
    }
  }
  const cols = segments + 1;
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = base + r * cols + s;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      streams.indices.push(a, c, b, b, c, d);
    }
  }
}

/**
 * A smooth cone standing on `center` (its base), height along +Y. Side normals
 * point outward and slightly up, so the cone lights as a rounded surface —
 * tree canopies, spires.
 */
export function pushCone(
  streams: Streams,
  center: Vec3,
  radius: number,
  height: number,
  segments: number,
): void {
  const apex = streams.positions.length / 3;
  streams.positions.push(center[0], center[1] + height, center[2]);
  streams.normals.push(0, 1, 0);
  streams.uvs.push(0.5, 1);
  const ringStart = streams.positions.length / 3;
  const slope = radius / Math.hypot(radius, height);
  const up = height / Math.hypot(radius, height);
  for (let s = 0; s <= segments; s += 1) {
    const u = (s / segments) * Math.PI * 2;
    const cx = Math.cos(u);
    const cz = Math.sin(u);
    streams.positions.push(center[0] + cx * radius, center[1], center[2] + cz * radius);
    streams.normals.push(cx * up, slope, cz * up);
    streams.uvs.push(s / segments, 0);
  }
  for (let s = 0; s < segments; s += 1) {
    streams.indices.push(apex, ringStart + s, ringStart + s + 1);
  }
}

/**
 * A smooth vertical cylinder (open-ended) from `center` (its base) up by
 * `height` — tree trunks, columns, drums.
 */
export function pushCylinder(
  streams: Streams,
  center: Vec3,
  radius: number,
  height: number,
  segments: number,
): void {
  const base = streams.positions.length / 3;
  for (let s = 0; s <= segments; s += 1) {
    const u = (s / segments) * Math.PI * 2;
    const cx = Math.cos(u);
    const cz = Math.sin(u);
    const px = center[0] + cx * radius;
    const pz = center[2] + cz * radius;
    streams.positions.push(px, center[1], pz);
    streams.normals.push(cx, 0, cz);
    streams.uvs.push(s / segments, 0);
    streams.positions.push(px, center[1] + height, pz);
    streams.normals.push(cx, 0, cz);
    streams.uvs.push(s / segments, 1);
  }
  for (let s = 0; s < segments; s += 1) {
    const a = base + s * 2;
    streams.indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
}

/**
 * A faceted octahedron centred on `center` — eight flat triangles, each with its
 * own vertices and face normal, so it reads as a hard crystalline gem. The N64
 * courtyard uses it for the collectible that spins over the scene.
 */
export function pushOctahedron(streams: Streams, center: Vec3, radius: number): void {
  const v: Vec3[] = [
    [center[0], center[1] + radius, center[2]],
    [center[0], center[1] - radius, center[2]],
    [center[0] + radius, center[1], center[2]],
    [center[0] - radius, center[1], center[2]],
    [center[0], center[1], center[2] + radius],
    [center[0], center[1], center[2] - radius],
  ];
  const tris: ReadonlyArray<readonly [number, number, number]> = [
    [0, 4, 2], [0, 2, 5], [0, 5, 3], [0, 3, 4],
    [1, 2, 4], [1, 5, 2], [1, 3, 5], [1, 4, 3],
  ];
  for (const [i, j, k] of tris) {
    const base = streams.positions.length / 3;
    const a = v[i]!;
    const b = v[j]!;
    const c = v[k]!;
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const wx = c[0] - a[0];
    const wy = c[1] - a[1];
    const wz = c[2] - a[2];
    let nx = uy * wz - uz * wy;
    let ny = uz * wx - ux * wz;
    let nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const p of [a, b, c]) {
      streams.positions.push(p[0], p[1], p[2]);
      streams.normals.push(nx, ny, nz);
    }
    streams.uvs.push(0.5, 1, 0, 0, 1, 0);
    streams.indices.push(base, base + 1, base + 2);
  }
}

/** Assemble one primitive from a completed stream set. */
export function toPrimitive(streams: Streams, material: MeshMaterial): MeshPrimitive {
  return {
    positions: new Float32Array(streams.positions),
    normals: new Float32Array(streams.normals),
    uvs: new Float32Array(streams.uvs),
    indices: new Uint32Array(streams.indices),
    material,
  };
}
