/**
 * The full material set (AAA_FIDELITY_ROADMAP.md F1d): what glTF's KHR
 * material extensions add over metal/roughness, each one read and written as
 * its extension says.
 *
 * - **Sheen** (KHR_materials_sheen): a soft retro-reflective lobe for cloth and
 *   velvet, the Charlie distribution (Estevez & Kulla 2017) with Neubelt's
 *   visibility. The base beneath keeps what the sheen doesn't reflect.
 * - **Transmission and volume** (KHR_materials_transmission, _volume): a
 *   dielectric that lets the light behind it through rather than diffusing
 *   it, tinted by Beer–Lambert absorption over its thickness.
 * - **IOR and specular** (KHR_materials_ior, _specular): a dielectric's
 *   reflectance at normal incidence from its index of refraction, scaled and
 *   tinted by its specular factor and colour. IOR 1.5 and a specular of 1 give
 *   the 4% every material had before.
 * - **Iridescence** (KHR_materials_iridescence): a thin film over the base
 *   whose interference shifts the Fresnel's colour with the angle (Belcour &
 *   Barla 2017, as glTF's sample viewer evaluates it).
 * - **Emissive strength** (KHR_materials_emissive_strength): the emission's
 *   factor past 1, in linear light.
 * - **Texture transforms** (KHR_texture_transform): offset, rotation and scale
 *   of the UVs. glTF gives each texture its own; the engine keeps one for the
 *   material, the base colour map's (or the first a material's maps carry),
 *   applied to every map.
 *
 * Colours are linear, as the extensions store them. The functions here mirror
 * the AAA shader's (and the path-traced reference's) term for term.
 */

import type { MeshMaterial } from "./MeshAsset";
import { readCharacterShading, resolveCharacter, type CharacterShading, type ResolvedCharacter } from "./characterShading";

export type Rgb = readonly [number, number, number];

/** A material's UV transform, in glTF's UV space (V down from the image's top). */
export interface UvTransform {
  readonly offset: readonly [number, number];
  /** Radians. */
  readonly rotation: number;
  readonly scale: readonly [number, number];
}

/** The extension fields, as {@link MeshMaterial} carries them. */
export type MaterialExtensions = Pick<
  MeshMaterial,
  | "sheenColor"
  | "sheenRoughness"
  | "transmission"
  | "thickness"
  | "attenuationDistance"
  | "attenuationColor"
  | "ior"
  | "specularFactor"
  | "specularColor"
  | "iridescence"
  | "iridescenceIor"
  | "iridescenceThickness"
  | "emissiveStrength"
  | "uvTransform"
  | "subsurface"
  | "subsurfaceColor"
  | "subsurfaceRadius"
  | "diffuseTransmission"
  | "diffuseTransmissionColor"
  | "character"
>;

/** A dielectric's index when a material doesn't say (glTF's default). */
export const DEFAULT_IOR = 1.5;
/** A thin film's index and thickness (nm) when a material doesn't say (glTF's defaults; its thickness the range's top). */
export const DEFAULT_IRIDESCENCE_IOR = 1.3;
export const DEFAULT_IRIDESCENCE_THICKNESS = 400;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const rgb = (v: unknown, hi = 1): Rgb | undefined =>
  Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every(finite) ? [clamp(v[0], 0, hi), clamp(v[1], 0, hi), clamp(v[2], 0, hi)] : undefined;

