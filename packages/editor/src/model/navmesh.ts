/**
 * Navigation (ENGINE_ROADMAP.md, Phase 6): a walkable surface baked from a
 * scene's geometry, and paths across it — so characters find their own way
 * round a map instead of following hand-placed waypoints.
 *
 * Baking works like Recast's first stages, on a grid of columns `cell` wide:
 *
 * 1. Every triangle is clipped to each column it covers, leaving a solid span
 *    (bottom and top height) there; a span whose top comes from a surface flat
 *    enough to stand on (within `maxSlope`) is walkable.
 * 2. Overlapping spans merge. The top of a walkable span is a floor when there
 *    is headroom for the agent (`height`) above it.
 * 3. Floors link to their four neighbours when the step between them is at most
 *    `climb` (stairs and ramps join up; walls and ledges don't). Floors closer
 *    to an edge than the agent's `radius` are removed, so a path keeps a body's
 *    width from walls and drops.
 * 4. A floor at a ledge gets a one-way **drop** link to the floor below it, when
 *    that is at most `maxDrop` down and nothing is in the way.
 *
 * The result is a heightfield of floors (a few per column where storeys stack),
 * stored compactly on the mesh sidecar. {@link NavGraph} finds paths over it
 * (A* over floors, then straightened into as few straight walks as the surface
 * allows) and answers "where is the floor here". Pure and DOM-free: the editor
 * bakes, the player walks agents over it, the tests check both.
 */

/** The body the surface is baked for. */
export interface NavAgent {
  /** Distance kept from walls and drops. */
  readonly radius: number;
  /** Headroom needed. */
  readonly height: number;
  /** Tallest step walked up (or down) without a drop. */
  readonly climb: number;
  /** Steepest walkable slope, degrees. */
  readonly maxSlope: number;
  /** Deepest ledge dropped off (0: never drop). */
  readonly maxDrop: number;
}

export const DEFAULT_NAV_AGENT: NavAgent = { radius: 0.4, height: 1.8, climb: 0.5, maxSlope: 45, maxDrop: 4 };

export interface NavMesh {
  /** Column width (world units). */
  readonly cell: number;
  /** World X / Z of the first column's corner. */
  readonly originX: number;
  readonly originZ: number;
  readonly cols: number;
  readonly rows: number;
  readonly agent: NavAgent;
  /** Floors per column (cols × rows, row-major by Z). */
  readonly counts: Uint8Array;
  /** Floor heights, column by column, ascending within a column. */
  readonly heights: Float32Array;
  /** One-way drops: pairs of floor indices (from, to). */
  readonly drops: Uint32Array;
}

/** Limits for untrusted or runaway input. */
export const NAV_MAX_COLUMNS = 1_000_000;
export const NAV_MAX_FLOORS = 2_000_000;
const MAX_PER_COLUMN = 16;

interface Span {
  lo: number;
  hi: number;
  walk: boolean;
}

/** A triangle's piece in one column: its height range, and which way it faces (up 1, down -1, sideways 0). */
interface Piece extends Span {
  dir: 1 | -1 | 0;
  /** The share of the column's area it covers (0..1). */
  w: number;
}

/** Clip a 3D polygon to the half-space where `axis` (0 = x, 2 = z) is ≥ (sign 1) or ≤ (sign -1) `limit`. */
function clip(poly: number[][], axis: 0 | 2, limit: number, sign: 1 | -1): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const da = (a[axis]! - limit) * sign;
    const db = (b[axis]! - limit) * sign;
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push([a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t]);
    }
  }
  return out;
}

/**
 * Whether a clipped piece lying flat on one of its column's borders belongs to
 * the other column: a face exactly on a grid line belongs only to the column its
 * solid side is in (it faces away from that column), and a flat face touching a
 * border only along an edge belongs to the column it covers.
 */
