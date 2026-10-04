/**
 * The content browser's model (ENGINE_PARITY_ROADMAP.md EP4): every asset a
 * cart's 3D scene is built from, gathered from the mesh sidecar, as pure
 * functions — so listing, searching, finding what uses an asset and renaming it
 * safely are unit-testable.
 *
 * - Meshes: each distinct geometry, shared by however many objects place it.
 * - Prefabs, with how many copies are placed.
 * - Textures and materials found inside the meshes.
 * - Particle effects, decals and debris definitions.
 *
 * A Cartbox scene refers to things by name — debris by its source object or
 * prefab and the materials it leaves off, decal marks by decal, the cart's Lua
 * by string (`cartbox.find("door")`, `cartbox.burst("sparks", …)`) — so a safe
 * rename carries the new name to every one of those places.
 */

import { deserializeMeshAsset, serializeMeshAsset, type EncodedImage, type MeshAsset } from "@cartbox/editor";

import { placePrefab } from "./meshPrefabs";
import { MESH_SIDECAR_VERSION, newMeshId, type MeshSidecar } from "./meshSidecar";
import { nextName } from "./sceneSelection";

export type AssetKind = "mesh" | "prefab" | "texture" | "material" | "effect" | "decal" | "debris";

export const ASSET_KINDS: readonly { readonly kind: AssetKind; readonly label: string }[] = [
  { kind: "mesh", label: "Meshes" },
  { kind: "prefab", label: "Prefabs" },
  { kind: "material", label: "Materials" },
  { kind: "texture", label: "Textures" },
  { kind: "effect", label: "Effects" },
  { kind: "decal", label: "Decals" },
  { kind: "debris", label: "Debris" },
];

export interface ContentAsset {
  readonly kind: AssetKind;
  /** Unique within its kind. */
  readonly key: string;
  readonly name: string;
  /** A short line under the name (triangle count, copies, size…). */
  readonly detail: string;
  /** Objects in the scene that use it. */
  readonly objects: readonly string[];
  /** A mesh's serialized geometry (to place it), or a prefab's root node's (for its thumbnail). */
  readonly mesh?: string;
  /** A texture's image. */
  readonly image?: EncodedImage;
  /** A material's base colour (0..1). */
  readonly color?: readonly [number, number, number];
}

