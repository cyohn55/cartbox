/**
 * Foliage editing in the Mesh tab (ENGINE_PARITY_ROADMAP.md EP11): adding a
 * layer (a built-in mesh, or a copy of a scene object's), changing its
 * settings, and storing what a brush paints. See foliage.ts in @cartbox/editor.
 */

import { FOLIAGE_PRESET_LABELS, bakeImpostor, deserializeMeshAsset, foliagePreset, readFoliage, serializeFoliage, serializeMeshAsset, type FoliageLayer, type FoliagePreset, type MeshAsset } from "@cartbox/editor";
import { decodeMeshTextures } from "./meshImport";

import { setMeshFoliage, type MeshSidecar } from "./meshSidecar";

/** A layer on the sidecar, decoded: its settings and copies, and its mesh as stored. */
export function findFoliage(sidecar: MeshSidecar, id: string): { layer: FoliageLayer; mesh: string } | null {
  const stored = (sidecar.foliage ?? []).find((f) => f.id === id);
  return stored ? readFoliage(stored, sidecar.terrains ?? []) : null;
}

/** The foliage layers growing on a terrain. */
export function foliageOn(sidecar: MeshSidecar, terrainId: string): { layer: FoliageLayer; mesh: string }[] {
  return (sidecar.foliage ?? [])
    .filter((f) => f.terrain === terrainId)
    .map((f) => readFoliage(f, sidecar.terrains ?? []))
    .filter((x): x is { layer: FoliageLayer; mesh: string } => x !== null);
}

function newId(sidecar: MeshSidecar): string {
  const taken = new Set((sidecar.foliage ?? []).map((f) => f.id));
  for (let k = 1; ; k += 1) if (!taken.has(`foliage-${k}`)) return `foliage-${k}`;
}

/**
 * Add a layer to terrain `terrainId`: a built-in mesh with the settings it
 * suits, or (`from`) a copy of a scene object's mesh with middling settings.
 */
export function addFoliage(sidecar: MeshSidecar, terrainId: string, source: { preset: FoliagePreset } | { from: string }): { sidecar: MeshSidecar; id: string } | null {
  const terrain = (sidecar.terrains ?? []).find((t) => t.id === terrainId);
  if (!terrain) return null;
  const id = newId(sidecar);
  let mesh: string;
  let name: string;
  let settings: Pick<FoliageLayer, "density" | "scale" | "align" | "sink" | "cull" | "wind">;
  let fill: FoliageLayer["fill"];
  if ("preset" in source) {
    const preset = foliagePreset(source.preset);
    mesh = serializeMeshAsset(preset.mesh);
    name = FOLIAGE_PRESET_LABELS[source.preset];
    settings = preset.settings;
    // A preset that grows by rules (cliff rocks on the steep faces) starts filled.
    if (preset.fill) fill = { seed: Math.floor(Math.random() * 1e6), ...preset.fill };
  } else {
    const entry = sidecar.meshes.find((m) => m.id === source.from);
    if (!entry) return null;
    mesh = entry.mesh;
    name = entry.name;
    settings = { density: 2, scale: [0.8, 1.2], align: 0.5, sink: 0, cull: 150 };
  }
  const layer: FoliageLayer = { id, name, terrain: terrainId, ...settings, copies: [], ...(fill ? { fill } : {}) };
  return { sidecar: setMeshFoliage(sidecar, [...(sidecar.foliage ?? []), serializeFoliage(terrain, layer, mesh)]), id };
}

/** Store an edited layer in place (its mesh unchanged). */
export function replaceFoliage(sidecar: MeshSidecar, layer: FoliageLayer, mesh: string): MeshSidecar {
  const terrain = (sidecar.terrains ?? []).find((t) => t.id === layer.terrain);
  if (!terrain) return sidecar;
  const stored = serializeFoliage(terrain, layer, mesh);
  return setMeshFoliage(sidecar, (sidecar.foliage ?? []).map((f) => (f.id === layer.id ? stored : f)));
}

/**
 * Bake a layer's mesh into impostor cards (P4; see render/impostor.ts in
 * @cartbox/editor), its base-colour maps decoded first: the cards' mesh,
 * serialized, or null for a mesh with no extent.
 */
export async function bakeFoliageImpostor(mesh: string): Promise<string | null> {
  let asset: MeshAsset;
  try {
    asset = deserializeMeshAsset(mesh);
  } catch {
    return null;
  }
  const baked = bakeImpostor(asset, await decodeMeshTextures(asset));
  return baked ? serializeMeshAsset(baked.mesh) : null;
}

export function removeFoliage(sidecar: MeshSidecar, id: string): MeshSidecar {
  return setMeshFoliage(sidecar, (sidecar.foliage ?? []).filter((f) => f.id !== id));
}
