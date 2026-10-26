/**
 * Virtual shadow maps for the sun on the AAA tier (AAA_FIDELITY_ROADMAP.md
 * F2b): shadow detail that holds at every distance, where the four cascades
 * (F2a) spread a fixed number of texels ever thinner.
 *
 * - **The virtual map.** A clipmap of {@link VSM_LEVELS} levels round the
 *   camera, each a virtual 16384² map ({@link VSM_PAGES}² pages of
 *   {@link VSM_PAGE}² texels) whose texels are twice the size of the level
 *   below's: 2 mm at level 0, a few centimetres at the last. A page always
 *   holds the same square of the sun's view (its light-space grid is fixed, and
 *   the depth range round the camera moves only in large steps), so a page
 *   drawn once stays good as the camera moves.
 * - **Marking.** A pass over the depth prepass finds, for every pixel, the
 *   finest level whose texels are no larger than the pixel (so the map never
 *   has fewer texels than the screen has pixels there) and marks the pages its
 *   filter reaches at that level and two above, for wide penumbrae.
 * - **The pool.** Marks are read back a frame or two late and the CPU (this
 *   file's {@link VirtualPagePool}) gives each marked page a page of a
 *   physical depth pool, evicting the least recently needed when it is full.
 *   A page is drawn when it is first given out, when the light, the still
 *   scene or the depth range changes, and while something that moves stands
 *   in it (or did when it was last drawn), at most {@link VSM_PAGES_PER_FRAME}
 *   a frame, finest first. The rest of the frame keeps what it drew before.
 * - **Sampling.** A full-screen pass after the page draws takes each opaque
 *   pixel's shadow from the finest resident page round it, with PCSS (a
 *   blocker search, then a filter as wide as the sun's size makes the
 *   penumbra), at its level or, for a penumbra wider than the level's filter
 *   reaches, two levels up. Where no page is resident yet it writes −1 and the
 *   scene shader falls back to the cascades; see-through surfaces, which the
 *   prepass doesn't hold, always do.
 *
 * Depth is WebGPU's, 0 nearest the sun.
 */

/** Levels in the clipmap. */
export const VSM_LEVELS = 6;
/** Pages along a level's side (its virtual map is VSM_PAGES × VSM_PAGE texels square: 16384). */
export const VSM_PAGES = 128;
/** Texels along a page's side. */
export const VSM_PAGE = 128;
/** A level-0 texel's edge, metres (each level doubles it). */
export const VSM_TEXEL0 = 0.002;
/** How far, metres, the depth range reaches toward and away from the sun round the camera. */
export const VSM_DEPTH_REACH = 1000;
/** Pages drawn a frame at most; the rest wait (the cascades stand in). */
export const VSM_PAGES_PER_FRAME = 48;
/** The widest the filter reaches, in texels of its level. */
export const VSM_FILTER_TEXELS = 12;
/** Floats in the passes' uniforms. */
export const VSM_UNIFORM_FLOATS = 64;
/** Words in the marks (a bit a virtual page). */
export const VSM_MARK_WORDS = (VSM_LEVELS * VSM_PAGES * VSM_PAGES) / 32;

type Vec3 = readonly [number, number, number];

/** A level's texel edge, metres. */
export function vsmTexel(level: number): number {
  return VSM_TEXEL0 * 2 ** level;
}

/** A level's page edge, metres. */
export function vsmPageSize(level: number): number {
  return vsmTexel(level) * VSM_PAGE;
}