/** FNV-1a over a string: a short stable key for a mesh payload. */
export function hashString(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${bytes.length}`;
}

const triangles = (mesh: MeshAsset) => mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Every image a material holds (base colour, normal, metallic-roughness…). */
function materialImages(material: MeshAsset["primitives"][number]["material"]): EncodedImage[] {
  const out: EncodedImage[] = [];
  for (const [key, value] of Object.entries(material)) {
    if (!key.endsWith("Image") || !value || typeof value !== "object") continue;
    const image = value as EncodedImage;
    if (typeof image.mime === "string" && image.bytes instanceof Uint8Array && image.bytes.length > 0) out.push(image);
  }
  return out;
}

/** Every asset in the scene, by kind then name. A mesh that won't decode is skipped. */
export function collectAssets(sidecar: MeshSidecar): ContentAsset[] {
  const out: ContentAsset[] = [];
  // Meshes, grouped by identical geometry.
  const byPayload = new Map<string, string[]>();
  for (const entry of sidecar.meshes) {
    const users = byPayload.get(entry.mesh);
    if (users) users.push(entry.id);
    else byPayload.set(entry.mesh, [entry.id]);
  }
  const decoded = new Map<string, MeshAsset>();
  const textures = new Map<string, { image: EncodedImage; name: string; objects: Set<string>; materials: Set<string> }>();
  const materials = new Map<string, { color: [number, number, number]; objects: Set<string>; meshes: Set<string> }>();
  for (const [payload, users] of byPayload) {
    let mesh: MeshAsset;
    try {
      mesh = deserializeMeshAsset(payload);
    } catch {
      continue;
    }
    decoded.set(payload, mesh);
    const key = hashString(payload);
    const first = sidecar.meshes.find((m) => m.id === users[0]);
    out.push({
      kind: "mesh",
      key,
      name: mesh.name || first?.name || "Mesh",
      detail: `${plural(triangles(mesh), "tri")} · ${plural(users.length, "use")}`,
      objects: users,
      mesh: payload,
    });
    for (const primitive of mesh.primitives) {
      const m = primitive.material;
      const mat = materials.get(m.name) ?? { color: [m.baseColorFactor[0], m.baseColorFactor[1], m.baseColorFactor[2]] as [number, number, number], objects: new Set<string>(), meshes: new Set<string>() };
      users.forEach((u) => mat.objects.add(u));
      mat.meshes.add(key);
      materials.set(m.name, mat);
      for (const image of materialImages(m)) {
        const tk = hashBytes(image.bytes);
        const tex = textures.get(tk) ?? { image, name: `${m.name} texture`, objects: new Set<string>(), materials: new Set<string>() };
        users.forEach((u) => tex.objects.add(u));
        tex.materials.add(m.name);
        textures.set(tk, tex);
      }
    }
  }
  for (const prefab of sidecar.prefabs ?? []) {
    const placed = sidecar.meshes.filter((m) => m.prefab?.id === prefab.id);
    const copies = new Set(placed.map((m) => m.prefab!.instance)).size;
    const root = prefab.nodes.find((n) => !n.parent);
    out.push({
      kind: "prefab",
      key: prefab.id,
      name: prefab.name,
      detail: `${plural(prefab.nodes.length, "part")} · ${plural(copies, "copy")}${prefab.pool !== undefined ? ` · pool ${prefab.pool}` : ""}`,
      objects: placed.map((m) => m.id),
      ...(root ? { mesh: root.mesh } : {}),
    });
  }
  for (const [name, mat] of materials) {
    out.push({ kind: "material", key: name, name, detail: `${plural(mat.meshes.size, "mesh")} · ${plural(mat.objects.size, "object")}`, objects: [...mat.objects], color: mat.color });
  }
  for (const [key, tex] of textures) {
    const kb = Math.max(1, Math.round(tex.image.bytes.length / 1024));
    out.push({ kind: "texture", key, name: tex.name, detail: `${tex.image.mime.replace("image/", "").toUpperCase()} · ${kb} KB`, objects: [...tex.objects], image: tex.image });
  }
  for (const effect of sidecar.effects ?? []) out.push({ kind: "effect", key: effect.name, name: effect.name, detail: `${effect.shape} · ${effect.count} particles`, objects: [] });
  for (const decal of sidecar.decals ?? []) {
    const marks = (sidecar.decalMarks ?? []).filter((m) => m.decal === decal.name).length;
    out.push({ kind: "decal", key: decal.name, name: decal.name, detail: `${decal.pattern}${marks ? ` · ${plural(marks, "mark")}` : ""}`, objects: [] });
  }
  for (const def of sidecar.debris ?? []) {
    const sources = sidecar.meshes.filter((m) => m.name === def.source).map((m) => m.id);
    out.push({ kind: "debris", key: def.name, name: def.name, detail: `from ${def.source}`, objects: sources });
  }
  const order = new Map(ASSET_KINDS.map((k, i) => [k.kind, i]));
  return out.sort((a, b) => order.get(a.kind)! - order.get(b.kind)! || a.name.localeCompare(b.name));
}

/** The assets of a kind (or every kind) whose name or detail contains the query (any case). */
export function filterAssets(assets: readonly ContentAsset[], kind: AssetKind | "all", query: string): ContentAsset[] {
  const q = query.trim().toLowerCase();
  return assets.filter((a) => (kind === "all" || a.kind === kind) && (!q || a.name.toLowerCase().includes(q) || a.detail.toLowerCase().includes(q)));
}

/** Escape a string for a regular expression. */
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The 1-based lines of `code` holding `name` as a whole string literal ("name" or 'name'). */
export function codeReferences(code: string, name: string): number[] {
  if (!name) return [];
  const pattern = new RegExp(`(["'])${escape(name)}\\1`);
  const out: number[] = [];
  code.split("\n").forEach((line, i) => {
    if (pattern.test(line)) out.push(i + 1);
  });
  return out;
}

/** `code` with every whole string literal `from` changed to `to` (same quotes), and how many changed. */
export function renameInCode(code: string, from: string, to: string): { code: string; count: number } {
  if (!from || from === to) return { code, count: 0 };
  let count = 0;
  const next = code.replace(new RegExp(`(["'])${escape(from)}\\1`, "g"), (_m, quote: string) => {
    count += 1;
    return `${quote}${to}${quote}`;
  });
  return { code: next, count };
}

/**
 * What else in the scene names an asset (besides the objects that place it),
 * as lines for the browser to show: debris drawn from it, decal marks of it,
 * debris leaving a material off.
 */
export function sceneReferences(sidecar: MeshSidecar, asset: ContentAsset): string[] {
  const out: string[] = [];
  if (asset.kind === "prefab") for (const d of sidecar.debris ?? []) if (d.source === asset.name) out.push(`Debris “${d.name}” is drawn from it`);
  if (asset.kind === "material") for (const d of sidecar.debris ?? []) if (d.without?.includes(asset.name)) out.push(`Debris “${d.name}” leaves it off`);
  if (asset.kind === "decal") {
    const marks = (sidecar.decalMarks ?? []).filter((m) => m.decal === asset.name).length;
    if (marks) out.push(`${plural(marks, "mark")} placed in the scene`);
  }
  return out;
}

/** Whether an asset kind can be renamed (meshes and textures have no name anything refers to). */
export function renamable(kind: AssetKind): boolean {
  return kind === "prefab" || kind === "material" || kind === "effect" || kind === "decal" || kind === "debris";
}

/**
 * The sidecar with an asset renamed, and every reference in the scene carried
 * along: a prefab's name in debris sources, a material's name in every mesh
 * and in debris `without` lists, a decal's in its marks. Refused (the sidecar
 * comes back unchanged) for an empty name or one its kind already uses.
 */
export function renameAsset(sidecar: MeshSidecar, asset: ContentAsset, name: string): MeshSidecar {
  const to = name.trim();
  if (!to || to === asset.name || !renamable(asset.kind)) return sidecar;
  const taken = collectAssets(sidecar).some((a) => a.kind === asset.kind && a.name === to);
  if (taken) return sidecar;
  const from = asset.name;
  switch (asset.kind) {
    case "prefab":
      return {
        ...sidecar,
        prefabs: (sidecar.prefabs ?? []).map((p) => (p.id === asset.key ? { ...p, name: to } : p)),
        ...(sidecar.debris ? { debris: sidecar.debris.map((d) => (d.source === from ? { ...d, source: to } : d)) } : {}),
      };
    case "effect":
      return { ...sidecar, effects: (sidecar.effects ?? []).map((e) => (e.name === from ? { ...e, name: to } : e)) };
    case "decal":
      return {
        ...sidecar,
        decals: (sidecar.decals ?? []).map((d) => (d.name === from ? { ...d, name: to } : d)),
        ...(sidecar.decalMarks ? { decalMarks: sidecar.decalMarks.map((m) => (m.decal === from ? { ...m, decal: to } : m)) } : {}),
      };
    case "debris":
      return { ...sidecar, debris: (sidecar.debris ?? []).map((d) => (d.name === from ? { ...d, name: to } : d)) };
    case "material":
      return {
        ...sidecar,
        meshes: sidecar.meshes.map((entry) => {
          if (!entry.mesh.includes(from)) return entry;
          let mesh: MeshAsset;
          try {
            mesh = deserializeMeshAsset(entry.mesh);
          } catch {
            return entry;
          }
          if (!mesh.primitives.some((p) => p.material.name === from)) return entry;
          return { ...entry, mesh: serializeRenamed(mesh, from, to) };
        }),
        ...(sidecar.debris ? { debris: sidecar.debris.map((d) => (d.without?.includes(from) ? { ...d, without: d.without.map((w) => (w === from ? to : w)) } : d)) } : {}),
      };
    default:
      return sidecar;
  }
}

function serializeRenamed(mesh: MeshAsset, from: string, to: string): string {
  return serializeMeshAsset({ ...mesh, primitives: mesh.primitives.map((p) => (p.material.name === from ? { ...p, material: { ...p.material, name: to } } : p)) });
}

/**
 * Place an asset in the scene at `position` (world, top level): a mesh as a
 * new object wearing that geometry (named after the object it came from), a
 * prefab as a new copy. The new object's id comes back to be selected; an
 * asset that can't be placed leaves the sidecar unchanged (id null).
 */
export function placeAsset(sidecar: MeshSidecar, asset: Pick<ContentAsset, "kind" | "key" | "name">, position: readonly [number, number, number]): { sidecar: MeshSidecar; id: string | null } {
  const transform = { position: [position[0], position[1], position[2]] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
  if (asset.kind === "prefab") {
    const placed = placePrefab(sidecar, asset.key, { transform });
    return placed.rootId ? { sidecar: placed.sidecar, id: placed.rootId } : { sidecar, id: null };
  }
  if (asset.kind !== "mesh") return { sidecar, id: null };
  const source = sidecar.meshes.find((m) => hashString(m.mesh) === asset.key);
  if (!source) return { sidecar, id: null };
  const id = newMeshId();
  const name = nextName(source.name, new Set(sidecar.meshes.map((m) => m.name)));
  return { sidecar: { ...sidecar, version: MESH_SIDECAR_VERSION, meshes: [...sidecar.meshes, { id, name, mesh: source.mesh, transform }] }, id };
}
