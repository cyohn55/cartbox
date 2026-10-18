/**
 * Per-device budgets (EDITOR_PRO_ROADMAP.md P8), after Unreal's scalability
 * budgets and Unity's frame debugger targets: what a scene may cost to run
 * well on an iPhone, an iPad and a desktop — triangles and draw calls a
 * frame, texture and mesh memory, frame time and download — and a check
 * that says, line by line, how a scene's load compares and which lines are
 * over. The profiler overlay and the editor's budget panel both read it.
 *
 * The numbers are for this engine's paths (a WebGPU or WebGL2 forward
 * renderer, textures as RGBA8 with mips, everything inside a browser tab's
 * memory), set from what Lockout and Beaver Creek run at on each device
 * class with headroom. Pure.
 */

export type BudgetDevice = "iphone" | "ipad" | "desktop";

export const BUDGET_DEVICES: readonly BudgetDevice[] = ["iphone", "ipad", "desktop"];

export interface DeviceBudget {
  readonly label: string;
  /** Triangles drawn a frame. */
  readonly triangles: number;
  /** Draw calls a frame. */
  readonly drawCalls: number;
  /** Texture memory (decoded, with mips), bytes. */
  readonly textureBytes: number;
  /** Mesh memory (vertices and indices), bytes. */
  readonly meshBytes: number;
  /** Frame time to hold, milliseconds (30 fps on a phone, 60 elsewhere). */
  readonly frameMs: number;
  /** What the scene may download before it plays, bytes. */
  readonly downloadBytes: number;
}

const MB = 1024 * 1024;

export const DEVICE_BUDGETS: Readonly<Record<BudgetDevice, DeviceBudget>> = {
  iphone: { label: "iPhone", triangles: 400_000, drawCalls: 500, textureBytes: 192 * MB, meshBytes: 64 * MB, frameMs: 1000 / 30, downloadBytes: 16 * MB },
  ipad: { label: "iPad", triangles: 800_000, drawCalls: 900, textureBytes: 384 * MB, meshBytes: 128 * MB, frameMs: 1000 / 60, downloadBytes: 32 * MB },
  desktop: { label: "Desktop", triangles: 3_000_000, drawCalls: 3000, textureBytes: 1536 * MB, meshBytes: 512 * MB, frameMs: 1000 / 60, downloadBytes: 96 * MB },
};

/** What a scene costs: any of these may be unknown (left out), and is then not checked. */
export interface SceneLoad {
  readonly triangles?: number;
  readonly drawCalls?: number;
  readonly textureBytes?: number;
  readonly meshBytes?: number;
  readonly frameMs?: number;
  readonly downloadBytes?: number;
}

export type BudgetKey = keyof SceneLoad;

export interface BudgetLine {
  readonly key: BudgetKey;
  readonly label: string;
  readonly value: number;
  readonly budget: number;
  /** value / budget (1 = right at it). */
  readonly share: number;
  readonly over: boolean;
  /** The value and budget as people read them ("1.2 MB of 192 MB"). */
  readonly text: string;
}

const LABELS: Readonly<Record<BudgetKey, string>> = {
  triangles: "Triangles",
  drawCalls: "Draw calls",
  textureBytes: "Texture memory",
  meshBytes: "Mesh memory",
  frameMs: "Frame time",
  downloadBytes: "Download",
};

/** A count, size or time as people read it. */
export function formatBudgetValue(key: BudgetKey, v: number): string {
  if (key === "frameMs") return `${v.toFixed(1)} ms`;
  if (key === "textureBytes" || key === "meshBytes" || key === "downloadBytes") return v >= MB ? `${(v / MB).toFixed(1)} MB` : `${Math.round(v / 1024)} KB`;
  return v >= 10_000 ? `${(v / 1000).toFixed(0)}k` : `${Math.round(v)}`;
}

/** How a scene's load compares with a device's budget, line by line (only the lines it knows). */
export function checkBudget(load: SceneLoad, device: BudgetDevice): BudgetLine[] {
  const budget = DEVICE_BUDGETS[device];
  const out: BudgetLine[] = [];
  for (const key of Object.keys(LABELS) as BudgetKey[]) {
    const value = load[key];
    if (value === undefined || !Number.isFinite(value)) continue;
    const limit = budget[key];
    out.push({ key, label: LABELS[key], value, budget: limit, share: value / limit, over: value > limit, text: `${formatBudgetValue(key, value)} of ${formatBudgetValue(key, limit)}` });
  }
  return out;
}

/** The lines a scene is over on a device (none: it fits). */
export function overBudget(load: SceneLoad, device: BudgetDevice): BudgetLine[] {
  return checkBudget(load, device).filter((l) => l.over);
}

/** The smallest device a scene fits (all its known lines), or null when it fits none. */
export function smallestFit(load: SceneLoad): BudgetDevice | null {
  return BUDGET_DEVICES.find((d) => overBudget(load, d).length === 0) ?? null;
}

/** GPU bytes for a texture of this size decoded to RGBA8, with its mip chain (a third more). */
export function textureGpuBytes(width: number, height: number, mips = true): number {
  const base = Math.max(1, width) * Math.max(1, height) * 4;
  return mips ? Math.round((base * 4) / 3) : base;
}

/** A PNG's, JPEG's or KTX2's pixel size from its header, or null when it isn't one of those. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const u32 = (o: number, little = false) => {
    if (o + 4 > bytes.length) return 0;
    const b = [bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!];
    return (little ? (b[3]! << 24) | (b[2]! << 16) | (b[1]! << 8) | b[0]! : (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
  };
  // PNG: the IHDR chunk follows the 8-byte signature.
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { width: u32(16), height: u32(20) };
  // KTX2: «KTX 20», then vkFormat, typeSize, pixelWidth, pixelHeight (little-endian).
  if (bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58 && bytes[5] === 0x32) return { width: u32(20, true), height: Math.max(1, u32(24, true)) };
  // JPEG: walk the segments to a start-of-frame.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) return null;
      const marker = bytes[o + 1]!;
      const length = (bytes[o + 2]! << 8) | bytes[o + 3]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: (bytes[o + 7]! << 8) | bytes[o + 8]!, height: (bytes[o + 5]! << 8) | bytes[o + 6]! };
      }
      o += 2 + length;
    }
  }
  return null;
}