function notOurs(poly: number[][], x0: number, z0: number, cell: number, nx: number, ny: number, nz: number): boolean {
  const eps = 1e-6;
  const all = (axis: 0 | 2, v: number) => poly.every((p) => Math.abs(p[axis]! - v) < eps);
  if (all(0, x0)) return Math.abs(ny) > 0.5 || nx > 0;
  if (all(0, x0 + cell)) return Math.abs(ny) > 0.5 || nx < 0;
  if (all(2, z0)) return Math.abs(ny) > 0.5 || nz > 0;
  if (all(2, z0 + cell)) return Math.abs(ny) > 0.5 || nz < 0;
  return false;
}

/**
 * Bake a walkable surface from world-space triangles (9 floats each: three
 * xyz corners). `cell` is the column width; smaller is finer and bigger.
 */
export function bakeNavMesh(triangles: Float32Array, options: { cell?: number; agent?: Partial<NavAgent> } = {}): NavMesh {
  const agent: NavAgent = { ...DEFAULT_NAV_AGENT, ...options.agent };
  const cell = Math.max(0.05, options.cell ?? 0.25);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < triangles.length; i += 3) {
    minX = Math.min(minX, triangles[i]!);
    maxX = Math.max(maxX, triangles[i]!);
    minZ = Math.min(minZ, triangles[i + 2]!);
    maxZ = Math.max(maxZ, triangles[i + 2]!);
  }
  const empty = (): NavMesh => ({ cell, originX: 0, originZ: 0, cols: 0, rows: 0, agent, counts: new Uint8Array(0), heights: new Float32Array(0), drops: new Uint32Array(0) });
  if (!Number.isFinite(minX)) return empty();
  const originX = Math.floor(minX / cell) * cell;
  const originZ = Math.floor(minZ / cell) * cell;
  const cols = Math.ceil((maxX - originX) / cell) + 1;
  const rows = Math.ceil((maxZ - originZ) / cell) + 1;
  if (cols * rows > NAV_MAX_COLUMNS) throw new Error("Navigation area too big for this cell size");

  // 1. Rasterize: each triangle's extent in every column it covers.
  const columns: Piece[][] = Array.from({ length: cols * rows }, () => []);
  const minNormalY = Math.cos((agent.maxSlope * Math.PI) / 180);
  for (let t = 0; t + 8 < triangles.length; t += 9) {
    const a = [triangles[t]!, triangles[t + 1]!, triangles[t + 2]!];
    const b = [triangles[t + 3]!, triangles[t + 4]!, triangles[t + 5]!];
    const c = [triangles[t + 6]!, triangles[t + 7]!, triangles[t + 8]!];
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz);
    if (nl < 1e-12) continue;
    // Faces are wound counter-clockwise seen from outside (glTF's convention),
    // so the normal points out of the solid: up-facing flat faces are floors.
    const walk = ny / nl >= minNormalY;
    const dir: 1 | -1 | 0 = ny / nl > 0.05 ? 1 : ny / nl < -0.05 ? -1 : 0;
    const i0 = Math.max(0, Math.floor((Math.min(a[0]!, b[0]!, c[0]!) - originX) / cell));
    const i1 = Math.min(cols - 1, Math.floor((Math.max(a[0]!, b[0]!, c[0]!) - originX) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(a[2]!, b[2]!, c[2]!) - originZ) / cell));
    const j1 = Math.min(rows - 1, Math.floor((Math.max(a[2]!, b[2]!, c[2]!) - originZ) / cell));
    for (let j = j0; j <= j1; j += 1) {
      const z0 = originZ + j * cell;
      const row = clip(clip([a, b, c], 2, z0, 1), 2, z0 + cell, -1);
      if (row.length < 3) continue;
      for (let i = i0; i <= i1; i += 1) {
        const x0 = originX + i * cell;
        const poly = clip(clip(row, 0, x0, 1), 0, x0 + cell, -1);
        if (poly.length < 3 || notOurs(poly, x0, z0, cell, nx, ny, nz)) continue;
        let lo = Infinity;
        let hi = -Infinity;
        for (const p of poly) {
          lo = Math.min(lo, p[1]!);
          hi = Math.max(hi, p[1]!);
        }
        // Its footprint's share of the column: the two triangles of one face add
        // up to that face once, so a solid's depth count stays right however
        // its faces are split.
        let area = 0;
        for (let k = 0; k < poly.length; k += 1) {
          const p = poly[k]!;
          const q = poly[(k + 1) % poly.length]!;
          area += p[0]! * q[2]! - q[0]! * p[2]!;
        }
        columns[j * cols + i]!.push({ lo, hi, walk, dir, w: Math.min(1, Math.abs(area) / 2 / (cell * cell)) });
      }
    }
  }

  // 2. Fill solids: a downward face opens one and the upward face above closes
  // it (a winding count, so overlapping boxes fill as one). Sideways faces and
  // unpaired faces (an open ground plane) stay as they are. Then overlapping
  // spans merge; floors are walkable tops with headroom.
  const solidsOf = (pieces: Piece[]): Span[] => {
    const out: Span[] = [];
    const events: { y: number; open: boolean; piece: Piece; w: number }[] = [];
    for (const p of pieces) {
      if (p.dir === 0) out.push({ lo: p.lo, hi: p.hi, walk: false });
      else if (p.w > 1e-6) events.push({ y: p.dir < 0 ? p.lo : p.hi, open: p.dir < 0, piece: p, w: p.w });
    }
    events.sort((a, b) => a.y - b.y || (a.open ? -1 : 1));
    const EPS = 1e-4;
    let depth = 0;
    let start = 0;
    for (const e of events) {
      if (e.open) {
        if (depth <= EPS) start = e.piece.lo;
        depth += e.w;
      } else if (depth > EPS) {
        depth -= e.w;
        if (depth <= EPS) {
          depth = 0;
          out.push({ lo: start, hi: e.piece.hi, walk: e.piece.walk });
        }
      } else out.push({ lo: e.piece.lo, hi: e.piece.hi, walk: e.piece.walk });
    }
    if (depth > EPS) out.push({ lo: start, hi: start, walk: false });
    return out;
  };
  const solids = columns.map(solidsOf);
  const floorY: number[][] = solids.map((source) => {
    const spans = [...source];
    if (spans.length === 0) return [];
    spans.sort((p, q) => p.lo - q.lo);
    const merged: Span[] = [{ ...spans[0]! }];
    for (let k = 1; k < spans.length; k += 1) {
      const s = spans[k]!;
      const top = merged[merged.length - 1]!;
      if (s.lo <= top.hi + 0.02) {
        if (s.hi > top.hi + 1e-3) {
          top.walk = s.walk;
          top.hi = s.hi;
        } else if (Math.abs(s.hi - top.hi) <= 1e-3) top.walk = top.walk || s.walk;
      } else merged.push({ ...s });
    }
    const out: number[] = [];
    for (let k = 0; k < merged.length; k += 1) {
      const s = merged[k]!;
      const above = merged[k + 1];
      if (s.walk && (!above || above.lo - s.hi >= agent.height)) out.push(s.hi);
    }
    return out.slice(-MAX_PER_COLUMN);
  });

  // 3. Link floors to neighbours; erode by the radius.
  const index: number[][] = [];
  let n = 0;
  for (const ys of floorY) {
    index.push(ys.map(() => n++));
  }
  const col = new Int32Array(n);
  const ys = new Float32Array(n);
  floorY.forEach((list, c) => list.forEach((y, k) => ((col[index[c]![k]!] = c), (ys[index[c]![k]!] = y))));
  const DIRS = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  const neighbour = (f: number, dx: number, dz: number): number => {
    const c = col[f]!;
    const i = (c % cols) + dx;
    const j = Math.floor(c / cols) + dz;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return -1;
    const list = index[j * cols + i]!;
    let best = -1;
    let bd = agent.climb + 1e-4;
    for (const g of list) {
      const d = Math.abs(ys[g]! - ys[f]!);
      if (d <= bd) {
        bd = d;
        best = g;
      }
    }
    return best;
  };
  // Distance (in cells) from each floor to the nearest edge, by a two-pass chamfer over links.
  const dist = new Float32Array(n).fill(Infinity);
  const queue: number[] = [];
  for (let f = 0; f < n; f += 1) {
    let links = 0;
    for (const [dx, dz] of DIRS) if (neighbour(f, dx, dz) >= 0) links += 1;
    if (links < 4) {
      dist[f] = 0;
      queue.push(f);
    }
  }
  // Dijkstra-lite over 8 directions (diagonals via two orthogonal links).
  const DIAG = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const;
  for (let head = 0; head < queue.length; head += 1) {
    const f = queue[head]!;
    const d = dist[f]!;
    for (const [dx, dz] of DIRS) {
      const g = neighbour(f, dx, dz);
      if (g >= 0 && dist[g]! > d + 1) {
        dist[g] = d + 1;
        queue.push(g);
      }
    }
    for (const [dx, dz] of DIAG) {
      const a = neighbour(f, dx, 0);
      const g = a >= 0 ? neighbour(a, 0, dz) : -1;
      if (g >= 0 && dist[g]! > d + Math.SQRT2) {
        dist[g] = d + Math.SQRT2;
        queue.push(g);
      }
    }
  }
  const keep = new Uint8Array(n);
  for (let f = 0; f < n; f += 1) keep[f] = (dist[f]! + 0.5) * cell >= agent.radius - 1e-6 ? 1 : 0;
  // Clearance across the body, not just straight up: a floor goes if an
  // overhang within the radius — something whose underside is above a step but
  // below head height (a walkway's edge above a ramp) — would hit the head.
  // Walls and stairs rise from below the feet: erosion and the step limit deal
  // with those.
  const ring = Math.ceil(agent.radius / cell);
  for (let f = 0; f < n; f += 1) {
    if (!keep[f]) continue;
    const y = ys[f]!;
    const ci = col[f]! % cols;
    const cj = Math.floor(col[f]! / cols);
    scan: for (let dj = -ring; dj <= ring; dj += 1) {
      for (let di = -ring; di <= ring; di += 1) {
        if ((di === 0 && dj === 0) || Math.hypot(di, dj) * cell > agent.radius + cell * 0.5) continue;
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        for (const sp of solids[j * cols + i]!) {
          if (sp.lo > y + agent.climb && sp.lo < y + agent.height) {
            keep[f] = 0;
            break scan;
          }
        }
      }
    }
  }

  // Renumber the kept floors.
  const counts = new Uint8Array(cols * rows);
  const remap = new Int32Array(n).fill(-1);
  const heights: number[] = [];
  for (let c = 0; c < cols * rows; c += 1) {
    for (const f of index[c]!) {
      if (!keep[f]) continue;
      remap[f] = heights.length;
      heights.push(ys[f]!);
      counts[c] = counts[c]! + 1;
    }
  }
  if (heights.length > NAV_MAX_FLOORS) throw new Error("Navigation surface too big for this cell size");

  // 4. Drops: from a kept floor at a ledge, straight out over the edge to the
  // first kept floor below (the ground right under a ledge is usually eroded —
  // it's by the wall — so the fall carries on outward a little).
  const drops: number[] = [];
  if (agent.maxDrop > agent.climb) {
    const reach = Math.ceil((agent.radius * 4 + cell) / cell) + 2;
    const clear = (c: number, from: number, to: number) => !solids[c]!.some((s) => s.hi > from + 1e-3 && s.lo < to);
    const bodyClear = (c: number, from: number, to: number): boolean => {
      const ci = c % cols;
      const cj = Math.floor(c / cols);
      const ring = Math.ceil(agent.radius / cell);
      for (let dj = -ring; dj <= ring; dj += 1) {
        for (let di = -ring; di <= ring; di += 1) {
          if (Math.hypot(di, dj) * cell > agent.radius + cell * 0.5) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
          if (solids[j * cols + i]!.some((s) => s.hi > from + agent.climb && s.lo < to)) return false;
        }
      }
      return true;
    };
    for (let f = 0; f < n; f += 1) {
      if (!keep[f]) continue;
      const y = ys[f]!;
      const c0 = col[f]!;
      for (const [dx, dz] of DIRS) {
        // Only at an edge of the kept surface.
        const next = neighbour(f, dx, dz);
        if (next >= 0 && keep[next]) continue;
        let i = c0 % cols;
        let j = Math.floor(c0 / cols);
        let falling = false;
        for (let step = 1; step <= reach; step += 1) {
          i += dx;
          j += dz;
          if (i < 0 || j < 0 || i >= cols || j >= rows) break;
          const c = j * cols + i;
          // Still on this storey (unkept, near the edge): keep going.
          if (!falling && floorY[c]!.some((h) => Math.abs(h - y) <= agent.climb)) continue;
          falling = true;
          // The highest floor below, within reach of a drop.
          let below = -Infinity;
          for (const h of floorY[c]!) if (y - h > agent.climb && y - h <= agent.maxDrop) below = Math.max(below, h);
          if (below === -Infinity || !clear(c, below, y + agent.height)) break;
          let target = -1;
          for (const g of index[c]!) if (keep[g] && Math.abs(ys[g]! - below) < 1e-4) target = g;
          // Land only where the whole body clears what it dropped off (a floor
          // running on under a walkway isn't somewhere to land right beside it).
          if (target >= 0 && !bodyClear(c, below, y + agent.height)) target = -1;
          if (target >= 0) {
            drops.push(remap[f]!, remap[target]!);
            break;
          }
        }
      }
    }
  }

  return { cell, originX, originZ, cols, rows, agent, counts, heights: new Float32Array(heights), drops: new Uint32Array(drops) };
}

