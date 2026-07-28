/**
 * Deriving a sprite's material channels from the art itself.
 *
 * The Material layer lets an artist paint normal, height, specular, roughness
 * and emissive per pixel, and {@link MaterialSwatches} lets a *colour* carry a
 * material profile. Both are authoring paths: someone decides, pixel by pixel or
 * palette entry by palette entry, what the surface is. That is the right model
 * for deliberate work and a poor one for the first pass, where the artist has
 * already encoded the relief in the drawing — the light and dark texels of a
 * brick wall *are* its height field — and simply wants the channels to start
 * from what they drew.
 *
 * This module reads those channels back out of the albedo. Luminance becomes
 * height; the height's gradient becomes a normal; a cavity term falls out of the
 * height's local mean; brightness and saturation separate metal from paint and
 * pick out the texels that glow. The result is a starting point the artist then
 * edits, not a replacement for editing — nothing here writes anywhere on its
 * own, and {@link applyDerivedMaterials} takes an explicit list of the channels
 * it is allowed to touch.
 *
 * Ported from the Shade Studio material generator, whose heuristics this keeps;
 * the quantisation to the cart's 16 levels and 16 normal directions is new, and
 * is what makes the output authorable pixel art rather than a float texture.
 *
 * Pure and DOM-free. The unit tests drive it with drawn art and assert on the
 * channels read back off a real engine.
 */

import { MATERIAL_LEVELS } from "../engine/CartEngine";
import type { MaterialChannel, SpritePage } from "../engine/CartEngine";
import { luminance } from "../render/faceRelief";
import { NORMAL_DIRECTION_COUNT, nearestDirection } from "./normals";
import type { ParamSpec } from "../procgen/generators";
import type { SheetImage } from "./SpriteSheet";

/**
 * A scalar field over an image, in 0..1, one entry per pixel in row-major order.
 * Kept as floats through the whole derivation so quantisation happens exactly
 * once, at the end — quantising intermediates would stair-step the gradient the
 * normals are taken from.
 */
export type ScalarField = Float32Array;

/** Every channel this module can derive, including the one the cart cannot store. */
export type DerivedChannel = MaterialChannel | "occlusion";

/**
 * The channels a derivation produces.
 *
 * `normal` is three floats per pixel in the editor's screen-space basis (x right,
 * y down, z toward the viewer), *not* the 0..1-packed encoding a normal-map PNG
 * uses — the cart stores a direction index, so packing to bytes here would only
 * be undone immediately.
 */
export interface DerivedMaterials {
  readonly width: number;
  readonly height: number;
  /** Luminance-derived relief, 0..1. */
  readonly heightField: ScalarField;
  /** Unit normals, 3 floats per pixel. */
  readonly normal: Float32Array;
  /** Cavity occlusion, 1 where open and 0 in the deepest crevice. */
  readonly occlusion: ScalarField;
  /** Specular strength, from the metallic heuristic. */
  readonly specular: ScalarField;
  readonly roughness: ScalarField;
  readonly emissive: ScalarField;
  /** True where the source pixel was opaque; transparent pixels are left alone. */
  readonly opaque: Uint8Array;
}

/**
 * Every knob the derivation exposes, as one flat record.
 *
 * Flat rather than nested per channel because the UI renders it from
 * {@link MATERIAL_DERIVE_PARAMS} generically — the same {@link ParamSpec} shape
 * the Generate panel already uses — and a nested shape would buy nothing but a
 * path to walk.
 */
export interface MaterialDeriveParams {
  readonly heightGamma: number;
  readonly heightContrast: number;
  readonly heightInvert: number;
  readonly normalStrength: number;
  readonly occlusionRadius: number;
  readonly occlusionStrength: number;
  readonly roughnessBase: number;
  readonly roughnessBrightness: number;
  readonly roughnessDetail: number;
  readonly occlusionToRoughness: number;
  readonly metallicSaturation: number;
  readonly metallicBrightness: number;
  readonly metallicSoftness: number;
  readonly emissiveThreshold: number;
  readonly emissiveSoftness: number;
  readonly emissiveSaturation: number;
}

