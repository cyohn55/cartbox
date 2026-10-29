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
  /** GPU time of the frame's passes, when the browser can time it (else null). */
  readonly gpuMs: number | null;
  /** Each pass's GPU time (AAA_FIDELITY_ROADMAP.md F0c), on a renderer that times them one by one. */
  readonly passes?: readonly { readonly name: string; readonly ms: number }[];
  /** The size the 3D rendered at and its share of the frame's (F0d), when that isn't the cart's own. */
  readonly resolution?: { readonly width: number; readonly height: number; readonly scale: number };
  /** Texture streaming's residency (AAA_FIDELITY_ROADMAP.md F1b), on a renderer that streams. */
  readonly textures?: { readonly budgetMB: number; readonly residentMB: number; readonly wantedMB: number; readonly maps: number; readonly limited: number };
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
    /** The same split (EDITOR_PRO_ROADMAP.md P8): every texture map, the meshes, the targets. */
    readonly sceneParts?: SceneMemory | null;
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

/** A 3D scene's GPU memory by kind (bytes, estimated). */
export interface SceneMemory {
  readonly textures: number;
  readonly meshes: number;
  readonly targets: number;
}

/** The texture sets an instance may draw with: base colour and every other map. */
const TEXTURE_SETS = ["textures", "normalTextures", "materialTextures", "mrTextures", "occlusionTextures", "emissiveTextures", "lightmapTextures"] as const;

type TextureSet = readonly ({ readonly width: number; readonly height: number; readonly gpu?: { readonly levels: readonly { readonly data: { readonly byteLength: number } }[] } } | null | undefined)[] | undefined;

/**
 * A texture's bytes on the GPU: its block-compressed chain when it carries one
 * (F1a; DecodedTexture.gpu), else RGBA8 with its mips.
 */
export function textureMemory(texture: { readonly width: number; readonly height: number; readonly gpu?: { readonly levels: readonly { readonly data: { readonly byteLength: number } }[] } }): number {
  if (texture.gpu) return texture.gpu.levels.reduce((sum, level) => sum + level.data.byteLength, 0);
  return Math.round((texture.width * texture.height * 4 * 4) / 3);
}

/**
 * A 3D scene's GPU memory by kind (P8), for the per-device budgets: each
 * mesh's vertices and indices once (as {@link estimateSceneBytes}), each
 * texture of every map once ({@link textureMemory}: compressed, or RGBA8
 * with its mips), and the targets.
 */
export function estimateSceneMemory(
  instances: readonly ({ readonly mesh: { readonly primitives: readonly { readonly positions: ArrayLike<number>; readonly indices: ArrayLike<number> }[] } } & Partial<Record<(typeof TEXTURE_SETS)[number], TextureSet>>)[],
  width: number,
  height: number,
): SceneMemory {
  const meshes = new Set<object>();
  const textures = new Set<object>();
  let meshBytes = 0;
  let textureBytes = 0;
  for (const instance of instances) {
    if (!meshes.has(instance.mesh)) {
      meshes.add(instance.mesh);
      for (const p of instance.mesh.primitives) meshBytes += (p.positions.length / 3) * 32 + p.indices.length * 4;
    }
    for (const set of TEXTURE_SETS) {
      for (const texture of instance[set] ?? []) {
        if (texture && !textures.has(texture)) {
          textures.add(texture);
          textureBytes += textureMemory(texture);
        }
      }
    }
  }
  return { textures: textureBytes, meshes: meshBytes, targets: width * height * 8 };
}