/** Read a stored material's extension fields, clamping each and dropping anything malformed or neutral. */
export function readMaterialExtensions(raw: Record<string, unknown> | object): MaterialExtensions {
  const r = raw as Record<string, unknown>;
  const out: { -readonly [K in keyof MaterialExtensions]: MaterialExtensions[K] } = {};
  const sheen = rgb(r.sheenColor);
  if (sheen && Math.max(...sheen) > 0) {
    out.sheenColor = sheen;
    if (finite(r.sheenRoughness)) out.sheenRoughness = clamp(r.sheenRoughness, 0, 1);
  }
  if (finite(r.transmission) && r.transmission > 0) out.transmission = clamp(r.transmission, 0, 1);
  if (finite(r.thickness) && r.thickness > 0) out.thickness = Math.min(r.thickness, 100);
  if (finite(r.attenuationDistance) && r.attenuationDistance > 0) out.attenuationDistance = r.attenuationDistance;
  const attenuation = rgb(r.attenuationColor);
  if (attenuation && attenuation.some((c) => c < 1)) out.attenuationColor = attenuation;
  if (finite(r.ior) && r.ior !== DEFAULT_IOR) out.ior = r.ior === 0 ? 0 : clamp(r.ior, 1, 5);
  if (finite(r.specularFactor) && r.specularFactor !== 1) out.specularFactor = clamp(r.specularFactor, 0, 1);
  const specular = rgb(r.specularColor, 10);
  if (specular && specular.some((c) => c !== 1)) out.specularColor = specular;
  if (finite(r.iridescence) && r.iridescence > 0) {
    out.iridescence = clamp(r.iridescence, 0, 1);
    if (finite(r.iridescenceIor)) out.iridescenceIor = clamp(r.iridescenceIor, 1, 3);
    if (finite(r.iridescenceThickness)) out.iridescenceThickness = clamp(r.iridescenceThickness, 0, 2000);
  }
  if (finite(r.emissiveStrength) && r.emissiveStrength !== 1) out.emissiveStrength = Math.max(0, r.emissiveStrength);
  if (finite(r.subsurface) && r.subsurface > 0) {
    out.subsurface = clamp(r.subsurface, 0, 1);
    const scatter = rgb(r.subsurfaceColor);
    if (scatter) out.subsurfaceColor = scatter;
    if (finite(r.subsurfaceRadius) && r.subsurfaceRadius > 0) out.subsurfaceRadius = Math.min(r.subsurfaceRadius, 1);
  }
  if (finite(r.diffuseTransmission) && r.diffuseTransmission > 0) {
    out.diffuseTransmission = clamp(r.diffuseTransmission, 0, 1);
    const tint = rgb(r.diffuseTransmissionColor);
    if (tint && tint.some((c) => c !== 1)) out.diffuseTransmissionColor = tint;
  }
  const character = readCharacterShading(r.character);
  if (character) out.character = character;
  const t = r.uvTransform as Record<string, unknown> | undefined;
  if (t && typeof t === "object") {
    const offset = Array.isArray(t.offset) && t.offset.length >= 2 && t.offset.slice(0, 2).every(finite) ? ([t.offset[0], t.offset[1]] as [number, number]) : ([0, 0] as [number, number]);
    const scale = Array.isArray(t.scale) && t.scale.length >= 2 && t.scale.slice(0, 2).every(finite) ? ([t.scale[0], t.scale[1]] as [number, number]) : ([1, 1] as [number, number]);
    const rotation = finite(t.rotation) ? t.rotation : 0;
    if (offset[0] !== 0 || offset[1] !== 0 || scale[0] !== 1 || scale[1] !== 1 || rotation !== 0) out.uvTransform = { offset, rotation, scale };
  }
  return out;
}

/** The extension fields in stored form (only those a material sets). */
export function writeMaterialExtensions(material: MeshMaterial): Record<string, unknown> {
  return { ...readMaterialExtensions(material) };
}

/** Whether a material sets any of them, which (like a layer) puts it on the PBR path. */
export function materialHasExtensions(material: object): boolean {
  return Object.keys(readMaterialExtensions(material)).length > 0;
}

/** A material's extensions as a draw applies them, every one resolved to a value. */
export interface ResolvedExtensions {
  readonly sheenColor: Rgb;
  readonly sheenRoughness: number;
  readonly transmission: number;
  /** Metres; 0 is thin-walled (no bend). */
  readonly thickness: number;
  /** Metres; 0 is no absorption. */
  readonly attenuationDistance: number;
  readonly attenuationColor: Rgb;
  /** A dielectric's reflectance at normal incidence, its specular factor and colour applied. */
  readonly dielectricF0: Rgb;
  /** The specular factor alone, which scales the dielectric's Fresnel as a whole. */
  readonly specularFactor: number;
  readonly ior: number;
  readonly iridescence: number;
  readonly iridescenceIor: number;
  /** Nanometres. */
  readonly iridescenceThickness: number;
  readonly emissiveStrength: number;
  readonly uvTransform: UvTransform | null;
  /** The share of the diffuse light that scatters under the surface (F1d-2), how far each channel scatters (metres × colour), and the thin-surface transmission. */
  readonly subsurface: number;
  readonly subsurfaceColor: Rgb;
  readonly subsurfaceRadius: number;
  readonly diffuseTransmission: number;
  readonly diffuseTransmissionColor: Rgb;
  /** Character shading (F7c), every field resolved, or null. */
  readonly character: ResolvedCharacter | null;
}