/**
 * The parameter descriptors, in the order the panel shows them.
 *
 * Reusing procgen's {@link ParamSpec} is deliberate: the Generate panel already
 * renders a slider per spec and knows nothing about what it is generating, so
 * describing these the same way means the material controls render with working
 * ranges, formats and tooltips without a line of new UI.
 */
export const MATERIAL_DERIVE_PARAMS: readonly ParamSpec[] = [
  {
    key: "heightGamma",
    label: "Height gamma",
    min: 0.25,
    max: 4,
    step: 0.05,
    value: 1,
    format: "decimal",
    hint: "Bends the brightness-to-height curve; above 1 pushes midtones down.",
  },
  {
    key: "heightContrast",
    label: "Height contrast",
    min: 0.25,
    max: 3,
    step: 0.05,
    value: 1,
    format: "decimal",
    hint: "Spreads relief away from the midpoint, deepening peaks and pits.",
  },
  {
    key: "heightInvert",
    label: "Invert height",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    format: "integer",
    hint: "Treat dark pixels as raised instead of recessed.",
  },
  {
    key: "normalStrength",
    label: "Normal strength",
    min: 0,
    max: 8,
    step: 0.1,
    value: 2,
    format: "decimal",
    hint: "How steeply the height's slope tilts the surface normal.",
  },
  {
    key: "occlusionRadius",
    label: "Cavity radius",
    min: 1,
    max: 8,
    step: 1,
    value: 2,
    format: "integer",
    hint: "How far out occlusion looks for the surrounding surface level.",
  },
  {
    key: "occlusionStrength",
    label: "Cavity strength",
    min: 0,
    max: 3,
    step: 0.05,
    value: 1,
    format: "decimal",
    hint: "How dark a crevice gets relative to the surface around it.",
  },
  {
    key: "roughnessBase",
    label: "Roughness base",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.5,
    format: "percent",
    hint: "The roughness a flat, mid-brightness pixel settles at.",
  },
  {
    key: "roughnessBrightness",
    label: "Gloss from light",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.2,
    format: "percent",
    hint: "How much brighter pixels are treated as smoother.",
  },
  {
    key: "roughnessDetail",
    label: "Roughness from detail",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.25,
    format: "percent",
    hint: "How much fine texture in the art reads as a rough surface.",
  },
  {
    key: "occlusionToRoughness",
    label: "Roughness in cavities",
    min: 0,
    max: 1,
    step: 0.05,
    value: 0.35,
    format: "percent",
    hint: "How much crevices roughen, since sheltered surfaces rarely stay polished.",
  },
  {
    key: "metallicSaturation",
    label: "Metal saturation limit",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.2,
    format: "percent",
    hint: "Colours more saturated than this are treated as paint, not metal.",
  },
  {
    key: "metallicBrightness",
    label: "Metal brightness floor",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.3,
    format: "percent",
    hint: "Metal has to be at least this bright; darker greys stay matte.",
  },
  {
    key: "metallicSoftness",
    label: "Metal edge softness",
    min: 0.01,
    max: 0.5,
    step: 0.01,
    value: 0.1,
    format: "percent",
    hint: "How gradually the metal mask fades in around its thresholds.",
  },
  {
    key: "emissiveThreshold",
    label: "Glow threshold",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.85,
    format: "percent",
    hint: "Pixels brighter than this begin to emit their own light.",
  },
  {
    key: "emissiveSoftness",
    label: "Glow softness",
    min: 0.01,
    max: 0.5,
    step: 0.01,
    value: 0.1,
    format: "percent",
    hint: "How gradually glow ramps in above the threshold.",
  },
  {
    key: "emissiveSaturation",
    label: "Glow needs colour",
    min: 0,
    max: 1,
    step: 0.05,
    value: 0,
    format: "percent",
    hint: "Above zero, only saturated pixels glow — white highlights stay lit, not lamps.",
  },
];

