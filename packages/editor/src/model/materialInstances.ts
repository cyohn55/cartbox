/**
 * Material instances (EDITOR_PRO_ROADMAP.md P1b): Unreal's Material Instances,
 * Unity's material variants. A cart keeps a library of parent materials; a
 * mesh's material can be an instance of one, taking every field from it except
 * the ones it overrides. Editing the parent re-resolves every instance of it,
 * so a dozen rocks share one "canyon stone" and differ only in tint.
 *
 * Each instance keeps a full, resolved copy of its fields, so the player and
 * every other reader of a mesh need no library: only the editor resolves.
 * Generated maps (P1c) are stored as recipes, so the copies cost little.
 *
 * Pure and DOM-free.
 */

import { isGeneratedImage } from "./textureGenerators";
import { withGeneratedMaps, type EncodedImage, type MeshAsset, type MeshMaterial } from "./MeshAsset";
import { INSTANCE_FIELDS, type InstanceField } from "./materialInstanceLink";

export { INSTANCE_FIELDS, isInstanceField, readInstanceLink, type InstanceField, type MaterialInstanceLink } from "./materialInstanceLink";

/** The slots a generator fills: inherited with it unless the instance paints its own. */
const GENERATED_SLOTS = ["baseColorImage", "normalImage", "metallicRoughnessImage", "reliefImage"] as const;

/** One parent material in a cart's library. */
export interface LibraryMaterial {
  readonly id: string;
  readonly material: MeshMaterial;
}

/** A cart's parent materials. */
export type MaterialLibrary = readonly LibraryMaterial[];

/** At most this many parents in a library. */
export const MAX_LIBRARY_MATERIALS = 256;

