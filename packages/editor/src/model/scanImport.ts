/**
 * Scans and dense meshes (AAA_FIDELITY_ROADMAP.md F9c): a photogrammetry or
 * scanner mesh — millions of triangles, its colour in its vertices, its
 * lighting baked into that colour — made into a game asset.
 *
 * - **PLY in** (`parsePly`), ASCII or binary either way round: positions,
 *   normals, colours (8-bit or float), any polygon fanned. (OBJ and glTF scans
 *   come in through their own codecs.)
 * - **Delighting.** The scan's colour is albedo times the light it was
 *   captured under. The light is fitted as L2 spherical harmonics of the
 *   normal (least squares over the vertices' luminance), and each vertex's
 *   colour divided by what the fit says its normal received, relative to the
 *   mean: the shading gone, the albedo kept.
 * - **The game mesh.** The dense mesh simplified to a triangle budget (QEM,
 *   meshSimplify.ts), its vertices taking the nearest dense vertex's colour,
 *   then auto-unwrapped (uvUnwrap.ts) and the colour baked into a texture
 *   (each triangle rasterised in UV space, its corners' colours blended, then
 *   dilated past the charts' edges).
 * - **No manual LODs:** an LOD chain generated from it (`generateLods`), a
 *   coarse "game" proxy for collision, and the triangles grouped into
 *   128-triangle clusters (Morton order, each with its bounding sphere and
 *   normal cone) for cluster rendering (F6a).
 */

import { computeSmoothNormals, type EncodedImage, type MeshAsset, type MeshMaterial, type MeshPrimitive } from "./MeshAsset";
import { generateLods, simplifyMesh, triangleCountOf } from "./meshSimplify";
import { shBasis } from "./probeVolume";
import { encodeRgbaPng } from "./png";
import { unwrapPrimitive } from "./uvUnwrap";

type V3 = [number, number, number];

/** A scan as read: its mesh and, when it had them, its vertices' colours (linear 0..1, three a vertex). */
export interface ScanMesh {
  readonly mesh: MeshAsset;
  readonly colors: Float32Array | null;
}

const PLY_TYPES: Record<string, { size: number; get: (v: DataView, o: number, le: boolean) => number }> = {
  char: { size: 1, get: (v, o) => v.getInt8(o) },
  int8: { size: 1, get: (v, o) => v.getInt8(o) },
  uchar: { size: 1, get: (v, o) => v.getUint8(o) },
  uint8: { size: 1, get: (v, o) => v.getUint8(o) },
  short: { size: 2, get: (v, o, le) => v.getInt16(o, le) },
  int16: { size: 2, get: (v, o, le) => v.getInt16(o, le) },
  ushort: { size: 2, get: (v, o, le) => v.getUint16(o, le) },
  uint16: { size: 2, get: (v, o, le) => v.getUint16(o, le) },
  int: { size: 4, get: (v, o, le) => v.getInt32(o, le) },
  int32: { size: 4, get: (v, o, le) => v.getInt32(o, le) },
  uint: { size: 4, get: (v, o, le) => v.getUint32(o, le) },
  uint32: { size: 4, get: (v, o, le) => v.getUint32(o, le) },
  float: { size: 4, get: (v, o, le) => v.getFloat32(o, le) },
  float32: { size: 4, get: (v, o, le) => v.getFloat32(o, le) },
  double: { size: 8, get: (v, o, le) => v.getFloat64(o, le) },
  float64: { size: 8, get: (v, o, le) => v.getFloat64(o, le) },
};

/** The most vertices and faces a scan may have. */
export const MAX_SCAN_VERTICES = 20_000_000;

interface PlyProperty {
  readonly name: string;
  readonly type: string;
  /** A list's count and item types. */
  readonly list?: { readonly count: string; readonly item: string };
}
interface PlyElement {
  readonly name: string;
  readonly count: number;
  readonly properties: PlyProperty[];
}