/** The defaults, read straight off the descriptors so the two cannot drift. */
export function defaultMaterialDeriveParams(): MaterialDeriveParams {
  const values: Record<string, number> = {};
  for (const param of MATERIAL_DERIVE_PARAMS) values[param.key] = param.value;
  return values as unknown as MaterialDeriveParams;
}

/**
 * Coerce a loose record into valid parameters: unknown keys dropped, missing
 * ones defaulted, and every value clamped into its declared range. The panel
 * holds its state as `Record<string, number>`, so this is the boundary between
 * that and the typed shape the derivation runs on.
 */
export function normalizeMaterialDeriveParams(values: Readonly<Record<string, number>>): MaterialDeriveParams {
  const params: Record<string, number> = {};
  for (const spec of MATERIAL_DERIVE_PARAMS) {
    const raw = values[spec.key];
    params[spec.key] =
      typeof raw === "number" && Number.isFinite(raw) ? Math.min(spec.max, Math.max(spec.min, raw)) : spec.value;
  }
  return params as unknown as MaterialDeriveParams;
}

// --- Numeric primitives -----------------------------------------------------

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Sample a field with coordinates clamped to the edge (a sprite does not tile). */
function sampleClamped(field: ScalarField, width: number, height: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= width ? width - 1 : x;
  const cy = y < 0 ? 0 : y >= height ? height - 1 : y;
  return field[cy * width + cx] ?? 0;
}

/**
 * Separable box blur over a scalar field, via a running sum per row and then per
 * column. Linear in the pixel count rather than quadratic in the radius, which
 * matters because the cavity term blurs the height field at every derivation and
 * the editor re-derives on every slider drag.
 */
export function boxBlur(field: ScalarField, width: number, height: number, radius: number): ScalarField {
  const span = Math.max(0, Math.round(radius));
  if (span === 0) return field.slice();

  const horizontal = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let offset = -span; offset <= span; offset += 1) {
        sum += sampleClamped(field, width, height, x + offset, y);
      }
      horizontal[y * width + x] = sum / (span * 2 + 1);
    }
  }

  const blurred = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let offset = -span; offset <= span; offset += 1) {
        sum += sampleClamped(horizontal, width, height, x, y + offset);
      }
      blurred[y * width + x] = sum / (span * 2 + 1);
    }
  }
  return blurred;
}

/** A 3x3 Sobel gradient of a scalar field, edges clamped. */
export function sobelGradient(
  field: ScalarField,
  width: number,
  height: number,
): { readonly dx: Float32Array; readonly dy: Float32Array } {
  const dx = new Float32Array(width * height);
  const dy = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tl = sampleClamped(field, width, height, x - 1, y - 1);
      const tc = sampleClamped(field, width, height, x, y - 1);
      const tr = sampleClamped(field, width, height, x + 1, y - 1);
      const ml = sampleClamped(field, width, height, x - 1, y);
      const mr = sampleClamped(field, width, height, x + 1, y);
      const bl = sampleClamped(field, width, height, x - 1, y + 1);
      const bc = sampleClamped(field, width, height, x, y + 1);
      const br = sampleClamped(field, width, height, x + 1, y + 1);
      const index = y * width + x;
      dx[index] = (tr + 2 * mr + br - (tl + 2 * ml + bl)) / 8;
      dy[index] = (bl + 2 * bc + br - (tl + 2 * tc + tr)) / 8;
    }
  }
  return { dx, dy };
}

/** HSV saturation and value of an 0..255 RGB triplet, both 0..1. */
function saturationValue(red: number, green: number, blue: number): { saturation: number; value: number } {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  return { saturation: max <= 0 ? 0 : (max - min) / max, value: max };
}

/**
 * A soft threshold: 0 below `edge - softness`, 1 above `edge + softness`, and a
 * smooth ramp between. Used everywhere a heuristic splits pixels into two
 * populations, because a hard cut produces a jagged one-pixel border in the
 * derived channel that reads as an artefact rather than a decision.
 */
function softStep(value: number, edge: number, softness: number): number {
  const width = Math.max(softness, 1e-4);
  const t = clamp01((value - (edge - width)) / (2 * width));
  return t * t * (3 - 2 * t);
}