/** The sun's frame: x and y across its view, z toward it. */
export function vsmLightBasis(toLight: Vec3): { x: [number, number, number]; y: [number, number, number]; z: [number, number, number] } {
  const lz = Math.hypot(toLight[0], toLight[1], toLight[2]) || 1;
  const z: [number, number, number] = [toLight[0] / lz, toLight[1] / lz, toLight[2] / lz];
  const up: Vec3 = Math.abs(z[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];
  // x = up × z, y = z × x.
  let x: [number, number, number] = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
  const lx = Math.hypot(x[0], x[1], x[2]) || 1;
  x = [x[0] / lx, x[1] / lx, x[2] / lx];
  const y: [number, number, number] = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return { x, y, z };
}

/** The depth range's middle along the sun: the camera's, in steps of a quarter of the reach (so it rarely moves). */
export function vsmDepthCentre(eye: Vec3, basis: ReturnType<typeof vsmLightBasis>): number {
  const step = VSM_DEPTH_REACH / 4;
  return Math.round((eye[0] * basis.z[0] + eye[1] * basis.z[1] + eye[2] * basis.z[2]) / step) * step;
}

/** Each level's window: the first page (x, y) of the VSM_PAGES² it holds, centred on the camera. */
export function vsmWindows(eye: Vec3, basis: ReturnType<typeof vsmLightBasis>): [number, number][] {
  const lx = eye[0] * basis.x[0] + eye[1] * basis.x[1] + eye[2] * basis.x[2];
  const ly = eye[0] * basis.y[0] + eye[1] * basis.y[1] + eye[2] * basis.y[2];
  return Array.from({ length: VSM_LEVELS }, (_, k) => {
    const size = vsmPageSize(k);
    return [Math.floor(lx / size) - VSM_PAGES / 2, Math.floor(ly / size) - VSM_PAGES / 2];
  });
}

/**
 * A page's world → clip (column-major): its square of the sun's view to −1..1
 * across, the depth range round `centre` to 0 (sunward) .. 1.
 */
export function vsmPageViewProj(level: number, gx: number, gy: number, basis: ReturnType<typeof vsmLightBasis>, centre: number): Float32Array {
  const size = vsmPageSize(level);
  const cx = (gx + 0.5) * size;
  const cy = (gy + 0.5) * size;
  const s = 2 / size;
  const d = 1 / (2 * VSM_DEPTH_REACH);
  const { x, y, z } = basis;
  // Rows: x·s − cx·s, y·s − cy·s, (centre + reach − z·p)·d, 1.
  return Float32Array.from([
    x[0] * s, y[0] * s, -z[0] * d, 0,
    x[1] * s, y[1] * s, -z[1] * d, 0,
    x[2] * s, y[2] * s, -z[2] * d, 0,
    -cx * s, -cy * s, (centre + VSM_DEPTH_REACH) * d, 1,
  ]);
}

/** A page of a level: its level and page coordinates in the sun's grid. */
export interface VirtualPage {
  readonly level: number;
  readonly gx: number;
  readonly gy: number;
}

/** A page to draw this frame: where it is, and the physical page it goes in. */
export interface PageDraw extends VirtualPage {
  readonly physical: number;
}

const keyOf = (level: number, gx: number, gy: number) => `${level}:${gx}:${gy}`;

/**
 * The CPU side of the pool: which virtual page each physical page holds, and
 * whether its map is still good. Pure, so it is tested on its own.
 */
export class VirtualPagePool {
  private readonly entries = new Map<string, { page: VirtualPage; physical: number; needed: number; valid: boolean; mover: boolean }>();
  private readonly free: number[] = [];
  private frame = 0;
  private key: string | null = null;
  /** Whether the table needs building again (a page was given out, dropped or drawn, or a window moved). */
  changed = true;

  constructor(readonly capacity: number) {
    for (let i = capacity - 1; i >= 0; i -= 1) this.free.push(i);
  }

  /** Physical pages in use. */
  get used(): number {
    return this.entries.size;
  }

  /**
   * A frame: `needed` the pages the marks asked for, `key` what the maps were
   * drawn for (the light, the depth range, the still scene; a change makes
   * every page draw again), `moving(page)` whether something that moves stands
   * in a page now. Returns the pages to draw, at most `budget`, finest first.
   */
  update(needed: readonly VirtualPage[], key: string, moving: (page: VirtualPage) => boolean, budget = VSM_PAGES_PER_FRAME): PageDraw[] {
    this.frame += 1;
    if (key !== this.key) {
      for (const e of this.entries.values()) e.valid = false;
      this.key = key;
      this.changed = true;
    }
    const want: { e: { page: VirtualPage; physical: number; needed: number; valid: boolean; mover: boolean } | null; page: VirtualPage }[] = [];
    for (const page of needed) {
      const e = this.entries.get(keyOf(page.level, page.gx, page.gy)) ?? null;
      if (e) e.needed = this.frame;
      want.push({ e, page });
    }
    // What must be drawn: pages without a physical page or whose map is stale, then those something moves in.
    const draws: { page: VirtualPage; e: { page: VirtualPage; physical: number; needed: number; valid: boolean; mover: boolean } | null; moving: boolean }[] = [];
    for (const { e, page } of want) {
      const now = moving(page);
      if (!e || !e.valid || now || e.mover) draws.push({ page, e, moving: now });
    }
    draws.sort((a, b) => Number(a.e !== null && a.e.valid) - Number(b.e !== null && b.e.valid) || a.page.level - b.page.level);
    const out: PageDraw[] = [];
    for (const d of draws) {
      if (out.length >= budget) break;
      let e = d.e;
      if (!e) {
        const physical = this.take();
        if (physical === null) continue;
        e = { page: d.page, physical, needed: this.frame, valid: false, mover: false };
        this.entries.set(keyOf(d.page.level, d.page.gx, d.page.gy), e);
      }
      e.valid = true;
      e.mover = d.moving;
      out.push({ ...d.page, physical: e.physical });
      this.changed = true;
    }
    return out;
  }

  /** A free physical page, or the least recently needed one not needed this frame (null: the pool is full of this frame's). */
  private take(): number | null {
    const free = this.free.pop();
    if (free !== undefined) return free;
    let oldest: string | null = null;
    let at = Infinity;
    for (const [k, e] of this.entries) {
      if (e.needed < this.frame && e.needed < at) {
        at = e.needed;
        oldest = k;
      }
    }
    if (oldest === null) return null;
    const e = this.entries.get(oldest)!;
    this.entries.delete(oldest);
    this.changed = true;
    return e.physical;
  }

  /** The physical page holding a good map of `page`, or null. */
  resident(page: VirtualPage): number | null {
    const e = this.entries.get(keyOf(page.level, page.gx, page.gy));
    return e && e.valid ? e.physical : null;
  }

  /**
   * The page table for the levels' `windows`: per level, VSM_PAGES² words at
   * the page's place in its window wrapped (x mod VSM_PAGES, y mod VSM_PAGES),
   * each the physical page + 1 holding it, or 0.
   */
  table(windows: readonly (readonly [number, number])[], out: Uint32Array = new Uint32Array(VSM_LEVELS * VSM_PAGES * VSM_PAGES)): Uint32Array {
    out.fill(0);
    for (const e of this.entries.values()) {
      if (!e.valid) continue;
      const { level, gx, gy } = e.page;
      const w = windows[level];
      if (!w || gx < w[0] || gy < w[1] || gx >= w[0] + VSM_PAGES || gy >= w[1] + VSM_PAGES) continue;
      out[level * VSM_PAGES * VSM_PAGES + wrap(gy) * VSM_PAGES + wrap(gx)] = e.physical + 1;
    }
    this.changed = false;
    return out;
  }

  /** Forget every page (the pool was remade). */
  clear(): void {
    this.entries.clear();
    this.free.length = 0;
    for (let i = this.capacity - 1; i >= 0; i -= 1) this.free.push(i);
    this.key = null;
    this.changed = true;
  }
}

/** A page coordinate's slot in its level's table. */
export function wrap(g: number): number {
  return ((g % VSM_PAGES) + VSM_PAGES) % VSM_PAGES;
}

/** The pages a frame's marks name, each slot read back to the page it stands for in the window it was marked under. */
export function markedPages(marks: Uint32Array, windows: readonly (readonly [number, number])[]): VirtualPage[] {
  const out: VirtualPage[] = [];
  const perLevel = VSM_PAGES * VSM_PAGES;
  for (let word = 0; word < marks.length; word += 1) {
    let bits = marks[word]!;
    while (bits !== 0) {
      const b = 31 - Math.clz32(bits);
      bits &= ~(1 << b);
      const index = word * 32 + b;
      const level = Math.floor(index / perLevel);
      const slot = index % perLevel;
      const sx = slot % VSM_PAGES;
      const sy = Math.floor(slot / VSM_PAGES);
      const w = windows[level]!;
      // The page in the window whose wrapped place is this slot.
      out.push({ level, gx: w[0] + wrap(sx - w[0]), gy: w[1] + wrap(sy - w[1]) });
    }
  }
  return out;
}

/** Where a physical page lies in a pool `poolSize` texels square: its corner, in texels. */
export function physicalCorner(physical: number, poolSize: number): [number, number] {
  const across = Math.floor(poolSize / VSM_PAGE);
  return [(physical % across) * VSM_PAGE, Math.floor(physical / across) * VSM_PAGE];
}

/**
 * The passes' uniforms: clip → world as drawn, the camera, the sun's frame and
 * depth range, the screen's pixel size at unit depth, each level's window, and
 * the pool.
 */
export function vsmUniforms(options: {
  readonly invViewProj: ArrayLike<number>;
  readonly eye: Vec3;
  readonly basis: ReturnType<typeof vsmLightBasis>;
  readonly centre: number;
  readonly windows: readonly (readonly [number, number])[];
  readonly pixelAngle: number;
  readonly width: number;
  readonly height: number;
  readonly poolSize: number;
  readonly softness: number;
  readonly strength: number;
  readonly view: ArrayLike<number>;
}, out: Float32Array<ArrayBuffer> = new Float32Array(VSM_UNIFORM_FLOATS)): Float32Array<ArrayBuffer> {
  out.set(options.invViewProj, 0);
  out.set([...options.eye, options.pixelAngle], 16);
  out.set([...options.basis.x, options.centre], 20);
  out.set([...options.basis.y, VSM_DEPTH_REACH], 24);
  out.set([...options.basis.z, VSM_TEXEL0], 28);
  options.windows.forEach((w, k) => out.set(w, 32 + k * 2));
  out.set([options.width, options.height, options.poolSize, options.softness], 44);
  out.set([options.strength, VSM_LEVELS, 0, 0], 48);
  // The view's third row: a point's view depth is −(row · p + w).
  out.set([options.view[2]!, options.view[6]!, options.view[10]!, options.view[14]!], 52);
  return out;
}

const SHARED = (multisampled: boolean) => /* wgsl */ `
struct Vsm {
  invViewProj: mat4x4<f32>,
  eye: vec4<f32>,      // w: a pixel's size at unit depth
  axisX: vec4<f32>,    // w: the depth range's middle along the sun
  axisY: vec4<f32>,    // w: the depth range's reach either way
  axisZ: vec4<f32>,    // toward the sun; w: a level-0 texel
  windows: array<vec4<f32>, 3>, // each level's first page, two levels a vec4
  screen: vec4<f32>,   // width, height, the pool's size, the sun's softness
  info: vec4<f32>,     // strength, levels
  viewRow: vec4<f32>,  // the view's third row
};
@group(0) @binding(0) var<uniform> vsm: Vsm;
@group(0) @binding(1) var depth: ${multisampled ? "texture_depth_multisampled_2d" : "texture_depth_2d"};

fn vsmWindow(k: i32) -> vec2<f32> {
  let w = vsm.windows[k / 2];
  return select(w.xy, w.zw, (k & 1) == 1);
}
fn vsmTexel(k: i32) -> f32 { return vsm.axisZ.w * exp2(f32(k)); }
fn vsmLight(p: vec3<f32>) -> vec3<f32> { return vec3<f32>(dot(p, vsm.axisX.xyz), dot(p, vsm.axisY.xyz), dot(p, vsm.axisZ.xyz)); }
// A light-space point's page at level k (x, y), and whether the level's window holds it.
fn vsmPageOf(l: vec2<f32>, k: i32) -> vec3<f32> {
  let g = floor(l / (vsmTexel(k) * ${VSM_PAGE}.0));
  let w = vsmWindow(k);
  let inside = all(g >= w) && all(g < w + vec2<f32>(${VSM_PAGES}.0));
  return vec3<f32>(g, select(0.0, 1.0, inside));
}
// The finest level whose texels are no larger than the pixel at view depth d.
fn vsmLevel(d: f32) -> i32 {
  let footprint = d * vsm.eye.w;
  return clamp(i32(ceil(log2(max(footprint / vsm.axisZ.w, 1e-6)))), 0, i32(vsm.info.y) - 1);
}
// The world point at a pixel, and its view depth (w).
fn vsmWorldAt(p: vec2<i32>) -> vec4<f32> {
  let z = textureLoad(depth, p, 0);
  let ndc = vec2<f32>((f32(p.x) + 0.5) / vsm.screen.x * 2.0 - 1.0, 1.0 - (f32(p.y) + 0.5) / vsm.screen.y * 2.0);
  let w = vsm.invViewProj * vec4<f32>(ndc, z, 1.0);
  let world = w.xyz / w.w;
  return vec4<f32>(world, -(dot(vsm.viewRow.xyz, world) + vsm.viewRow.w));
}
`;

/** The marking pass: a thread a pixel, a bit a page its filter reaches, at its level and two above. */
export function vsmMarkWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var<storage, read_write> marks: array<atomic<u32>>;

fn mark(l: vec2<f32>, k: i32) {
  let g = vsmPageOf(l, k);
  if (g.z < 0.5) { return; }
  let sx = u32((i32(g.x) % ${VSM_PAGES} + ${VSM_PAGES}) % ${VSM_PAGES});
  let sy = u32((i32(g.y) % ${VSM_PAGES} + ${VSM_PAGES}) % ${VSM_PAGES});
  let bit = u32(k) * ${VSM_PAGES * VSM_PAGES}u + sy * ${VSM_PAGES}u + sx;
  atomicOr(&marks[bit / 32u], 1u << (bit % 32u));
}
fn markAround(l: vec2<f32>, k: i32) {
  let r = vsmTexel(k) * ${VSM_FILTER_TEXELS + 2}.0;
  mark(l + vec2<f32>(-r, -r), k);
  mark(l + vec2<f32>(r, -r), k);
  mark(l + vec2<f32>(-r, r), k);
  mark(l + vec2<f32>(r, r), k);
}

@compute @workgroup_size(8, 8)
fn markPages(@builtin(global_invocation_id) id: vec3<u32>) {
  let p = vec2<i32>(id.xy);
  if (f32(p.x) >= vsm.screen.x || f32(p.y) >= vsm.screen.y) { return; }
  if (textureLoad(depth, p, 0) >= 1.0) { return; }
  let at = vsmWorldAt(p);
  let l = vsmLight(at.xyz).xy;
  let levels = i32(vsm.info.y);
  var k = vsmLevel(at.w);
  // Up to the first level whose window holds the point.
  loop {
    if (k >= levels - 1 || vsmPageOf(l, k).z > 0.5) { break; }
    k += 1;
  }
  markAround(l, k);
  if (k + 2 < levels) { markAround(l, k + 2); }
}
`;
}

/** The sampling pass's WGSL: r the sun's light through the virtual map (1 lit), or −1 where no page is resident. */
export function vsmResolveWgsl(multisampled: boolean): string {
  return /* wgsl */ `${SHARED(multisampled)}
@group(0) @binding(2) var<storage, read> pageTable: array<u32>;
@group(0) @binding(3) var pool: texture_depth_2d;
@group(0) @binding(4) var poolSamp: sampler_comparison;
@group(0) @binding(5) var gbuffer: texture_2d<f32>;

const DISK = array<vec2<f32>, 12>(
  vec2<f32>(-0.326, -0.406), vec2<f32>(-0.840, -0.074), vec2<f32>(-0.696, 0.457), vec2<f32>(-0.203, 0.621),
  vec2<f32>(0.962, -0.195), vec2<f32>(0.473, -0.480), vec2<f32>(0.519, 0.767), vec2<f32>(0.185, -0.893),
  vec2<f32>(0.507, 0.064), vec2<f32>(0.896, 0.412), vec2<f32>(-0.322, -0.933), vec2<f32>(-0.792, -0.598));

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn octDecode(e: vec2<f32>) -> vec3<f32> {
  var n = vec3<f32>(e.x, e.y, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x = n.x + select(t, -t, n.x >= 0.0);
  n.y = n.y + select(t, -t, n.y >= 0.0);
  return normalize(n);
}

// The physical page holding a light-space point's page at level k (+1), or 0.
fn vsmPhysical(l: vec2<f32>, k: i32) -> u32 {
  let g = vsmPageOf(l, k);
  if (g.z < 0.5) { return 0u; }
  let sx = u32((i32(g.x) % ${VSM_PAGES} + ${VSM_PAGES}) % ${VSM_PAGES});
  let sy = u32((i32(g.y) % ${VSM_PAGES} + ${VSM_PAGES}) % ${VSM_PAGES});
  return pageTable[u32(k) * ${VSM_PAGES * VSM_PAGES}u + sy * ${VSM_PAGES}u + sx];
}

// Where a light-space point lies in the pool at level k (texels), or x < 0 where its page isn't resident.
fn vsmPoolAt(l: vec2<f32>, k: i32) -> vec2<f32> {
  let phys = vsmPhysical(l, k);
  if (phys == 0u) { return vec2<f32>(-1.0); }
  let size = vsmTexel(k) * ${VSM_PAGE}.0;
  let g = floor(l / size);
  // Within the page: x across, y down (row 0 is the page's top, as it was drawn).
  let f = (l - g * size) / size;
  let inPage = clamp(vec2<f32>(f.x, 1.0 - f.y) * ${VSM_PAGE}.0, vec2<f32>(0.5), vec2<f32>(${VSM_PAGE}.0 - 0.5));
  let across = u32(vsm.screen.z) / ${VSM_PAGE}u;
  let corner = vec2<f32>(f32((phys - 1u) % across), f32((phys - 1u) / across)) * ${VSM_PAGE}.0;
  return corner + inPage;
}

// The depth a light-space point (with its depth along the sun) has in a page's map.
fn vsmDepth(lz: f32) -> f32 { return (vsm.axisX.w + vsm.axisY.w - lz) / (2.0 * vsm.axisY.w); }

// PCSS at level k round light-space point l of depth z: −1 where a tap's page isn't resident; else the light,
// and in .y the penumbra's width in metres the blockers ask for.
fn vsmPcss(l: vec2<f32>, z: f32, k: i32, spin: vec2<f32>) -> vec2<f32> {
  let texel = vsmTexel(k);
  let inv = 1.0 / vsm.screen.z;
  let reach = ${VSM_FILTER_TEXELS}.0;
  var blockers = 0.0;
  var count = 0.0;
  for (var i = 0; i < 12; i += 1) {
    let d = DISK[i];
    let o = vec2<f32>(d.x * spin.x - d.y * spin.y, d.x * spin.y + d.y * spin.x) * reach * texel;
    let at = vsmPoolAt(l + o, k);
    if (at.x < 0.0) { return vec2<f32>(-1.0, 0.0); }
    let b = textureLoad(pool, vec2<i32>(at), 0);
    if (b < z) { blockers = blockers + b; count = count + 1.0; }
  }
  if (count < 0.5) { return vec2<f32>(1.0, 0.0); }
  // How far above the point the blockers stand, metres, times the sun's size: the penumbra.
  let above = (z - blockers / count) * 2.0 * vsm.axisY.w;
  let penumbra = above * vsm.screen.w;
  let width = clamp(penumbra / texel, 1.0, reach);
  var lit = 0.0;
  for (var i = 0; i < 12; i += 1) {
    let d = DISK[i];
    let o = vec2<f32>(d.x * spin.x - d.y * spin.y, d.x * spin.y + d.y * spin.x) * width * texel;
    let at = vsmPoolAt(l + o, k);
    if (at.x < 0.0) { return vec2<f32>(-1.0, 0.0); }
    lit = lit + textureSampleCompareLevel(pool, poolSamp, at * inv, z);
  }
  return vec2<f32>(lit / 12.0, penumbra);
}

@fragment
fn resolve(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
  let p = vec2<i32>(frag.xy);
  if (textureLoad(depth, p, 0) >= 1.0) { return vec4<f32>(1.0, 0.0, 0.0, 1.0); }
  let at = vsmWorldAt(p);
  let N = octDecode(textureLoad(gbuffer, p, 0).xy);
  let L = vsm.axisZ.xyz;
  let levels = i32(vsm.info.y);
  let a = 6.2831853 * fract(52.9829189 * fract(dot(frag.xy, vec2<f32>(0.06711056, 0.00583715))));
  let spin = vec2<f32>(cos(a), sin(a));
  let cosL = clamp(abs(dot(N, L)), 0.05, 1.0);
  // Facing away from the sun: in its own shadow.
  if (dot(N, L) <= 0.0) { return vec4<f32>(1.0 - vsm.info.x, 0.0, 0.0, 1.0); }
  var k = vsmLevel(at.w);
  loop {
    if (k >= levels - 1 || vsmPageOf(vsmLight(at.xyz).xy, k).z > 0.5) { break; }
    k += 1;
  }
  // From the level the pixel wants up to the first with resident pages round it.
  for (; k < levels; k += 1) {
    let texel = vsmTexel(k);
    // Off the surface toward the sun and along its normal, by a texel or more as the light grazes.
    let push = texel * (1.5 + 2.0 * min(4.0, sqrt(1.0 - cosL * cosL) / cosL));
    let q = vsmLight(at.xyz + L * push + N * texel);
    let z = vsmDepth(q.z);
    var s = vsmPcss(q.xy, z, k, spin);
    if (s.x < 0.0) { continue; }
    // A penumbra wider than this level's filter reaches: filter it two levels up, where it fits.
    if (s.y > vsmTexel(k) * ${VSM_FILTER_TEXELS}.0 && k + 2 < levels) {
      let wide = vsmPcss(q.xy, z, k + 2, spin);
      if (wide.x >= 0.0) { s = wide; }
    }
    return vec4<f32>(1.0 - vsm.info.x * (1.0 - s.x), 0.0, 0.0, 1.0);
  }
  return vec4<f32>(-1.0, 0.0, 0.0, 1.0);
}
`;
}

const spheres = new WeakMap<object, readonly [number, number, number, number]>();

/** The bounding sphere (centre, radius) of a primitive's positions, or a mesh's, in its own space; made once. */
export function localSphere(owner: { readonly positions: ArrayLike<number> } | { readonly primitives: readonly { readonly positions: ArrayLike<number> }[] }): readonly [number, number, number, number] {
  let s = spheres.get(owner);
  if (s) return s;
  const lists = "primitives" in owner ? owner.primitives.map((p) => p.positions) : [owner.positions];
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const positions of lists) {
    for (let i = 0; i + 2 < positions.length; i += 3) {
      for (let a = 0; a < 3; a += 1) {
        lo[a] = Math.min(lo[a]!, positions[i + a]!);
        hi[a] = Math.max(hi[a]!, positions[i + a]!);
      }
    }
  }
  if (!Number.isFinite(lo[0]!)) s = [0, 0, 0, 0];
  else {
    const c = [0, 1, 2].map((a) => (lo[a]! + hi[a]!) / 2);
    s = [c[0]!, c[1]!, c[2]!, Math.hypot(hi[0]! - c[0]!, hi[1]! - c[1]!, hi[2]! - c[2]!)];
  }
  spheres.set(owner, s);
  return s;
}

/** A local sphere through a model matrix (its radius by the largest axis scale). */
export function worldSphere(local: readonly [number, number, number, number], m: ArrayLike<number>): [number, number, number, number] {
  const [x, y, z, r] = local;
  const scale = Math.max(Math.hypot(m[0]!, m[1]!, m[2]!), Math.hypot(m[4]!, m[5]!, m[6]!), Math.hypot(m[8]!, m[9]!, m[10]!));
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!, r * scale];
}

/** Whether a world sphere's shadow can fall in a page: its disc across the sun's view against the page's square. */
export function pageTouches(page: VirtualPage, basis: ReturnType<typeof vsmLightBasis>, sphere: readonly [number, number, number, number]): boolean {
  const size = vsmPageSize(page.level);
  const lx = sphere[0] * basis.x[0] + sphere[1] * basis.x[1] + sphere[2] * basis.x[2];
  const ly = sphere[0] * basis.y[0] + sphere[1] * basis.y[1] + sphere[2] * basis.y[2];
  const r = sphere[3];
  return lx + r >= page.gx * size && lx - r <= (page.gx + 1) * size && ly + r >= page.gy * size && ly - r <= (page.gy + 1) * size;
}