/** Read a PLY file (ASCII, binary little- or big-endian). */
export function parsePly(bytes: Uint8Array, name = "scan"): ScanMesh {
  // The header, up to "end_header\n".
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const end = head.indexOf("end_header");
  if (!head.startsWith("ply") || end < 0) throw new Error("Not a PLY file");
  const bodyStart = head.indexOf("\n", end) + 1;
  const lines = head.slice(0, end).split(/\r?\n/).map((l) => l.trim());
  let format = "ascii";
  const elements: PlyElement[] = [];
  for (const line of lines) {
    const w = line.split(/\s+/);
    if (w[0] === "format") format = w[1]!;
    else if (w[0] === "element") elements.push({ name: w[1]!, count: Number(w[2]), properties: [] });
    else if (w[0] === "property" && elements.length > 0) {
      const props = elements[elements.length - 1]!.properties;
      if (w[1] === "list") props.push({ name: w[4]!, type: "list", list: { count: w[2]!, item: w[3]! } });
      else props.push({ name: w[2]!, type: w[1]! });
    }
  }
  const vertexEl = elements.find((e) => e.name === "vertex");
  if (!vertexEl || !(vertexEl.count > 0) || vertexEl.count > MAX_SCAN_VERTICES) throw new Error("A PLY scan needs vertices");
  const n = vertexEl.count;
  const positions = new Float32Array(n * 3);
  let normals: Float32Array | null = null;
  let colors: Float32Array | null = null;
  const pick = (names: string[]) => vertexEl.properties.findIndex((p) => names.includes(p.name));
  const ix = [pick(["x"]), pick(["y"]), pick(["z"])];
  const inx = [pick(["nx"]), pick(["ny"]), pick(["nz"])];
  const ic = [pick(["red", "r", "diffuse_red"]), pick(["green", "g", "diffuse_green"]), pick(["blue", "b", "diffuse_blue"])];
  if (inx.every((i) => i >= 0)) normals = new Float32Array(n * 3);
  if (ic.every((i) => i >= 0)) colors = new Float32Array(n * 3);
  const colourScale = (type: string) => (type.startsWith("float") || type === "double" ? 1 : type.includes("short") || type.includes("16") ? 1 / 65535 : 1 / 255);
  const indices: number[] = [];

  const vertexRow = (v: number, row: number[]) => {
    for (let a = 0; a < 3; a += 1) positions[v * 3 + a] = row[ix[a]!]!;
    if (normals) for (let a = 0; a < 3; a += 1) normals[v * 3 + a] = row[inx[a]!]!;
    if (colors) for (let a = 0; a < 3; a += 1) colors[v * 3 + a] = row[ic[a]!]! * colourScale(vertexEl.properties[ic[a]!]!.type);
  };
  const faceRow = (list: number[]) => {
    for (let k = 1; k + 1 < list.length; k += 1) {
      const a = list[0]!, b = list[k]!, c = list[k + 1]!;
      if (a < n && b < n && c < n) indices.push(a, b, c);
    }
  };

  if (format === "ascii") {
    const body = new TextDecoder("latin1").decode(bytes.subarray(bodyStart)).split(/\r?\n/);
    let line = 0;
    for (const el of elements) {
      for (let r = 0; r < el.count; r += 1) {
        while (line < body.length && body[line]!.trim() === "") line += 1;
        const nums = (body[line++] ?? "").trim().split(/\s+/).map(Number);
        if (el === vertexEl) vertexRow(r, nums);
        else if (el.name === "face") faceRow(nums.slice(1, 1 + (nums[0] ?? 0)));
      }
    }
  } else {
    const le = format === "binary_little_endian";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = bodyStart;
    for (const el of elements) {
      for (let r = 0; r < el.count; r += 1) {
        const row: number[] = [];
        let list: number[] = [];
        for (const p of el.properties) {
          if (p.list) {
            const ct = PLY_TYPES[p.list.count]!;
            const it = PLY_TYPES[p.list.item]!;
            const count = ct.get(view, o, le);
            o += ct.size;
            list = [];
            for (let k = 0; k < count; k += 1) {
              list.push(it.get(view, o, le));
              o += it.size;
            }
            row.push(NaN);
          } else {
            const t = PLY_TYPES[p.type];
            if (!t) throw new Error(`Unknown PLY type ${p.type}`);
            row.push(t.get(view, o, le));
            o += t.size;
          }
        }
        if (el === vertexEl) vertexRow(r, row);
        else if (el.name === "face") faceRow(list);
      }
    }
  }
  const primitive: MeshPrimitive = {
    positions,
    normals: normals ?? computeSmoothNormals(positions, Uint32Array.from(indices)),
    uvs: new Float32Array(n * 2),
    indices: Uint32Array.from(indices),
    material: { name: "scan", baseColorFactor: [1, 1, 1, 1], baseColorImage: null, metallicFactor: 0, roughnessFactor: 0.8 },
  };
  return { mesh: { name, primitives: [primitive] }, colors };
}

