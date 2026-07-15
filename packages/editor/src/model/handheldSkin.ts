/**
 * Handheld console skin model.
 *
 * A handheld's appearance is a shared chrome image (the "base": bezel, screen
 * frame, button outlines) plus seven flat, recolourable regions (chassis face,
 * button letters, D-pad arrows/ring, L/R shoulder backs, button diamonds). A
 * "scheme" is therefore just seven colours; recolouring is an exact mask-fill,
 * which is what makes both quick palette swaps and premade skins cheap.
 *
 * This module is pure (no DOM): it defines the regions, renders a scheme onto a
 * template to RGBA, and extracts a template/scheme from a parsed Aseprite file
 * (the `Vertical_Pixel_Handheld.aseprite` template, whose named layers encode
 * exactly this structure). The web app and the asset-prep script share it.
 */

import type { AsepriteLayers } from "./asepriteImport";
import { hexToRgb, rgbToHex } from "./palette";

/**
 * The seven recolourable regions, in mask-id order (mask id = index + 1; 0 means
 * "not a region"). `layer` is the Aseprite layer name that carries the region in
 * the template file.
 */
export const HANDHELD_REGIONS = [
  { id: "face", label: "Chassis", layer: "Face_Color" },
  { id: "buttonLetter", label: "Button letters", layer: "Button_Letter_Color" },
  { id: "dpadArrow", label: "D-pad arrows", layer: "DPad_Arrow_Color" },
  { id: "lButton", label: "L shoulder", layer: "L_Button_BKGR" },
  { id: "rButton", label: "R shoulder", layer: "R_Button_BkGR" },
  { id: "buttonDiamond", label: "Button diamonds", layer: "Button_Diamond_Color" },
  { id: "dpadRing", label: "D-pad ring", layer: "DPad_Ring_Color" },
] as const;

export type HandheldRegion = (typeof HANDHELD_REGIONS)[number];
export type HandheldRegionId = HandheldRegion["id"];

/** A colour scheme: one hex colour (`#rrggbb`) per region. */
export type HandheldScheme = Record<HandheldRegionId, string>;

/** A named premade scheme shown on the handheld-selection screen. */
export interface HandheldPreset {
  readonly id: string;
  readonly label: string;
  readonly scheme: HandheldScheme;
}

/**
 * The reusable skin geometry: the base chrome bitmap plus a per-pixel region
 * mask. Both cover the same `width × height` canvas. A scheme + this template
 * fully determines a rendered handheld.
 */
export interface HandheldTemplate {
  readonly width: number;
  readonly height: number;
  /** Straight-alpha RGBA of the shared chrome, length `width * height * 4`. */
  readonly base: Uint8ClampedArray;
  /** Region id per pixel (0 = none, 1..7 = HANDHELD_REGIONS order). */
  readonly regionMask: Uint8Array;
}

/** Build a scheme by mapping each region id to a colour. */
export function makeScheme(color: (region: HandheldRegion) => string): HandheldScheme {
  const scheme = {} as Record<HandheldRegionId, string>;
  for (const region of HANDHELD_REGIONS) scheme[region.id] = color(region);
  return scheme;
}

/** A scheme with a single accent (letters/arrows/diamonds/ring) over one body. */
function twoTone(body: string, accent: string): HandheldScheme {
  return {
    face: body,
    lButton: body,
    rButton: body,
    buttonLetter: accent,
    dpadArrow: accent,
    buttonDiamond: accent,
    dpadRing: accent,
  };
}

/**
 * Premade schemes shown on the handheld-selection screen. "Iron Man" is the
 * scheme authored in the template file; the rest are house palettes. Users can
 * pick one as-is or recolour any region from there.
 */
export const HANDHELD_PRESETS: readonly HandheldPreset[] = [
  { id: "iron-man", label: "Iron Man", scheme: twoTone("#195ba6", "#fad937") },
  { id: "graphite", label: "Graphite", scheme: twoTone("#3a3d42", "#e6e6e6") },
  { id: "bubblegum", label: "Bubblegum", scheme: twoTone("#e84d8a", "#fff3b0") },
  { id: "mint", label: "Mint", scheme: twoTone("#3dbe8a", "#f6f7d7") },
  { id: "grape", label: "Grape", scheme: twoTone("#3f3f74", "#fad937") },
  { id: "ember", label: "Ember", scheme: twoTone("#b13e53", "#ffcd75") },
];

