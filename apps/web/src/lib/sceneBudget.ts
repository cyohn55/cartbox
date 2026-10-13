/**
 * What a scene costs, for the per-device budgets (EDITOR_PRO_ROADMAP.md P8):
 * from the stored scene, before it plays — triangles and draw calls at full
 * detail (every object and terrain chunk in view, its nearest level of
 * detail), its meshes' and textures' memory (each counted once, textures
 * decoded to RGBA8 with mips, sized from their headers), and its download.
 * Foliage and distance culling are left to the live overlay, which counts
 * what a frame actually draws. Pure; meshes are decoded once per string.
 */

import { readTerrain, terrainChunks, textureGpuBytes, imageSize, type EncodedImage, type MeshAsset, type SceneLoad } from "@cartbox/editor";

import { encodeMeshSidecar, readMeshEntry, type MeshSidecar, type MeshSidecarEntry } from "./meshSidecar";

/** One mesh's own cost: its triangles and primitives, its geometry bytes, and its images. */
interface MeshCost {
  readonly triangles: number;
  readonly primitives: number;
  readonly bytes: number;
  readonly images: readonly EncodedImage[];
}

const costs = new Map<string, MeshCost>();

/** Every image a mesh's materials hold. */
function imagesOf(mesh: MeshAsset): EncodedImage[] {
  const out: EncodedImage[] = [];
  for (const p of mesh.primitives) {
    for (const value of Object.values(p.material)) {
      const image = value as Partial<EncodedImage> | null;
      if (image && typeof image === "object" && image.bytes instanceof Uint8Array && typeof image.mime === "string") out.push(image as EncodedImage);
    }
  }
  return out;
}

function costOf(entry: MeshSidecarEntry): MeshCost {
  const key = `${entry.mesh.length}:${entry.variant ?? ""}:${entry.mesh.slice(0, 64)}:${entry.mesh.slice(-64)}`;
  const known = costs.get(key);
  if (known) return known;
  let mesh: MeshAsset;
  try {
    mesh = readMeshEntry(entry);
  } catch {
    return { triangles: 0, primitives: 0, bytes: 0, images: [] };
  }
  const cost: MeshCost = {
    triangles: mesh.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
    primitives: mesh.primitives.length,
    bytes: mesh.primitives.reduce((n, p) => n + (p.positions.length / 3) * 32 + p.indices.length * 4, 0),
    images: imagesOf(mesh),
  };
  if (costs.size > 512) costs.clear();
  costs.set(key, cost);
  return cost;
}

/** A cheap identity for an image's bytes (its length and an FNV-1a hash of a sample). */
function imageKey(image: EncodedImage): string {
  const b = image.bytes;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(b.length / 4096));
  for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i]!, 0x01000193);
  return `${b.length}:${h >>> 0}`;
}

/** The scene's load as stored: what the budgets check before it plays. */
export function sceneLoadOf(sidecar: MeshSidecar): Required<Pick<SceneLoad, "triangles" | "drawCalls" | "meshBytes" | "textureBytes" | "downloadBytes">> {
  let triangles = 0;
  let drawCalls = 0;
  let meshBytes = 0;
  let textureBytes = 0;
  const meshesSeen = new Set<string>();
  const imagesSeen = new Set<string>();
  for (const entry of sidecar.meshes) {
    const cost = costOf(entry);
    triangles += cost.triangles;
    drawCalls += cost.primitives;
    if (!meshesSeen.has(entry.mesh)) {
      meshesSeen.add(entry.mesh);
      meshBytes += cost.bytes;
    }
    for (const image of cost.images) {
      const key = imageKey(image);
      if (imagesSeen.has(key)) continue;
      imagesSeen.add(key);
      const size = imageSize(image.bytes);
      if (size) textureBytes += textureGpuBytes(size.width, size.height);
    }
  }
  for (const raw of sidecar.terrains ?? []) {
    const terrain = readTerrain(raw);
    if (!terrain) continue;
    const cells = (terrain.samples - 1) * (terrain.samples - 1);
    triangles += cells * 2;
    drawCalls += terrainChunks(terrain).length;
    meshBytes += terrain.samples * terrain.samples * 32 + cells * 6 * 4;
  }
  return { triangles, drawCalls, meshBytes, textureBytes, downloadBytes: encodeMeshSidecar(sidecar)?.length ?? 0 };
}
