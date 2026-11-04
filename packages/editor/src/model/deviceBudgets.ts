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
 *
 * The `aaa` tier has a table of its own (AAA_PRODUCTION_ROADMAP.md Q2), over
 * four device classes (a desktop's integrated GPU beside its discrete one),
 * each with the quality level and resolution AAA_FIDELITY_ROADMAP.md targets
 * there and a GPU budget for each group of the frame graph's passes. Those
 * numbers are provisional until the hardware lab (DEMO_QUALITY_ROADMAP.md R1)
 * measures them; see {@link AAA_BUDGETS_PROVISIONAL}. Every call takes the
 * tier, and leaving it out means the fantasy tiers' table, as before.
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

/** A device class on the AAA tier: a desktop's integrated GPU joins the fantasy tiers' three. */
export type AaaBudgetDevice = BudgetDevice | "integrated";

/** Which table of budgets: the fantasy tiers' (PS1 through the 360) or the `aaa` tier's. */
export type BudgetTier = "fantasy" | "aaa";

/** The AAA tier's devices, smallest first. */
export const AAA_BUDGET_DEVICES: readonly AaaBudgetDevice[] = ["iphone", "ipad", "integrated", "desktop"];

/** Scalability levels, after Unreal's (AAA_FIDELITY_ROADMAP.md's ground rules). */
export type QualityLevel = "Low" | "Medium" | "High" | "Epic";

/**
 * Groups of the frame graph's passes, each with a share of the GPU's frame.
 * {@link passGroup} sorts a pass into one by its name.
 */
export type PassGroup = "culling" | "shadows" | "shading" | "lighting" | "atmosphere" | "post" | "other";

export const PASS_GROUPS: readonly PassGroup[] = ["culling", "shadows", "shading", "lighting", "atmosphere", "post", "other"];

export const PASS_GROUP_LABELS: Readonly<Record<PassGroup, string>> = {
  culling: "Culling and depth",
  shadows: "Shadows",
  shading: "Scene shading",
  lighting: "GI, AO and reflections",
  atmosphere: "Sky, fog and volumes",
  post: "Temporal and post",
  other: "Other",
};

/**
 * Each group's share of the frame time, summing to 0.9 so a tenth is left for
 * the browser's own compositing and for spikes. Shading is the largest, then
 * the screen-space and probe lighting, then shadows, as in a current-gen
 * deferred or forward+ frame.
 */
export const PASS_GROUP_SHARES: Readonly<Record<PassGroup, number>> = {
  culling: 0.08,
  shadows: 0.14,
  shading: 0.27,
  lighting: 0.18,
  atmosphere: 0.08,
  post: 0.13,
  other: 0.02,
};

/** A device's AAA budget: the scene's, plus the level it runs at and a GPU time per group of passes. */
export interface AaaDeviceBudget extends DeviceBudget {
  readonly level: QualityLevel;
  /** The output resolution the level targets ("1440p"), before upscaling. */
  readonly resolution: string;
  /** GPU milliseconds per group of passes: the group's share of the frame time. */
  readonly passMs: Readonly<Record<PassGroup, number>>;
}

/**
 * True while the AAA budgets are set from targets, not measured: the editor
 * says so beside them. Clear it when R1's lab has measured the four classes.
 */
export const AAA_BUDGETS_PROVISIONAL = true;

function aaaBudget(budget: Omit<AaaDeviceBudget, "passMs">): AaaDeviceBudget {
  const passMs = Object.fromEntries(PASS_GROUPS.map((g) => [g, budget.frameMs * PASS_GROUP_SHARES[g]])) as Record<PassGroup, number>;
  return { ...budget, passMs };
}

/**
 * The AAA tier's budgets: AAA_FIDELITY_ROADMAP.md's targets (Epic at 1440p60
 * on a discrete GPU, High at 1080p60 upscaled on an integrated one, Medium at
 * 30 fps on an iPad and an iPhone). Triangles and draw calls are what reach
 * the raster after GPU culling and cluster LOD, so they sit above the fantasy
 * tiers'; memory holds to a tab's 2–4 GB on a desktop and far less on iOS;
 * downloads stop at the direct-upload ceiling (256 MB) and well below it on a
 * phone. Textures are counted as everywhere else here, RGBA8 with mips, though
 * the tier stores them compressed (BC7 or ASTC, a quarter of that or less), so
 * these are the decoded scene's limits, not the GPU's.
 */
export const AAA_DEVICE_BUDGETS: Readonly<Record<AaaBudgetDevice, AaaDeviceBudget>> = {
  iphone: aaaBudget({ label: "iPhone", level: "Medium", resolution: "the screen's resolution, upscaled", triangles: 600_000, drawCalls: 700, textureBytes: 256 * MB, meshBytes: 96 * MB, frameMs: 1000 / 30, downloadBytes: 48 * MB }),
  ipad: aaaBudget({ label: "iPad", level: "Medium", resolution: "the screen's resolution, upscaled", triangles: 1_200_000, drawCalls: 1200, textureBytes: 512 * MB, meshBytes: 160 * MB, frameMs: 1000 / 30, downloadBytes: 64 * MB }),
  integrated: aaaBudget({ label: "Integrated GPU", level: "High", resolution: "1080p, upscaled", triangles: 3_000_000, drawCalls: 2500, textureBytes: 1024 * MB, meshBytes: 384 * MB, frameMs: 1000 / 60, downloadBytes: 160 * MB }),
  desktop: aaaBudget({ label: "Discrete GPU", level: "Epic", resolution: "1440p", triangles: 8_000_000, drawCalls: 5000, textureBytes: 2048 * MB, meshBytes: 768 * MB, frameMs: 1000 / 60, downloadBytes: 256 * MB }),
};

/** A tier's devices, smallest first. */
export function budgetDevices(tier: BudgetTier = "fantasy"): readonly AaaBudgetDevice[] {
  return tier === "aaa" ? AAA_BUDGET_DEVICES : BUDGET_DEVICES;
}

/**
 * The device a tier checks against: itself when the tier has it; otherwise
 * (an integrated GPU on the fantasy tiers, which don't split the desktop) the
 * desktop.
 */
export function tierDevice(device: AaaBudgetDevice, tier: BudgetTier = "fantasy"): AaaBudgetDevice {
  return budgetDevices(tier).includes(device) ? device : "desktop";
}

/** A device's budget on a tier (see {@link tierDevice} for a device the tier doesn't have). */
export function deviceBudget(device: AaaBudgetDevice, tier: BudgetTier = "fantasy"): DeviceBudget {
  const d = tierDevice(device, tier);
  return tier === "aaa" ? AAA_DEVICE_BUDGETS[d] : DEVICE_BUDGETS[d as BudgetDevice];
}

/** How a scene's load compares with a device's budget, line by line (only the lines it knows). */
export function checkBudget(load: SceneLoad, device: AaaBudgetDevice, tier: BudgetTier = "fantasy"): BudgetLine[] {
  const budget = deviceBudget(device, tier);
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
export function overBudget(load: SceneLoad, device: AaaBudgetDevice, tier: BudgetTier = "fantasy"): BudgetLine[] {
  return checkBudget(load, device, tier).filter((l) => l.over);
}

/** The smallest device a scene fits (all its known lines), or null when it fits none. */
export function smallestFit(load: SceneLoad, tier?: "fantasy"): BudgetDevice | null;
export function smallestFit(load: SceneLoad, tier: BudgetTier): AaaBudgetDevice | null;
export function smallestFit(load: SceneLoad, tier: BudgetTier = "fantasy"): AaaBudgetDevice | null {
  return budgetDevices(tier).find((d) => overBudget(load, d, tier).length === 0) ?? null;
}

/** A device as a sentence names it: "an iPhone", "a desktop", "an integrated GPU". */
function deviceNoun(device: AaaBudgetDevice, tier: BudgetTier): string {
  const label = deviceBudget(device, tier).label;
  const noun = /^[A-Z][a-z]/.test(label) ? label[0]!.toLowerCase() + label.slice(1) : label;
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
}

/** What {@link smallestFit} found, as the Budgets panel says it. */
export function fitSummary(fits: AaaBudgetDevice | null, tier: BudgetTier = "fantasy"): string {
  const devices = budgetDevices(tier);
  if (fits) return fits === devices[devices.length - 1] ? `Fits ${deviceNoun(fits, tier)}.` : `Fits ${deviceNoun(fits, tier)} and up.`;
  return `Over even ${deviceNoun(devices[devices.length - 1]!, tier)}'s budget.`;
}

/**
 * The group a frame-graph pass belongs to, by its name: the presenter's
 * `present: ` prefix is dropped, and a dotted sub-pass (`taa.resolve`,
 * `cull.clusters.occlusion`) goes with its root. A name nobody sorted is
 * "other", and a test over the renderer's source keeps that to the readback.
 */
export function passGroup(name: string): PassGroup {
  const bare = name.startsWith("present: ") ? name.slice("present: ".length) : name;
  const root = bare.split(".")[0]!.trim();
  return PASS_ROOTS[root] ?? "other";
}

const PASS_ROOTS: Readonly<Record<string, PassGroup>> = {
  cull: "culling",
  hiz: "culling",
  prepass: "culling",
  "texture feedback": "culling",
  lights: "culling",
  "shadow cascades": "shadows",
  "virtual shadows": "shadows",
  vsm: "shadows",
  "local shadows": "shadows",
  "contact shadows": "shadows",
  opaque: "shading",
  "see-through": "shading",
  behind: "shading",
  particles: "shading",
  sss: "shading",
  gtao: "lighting",
  ssgi: "lighting",
  "dynamic gi": "lighting",
  reflections: "lighting",
  sky: "atmosphere",
  "volumetric fog": "atmosphere",
  volumes: "atmosphere",
  shafts: "atmosphere",
  "shaft mask": "atmosphere",
  taa: "post",
  upscale: "post",
  motion: "post",
  dof: "post",
  bloom: "post",
  lens: "post",
  "tone map": "post",
  post: "post",
  compose: "post",
  "compose and tone map": "post",
  "linear composite": "post",
  measure: "post",
  "view mode": "post",
  readback: "other",
};

/** One group's GPU time against its budget. */
export interface PassBudgetLine {
  readonly group: PassGroup;
  readonly label: string;
  /** The group's passes' time, summed, milliseconds. */
  readonly ms: number;
  readonly budget: number;
  readonly share: number;
  readonly over: boolean;
  /** The passes counted, in the frame's order. */
  readonly passes: readonly string[];
  /** "2.10 ms of 2.33 ms". */
  readonly text: string;
}

/**
 * A frame's GPU pass times (the profiler's `passes`) against an AAA device's
 * budget, a line per group that ran, in {@link PASS_GROUPS}' order.
 */
export function checkPassBudget(passes: readonly { readonly name: string; readonly ms: number }[], device: AaaBudgetDevice): PassBudgetLine[] {
  const budget = AAA_DEVICE_BUDGETS[device];
  const sums = new Map<PassGroup, { ms: number; passes: string[] }>();
  for (const pass of passes) {
    if (!Number.isFinite(pass.ms)) continue;
    const group = passGroup(pass.name);
    const entry = sums.get(group) ?? { ms: 0, passes: [] };
    entry.ms += Math.max(0, pass.ms);
    entry.passes.push(pass.name);
    sums.set(group, entry);
  }
  return PASS_GROUPS.flatMap((group) => {
    const entry = sums.get(group);
    if (!entry) return [];
    const limit = budget.passMs[group];
    return [{ group, label: PASS_GROUP_LABELS[group], ms: entry.ms, budget: limit, share: entry.ms / limit, over: entry.ms > limit, passes: entry.passes, text: `${entry.ms.toFixed(2)} ms of ${limit.toFixed(2)} ms` }];
  });
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