/** A new library id, unique within `library`, from a material's name. */
export function libraryId(library: MaterialLibrary, name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "material";
  const taken = new Set(library.map((m) => m.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The parent `id` names, or null. */
export function libraryMaterial(library: MaterialLibrary, id: string): MeshMaterial | null {
  return library.find((m) => m.id === id)?.material ?? null;
}

/** A material as a parent: no link of its own and nothing per-object (a light map, a sprite). */
function asParent(material: MeshMaterial): MeshMaterial {
  const { instance: _instance, lightmapImage: _lightmap, lightmapHdrImage: _hdr, textureSprite: _sprite, ...rest } = material;
  void _instance;
  void _lightmap;
  void _hdr;
  void _sprite;
  return rest;
}

/** A field's value on a material, absent fields as undefined. */
const valueOf = (material: MeshMaterial, field: InstanceField): unknown => (material as unknown as Record<string, unknown>)[field];

/**
 * An instance resolved against its parent: every field it doesn't override
 * from the parent; its name, light map, sprite link and overrides its own.
 * When it overrides the generator, the maps the parent's generator made are
 * baked again from its own recipe (slots it painted itself are kept).
 */
export function resolveInstance(material: MeshMaterial, parent: MeshMaterial): MeshMaterial {
  const link = material.instance;
  if (!link) return material;
  const own = new Set<string>(link.overrides);
  const out: Record<string, unknown> = {};
  for (const [field] of INSTANCE_FIELDS) {
    const value = own.has(field) ? valueOf(material, field) : valueOf(parent, field);
    if (value !== undefined) out[field] = value;
  }
  out.name = material.name;
  out.instance = link;
  if (material.lightmapImage !== undefined) out.lightmapImage = material.lightmapImage;
  if (material.lightmapHdrImage !== undefined) out.lightmapHdrImage = material.lightmapHdrImage;
  if (material.textureSprite !== undefined) out.textureSprite = material.textureSprite;
  if (out.baseColorFactor === undefined) out.baseColorFactor = material.baseColorFactor;
  if (out.baseColorImage === undefined) out.baseColorImage = null;
  let resolved = out as unknown as MeshMaterial;
  if (own.has("generator") && resolved.generator) {
    const fresh: Record<string, EncodedImage | null> = {};
    for (const slot of GENERATED_SLOTS) if (!own.has(slot) && isGeneratedImage(resolved[slot])) fresh[slot] = null;
    resolved = withGeneratedMaps({ ...resolved, ...fresh });
  }
  return resolved;
}

/** Shallow structural equality of two field values (images by identity, tuples and records by value). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a !== "object" || typeof b !== "object") return false;
  // Images are compared by identity: a new image is a change, however alike its bytes.
  if ("bytes" in a || "bytes" in b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Follow an edit of an instance: every field that changed becomes an override,
 * so a later edit of the parent leaves it alone. Not an instance: unchanged.
 */
export function trackOverrides(before: MeshMaterial, after: MeshMaterial): MeshMaterial {
  const link = after.instance;
  if (!link) return after;
  const own = new Set<string>(link.overrides);
  for (const [field] of INSTANCE_FIELDS) if (!own.has(field) && !sameValue(valueOf(before, field), valueOf(after, field))) own.add(field);
  if (own.size === link.overrides.length) return after;
  return { ...after, instance: { of: link.of, overrides: INSTANCE_FIELDS.map(([field]) => field).filter((field) => own.has(field)) } };
}

/** Make `material` an instance of the library's `id`, inheriting every field (nothing overridden). */
export function instanceOf(material: MeshMaterial, id: string, parent: MeshMaterial): MeshMaterial {
  return resolveInstance({ ...material, instance: { of: id, overrides: [] } }, parent);
}

/** Put one overridden field back to the parent's. */
export function revertOverride(material: MeshMaterial, field: InstanceField, parent: MeshMaterial): MeshMaterial {
  const link = material.instance;
  if (!link || !link.overrides.includes(field)) return material;
  return resolveInstance({ ...material, instance: { of: link.of, overrides: link.overrides.filter((f) => f !== field) } }, parent);
}

/** Cut an instance loose: it keeps every value it has now, and no longer follows a parent. */
export function detachInstance(material: MeshMaterial): MeshMaterial {
  if (!material.instance) return material;
  const { instance: _instance, ...rest } = material;
  void _instance;
  return rest;
}

/**
 * Add `material` to the library as a new parent, named after it, and make it
 * the first instance of that parent. Returns the new library, the parent's
 * id, and the material (now an instance with nothing overridden).
 */
export function addLibraryMaterial(library: MaterialLibrary, material: MeshMaterial): { library: MaterialLibrary; id: string; material: MeshMaterial } | null {
  if (library.length >= MAX_LIBRARY_MATERIALS) return null;
  const id = libraryId(library, material.name);
  const parent = asParent(material);
  return { library: [...library, { id, material: parent }], id, material: instanceOf(material, id, parent) };
}

/**
 * Push an instance's overrides up into its parent (Unreal's "apply to parent"):
 * the parent takes every value the instance sets, and the instance overrides
 * nothing any more. Returns the new library and the instance.
 */
export function applyToParent(library: MaterialLibrary, material: MeshMaterial): { library: MaterialLibrary; material: MeshMaterial } {
  const link = material.instance;
  const parent = link ? libraryMaterial(library, link.of) : null;
  if (!link || !parent) return { library, material };
  const next = { ...asParent(material), name: parent.name };
  return {
    library: library.map((m) => (m.id === link.of ? { id: m.id, material: next } : m)),
    material: { ...material, instance: { of: link.of, overrides: [] } },
  };
}

/** Replace (or with null, remove) one parent. */
export function setLibraryMaterial(library: MaterialLibrary, id: string, material: MeshMaterial | null): MaterialLibrary {
  if (material === null) return library.filter((m) => m.id !== id);
  const parent = asParent(material);
  return library.some((m) => m.id === id) ? library.map((m) => (m.id === id ? { id, material: parent } : m)) : [...library, { id, material: parent }];
}

/**
 * Re-resolve every instance in a mesh (its own materials and every material
 * set's) against the library. An instance whose parent is gone is detached,
 * keeping its values. Returns the same mesh when nothing changed.
 */
export function resolveMeshInstances(mesh: MeshAsset, library: MaterialLibrary): MeshAsset {
  let changed = false;
  const resolve = (material: MeshMaterial): MeshMaterial => {
    const link = material.instance;
    if (!link) return material;
    const parent = libraryMaterial(library, link.of);
    const next = parent ? resolveInstance(material, parent) : detachInstance(material);
    if (!sameMaterial(next, material)) changed = true;
    return next;
  };
  const primitives = mesh.primitives.map((p) => {
    const material = resolve(p.material);
    return material === p.material ? p : { ...p, material };
  });
  const variants = mesh.variants?.map((v) => ({ ...v, materials: v.materials.map((m) => (m ? resolve(m) : m)) }));
  if (!changed) return mesh;
  return { ...mesh, primitives, ...(variants ? { variants } : {}) };
}

/** Whether two materials hold the same values (images by identity). */
function sameMaterial(a: MeshMaterial, b: MeshMaterial): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!sameValue((a as unknown as Record<string, unknown>)[key], (b as unknown as Record<string, unknown>)[key])) return false;
  }
  return true;
}

/** Whether a serialized mesh may hold an instance of `id` (a cheap test before decoding it). */
export function mayInstance(serializedMesh: string, id: string): boolean {
  return serializedMesh.includes(`"of":${JSON.stringify(id)}`);
}

/** How many materials in `meshes` are instances of each parent. */
export function instanceCounts(meshes: readonly MeshAsset[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const mesh of meshes) {
    for (const p of mesh.primitives) {
      const of = p.material.instance?.of;
      if (of) counts.set(of, (counts.get(of) ?? 0) + 1);
    }
  }
  return counts;
}