// --- Per-channel derivation -------------------------------------------------

/** Luminance of every pixel, 0..1, with transparent pixels marked separately. */
function luminanceField(image: SheetImage): { lum: ScalarField; opaque: Uint8Array } {
  const count = image.width * image.height;
  const lum = new Float32Array(count);
  const opaque = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const base = index * 4;
    if ((image.data[base + 3] ?? 0) < 128) continue;
    opaque[index] = 1;
    lum[index] = luminance(image.data[base] ?? 0, image.data[base + 1] ?? 0, image.data[base + 2] ?? 0);
  }
  return { lum, opaque };
}

/**
 * Relief from luminance.
 *
 * Transparent pixels take the opaque mean rather than zero: a hole has no
 * height, and letting it read as a pit would carve a trench around the sprite's
 * silhouette as soon as the gradient is taken. (The same reasoning, and the same
 * fix, as the Map tab's face relief.)
 */
export function deriveHeight(lum: ScalarField, opaque: Uint8Array, params: MaterialDeriveParams): ScalarField {
  let total = 0;
  let count = 0;
  for (let index = 0; index < lum.length; index += 1) {
    if (opaque[index] !== 1) continue;
    total += lum[index] ?? 0;
    count += 1;
  }
  const mean = count > 0 ? total / count : 0.5;

  const field = new Float32Array(lum.length);
  for (let index = 0; index < lum.length; index += 1) {
    let value = opaque[index] === 1 ? (lum[index] ?? 0) : mean;
    if (params.heightGamma !== 1) value = Math.pow(Math.max(value, 1e-6), params.heightGamma);
    if (params.heightContrast !== 1) value = 0.5 + (value - 0.5) * params.heightContrast;
    if (params.heightInvert >= 0.5) value = 1 - value;
    field[index] = clamp01(value);
  }
  return field;
}

/**
 * Unit normals from the height field, in the editor's screen-space basis.
 *
 * For a height field h(x, y) with y running *down* the image, the surface normal
 * is proportional to (-dh/dx, -dh/dy, 1) in that same basis. The editor's
 * sixteen normal directions are built in the same y-down compass, so the result
 * drops straight into {@link nearestDirection} with no flip.
 */
export function deriveNormal(field: ScalarField, width: number, height: number, strength: number): Float32Array {
  const { dx, dy } = sobelGradient(field, width, height);
  const normals = new Float32Array(width * height * 3);
  for (let index = 0; index < width * height; index += 1) {
    const nx = -(dx[index] ?? 0) * strength;
    const ny = -(dy[index] ?? 0) * strength;
    const length = Math.hypot(nx, ny, 1) || 1;
    const base = index * 3;
    normals[base] = nx / length;
    normals[base + 1] = ny / length;
    normals[base + 2] = 1 / length;
  }
  return normals;
}

/**
 * Cavity occlusion: how far a pixel sits below the surface level around it.
 * 1 is fully open, 0 the deepest crevice. Comparing against a local blur rather
 * than tracing rays is what keeps this affordable per keystroke, and at sprite
 * scale the two are hard to tell apart.
 */
export function deriveOcclusion(
  field: ScalarField,
  width: number,
  height: number,
  params: MaterialDeriveParams,
): ScalarField {
  const local = boxBlur(field, width, height, params.occlusionRadius);
  const occlusion = new Float32Array(field.length);
  for (let index = 0; index < field.length; index += 1) {
    const cavity = clamp01((local[index] ?? 0) - (field[index] ?? 0));
    occlusion[index] = 1 - clamp01(cavity * params.occlusionStrength);
  }
  return occlusion;
}

/**
 * Roughness, as brightness and fine detail imply it: a bright pixel reads as a
 * smoother surface catching more light, and high-frequency texture reads as a
 * rougher one. Cavities roughen on top of that by `occlusionToRoughness`, since
 * a sheltered surface collects what a polished one sheds.
 */
