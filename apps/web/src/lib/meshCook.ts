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
 * The editor reads cooked meshes too, and counts the maps as the generator's,
 * so its own saves still send only the recipe; the server cooks again. A mesh
 * without a generator is left byte for byte as it was. Pure: no I/O.
 */

import { deserializeMeshAsset, serializeMeshAsset } from "@cartbox/editor";

import { meshSlots, parseSidecar } from "./meshPackages";

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
  return changed ? { encoded: JSON.stringify(root), cooked: [...done].filter(([a, b]) => a !== b).length } : { encoded, cooked: 0 };
}