// --- Delighting ---------------------------------------------------------------

/** Solve a small linear system (Gaussian elimination with partial pivoting; a little ridge for stability). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row.map((v, j) => v + (i === j ? 1e-6 : 0)), b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const d = m[c]![c]! || 1e-12;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r]![c]! / d;
      for (let k = c; k <= n; k += 1) m[r]![k] = m[r]![k]! - f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / (row[i]! || 1e-12));
}

const luminance = (c: ArrayLike<number>, o: number) => 0.2126 * c[o]! + 0.7152 * c[o + 1]! + 0.0722 * c[o + 2]!;

/**
 * Delight a scan's colours: the capture's light fitted as L2 SH of the
 * normal, each vertex divided by its share of it (the fit at its normal over
 * the fit's mean), clamped so a nearly black fit doesn't blow a colour up.
 * Returns the colours and the fitted light.
 */
export function delightColors(normals: Float32Array, colors: Float32Array): { colors: Float32Array; light: number[] } {
  const n = colors.length / 3;
  const ata = Array.from({ length: 9 }, () => new Array<number>(9).fill(0));
  const atb = new Array<number>(9).fill(0);
  // A stride over very dense scans: a few hundred thousand samples are plenty for nine numbers.
  const step = Math.max(1, Math.floor(n / 250_000));
  for (let v = 0; v < n; v += step) {
    const y = shBasis(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    const l = luminance(colors, v * 3);
    for (let i = 0; i < 9; i += 1) {
      atb[i] = atb[i]! + y[i]! * l;
      for (let j = 0; j < 9; j += 1) ata[i]![j] = ata[i]![j]! + y[i]! * y[j]!;
    }
  }
  const light = solve(ata, atb);
  const shade = (v: number) => shBasis(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!).reduce((s, b, i) => s + b * light[i]!, 0);
  let mean = 0;
  for (let v = 0; v < n; v += step) mean += shade(v);
  mean /= Math.ceil(n / step);
  const out = new Float32Array(colors.length);
  for (let v = 0; v < n; v += 1) {
    const k = mean > 1e-6 ? Math.max(0.2, shade(v) / mean) : 1;
    for (let a = 0; a < 3; a += 1) out[v * 3 + a] = Math.min(1, colors[v * 3 + a]! / k);
  }
  return { colors: out, light };
}

// --- Transfer, unwrap, bake ---------------------------------------------------

/** Each of `to`'s vertices takes the colour of the nearest of `from`'s (a uniform grid over the bounds). */
export function transferColors(from: Float32Array, fromColors: Float32Array, to: Float32Array): Float32Array {
  const n = from.length / 3;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < n; v += 1) for (let a = 0; a < 3; a += 1) {
    min[a] = Math.min(min[a]!, from[v * 3 + a]!);
    max[a] = Math.max(max[a]!, from[v * 3 + a]!);
  }
  const res = Math.max(1, Math.round(Math.cbrt(n / 4)));
  const size = [0, 1, 2].map((a) => (max[a]! - min[a]!) / res || 1);
  const cell = (p: readonly number[], a: number) => Math.max(0, Math.min(res - 1, Math.floor((p[a]! - min[a]!) / size[a]!)));
  const grid = new Map<number, number[]>();
  for (let v = 0; v < n; v += 1) {
    const p = [from[v * 3]!, from[v * 3 + 1]!, from[v * 3 + 2]!];
    const key = (cell(p, 0) * res + cell(p, 1)) * res + cell(p, 2);
    const list = grid.get(key);
    if (list) list.push(v);
    else grid.set(key, [v]);
  }
  const out = new Float32Array(to.length);
  for (let w = 0; w < to.length / 3; w += 1) {
    const p = [to[w * 3]!, to[w * 3 + 1]!, to[w * 3 + 2]!];
    const c = [cell(p, 0), cell(p, 1), cell(p, 2)];
    let best = -1;
    let bestD = Infinity;
    // Rings outward until something is found and the ring can't hold anything nearer.
    for (let r = 0; r < res && (best < 0 || r <= 1); r += 1) {
      for (let i = c[0]! - r; i <= c[0]! + r; i += 1)
        for (let j = c[1]! - r; j <= c[1]! + r; j += 1)
          for (let k = c[2]! - r; k <= c[2]! + r; k += 1) {
            if (Math.max(Math.abs(i - c[0]!), Math.abs(j - c[1]!), Math.abs(k - c[2]!)) !== r) continue;
            if (i < 0 || j < 0 || k < 0 || i >= res || j >= res || k >= res) continue;
            for (const v of grid.get((i * res + j) * res + k) ?? []) {
              const d = (from[v * 3]! - p[0]!) ** 2 + (from[v * 3 + 1]! - p[1]!) ** 2 + (from[v * 3 + 2]! - p[2]!) ** 2;
              if (d < bestD) {
                bestD = d;
                best = v;
              }
            }
          }
    }
    if (best >= 0) out.set(fromColors.subarray(best * 3, best * 3 + 3), w * 3);
  }
  return out;
}