export function deriveRoughness(
  image: SheetImage,
  lum: ScalarField,
  occlusion: ScalarField,
  params: MaterialDeriveParams,
): ScalarField {
  const detailBase = boxBlur(lum, image.width, image.height, 2);
  const roughness = new Float32Array(lum.length);
  for (let index = 0; index < lum.length; index += 1) {
    const base = index * 4;
    const { value } = saturationValue(
      image.data[base] ?? 0,
      image.data[base + 1] ?? 0,
      image.data[base + 2] ?? 0,
    );
    const detail = Math.abs((lum[index] ?? 0) - (detailBase[index] ?? 0));
    // The detail term is small by construction (a local deviation from a blur),
    // so it is scaled up to reach a usable range at the slider's top end.
    const rough =
      params.roughnessBase - value * params.roughnessBrightness + detail * params.roughnessDetail * 10;
    const cavity = (1 - (occlusion[index] ?? 1)) * params.occlusionToRoughness;
    roughness[index] = clamp01(rough + cavity);
  }
  return roughness;
}

/**
 * The metallic mask, read as specular strength: metal is what is desaturated
 * *and* not dark. A saturated colour is pigment, and a near-black grey is more
 * likely a shadow than chrome, so both gates have to pass.
 */
export function deriveSpecular(image: SheetImage, params: MaterialDeriveParams): ScalarField {
  const count = image.width * image.height;
  const specular = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const base = index * 4;
    const { saturation, value } = saturationValue(
      image.data[base] ?? 0,
      image.data[base + 1] ?? 0,
      image.data[base + 2] ?? 0,
    );
    // Saturation gate runs the other way: low saturation is what passes.
    const desaturated = 1 - softStep(saturation, params.metallicSaturation, params.metallicSoftness);
    const bright = softStep(value, params.metallicBrightness, params.metallicSoftness);
    specular[index] = desaturated * bright;
  }
  return specular;
}

/**
 * Self-emission: the brightest texels glow. The saturation gate exists because
 * "bright" alone cannot tell a neon sign from a white highlight — raise it and
 * only coloured light sources survive.
 */
export function deriveEmissive(image: SheetImage, lum: ScalarField, params: MaterialDeriveParams): ScalarField {
  const emissive = new Float32Array(lum.length);
  for (let index = 0; index < lum.length; index += 1) {
    let mask = softStep(lum[index] ?? 0, params.emissiveThreshold, params.emissiveSoftness);
    if (params.emissiveSaturation > 0) {
      const base = index * 4;
      const { saturation } = saturationValue(
        image.data[base] ?? 0,
        image.data[base + 1] ?? 0,
        image.data[base + 2] ?? 0,
      );
      mask *= clamp01(saturation / params.emissiveSaturation);
    }
    emissive[index] = mask;
  }
  return emissive;
}

/** Run the whole derivation over one RGBA image. */
export function deriveMaterials(image: SheetImage, params: MaterialDeriveParams): DerivedMaterials {
  const { lum, opaque } = luminanceField(image);
  const heightField = deriveHeight(lum, opaque, params);
  const normal = deriveNormal(heightField, image.width, image.height, params.normalStrength);
  const occlusion = deriveOcclusion(heightField, image.width, image.height, params);
  return {
    width: image.width,
    height: image.height,
    heightField,
    normal,
    occlusion,
    specular: deriveSpecular(image, params),
    roughness: deriveRoughness(image, lum, occlusion, params),
    emissive: deriveEmissive(image, lum, params),
    opaque,
  };
}

// --- Writing back into the cart ---------------------------------------------

/** A 0..1 value as one of the cart's `MATERIAL_LEVELS` steps. */
export function quantizeLevel(value: number, levels: number = MATERIAL_LEVELS): number {
  return Math.max(0, Math.min(levels - 1, Math.round(clamp01(value) * (levels - 1))));
}

/**
 * The cart channels a derivation can be written into — every {@link
 * DerivedChannel} except `occlusion`, which the cart has no bank for and which
 * therefore reaches the art only through its contribution to roughness.
 */
export const DERIVABLE_CHANNELS: readonly MaterialChannel[] = [
  "normal",
  "height",
  "specular",
  "roughness",
  "emissive",
];

