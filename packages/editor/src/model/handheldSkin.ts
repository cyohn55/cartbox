/**
 * Handheld console skin model.
 *
 * A handheld's appearance is a shared chrome image (the "base": bezel, screen
 * frame, button outlines) plus a set of flat, recolourable regions (chassis
 * face, D-pad and button recess panels, the D-pad and its arrows, button
 * letters, on-shell text and decals). A "scheme" is therefore just one colour
 * per region; recolouring is an exact mask-fill, which is what makes both quick
 * palette swaps and premade skins cheap.
 *
 * This module is pure (no DOM): it defines the regions, renders a scheme onto a
 * template to RGBA, and extracts a template/scheme from a parsed Aseprite file
 * (the `Vertical_Pixel_Handheld.aseprite` template, whose `Vertical_Handheld`
 * group holds one flat layer per region over the shared `Handheld` base). The
 * web app and the asset-prep script share it.
 */

import type { AsepriteLayers } from "./asepriteImport";
import { hexToRgb, rgbToHex } from "./palette";

/**
 * The recolourable regions, in mask-id order (mask id = index + 1; 0 means "not
 * a region"). `layer` is the Aseprite layer name that carries the region in the
 * `Vertical_Handheld` group of the template file.
 *
 * Order matters: the chassis is the full-face background that every other region
 * sits on top of, so it comes first (lowest priority) and detail regions follow.
 * When masks overlap, the later region wins the pixel.
 */
export const HANDHELD_REGIONS = [
  { id: "face", label: "Chassis", layer: "Face_Color" },
  { id: "dpadPanel", label: "D-pad panel", layer: "DPad_Background" },
  { id: "buttonPanel", label: "Button panel", layer: "Button_Background" },
  { id: "decal", label: "Decals", layer: "Decal_Color" },
  { id: "text", label: "Text", layer: "Text_Color" },
  { id: "dpad", label: "D-pad", layer: "DPad_Color" },
  { id: "buttonColor", label: "Buttons", layer: "Button_Color" },
  { id: "dpadArrow", label: "D-pad arrows", layer: "Arrow_Color" },
  { id: "buttonLetter", label: "Button letters", layer: "Button_Text_Color" },
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
  /** Region id per pixel (0 = none, 1..N = HANDHELD_REGIONS order). */
  readonly regionMask: Uint8Array;
}

/** Build a scheme by mapping each region id to a colour. */
export function makeScheme(color: (region: HandheldRegion) => string): HandheldScheme {
  const scheme = {} as Record<HandheldRegionId, string>;
  for (const region of HANDHELD_REGIONS) scheme[region.id] = color(region);
  return scheme;
}

/**
 * A scheme with a single accent over one body colour: the chassis and its recess
 * panels take the body; the D-pad, buttons, on-shell text and decals take the
 * accent. The D-pad arrows and button letters sit *on top of* the accent-coloured
 * D-pad and buttons, so they take `ink` (the chassis colour by default) to read
 * as an engraved cut-out — never the same colour as the control they mark.
 * Exported so the animated-skin model can build the same two-tone base schemes.
 */
export function twoTone(body: string, accent: string, ink: string = body): HandheldScheme {
  return {
    face: body,
    dpadPanel: body,
    buttonPanel: body,
    dpad: accent,
    buttonColor: accent,
    dpadArrow: ink,
    buttonLetter: ink,
    text: accent,
    decal: accent,
  };
}

/**
 * Premade schemes shown on the handheld-selection screen: one chassis per colour
 * of the spectrum (red through violet) plus neutral graphite and white. Each is
 * a two-tone pairing whose accent (D-pad, buttons, markings) is chosen to read
 * clearly against its chassis. Users can pick one as-is or recolour any region.
 */
export const HANDHELD_PRESETS: readonly HandheldPreset[] = [
  { id: "red", label: "Red", scheme: twoTone("#cc3b3b", "#f2e6c9") }, // red + cream
  { id: "orange", label: "Orange", scheme: twoTone("#e8792b", "#26374d") }, // orange + navy
  { id: "yellow", label: "Yellow", scheme: twoTone("#f2c53d", "#33344a") }, // yellow + charcoal
  { id: "green", label: "Green", scheme: twoTone("#3fa65a", "#ffffff") }, // green + white accents (decals/text/D-pad/buttons)
  { id: "blue", label: "Blue", scheme: twoTone("#2f6fd0", "#f2c53d") }, // blue + gold
  { id: "indigo", label: "Indigo", scheme: twoTone("#3b3d8f", "#7cc4f2") }, // indigo + sky
  { id: "violet", label: "Violet", scheme: twoTone("#7a3fa6", "#a7f070") }, // violet + lime
  { id: "graphite", label: "Graphite", scheme: twoTone("#3a3d42", "#d6d9de") }, // graphite + silver
  { id: "white", label: "White", scheme: twoTone("#eef1f4", "#cc3b3b") }, // white + red
];

/** The scheme a brand-new account starts on before choosing. */
export const DEFAULT_HANDHELD_PRESET_ID = "blue";

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

/** The 1-based region id of the chassis background (`face`) within the mask. */
const FACE_REGION_ID = HANDHELD_REGIONS.findIndex((region) => region.id === "face") + 1;

/** A straight-alpha RGBA image supplied as the chassis background. */
export interface HandheldBackground {
  readonly width: number;
  readonly height: number;
  /** RGBA pixels, length `width * height * 4`. */
  readonly data: Uint8ClampedArray;
}

/**
 * Render a scheme, then replace the chassis (`face`) pixels with an uploaded
 * image so it shows through the body while the chrome, controls and screen stay
 * on top. The image is cover-fitted to the device bounds (scaled to fill, then
 * centre-cropped) so any aspect ratio reads cleanly; every other region keeps
 * its scheme colour. Pure: returns straight-alpha RGBA like `renderHandheld`.
 */
export function renderHandheldWithBackground(
  template: HandheldTemplate,
  scheme: HandheldScheme,
  background: HandheldBackground,
): Uint8ClampedArray {
  const out = renderHandheld(template, scheme);
  const { width, height, regionMask } = template;
  const { width: imageWidth, height: imageHeight, data } = background;
  if (imageWidth <= 0 || imageHeight <= 0) return out;

  // Cover fit: scale to fill the device, centre the overflow so it is cropped
  // symmetrically rather than anchored to a corner.
  const scale = Math.max(width / imageWidth, height / imageHeight);
  const offsetX = (width - imageWidth * scale) / 2;
  const offsetY = (height - imageHeight * scale) / 2;

  for (let pixel = 0; pixel < regionMask.length; pixel += 1) {
    if (regionMask[pixel] !== FACE_REGION_ID) continue;
    const x = pixel % width;
    const y = (pixel / width) | 0;
    const sampleX = Math.min(imageWidth - 1, Math.max(0, Math.floor((x - offsetX) / scale)));
    const sampleY = Math.min(imageHeight - 1, Math.max(0, Math.floor((y - offsetY) / scale)));
    const src = (sampleY * imageWidth + sampleX) * 4;
    const dst = pixel * 4;
    out[dst] = data[src] ?? 0;
    out[dst + 1] = data[src + 1] ?? 0;
    out[dst + 2] = data[src + 2] ?? 0;
    out[dst + 3] = 255;
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
  // The template can carry more than one layer named for the base (e.g. a backup
  // nested in a hidden group); prefer the top-level chrome layer, which is the
  // one actually composited on the shell.
  const baseSource =
    layers.layers.find((layer) => layer.name === baseLayer && layer.childLevel === 0)?.pixels ??
    layers.layers.find((layer) => layer.name === baseLayer)?.pixels;
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
