/**
 * A material's link to its parent in the cart's material library
 * (EDITOR_PRO_ROADMAP.md P1b; see materialInstances.ts): which fields an
 * instance inherits, and reading a stored link. Kept apart from
 * materialInstances.ts so MeshAsset.ts can read links without an import cycle.
 *
 * Pure and DOM-free.
 */

import type { MeshMaterial } from "./MeshAsset";

/** A material field an instance can take from its parent or override. */
export type InstanceField = Exclude<keyof MeshMaterial, "name" | "instance" | "lightmapImage" | "lightmapHdrImage" | "textureSprite" | "octahedral">;

/** Every field an instance inherits, in the order the material panel lists them, with a label. */
export const INSTANCE_FIELDS = [
  ["baseColorFactor", "Base colour"],
  ["baseColorImage", "Base colour map"],
  ["normalImage", "Normal map"],
  ["materialImage", "Material map (fantasy)"],
  ["metallicRoughnessImage", "Metal / roughness map"],
  ["occlusionImage", "Occlusion map"],
  ["emissiveImage", "Emissive map"],
  ["metallicFactor", "Metallic"],
  ["roughnessFactor", "Roughness"],
  ["emissiveFactor", "Emissive colour"],
  ["tintable", "Team colour"],
  ["tintMix", "Team colour mix"],
  ["tintMaskImage", "Team-colour mask"],
  ["detailImage", "Detail map"],
  ["detailScale", "Detail scale"],
  ["detailStrength", "Detail strength"],
  ["emissiveScroll", "Emissive scroll"],
  ["emissivePulse", "Emissive pulse"],
  ["rim", "Rim light"],
  ["reflectivity", "Reflectivity"],
  ["reflectionMask", "Reflection mask"],
  ["blendImage", "Blend surface map"],
  ["blendColor", "Blend surface colour"],
  ["blendRoughness", "Blend surface roughness"],
  ["clearcoat", "Clearcoat"],
  ["clearcoatRoughness", "Clearcoat roughness"],
  ["anisotropy", "Anisotropy"],
  ["anisotropyRotation", "Anisotropy rotation"],
  ["sheenColor", "Sheen colour"],
  ["sheenRoughness", "Sheen roughness"],
  ["transmission", "Transmission"],
  ["thickness", "Thickness"],
  ["attenuationDistance", "Attenuation distance"],
  ["attenuationColor", "Attenuation colour"],
  ["ior", "Index of refraction"],
  ["specularFactor", "Specular"],
  ["specularColor", "Specular colour"],
  ["iridescence", "Iridescence"],
  ["iridescenceIor", "Iridescence IOR"],
  ["iridescenceThickness", "Iridescence thickness"],
  ["emissiveStrength", "Emissive strength"],
  ["uvTransform", "UV transform"],
  ["subsurface", "Subsurface"],
  ["subsurfaceColor", "Subsurface colour"],
  ["subsurfaceRadius", "Subsurface radius"],
  ["diffuseTransmission", "Diffuse transmission"],
  ["diffuseTransmissionColor", "Diffuse transmission colour"],
  ["character", "Character shading"],
  ["reliefImage", "Relief map"],
  ["parallaxDepth", "Parallax depth"],
  ["refraction", "Refraction"],
  ["distortion", "Distortion"],
  ["water", "Water"],
  ["generator", "Generated maps"],
  ["triplanar", "Triplanar"],
  ["blendSharpness", "Height blend"],
  ["macro", "Macro variation"],
  ["farTile", "Distance tiling"],
  ["alphaMode", "Alpha mode"],
  ["alphaCutoff", "Alpha cutoff"],
  ["softDepth", "Soft edges"],
  ["graph", "Node graph"],
  ["graphSwitches", "Static switches"],
  ["graphImages", "Graph images"],
  ["smartStack", "Smart material"],
] as const satisfies readonly (readonly [InstanceField, string])[];

// Every inheritable field is listed (a new material field must be added above).
type Unlisted = Exclude<InstanceField, (typeof INSTANCE_FIELDS)[number][0]>;
const everyFieldListed: [Unlisted] extends [never] ? true : Unlisted = true;
void everyFieldListed;

const FIELDS: ReadonlySet<string> = new Set(INSTANCE_FIELDS.map(([field]) => field));

/** A material's link to its parent in the cart's library. */
export interface MaterialInstanceLink {
  /** The parent's library id. */
  readonly of: string;
  /** The fields this instance sets itself, in {@link INSTANCE_FIELDS} order. */
  readonly overrides: readonly InstanceField[];
}

/** Whether `field` is one an instance inherits. */
export function isInstanceField(field: unknown): field is InstanceField {
  return typeof field === "string" && FIELDS.has(field);
}

/** Read a stored link defensively (unknown and repeated overrides dropped, kept in canonical order), or undefined. */
export function readInstanceLink(value: unknown): MaterialInstanceLink | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { of?: unknown; overrides?: unknown };
  if (typeof raw.of !== "string" || raw.of.length === 0 || raw.of.length > 64) return undefined;
  const given = new Set(Array.isArray(raw.overrides) ? raw.overrides.filter(isInstanceField) : []);
  return { of: raw.of, overrides: INSTANCE_FIELDS.map(([field]) => field).filter((field) => given.has(field)) };
}