/** The linear colour as 8-bit sRGB. */
const toSrgb8 = (c: number) => Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));

/**
 * Bake a primitive's vertex colours into a `size`² texture through its UVs:
 * each triangle rasterised in UV space, its corners' colours blended by
 * barycentrics, then the charts' edges dilated `dilate` texels outward.
 */
export function bakeVertexColors(primitive: MeshPrimitive, colors: Float32Array, size: number, dilate = 4): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const filled = new Uint8Array(size * size);
  const uv = primitive.uvs;
  if (!uv) return rgba;
  for (let t = 0; t + 2 < primitive.indices.length; t += 3) {
    const v = [primitive.indices[t]!, primitive.indices[t + 1]!, primitive.indices[t + 2]!];
    // Texel space, V up as the engine keeps it (row 0 is the image's top).
    const px = v.map((i) => uv[i * 2]! * size);
    const py = v.map((i) => (1 - uv[i * 2 + 1]!) * size);
    const x0 = Math.max(0, Math.floor(Math.min(...px))), x1 = Math.min(size - 1, Math.ceil(Math.max(...px)));
    const y0 = Math.max(0, Math.floor(Math.min(...py))), y1 = Math.min(size - 1, Math.ceil(Math.max(...py)));
    const area = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (px[2]! - px[0]!) * (py[1]! - py[0]!);
    if (Math.abs(area) < 1e-12) continue;
    for (let y = y0; y <= y1; y += 1)
      for (let x = x0; x <= x1; x += 1) {
        const sx = x + 0.5, sy = y + 0.5;
        const w1 = ((sx - px[0]!) * (py[2]! - py[0]!) - (px[2]! - px[0]!) * (sy - py[0]!)) / area;
        const w2 = ((px[1]! - px[0]!) * (sy - py[0]!) - (sx - px[0]!) * (py[1]! - py[0]!)) / area;
        const w0 = 1 - w1 - w2;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;
        const o = (y * size + x) * 4;
        for (let a = 0; a < 3; a += 1) rgba[o + a] = toSrgb8(Math.max(0, Math.min(1, w0 * colors[v[0]! * 3 + a]! + w1 * colors[v[1]! * 3 + a]! + w2 * colors[v[2]! * 3 + a]!)));
        rgba[o + 3] = 255;
        filled[y * size + x] = 1;
      }
  }
  // Dilation: an empty texel takes a filled neighbour's colour, ring by ring.
  for (let pass = 0; pass < dilate; pass += 1) {
    const grow: number[] = [];
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        if (filled[y * size + x]) continue;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size || !filled[ny * size + nx]) continue;
          grow.push(y * size + x, ny * size + nx);
          break;
        }
      }
    for (let k = 0; k < grow.length; k += 2) {
      rgba.set(rgba.subarray(grow[k + 1]! * 4, grow[k + 1]! * 4 + 4), grow[k]! * 4);
      filled[grow[k]!] = 1;
    }
  }
  return rgba;
}