/** Where one tile's worth of derived material is written. */
export interface MaterialTarget {
  readonly page: SpritePage;
  /** Tile index of the block's top-left tile. */
  readonly tile: number;
  /** Block size in tiles; 1x1 for a single sprite. */
  readonly tilesWide: number;
  readonly tilesHigh: number;
  /** Pixels per tile edge and tiles per sheet row — the sheet's own geometry. */
  readonly tileSize: number;
  readonly sheetCols: number;
}

/** Something that stores a per-pixel normal direction — {@link NormalMap} does. */
export interface NormalWriter {
  setDirection(page: SpritePage, tile: number, x: number, y: number, direction: number): void;
}

/** Something that stores a per-pixel scalar level — {@link MaterialMap} does. */
export interface LevelWriter {
  setValue(page: SpritePage, tile: number, x: number, y: number, value: number): void;
}

/**
 * Where each channel is written.
 *
 * Structural rather than the engine itself, so the caller supplies the same
 * {@link NormalMap}/{@link MaterialMap} views it already holds for painting.
 * That keeps this module ignorant of the engine, and it makes "which channels
 * exist" a property of what the caller passed rather than a second list to keep
 * in step with the first.
 */
export interface MaterialWriters {
  readonly normal?: NormalWriter;
  readonly height?: LevelWriter;
  readonly specular?: LevelWriter;
  readonly roughness?: LevelWriter;
  readonly emissive?: LevelWriter;
}

/**
 * Write derived channels into the cart.
 *
 * Only the channels named in `channels` *and* backed by a writer are touched,
 * and transparent source pixels are skipped entirely: a derivation is a starting
 * point laid over the artist's work, so it must never overwrite a channel the
 * artist did not ask it to, and must never invent material for a pixel that is
 * not there.
 *
 * Returns how many pixels were written, so the UI can report the result rather
 * than claiming success on a fully transparent block.
 */
export function applyDerivedMaterials(
  derived: DerivedMaterials,
  writers: MaterialWriters,
  target: MaterialTarget,
  channels: readonly MaterialChannel[],
): number {
  const active = channels.filter((channel) => writers[channel] !== undefined);
  if (active.length === 0) return 0;

  const { tileSize, sheetCols } = target;
  const originX = (target.tile % sheetCols) * tileSize;
  const originY = Math.floor(target.tile / sheetCols) * tileSize;
  const blockWidth = Math.min(derived.width, target.tilesWide * tileSize);
  const blockHeight = Math.min(derived.height, target.tilesHigh * tileSize);

  let written = 0;
  for (let y = 0; y < blockHeight; y += 1) {
    for (let x = 0; x < blockWidth; x += 1) {
      const index = y * derived.width + x;
      if (derived.opaque[index] !== 1) continue;

      const canvasX = originX + x;
      const canvasY = originY + y;
      const tile = Math.floor(canvasY / tileSize) * sheetCols + Math.floor(canvasX / tileSize);
      const pixelX = canvasX % tileSize;
      const pixelY = canvasY % tileSize;

      for (const channel of active) {
        if (channel === "normal") {
          const base = index * 3;
          const direction = nearestDirection([
            derived.normal[base] ?? 0,
            derived.normal[base + 1] ?? 0,
            derived.normal[base + 2] ?? 1,
          ]);
          writers.normal?.setDirection(target.page, tile, pixelX, pixelY, direction % NORMAL_DIRECTION_COUNT);
        } else {
          const writer = writers[channel];
          writer?.setValue(target.page, tile, pixelX, pixelY, quantizeLevel(fieldFor(derived, channel)[index] ?? 0));
        }
      }
      written += 1;
    }
  }
  return written;
}

/** The scalar field backing a cart channel. `normal` is not scalar and is handled apart. */
function fieldFor(derived: DerivedMaterials, channel: Exclude<MaterialChannel, "normal">): ScalarField {
  switch (channel) {
    case "height":
      return derived.heightField;
    case "specular":
      return derived.specular;
    case "roughness":
      return derived.roughness;
    case "emissive":
      return derived.emissive;
  }
}