/** The scheme a brand-new account starts on before choosing. */
export const DEFAULT_HANDHELD_PRESET_ID = "iron-man";

/** Look up a preset by id, falling back to the default. */
export function handheldPreset(id: string): HandheldPreset {
  return (
    HANDHELD_PRESETS.find((preset) => preset.id === id) ??
    HANDHELD_PRESETS.find((preset) => preset.id === DEFAULT_HANDHELD_PRESET_ID) ??
    HANDHELD_PRESETS[0]!
  );
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** Coerce one value to a `#rrggbb` colour, or null if it isn't one. */
function toHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return HEX_COLOR.test(withHash) ? withHash : null;
}

/**
 * Validate and normalise an untrusted scheme (e.g. from a request body) into a
 * complete scheme of `#rrggbb` colours. Unknown or malformed region values fall
 * back to the corresponding colour in `fallback` (the default preset). This is
 * the single gate every persisted scheme must pass through, so a malformed skin
 * can never reach the database.
 */
export function normalizeScheme(
  input: unknown,
  fallback: HandheldScheme = handheldPreset(DEFAULT_HANDHELD_PRESET_ID).scheme,
): HandheldScheme {
  const source = (input ?? {}) as Record<string, unknown>;
  return makeScheme((region) => toHexColor(source[region.id]) ?? fallback[region.id]);
}

/**
 * Render a scheme onto the template to a straight-alpha RGBA bitmap: start from
 * the base chrome, then paint each region's masked pixels with its scheme colour
 * (regions sit opaque on top of the base, matching the source file's layering).
 */
export function renderHandheld(template: HandheldTemplate, scheme: HandheldScheme): Uint8ClampedArray {
  const out = template.base.slice();
  const colors = HANDHELD_REGIONS.map((region) => hexToRgb(scheme[region.id]));
  const mask = template.regionMask;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const region = mask[pixel];
    if (!region) continue;
    const [red, green, blue] = colors[region - 1] ?? [0, 0, 0];
    const base = pixel * 4;
    out[base] = red;
    out[base + 1] = green;
    out[base + 2] = blue;
    out[base + 3] = 255;
  }
  return out;
}

/** The child image layers of a named group, with the group's own child level. */
function groupChildren(layers: AsepriteLayers, groupName: string): AsepriteLayers["layers"] {
  const start = layers.layers.findIndex((layer) => layer.name === groupName);
  if (start < 0) return [];
  const groupLevel = layers.layers[start]!.childLevel;
  const children: AsepriteLayers["layers"] = [];
  for (let index = start + 1; index < layers.layers.length; index += 1) {
    const layer = layers.layers[index]!;
    if (layer.childLevel <= groupLevel) break; // left the group's subtree
    children.push(layer);
  }
  return children;
}

/** The colour of the first opaque pixel of a layer, as `#rrggbb`, or null. */
function firstOpaqueColor(pixels: Uint8ClampedArray | null): string | null {
  if (!pixels) return null;
  for (let pixel = 0; pixel < pixels.length / 4; pixel += 1) {
    if ((pixels[pixel * 4 + 3] ?? 0) > 0) {
      return rgbToHex(pixels[pixel * 4] ?? 0, pixels[pixel * 4 + 1] ?? 0, pixels[pixel * 4 + 2] ?? 0);
    }
  }
  return null;
}

/**
 * Extract a scheme (the seven region colours) from a named group in a parsed
 * template — e.g. the `Iron_Man` group. Regions with no coloured layer fall back
 * to `fallback`.
 */
export function extractScheme(layers: AsepriteLayers, groupName: string, fallback = "#000000"): HandheldScheme {
  const children = groupChildren(layers, groupName);
  return makeScheme((region) => {
    const layer = children.find((child) => child.name === region.layer);
    return firstOpaqueColor(layer?.pixels ?? null) ?? fallback;
  });
}

/**
 * Effective visibility per layer: a layer shows only if it and every ancestor
 * group are visible. Aseprite stores group membership by child level (a group's
 * children have a higher level than it), so we track the running visibility of
 * the group open at each level.
 */
