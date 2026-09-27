/**
 * The playtest profiler (ENGINE_ROADMAP.md, Phase 5): where each frame's time
 * goes, measured on the host, over the last second or so of frames.
 *
 * Sections (milliseconds of main-thread time per frame):
 * - `cart`: the engine's tick — the cart's Lua, its 2D drawing and the chip
 *   sound synthesis all run inside it, and can't be told apart from outside.
 * - `runtime`: physics, spawning, animation and timelines (the runtime channel).
 * - `audio`: handing the frame's samples to Web Audio.
 * - `net`: the multiplayer session's work before and after the tick.
 * - `render`: presenting the frame, everything included; of it, `shadow` (the
 *   shadow map), `sky` and `scene` (drawing the 3D scene — on the GPU backends,
 *   submitting it and compositing the newest readback) are also shown alone.
 *
 * A frame is one console tick; the render that follows ticks counts toward the
 * last of them. Pure apart from the clock the caller reads.
 */

export const PROFILE_SECTIONS = ["cart", "runtime", "audio", "net", "render", "shadow", "sky", "scene"] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Frames the rolling window covers. */
export const PROFILE_WINDOW = 60;

/** What the 3D renderer did in its last frame. */
export interface RenderStats {
  readonly drawCalls: number;
  readonly instances: number;
  readonly triangles: number;
  /** GPU time of the scene pass, when the browser can time it (else null). */
  readonly gpuMs: number | null;
}

export interface SectionStats {
  /** Average milliseconds per frame over the window. */
  readonly avg: number;
  /** The slowest frame's. */
  readonly max: number;
}

export interface ProfileSnapshot {
  /** Frames in the window. */
  readonly frames: number;
  readonly sections: Readonly<Record<ProfileSection, SectionStats>>;
  /** All sections but the render sub-passes, per frame. */
  readonly total: SectionStats;
  /** The 3D renderer's last frame, when the cart has a 3D scene. */
  readonly render: (RenderStats & { readonly backend: string }) | null;
  readonly memory: {
    /** The engine's WebAssembly memory. */
    readonly wasm: number;
    /** The page's JavaScript heap (Chromium only; else null). */
    readonly jsHeap: number | null;
    /** The 3D scene's geometry, textures and render targets (an estimate), when it has one. */
    readonly scene: number | null;
  };
  /** Multiplayer traffic, bytes per second over the window, when the cart is online. */
  readonly net: { readonly sentPerSecond: number; readonly receivedPerSecond: number; readonly sent: number; readonly received: number } | null;
}

/** Sections that are part of `render`, not added again into the total. */
const SUB_PASSES = new Set<ProfileSection>(["shadow", "sky", "scene"]);

export class Profiler {
  private readonly samples = new Map<ProfileSection, Float64Array>(PROFILE_SECTIONS.map((s) => [s, new Float64Array(PROFILE_WINDOW)]));
  /** The slot being filled (the open frame). */
  private slot = 0;
  private filled = 0;
  /** A frame has been opened (the first nextFrame opens one, closing nothing). */
  private open = false;

  /** Add `ms` to the open frame's `section`. */
  add(section: ProfileSection, ms: number): void {
    const row = this.samples.get(section)!;
    row[this.slot] = row[this.slot]! + ms;
  }

  /** Close the open frame and start the next. */
  nextFrame(): void {
    this.slot = (this.slot + 1) % PROFILE_WINDOW;
    for (const row of this.samples.values()) row[this.slot] = 0;
    if (this.open) this.filled = Math.min(PROFILE_WINDOW - 1, this.filled + 1);
    this.open = true;
  }

  /** Averages and peaks over the closed frames in the window. */
  sections(): { frames: number; sections: Record<ProfileSection, SectionStats>; total: SectionStats } {
    const frames = this.filled;
    const sections = {} as Record<ProfileSection, SectionStats>;
    const totals = new Float64Array(PROFILE_WINDOW);
    for (const section of PROFILE_SECTIONS) {
      const row = this.samples.get(section)!;
      let sum = 0;
      let max = 0;
      for (let k = 1; k <= frames; k += 1) {
        const i = (this.slot - k + PROFILE_WINDOW) % PROFILE_WINDOW;
        const v = row[i]!;
        sum += v;
        if (v > max) max = v;
        if (!SUB_PASSES.has(section)) totals[i] = totals[i]! + v;
      }
      sections[section] = { avg: frames > 0 ? sum / frames : 0, max };
    }
    let sum = 0;
    let max = 0;
    for (let k = 1; k <= frames; k += 1) {
      const v = totals[(this.slot - k + PROFILE_WINDOW) % PROFILE_WINDOW]!;
      sum += v;
      if (v > max) max = v;
    }
    return { frames, sections, total: { avg: frames > 0 ? sum / frames : 0, max } };
  }

  reset(): void {
    for (const row of this.samples.values()) row.fill(0);
    this.slot = 0;
    this.filled = 0;
    this.open = false;
  }
}

/**
 * Bytes a 3D scene keeps on the GPU, estimated from what it draws: each mesh's
 * interleaved vertices (32 bytes: position, normal, UV) and 32-bit indices once,
 * each texture's RGBA8 pixels once, and the colour + depth targets.
 */
export function estimateSceneBytes(
  instances: readonly { readonly mesh: { readonly primitives: readonly { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> }[] }; readonly textures?: readonly ({ readonly width: number; readonly height: number } | null | undefined)[] }[],
  width: number,
  height: number,
): number {
  const meshes = new Set<object>();
  const textures = new Set<object>();
  let bytes = width * height * 8;
  for (const instance of instances) {
    if (!meshes.has(instance.mesh)) {
      meshes.add(instance.mesh);
      for (const p of instance.mesh.primitives) bytes += (p.positions.length / 3) * 32 + p.indices.length * 4;
    }
    for (const texture of instance.textures ?? []) {
      if (texture && !textures.has(texture)) {
        textures.add(texture);
        bytes += texture.width * texture.height * 4;
      }
    }
  }
  return bytes;
}