// --- Clusters -----------------------------------------------------------------

/** A cluster: its triangles (a run of the primitive's reordered index buffer), bounding sphere and normal cone. */
export interface Cluster {
  readonly firstTriangle: number;
  readonly triangles: number;
  readonly center: V3;
  readonly radius: number;
  /** The mean normal and the cosine every triangle's normal is within (backface culling a whole cluster). */
  readonly axis: V3;
  readonly cutoff: number;
}

export const CLUSTER_TRIANGLES = 128;

/** Spread a 10-bit integer's bits three apart (for a Morton code). */
function spread(v: number): number {
  let x = v & 1023;
  x = (x | (x << 16)) & 0x30000ff;
  x = (x | (x << 8)) & 0x300f00f;
  x = (x | (x << 4)) & 0x30c30c3;
  x = (x | (x << 2)) & 0x9249249;
  return x;
}

/**
 * Group a primitive's triangles into clusters of up to {@link CLUSTER_TRIANGLES}:
 * each grown from the first unclustered triangle along a Morton curve of
 * their centres, across shared edges, taking the frontier triangle nearest
 * the cluster's start, so a cluster is a compact, connected patch. Returns
 * the reordered indices (a cluster's triangles a run) and the clusters.
 */
export function buildClusters(primitive: Pick<MeshPrimitive, "positions" | "indices">, size = CLUSTER_TRIANGLES): { indices: Uint32Array; clusters: Cluster[] } {
  const p = primitive.positions;
  const ix = primitive.indices;
  const tris = Math.floor(ix.length / 3);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a += 1) {
    min[a] = Math.min(min[a]!, p[i + a]!);
    max[a] = Math.max(max[a]!, p[i + a]!);
  }
  const centres = new Float64Array(tris * 3);
  for (let t = 0; t < tris; t += 1) for (let a = 0; a < 3; a += 1) centres[t * 3 + a] = (p[ix[t * 3]! * 3 + a]! + p[ix[t * 3 + 1]! * 3 + a]! + p[ix[t * 3 + 2]! * 3 + a]!) / 3;
  const codes = new Uint32Array(tris);
  for (let t = 0; t < tris; t += 1) {
    const q = [0, 1, 2].map((a) => Math.floor(((centres[t * 3 + a]! - min[a]!) / (max[a]! - min[a]! || 1)) * 1023));
    codes[t] = ((spread(q[0]!) << 2) | (spread(q[1]!) << 1) | spread(q[2]!)) >>> 0;
  }
  const order = Array.from({ length: tris }, (_, t) => t).sort((a, b) => codes[a]! - codes[b]!);
  // Edge adjacency.
  const byEdge = new Map<string, number[]>();
  for (let t = 0; t < tris; t += 1)
    for (let e = 0; e < 3; e += 1) {
      const a = ix[t * 3 + e]!, b = ix[t * 3 + ((e + 1) % 3)]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = byEdge.get(key);
      if (list) list.push(t);
      else byEdge.set(key, [t]);
    }
  const neighbours = (t: number) => {
    const out: number[] = [];
    for (let e = 0; e < 3; e += 1) {
      const a = ix[t * 3 + e]!, b = ix[t * 3 + ((e + 1) % 3)]!;
      for (const u of byEdge.get(a < b ? `${a},${b}` : `${b},${a}`) ?? []) if (u !== t) out.push(u);
    }
    return out;
  };
  const taken = new Uint8Array(tris);
  const runs: number[][] = [];
  for (const seed of order) {
    if (taken[seed]) continue;
    const run = [seed];
    taken[seed] = 1;
    const frontier = new Set<number>(neighbours(seed).filter((u) => !taken[u]));
    const d2 = (u: number) => (centres[u * 3]! - centres[seed * 3]!) ** 2 + (centres[u * 3 + 1]! - centres[seed * 3 + 1]!) ** 2 + (centres[u * 3 + 2]! - centres[seed * 3 + 2]!) ** 2;
    while (run.length < size && frontier.size > 0) {
      let best = -1;
      let bestD = Infinity;
      for (const u of frontier) {
        const d = d2(u);
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      frontier.delete(best);
      if (taken[best]) continue;
      taken[best] = 1;
      run.push(best);
      for (const u of neighbours(best)) if (!taken[u]) frontier.add(u);
    }
    runs.push(run);
  }
  const indices = new Uint32Array(tris * 3);
  const clusters: Cluster[] = [];
  let k = 0;
  for (const run of runs) {
    const first = k;
    const c: V3 = [0, 0, 0];
    const axis: V3 = [0, 0, 0];
    const normals: V3[] = [];
    for (const t of run) {
      indices.set(ix.subarray(t * 3, t * 3 + 3), k * 3);
      k += 1;
      const v = [ix[t * 3]!, ix[t * 3 + 1]!, ix[t * 3 + 2]!].map((i) => [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]);
      for (const q of v) for (let a = 0; a < 3; a += 1) c[a] = c[a]! + q[a]! / (run.length * 3);
      const e1 = [v[1]![0]! - v[0]![0]!, v[1]![1]! - v[0]![1]!, v[1]![2]! - v[0]![2]!];
      const e2 = [v[2]![0]! - v[0]![0]!, v[2]![1]! - v[0]![1]!, v[2]![2]! - v[0]![2]!];
      const n: V3 = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const l = Math.hypot(...n) || 1;
      normals.push([n[0] / l, n[1] / l, n[2] / l]);
      for (let a = 0; a < 3; a += 1) axis[a] = axis[a]! + n[a]! / l;
    }
    let radius = 0;
    for (let q = first * 3; q < k * 3; q += 1) {
      const i = indices[q]!;
      radius = Math.max(radius, Math.hypot(p[i * 3]! - c[0], p[i * 3 + 1]! - c[1], p[i * 3 + 2]! - c[2]));
    }
    const al = Math.hypot(...axis) || 1;
    const unit: V3 = [axis[0] / al, axis[1] / al, axis[2] / al];
    clusters.push({ firstTriangle: first, triangles: run.length, center: c, radius, axis: unit, cutoff: Math.min(...normals.map((n) => n[0] * unit[0] + n[1] * unit[1] + n[2] * unit[2])) });
  }
  return { indices, clusters };
}

