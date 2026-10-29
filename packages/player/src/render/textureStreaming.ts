/**
 * Texture streaming (AAA_FIDELITY_ROADMAP.md F1b): which mip of each map is
 * resident on the GPU, from what the frame asked for, under a budget.
 *
 * - **Feedback.** Every few frames a small pass (`FEEDBACK_WGSL`) draws the
 *   scene at a quarter of its size and, for each pixel, records the finest mip
 *   its material's maps were sampled at: the UV footprint's log₂ in texels of
 *   a 1×1 map, kept per material by an atomic minimum in a storage buffer and
 *   read back without waiting. A map of `size` texels wants
 *   `footprint + log₂(size)`; one no pixel saw wants nothing.
 * - **The plan.** Each map is made resident at the level it wants, bounded by
 *   what it has; while the total is over the budget, the map costing the most
 *   steps down a level. A map the frame stopped seeing keeps what it has for a
 *   while, then steps down toward a coarse floor, so turning round doesn't
 *   stream it all again.
 * - **Residency** is real memory: a map resident at level `l` is a texture of
 *   its size over 2^l with only those levels, made again when the level
 *   changes. UVs are relative, so sampling it is unchanged.
 *
 * Pure apart from the WGSL: the renderer owns the textures and the passes.
 */

/** The most materials the feedback distinguishes in a frame. */
export const FEEDBACK_SLOTS = 4096;
/** The feedback's footprint, fixed point: (log₂ + {@link FOOTPRINT_BIAS}) × {@link FOOTPRINT_STEPS}. */
export const FOOTPRINT_BIAS = 24;
export const FOOTPRINT_STEPS = 8;
/** What a slot no pixel wrote holds. */
export const FEEDBACK_NONE = 0xffffffff;
/** Feedback rounds a map unseen keeps its level for, before stepping down. */
export const UNSEEN_ROUNDS = 8;
/** The coarsest a streamed map is held at: its largest side at least this many texels. */
export const FLOOR_TEXELS = 64;

/** The texture budgets per quality level, in MB. */
export const TEXTURE_BUDGET_MB = { low: 128, medium: 256, high: 512, epic: 1024 } as const;

/** A level's bytes for an RGBA8 map of `width × height` resident from `level` down: that level and all below. */
export function residentBytes(width: number, height: number, level: number): number {
  let w = Math.max(1, width >> level);
  let h = Math.max(1, height >> level);
  let total = 0;
  for (;;) {
    total += w * h * 4;
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return total;
}

/** A map's coarsest level: the top level its largest side has. */
export function topLevel(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(1, width, height)));
}

/** The level whose largest side is at least {@link FLOOR_TEXELS} (or the map's own, if smaller). */
export function floorLevel(width: number, height: number): number {
  return Math.max(0, topLevel(width, height) - Math.floor(Math.log2(FLOOR_TEXELS)));
}

/** A fixed-point footprint back to its log₂, or null for none. */
export function footprintLog2(fixed: number): number | null {
  return fixed === FEEDBACK_NONE ? null : fixed / FOOTPRINT_STEPS - FOOTPRINT_BIAS;
}

/** The level a map of `width × height` wants for a footprint (log₂ of a 1×1 map's texels a pixel). */
export function wantedLevel(width: number, height: number, footprint: number): number {
  const level = Math.floor(footprint + Math.log2(Math.max(1, width, height)));
  return Math.max(0, Math.min(topLevel(width, height), level));
}

interface Entry {
  readonly width: number;
  readonly height: number;
  /** The level resident now. */
  level: number;
  /** The level the last feedback asked for, or null when no pixel saw it. */
  wanted: number | null;
  unseen: number;
}

/** What residency looks like (for the profiler). */
export interface StreamingStats {
  readonly budgetMB: number;
  readonly residentMB: number;
  /** What every map at the level it wants would take. */
  readonly wantedMB: number;
  readonly maps: number;
  /** Maps held coarser than they want (by the budget). */
  readonly limited: number;
}

/** The residency plan; see the module comment. Maps are keyed by any object (the decoded texture). */
export class TextureStreamer {
  private readonly entries = new Map<object, Entry>();

  constructor(public budgetBytes: number) {}

