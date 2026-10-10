/**
 * Texture painting (LOCKOUT_MULTIPLAYER_ROADMAP.md L17): a brush painting
 * through a primitive's UVs into its material's maps — base colour,
 * roughness and metal (the packed metallic-roughness map's green and blue),
 * emissive, and the team-colour mask — and the mask applied at runtime.
 *
 * A layer is painted into an RGBA image the editor keeps while a stroke
 * lasts; when the stroke ends it is saved as a PNG in the material's slot. A
 * layer with no map yet starts from the material's own values, so the first
 * dab changes only what it touches: a base colour map starts as the base
 * colour (and the colour factor goes to white, so what is painted is what
 * shows; on a tintable part it starts white, the team colour still tinting
 * it), a metal-roughness map as the metal and roughness factors (which go
 * to 1), an emissive map as the emissive colour (factor 1), and a team mask
 * as the part's tint mix (which goes to 1, the mask taking its place).
 *
 * Texels are addressed as the rasteriser samples them: u across, row
 * (1 − v)·height down. Pure and DOM-free.
 */

import type { EncodedImage, MeshMaterial, MeshPrimitive } from "./MeshAsset";
import { encodeRgbaPng } from "./png";
import type { DecodedTexture } from "../render/meshRasterizer";

export type TexturePaintLayer = "baseColor" | "roughness" | "metal" | "emissive" | "teamMask";

/** The layers, the material slot each paints into, and the channels it writes (0 R, 1 G, 2 B). */
export const PAINT_LAYERS: readonly { readonly id: TexturePaintLayer; readonly label: string; readonly slot: "baseColorImage" | "metallicRoughnessImage" | "emissiveImage" | "tintMaskImage"; readonly channels: readonly number[] }[] = [
  { id: "baseColor", label: "Base colour", slot: "baseColorImage", channels: [0, 1, 2] },
  { id: "roughness", label: "Roughness", slot: "metallicRoughnessImage", channels: [1] },
  { id: "metal", label: "Metal", slot: "metallicRoughnessImage", channels: [2] },
  { id: "emissive", label: "Emissive", slot: "emissiveImage", channels: [0, 1, 2] },
  { id: "teamMask", label: "Team colour", slot: "tintMaskImage", channels: [0, 1, 2] },
];

export const paintLayer = (id: TexturePaintLayer) => PAINT_LAYERS.find((l) => l.id === id)!;

/** A paintable RGBA image (its pixels change in place as it is painted). */
export interface PaintImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * A fresh map for a layer the material has none of, filled with what the
 * material shows there now, and the patch that hands the material's own
 * value over to the map (so nothing changes until it is painted).
 */
export function blankLayer(material: MeshMaterial, layer: TexturePaintLayer, size = 512): { image: PaintImage; patch: Partial<MeshMaterial> } {
  const n = Math.max(4, Math.min(4096, Math.round(size)));
  const data = new Uint8ClampedArray(n * n * 4);
  let fill: [number, number, number, number];
  let patch: Partial<MeshMaterial> = {};
  const [r, g, b, a] = material.baseColorFactor;
  if (layer === "baseColor") {
    if (material.tintable) fill = [255, 255, 255, 255];
    else {
      fill = [byte(r), byte(g), byte(b), 255];
      patch = { baseColorFactor: [1, 1, 1, a] };
    }
  } else if (layer === "roughness" || layer === "metal") {
    // glTF's packing: G roughness, B metal (R unused, white).
    fill = [255, byte(material.roughnessFactor ?? 1), byte(material.metallicFactor ?? 1), 255];
    patch = { metallicFactor: 1, roughnessFactor: 1 };
  } else if (layer === "emissive") {
    const e = material.emissiveFactor ?? [0, 0, 0];
    const peak = Math.max(1, e[0], e[1], e[2]);
    fill = [byte(e[0] / peak), byte(e[1] / peak), byte(e[2] / peak), 255];
    patch = { emissiveFactor: [peak, peak, peak] };
  } else {
    const k = byte(material.tintMix ?? 1);
    fill = [k, k, k, 255];
    patch = { tintable: true, tintMix: undefined };
  }
  for (let i = 0; i < n * n; i += 1) data.set(fill, i * 4);
  return { image: { width: n, height: n, data }, patch };
}

/** The texel a UV falls in (wrapping, as the sampler does). */
export function texelOf(image: { width: number; height: number }, uv: readonly [number, number]): [number, number] {
  const wrap = (x: number) => x - Math.floor(x);
  return [Math.min(image.width - 1, Math.floor(wrap(uv[0]) * image.width)), Math.min(image.height - 1, Math.floor(wrap(1 - uv[1]) * image.height))];
}