/** Weld vertices that share a position (to a millionth of the mesh's size): their normals and colours averaged, collapsed triangles dropped. */
export function weldScan(scan: ScanMesh): ScanMesh {
  const prim = scan.mesh.primitives[0]!;
  const p = prim.positions;
  const n = p.length / 3;
  let span = 0;
  for (let i = 0; i < p.length; i += 1) span = Math.max(span, Math.abs(p[i]!));
  const q = (span || 1) * 1e-6;
  const remap = new Uint32Array(n);
  const seen = new Map<string, number>();
  const keep: number[] = [];
  for (let v = 0; v < n; v += 1) {
    const key = `${Math.round(p[v * 3]! / q)},${Math.round(p[v * 3 + 1]! / q)},${Math.round(p[v * 3 + 2]! / q)}`;
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, keep.length);
      remap[v] = keep.length;
      keep.push(v);
    } else remap[v] = at;
  }
  const m = keep.length;
  const positions = new Float32Array(m * 3);
  const sums = new Float32Array(m * 3);
  const colors = scan.colors ? new Float32Array(m * 3) : null;
  const counts = new Float32Array(m);
  for (let v = 0; v < n; v += 1) {
    const w = remap[v]!;
    counts[w] = counts[w]! + 1;
    for (let a = 0; a < 3; a += 1) {
      positions[w * 3 + a] = p[v * 3 + a]!;
      if (prim.normals) sums[w * 3 + a] = sums[w * 3 + a]! + prim.normals[v * 3 + a]!;
      if (colors) colors[w * 3 + a] = colors[w * 3 + a]! + scan.colors![v * 3 + a]!;
    }
  }
  // Triangles the weld collapsed (two corners at one point, as at a sphere's poles) go: their edges would read as borders.
  const kept: number[] = [];
  for (let k = 0; k + 2 < prim.indices.length; k += 3) {
    const a = remap[prim.indices[k]!]!, b = remap[prim.indices[k + 1]!]!, c = remap[prim.indices[k + 2]!]!;
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  const indices = Uint32Array.from(kept);
  const normals = prim.normals ? new Float32Array(m * 3) : computeSmoothNormals(positions, indices);
  for (let w = 0; w < m; w += 1) {
    if (prim.normals) {
      const l = Math.hypot(sums[w * 3]!, sums[w * 3 + 1]!, sums[w * 3 + 2]!) || 1;
      for (let a = 0; a < 3; a += 1) normals[w * 3 + a] = sums[w * 3 + a]! / l;
    }
    if (colors) for (let a = 0; a < 3; a += 1) colors[w * 3 + a] = colors[w * 3 + a]! / counts[w]!;
  }
  return { mesh: { ...scan.mesh, primitives: [{ ...prim, positions, normals, uvs: new Float32Array(m * 2), indices }] }, colors };
}