/** Skin's scatter by channel when a material doesn't say (red farthest), and its radius in metres (about 1.2 cm). */
export const DEFAULT_SUBSURFACE_COLOR: Rgb = [1, 0.37, 0.18];
export const DEFAULT_SUBSURFACE_RADIUS = 0.012;

/** The reflectance at normal incidence of an interface between indices `n1` and `n2`. */
export function iorToF0(n2: number, n1 = 1): number {
  return ((n2 - n1) / (n2 + n1)) ** 2;
}

/** Resolve a material's extensions (defaults where it sets none). */
export function resolveExtensions(material: MeshMaterial): ResolvedExtensions {
  const e = readMaterialExtensions(material);
  const ior = e.ior ?? DEFAULT_IOR;
  const factor = e.specularFactor ?? 1;
  const tint = e.specularColor ?? [1, 1, 1];
  // An IOR of 0 is glTF's "infinite": a full reflector.
  const base = ior === 0 ? 1 : iorToF0(ior);
  return {
    sheenColor: e.sheenColor ?? [0, 0, 0],
    sheenRoughness: e.sheenRoughness ?? 0,
    transmission: e.transmission ?? 0,
    thickness: e.thickness ?? 0,
    attenuationDistance: e.attenuationDistance ?? 0,
    attenuationColor: e.attenuationColor ?? [1, 1, 1],
    dielectricF0: [Math.min(1, base * tint[0]) * factor, Math.min(1, base * tint[1]) * factor, Math.min(1, base * tint[2]) * factor],
    specularFactor: factor,
    ior,
    iridescence: e.iridescence ?? 0,
    iridescenceIor: e.iridescenceIor ?? DEFAULT_IRIDESCENCE_IOR,
    iridescenceThickness: e.iridescenceThickness ?? DEFAULT_IRIDESCENCE_THICKNESS,
    emissiveStrength: e.emissiveStrength ?? 1,
    uvTransform: e.uvTransform ?? null,
    subsurface: e.subsurface ?? 0,
    subsurfaceColor: e.subsurfaceColor ?? DEFAULT_SUBSURFACE_COLOR,
    subsurfaceRadius: e.subsurfaceRadius ?? DEFAULT_SUBSURFACE_RADIUS,
    diffuseTransmission: e.diffuseTransmission ?? 0,
    diffuseTransmissionColor: e.diffuseTransmissionColor ?? [1, 1, 1],
    character: resolveCharacter(e),
  };
}

/**
 * A UV through a transform, in the engine's UV space (V up; glTF's V flipped
 * on import): into glTF's, offset + rotation · (scale × uv), and back. The
 * rotation turns (u, v) to (c·u + s·v, −s·u + c·v), as three.js and Blender
 * read the extension.
 */
export function transformUv(u: number, v: number, t: UvTransform | null): [number, number] {
  if (!t) return [u, v];
  const gu = u * t.scale[0];
  const gv = (1 - v) * t.scale[1];
  const c = Math.cos(t.rotation);
  const s = Math.sin(t.rotation);
  return [c * gu + s * gv + t.offset[0], 1 - (-s * gu + c * gv + t.offset[1])];
}

/** The Charlie sheen distribution (Estevez & Kulla) for a sheen roughness `r`. */
export function charlieD(r: number, ndh: number): number {
  const alpha = Math.max(1e-3, r * r);
  const inv = 1 / alpha;
  const sin2 = Math.max(0, 1 - ndh * ndh);
  return ((2 + inv) * sin2 ** (inv * 0.5)) / (2 * Math.PI);
}

