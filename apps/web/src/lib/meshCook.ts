/**
 * The cook (AAA_PRODUCTION_ROADMAP.md D5): what a player would otherwise make
 * as a cart loads, made once when it's saved.
 *
 * A material with a texture generator (P1c) stores its recipe, and every load
 * bakes its four maps again: noise per texel, normals from slopes, a relief
 * map, on the player's main thread. The cook writes each such mesh with its
 * maps beside the recipe (`serializeMeshAsset(mesh, { cook: true })`), and a
 * load whose recipe still matches uses them (`deserializeMaterial`). Run before
 * the texture offload and the packaging (D4), the maps become content-hashed
 * assets like any texture, shared by every cart with the same recipe, and
 * stream like any texture.
 *
 * Terrain layers' materials and the library's parent materials sit in the
 * sidecar as objects rather than mesh strings; they're cooked the same way, and
 * the texture offload then lifts their maps into the asset store like any
 * mesh's (a cooked map inline would put megabytes of PNG in the row).
 *
 * The editor reads cooked meshes too, and counts the maps as the generator's,
 * so its own saves still send only the recipe; the server cooks again. A mesh
 * without a generator is left byte for byte as it was. Pure: no I/O.
 */

import { deserializeMaterial, deserializeMeshAsset, serializeMaterial, serializeMeshAsset } from "@cartbox/editor";

import { meshSlots, parseSidecar } from "./meshPackages";
import { sidecarMaterialObjects } from "./meshTextureAssets";

export interface CookResult {
  /** The sidecar with each generator's maps baked in. */
  readonly encoded: string;
  /** How many distinct meshes were cooked. */
  readonly cooked: number;
}

/** Cook a stored mesh sidecar (see the module comment); a sidecar with nothing to cook comes back unchanged. */
export function cookMeshSidecar(encoded: string): CookResult {
  if (!encoded.includes("generator")) return { encoded, cooked: 0 };
  const root = parseSidecar(encoded);
  if (!root) return { encoded, cooked: 0 };
  const done = new Map<string, string>();
  let changed = false;
  for (const slot of meshSlots(root)) {
    const value = slot.value;
    // Only a mesh whose material has a recipe; `@lib:`/`@pkg:` references are cooked where they're stored.
    if (typeof value !== "string" || value.startsWith("@") || !value.includes('"generator"')) continue;
    let out = done.get(value);
    if (out === undefined) {
      try {
        out = serializeMeshAsset(deserializeMeshAsset(value), { cook: true });
      } catch {
        out = value; // a mesh that won't read is left as it was
      }
      done.set(value, out);
    }
    if (out !== value) {
      slot.write(out);
      changed = true;
    }
  }
  // Materials kept as objects (terrain layers, library parents): each with a recipe cooked the same way.
  const doneMaterials = new Map<string, unknown>();
  for (const slot of sidecarMaterialObjects(root as { terrains?: unknown; materials?: unknown })) {
    const value = slot.value as { generator?: unknown; cooked?: unknown } | null;
    if (!value || typeof value !== "object" || !value.generator) continue;
    const key = JSON.stringify(value);
    let out = doneMaterials.get(key);
    if (out === undefined) {
      try {
        out = serializeMaterial(deserializeMaterial(value), undefined, { cook: true });
      } catch {
        out = value;
      }
      doneMaterials.set(key, out);
    }
    if (JSON.stringify(out) !== key) {
      slot.write(out);
      changed = true;
    }
  }
  const cookedMaterials = [...doneMaterials].filter(([a, b]) => JSON.stringify(b) !== a).length;
  return changed ? { encoded: JSON.stringify(root), cooked: [...done].filter(([a, b]) => a !== b).length + cookedMaterials } : { encoded, cooked: 0 };
}