/** Triangles (9 floats each) for axis-aligned boxes given as [cx, cy, cz, hx, hy, hz], wound to face outward. */
export function boxTriangles(boxes: readonly (readonly number[])[]): Float32Array {
  const out: number[] = [];
  for (const [cx, cy, cz, hx, hy, hz] of boxes) {
    const x0 = cx! - hx!, x1 = cx! + hx!, y0 = cy! - hy!, y1 = cy! + hy!, z0 = cz! - hz!, z1 = cz! + hz!;
    // Each quad listed counter-clockwise as seen from outside.
    const quad = (a: number[], b: number[], c: number[], d: number[]) => out.push(...a, ...b, ...c, ...a, ...c, ...d);
    quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // top (+y)
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // bottom (-y)
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
    quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
  }
  return new Float32Array(out);
}

// --- Storage ------------------------------------------------------------------

export interface SerializedNavMesh {
  cell: number;
  originX: number;
  originZ: number;
  cols: number;
  rows: number;
  agent: NavAgent;
  counts: string;
  /** Floor heights in centimetres, as int16 in a float-free base64 (see encode). */
  heights: string;
  drops: string;
}

const u8ToBase64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const base64ToU8 = (text: string): Uint8Array => {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
};

/** Store a baked surface (heights to the centimetre). */
export function serializeNavMesh(mesh: NavMesh): SerializedNavMesh {
  const heights = new Int16Array(mesh.heights.length);
  mesh.heights.forEach((h, i) => (heights[i] = Math.max(-32768, Math.min(32767, Math.round(h * 100)))));
  return {
    cell: mesh.cell,
    originX: mesh.originX,
    originZ: mesh.originZ,
    cols: mesh.cols,
    rows: mesh.rows,
    agent: mesh.agent,
    counts: u8ToBase64(mesh.counts),
    heights: u8ToBase64(new Uint8Array(heights.buffer)),
    drops: u8ToBase64(new Uint8Array(mesh.drops.buffer, mesh.drops.byteOffset, mesh.drops.byteLength)),
  };
}