/** Neubelt's sheen visibility. */
export function neubeltV(ndl: number, ndv: number): number {
  return 1 / (4 * (ndl + ndv - ndl * ndv) + 1e-6);
}

/** The sheen's directional albedo at N·V for roughness `r`: what it reflects of uniform light (the base keeps 1 − max(sheen colour) × it). */
export function sheenAlbedo(ndv: number, r: number, samples = 256): number {
  // Uniform over the hemisphere, V in the xz plane.
  const vx = Math.sqrt(Math.max(0, 1 - ndv * ndv));
  let sum = 0;
  const n = Math.round(Math.sqrt(samples));
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      const z = (i + 0.5) / n;
      const phi = (2 * Math.PI * (j + 0.5)) / n;
      const rr = Math.sqrt(1 - z * z);
      const lx = rr * Math.cos(phi);
      const ly = rr * Math.sin(phi);
      const hx = lx + vx;
      const hy = ly;
      const hz = z + ndv;
      const hl = Math.hypot(hx, hy, hz) || 1;
      sum += charlieD(r, hz / hl) * neubeltV(z, ndv) * z * 2 * Math.PI;
    }
  }
  return Math.min(1, sum / (n * n));
}

/** Schlick's Fresnel. */
const schlick = (f0: number, c: number) => f0 + (1 - f0) * (1 - c) ** 5;

/** XYZ (spectral sensitivity's Fourier form) to linear Rec. 709, as glTF's sample viewer evaluates thin films. */
function sensitivity(opd: number, shift: Rgb): [number, number, number] {
  const phase = 2 * Math.PI * opd * 1e-9;
  const val = [5.4856e-13, 4.4201e-13, 5.2481e-13];
  const pos = [1.681e6, 1.7953e6, 2.2084e6];
  const vr = [4.3278e9, 9.3046e9, 6.6121e9];
  const xyz = [0, 1, 2].map((i) => val[i]! * Math.sqrt(2 * Math.PI * vr[i]!) * Math.cos(pos[i]! * phase + shift[i]!) * Math.exp(-phase * phase * vr[i]!));
  xyz[0] = xyz[0]! + 9.747e-14 * Math.sqrt(2 * Math.PI * 4.5282e9) * Math.cos(2.2399e6 * phase + shift[0]) * Math.exp(-4.5282e9 * phase * phase);
  const [x, y, z] = xyz.map((c) => c / 1.0685e-7) as [number, number, number];
  return [3.2404542 * x - 1.5371385 * y - 0.4985314 * z, -0.969266 * x + 1.8760108 * y + 0.041556 * z, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z];
}

/**
 * A thin film's Fresnel (Belcour & Barla, as glTF's sample viewer has it):
 * light at `cos1` from the outside medium (index `outside`) through a film of
 * index `filmIor` and `thickness` nm over a base of reflectance `baseF0`.
 */
export function iridescenceFresnel(outside: number, filmIor: number, cos1: number, thickness: number, baseF0: Rgb): [number, number, number] {
  const smooth = (x: number) => {
    const t = clamp(x / 0.03, 0, 1);
    return t * t * (3 - 2 * t);
  };
  const film = outside + (filmIor - outside) * smooth(thickness);
  const sin2Sq = (outside / film) ** 2 * (1 - cos1 * cos1);
  const cos2Sq = 1 - sin2Sq;
  if (cos2Sq < 0) return [1, 1, 1];
  const cos2 = Math.sqrt(cos2Sq);
  const r12 = schlick(iorToF0(film, outside), cos1);
  const t121 = 1 - r12;
  const phi12 = film < outside ? Math.PI : 0;
  const phi21 = Math.PI - phi12;
  const out: [number, number, number] = [0, 0, 0];
  const baseIor = baseF0.map((f) => {
    const s = Math.sqrt(clamp(f, 0, 0.9999));
    return (1 + s) / (1 - s);
  });
  const r23 = baseIor.map((n) => schlick(iorToF0(n, film), cos2));
  const phi23 = baseIor.map((n) => (n < film ? Math.PI : 0));
  const opd = 2 * film * thickness * cos2;
  const phi = phi23.map((p) => phi21 + p) as unknown as Rgb;
  const r123 = r23.map((r) => clamp(r12 * r, 1e-5, 0.9999));
  const rs = r23.map((r, i) => (t121 * t121 * r) / (1 - r123[i]!));
  const s1 = sensitivity(opd, phi);
  const s2 = sensitivity(2 * opd, phi.map((p) => 2 * p) as unknown as Rgb);
  for (let i = 0; i < 3; i += 1) {
    const c0 = r12 + rs[i]!;
    let cm = rs[i]! - t121;
    const root = Math.sqrt(r123[i]!);
    cm *= root;
    let total = c0 + cm * 2 * s1[i]!;
    cm *= root;
    total += cm * 2 * s2[i]!;
    out[i] = Math.max(0, total);
  }
  return out;
}