// --- The whole pipeline -------------------------------------------------------

export interface ScanOptions {
  /** The game mesh's triangle budget (default 60 000). */
  readonly triangles?: number;
  /** The collision proxy's (default 1 000). */
  readonly proxyTriangles?: number;
  /** The colour texture's size (default 1024). */
  readonly textureSize?: number;
  /** Delight the colours (default on). */
  readonly delight?: boolean;
}

/** A prepared scan: the game mesh (unwrapped, its colour baked), its LOD chain, the collision proxy, the clusters, and what was found. */
export interface PreparedScan {
  readonly mesh: MeshAsset;
  readonly lods: { readonly meshes: readonly MeshAsset[]; readonly distances: readonly number[] } | null;
  readonly proxy: MeshAsset;
  readonly clusters: readonly Cluster[];
  readonly light: readonly number[] | null;
  readonly stats: { readonly denseTriangles: number; readonly triangles: number; readonly proxyTriangles: number };
}

/** Prepare a scan for the game: see the module comment. */
export function prepareScan(given: ScanMesh, options: ScanOptions = {}): PreparedScan {
  // Welded first: a scan's duplicated seam vertices would hold the simplifier at their borders.
  const scan = weldScan(given);
  const dense = scan.mesh;
  const denseTris = triangleCountOf(dense);
  const budget = options.triangles ?? 60_000;
  const prim0 = dense.primitives[0]!;
  const normals = prim0.normals ?? computeSmoothNormals(prim0.positions, prim0.indices);
  let colors = scan.colors;
  let light: number[] | null = null;
  if (colors && options.delight !== false) {
    const d = delightColors(normals, colors);
    colors = d.colors;
    light = d.light;
  }
  const game = denseTris > budget ? simplifyMesh(dense, budget / denseTris) : dense;
  const prim = game.primitives[0]!;
  const unwrapped = unwrapPrimitive({ ...prim, normals: prim.normals ?? computeSmoothNormals(prim.positions, prim.indices) });
  // Clusters reorder the triangles: the index buffer the mesh keeps is in cluster order.
  const { indices, clusters } = buildClusters(unwrapped);
  let material: MeshMaterial = prim.material;
  if (colors) {
    const size = options.textureSize ?? 1024;
    const vertexColors = transferColors(prim0.positions, colors, unwrapped.positions);
    const rgba = bakeVertexColors(unwrapped, vertexColors, size);
    const image: EncodedImage = { mime: "image/png", bytes: encodeRgbaPng(rgba, size, size) };
    material = { ...material, baseColorImage: image, baseColorFactor: [1, 1, 1, 1] };
  }
  const mesh: MeshAsset = { name: dense.name, primitives: [{ ...unwrapped, indices, material }] };
  // The proxy straight from the welded scan: collision needs no UVs, and the charts' seams would hold the simplifier back.
  const proxyBudget = options.proxyTriangles ?? 1000;
  const tris = triangleCountOf(mesh);
  const proxy = denseTris > proxyBudget ? simplifyMesh(dense, proxyBudget / denseTris) : dense;
  return {
    mesh,
    lods: generateLods(mesh),
    proxy: { ...proxy, name: `${dense.name}:collision` },
    clusters,
    light,
    stats: { denseTriangles: denseTris, triangles: tris, proxyTriangles: triangleCountOf(proxy) },
  };
}
