/**
 * Editing material sets and material maps (LOCKOUT_MULTIPLAYER_ROADMAP.md
 * L17): any image slot of a material filled from an uploaded file (or
 * painted, see texturePaint.ts) or cleared, and a mesh's material sets
 * (I13's KHR_materials_variants) made, renamed, removed and edited — a
 * set's material for a part starts as a copy of the part's own the first
 * time it is changed, and can be put back to it.
 *
 * Every edit names the set it applies to; none (null) edits the mesh's own
 * materials. Pure and DOM-free.
 */

import { MAX_MESH_VARIANTS, updateMeshMaterial, type EncodedImage, type MeshAsset, type MeshMaterial } from "./MeshAsset";

/** A material's image slots. */
export type MaterialImageSlot =
  | "baseColorImage"
  | "metallicRoughnessImage"
  | "emissiveImage"
  | "normalImage"
  | "occlusionImage"
  | "tintMaskImage"
  | "reliefImage"
  | "detailImage"
  | "materialImage"
  | "blendImage"
  | "lightmapImage";

/** Every slot an image can be uploaded into, with what it holds. */
export const MATERIAL_IMAGE_SLOTS: readonly { readonly slot: MaterialImageSlot; readonly label: string; readonly hint: string }[] = [
  { slot: "baseColorImage", label: "Base colour", hint: "RGB colour (and alpha), times the base colour" },
  { slot: "metallicRoughnessImage", label: "Metal / roughness", hint: "G roughness, B metal (glTF's packing)" },
  { slot: "emissiveImage", label: "Emissive", hint: "RGB glow, times the emissive colour" },
  { slot: "normalImage", label: "Normal", hint: "Tangent-space normals" },
  { slot: "occlusionImage", label: "Occlusion", hint: "R ambient occlusion" },
  { slot: "tintMaskImage", label: "Team-colour mask", hint: "R how much of the team colour each texel takes" },
  { slot: "reliefImage", label: "Relief", hint: "R height, G curvature (parallax and wear)" },
  { slot: "detailImage", label: "Detail", hint: "Fine grain tiled close up (mid-grey changes nothing)" },
  { slot: "materialImage", label: "Material (fantasy)", hint: "R height, G specular, B roughness, A emissive" },
  { slot: "blendImage", label: "Blend surface", hint: "The second surface blended in per vertex" },
  { slot: "lightmapImage", label: "Light map", hint: "Baked light, on the second UV set" },
];

/** A part's material in a set (null: the mesh's own), falling back to the part's own when the set leaves it be. */
export function materialFor(mesh: MeshAsset, primitive: number, set?: string | null): MeshMaterial | null {
  const own = mesh.primitives[primitive]?.material;
  if (!own) return null;
  if (!set) return own;
  return mesh.variants?.find((v) => v.name === set)?.materials[primitive] ?? own;
}

/** Whether a set has its own material for a part (else the part wears its own). */
export function setHasMaterial(mesh: MeshAsset, set: string, primitive: number): boolean {
  return Boolean(mesh.variants?.find((v) => v.name === set)?.materials[primitive]);
}

/** One part's material patched — its own (no set), or a set's (starting from a copy of its own). */
export function patchMaterial(mesh: MeshAsset, primitive: number, patch: Partial<MeshMaterial>, set?: string | null): MeshAsset {
  if (primitive < 0 || primitive >= mesh.primitives.length) return mesh;
  if (!set) return updateMeshMaterial(mesh, primitive, patch);
  const k = mesh.variants?.findIndex((v) => v.name === set) ?? -1;
  if (k < 0) return mesh;
  const variant = mesh.variants![k]!;
  const from = variant.materials[primitive] ?? mesh.primitives[primitive]!.material;
  const materials = mesh.primitives.map((_, i) => (i === primitive ? { ...from, ...patch } : (variant.materials[i] ?? null)));
  return { ...mesh, variants: mesh.variants!.map((v, i) => (i === k ? { ...v, materials } : v)) };
}

/** An image put in (or, with null, taken out of) a slot of a part's material. */
export function setMaterialImage(mesh: MeshAsset, primitive: number, slot: MaterialImageSlot, image: EncodedImage | null, set?: string | null): MeshAsset {
  return patchMaterial(mesh, primitive, { [slot]: image } as Partial<MeshMaterial>, set);
}

/** A set name not yet on the mesh: `base`, else `base 2`, `base 3` … */
function freeSetName(mesh: MeshAsset, base: string): string {
  const names = new Set((mesh.variants ?? []).map((v) => v.name));
  const name = base.trim().slice(0, 60) || "set";
  if (!names.has(name)) return name;
  for (let n = 2; ; n += 1) if (!names.has(`${name} ${n}`)) return `${name} ${n}`;
}

/**
 * A new material set (refused past {@link MAX_MESH_VARIANTS}): a copy of set
 * `copy`'s materials, or with none, a set that wears every part's own until
 * edited. Returns the mesh and the new set's name.
 */
export function addMaterialSet(mesh: MeshAsset, name: string, copy?: string | null): { mesh: MeshAsset; name: string | null } {
  const sets = mesh.variants ?? [];
  if (sets.length >= MAX_MESH_VARIANTS) return { mesh, name: null };
  const source = copy ? sets.find((v) => v.name === copy) : undefined;
  const fresh = freeSetName(mesh, name);
  const materials = mesh.primitives.map((_, i) => source?.materials[i] ?? null);
  return { mesh: { ...mesh, variants: [...sets, { name: fresh, materials }] }, name: fresh };
}

/** A set renamed (a name already taken gets a number); returns the name it got. */
export function renameMaterialSet(mesh: MeshAsset, from: string, to: string): { mesh: MeshAsset; name: string } {
  const sets = mesh.variants ?? [];
  if (!sets.some((v) => v.name === from) || !to.trim() || to.trim() === from) return { mesh, name: from };
  const others = { ...mesh, variants: sets.filter((v) => v.name !== from) };
  const name = freeSetName(others, to);
  return { mesh: { ...mesh, variants: sets.map((v) => (v.name === from ? { ...v, name } : v)) }, name };
}

/** A set removed. */
export function removeMaterialSet(mesh: MeshAsset, name: string): MeshAsset {
  const sets = mesh.variants ?? [];
  if (!sets.some((v) => v.name === name)) return mesh;
  const rest = sets.filter((v) => v.name !== name);
  if (rest.length > 0) return { ...mesh, variants: rest };
  const { variants: _drop, ...without } = mesh;
  return without;
}

/** A set's part put back to wearing its own material. */
export function resetSetMaterial(mesh: MeshAsset, set: string, primitive: number): MeshAsset {
  const k = mesh.variants?.findIndex((v) => v.name === set) ?? -1;
  if (k < 0) return mesh;
  return { ...mesh, variants: mesh.variants!.map((v, i) => (i === k ? { ...v, materials: v.materials.map((m, j) => (j === primitive ? null : m)) } : v)) };
}