/** Beer–Lambert: what of the light gets through `distance` of a volume whose colour after `attenuationDistance` is `color`. */
export function volumeTransmittance(color: Rgb, attenuationDistance: number, distance: number): [number, number, number] {
  if (!(attenuationDistance > 0) || !(distance > 0)) return [1, 1, 1];
  return [0, 1, 2].map((i) => Math.max(0, color[i]!) ** (distance / attenuationDistance)) as [number, number, number];
}

// --- glTF -----------------------------------------------------------------

/** The glTF material's extension objects these fields come from and go to. */
export interface GltfMaterialExtensions {
  KHR_materials_sheen?: { sheenColorFactor?: number[]; sheenRoughnessFactor?: number };
  KHR_materials_transmission?: { transmissionFactor?: number };
  KHR_materials_volume?: { thicknessFactor?: number; attenuationDistance?: number; attenuationColor?: number[] };
  KHR_materials_ior?: { ior?: number };
  KHR_materials_specular?: { specularFactor?: number; specularColorFactor?: number[] };
  KHR_materials_iridescence?: { iridescenceFactor?: number; iridescenceIor?: number; iridescenceThicknessMinimum?: number; iridescenceThicknessMaximum?: number };
  KHR_materials_emissive_strength?: { emissiveStrength?: number };
  KHR_materials_diffuse_transmission?: { diffuseTransmissionFactor?: number; diffuseTransmissionColorFactor?: number[] };
}

/** Subsurface scattering, which no ratified glTF extension carries: kept in the material's extras (F1d-2). */
export interface GltfSubsurfaceExtras {
  cartboxSubsurface?: { factor?: number; color?: number[]; radius?: number };
  /** Character shading (F7c), as the material stores it. */
  cartboxCharacter?: CharacterShading;
}

/** A texture reference's KHR_texture_transform, as glTF writes it. */
export interface GltfTextureTransform {
  offset?: number[];
  rotation?: number;
  scale?: number[];
  texCoord?: number;
}

/** The fields a glTF material's extensions (and its first texture transform) give. */
export function readGltfMaterialExtensions(extensions: GltfMaterialExtensions | undefined, transform: GltfTextureTransform | undefined, extras?: GltfSubsurfaceExtras): MaterialExtensions {
  const e = extensions ?? {};
  const sheen = e.KHR_materials_sheen;
  const volume = e.KHR_materials_volume;
  const specular = e.KHR_materials_specular;
  const irid = e.KHR_materials_iridescence;
  // glTF's defaults where an extension is present but a field isn't.
  return readMaterialExtensions({
    ...(sheen ? { sheenColor: sheen.sheenColorFactor ?? [0, 0, 0], sheenRoughness: sheen.sheenRoughnessFactor ?? 0 } : {}),
    ...(e.KHR_materials_transmission ? { transmission: e.KHR_materials_transmission.transmissionFactor ?? 0 } : {}),
    ...(volume ? { thickness: volume.thicknessFactor ?? 0, attenuationDistance: volume.attenuationDistance, attenuationColor: volume.attenuationColor } : {}),
    ...(e.KHR_materials_ior ? { ior: e.KHR_materials_ior.ior ?? DEFAULT_IOR } : {}),
    ...(specular ? { specularFactor: specular.specularFactor ?? 1, specularColor: specular.specularColorFactor } : {}),
    ...(irid ? { iridescence: irid.iridescenceFactor ?? 0, iridescenceIor: irid.iridescenceIor ?? DEFAULT_IRIDESCENCE_IOR, iridescenceThickness: irid.iridescenceThicknessMaximum ?? DEFAULT_IRIDESCENCE_THICKNESS } : {}),
    ...(e.KHR_materials_emissive_strength ? { emissiveStrength: e.KHR_materials_emissive_strength.emissiveStrength ?? 1 } : {}),
    ...(transform ? { uvTransform: { offset: transform.offset, rotation: transform.rotation, scale: transform.scale } } : {}),
    ...(e.KHR_materials_diffuse_transmission ? { diffuseTransmission: e.KHR_materials_diffuse_transmission.diffuseTransmissionFactor ?? 0, diffuseTransmissionColor: e.KHR_materials_diffuse_transmission.diffuseTransmissionColorFactor } : {}),
    ...(extras?.cartboxCharacter ? { character: extras.cartboxCharacter } : {}),
    ...(extras?.cartboxSubsurface ? { subsurface: extras.cartboxSubsurface.factor ?? 0, subsurfaceColor: extras.cartboxSubsurface.color, subsurfaceRadius: extras.cartboxSubsurface.radius } : {}),
  });
}