/** A point of a triangle (barycentric weights) in UV space, or null when the primitive has no UVs. */
export function surfaceUv(p: MeshPrimitive, triangle: number, barycentric: readonly [number, number, number]): [number, number] | null {
  if (!p.uvs) return null;
  let u = 0, v = 0;
  for (let c = 0; c < 3; c += 1) {
    const i = p.indices[triangle * 3 + c]!;
    u += p.uvs[i * 2]! * barycentric[c]!;
    v += p.uvs[i * 2 + 1]! * barycentric[c]!;
  }
  return [u, v];
}

export interface PaintBrush {
  /** Radius in texels. */
  readonly radius: number;
  /** How much one dab covers at its centre, 0..1. */
  readonly opacity: number;
  /** How much of the radius paints at full opacity before it fades, 0..1 (default 0.5). */
  readonly hardness?: number;
}

/**
 * One dab of the brush into a layer's image at a UV: each texel whose centre
 * is within the radius moves toward `value` (RGB 0..1; the scalar layers
 * read its first component) by the opacity, fading past the hard core.
 * Only the layer's channels change. Returns the texels touched (an
 * inclusive rectangle), or null when none were.
 */
export function paintTexels(image: PaintImage, layer: TexturePaintLayer, uv: readonly [number, number], value: readonly number[], brush: PaintBrush): { x0: number; y0: number; x1: number; y1: number } | null {
  const cx = (uv[0] - Math.floor(uv[0])) * image.width;
  const cy = (1 - uv[1] - Math.floor(1 - uv[1])) * image.height;
  const r = Math.max(0.5, brush.radius);
  const hard = Math.max(0, Math.min(1, brush.hardness ?? 0.5));
  const opacity = Math.max(0, Math.min(1, brush.opacity));
  const { channels } = paintLayer(layer);
  // The value per channel written: the scalar layers' one value lands in their channel; the mask is grey.
  const target = layer === "roughness" || layer === "metal" ? [value[0]!, value[0]!, value[0]!] : layer === "teamMask" ? [value[0]!, value[0]!, value[0]!] : [value[0]!, value[1]!, value[2]!];
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(image.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(image.height - 1, Math.ceil(cy + r));
  let touched = false;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d > 1) continue;
      const fade = d <= hard ? 1 : 1 - (d - hard) / Math.max(1e-6, 1 - hard);
      const k = opacity * fade * fade * (3 - 2 * fade);
      if (k <= 0) continue;
      const o = (y * image.width + x) * 4;
      for (const c of channels) image.data[o + c] = Math.round(image.data[o + c]! + (byte(target[c]!) - image.data[o + c]!) * k);
      image.data[o + 3] = 255;
      touched = true;
    }
  }
  return touched ? { x0, y0, x1, y1 } : null;
}

/** A layer's value at a texel (0..1): RGB for colour layers, one value for the others. */
export function layerValue(image: PaintImage, layer: TexturePaintLayer, x: number, y: number): number[] {
  const o = (y * image.width + x) * 4;
  return paintLayer(layer).channels.map((c) => image.data[o + c]! / 255);
}

/** A painted image as the PNG a material slot keeps. */
export function encodePaintImage(image: PaintImage): EncodedImage {
  return { mime: "image/png", bytes: encodeRgbaPng(image.data, image.width, image.height, { compress: true }) };
}

/** A decoded texture copied into a paintable image. */
export function paintImageFrom(texture: DecodedTexture): PaintImage {
  return { width: texture.width, height: texture.height, data: new Uint8ClampedArray(texture.data) };
}

/**
 * The base colour a team-colour mask gives a tinted part (the player's
 * runtime half of the mask): each texel's colour is its own base colour
 * mixed toward the team colour by the mask's red × `mix`, times the base
 * colour map's texel where there is one (at the base map's size, else the
 * mask's). The part then draws with a white colour factor.
 */
export function tintMaskTexture(
  base: DecodedTexture | null,
  mask: DecodedTexture,
  baseColor: readonly [number, number, number],
  tint: readonly [number, number, number],
  mix = 1,
): DecodedTexture {
  const width = base?.width ?? mask.width, height = base?.height ?? mask.height;
  const data = new Uint8ClampedArray(width * height * 4);
  const k = Math.max(0, Math.min(1, mix));
  for (let y = 0; y < height; y += 1) {
    const my = Math.min(mask.height - 1, Math.floor(((y + 0.5) / height) * mask.height));
    for (let x = 0; x < width; x += 1) {
      const mx = Math.min(mask.width - 1, Math.floor(((x + 0.5) / width) * mask.width));
      const m = (mask.data[(my * mask.width + mx) * 4]! / 255) * k;
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c += 1) {
        const colour = baseColor[c]! + (tint[c]! - baseColor[c]!) * m;
        data[o + c] = Math.round((base ? base.data[o + c]! : 255) * colour);
      }
      data[o + 3] = base ? base.data[o + 3]! : 255;
    }
  }
  return { width, height, data };
}