const finite = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

/** Read a stored surface, or null when absent or malformed (it's untrusted). */
export function readNavMesh(value: unknown): NavMesh | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const cell = finite(raw.cell, 0.01, 100);
  const originX = finite(raw.originX, -1e7, 1e7);
  const originZ = finite(raw.originZ, -1e7, 1e7);
  const cols = finite(raw.cols, 0, NAV_MAX_COLUMNS);
  const rows = finite(raw.rows, 0, NAV_MAX_COLUMNS);
  if (cell === null || originX === null || originZ === null || cols === null || rows === null) return null;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols * rows > NAV_MAX_COLUMNS) return null;
  if (typeof raw.counts !== "string" || typeof raw.heights !== "string" || typeof raw.drops !== "string") return null;
  const a = (raw.agent ?? {}) as Record<string, unknown>;
  const agent: NavAgent = {
    radius: finite(a.radius, 0, 100) ?? DEFAULT_NAV_AGENT.radius,
    height: finite(a.height, 0, 100) ?? DEFAULT_NAV_AGENT.height,
    climb: finite(a.climb, 0, 100) ?? DEFAULT_NAV_AGENT.climb,
    maxSlope: finite(a.maxSlope, 0, 90) ?? DEFAULT_NAV_AGENT.maxSlope,
    maxDrop: finite(a.maxDrop, 0, 1000) ?? DEFAULT_NAV_AGENT.maxDrop,
  };
  try {
    const counts = base64ToU8(raw.counts);
    if (counts.length !== cols * rows) return null;
    let total = 0;
    for (const c of counts) total += c;
    const hb = base64ToU8(raw.heights);
    if (hb.length !== total * 2 || total > NAV_MAX_FLOORS) return null;
    const h16 = new Int16Array(hb.buffer, hb.byteOffset, total);
    const heights = new Float32Array(total);
    for (let i = 0; i < total; i += 1) heights[i] = h16[i]! / 100;
    const db = base64ToU8(raw.drops);
    if (db.length % 8 !== 0) return null;
    const drops = new Uint32Array(db.buffer.slice(db.byteOffset, db.byteOffset + db.length));
    for (const d of drops) if (d >= total) return null;
    return { cell, originX, originZ, cols, rows, agent, counts, heights, drops };
  } catch {
    return null;
  }
}