  /** Start streaming a map: resident at its floor until feedback asks for more. */
  register(key: object, width: number, height: number): number {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { width, height, level: floorLevel(width, height), wanted: null, unseen: 0 };
      this.entries.set(key, entry);
    }
    return entry.level;
  }

  /** The level a map is resident at (0 for one not streamed). */
  levelOf(key: object): number {
    return this.entries.get(key)?.level ?? 0;
  }

  /** A round of feedback: the footprint (log₂) each map's material was sampled at, absent for none seen. */
  observe(footprints: ReadonlyMap<object, number>): void {
    for (const [key, entry] of this.entries) {
      const footprint = footprints.get(key);
      if (footprint === undefined) {
        entry.unseen += 1;
        if (entry.unseen > UNSEEN_ROUNDS) entry.wanted = Math.max(entry.wanted ?? entry.level, floorLevel(entry.width, entry.height));
      } else {
        entry.unseen = 0;
        entry.wanted = wantedLevel(entry.width, entry.height, footprint);
      }
    }
  }

  /**
   * Fit the residency to the budget: each map at the level it wants (or holds,
   * unseen), then the costliest stepped down until the total fits. Returns the
   * maps whose level changed, with the new level.
   */
  plan(): Map<object, number> {
    const target = new Map<object, number>();
    let total = 0;
    for (const [key, e] of this.entries) {
      const level = e.wanted ?? e.level;
      target.set(key, level);
      total += residentBytes(e.width, e.height, level);
    }
    while (total > this.budgetBytes) {
      let worst: object | null = null;
      let worstBytes = 0;
      for (const [key, level] of target) {
        const e = this.entries.get(key)!;
        if (level >= topLevel(e.width, e.height)) continue;
        const bytes = residentBytes(e.width, e.height, level);
        if (bytes > worstBytes) {
          worstBytes = bytes;
          worst = key;
        }
      }
      if (!worst) break;
      const e = this.entries.get(worst)!;
      const level = target.get(worst)! + 1;
      total += residentBytes(e.width, e.height, level) - worstBytes;
      target.set(worst, level);
    }
    const changed = new Map<object, number>();
    for (const [key, level] of target) {
      const e = this.entries.get(key)!;
      if (level !== e.level) {
        e.level = level;
        changed.set(key, level);
      }
    }
    return changed;
  }

  /** Stop streaming a map. */
  forget(key: object): void {
    this.entries.delete(key);
  }

  stats(): StreamingStats {
    let resident = 0;
    let wanted = 0;
    let limited = 0;
    for (const e of this.entries.values()) {
      resident += residentBytes(e.width, e.height, e.level);
      const want = e.wanted ?? e.level;
      wanted += residentBytes(e.width, e.height, want);
      if (e.level > want) limited += 1;
    }
    const mb = (b: number) => b / (1024 * 1024);
    return { budgetMB: mb(this.budgetBytes), residentMB: mb(resident), wantedMB: mb(wanted), maps: this.entries.size, limited };
  }
}

/**
 * The feedback pass's WGSL: the scene's vertices through each copy's transform
 * (the instance buffer), and per pixel the finest footprint of its material's
 * UVs, atomically kept per slot. Binding 0 the draw's slot (x), with a
 * dynamic offset; 1 the transforms (a batch's copies by their instance index,
 * as the scene draws them); 2 the slots. `scale` is how much smaller than the frame the pass renders.
 */
export function feedbackWgsl(scale: number): string {
  return /* wgsl */ `
struct Draw {
  info: vec4<u32>, // x = the material's slot
};
struct InstanceXf {
  mvp: mat4x4<f32>,
  lightMvp: mat4x4<f32>,
  model: mat4x4<f32>,
  nrm: mat3x3<f32>,
};
@group(0) @binding(0) var<uniform> draw: Draw;
@group(0) @binding(1) var<storage, read> xf: array<InstanceXf>;
@group(0) @binding(2) var<storage, read_write> wanted: array<atomic<u32>>;
struct Out {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@location(0) position: vec3<f32>, @location(2) uv: vec2<f32>, @builtin(instance_index) instance: u32) -> Out {
  var out: Out;
  out.pos = xf[instance].mvp * vec4<f32>(position, 1.0);
  out.uv = uv;
  return out;
}
@fragment
fn fs(in: Out) {
  // The footprint in a 1×1 map's texels: the larger derivative's length, as the hardware picks a mip, at the
  // frame's own size (the pass renders ${scale}× smaller, so its derivatives are ${scale}× longer).
  let d = max(dot(dpdx(in.uv), dpdx(in.uv)), dot(dpdy(in.uv), dpdy(in.uv)));
  let footprint = 0.5 * log2(max(d, 1e-20)) - log2(${scale.toFixed(1)});
  let fixed = u32(clamp((footprint + ${FOOTPRINT_BIAS}.0) * ${FOOTPRINT_STEPS}.0, 0.0, 4294967040.0));
  atomicMin(&wanted[min(draw.info.x, ${FEEDBACK_SLOTS - 1}u)], fixed);
}
`;
}