function effectiveVisibility(layers: AsepriteLayers["layers"]): boolean[] {
  const groupVisibleAtLevel: boolean[] = [];
  return layers.map((layer) => {
    const parentVisible = layer.childLevel === 0 ? true : (groupVisibleAtLevel[layer.childLevel - 1] ?? true);
    const visible = layer.visible && parentVisible;
    if (layer.type === 1 /* group */) groupVisibleAtLevel[layer.childLevel] = visible;
    return visible;
  });
}

/**
 * Extract a scheme from an edited handheld file the way it actually renders —
 * used when a player uploads a `.aseprite` they recoloured in an external tool.
 * It composites the effectively-visible layers (honouring group visibility),
 * then reads each region's most common colour over that region's shape (the
 * union of every layer named for it). "What you see in Aseprite is what you
 * get." Regions with no coverage fall back to `fallback`.
 */
export function extractSchemeFromLayers(layers: AsepriteLayers, fallback: HandheldScheme): HandheldScheme {
  const { width, height } = layers;
  const visible = effectiveVisibility(layers.layers);

  // Flatten the visible layers, bottom to top, straight-alpha source-over.
  const composite = new Uint8ClampedArray(width * height * 4);
  layers.layers.forEach((layer, index) => {
    const pixels = layer.pixels;
    if (!visible[index] || !pixels) return;
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const alpha = pixels[pixel * 4 + 3] ?? 0;
      if (!alpha) continue;
      const base = pixel * 4;
      const sa = alpha / 255;
      const da = (composite[base + 3] ?? 0) / 255;
      const oa = sa + da * (1 - sa);
      composite[base] = ((pixels[base] ?? 0) * sa + (composite[base] ?? 0) * da * (1 - sa)) / oa;
      composite[base + 1] = ((pixels[base + 1] ?? 0) * sa + (composite[base + 1] ?? 0) * da * (1 - sa)) / oa;
      composite[base + 2] = ((pixels[base + 2] ?? 0) * sa + (composite[base + 2] ?? 0) * da * (1 - sa)) / oa;
      composite[base + 3] = Math.round(oa * 255);
    }
  });

  return makeScheme((region) => {
    const counts = new Map<number, number>();
    for (const layer of layers.layers) {
      if (layer.name !== region.layer || !layer.pixels) continue;
      for (let pixel = 0; pixel < width * height; pixel += 1) {
        if ((layer.pixels[pixel * 4 + 3] ?? 0) < 128) continue; // outside the region shape
        if ((composite[pixel * 4 + 3] ?? 0) < 128) continue; // nothing visible here
        const key = ((composite[pixel * 4] ?? 0) << 16) | ((composite[pixel * 4 + 1] ?? 0) << 8) | (composite[pixel * 4 + 2] ?? 0);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    let best = -1;
    let bestCount = 0;
    for (const [key, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = key;
      }
    }
    return best < 0 ? fallback[region.id] : `#${(best & 0xffffff).toString(16).padStart(6, "0")}`;
  });
}

/**
 * Build the reusable template (base chrome + region mask) from a parsed file.
 * `baseLayer` is the shared chrome layer name; `maskGroup` is the group whose
 * region layers define the masks (any complete scheme works — they share masks —
 * but the blank template group is the canonical choice).
 */
export function extractHandheldTemplate(
  layers: AsepriteLayers,
  baseLayer: string,
  maskGroup: string,
): HandheldTemplate {
  const { width, height } = layers;
  const baseSource = layers.layers.find((layer) => layer.name === baseLayer)?.pixels;
  if (!baseSource) throw new Error(`Base layer "${baseLayer}" not found or empty.`);
  const base = baseSource.slice();

  const regionMask = new Uint8Array(width * height);
  const children = groupChildren(layers, maskGroup);
  HANDHELD_REGIONS.forEach((region, index) => {
    const pixels = children.find((child) => child.name === region.layer)?.pixels;
    if (!pixels) return;
    const id = index + 1;
    for (let pixel = 0; pixel < regionMask.length; pixel += 1) {
      if ((pixels[pixel * 4 + 3] ?? 0) >= 128) regionMask[pixel] = id;
    }
  });

  return { width, height, base, regionMask };
}