// --- Paths ----------------------------------------------------------------------

type P3 = readonly [number, number, number];

/** A binary min-heap of floor indices keyed by a score array. */
class Heap {
  private items: number[] = [];
  constructor(private readonly score: Float64Array) {}
  get size(): number {
    return this.items.length;
  }
  clear(): void {
    this.items.length = 0;
  }
  push(v: number): void {
    const a = this.items;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score[a[p]!]! <= this.score[a[i]!]!) break;
      [a[p], a[i]] = [a[i]!, a[p]!];
      i = p;
    }
  }
  pop(): number {
    const a = this.items;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.score[a[l]!]! < this.score[a[m]!]!) m = l;
        if (r < a.length && this.score[a[r]!]! < this.score[a[m]!]!) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}

/** Paths and floor queries over a baked {@link NavMesh}. */
export class NavGraph {
  /** First floor index of each column (cols × rows + 1). */
  private readonly start: Uint32Array;
  /** Each floor's column. */
  private readonly colOf: Int32Array;
  /** Drop links out of each floor. */
  private readonly dropsFrom = new Map<number, number[]>();
  private readonly g: Float64Array;
  private readonly f: Float64Array;
  private readonly from: Int32Array;
  private readonly seen: Uint32Array;
  private generation = 0;
  private readonly heap: Heap;