/** A material's extensions as glTF writes them (only those it sets). */
export function writeGltfMaterialExtensions(material: MeshMaterial): GltfMaterialExtensions {
  const e = readMaterialExtensions(material);
  const out: GltfMaterialExtensions = {};
  if (e.sheenColor) out.KHR_materials_sheen = { sheenColorFactor: [...e.sheenColor], sheenRoughnessFactor: e.sheenRoughness ?? 0 };
  if (e.transmission) out.KHR_materials_transmission = { transmissionFactor: e.transmission };
  if (e.thickness || e.attenuationDistance || e.attenuationColor) {
    out.KHR_materials_volume = { thicknessFactor: e.thickness ?? 0, ...(e.attenuationDistance ? { attenuationDistance: e.attenuationDistance } : {}), ...(e.attenuationColor ? { attenuationColor: [...e.attenuationColor] } : {}) };
  }
  if (e.ior !== undefined) out.KHR_materials_ior = { ior: e.ior };
  if (e.specularFactor !== undefined || e.specularColor) out.KHR_materials_specular = { specularFactor: e.specularFactor ?? 1, ...(e.specularColor ? { specularColorFactor: [...e.specularColor] } : {}) };
  if (e.iridescence) out.KHR_materials_iridescence = { iridescenceFactor: e.iridescence, iridescenceIor: e.iridescenceIor ?? DEFAULT_IRIDESCENCE_IOR, iridescenceThicknessMaximum: e.iridescenceThickness ?? DEFAULT_IRIDESCENCE_THICKNESS };
  if (e.emissiveStrength !== undefined) out.KHR_materials_emissive_strength = { emissiveStrength: e.emissiveStrength };
  if (e.diffuseTransmission) out.KHR_materials_diffuse_transmission = { diffuseTransmissionFactor: e.diffuseTransmission, ...(e.diffuseTransmissionColor ? { diffuseTransmissionColorFactor: [...e.diffuseTransmissionColor] } : {}) };
  return out;
}

/** A material's subsurface scattering (F1d-2) and character shading (F7c) as its glTF extras, or nothing. */
export function writeGltfSubsurface(material: MeshMaterial): GltfSubsurfaceExtras | null {
  const e = readMaterialExtensions(material);
  if (!e.subsurface && !e.character) return null;
  return {
    ...(e.subsurface ? { cartboxSubsurface: { factor: e.subsurface, ...(e.subsurfaceColor ? { color: [...e.subsurfaceColor] } : {}), ...(e.subsurfaceRadius ? { radius: e.subsurfaceRadius } : {}) } } : {}),
    ...(e.character ? { cartboxCharacter: e.character } : {}),
  };
}

/** A material's UV transform as each of its texture references writes it, or nothing. */
export function writeGltfTextureTransform(material: MeshMaterial): { KHR_texture_transform: GltfTextureTransform } | null {
  const t = readMaterialExtensions(material).uvTransform;
  return t ? { KHR_texture_transform: { offset: [...t.offset], rotation: t.rotation, scale: [...t.scale] } } : null;
}