  constructor(readonly mesh: NavMesh) {
    const n = mesh.heights.length;
    this.start = new Uint32Array(mesh.counts.length + 1);
    this.colOf = new Int32Array(n);
    for (let c = 0; c < mesh.counts.length; c += 1) {
      this.start[c + 1] = this.start[c]! + mesh.counts[c]!;
      for (let k = this.start[c]!; k < this.start[c + 1]!; k += 1) this.colOf[k] = c;
    }
    for (let i = 0; i + 1 < mesh.drops.length; i += 2) {
      const list = this.dropsFrom.get(mesh.drops[i]!) ?? [];
      list.push(mesh.drops[i + 1]!);
      this.dropsFrom.set(mesh.drops[i]!, list);
    }
    this.g = new Float64Array(n);
    this.f = new Float64Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.heap = new Heap(this.f);
  }

  /** Number of floors. */
  get size(): number {
    return this.mesh.heights.length;
  }

  /** The centre of a floor, in the world. */
  position(floor: number): [number, number, number] {
    const m = this.mesh;
    const c = this.colOf[floor]!;
    return [m.originX + ((c % m.cols) + 0.5) * m.cell, m.heights[floor]!, m.originZ + (Math.floor(c / m.cols) + 0.5) * m.cell];
  }

  private column(x: number, z: number): number {
    const m = this.mesh;
    const i = Math.floor((x - m.originX) / m.cell);
    const j = Math.floor((z - m.originZ) / m.cell);
    if (i < 0 || j < 0 || i >= m.cols || j >= m.rows) return -1;
    return j * m.cols + i;
  }

  /**
   * The floor under (x, z) that something at height `y` stands on: the highest
   * floor no more than `climb` above y (so a step up counts), or -1.
   */
  floorAt(x: number, y: number, z: number, climb = this.mesh.agent.climb): number {
    const c = this.column(x, z);
    if (c < 0) return -1;
    let best = -1;
    for (let k = this.start[c]!; k < this.start[c + 1]!; k += 1) {
      if (this.mesh.heights[k]! <= y + climb) best = k;
    }
    return best;
  }

  /** The floor nearest a point (searching outward up to `range` world units), or -1. */
  nearest(x: number, y: number, z: number, range = 3): number {
    const m = this.mesh;
    const ci = Math.floor((x - m.originX) / m.cell);
    const cj = Math.floor((z - m.originZ) / m.cell);
    const rings = Math.ceil(range / m.cell);
    let best = -1;
    let bd = Infinity;
    for (let r = 0; r <= rings; r += 1) {
      for (let dj = -r; dj <= r; dj += 1) {
        for (let di = -r; di <= r; di += 1) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const i = ci + di;
          const j = cj + dj;
          if (i < 0 || j < 0 || i >= m.cols || j >= m.rows) continue;
          const c = j * m.cols + i;
          for (let k = this.start[c]!; k < this.start[c + 1]!; k += 1) {
            const h = m.heights[k]!;
            // Height counts extra: a point under the walkway isn't "at" the walkway.
            const dy = h - y;
            const d = (di * di + dj * dj) * m.cell * m.cell + dy * dy * (dy > m.agent.climb ? 9 : 2);
            if (d < bd) {
              bd = d;
              best = k;
            }
          }
        }
      }
      if (best >= 0 && r * m.cell * r * m.cell > bd) break;
    }
    return best;
  }

  /** Walkable neighbours of a floor (8 directions, diagonals only round no corner), then its drops. */
  private *links(floor: number): Generator<[number, number]> {
    const m = this.mesh;
    const c = this.colOf[floor]!;
    const i = c % m.cols;
    const j = Math.floor(c / m.cols);
    const y = m.heights[floor]!;
    const step = (di: number, dj: number): number => {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= m.cols || jj >= m.rows) return -1;
      const cc = jj * m.cols + ii;
      let best = -1;
      let bd = m.agent.climb + 1e-4;
      for (let k = this.start[cc]!; k < this.start[cc + 1]!; k += 1) {
        const d = Math.abs(m.heights[k]! - y);
        if (d <= bd) {
          bd = d;
          best = k;
        }
      }
      return best;
    };
    const e = step(1, 0);
    const w = step(-1, 0);
    const n = step(0, 1);
    const s = step(0, -1);
    if (e >= 0) yield [e, m.cell];
    if (w >= 0) yield [w, m.cell];
    if (n >= 0) yield [n, m.cell];
    if (s >= 0) yield [s, m.cell];
    const diag = m.cell * Math.SQRT2;
    if (e >= 0 && n >= 0) {
      const d = step(1, 1);
      if (d >= 0) yield [d, diag];
    }
    if (e >= 0 && s >= 0) {
      const d = step(1, -1);
      if (d >= 0) yield [d, diag];
    }
    if (w >= 0 && n >= 0) {
      const d = step(-1, 1);
      if (d >= 0) yield [d, diag];
    }
    if (w >= 0 && s >= 0) {
      const d = step(-1, -1);
      if (d >= 0) yield [d, diag];
    }
    for (const d of this.dropsFrom.get(floor) ?? []) {
      const [x0, , z0] = this.position(floor);
      const [x1, , z1] = this.position(d);
      yield [d, Math.hypot(x1 - x0, z1 - z0) + 0.5];
    }
  }

  /** Floors from `a` to `b` (both included), or null when unreachable. */
  floorPath(a: number, b: number, maxVisits = 200_000): number[] | null {
    if (a < 0 || b < 0) return null;
    if (a === b) return [a];
    this.generation += 1;
    if (this.generation === 0xffffffff) {
      this.seen.fill(0);
      this.generation = 1;
    }
    const gen = this.generation;
    const [bx, by, bz] = this.position(b);
    const h = (k: number) => {
      const [x, y, z] = this.position(k);
      return Math.hypot(x - bx, z - bz) + Math.abs(y - by) * 0.5;
    };
    this.heap.clear();
    this.seen[a] = gen;
    this.g[a] = 0;
    this.f[a] = h(a);
    this.from[a] = -1;
    this.heap.push(a);
    let visits = 0;
    while (this.heap.size > 0 && visits < maxVisits) {
      const cur = this.heap.pop();
      visits += 1;
      if (cur === b) {
        const out: number[] = [];
        for (let k = b; k >= 0; k = this.from[k]!) out.push(k);
        return out.reverse();
      }
      const gc = this.g[cur]!;
      for (const [next, cost] of this.links(cur)) {
        const dy = Math.abs(this.mesh.heights[next]! - this.mesh.heights[cur]!);
        const ng = gc + cost + dy * 0.5;
        if (this.seen[next] !== gen || ng < this.g[next]!) {
          this.seen[next] = gen;
          this.g[next] = ng;
          this.f[next] = ng + h(next);
          this.from[next] = cur;
          this.heap.push(next);
        }
      }
    }
    return null;
  }

  /**
   * Whether a straight walk from `a` to `b` stays on the surface: sampled every
   * half cell, each step up or down at most `climb`, ending on b's floor.
   */
  walkable(a: P3, b: P3): boolean {
    const m = this.mesh;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(len / (m.cell * 0.5)));
    let y = a[1];
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const c = this.column(a[0] + dx * t, a[2] + dz * t);
      if (c < 0) return false;
      let best = Infinity;
      let by = y;
      for (let k = this.start[c]!; k < this.start[c + 1]!; k += 1) {
        const d = Math.abs(m.heights[k]! - y);
        if (d < best) {
          best = d;
          by = m.heights[k]!;
        }
      }
      if (best > m.agent.climb) return false;
      y = by;
    }
    return Math.abs(y - b[1]) <= m.agent.climb;
  }

  /**
   * A route from one point to another as corners to walk between: A* over the
   * floors, then straightened (each corner the farthest one still in a straight
   * walk). `drop[i]` marks a corner reached by dropping off a ledge (the corner
   * before it is the ledge). Null when either point is off the surface or
   * there's no way through.
   */
  findRoute(from: P3, to: P3): { points: [number, number, number][]; drop: boolean[] } | null {
    const a = this.nearest(from[0], from[1], from[2]);
    const b = this.nearest(to[0], to[1], to[2]);
    const floors = this.floorPath(a, b);
    if (!floors) return null;
    const points = floors.map((k) => this.position(k));
    const isDrop = floors.map((k, i) => i > 0 && this.mesh.heights[floors[i - 1]!]! - this.mesh.heights[k]! > this.mesh.agent.climb);
    const out: [number, number, number][] = [[from[0], points[0]![1], from[2]]];
    const drop: boolean[] = [false];
    let i = 0;
    while (i < points.length - 1) {
      let j = i + 1;
      if (!isDrop[j]) {
        let k = j + 1;
        while (k < points.length && !isDrop[k] && this.walkable(out[out.length - 1]!, points[k]!)) {
          j = k;
          k += 1;
        }
      }
      out.push(points[j]!);
      drop.push(isDrop[j]!);
      i = j;
    }
    // End exactly at the goal when it stands on the last floor.
    const last = out[out.length - 1]!;
    if (Math.hypot(to[0] - last[0], to[2] - last[2]) <= this.mesh.cell * 2 && this.floorAt(to[0], to[1], to[2]) === b) {
      out[out.length - 1] = [to[0], last[1], to[2]];
    }
    return { points: out, drop };
  }

  /** The corners of {@link findRoute}, or null. */
  findPath(from: P3, to: P3): [number, number, number][] | null {
    return this.findRoute(from, to)?.points ?? null;
  }
}
